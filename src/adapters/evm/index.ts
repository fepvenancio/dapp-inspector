import type { BrowserContext } from "playwright"
import {
  createWalletClient,
  http,
  toHex,
  hexToString,
} from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { foundry } from "viem/chains"
import type {
  DappInspectorAdapter,
  AdapterConfig,
  AccountConfig,
  WalletState,
  PendingTransaction,
  ToolRegistry,
  BridgeResult,
} from "../interface.js"
import { toolError } from "../interface.js"
import { AnvilClient } from "./anvil.js"
import { buildEvmShim } from "./shim.js"
import type { ShimInitialState } from "./shim.js"
import { registerEvmTools } from "./tools.js"
import type { EVMAdapterConfig } from "../../config/schema.js"
import { nanoid } from "nanoid"

export class EVMAdapter implements DappInspectorAdapter {
  readonly name = "evm"
  readonly version = "1.0.0"
  readonly walletWindowKey = "ethereum"

  private context: BrowserContext | null = null
  private anvil: AnvilClient | null = null
  private accounts: AccountConfig[] = []
  private accountLabels: Map<string, string> = new Map()
  private chainId: number = 31337
  private devnetUrl: string = "http://localhost:8545"
  private gasConfig?: { gasLimit?: string; gasPrice?: string }

  private state: WalletState = {
    isConnected: false,
    accounts: [],
    activeAccount: null,
    chainId: null,
    pendingTransaction: null,
    autoApprove: false,
  }

  // Promise resolvers for pending transactions
  private pendingTxResolve: ((result: BridgeResult) => void) | null = null

  async initialize(context: BrowserContext, config: AdapterConfig): Promise<void> {
    this.context = context
    const evmConfig = config as unknown as EVMAdapterConfig

    this.devnetUrl = evmConfig.devnetUrl ?? "http://localhost:8545"
    this.chainId = evmConfig.chainId ?? 31337
    this.gasConfig = evmConfig.gasConfig
    this.accounts = evmConfig.accounts
    this.state.autoApprove = evmConfig.autoApprove ?? false

    // Build account label map
    for (const account of this.accounts) {
      const addr = account.address.toLowerCase()
      if (account.label) {
        this.accountLabels.set(addr, account.label)
      }
    }

    // Connect to Anvil
    this.anvil = new AnvilClient(this.devnetUrl)
    const { chainId } = await this.anvil.connect()
    this.chainId = chainId

    // Set up state with all account addresses
    const addresses = this.accounts.map((a) => a.address)
    this.state.accounts = addresses
    this.state.chainId = "0x" + this.chainId.toString(16)

    // Log balances (non-blocking)
    this.logAccountBalances().catch(() => {})

    // Build and inject the shim script
    const shimState: ShimInitialState = {
      accounts: [],  // Start disconnected — DApp must call eth_requestAccounts
      chainId: "0x" + this.chainId.toString(16),
      isConnected: false,
    }
    const shimScript = buildEvmShim(shimState, this.devnetUrl, this.chainId)
    await context.addInitScript({ content: shimScript })

    // Expose the bridge function
    await context.exposeFunction(
      "__dappInspector_bridge",
      (callJson: string) => this.handleBridgeCallRaw(callJson),
    )
  }

  async teardown(): Promise<void> {
    this.anvil = null
    this.context = null
    this.pendingTxResolve = null
    this.state.pendingTransaction = null
  }

  registerTools(registry: ToolRegistry): void {
    // Register EVM-specific devnet tools
    registerEvmTools(registry, () => {
      if (!this.anvil) throw new Error("Anvil client not initialized")
      return this.anvil
    })

    // Register shared wallet tools
    this.registerWalletTools(registry)
  }

  getWalletState(): WalletState {
    return { ...this.state }
  }

  // ── Wallet control methods ──

  async connect(account?: string): Promise<{ address: string; chainId: string }> {
    const targetAccount = account
      ? this.resolveAccount(account)
      : this.accounts[0]

    if (!targetAccount) {
      throw new Error("No accounts configured")
    }

    this.state.isConnected = true
    this.state.activeAccount = targetAccount.address

    // Re-order accounts so active is first
    const addresses = this.accounts.map((a) => a.address)
    const activeIdx = addresses.indexOf(targetAccount.address)
    if (activeIdx > 0) {
      addresses.splice(activeIdx, 1)
      addresses.unshift(targetAccount.address)
    }
    this.state.accounts = addresses

    const chainId = "0x" + this.chainId.toString(16)
    this.state.chainId = chainId

    // Notify all pages about the state change
    await this.pushStateToPages()

    return { address: targetAccount.address, chainId }
  }

  async disconnect(): Promise<void> {
    this.state.isConnected = false
    this.state.activeAccount = null
    this.state.accounts = this.accounts.map((a) => a.address)

    await this.pushStateToPages()
  }

  async switchAccount(address: string): Promise<void> {
    const account = this.resolveAccount(address)
    if (!account) {
      throw new Error(`Account not found: ${address}`)
    }

    this.state.activeAccount = account.address

    // Re-order so active is first
    const addresses = this.accounts.map((a) => a.address)
    const activeIdx = addresses.indexOf(account.address)
    if (activeIdx > 0) {
      addresses.splice(activeIdx, 1)
      addresses.unshift(account.address)
    }
    this.state.accounts = addresses

    await this.pushStateToPages()
  }

  setAutoApprove(enabled: boolean): void {
    this.state.autoApprove = enabled
  }

  async approveTransaction(): Promise<{ txHash: string }> {
    const pending = this.state.pendingTransaction
    if (!pending || pending.status !== "pending") {
      throw new Error("No pending transaction to approve")
    }

    const txHash = await this.signAndSendTransaction(pending.payload)

    pending.status = "approved"
    pending.resolvedAt = Date.now()

    // Resolve the bridge promise
    if (this.pendingTxResolve) {
      this.pendingTxResolve({ success: true, data: { txHash } })
      this.pendingTxResolve = null
    }

    this.state.pendingTransaction = null
    return { txHash }
  }

  async rejectTransaction(reason?: string): Promise<void> {
    const pending = this.state.pendingTransaction
    if (!pending || pending.status !== "pending") {
      throw new Error("No pending transaction to reject")
    }

    pending.status = "rejected"
    pending.resolvedAt = Date.now()

    if (this.pendingTxResolve) {
      this.pendingTxResolve({
        success: false,
        error: reason || "Transaction rejected by user",
      })
      this.pendingTxResolve = null
    }

    this.state.pendingTransaction = null
  }

  getPendingTransaction(): PendingTransaction | null {
    return this.state.pendingTransaction
  }

  // ── Bridge handling ──

  private async handleBridgeCallRaw(callJson: string): Promise<string> {
    try {
      const call = JSON.parse(callJson)
      const result = await this.handleBridgeCall(call.method, call.params)
      return JSON.stringify(result)
    } catch (e: any) {
      return JSON.stringify({ success: false, error: e.message })
    }
  }

  private async handleBridgeCall(method: string, params?: any): Promise<BridgeResult> {
    switch (method) {
      case "getState":
        return {
          success: true,
          data: {
            accounts: this.state.isConnected ? this.state.accounts : [],
            chainId: this.state.chainId,
            isConnected: this.state.isConnected,
          },
        }

      case "requestAccounts": {
        // Auto-connect with the first account
        const result = await this.connect()
        return {
          success: true,
          data: {
            accounts: this.state.accounts,
            chainId: result.chainId,
          },
        }
      }

      case "sendTransaction":
        return this.handleSendTransaction(params)

      case "sign":
        return this.handleSign(params)

      case "personalSign":
        return this.handlePersonalSign(params)

      case "signTypedData":
        return this.handleSignTypedData(params)

      case "switchChain":
        return this.handleSwitchChain(params)

      case "rpcProxy":
        return this.handleRpcProxy(params)

      default:
        return { success: false, error: `Unknown bridge method: ${method}` }
    }
  }

  private async handleSendTransaction(txPayload: any): Promise<BridgeResult> {
    if (this.state.autoApprove) {
      try {
        const txHash = await this.signAndSendTransaction(txPayload)
        return { success: true, data: { txHash } }
      } catch (e: any) {
        return { success: false, error: e.message }
      }
    }

    // Queue as pending transaction
    const pendingTx: PendingTransaction = {
      id: nanoid(),
      payload: txPayload,
      status: "pending",
    }
    this.state.pendingTransaction = pendingTx

    // Return a promise that will be resolved when approve/reject is called
    return new Promise<BridgeResult>((resolve) => {
      this.pendingTxResolve = resolve
    })
  }

  private async handleSign(params: {
    address: string
    message: string
  }): Promise<BridgeResult> {
    try {
      const account = this.findAccountByAddress(params.address)
      if (!account) {
        return { success: false, error: `Account not found: ${params.address}` }
      }

      const viemAccount = privateKeyToAccount(account.privateKey as `0x${string}`)
      const signature = await viemAccount.signMessage({
        message: { raw: params.message as `0x${string}` },
      })

      return { success: true, data: { signature } }
    } catch (e: any) {
      return { success: false, error: e.message }
    }
  }

  private async handlePersonalSign(params: {
    message: string
    address: string
  }): Promise<BridgeResult> {
    try {
      const account = this.findAccountByAddress(params.address)
      if (!account) {
        return { success: false, error: `Account not found: ${params.address}` }
      }

      const viemAccount = privateKeyToAccount(account.privateKey as `0x${string}`)

      // personal_sign message is hex-encoded
      let messageContent: string | { raw: `0x${string}` }
      if (params.message.startsWith("0x")) {
        try {
          messageContent = hexToString(params.message as `0x${string}`)
        } catch {
          messageContent = { raw: params.message as `0x${string}` }
        }
      } else {
        messageContent = params.message
      }

      const signature = await viemAccount.signMessage({
        message: messageContent,
      })

      return { success: true, data: { signature } }
    } catch (e: any) {
      return { success: false, error: e.message }
    }
  }

  private async handleSignTypedData(params: {
    address: string
    typedData: string
  }): Promise<BridgeResult> {
    try {
      const account = this.findAccountByAddress(params.address)
      if (!account) {
        return { success: false, error: `Account not found: ${params.address}` }
      }

      const viemAccount = privateKeyToAccount(account.privateKey as `0x${string}`)

      // Parse the typed data (DApps send it as a JSON string)
      const typedData =
        typeof params.typedData === "string"
          ? JSON.parse(params.typedData)
          : params.typedData

      const signature = await viemAccount.signTypedData({
        domain: typedData.domain,
        types: typedData.types,
        primaryType: typedData.primaryType,
        message: typedData.message,
      })

      return { success: true, data: { signature } }
    } catch (e: any) {
      return { success: false, error: e.message }
    }
  }

  private async handleSwitchChain(params: {
    chainId: string
  }): Promise<BridgeResult> {
    const requestedChainId = parseInt(params.chainId, 16)

    // If the requested chain matches our current devnet, update
    if (requestedChainId === this.chainId) {
      return { success: true, data: { chainId: params.chainId } }
    }

    // For now, we update the reported chain ID. In the future, this could
    // switch to a different Anvil instance.
    this.chainId = requestedChainId
    this.state.chainId = params.chainId

    await this.pushStateToPages()

    return { success: true, data: { chainId: params.chainId } }
  }

  private async handleRpcProxy(params: {
    method: string
    params: any[]
  }): Promise<BridgeResult> {
    try {
      if (!this.anvil) {
        return { success: false, error: "Anvil client not initialized" }
      }
      const result = await this.anvil.rpc(params.method, params.params)
      return { success: true, data: result }
    } catch (e: any) {
      return { success: false, error: e.message }
    }
  }

  // ── Transaction signing ──

  private async signAndSendTransaction(txPayload: any): Promise<string> {
    if (!this.state.activeAccount) {
      throw new Error("No active account")
    }

    const account = this.findAccountByAddress(this.state.activeAccount)
    if (!account) {
      throw new Error(`Active account not found: ${this.state.activeAccount}`)
    }

    const viemAccount = privateKeyToAccount(account.privateKey as `0x${string}`)

    const chain = {
      ...foundry,
      id: this.chainId,
    }

    const walletClient = createWalletClient({
      account: viemAccount,
      chain,
      transport: http(this.devnetUrl),
    })

    // Build the transaction request
    const txRequest: Record<string, any> = {
      to: txPayload.to as `0x${string}`,
      data: txPayload.data as `0x${string}` | undefined,
      value: txPayload.value ? BigInt(txPayload.value) : undefined,
    }

    // Apply gas overrides from config
    if (this.gasConfig?.gasLimit) {
      txRequest.gas = BigInt(this.gasConfig.gasLimit)
    } else if (txPayload.gas) {
      txRequest.gas = BigInt(txPayload.gas)
    } else if (txPayload.gasLimit) {
      txRequest.gas = BigInt(txPayload.gasLimit)
    }

    if (this.gasConfig?.gasPrice) {
      txRequest.gasPrice = BigInt(this.gasConfig.gasPrice)
    } else if (txPayload.gasPrice) {
      txRequest.gasPrice = BigInt(txPayload.gasPrice)
    }

    if (txPayload.maxFeePerGas) {
      txRequest.maxFeePerGas = BigInt(txPayload.maxFeePerGas)
    }
    if (txPayload.maxPriorityFeePerGas) {
      txRequest.maxPriorityFeePerGas = BigInt(txPayload.maxPriorityFeePerGas)
    }
    if (txPayload.nonce !== undefined) {
      txRequest.nonce = parseInt(txPayload.nonce, 16)
    }

    const txHash = await walletClient.sendTransaction(txRequest)
    return txHash
  }

  // ── Account helpers ──

  private resolveAccount(addressOrLabel: string): AccountConfig | undefined {
    // Try direct address match (case-insensitive)
    const byAddress = this.accounts.find(
      (a) => a.address.toLowerCase() === addressOrLabel.toLowerCase(),
    )
    if (byAddress) return byAddress

    // Try label match
    const byLabel = this.accounts.find(
      (a) => a.label?.toLowerCase() === addressOrLabel.toLowerCase(),
    )
    if (byLabel) return byLabel

    return undefined
  }

  private findAccountByAddress(address: string): AccountConfig | undefined {
    return this.accounts.find(
      (a) => a.address.toLowerCase() === address.toLowerCase(),
    )
  }

  private getAccountLabel(address: string): string {
    const label = this.accountLabels.get(address.toLowerCase())
    return label ? `${label} (${address})` : address
  }

  // ── State synchronization ──

  private async pushStateToPages(): Promise<void> {
    if (!this.context) return

    const stateUpdate = {
      accounts: this.state.isConnected ? this.state.accounts : [],
      isConnected: this.state.isConnected,
      chainId: this.state.chainId,
    }

    const script = `
      if (window.ethereum && window.ethereum._updateState) {
        window.ethereum._updateState(${JSON.stringify(stateUpdate)});
      }
    `

    try {
      for (const page of this.context.pages()) {
        await page.evaluate(script).catch(() => {
          // Page may have navigated or closed
        })
      }
    } catch {
      // Context may have closed
    }
  }

  private async logAccountBalances(): Promise<void> {
    if (!this.anvil) return

    for (const account of this.accounts) {
      try {
        const { formatted } = await this.anvil.getBalance(account.address)
        const label = this.getAccountLabel(account.address)
        console.log(`[EVM] Account ${label}: ${formatted}`)
      } catch {
        // Non-critical — skip
      }
    }
  }

  // ── Wallet tool registration ──

  private registerWalletTools(registry: ToolRegistry): void {
    registry.register({
      name: "wallet_connect",
      description:
        "Connects the wallet, simulating the user approving a connection request. Optionally specify an account address or label.",
      inputSchema: {
        type: "object",
        properties: {
          account: {
            type: "string",
            description:
              "Account address or label to connect (default: first account)",
          },
        },
        required: [],
      },
      handler: async (input: { account?: string }) => {
        try {
          return await this.connect(input.account)
        } catch (e: any) {
          return toolError("CONNECT_FAILED", e.message)
        }
      },
    })

    registry.register({
      name: "wallet_disconnect",
      description: "Disconnects the wallet from the DApp.",
      inputSchema: {
        type: "object",
        properties: {},
        required: [],
      },
      handler: async () => {
        try {
          await this.disconnect()
          return { success: true }
        } catch (e: any) {
          return toolError("DISCONNECT_FAILED", e.message)
        }
      },
    })

    registry.register({
      name: "wallet_switch_account",
      description:
        "Switches the active account. Accepts an address or label.",
      inputSchema: {
        type: "object",
        properties: {
          address: {
            type: "string",
            description: "Account address or label to switch to",
          },
        },
        required: ["address"],
      },
      handler: async (input: { address: string }) => {
        try {
          await this.switchAccount(input.address)
          return {
            success: true,
            activeAccount: this.getAccountLabel(
              this.state.activeAccount!,
            ),
          }
        } catch (e: any) {
          return toolError("SWITCH_ACCOUNT_FAILED", e.message)
        }
      },
    })

    registry.register({
      name: "wallet_set_auto_approve",
      description:
        "When enabled, all transactions are silently approved without needing explicit wallet_approve_transaction calls.",
      inputSchema: {
        type: "object",
        properties: {
          enabled: {
            type: "boolean",
            description: "Whether to enable auto-approve",
          },
        },
        required: ["enabled"],
      },
      handler: async (input: { enabled: boolean }) => {
        this.setAutoApprove(input.enabled)
        return { autoApprove: input.enabled }
      },
    })

    registry.register({
      name: "wallet_approve_transaction",
      description:
        "Approves the currently pending transaction (when autoApprove is false).",
      inputSchema: {
        type: "object",
        properties: {},
        required: [],
      },
      handler: async () => {
        try {
          return await this.approveTransaction()
        } catch (e: any) {
          return toolError("NO_PENDING_TRANSACTION", e.message)
        }
      },
    })

    registry.register({
      name: "wallet_reject_transaction",
      description:
        "Rejects the currently pending transaction with an optional reason.",
      inputSchema: {
        type: "object",
        properties: {
          reason: {
            type: "string",
            description: "Optional rejection reason",
          },
        },
        required: [],
      },
      handler: async (input: { reason?: string }) => {
        try {
          await this.rejectTransaction(input.reason)
          return { success: true }
        } catch (e: any) {
          return toolError("NO_PENDING_TRANSACTION", e.message)
        }
      },
    })

    registry.register({
      name: "wallet_get_state",
      description: "Returns the full current wallet state.",
      inputSchema: {
        type: "object",
        properties: {},
        required: [],
      },
      handler: async () => {
        const walletState = this.getWalletState()
        // Enrich with labels
        return {
          ...walletState,
          activeAccountLabel: walletState.activeAccount
            ? this.getAccountLabel(walletState.activeAccount)
            : null,
          accountsWithLabels: walletState.accounts.map((addr) => ({
            address: addr,
            label: this.accountLabels.get(addr.toLowerCase()) ?? null,
          })),
        }
      },
    })

    registry.register({
      name: "wallet_get_pending_transaction",
      description:
        "Returns the currently pending transaction payload if one exists.",
      inputSchema: {
        type: "object",
        properties: {},
        required: [],
      },
      handler: async () => {
        return this.getPendingTransaction() ?? { pending: false }
      },
    })
  }
}
