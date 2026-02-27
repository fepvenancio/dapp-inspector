# dapp-inspector

**An MCP server for AI-assisted DApp frontend testing, inspection, and validation.**

dapp-inspector gives Claude (or any MCP-compatible AI) full control over a browser session with a programmable wallet shim, devnet integration, and rich inspection tools — all without touching a real wallet or real funds.

---

## What it does

- **Converts any DApp frontend to inspectable Markdown** — DOM structure, rendered text, component state
- **Injects a programmable wallet** into the browser — approve or reject transactions, switch accounts, simulate edge cases, all under AI control
- **Captures console logs, network requests, and errors** in real time
- **Integrates with local devnets** — spin up state, mint tokens, fast-forward time, assert on-chain results
- **Works across chains** via a pluggable adapter system — StarkNet, EVM, and Solana supported from day one

---

## Why it exists

Testing DApp frontends is uniquely painful. You need a real browser, a wallet extension, a local node, funded accounts, and enough patience to click through every scenario manually. Existing tools either stop at the browser (Playwright) or at the chain (Hardhat, Foundry, starknet-devnet) — nothing connects them in a way an AI agent can drive end-to-end.

dapp-inspector closes that gap. It's the missing layer between "Claude can see my UI" and "Claude can fully test my DApp."

---

## Who it's for

- DeFi protocol teams who want AI-assisted QA on their frontends
- Developers building on StarkNet, EVM L1/L2s, or Solana
- Teams using Claude Code who want to extend testing to the UI layer
- Anyone who's ever manually clicked through 20 wallet approval flows to test a happy path

---

## How it fits into your workflow

```
Claude Code
    │
    ▼
dapp-inspector MCP server
    │
    ├── Browser (Playwright)
    │       ├── Your DApp frontend (localhost or staging)
    │       └── Injected wallet shim (window.starknet / window.ethereum / window.solana)
    │
    └── Chain Adapter
            ├── Devnet (starknet-devnet / anvil / solana-test-validator)
            └── Test accounts + funded state
```

You describe what you want to test in plain language. Claude drives the browser, controls the wallet, inspects the results, and reports back — errors, state mismatches, UI inconsistencies, failed network calls, all of it.

---

## Quick start (once built)

```bash
npm install -g dapp-inspector

# Add to your Claude Code MCP config
dapp-inspector init --chain starknet
```

```json
{
  "mcpServers": {
    "dapp-inspector": {
      "command": "dapp-inspector",
      "args": ["--config", "./dapp-inspector.config.json"]
    }
  }
}
```

Then in Claude Code:
> "Open http://localhost:3000, connect the wallet, and check if the borrow form correctly validates when the collateral ratio is below the minimum."

---

## Project structure

```
dapp-inspector/
├── src/
│   ├── core/           # Chain-agnostic browser + inspection engine
│   ├── adapters/       # Chain-specific wallet shims + devnet clients
│   │   ├── starknet/
│   │   ├── evm/
│   │   └── solana/
│   ├── mcp/            # MCP server + tool definitions
│   └── config/         # Config loading + validation
├── docs/               # This spec
└── examples/           # Example configs and test scenarios
```

---

## Documentation

- [Architecture](./ARCHITECTURE.md)
- [Core Spec](./SPEC_CORE.md)
- [Adapter Interface](./SPEC_ADAPTERS.md)
- [StarkNet Adapter](./SPEC_ADAPTER_STARKNET.md)
- [EVM Adapter](./SPEC_ADAPTER_EVM.md)
- [Solana Adapter](./SPEC_ADAPTER_SOLANA.md)
- [Roadmap](./ROADMAP.md)
- [Contributing](./CONTRIBUTING.md)

---

## License

MIT
