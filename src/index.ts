// Main entrypoint for dapp-inspector

export { createServer, startServer } from "./mcp/server.js"
export type { ServerContext } from "./mcp/server.js"

export { ToolRegistryImpl } from "./mcp/registry.js"
export type { McpToolSchema, DispatchResult } from "./mcp/registry.js"

// Re-export all types from interface for library consumers
export type {
  ToolDefinition,
  ToolRegistry,
  ToolError,
  WalletState,
  PendingTransaction,
  AccountConfig,
  AdapterConfig,
  BridgeCall,
  BridgeResult,
  DappInspectorAdapter,
} from "./adapters/interface.js"
export { toolError } from "./adapters/interface.js"

// Re-export config types
export type { DappInspectorConfig } from "./config/schema.js"
export { loadConfig } from "./config/loader.js"
