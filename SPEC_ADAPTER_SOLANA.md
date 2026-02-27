# Solana Adapter Spec

This document covers the Solana adapter. Read `SPEC_ADAPTERS.md` first for the base interface.

---

## Wallet shim: `window.solana`

The shim implements the wallet-adapter standard interface used by virtually all Solana DApps. It also supports the newer Wallet Standard (`@wallet-standard/core`) for DApps using `@solana/wallet-adapter-react`.

### Interface surface (legacy standard)

```ts
interface SolanaProvider {
  isPhantom: boolean       // true — most DApps check this
  publicKey: PublicKey | null
  isConnected: boolean

  connect(options?: { onlyIfTrusted?: boolean }): Promise<{ publicKey: PublicKey }>
  disconnect(): Promise<void>

  signTransaction<T extends Transaction | VersionedTransaction>(tx: T): Promise<T>
  signAllTransactions<T extends Transaction | VersionedTransaction>(txs: T[]): Promise<T[]>
  signAndSendTransaction<T extends Transaction | VersionedTransaction>(
    tx: T,
    options?: SendOptions
  ): Promise<{ signature: string }>
  signMessage(message: Uint8Array): Promise<{ signature: Uint8Array }>

  on(event: "connect" | "disconnect" | "accountChanged", handler: Function): void
  off(event: "connect" | "disconnect" | "accountChanged", handler: Function): void
}
```

### Wallet Standard support

The shim registers itself with the Wallet Standard's `registerWallet` API so DApps using `@solana/wallet-adapter-react` with `autoConnect` can discover it:

```ts
import { registerWallet } from "@wallet-standard/wallet"
registerWallet(shimWallet)
```

The shim wallet object implements `StandardConnect`, `StandardDisconnect`, `StandardEvents`, and `SolanaSignTransaction` features.

### Transaction flow

Solana has two transaction formats: legacy `Transaction` and `VersionedTransaction`. The shim handles both.

```
DApp calls provider.signAndSendTransaction(tx)
    │
    ▼
Shim serializes transaction to base64
Shim calls bridge: { method: "submitTransaction", params: { tx: base64, encoding: "base64" } }
    │
    ▼
Adapter deserializes and inspects the transaction
  if autoApprove:
    → signs with test account keypair
    → submits to devnet via connection.sendRawTransaction()
    → returns { signature }
  else:
    → stores in pendingTransaction (with human-readable decoded instructions)
    → Promise resolves when wallet_approve_transaction is called
```

### Signing without sending

`signTransaction` and `signAllTransactions` sign the transaction(s) with the test account keypair and return them without submitting. The DApp is then responsible for submitting.

---

## Required adapter config fields

```ts
type SolanaAdapterConfig = AdapterConfig & {
  devnetUrl?: string    // default: "http://localhost:8899" (solana-test-validator)
  wsUrl?: string        // default: "ws://localhost:8900"
  commitment?: "processed" | "confirmed" | "finalized"  // default: "confirmed"
  autoApprove?: boolean   // default: false
}
```

Account format for Solana (uses base58 keypair or byte array):
```json
{
  "address": "4Qkev8aNZcqFNSRkR9HdkLVANOXPcjKDGq2LBMNYZ6U",
  "privateKey": "base58EncodedPrivateKeyHere",
  "label": "trader"
}
```

The adapter accepts both base58-encoded private keys and base64-encoded 64-byte keypairs.

---

## Devnet integration: solana-test-validator

The adapter connects to a running `solana-test-validator` instance. Start it with:

```bash
solana-test-validator
```

Or clone an account from mainnet:
```bash
solana-test-validator --clone <PROGRAM_ID> --url mainnet-beta
```

Connection is via `@solana/web3.js` `Connection`.

### Solana-specific MCP tools

#### `solana_airdrop`
Airdrops SOL to an address using the devnet faucet.

**Input**
```ts
{
  address: string
  amount: number   // in SOL (e.g. 10)
}
```

**Output**: `{ signature: string, newBalance: number }` (balance in SOL)

---

#### `solana_get_balance`
Gets SOL or SPL token balance.

**Input**
```ts
{
  address: string
  mintAddress?: string   // omit for SOL
}
```

**Output**: `{ balance: number, formatted: string }`

---

#### `solana_mint_spl_tokens`
Mints SPL tokens to an associated token account, creating the ATA if needed.

**Input**
```ts
{
  mintAddress: string
  toAddress: string
  amount: number      // in token units (respects mint decimals)
  mintAuthority?: string  // label or address — must be a configured account
}
```

---

#### `solana_create_mint`
Creates a new SPL token mint on the devnet.

**Input**
```ts
{
  decimals?: number     // default: 9
  mintAuthority?: string
  freezeAuthority?: string
  label?: string        // store reference for later use
}
```

**Output**: `{ mintAddress: string }`

---

#### `solana_get_transaction`
Gets a confirmed transaction.

**Input**
```ts
{
  signature: string
}
```

**Output**
```ts
{
  status: "confirmed" | "finalized" | "failed" | "pending"
  slot: number
  fee: number         // in lamports
  instructions: Array<{ programId: string, data: string, accounts: string[] }>
  logs: string[]
  error?: string
}
```

---

#### `solana_get_account_info`
Gets raw account data for any address.

**Input**
```ts
{
  address: string
  encoding?: "base58" | "base64" | "jsonParsed"   // default: "jsonParsed"
}
```

---

#### `solana_advance_clock`
Advances the validator clock (only works on solana-test-validator with `--bpf-program` or when using `warp_slot`).

**Input**
```ts
{
  slots?: number
  unixTimestamp?: number   // set absolute timestamp
}
```

Note: Solana's test-validator clock advancement is more limited than EVM/StarkNet. The adapter uses `--warp-slot` via the validator's admin RPC if available, otherwise returns a `NOT_SUPPORTED` error with a suggestion to restart the validator with a different slot.

---

#### `solana_get_program_accounts`
Gets all accounts owned by a program (useful for asserting protocol state).

**Input**
```ts
{
  programId: string
  filters?: Array<{
    memcmp?: { offset: number, bytes: string }
    dataSize?: number
  }>
}
```

---

## Notes on Solana-specific complexity

**Transaction blockhashes**: Solana transactions include a recent blockhash that expires after ~2 minutes. The shim automatically replaces the blockhash with the latest one from the devnet before signing, so stale transactions from slow test flows don't fail.

**Versioned transactions and lookup tables**: `VersionedTransaction` with address lookup tables (ALTs) is supported. The adapter fetches ALT data from the devnet before signing if needed.

**Simulation before submission**: When `autoApprove` is true, the adapter simulates the transaction first via `simulateTransaction` and surfaces any simulation errors before submitting. This catches program errors without wasting the RPC call.
