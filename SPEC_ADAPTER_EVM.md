# EVM Adapter Spec

This document covers the EVM adapter (Ethereum mainnet, L2s: Arbitrum, Optimism, Base, etc.). Read `SPEC_ADAPTERS.md` first for the base interface.

---

## Wallet shim: `window.ethereum`

The shim implements the EIP-1193 provider interface, which is the universal standard all EVM DApps expect.

### Interface surface

```ts
interface EIP1193Provider {
  isMetaMask: boolean          // true — many DApps gate on this
  isConnected(): boolean
  
  request(args: { method: string, params?: any[] }): Promise<any>
  
  on(event: string, listener: Function): void
  removeListener(event: string, listener: Function): void
  
  // Legacy (still used by older DApps)
  send?(method: string, params?: any[]): Promise<any>
  sendAsync?(payload: any, callback: Function): void
}
```

### Supported RPC methods in the shim

| Method | Behavior |
|---|---|
| `eth_accounts` | Returns connected accounts |
| `eth_requestAccounts` | Triggers connection via bridge |
| `eth_chainId` | Returns current chainId (hex) |
| `net_version` | Returns chain ID as decimal string |
| `eth_getBalance` | Proxies to devnet RPC |
| `eth_sendTransaction` | Submits tx via bridge |
| `eth_sign` | Signs via bridge |
| `personal_sign` | Signs via bridge |
| `eth_signTypedData_v4` | EIP-712 signing via bridge |
| `wallet_switchEthereumChain` | Updates chainId via bridge |
| `wallet_addEthereumChain` | Always succeeds |
| `wallet_watchAsset` | Always succeeds |
| `eth_getTransactionReceipt` | Proxies to devnet RPC |
| `eth_getTransactionCount` | Proxies to devnet RPC |
| `eth_estimateGas` | Proxies to devnet RPC |
| `eth_gasPrice` | Proxies to devnet RPC |
| `eth_call` | Proxies to devnet RPC |
| `eth_blockNumber` | Proxies to devnet RPC |
| `eth_getBlock*` | Proxies to devnet RPC |

All unrecognized methods are proxied directly to the devnet RPC endpoint.

### EIP-6963 support

Modern DApps use EIP-6963 (multi-wallet discovery) rather than reading `window.ethereum` directly. The shim announces itself via the `eip6963:announceProvider` event:

```ts
window.dispatchEvent(new CustomEvent("eip6963:announceProvider", {
  detail: {
    info: {
      uuid: "dapp-inspector-evm",
      name: "DappInspector Test Wallet",
      icon: "data:image/svg+xml,...",
      rdns: "io.dapp-inspector.wallet"
    },
    provider: shimProvider
  }
}))
```

The shim listens for `eip6963:requestProvider` and re-announces on demand.

---

## Required adapter config fields

```ts
type EVMAdapterConfig = AdapterConfig & {
  devnetUrl?: string      // default: "http://localhost:8545" (Anvil default)
  chainId?: number        // default: 31337 (Anvil default)
  autoApprove?: boolean   // default: false
  gasConfig?: {
    gasLimit?: string     // override gas limit for all txs (hex)
    gasPrice?: string     // override gas price (hex)
  }
}
```

---

## Devnet integration: Anvil (Foundry)

The adapter connects to a running Anvil instance via its JSON-RPC endpoint. Anvil must be started separately by the user.

Recommended Anvil startup for testing:
```bash
anvil --block-time 1 --chain-id 31337
```

Or forking mainnet/L2:
```bash
anvil --fork-url https://eth.llamarpc.com --chain-id 1
```

### EVM-specific MCP tools

#### `evm_mint_eth`
Mints ETH to an address using Anvil's `anvil_setBalance` method.

**Input**
```ts
{
  address: string
  amount: string   // in ETH (e.g. "10.5"), converted to wei internally
}
```

**Output**: `{ newBalance: string }` (in wei)

---

#### `evm_mint_erc20`
Mints ERC20 tokens to an address by impersonating the token contract's minter.

**Input**
```ts
{
  tokenAddress: string
  toAddress: string
  amount: string     // in token units with decimals
}
```

---

#### `evm_get_balance`
Gets ETH or ERC20 balance.

**Input**
```ts
{
  address: string
  tokenAddress?: string   // omit for ETH
}
```

**Output**: `{ balance: string, formatted: string }`

---

#### `evm_advance_time`
Advances block timestamp.

**Input**
```ts
{
  seconds: number
}
```

Uses `evm_increaseTime` + `evm_mine`.

---

#### `evm_mine_block`
Forces a new block to be mined.

**Input**
```ts
{
  count?: number   // mine N blocks, default: 1
}
```

---

#### `evm_impersonate_account`
Impersonates any address — useful for testing admin functions, simulating whale behavior, or interacting with contracts without owning the private key.

**Input**
```ts
{
  address: string
}
```

After this call, `wallet_switch_account` to the impersonated address will work. Uses `anvil_impersonateAccount`.

---

#### `evm_stop_impersonating`
Stops impersonating an account.

**Input**
```ts
{
  address: string
}
```

---

#### `evm_call`
Makes a read-only `eth_call`.

**Input**
```ts
{
  to: string
  data: string       // ABI-encoded calldata (hex)
  from?: string
}
```

**Output**: `{ result: string }` (hex)

---

#### `evm_get_transaction`
Gets a transaction receipt.

**Input**
```ts
{
  txHash: string
}
```

**Output**
```ts
{
  status: "pending" | "success" | "reverted"
  blockNumber: number
  gasUsed: string
  logs: Array<{ address: string, topics: string[], data: string }>
  revertReason?: string   // decoded if possible
}
```

---

#### `evm_snapshot` / `evm_revert`
Takes an Anvil state snapshot and reverts to it. Useful for resetting state between test scenarios without restarting the devnet.

`evm_snapshot` → **Output**: `{ snapshotId: string }`

`evm_revert` → **Input**: `{ snapshotId: string }`

---

#### `evm_reset`
Resets Anvil to its initial state (or re-forks from the fork URL if applicable).

---

## Chain ID and network handling

The adapter reads the actual chain ID from Anvil on startup. The shim reports this chain ID to the DApp. If the DApp calls `wallet_switchEthereumChain` with a different chain ID, the adapter:

1. Checks if it can switch (only possible if Anvil supports it, or if another devnet URL is configured for that chain)
2. Updates the shim's chain ID and fires the `chainChanged` event
3. Returns an error if the switch is not possible

---

## Signing

EIP-712 (`eth_signTypedData_v4`) and `personal_sign` signatures are computed using `viem`'s signing utilities with the test account's private key. Signatures are valid and will pass `ecrecover`-based verification on-chain.

---

## Account management

Same as the base adapter spec. Accounts are referenced by address or `label`. On initialization:

1. All configured accounts are set as known accounts in the shim
2. The first account is set as active (`eth_accounts` returns it first)
3. ETH balances are verified and logged (warning if zero)
