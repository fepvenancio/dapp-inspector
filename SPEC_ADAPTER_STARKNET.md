# StarkNet Adapter Spec

This document covers everything specific to the StarkNet adapter. Read `SPEC_ADAPTERS.md` first for the base interface all adapters must implement.

---

## Wallet shim: `window.starknet`

The shim implements the `StarknetWindowObject` interface as defined by `get-starknet` and the StarkNet wallet standard (`@starknet-io/types-js`).

### Interface surface

```ts
interface StarknetWindowObject {
  id: string                    // "dapp-inspector"
  name: string                  // "DappInspector Test Wallet"
  version: string               // "1.0.0"
  icon: string                  // SVG data URI (simple icon)

  isConnected: boolean
  selectedAddress: string | undefined
  chainId: string | undefined
  account: AccountInterface | undefined
  provider: ProviderInterface

  // Connection
  enable(options?: { starknetVersion?: "v4" | "v5" }): Promise<string[]>
  isPreauthorized(): Promise<boolean>
  
  // Events (EIP-1193 style)
  on(event: "accountsChanged" | "networkChanged", handler: Function): void
  off(event: "accountsChanged" | "networkChanged", handler: Function): void

  // Request (SNIP-12 style)
  request(call: RpcMessage): Promise<any>
}
```

### Supported RPC methods in the shim

| Method | Behavior |
|---|---|
| `wallet_getPermissions` | Returns current permissions |
| `wallet_requestAccounts` | Triggers connection flow via bridge |
| `wallet_watchAsset` | Always returns `true` |
| `wallet_addStarknetChain` | Always returns `true` |
| `wallet_switchStarknetChain` | Updates chainId via bridge |
| `wallet_requestChainId` | Returns current chainId |
| `wallet_deploymentData` | Returns mock deployment data |
| `wallet_addInvokeTransaction` | Submits tx via bridge, returns txHash |
| `wallet_addDeclareTransaction` | Submits declare via bridge |
| `wallet_signTypedData` | Signs via bridge (returns mock signature) |
| `wallet_supportedSpecs` | Returns `["0.6", "0.7"]` |

### Transaction flow (invoke)

```
DApp calls window.starknet.account.execute([calls])
    │
    ▼
Shim calls bridge: { method: "submitTransaction", params: { calls, ... } }
    │
    ▼
Adapter receives call
  if autoApprove:
    → forwards to devnet RPC immediately
    → returns { txHash }
  else:
    → stores in pendingTransaction
    → returns pending Promise
    → Promise resolves when wallet_approve_transaction tool is called
    │
    ▼
DApp receives txHash and polls for receipt
```

### Signature (signTypedData)

The shim returns a deterministic mock signature derived from the account's private key using `starknet.js` signing primitives. This means signature verification on-chain will pass on devnet (where the test account is a real deployed account) but will not produce a real mainnet-valid signature.

---

## Required adapter config fields

```ts
type StarkNetAdapterConfig = AdapterConfig & {
  devnetUrl?: string          // default: "http://localhost:5050"
  starknetVersion?: "v5" | "v6"  // starknet.js version, default: "v6"
  chainId?: string            // default: "SN_SEPOLIA" (devnet default)
  autoApprove?: boolean       // default: false
}
```

---

## Devnet integration: `starknet-devnet`

The adapter connects to a running `starknet-devnet` instance. It does **not** manage the devnet process lifecycle — the user is expected to start it separately. (A future enhancement could add a `devnet_start` / `devnet_stop` tool.)

Connection is via HTTP using the `starknet-devnet` REST API and JSON-RPC endpoint.

### StarkNet-specific MCP tools

#### `starknet_mint_tokens`
Mints ETH or STRK to a test account.

**Input**
```ts
{
  address: string
  amount: string        // in wei as a decimal string
  token?: "ETH" | "STRK"  // default: "ETH"
}
```

**Output**: `{ newBalance: string, txHash: string }`

---

#### `starknet_get_balance`
Gets the ETH or STRK balance of an address.

**Input**
```ts
{
  address: string
  token?: "ETH" | "STRK"
}
```

**Output**: `{ balance: string, formatted: string }` (raw wei + formatted with 18 decimals)

---

#### `starknet_advance_time`
Advances the devnet's block timestamp by a given number of seconds. Critical for testing time-dependent logic like loan expiry, liquidation windows, or vesting schedules.

**Input**
```ts
{
  seconds: number
}
```

**Output**: `{ newTimestamp: number, newBlock: number }`

---

#### `starknet_mine_block`
Forces the devnet to mine a new block immediately (useful when devnet is in interval mining mode).

**Output**: `{ blockNumber: number, blockHash: string }`

---

#### `starknet_get_transaction`
Gets the status and receipt of a transaction by hash.

**Input**
```ts
{
  txHash: string
}
```

**Output**
```ts
{
  status: "RECEIVED" | "PENDING" | "ACCEPTED_ON_L2" | "REJECTED" | "REVERTED"
  receipt: {
    actualFee: string
    events: Array<{ fromAddress: string, keys: string[], data: string[] }>
    revertReason?: string
  }
}
```

---

#### `starknet_call`
Makes a read-only contract call directly through the devnet, bypassing the browser entirely.

**Input**
```ts
{
  contractAddress: string
  entrypoint: string
  calldata?: string[]
}
```

**Output**: `{ result: string[] }`

---

#### `starknet_deploy_account`
Deploys a test account contract on the devnet if it isn't already deployed. Devnet pre-deployed accounts are already deployed, but custom accounts need this.

**Input**
```ts
{
  address: string   // must match a configured account
}
```

---

#### `starknet_get_storage`
Reads raw contract storage at a given key.

**Input**
```ts
{
  contractAddress: string
  key: string
}
```

**Output**: `{ value: string }`

---

#### `starknet_fork_reset`
If the devnet was started in fork mode, resets it to the forked block state. Useful for resetting between test scenarios.

---

## Account management

On initialization, the adapter:

1. Loads all configured accounts from config
2. Verifies each account is deployed on the devnet (or logs a warning)
3. Sets the first account as the active wallet account
4. Sets `window.starknet.selectedAddress` and `window.starknet.account` in the shim state

Accounts can be referenced by their `label` field in tool inputs (e.g. `"borrower"` instead of the full address) — the adapter resolves labels to addresses transparently.

---

## Chain IDs

| Network | Chain ID |
|---|---|
| starknet-devnet (local) | `SN_GOERLI` or `SN_SEPOLIA` (configured at devnet startup) |
| Sepolia testnet | `SN_SEPOLIA` |
| Mainnet | `SN_MAIN` |

The adapter reads the actual chain ID from the devnet on startup via `starknet_chainId` RPC call and uses that as the default. If the DApp checks `chainId` and it doesn't match what it expects, the adapter logs a warning.

---

## Stela-specific usage notes

When testing Stela with dapp-inspector, a typical setup looks like:

```json
{
  "chain": "starknet",
  "adapter": {
    "devnetUrl": "http://localhost:5050",
    "autoApprove": false,
    "accounts": [
      { "address": "0x...", "privateKey": "0x...", "label": "borrower" },
      { "address": "0x...", "privateKey": "0x...", "label": "lender_1" },
      { "address": "0x...", "privateKey": "0x...", "label": "lender_2" }
    ]
  }
}
```

Claude can then test multi-lender scenarios by:
1. Switching accounts between borrower and lender flows via `wallet_switch_account`
2. Controlling each transaction approval individually via `wallet_approve_transaction`
3. Fast-forwarding time to trigger loan expiry via `starknet_advance_time`
4. Asserting on-chain state via `starknet_call` after UI actions
