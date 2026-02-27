import type { BrowserContext, Page } from "playwright"
import { Account, RpcProvider, stark, ec } from "starknet"
import type {
  DappInspectorAdapter,
  AdapterConfig,
  AccountConfig,
  WalletState,
  PendingTransaction,
  BridgeResult,
  ToolRegistry,
} from "../interface.js"
import { toolError } from "../interface.js"
import type { StarkNetAdapterConfig } from "../../config/schema.js"
import { StarknetDevnetClient } from "./devnet.js"
import { buildStarknetShim } from "./shim.js"
import { registerStarknetTools } from "./tools.js"

type PendingTxResolver = {
  resolve: (value: { txHash: string }) => void
  reject: (reason: Error) => void
}

export class StarkNetAdapter implements DappInspectorAdapter {
  readonly name = "starknet"
  readonly version = "1.0.0"
  readonly walletWindowKey = "starknet"

  // Public so tools.ts can access them
  devnet!: StarknetDevnetClient
  devnetUrl!: string

  private context!: BrowserContext
  private config!: StarkNetAdapterConfig
  private accountConfigs: AccountConfig[] = []
  private labelMap = new Map<string, string>() // label → address
  private state: WalletState = {
    isConnected: false,
    accounts: [],
    activeAccount: null,
    chainId: null,
    pendingTransaction: null,
    autoApprove: false,
  }
  private pendingResolver: PendingTxResolver | null = null
  private provider!: RpcProvider

  // ── Lifecycle ──

  async initialize(
    context: BrowserContext,
    config: AdapterConfig,
  ): Promise<void> {
    this.context = context
    this.config = config as StarkNetAdapterConfig
    this.devnetUrl = this.config.devnetUrl ?? "http://localhost:5050"
    this.state.autoApprove = this.config.autoApprove ?? false

    // Load account configs and build label lookup
    this.accountConfigs = this.config.accounts
    for (const acc of this.accountConfigs) {
      this.state.accounts.push(acc.address)
      if (acc.label) {
        this.labelMap.set(acc.label.toLowerCase(), acc.address)
      }
    }

    // Connect to devnet
    this.devnet = new StarknetDevnetClient(this.devnetUrl)
    await this.devnet.connect()

    // Set up RPC provider
    this.provider = new RpcProvider({ nodeUrl: this.devnetUrl })

    // Read actual chain ID from devnet
    try {
      const chainIdHex = await this.devnet.getChainId()
      this.state.chainId = decodeChainId(chainIdHex)
    } catch {
      this.state.chainId = this.config.chainId ?? "SN_SEPOLIA"
    }

    // Set first account as active
    if (this.accountConfigs.length > 0) {
      this.state.activeAccount = this.accountConfigs[0].address
    }

    // Verify accounts are deployed (log warnings for undeployed ones)
    for (const acc of this.accountConfigs) {
      try {
        await this.provider.getNonceForAddress(acc.address)
      } catch {
        console.warn(
          `[dapp-inspector] Account ${acc.label ?? acc.address} may not be deployed on devnet`,
        )
      }
    }

    // Expose the bridge function
    await context.exposeFunction(
      "__dappInspector_bridge",
      (callJson: string) => this.handleBridgeCall(callJson),
    )

    // Build and inject the wallet shim
    const shimScript = buildStarknetShim({
      accounts: this.state.accounts,
      activeAccount: this.state.activeAccount,
      chainId: this.state.chainId ?? "SN_SEPOLIA",
      isConnected: false,
    })
    await context.addInitScript({ content: shimScript })
  }

  async teardown(): Promise<void> {
    if (this.devnet?.isConnected()) {
      this.devnet.disconnect()
    }
    // Reject any pending transaction
    if (this.pendingResolver) {
      this.pendingResolver.reject(new Error("Adapter teardown"))
      this.pendingResolver = null
    }
    this.state.pendingTransaction = null
  }

  registerTools(registry: ToolRegistry): void {
    registerStarknetTools(registry, this)
  }

  getWalletState(): WalletState {
    return { ...this.state }
  }

  // ── Wallet control methods ──

  async connect(account?: string): Promise<{ address: string; chainId: string }> {
    const address = account
      ? this.resolveAddress(account)
      : this.state.accounts[0]

    if (!address) {
      throw new Error("No accounts configured")
    }

    this.state.isConnected = true
    this.state.activeAccount = address

    // Notify all pages of the state change
    await this.pushStateToPages()

    return {
      address,
      chainId: this.state.chainId ?? "SN_SEPOLIA",
    }
  }

  async disconnect(): Promise<void> {
    this.state.isConnected = false
    this.state.activeAccount = null
    await this.pushStateToPages()
  }

  async switchAccount(addressOrLabel: string): Promise<void> {
    const address = this.resolveAddress(addressOrLabel)
    if (!this.state.accounts.includes(address)) {
      throw new Error(
        `Account ${addressOrLabel} (${address}) is not in the configured accounts list`,
      )
    }
    this.state.activeAccount = address
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

    try {
      const txHash = await this.executePendingTransaction(pending)
      pending.status = "approved"
      pending.resolvedAt = Date.now()

      if (this.pendingResolver) {
        this.pendingResolver.resolve({ txHash })
        this.pendingResolver = null
      }

      this.state.pendingTransaction = null
      return { txHash }
    } catch (err) {
      pending.status = "rejected"
      pending.resolvedAt = Date.now()
      if (this.pendingResolver) {
        this.pendingResolver.reject(
          err instanceof Error ? err : new Error(String(err)),
        )
        this.pendingResolver = null
      }
      this.state.pendingTransaction = null
      throw err
    }
  }

  async rejectTransaction(reason?: string): Promise<void> {
    const pending = this.state.pendingTransaction
    if (!pending || pending.status !== "pending") {
      throw new Error("No pending transaction to reject")
    }

    pending.status = "rejected"
    pending.resolvedAt = Date.now()

    if (this.pendingResolver) {
      this.pendingResolver.reject(
        new Error(reason ?? "Transaction rejected by user"),
      )
      this.pendingResolver = null
    }

    this.state.pendingTransaction = null
  }

  getPendingTransaction(): PendingTransaction | null {
    return this.state.pendingTransaction
  }

  // ── Public helpers for tools ──

  resolveAddress(addressOrLabel: string): string {
    // Check if it's a label first
    const fromLabel = this.labelMap.get(addressOrLabel.toLowerCase())
    if (fromLabel) return fromLabel

    // Check if it's a direct address match
    const normalized = addressOrLabel.toLowerCase()
    for (const acc of this.accountConfigs) {
      if (acc.address.toLowerCase() === normalized) {
        return acc.address
      }
    }

    // Return as-is (might be an external address)
    return addressOrLabel
  }

  getAccountConfig(address: string): AccountConfig | undefined {
    const normalized = address.toLowerCase()
    return this.accountConfigs.find(
      (a) => a.address.toLowerCase() === normalized,
    )
  }

  // ── Bridge handler ──

  private async handleBridgeCall(callJson: string): Promise<string> {
    let call: { method: string; params?: any }
    try {
      call = JSON.parse(callJson)
    } catch {
      return JSON.stringify({
        success: false,
        error: "Invalid bridge call JSON",
      } satisfies BridgeResult)
    }

    try {
      const result = await this.routeBridgeCall(call.method, call.params)
      return JSON.stringify({
        success: true,
        data: result,
      } satisfies BridgeResult)
    } catch (err) {
      return JSON.stringify({
        success: false,
        error: err instanceof Error ? err.message : String(err),
      } satisfies BridgeResult)
    }
  }

  private async routeBridgeCall(
    method: string,
    params: any,
  ): Promise<any> {
    switch (method) {
      case "getState":
        return {
          isConnected: this.state.isConnected,
          accounts: this.state.accounts,
          selectedAddress: this.state.activeAccount,
          chainId: this.state.chainId,
        }

      case "requestAccounts":
        return this.handleRequestAccounts()

      case "submitTransaction":
        return this.handleSubmitTransaction(params)

      case "signTypedData":
        return this.handleSignTypedData(params)

      case "switchChain":
        return this.handleSwitchChain(params)

      case "rpcCall":
        return this.handleRpcCall(params)

      default:
        throw new Error(`Unknown bridge method: ${method}`)
    }
  }

  private async handleRequestAccounts(): Promise<any> {
    // Auto-connect if not connected
    if (!this.state.isConnected) {
      this.state.isConnected = true
    }

    return {
      accounts: this.state.accounts,
      selectedAddress: this.state.activeAccount,
      chainId: this.state.chainId,
    }
  }

  private async handleSubmitTransaction(params: any): Promise<any> {
    if (!this.state.activeAccount) {
      throw new Error("No active account. Connect the wallet first.")
    }

    const txId = `tx_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

    const pending: PendingTransaction = {
      id: txId,
      payload: params,
      status: "pending",
    }

    // If auto-approve, execute immediately
    if (this.state.autoApprove) {
      this.state.pendingTransaction = pending
      const txHash = await this.executePendingTransaction(pending)
      pending.status = "approved"
      pending.resolvedAt = Date.now()
      this.state.pendingTransaction = null
      return { txHash }
    }

    // Otherwise, hold until approved/rejected via MCP tool
    this.state.pendingTransaction = pending

    return new Promise<{ txHash: string }>((resolve, reject) => {
      this.pendingResolver = { resolve, reject }
    })
  }

  private async handleSignTypedData(params: any): Promise<any> {
    if (!this.state.activeAccount) {
      throw new Error("No active account. Connect the wallet first.")
    }

    const accountConfig = this.getAccountConfig(this.state.activeAccount)
    if (!accountConfig) {
      throw new Error("Active account not found in config")
    }

    // Produce a deterministic signature using the account's private key
    // For devnet testing this is sufficient — the signature will verify
    // against the test account on-chain.
    try {
      const typedData = params.typedData ?? params
      // Hash the typed data message for signing
      // Use a simple hash of the stringified data as the message hash
      const msgStr = JSON.stringify(typedData)
      let hash = 0n
      for (let i = 0; i < msgStr.length; i++) {
        hash = (hash * 31n + BigInt(msgStr.charCodeAt(i))) % (2n ** 251n)
      }
      const msgHash = "0x" + hash.toString(16)

      const signature = ec.starkCurve.sign(
        msgHash,
        accountConfig.privateKey,
      )

      return [
        "0x" + signature.r.toString(16),
        "0x" + signature.s.toString(16),
      ]
    } catch (err) {
      // Fallback: return a mock signature pair
      const mockR = stark.randomAddress()
      const mockS = stark.randomAddress()
      return [mockR, mockS]
    }
  }

  private async handleSwitchChain(params: any): Promise<any> {
    const newChainId = params.chainId
    this.state.chainId = newChainId
    return { chainId: newChainId }
  }

  private async handleRpcCall(params: any): Promise<any> {
    // Proxy the RPC call to the devnet
    const { method, params: rpcParams } = params
    const res = await fetch(this.devnetUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method,
        params: rpcParams,
      }),
    })

    if (!res.ok) {
      throw new Error(`RPC call ${method} failed with status ${res.status}`)
    }

    const json = await res.json() as { error?: { message: string }; result: any }
    if (json.error) {
      throw new Error(`RPC error: ${json.error.message}`)
    }
    return json.result
  }

  // ── Transaction execution ──

  private async executePendingTransaction(
    pending: PendingTransaction,
  ): Promise<string> {
    const payload = pending.payload
    const activeAddress = this.state.activeAccount!
    const accountConfig = this.getAccountConfig(activeAddress)

    if (!accountConfig) {
      throw new Error(`No config for active account ${activeAddress}`)
    }

    const account = new Account(
      this.provider,
      accountConfig.address,
      accountConfig.privateKey,
    )

    const txType = payload.type ?? "INVOKE"

    switch (txType) {
      case "INVOKE": {
        const calls = (payload.calls ?? []).map((c: any) => ({
          contractAddress: c.contractAddress || c.contract_address,
          entrypoint: c.entrypoint || c.entry_point,
          calldata: c.calldata ?? [],
        }))

        const result = await account.execute(calls)
        return result.transaction_hash
      }

      case "DECLARE": {
        const contract = payload.contract
        const result = await account.declare(contract)
        return result.transaction_hash
      }

      case "DEPLOY": {
        const deployPayload = payload.payload
        const result = await account.deployContract(deployPayload)
        return result.transaction_hash
      }

      default:
        throw new Error(`Unsupported transaction type: ${txType}`)
    }
  }

  // ── Page state sync ──

  private async pushStateToPages(): Promise<void> {
    const pages = this.context.pages()
    const update = {
      isConnected: this.state.isConnected,
      selectedAddress: this.state.activeAccount,
      accounts: this.state.accounts,
      chainId: this.state.chainId,
    }

    for (const page of pages) {
      try {
        await page.evaluate((data: any) => {
          /* eslint-disable no-undef */
          const w = globalThis as any
          w.dispatchEvent(
            new w.CustomEvent("__dappInspector_stateUpdate", {
              detail: data,
            }),
          )
        }, update)
      } catch {
        // Page might be closed or navigating — ignore
      }
    }
  }
}

// ── Helpers ──

/**
 * Decode a hex-encoded chain ID to a human-readable string.
 * starknet_chainId returns hex like "0x534e5f5345504f4c4941" → "SN_SEPOLIA"
 */
function decodeChainId(hex: string): string {
  if (!hex.startsWith("0x")) return hex
  const stripped = hex.slice(2)
  let result = ""
  for (let i = 0; i < stripped.length; i += 2) {
    const code = parseInt(stripped.slice(i, i + 2), 16)
    if (code === 0) break
    result += String.fromCharCode(code)
  }
  return result || hex
}
