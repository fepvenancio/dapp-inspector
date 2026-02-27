# Adapter Interface Spec

Every chain adapter in dapp-inspector implements the same interface. This document defines that contract. If you're building a new adapter, this is your starting point.

---

## Overview

An adapter is a TypeScript class that:

1. Injects a wallet shim into the browser context
2. Controls wallet behavior through an in-memory state machine
3. Provides a devnet client for chain state manipulation
4. Registers chain-specific MCP tools

The adapter does not own the browser — the core engine does. The adapter receives the `BrowserContext` from Playwright and uses it only to inject scripts and expose bridge functions.

---

## The `DappInspectorAdapter` interface

```ts
interface DappInspectorAdapter {
  // Adapter metadata
  readonly name: string           // e.g. "starknet", "evm", "solana"
  readonly version: string
  readonly walletWindowKey: string  // e.g. "starknet", "ethereum", "solana"

  // Lifecycle
  initialize(context: BrowserContext, config: AdapterConfig): Promise<void>
  teardown(): Promise<void>

  // Tool registration
  registerTools(registry: ToolRegistry): void

  // Wallet state (read by MCP layer for page_get_summary)
  getWalletState(): WalletState
}
```

---

## Lifecycle methods

### `initialize(context, config)`

Called once after the browser context is created. The adapter must:

1. Call `context.addInitScript({ content: shimScript })` to inject the wallet shim into every page before page scripts run
2. Call `context.exposeFunction('__dappInspector_bridge', this.handleBridgeCall)` to expose the Node.js bridge
3. Connect to the devnet using the URL from `config.devnetUrl`
4. Load test accounts from `config.accounts`
5. Set up initial wallet state

**The shim must be injected before page scripts run.** `addInitScript` guarantees this — it runs before `DOMContentLoaded` and before any page JavaScript.

### `teardown()`

Called when the MCP session ends. The adapter must:
- Disconnect from the devnet
- Clear any running intervals or listeners
- Release resources

---

## Wallet shim contract

The shim is a JavaScript bundle injected into the page. It must:

- Assign itself to `window[adapter.walletWindowKey]` (e.g. `window.starknet`)
- Implement the chain's standard wallet interface faithfully — the DApp must not be able to distinguish it from a real wallet
- Communicate with the adapter via `window.__dappInspector_bridge(call: BridgeCall): Promise<BridgeResult>`
- Handle the case where the bridge is not yet available (race condition on very early page scripts)

### Bridge call format

```ts
type BridgeCall = {
  method: string      // e.g. "getState", "approveTransaction", "rejectTransaction"
  params?: any
}

type BridgeResult = {
  success: boolean
  data?: any
  error?: string
}
```

The bridge is the only communication channel between the shim (browser JS) and the adapter (Node.js). All wallet state transitions happen through this bridge.

---

## Wallet state machine

All adapters must maintain a wallet state object with at minimum these fields:

```ts
type WalletState = {
  isConnected: boolean
  accounts: string[]              // connected accounts/addresses
  activeAccount: string | null
  chainId: string | null
  pendingTransaction: PendingTransaction | null
  autoApprove: boolean            // if true, all transactions are approved automatically
}

type PendingTransaction = {
  id: string
  payload: any                    // chain-specific tx data
  status: "pending" | "approved" | "rejected"
  resolvedAt?: number
}
```

When `autoApprove` is `true`, the adapter approves all incoming transactions immediately. When `false`, the adapter holds them in `pendingTransaction` until `wallet_approve_transaction` or `wallet_reject_transaction` is called.

---

## Required MCP tools (every adapter must implement)

These tools are required regardless of chain. They form the shared wallet control API.

### `wallet_connect`
Simulates the user approving a wallet connection request.

**Input**: `{ account?: string }` — connects a specific account or the first test account

**Output**: `{ address: string, chainId: string }`

---

### `wallet_disconnect`
Disconnects the wallet.

---

### `wallet_switch_account`
Switches the active account.

**Input**: `{ address: string }`

---

### `wallet_set_auto_approve`
When enabled, all transactions are silently approved without needing explicit `wallet_approve_transaction` calls. Useful for testing flows where the transaction result matters but the approval UX doesn't.

**Input**: `{ enabled: boolean }`

---

### `wallet_approve_transaction`
Approves the currently pending transaction (when `autoApprove` is false).

**Output**: `{ txHash: string }`

---

### `wallet_reject_transaction`
Rejects the currently pending transaction with an optional reason.

**Input**: `{ reason?: string }`

---

### `wallet_get_state`
Returns the full current wallet state.

**Output**: `WalletState`

---

### `wallet_get_pending_transaction`
Returns the currently pending transaction payload if one exists.

**Output**: `PendingTransaction | null`

---

## Optional MCP tools (adapter-specific)

Adapters may register additional tools for chain-specific operations. These are documented in each adapter's spec. Examples:

- `devnet_mint_tokens` (StarkNet, EVM, Solana)
- `devnet_advance_time` (StarkNet, EVM)
- `devnet_impersonate_account` (EVM)
- `devnet_get_transaction` (all)

---

## Config schema

The user's `dapp-inspector.config.json` has this shape:

```ts
type DappInspectorConfig = {
  chain: "starknet" | "evm" | "solana" | string  // string for custom adapters
  adapterPath?: string   // path or npm package name for custom adapters
  
  browser: {
    headless?: boolean        // default: false
    viewport?: { width: number, height: number }
  }

  adapter: AdapterConfig     // chain-specific, validated by the adapter
}

type AdapterConfig = {
  devnetUrl?: string          // local devnet RPC URL
  accounts: Array<{
    address: string
    privateKey: string
    label?: string            // human-readable name for this account in tool outputs
  }>
  // + chain-specific fields
}
```

**Example config (StarkNet)**:
```json
{
  "chain": "starknet",
  "browser": {
    "headless": false
  },
  "adapter": {
    "devnetUrl": "http://localhost:5050",
    "accounts": [
      {
        "address": "0x064b48806902a367c8598f4f95c305e8c1a1acba5f082d294a43793113115691",
        "privateKey": "0x0000000000000000000000000000000071d7bb07b9a64f6f78ac4c816aff4da9",
        "label": "borrower"
      },
      {
        "address": "0x023b77f70ed80e6e7331cf7e83a73d657a4b1c0a86ee2de8d3d5b16dcbf89de",
        "privateKey": "0x00000000000000000000000000000000e3954de2ed4fb6cf1bc79d879ab5c7e5",
        "label": "lender"
      }
    ]
  }
}
```

---

## Tool registry API

The adapter receives a `ToolRegistry` in `registerTools`. It uses this to register its tools:

```ts
interface ToolRegistry {
  register(tool: ToolDefinition): void
}

type ToolDefinition = {
  name: string
  description: string
  inputSchema: JSONSchema
  handler: (input: any) => Promise<any>
}
```

Tool names must be globally unique. Adapter tools should be prefixed with the adapter name (e.g. `starknet_`, `evm_`, `solana_`) to avoid collisions with core tools or other adapters.

---

## Error handling

All tool handlers must return errors in a structured format rather than throwing:

```ts
type ToolError = {
  error: true
  code: string      // machine-readable, e.g. "NO_PENDING_TRANSACTION"
  message: string   // human-readable for Claude
  details?: any
}
```

This ensures Claude receives informative error messages and can reason about what went wrong.
