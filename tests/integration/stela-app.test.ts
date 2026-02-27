/**
 * Integration test: dapp-inspector vs stela-app (live site)
 *
 * Tests the core engine (browser, inspector, console, network capture)
 * and StarkNet wallet shim injection against the real stela-dapp.xyz.
 *
 * Run:
 *   npx vitest run tests/integration/stela-app.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { BrowserManager } from "../../src/core/browser.js"
import { pageToMarkdown, elementGet, elementFind } from "../../src/core/inspector.js"
import { buildStarknetShim } from "../../src/adapters/starknet/shim.js"

const STELA_URL = "https://stela-dapp.xyz"

// Test account (doesn't need to be real — the shim controls everything)
const TEST_ACCOUNT = "0x064b48806902a367c8598f4f95c305e8c1a1acba5f082d294a43793113115691"

describe("dapp-inspector integration: stela-app", () => {
  let browser: BrowserManager

  beforeAll(async () => {
    browser = new BrowserManager({ headless: true, viewport: { width: 1280, height: 800 } })
    const context = await browser.launch({ headless: true })

    // Set up the bridge function that the shim calls
    let walletState = {
      isConnected: false,
      selectedAddress: undefined as string | undefined,
      accounts: [TEST_ACCOUNT],
      chainId: "SN_SEPOLIA",
    }

    await context.exposeFunction("__dappInspector_bridge", (callJson: string) => {
      const call = JSON.parse(callJson)
      switch (call.method) {
        case "getState":
          return JSON.stringify({
            success: true,
            data: walletState,
          })
        case "requestAccounts":
          walletState.isConnected = true
          walletState.selectedAddress = TEST_ACCOUNT
          return JSON.stringify({
            success: true,
            data: {
              accounts: walletState.accounts,
              selectedAddress: TEST_ACCOUNT,
              chainId: walletState.chainId,
            },
          })
        case "rpcCall":
          // For RPC calls, return a structured error (no real devnet)
          return JSON.stringify({
            success: false,
            error: "No devnet connected (integration test mode)",
          })
        default:
          return JSON.stringify({
            success: false,
            error: `Unhandled bridge method: ${call.method}`,
          })
      }
    })

    // Inject the StarkNet wallet shim
    const shimScript = buildStarknetShim({
      accounts: [TEST_ACCOUNT],
      activeAccount: TEST_ACCOUNT,
      chainId: "SN_SEPOLIA",
      isConnected: false,
    })
    await context.addInitScript({ content: shimScript })
  }, 30_000)

  afterAll(async () => {
    if (browser) {
      await browser.close()
    }
  })

  // ── Core: Navigation ──

  it("should navigate to stela-app homepage", async () => {
    const page = browser.getPage()
    const response = await page.goto(STELA_URL, { waitUntil: "networkidle", timeout: 20_000 })
    expect(response?.status()).toBe(200)
    expect(page.url()).toContain("stela-dapp.xyz")
    const title = await page.title()
    expect(title).toBeTruthy()
    console.log("  Page title:", title)
  }, 25_000)

  // ── Core: DOM-to-Markdown ──

  it("should convert homepage to Markdown", async () => {
    const page = browser.getPage()
    const md = await pageToMarkdown(page)
    expect(md).toBeTruthy()
    expect(md.length).toBeGreaterThan(50)

    // The homepage should contain "Stela" or "Inscribe" branding
    const mdLower = md.toLowerCase()
    const hasBranding = mdLower.includes("stela") || mdLower.includes("inscri") || mdLower.includes("lending") || mdLower.includes("legacy")
    expect(hasBranding).toBe(true)
    console.log("  Markdown length:", md.length, "chars")
    console.log("  First 500 chars:\n", md.substring(0, 500))
  }, 15_000)

  it("should convert page to Markdown with selector scope", async () => {
    const page = browser.getPage()
    // Scope to just the main content area
    const md = await pageToMarkdown(page, { selector: "main" })
    expect(md).toBeTruthy()
    console.log("  <main> markdown length:", md.length, "chars")
  }, 10_000)

  // ── Core: Element inspection ──

  it("should find buttons on the page", async () => {
    const page = browser.getPage()
    const buttons = await elementFind(page, { selector: "button" })
    expect(buttons.length).toBeGreaterThan(0)
    console.log("  Found", buttons.length, "buttons:")
    for (const btn of buttons.slice(0, 5)) {
      console.log("    -", btn.text.substring(0, 60) || "(no text)", btn.isVisible ? "" : "(hidden)")
    }
  }, 10_000)

  it("should find links on the page", async () => {
    const page = browser.getPage()
    const links = await elementFind(page, { selector: "a" })
    expect(links.length).toBeGreaterThan(0)
    console.log("  Found", links.length, "links")
    for (const link of links.slice(0, 5)) {
      console.log("    -", link.text.substring(0, 60), "→", link.attributes.href || "(no href)")
    }
  }, 10_000)

  it("should get element details", async () => {
    const page = browser.getPage()
    // Try to get info about the first heading
    const headings = await elementFind(page, { selector: "h1, h2, h3" })
    expect(headings.length).toBeGreaterThan(0)

    const firstVisible = headings.find(h => h.isVisible)
    if (firstVisible) {
      const info = await elementGet(page, firstVisible.selector)
      expect(info.tagName).toMatch(/^h[1-6]$/)
      expect(info.text).toBeTruthy()
      expect(info.isVisible).toBe(true)
      console.log("  First heading:", info.tagName, "→", JSON.stringify(info.text.substring(0, 80)))
    }
  }, 10_000)

  // ── Core: Console capture ──

  it("should capture console logs", async () => {
    const consoleCapture = browser.getConsoleCapture()
    const logs = consoleCapture.getLogs()
    console.log("  Captured", logs.length, "console messages")

    const errors = logs.filter(l => l.type === "error")
    const warnings = logs.filter(l => l.type === "warning")
    console.log("  Errors:", errors.length, "| Warnings:", warnings.length)

    // Log the first few errors if any
    for (const err of errors.slice(0, 3)) {
      console.log("    ERROR:", err.message.substring(0, 120))
    }

    // Check that the shim injection log is present
    const shimLog = logs.find(l => l.message.includes("dapp-inspector"))
    expect(shimLog).toBeTruthy()
    console.log("  Shim injection log found:", shimLog?.message)
  }, 10_000)

  // ── Core: Network capture ──

  it("should capture network requests", async () => {
    const networkCapture = browser.getNetworkCapture()
    const requests = networkCapture.getRequests()
    expect(requests.length).toBeGreaterThan(0)
    console.log("  Captured", requests.length, "network requests")

    // Show fetch/XHR requests (most relevant for DApp debugging)
    const apiRequests = requests.filter(r => r.resourceType === "fetch" || r.resourceType === "xhr")
    console.log("  API (fetch/xhr) requests:", apiRequests.length)
    for (const req of apiRequests.slice(0, 5)) {
      console.log("    -", req.method, req.url.substring(0, 100), "→", req.status)
    }

    // Check for failed requests
    const failed = requests.filter(r => r.failed)
    console.log("  Failed requests:", failed.length)
  }, 10_000)

  it("should detect JSON-RPC calls", async () => {
    const networkCapture = browser.getNetworkCapture()
    const rpcCalls = networkCapture.getRpcCalls()
    console.log("  JSON-RPC calls captured:", rpcCalls.length)
    for (const rpc of rpcCalls.slice(0, 5)) {
      console.log("    -", rpc.rpcMethod, "→", rpc.status)
    }
  }, 10_000)

  // ── Wallet shim: injection verification ──

  it("should have injected window.starknet shim", async () => {
    const page = browser.getPage()
    const shimInfo = await page.evaluate(() => {
      const w = window as any
      return {
        hasStarknet: !!w.starknet,
        shimReady: !!w.__dappInspector_shimReady,
        walletId: w.starknet?.id,
        walletName: w.starknet?.name,
        isConnected: w.starknet?.isConnected,
        chainId: w.starknet?.chainId,
        selectedAddress: w.starknet?.selectedAddress,
        hasEnable: typeof w.starknet?.enable === "function",
        hasRequest: typeof w.starknet?.request === "function",
        hasProvider: !!w.starknet?.provider,
      }
    })

    expect(shimInfo.hasStarknet).toBe(true)
    expect(shimInfo.shimReady).toBe(true)
    expect(shimInfo.walletId).toBe("dapp-inspector")
    expect(shimInfo.walletName).toBe("DappInspector Test Wallet")
    expect(shimInfo.hasEnable).toBe(true)
    expect(shimInfo.hasRequest).toBe(true)
    expect(shimInfo.hasProvider).toBe(true)
    console.log("  Shim verified:", shimInfo)
  }, 10_000)

  it("should be able to call wallet enable() via shim", async () => {
    const page = browser.getPage()
    const result = await page.evaluate(async () => {
      const w = window as any
      try {
        const accounts = await w.starknet.enable()
        return {
          success: true,
          accounts,
          isConnected: w.starknet.isConnected,
          selectedAddress: w.starknet.selectedAddress,
        }
      } catch (err: any) {
        return { success: false, error: err.message }
      }
    })

    expect(result.success).toBe(true)
    expect(result.isConnected).toBe(true)
    expect(result.selectedAddress).toBe(TEST_ACCOUNT)
    expect(result.accounts).toContain(TEST_ACCOUNT)
    console.log("  Wallet connected:", result)
  }, 10_000)

  // ── Navigation: Browse page ──

  it("should navigate to /browse and inspect", async () => {
    const page = browser.getPage()
    await page.goto(`${STELA_URL}/browse`, { waitUntil: "networkidle", timeout: 20_000 })
    expect(page.url()).toContain("/browse")

    const md = await pageToMarkdown(page)
    expect(md).toBeTruthy()
    console.log("  /browse markdown length:", md.length)
    console.log("  First 400 chars:\n", md.substring(0, 400))
  }, 25_000)

  // ── Navigation: Faucet page ──

  it("should navigate to /faucet and find mint buttons", async () => {
    const page = browser.getPage()
    await page.goto(`${STELA_URL}/faucet`, { waitUntil: "networkidle", timeout: 20_000 })
    expect(page.url()).toContain("/faucet")

    const md = await pageToMarkdown(page)
    expect(md).toBeTruthy()

    // Look for token-related content
    const mdLower = md.toLowerCase()
    const hasTokenContent = mdLower.includes("usdc") || mdLower.includes("weth") || mdLower.includes("dai") || mdLower.includes("faucet") || mdLower.includes("mint")
    expect(hasTokenContent).toBe(true)
    console.log("  /faucet markdown length:", md.length)
    console.log("  First 400 chars:\n", md.substring(0, 400))

    // Find mint/faucet buttons
    const buttons = await elementFind(page, { selector: "button" })
    const mintButtons = buttons.filter(b => {
      const txt = b.text.toLowerCase()
      return txt.includes("mint") || txt.includes("faucet") || txt.includes("request")
    })
    console.log("  Mint-related buttons found:", mintButtons.length)
    for (const btn of mintButtons) {
      console.log("    -", btn.text.substring(0, 60))
    }
  }, 25_000)

  // ── Navigation: Create page ──

  it("should navigate to /create and find form elements", async () => {
    const page = browser.getPage()
    await page.goto(`${STELA_URL}/create`, { waitUntil: "networkidle", timeout: 20_000 })
    expect(page.url()).toContain("/create")

    const md = await pageToMarkdown(page)
    expect(md).toBeTruthy()
    console.log("  /create markdown length:", md.length)
    console.log("  First 400 chars:\n", md.substring(0, 400))

    // Find form inputs
    const inputs = await elementFind(page, { selector: "input" })
    console.log("  Form inputs found:", inputs.length)
    for (const input of inputs.slice(0, 5)) {
      console.log("    -", input.tagName, input.attributes.type || "text", input.attributes.placeholder || "(no placeholder)")
    }
  }, 25_000)

  // ── Screenshot ──

  it("should take a screenshot", async () => {
    const page = browser.getPage()
    await page.goto(STELA_URL, { waitUntil: "networkidle", timeout: 20_000 })
    const screenshot = await page.screenshot({ encoding: "base64" })
    expect(screenshot).toBeTruthy()
    expect(screenshot.length).toBeGreaterThan(1000) // Real screenshot should be substantial
    console.log("  Screenshot size:", Math.round(screenshot.length / 1024), "KB (base64)")
  }, 25_000)

  // ── Interaction: Click ──

  it("should click a navigation link", async () => {
    const page = browser.getPage()
    await page.goto(STELA_URL, { waitUntil: "networkidle", timeout: 20_000 })

    // Find a link to browse or explore
    const links = await elementFind(page, { selector: "a" })
    const browseLink = links.find(l => {
      const txt = l.text.toLowerCase()
      const href = (l.attributes.href || "").toLowerCase()
      return (txt.includes("browse") || txt.includes("explore") || href.includes("/browse")) && l.isVisible
    })

    if (browseLink) {
      await page.click(browseLink.selector)
      // Wait for navigation — Next.js uses client-side routing
      await page.waitForTimeout(2000)
      await page.waitForLoadState("networkidle")
      console.log("  Clicked:", browseLink.text.substring(0, 60))
      console.log("  New URL:", page.url())
      // Should have navigated somewhere
      expect(page.url()).toBeTruthy()
    } else {
      console.log("  No browse/explore link found, skipping click test")
    }
  }, 25_000)

  // ── Summary: Full page state ──

  it("should produce a complete page state summary", async () => {
    const page = browser.getPage()
    await page.goto(STELA_URL, { waitUntil: "networkidle", timeout: 20_000 })

    const consoleCapture = browser.getConsoleCapture()
    const networkCapture = browser.getNetworkCapture()

    const summary = {
      url: page.url(),
      title: await page.title(),
      markdownLength: (await pageToMarkdown(page)).length,
      consoleErrors: consoleCapture.getLogs({ types: ["error"] }).length,
      consoleWarnings: consoleCapture.getLogs({ types: ["warning"] }).length,
      totalNetworkRequests: networkCapture.getRequests().length,
      failedRequests: networkCapture.getRequests().filter(r => r.failed).length,
      rpcCalls: networkCapture.getRpcCalls().length,
      walletShimActive: await page.evaluate(() => !!(window as any).__dappInspector_shimReady),
    }

    console.log("\n  === Page State Summary ===")
    console.log("  URL:", summary.url)
    console.log("  Title:", summary.title)
    console.log("  Markdown:", summary.markdownLength, "chars")
    console.log("  Console errors:", summary.consoleErrors)
    console.log("  Console warnings:", summary.consoleWarnings)
    console.log("  Network requests:", summary.totalNetworkRequests)
    console.log("  Failed requests:", summary.failedRequests)
    console.log("  RPC calls:", summary.rpcCalls)
    console.log("  Wallet shim:", summary.walletShimActive ? "active" : "inactive")
    console.log("  ==========================\n")

    expect(summary.walletShimActive).toBe(true)
    expect(summary.totalNetworkRequests).toBeGreaterThan(0)
  }, 25_000)
})
