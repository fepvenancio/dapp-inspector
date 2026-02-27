import type { BrowserContext } from "playwright"
import {
  Keypair,
  PublicKey,
  Transaction,
  VersionedTransaction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js"
import bs58 from "bs58"
import { nanoid } from "nanoid"

import type {
  DappInspectorAdapter,
  AdapterConfig,
  WalletState,
  PendingTransaction,
  ToolRegistry,
  BridgeCall,
  BridgeResult,
  AccountConfig,
} from "../interface.js"
import { toolError } from "../interface.js"
import type { SolanaAdapterConfig } from "../../config/schema.js"
import { SolanaValidatorClient } from "./validator.js"
import { buildSolanaShim } from "./shim.js"
import { registerSolanaTools } from "./tools.js"

export class SolanaAdapter implements DappInspectorAdapter {
  readonly name = "solana"
  readonly version = "1.0.0"
  readonly walletWindowKey = "solana"

  private context: BrowserContext | null = null
  private config: SolanaAdapterConfig | null = null
  private validator: SolanaValidatorClient = new SolanaValidatorClient()
  private keypairs: Map<string, Keypair> = new Map()
  private labelMap: Map<string, string> = new Map()
  private accounts: AccountConfig[] = []

  private state: WalletState = {
    isConnected: false,
    accounts: [],
    activeAccount: null,
    chainId: null,
    pendingTransaction: null,
    autoApprove: false,
  }

  // Pending transaction resolution
  private pendingResolve: ((result: { txHash: string }) => void) | null = null
  private pendingReject: ((error: Error) => void) | null = null

  async initialize(context: BrowserContext, config: AdapterConfig): Promise<void> {
    this.context = context
    this.config = config as SolanaAdapterConfig
    this.accounts = config.accounts

    // Load keypairs from config
    for (const account of config.accounts) {
      const keypair = this.parseKeypair(account.privateKey)
      const address = keypair.publicKey.toBase58()

      // Validate that the derived address matches the configured address
      if (account.address && account.address !== address) {
        console.warn(
          `[solana-adapter] Warning: configured address ${account.address} does not match ` +
            `derived address ${address}. Using derived address.`,
        )
      }

      this.keypairs.set(address, keypair)
      if (account.label) {
        this.labelMap.set(account.label, address)
      }
    }

    this.state.accounts = Array.from(this.keypairs.keys())
    this.state.autoApprove = config.autoApprove ?? false

    // Connect to the validator
    await this.validator.connect(this.config)

    // Build and inject the wallet shim
    const shimScript = buildSolanaShim(this.state)
    await context.addInitScript({ content: shimScript })

    // Expose the bridge function
    await context.exposeFunction(
      "__dappInspector_bridge",
      (callStr: string) => this.handleBridgeCall(callStr),
    )
  }

  async teardown(): Promise<void> {
    this.validator.disconnect()
    this.keypairs.clear()
    this.labelMap.clear()
    this.pendingResolve = null
    this.pendingReject = null
    this.context = null
    this.config = null
  }

  registerTools(registry: ToolRegistry): void {
    // Register wallet control tools (shared across all adapters)
    this.registerWalletTools(registry)

    // Register Solana-specific tools
    registerSolanaTools(
      registry,
      this.validator,
      this.accounts,
      (ref) => this.resolveKeypair(ref),
    )
  }

  getWalletState(): WalletState {
    return { ...this.state }
  }

  // ── Wallet control methods ──

  async connect(account?: string): Promise<{ address: string; chainId: string }> {
    let address: string
    if (account) {
      // Resolve by label or address
      address = this.labelMap.get(account) ?? account
      if (!this.keypairs.has(address)) {
        throw new Error(`Unknown account: ${account}`)
      }
    } else {
      // Use first account
      address = this.state.accounts[0]
      if (!address) throw new Error("No accounts configured")
    }

    this.state.isConnected = true
    this.state.activeAccount = address
    this.state.chainId = "solana:devnet"

    await this.notifyPages("connect", { address })

    return { address, chainId: "solana:devnet" }
  }

  async disconnect(): Promise<void> {
    this.state.isConnected = false
    this.state.activeAccount = null

    // Reject any pending transaction
    if (this.pendingReject) {
      this.pendingReject(new Error("Wallet disconnected"))
      this.pendingResolve = null
      this.pendingReject = null
      this.state.pendingTransaction = null
    }

    await this.notifyPages("disconnect", {})
  }

  async switchAccount(address: string): Promise<void> {
    const resolved = this.labelMap.get(address) ?? address
    if (!this.keypairs.has(resolved)) {
      throw new Error(`Unknown account: ${address}`)
    }

    const oldAccount = this.state.activeAccount
    this.state.activeAccount = resolved

    if (oldAccount !== resolved) {
      await this.notifyPages("accountChanged", { address: resolved })
    }
  }

  setAutoApprove(enabled: boolean): void {
    this.state.autoApprove = enabled
  }

  async approveTransaction(): Promise<{ txHash: string }> {
    if (!this.state.pendingTransaction) {
      throw new Error("No pending transaction to approve")
    }

    if (this.state.pendingTransaction.status !== "pending") {
      throw new Error(
        `Transaction is already ${this.state.pendingTransaction.status}`,
      )
    }

    const pending = this.state.pendingTransaction
    const payload = pending.payload

    try {
      const keypair = this.getActiveKeypair()
      const conn = this.validator.getConnection()

      let signature: string

      if (payload.signOnly) {
        // signTransaction — sign and return, don't submit
        const txBytes = Buffer.from(payload.tx, "base64")
        let signedTxBase64: string
        let sigBase64: string

        if (payload.versioned) {
          const vtx = VersionedTransaction.deserialize(txBytes)
          // Replace blockhash
          const { blockhash } = await conn.getLatestBlockhash(
            this.config?.commitment ?? "confirmed",
          )
          vtx.message.recentBlockhash = blockhash
          vtx.sign([keypair])
          signedTxBase64 = Buffer.from(vtx.serialize()).toString("base64")
          sigBase64 = Buffer.from(vtx.signatures[0]).toString("base64")
        } else {
          const tx = Transaction.from(txBytes)
          const { blockhash } = await conn.getLatestBlockhash(
            this.config?.commitment ?? "confirmed",
          )
          tx.recentBlockhash = blockhash
          tx.feePayer = keypair.publicKey
          tx.sign(keypair)
          signedTxBase64 = Buffer.from(
            tx.serialize({ requireAllSignatures: false }),
          ).toString("base64")
          sigBase64 = tx.signature
            ? Buffer.from(tx.signature).toString("base64")
            : ""
        }

        pending.status = "approved"
        pending.resolvedAt = Date.now()
        this.state.pendingTransaction = null

        if (this.pendingResolve) {
          this.pendingResolve({ txHash: sigBase64 })
          this.pendingResolve = null
          this.pendingReject = null
        }

        return { txHash: sigBase64 }
      }

      // signAndSendTransaction — sign and submit
      const txBytes = Buffer.from(payload.tx, "base64")

      if (payload.versioned) {
        const vtx = VersionedTransaction.deserialize(txBytes)
        const { blockhash } = await conn.getLatestBlockhash(
          this.config?.commitment ?? "confirmed",
        )
        vtx.message.recentBlockhash = blockhash

        // Simulate first
        const simResult = await conn.simulateTransaction(vtx)
        if (simResult.value.err) {
          const errMsg = JSON.stringify(simResult.value.err)
          throw new Error(
            `Simulation failed: ${errMsg}. Logs: ${(simResult.value.logs ?? []).join("\n")}`,
          )
        }

        vtx.sign([keypair])
        signature = await this.validator.sendRawTransaction(
          Buffer.from(vtx.serialize()),
        )
      } else {
        const tx = Transaction.from(txBytes)
        const { blockhash } = await conn.getLatestBlockhash(
          this.config?.commitment ?? "confirmed",
        )
        tx.recentBlockhash = blockhash
        tx.feePayer = keypair.publicKey

        // Simulate first
        const simResult = await conn.simulateTransaction(tx)
        if (simResult.value.err) {
          const errMsg = JSON.stringify(simResult.value.err)
          throw new Error(
            `Simulation failed: ${errMsg}. Logs: ${(simResult.value.logs ?? []).join("\n")}`,
          )
        }

        tx.sign(keypair)
        signature = await this.validator.sendRawTransaction(
          tx.serialize(),
        )
      }

      pending.status = "approved"
      pending.resolvedAt = Date.now()
      this.state.pendingTransaction = null

      if (this.pendingResolve) {
        this.pendingResolve({ txHash: signature })
        this.pendingResolve = null
        this.pendingReject = null
      }

      return { txHash: signature }
    } catch (err: any) {
      pending.status = "rejected"
      pending.resolvedAt = Date.now()
      this.state.pendingTransaction = null

      if (this.pendingReject) {
        this.pendingReject(err)
        this.pendingResolve = null
        this.pendingReject = null
      }

      throw err
    }
  }

  async rejectTransaction(reason?: string): Promise<void> {
    if (!this.state.pendingTransaction) {
      throw new Error("No pending transaction to reject")
    }

    this.state.pendingTransaction.status = "rejected"
    this.state.pendingTransaction.resolvedAt = Date.now()
    this.state.pendingTransaction = null

    if (this.pendingReject) {
      this.pendingReject(new Error(reason ?? "Transaction rejected by user"))
      this.pendingResolve = null
      this.pendingReject = null
    }
  }

  getPendingTransaction(): PendingTransaction | null {
    return this.state.pendingTransaction
  }

  // ── Bridge handler ──

  private async handleBridgeCall(callStr: string): Promise<string> {
    let call: BridgeCall
    try {
      call = JSON.parse(callStr)
    } catch {
      return JSON.stringify({ success: false, error: "Invalid bridge call JSON" })
    }

    try {
      const result = await this.routeBridgeCall(call)
      return JSON.stringify(result)
    } catch (err: any) {
      return JSON.stringify({ success: false, error: err.message })
    }
  }

  private async routeBridgeCall(call: BridgeCall): Promise<BridgeResult> {
    switch (call.method) {
      case "getState":
        return { success: true, data: this.getWalletState() }

      case "connect": {
        const result = await this.connect()
        return { success: true, data: result }
      }

      case "disconnect": {
        await this.disconnect()
        return { success: true }
      }

      case "signTransaction":
        return this.handleSignTransaction(call.params)

      case "signAllTransactions":
        return this.handleSignAllTransactions(call.params)

      case "submitTransaction":
        return this.handleSubmitTransaction(call.params)

      case "signMessage":
        return this.handleSignMessage(call.params)

      default:
        return { success: false, error: `Unknown bridge method: ${call.method}` }
    }
  }

  private async handleSignTransaction(params: any): Promise<BridgeResult> {
    const keypair = this.getActiveKeypair()
    const conn = this.validator.getConnection()

    const txBytes = Buffer.from(params.tx, "base64")

    if (this.state.autoApprove) {
      // Sign immediately and return
      if (params.versioned) {
        const vtx = VersionedTransaction.deserialize(txBytes)
        const { blockhash } = await conn.getLatestBlockhash(
          this.config?.commitment ?? "confirmed",
        )
        vtx.message.recentBlockhash = blockhash
        vtx.sign([keypair])
        return {
          success: true,
          data: {
            signedTx: Buffer.from(vtx.serialize()).toString("base64"),
            signature: Buffer.from(vtx.signatures[0]).toString("base64"),
            versioned: true,
          },
        }
      }

      const tx = Transaction.from(txBytes)
      const { blockhash } = await conn.getLatestBlockhash(
        this.config?.commitment ?? "confirmed",
      )
      tx.recentBlockhash = blockhash
      tx.feePayer = keypair.publicKey
      tx.sign(keypair)
      return {
        success: true,
        data: {
          signedTx: Buffer.from(
            tx.serialize({ requireAllSignatures: false }),
          ).toString("base64"),
          signature: tx.signature
            ? Buffer.from(tx.signature).toString("base64")
            : "",
          versioned: false,
        },
      }
    }

    // Queue as pending transaction
    return new Promise((resolve, reject) => {
      this.state.pendingTransaction = {
        id: nanoid(),
        payload: {
          tx: params.tx,
          encoding: params.encoding,
          versioned: params.versioned,
          signOnly: true,
        },
        status: "pending",
      }

      this.pendingResolve = (result) => {
        resolve({
          success: true,
          data: {
            signedTx: result.txHash, // In signOnly, txHash is the base64 sig
            signature: result.txHash,
            versioned: params.versioned,
          },
        })
      }
      this.pendingReject = (err) => {
        resolve({ success: false, error: err.message })
      }
    })
  }

  private async handleSignAllTransactions(params: any): Promise<BridgeResult> {
    const keypair = this.getActiveKeypair()
    const conn = this.validator.getConnection()
    const transactions: any[] = params.transactions

    if (this.state.autoApprove) {
      const { blockhash } = await conn.getLatestBlockhash(
        this.config?.commitment ?? "confirmed",
      )
      const signatures: string[] = []

      for (const txData of transactions) {
        const txBytes = Buffer.from(txData.data, "base64")

        if (txData.versioned) {
          const vtx = VersionedTransaction.deserialize(txBytes)
          vtx.message.recentBlockhash = blockhash
          vtx.sign([keypair])
          signatures.push(
            Buffer.from(vtx.signatures[0]).toString("base64"),
          )
        } else {
          const tx = Transaction.from(txBytes)
          tx.recentBlockhash = blockhash
          tx.feePayer = keypair.publicKey
          tx.sign(keypair)
          signatures.push(
            tx.signature
              ? Buffer.from(tx.signature).toString("base64")
              : "",
          )
        }
      }

      return { success: true, data: { signatures } }
    }

    // For non-autoApprove: queue the first transaction, then handle sequentially
    // This is a simplification — most DApps signAll in one go
    return new Promise((resolve, reject) => {
      this.state.pendingTransaction = {
        id: nanoid(),
        payload: {
          transactions: transactions.map((t) => ({
            tx: t.data,
            encoding: t.encoding,
            versioned: t.versioned,
          })),
          signOnly: true,
          isMulti: true,
        },
        status: "pending",
      }

      this.pendingResolve = async (result) => {
        // When approved, sign all at once
        try {
          const { blockhash } = await conn.getLatestBlockhash(
            this.config?.commitment ?? "confirmed",
          )
          const signatures: string[] = []

          for (const txData of transactions) {
            const txBytes = Buffer.from(txData.data, "base64")
            if (txData.versioned) {
              const vtx = VersionedTransaction.deserialize(txBytes)
              vtx.message.recentBlockhash = blockhash
              vtx.sign([keypair])
              signatures.push(
                Buffer.from(vtx.signatures[0]).toString("base64"),
              )
            } else {
              const tx = Transaction.from(txBytes)
              tx.recentBlockhash = blockhash
              tx.feePayer = keypair.publicKey
              tx.sign(keypair)
              signatures.push(
                tx.signature
                  ? Buffer.from(tx.signature).toString("base64")
                  : "",
              )
            }
          }

          resolve({ success: true, data: { signatures } })
        } catch (err: any) {
          resolve({ success: false, error: err.message })
        }
      }
      this.pendingReject = (err) => {
        resolve({ success: false, error: err.message })
      }
    })
  }

  private async handleSubmitTransaction(params: any): Promise<BridgeResult> {
    const keypair = this.getActiveKeypair()
    const conn = this.validator.getConnection()

    const txBytes = Buffer.from(params.tx, "base64")

    if (this.state.autoApprove) {
      // Simulate, sign, and submit immediately
      const { blockhash } = await conn.getLatestBlockhash(
        this.config?.commitment ?? "confirmed",
      )

      let signature: string

      if (params.versioned) {
        const vtx = VersionedTransaction.deserialize(txBytes)
        vtx.message.recentBlockhash = blockhash

        // Simulate
        const simResult = await conn.simulateTransaction(vtx)
        if (simResult.value.err) {
          return {
            success: false,
            error: `Simulation failed: ${JSON.stringify(simResult.value.err)}. Logs: ${(simResult.value.logs ?? []).join("\n")}`,
          }
        }

        vtx.sign([keypair])
        signature = await this.validator.sendRawTransaction(
          Buffer.from(vtx.serialize()),
        )
      } else {
        const tx = Transaction.from(txBytes)
        tx.recentBlockhash = blockhash
        tx.feePayer = keypair.publicKey

        // Simulate
        const simResult = await conn.simulateTransaction(tx)
        if (simResult.value.err) {
          return {
            success: false,
            error: `Simulation failed: ${JSON.stringify(simResult.value.err)}. Logs: ${(simResult.value.logs ?? []).join("\n")}`,
          }
        }

        tx.sign(keypair)
        signature = await this.validator.sendRawTransaction(tx.serialize())
      }

      return {
        success: true,
        data: { signature, publicKey: keypair.publicKey.toBase58() },
      }
    }

    // Queue as pending
    return new Promise((resolve) => {
      this.state.pendingTransaction = {
        id: nanoid(),
        payload: {
          tx: params.tx,
          encoding: params.encoding,
          versioned: params.versioned,
          signOnly: false,
        },
        status: "pending",
      }

      this.pendingResolve = (result) => {
        resolve({
          success: true,
          data: {
            signature: result.txHash,
            publicKey: keypair.publicKey.toBase58(),
          },
        })
      }
      this.pendingReject = (err) => {
        resolve({ success: false, error: err.message })
      }
    })
  }

  private async handleSignMessage(params: any): Promise<BridgeResult> {
    const keypair = this.getActiveKeypair()
    const msgBytes = Buffer.from(params.message, "base64")

    // Sign message using Node.js crypto ed25519
    const crypto = await import("node:crypto")
    const privateKeySeed = keypair.secretKey.slice(0, 32)
    const nodeKey = crypto.createPrivateKey({
      key: Buffer.concat([
        // Ed25519 PKCS8 DER prefix
        Buffer.from("302e020100300506032b657004220420", "hex"),
        Buffer.from(privateKeySeed),
      ]),
      format: "der",
      type: "pkcs8",
    })
    const signatureBytes = new Uint8Array(
      crypto.sign(null, msgBytes, nodeKey),
    )

    const sigBase64 = Buffer.from(signatureBytes).toString("base64")
    return { success: true, data: { signature: sigBase64 } }
  }

  // ── Helpers ──

  private parseKeypair(privateKey: string): Keypair {
    // Try base58 first (standard Solana CLI format)
    try {
      const decoded = bs58.decode(privateKey)
      if (decoded.length === 64) {
        return Keypair.fromSecretKey(decoded)
      }
      // 32-byte seed
      if (decoded.length === 32) {
        return Keypair.fromSeed(decoded)
      }
    } catch {
      // Not base58
    }

    // Try base64 (64-byte keypair)
    try {
      const decoded = Buffer.from(privateKey, "base64")
      if (decoded.length === 64) {
        return Keypair.fromSecretKey(new Uint8Array(decoded))
      }
    } catch {
      // Not base64
    }

    // Try JSON array format (e.g. from solana-keygen)
    try {
      const arr = JSON.parse(privateKey)
      if (Array.isArray(arr)) {
        return Keypair.fromSecretKey(new Uint8Array(arr))
      }
    } catch {
      // Not JSON
    }

    throw new Error(
      "Invalid private key format. Expected base58-encoded keypair, " +
        "base64-encoded 64-byte keypair, or JSON byte array.",
    )
  }

  private getActiveKeypair(): Keypair {
    if (!this.state.activeAccount) {
      throw new Error("No active account. Connect the wallet first.")
    }
    const kp = this.keypairs.get(this.state.activeAccount)
    if (!kp) {
      throw new Error(`No keypair found for account ${this.state.activeAccount}`)
    }
    return kp
  }

  private resolveKeypair(addressOrLabel: string): Keypair | null {
    // Try label first
    const byLabel = this.labelMap.get(addressOrLabel)
    if (byLabel) {
      return this.keypairs.get(byLabel) ?? null
    }
    // Try direct address
    return this.keypairs.get(addressOrLabel) ?? null
  }

  private async notifyPages(event: string, data: any): Promise<void> {
    if (!this.context) return

    const pages = this.context.pages()
    for (const page of pages) {
      try {
        await page.evaluate(
          ({ event, data }) => {
            const provider = (window as any).solana
            if (provider && provider._isSolanaProvider) {
              // Trigger listeners by dispatching a custom event
              const customEvent = new CustomEvent(`__dappInspector_${event}`, {
                detail: data,
              })
              window.dispatchEvent(customEvent)
            }
          },
          { event, data },
        )
      } catch {
        // Page may have been closed
      }
    }
  }

  // ── Wallet tool registration ──

  private registerWalletTools(registry: ToolRegistry): void {
    registry.register({
      name: "wallet_connect",
      description:
        "Connects the Solana wallet, simulating user approval. Optionally specify an account by label or address.",
      inputSchema: {
        properties: {
          account: {
            type: "string",
            description: "Account label or address to connect (default: first configured account)",
          },
        },
        required: [],
      },
      handler: async (input: { account?: string }) => {
        try {
          return await this.connect(input.account)
        } catch (err: any) {
          return toolError("CONNECT_FAILED", err.message)
        }
      },
    })

    registry.register({
      name: "wallet_disconnect",
      description: "Disconnects the Solana wallet.",
      inputSchema: { properties: {}, required: [] },
      handler: async () => {
        try {
          await this.disconnect()
          return { success: true }
        } catch (err: any) {
          return toolError("DISCONNECT_FAILED", err.message)
        }
      },
    })

    registry.register({
      name: "wallet_switch_account",
      description: "Switches the active wallet account.",
      inputSchema: {
        properties: {
          address: {
            type: "string",
            description: "Address or label of the account to switch to",
          },
        },
        required: ["address"],
      },
      handler: async (input: { address: string }) => {
        try {
          await this.switchAccount(input.address)
          return { success: true, activeAccount: this.state.activeAccount }
        } catch (err: any) {
          return toolError("SWITCH_ACCOUNT_FAILED", err.message)
        }
      },
    })

    registry.register({
      name: "wallet_set_auto_approve",
      description:
        "Enables or disables auto-approval for all transactions. " +
        "When enabled, transactions are signed and submitted without waiting for explicit approval.",
      inputSchema: {
        properties: {
          enabled: { type: "boolean", description: "Enable or disable auto-approve" },
        },
        required: ["enabled"],
      },
      handler: async (input: { enabled: boolean }) => {
        this.setAutoApprove(input.enabled)
        return { autoApprove: this.state.autoApprove }
      },
    })

    registry.register({
      name: "wallet_approve_transaction",
      description:
        "Approves the currently pending transaction (when auto-approve is off). " +
        "Signs the transaction with the active account and submits it to the devnet.",
      inputSchema: { properties: {}, required: [] },
      handler: async () => {
        try {
          return await this.approveTransaction()
        } catch (err: any) {
          return toolError("APPROVE_FAILED", err.message)
        }
      },
    })

    registry.register({
      name: "wallet_reject_transaction",
      description:
        "Rejects the currently pending transaction with an optional reason.",
      inputSchema: {
        properties: {
          reason: { type: "string", description: "Rejection reason" },
        },
        required: [],
      },
      handler: async (input: { reason?: string }) => {
        try {
          await this.rejectTransaction(input.reason)
          return { success: true }
        } catch (err: any) {
          return toolError("REJECT_FAILED", err.message)
        }
      },
    })

    registry.register({
      name: "wallet_get_state",
      description: "Returns the full current wallet state.",
      inputSchema: { properties: {}, required: [] },
      handler: async () => {
        return this.getWalletState()
      },
    })

    registry.register({
      name: "wallet_get_pending_transaction",
      description:
        "Returns the currently pending transaction payload if one exists.",
      inputSchema: { properties: {}, required: [] },
      handler: async () => {
        return this.getPendingTransaction() ?? { pending: false }
      },
    })
  }
}
