# Roadmap

## Guiding principle

Build the core first, make it excellent, then add chains. A mediocre multi-chain tool is less valuable than a rock-solid single-chain one. The adapter system means chain support is additive — it doesn't affect core quality.

---

## Milestone 1 — Core + StarkNet (target: first working version)

**Goal**: Claude can fully drive a StarkNet DApp on localhost, control the wallet, and inspect everything.

### 1.1 Browser + inspection core
- Playwright setup and browser lifecycle management
- `page_navigate`, `page_to_markdown`, `page_get_summary`
- `element_click`, `element_type`, `element_select`, `keyboard_press`
- `page_wait_for` with all wait types
- Console log capture + `console_get_logs`
- Network request capture + `network_get_requests`, `network_get_rpc_calls`
- `page_evaluate` for arbitrary JS execution
- `browser_screenshot`

### 1.2 MCP server scaffolding
- `@modelcontextprotocol/sdk` integration
- Tool registry with registration + dispatch
- Session lifecycle management
- Config loading + Zod validation
- Error response formatting

### 1.3 Adapter plugin system
- `DappInspectorAdapter` interface
- Adapter loader (built-in + custom via path)
- `BrowserContext` handoff to adapter
- `addInitScript` injection flow
- `exposeFunction` bridge setup

### 1.4 StarkNet adapter
- `window.starknet` shim (full `StarknetWindowObject`)
- EIP-6963-style announcement (StarkNet equivalent)
- Connection flow + account management
- Transaction approval/rejection state machine
- `autoApprove` mode
- All required base tools (`wallet_connect`, `wallet_approve_transaction`, etc.)
- `starknet-devnet` client (mint, balance, advance_time, mine_block, call, get_transaction)
- Account label resolution

### 1.5 CLI + developer experience
- `dapp-inspector` CLI binary
- `dapp-inspector init --chain starknet` config scaffolding
- Readable startup output (what's connected, what accounts are loaded, etc.)
- Clear error messages when devnet is unreachable or accounts aren't deployed

**Exit criteria for M1**: A developer on a StarkNet project can install dapp-inspector, point it at their local frontend + devnet, add it to Claude Code, and have Claude test a full user flow including wallet approval without any manual browser interaction.

---

## Milestone 2 — EVM adapter

**Goal**: Same quality as StarkNet adapter, for any EVM chain.

- `window.ethereum` shim (EIP-1193 + EIP-6963)
- Anvil client (mint ETH, mint ERC20, advance time, snapshot/revert, impersonate)
- All EVM-specific tools from SPEC_ADAPTER_EVM.md
- `dapp-inspector init --chain evm` config scaffolding
- Tested against at least two DApp frameworks (wagmi, ethers.js directly)

---

## Milestone 3 — Solana adapter

**Goal**: Solana support with SPL token tooling.

- `window.solana` shim + Wallet Standard registration
- `solana-test-validator` client (airdrop, SPL mint, get_transaction, get_program_accounts)
- Blockhash auto-refresh in shim
- `simulateTransaction` before submit in autoApprove mode
- `dapp-inspector init --chain solana` config scaffolding

---

## Milestone 4 — Quality + DX improvements

Things that make the tool genuinely pleasant to use rather than just functional.

- **Video recording**: `recordVideo: true` in config produces a `.webm` of the test session
- **Scenario files**: YAML/JSON test scenario format that Claude can generate and replay
- **`page_get_summary` v2**: smarter summarization, strips boilerplate, highlights anomalies
- **Network diff**: compare network calls between two page states (useful for catching regressions)
- **Console error grouping**: deduplicate repeated errors, group by source file
- **`dapp-inspector replay`**: replay a recorded scenario non-interactively for CI use
- **Devnet health check**: startup warning if devnet is unreachable or on wrong chain ID
- **Hot reload**: re-inject shim after page navigation without losing state

---

## Milestone 5 — CI integration

Make dapp-inspector usable in automated pipelines (GitHub Actions, etc.) without Claude.

- Headless mode by default in CI environments
- JUnit/TAP output format for test results
- `dapp-inspector run <scenario.yaml>` command
- GitHub Action example in docs
- Exit codes: 0 = all scenarios passed, 1 = failure, 2 = configuration error

---

## Future / community

These are explicitly deferred until the core is stable and there's ecosystem interest:

- **Additional chains**: Cosmos/CosmWasm, Sui, Aptos, Bitcoin (via Leather/Xverse)
- **Real wallet replay**: record actual wallet interactions from a real session, replay via shim
- **Contract ABI integration**: decode transaction calldata and event logs automatically given an ABI file
- **Visual diff**: screenshot comparison between test runs to catch UI regressions
- **Claude prompt library**: pre-built Claude prompts for common DApp test patterns

---

## Open questions

These need decisions before or during implementation:

1. **Devnet process management**: Should dapp-inspector optionally manage devnet process lifecycle (start/stop/reset), or always require the user to manage it externally? Starting with external management is simpler but adds setup friction.

2. **Multi-tab support**: Some DApp flows open new tabs (OAuth, external links). Should the core engine support multi-tab scenarios in M1 or defer?

3. **Mobile viewports**: Testing responsive DApp layouts is a real need. Add a `viewport` preset system (desktop, tablet, mobile) or leave it as a raw config option?

4. **Authentication for staging environments**: Some staging DApps are behind HTTP basic auth or cookie-based auth. How should dapp-inspector handle this?

5. **Proxy support**: Some developers route traffic through a local proxy (mitmproxy, Charles). Should dapp-inspector support configuring a proxy for the browser session?
