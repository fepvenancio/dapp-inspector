# Contributing

## Who this guide is for

- Team members building dapp-inspector for the first time
- Community contributors adding new chain adapters
- Anyone fixing bugs or improving the core

---

## Getting started

```bash
git clone https://github.com/your-org/dapp-inspector
cd dapp-inspector
npm install
npm run build
npm run dev   # watch mode
```

### Prerequisites
- Node.js 20+
- A chain-specific devnet running locally (see adapter specs for setup commands)

---

## Project structure

```
dapp-inspector/
├── src/
│   ├── mcp/
│   │   ├── server.ts          # MCP server setup, session lifecycle
│   │   └── registry.ts        # Tool registry — registers + dispatches tool calls
│   │
│   ├── core/
│   │   ├── browser.ts         # Playwright browser + context management
│   │   ├── inspector.ts       # DOM-to-Markdown, element tools
│   │   ├── console.ts         # Console capture + buffering
│   │   ├── network.ts         # Network capture + filtering
│   │   └── tools.ts           # Core tool definitions (registered into registry)
│   │
│   ├── adapters/
│   │   ├── interface.ts       # DappInspectorAdapter interface + types
│   │   ├── loader.ts          # Adapter resolution + instantiation
│   │   │
│   │   ├── starknet/
│   │   │   ├── index.ts       # StarkNetAdapter class
│   │   │   ├── shim.ts        # window.starknet shim source (bundled at build time)
│   │   │   ├── devnet.ts      # starknet-devnet client
│   │   │   └── tools.ts       # StarkNet-specific tool definitions
│   │   │
│   │   ├── evm/
│   │   │   ├── index.ts
│   │   │   ├── shim.ts
│   │   │   ├── anvil.ts
│   │   │   └── tools.ts
│   │   │
│   │   └── solana/
│   │       ├── index.ts
│   │       ├── shim.ts
│   │       ├── validator.ts
│   │       └── tools.ts
│   │
│   ├── config/
│   │   ├── schema.ts          # Zod schemas for config validation
│   │   └── loader.ts          # Config file loading + merging with CLI flags
│   │
│   └── cli/
│       ├── index.ts           # CLI entrypoint (commander)
│       └── init.ts            # `dapp-inspector init` command
│
├── shims/                     # Wallet shim bundles (built separately, embedded as strings)
│   ├── starknet.bundle.js
│   ├── evm.bundle.js
│   └── solana.bundle.js
│
├── docs/                      # Spec files (this folder)
├── examples/                  # Example configs and scenarios
└── tests/
    ├── core/
    ├── adapters/
    └── integration/
```

---

## Building a new chain adapter

### Step 1: Create the adapter directory

```
src/adapters/mychain/
├── index.ts      # The adapter class
├── shim.ts       # The wallet shim source
├── client.ts     # Devnet/RPC client
└── tools.ts      # Chain-specific tool definitions
```

### Step 2: Implement `DappInspectorAdapter`

```ts
// src/adapters/mychain/index.ts
import { DappInspectorAdapter, AdapterConfig, WalletState, ToolRegistry } from "../interface"
import { BrowserContext } from "playwright"
import { buildShim } from "./shim"
import { MychainClient } from "./client"
import { registerMychainTools } from "./tools"

export class MychainAdapter implements DappInspectorAdapter {
  readonly name = "mychain"
  readonly version = "1.0.0"
  readonly walletWindowKey = "mychain"   // window.mychain

  private walletState: WalletState = {
    isConnected: false,
    accounts: [],
    activeAccount: null,
    chainId: null,
    pendingTransaction: null,
    autoApprove: false
  }

  private client: MychainClient
  private config: MychainAdapterConfig

  async initialize(context: BrowserContext, config: AdapterConfig): Promise<void> {
    this.config = config as MychainAdapterConfig

    // 1. Connect to devnet
    this.client = new MychainClient(this.config.devnetUrl ?? "http://localhost:XXXX")
    await this.client.connect()

    // 2. Load accounts
    this.walletState.accounts = this.config.accounts.map(a => a.address)
    this.walletState.activeAccount = this.walletState.accounts[0] ?? null

    // 3. Expose the bridge
    await context.exposeFunction("__dappInspector_bridge", this.handleBridgeCall.bind(this))

    // 4. Inject the shim (MUST be via addInitScript)
    const shimCode = buildShim(this.walletState)
    await context.addInitScript({ content: shimCode })
  }

  async teardown(): Promise<void> {
    await this.client.disconnect()
  }

  registerTools(registry: ToolRegistry): void {
    registerMychainTools(registry, this)
  }

  getWalletState(): WalletState {
    return { ...this.walletState }
  }

  private async handleBridgeCall(call: { method: string, params?: any }) {
    // Route bridge calls from the shim to the right handler
    switch (call.method) {
      case "getState": return { success: true, data: this.getWalletState() }
      case "submitTransaction": return this.handleTransaction(call.params)
      // ...
    }
  }
}
```

### Step 3: Build the wallet shim

The shim runs in the **browser context**, not Node.js. It must be a self-contained JS bundle with no `import` statements — bundle it with `esbuild` or `rollup` as part of the build step.

```ts
// src/adapters/mychain/shim.ts
// This function returns a string of JS code to inject
export function buildShim(initialState: WalletState): string {
  return `
    (function() {
      const state = ${JSON.stringify(initialState)};
      
      async function bridge(method, params) {
        return await window.__dappInspector_bridge({ method, params });
      }
      
      window.mychain = {
        // ... implement wallet interface here
        connect: async () => {
          const result = await bridge("requestAccounts");
          return result.data;
        },
        // ...
      };
    })();
  `;
}
```

### Step 4: Register your adapter

In `src/adapters/loader.ts`, add your chain to the built-in adapter map:

```ts
const BUILT_IN_ADAPTERS: Record<string, () => Promise<DappInspectorAdapter>> = {
  starknet: () => import("./starknet").then(m => new m.StarkNetAdapter()),
  evm:      () => import("./evm").then(m => new m.EVMAdapter()),
  solana:   () => import("./solana").then(m => new m.SolanaAdapter()),
  mychain:  () => import("./mychain").then(m => new m.MychainAdapter()),  // ← add here
}
```

### Step 5: Add to config schema

In `src/config/schema.ts`, add your config schema:

```ts
const MychainAdapterConfigSchema = BaseAdapterConfigSchema.extend({
  devnetUrl: z.string().url().default("http://localhost:XXXX"),
  // ... your chain-specific fields
})
```

### Step 6: Write a spec doc

Add a `docs/SPEC_ADAPTER_MYCHAIN.md` following the same structure as the existing adapter specs. Document:
- Wallet interface surface (what the shim implements)
- Config fields
- Devnet setup instructions
- All chain-specific tools with input/output schemas
- Any gotchas or chain-specific behavior

### Step 7: Tests

Add tests in `tests/adapters/mychain/`:
- Unit tests for the devnet client
- Unit tests for the shim communication
- Integration test that spins up a devnet and runs a full connect → transact → assert flow

---

## Pull request checklist

Before opening a PR:

- [ ] Adapter implements `DappInspectorAdapter` fully
- [ ] Shim passes basic connection + transaction flow test
- [ ] All tool input/output schemas have correct TypeScript types
- [ ] Errors return structured `ToolError` format (not thrown exceptions)
- [ ] `SPEC_ADAPTER_*.md` doc is complete
- [ ] Config schema is validated with Zod and has good error messages
- [ ] `dapp-inspector init --chain mychain` generates a working example config
- [ ] At least one integration test passes against the real devnet

---

## Code style

- TypeScript strict mode — no `any` except where absolutely necessary at the shim boundary
- Named exports over default exports (except for adapter classes)
- All async functions must handle errors explicitly — no unhandled promise rejections
- Tool handlers: always return `ToolError` on failure, never throw to the MCP layer
- Shim code: write for readability, it will be embedded as a string but it's important to be able to read and debug it

---

## Getting help

If you're building an adapter and get stuck on the shim injection or bridge communication, look at the StarkNet adapter as the reference implementation — it was built first and is the most thoroughly documented.
