import type { BrowserContext } from "playwright"

// ── Wallet state ──

export type PendingTransaction = {
  id: string
  payload: any
  status: "pending" | "approved" | "rejected"
  resolvedAt?: number
}

export type WalletState = {
  isConnected: boolean
  accounts: string[]
  activeAccount: string | null
  chainId: string | null
  pendingTransaction: PendingTransaction | null
  autoApprove: boolean
}

// ── Tool registry ──

export type ToolDefinition = {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  handler: (input: any) => Promise<any>
}

export interface ToolRegistry {
  register(tool: ToolDefinition): void
}

// ── Adapter config ──

export type AccountConfig = {
  address: string
  privateKey: string
  label?: string
}

export type AdapterConfig = {
  devnetUrl?: string
  accounts: AccountConfig[]
  autoApprove?: boolean
  [key: string]: unknown
}

// ── Tool error ──

export type ToolError = {
  error: true
  code: string
  message: string
  details?: any
}

export function toolError(code: string, message: string, details?: any): ToolError {
  return { error: true, code, message, details }
}

// ── Bridge types ──

export type BridgeCall = {
  method: string
  params?: any
}

export type BridgeResult = {
  success: boolean
  data?: any
  error?: string
}

// ── Adapter interface ──

export interface DappInspectorAdapter {
  readonly name: string
  readonly version: string
  readonly walletWindowKey: string

  initialize(context: BrowserContext, config: AdapterConfig): Promise<void>
  teardown(): Promise<void>
  registerTools(registry: ToolRegistry): void
  getWalletState(): WalletState

  // Wallet control methods used by MCP tools
  connect(account?: string): Promise<{ address: string; chainId: string }>
  disconnect(): Promise<void>
  switchAccount(address: string): Promise<void>
  setAutoApprove(enabled: boolean): void
  approveTransaction(): Promise<{ txHash: string }>
  rejectTransaction(reason?: string): Promise<void>
  getPendingTransaction(): PendingTransaction | null
}
