# Architecture

## System overview

dapp-inspector is structured as three layers: the MCP interface Claude talks to, the core browser engine, and the chain-specific adapter. Each layer has a clear responsibility and a defined interface to the layers around it.

```
┌─────────────────────────────────────────────────┐
│                  Claude / AI Agent               │
└───────────────────────┬─────────────────────────┘
                        │ MCP protocol (stdio/SSE)
┌───────────────────────▼─────────────────────────┐
│               MCP Server Layer                   │
│  Tool registry, request routing, response format │
└──────┬───────────────────────────────┬───────────┘
       │                               │
┌──────▼──────────────┐   ┌────────────▼──────────┐
│    Core Engine       │   │   Chain Adapter        │
│                      │   │                        │
│  - Playwright mgmt   │   │  - Wallet shim inject  │
│  - DOM → Markdown    │   │  - Devnet client       │
│  - Console capture   │   │  - Account management  │
│  - Network capture   │   │  - Tx control          │
│  - Screenshot        │   │  - Chain-specific tools│
│  - Page navigation   │   │                        │
└──────┬───────────────┘   └────────────┬───────────┘
       │                               │
┌──────▼───────────────────────────────▼───────────┐
│              Browser (Playwright)                 │
│                                                   │
│  ┌─────────────────────────────────────────────┐  │
│  │           DApp Frontend (target)            │  │
│  │                                             │  │
│  │   window.starknet / .ethereum / .solana     │  │
│  │   (injected shim — controlled by adapter)   │  │
│  └─────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────┘
       │
┌──────▼───────────────────────────────────────────┐
│              Local Devnet (optional)              │
│   starknet-devnet / anvil / solana-test-validator │
└───────────────────────────────────────────────────┘
```

---

## Layer responsibilities

### MCP Server Layer
- Exposes all tools to Claude via the MCP protocol
- Owns the tool registry — core tools + adapter-contributed tools are all registered here
- Routes tool calls to the correct handler (core engine or adapter)
- Normalizes all responses to MCP-compatible format
- Manages session lifecycle (one browser session per MCP session)
- Handles config loading and adapter initialization at startup

### Core Engine
- Manages the Playwright browser instance (launch, close, page management)
- Owns all chain-agnostic inspection capabilities
- Provides the DOM-to-Markdown pipeline
- Captures and buffers console logs and network events continuously
- Exposes a stable internal API that both the MCP layer and adapters can call
- Does not know about chains, wallets, or devnets

### Chain Adapter
- Implements the adapter interface (see SPEC_ADAPTERS.md)
- Injects the appropriate wallet shim into every new page via Playwright's `addInitScript`
- Controls wallet behavior through a shared in-memory state object that the shim reads
- Provides a devnet client for node management and chain state manipulation
- Registers chain-specific MCP tools into the tool registry at startup
- Manages test accounts (addresses, private keys, balances)

### Browser / DApp
- Standard Chromium instance launched by Playwright
- The target DApp frontend runs here (localhost or remote)
- The wallet shim replaces the real wallet extension — from the DApp's perspective it looks identical
- No real extensions are loaded — no ArgentX, no MetaMask, no Phantom

---

## Data flow: a tool call end to end

**Example: `wallet_approve_transaction` called by Claude**

```
1. Claude calls tool: wallet_approve_transaction({ txHash: "0x..." })

2. MCP Server receives the call, looks up the handler
   → routes to adapter.walletControl.approveTransaction()

3. Adapter updates the in-memory wallet state:
   wallet.pendingApproval = { txHash, status: "approved" }

4. The wallet shim inside the browser (injected JS) polls this state
   via window.__dappInspectorWallet.getPendingState()
   → resolves the pending Promise that the DApp is awaiting

5. DApp continues execution — submits transaction to devnet RPC

6. Adapter's devnet client observes the transaction
   → returns tx receipt to adapter

7. Adapter returns result to MCP layer:
   { success: true, txHash: "0x...", receipt: { ... } }

8. MCP layer formats and returns to Claude
```

---

## Wallet shim injection

The wallet shim is a JavaScript object injected into every page before any page scripts run, using Playwright's `addInitScript`. It completely replaces the real wallet object in `window`.

The shim communicates with the adapter through a bridge: a small Playwright `exposeFunction` that maps to in-memory state in the Node.js process. This avoids the complexity of WebSockets or message passing — it's a direct function call from browser JS into Node.js.

```
Browser JS (shim)                Node.js (adapter)
─────────────────                ─────────────────
window.__dappInspector           
  .getWalletState()    ────────► adapter.walletState getter
  .submitTransaction() ────────► adapter.handleTransaction()
  .requestAccounts()   ────────► adapter.handleAccountRequest()
```

The DApp sees a fully compliant wallet object (`window.starknet`, `window.ethereum`, etc.) and never knows it's talking to a shim.

---

## Adapter plugin system

Adapters are loaded at startup based on the `chain` field in `dapp-inspector.config.json`. The loader:

1. Resolves the adapter module from `src/adapters/{chain}/index.ts`
2. Instantiates it with the user's config (accounts, devnet URL, etc.)
3. Calls `adapter.initialize(browserContext)` — this is where the shim is injected
4. Calls `adapter.registerTools(toolRegistry)` — chain-specific tools are added
5. Stores the adapter instance for the lifetime of the session

Custom/community adapters can be loaded from an npm package or local path via the `adapterPath` config field.

---

## Session model

One dapp-inspector process = one browser session = one chain adapter instance.

Multiple Claude Code sessions can each run their own dapp-inspector process independently. There is no shared state between sessions. This is intentional — it keeps the architecture simple and avoids concurrency issues during parallel test runs.

---

## Tech stack

| Component | Technology | Rationale |
|---|---|---|
| MCP server | TypeScript, `@modelcontextprotocol/sdk` | Official SDK, broadest compatibility |
| Browser automation | Playwright | Best-in-class, supports script injection |
| Wallet shim | Vanilla JS (bundled) | No framework dependencies in browser context |
| Config | JSON + Zod validation | Simple, type-safe |
| Devnet clients | Chain-specific SDKs | starknet.js, viem, @solana/web3.js |
| Build | tsup | Fast, simple bundler for CLI tools |
