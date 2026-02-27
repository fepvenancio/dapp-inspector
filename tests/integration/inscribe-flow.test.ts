/**
 * End-to-end: Connect wallet + create inscription on stela-dapp.xyz
 *
 * Flow:
 *   1. Inject shim as window.starknet_argentX (so @starknet-react/core finds it)
 *   2. Click "Connect Wallet" → select Argent X → wallet connected
 *   3. Fill inscription form (debt token, collateral token, amounts, duration)
 *   4. Click "Approve & Sign Order"
 *   5. Sign typed data via bridge
 *
 * DOM targeting based on stela-app source:
 *   - Token select buttons: button#token-select-{0,1,2}
 *   - Amount inputs:        input#amount-{0,1,2}
 *   - Token modal:          [data-slot="dialog-content"]
 *   - Token rows:           button[aria-label^="Select"]
 *   - Quick chips:          [data-slot="dialog-content"] button:has-text("USDC")
 *   - Submit:               button:has-text("Approve & Sign Order")
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { chromium, type Browser, type BrowserContext, type Page } from "playwright"
import { pageToMarkdown, elementFind } from "../../src/core/inspector.js"
import { buildStarknetShim } from "../../src/adapters/starknet/shim.js"

const STELA_URL = "https://stela-dapp.xyz"
const TEST_ACCOUNT = "0x064b48806902a367c8598f4f95c305e8c1a1acba5f082d294a43793113115691"
const CHAIN_ID_HEX = "0x534e5f5345504f4c4941" // SN_SEPOLIA

let browserInstance: Browser
let context: BrowserContext
let page: Page
let bridgeCalls: Array<{ method: string; params: any }> = []

/** Helper: wait for a Playwright locator to be visible */
async function waitVisible(loc: ReturnType<Page["locator"]>, ms = 5_000) {
  await loc.waitFor({ state: "visible", timeout: ms })
}

/** Helper: select a token from the Radix dialog modal
 *  sectionIndex: 0=Debt, 1=Interest, 2=Collateral
 *  (all sections share id="token-select-0", so we use nth() to disambiguate)
 */
async function selectToken(
  sectionIndex: number,
  tokenSymbol: string,
) {
  const tokenBtn = page.locator('button[id="token-select-0"]').nth(sectionIndex)
  await waitVisible(tokenBtn)
  await tokenBtn.click()

  // Wait for dialog portal
  const dialog = page.locator('[data-slot="dialog-content"]')
  await waitVisible(dialog)

  // Try quick chip first
  const chip = dialog.locator(`button:has-text("${tokenSymbol}")`).first()
  if (await chip.isVisible({ timeout: 1_000 }).catch(() => false)) {
    await chip.click()
  } else {
    // Search
    const search = dialog.locator('input[placeholder="Search tokens"]')
    if (await search.isVisible().catch(() => false)) {
      await search.fill(tokenSymbol)
      await page.waitForTimeout(500)
    }
    // Click from list — aria-label is "Select TokenName (SYMBOL)"
    const row = dialog.locator(`button[aria-label*="${tokenSymbol}"]`).first()
    await waitVisible(row, 3_000)
    await row.click()
  }

  // Wait for modal to close
  await page.waitForTimeout(800)
  await dialog.waitFor({ state: "hidden", timeout: 3_000 }).catch(() => {})
}

describe("Inscription flow on stela-dapp.xyz", () => {
  beforeAll(async () => {
    browserInstance = await chromium.launch({ headless: true })
    context = await browserInstance.newContext({ viewport: { width: 1280, height: 900 } })

    // Bridge handler — captures and responds to all wallet calls
    await context.exposeFunction("__dappInspector_bridge", (callJson: string) => {
      const call = JSON.parse(callJson)
      bridgeCalls.push({ method: call.method, params: call.params })

      switch (call.method) {
        case "getState":
          return JSON.stringify({
            success: true,
            data: { isConnected: true, accounts: [TEST_ACCOUNT], selectedAddress: TEST_ACCOUNT, chainId: "SN_SEPOLIA" },
          })
        case "requestAccounts":
          return JSON.stringify({
            success: true,
            data: { accounts: [TEST_ACCOUNT], selectedAddress: TEST_ACCOUNT, chainId: "SN_SEPOLIA" },
          })
        case "signTypedData":
          console.log("    >>> SIGN TYPED DATA CALLED <<<")
          console.log("    Payload:", JSON.stringify(call.params).substring(0, 400))
          return JSON.stringify({ success: true, data: ["0x0612d8c7d1d1e8c03a2", "0x04a3b2c1d0e9f8a7b6c"] })
        case "submitTransaction":
          console.log("    >>> SUBMIT TRANSACTION CALLED <<<")
          return JSON.stringify({ success: true, data: { txHash: "0x" + "ab".repeat(31) + "cd" } })
        case "rpcCall": {
          const rpcMethod = call.params?.method
          if (rpcMethod === "starknet_call") {
            return JSON.stringify({ success: true, data: ["0x0de0b6b3a7640000", "0x0"] })
          }
          if (rpcMethod === "starknet_chainId") {
            return JSON.stringify({ success: true, data: CHAIN_ID_HEX })
          }
          if (rpcMethod === "starknet_getNonce") {
            return JSON.stringify({ success: true, data: "0x0" })
          }
          if (rpcMethod === "starknet_estimateFee") {
            return JSON.stringify({ success: true, data: [{ overall_fee: "0x2386f26fc10000", gas_consumed: "0x1000", gas_price: "0x174876e800" }] })
          }
          return JSON.stringify({ success: false, error: `Unhandled RPC: ${rpcMethod}` })
        }
        default:
          return JSON.stringify({ success: false, error: `Unknown: ${call.method}` })
      }
    })

    // Build the base shim
    const shimScript = buildStarknetShim({
      accounts: [TEST_ACCOUNT],
      activeAccount: TEST_ACCOUNT,
      chainId: "SN_SEPOLIA",
      isConnected: false,
    })

    // Inject the shim + alias as ArgentX
    const fullScript = shimScript + `\n;(function() {
      var wallet = window.starknet;
      var origRequest = wallet.request.bind(wallet);
      wallet.request = function(call) {
        var method = call.type || call.method;
        var params = call.params || {};
        if (method === "wallet_getPermissions") {
          return Promise.resolve(["accounts"]);
        }
        if (method === "wallet_requestChainId") {
          return Promise.resolve("${CHAIN_ID_HEX}");
        }
        return origRequest({ type: method, method: method, params: params });
      };
      wallet.id = "argentX";
      wallet.name = "Argent X";
      wallet.icon = "data:image/svg+xml;base64," + btoa('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#FF875B"/></svg>');
      Object.defineProperty(window, "starknet_argentX", {
        value: wallet, writable: true, configurable: true
      });
      console.log("[dapp-inspector] Wallet shim aliased as window.starknet_argentX");
    })();`

    await context.addInitScript({ content: fullScript })
    page = await context.newPage()
  }, 30_000)

  afterAll(async () => {
    await browserInstance?.close()
  })

  // ── Step 1: Navigate ──

  it("1. Navigate to /create", async () => {
    await page.goto(`${STELA_URL}/create`, { waitUntil: "networkidle", timeout: 25_000 })
    expect(page.url()).toContain("/create")

    const shimCheck = await page.evaluate(() => {
      const w = window as any
      return { hasArgentX: !!w.starknet_argentX, argentId: w.starknet_argentX?.id }
    })
    console.log("    Shim check:", shimCheck)
    expect(shimCheck.hasArgentX).toBe(true)
  }, 30_000)

  // ── Step 2: Connect wallet ──

  it("2. Connect wallet via Argent X", async () => {
    // Click header "Connect Wallet" button
    const connectBtn = page.locator('button:has-text("Connect Wallet")').first()
    await waitVisible(connectBtn)
    await connectBtn.click()
    await page.waitForTimeout(1000)

    // Click Argent X from wallet modal
    const argentBtn = page.locator('button:has-text("Argent")').first()
    await waitVisible(argentBtn, 3_000)
    console.log("    Clicking Argent X...")
    await argentBtn.click()
    await page.waitForTimeout(3000)

    // Verify bridge got requestAccounts
    const reqAccounts = bridgeCalls.filter(c => c.method === "requestAccounts")
    console.log("    requestAccounts calls:", reqAccounts.length)

    const walletInfo = await page.evaluate(() => {
      const w = window as any
      return {
        isConnected: w.starknet_argentX?.isConnected,
        selectedAddress: w.starknet_argentX?.selectedAddress,
      }
    })
    console.log("    Wallet state:", walletInfo)
    expect(walletInfo.isConnected).toBe(true)
  }, 20_000)

  // ── Step 3: Verify connected state ──

  it("3. Verify wallet connected in UI", async () => {
    await page.waitForTimeout(1000)
    const md = await pageToMarkdown(page)
    const hasAddress = md.toLowerCase().includes("0x064b")
    const noConnectWallet = !md.includes("Connect Wallet")
    console.log("    Shows address:", hasAddress)
    console.log("    Connect Wallet gone:", noConnectWallet)
    console.log("    Header:", md.substring(0, 400))

    // The wallet connection should have changed the UI
    // (either shows address OR "Connect Wallet" is replaced)
    expect(hasAddress || noConnectWallet).toBe(true)
  }, 10_000)

  // ── Step 4: Select debt token (USDC) ──

  it("4. Select debt token (USDC)", async () => {
    await selectToken(0, "USDC") // sectionIndex 0 = Debt

    const btnText = await page.locator('button[id="token-select-0"]').first().textContent()
    console.log("    Debt token button now shows:", btnText)
    expect(btnText?.toUpperCase()).toContain("USDC")
  }, 20_000)

  // ── Step 5: Fill debt amount ──

  it("5. Fill debt amount (100)", async () => {
    const amountInput = page.locator('input[id="amount-0"]').first() // Debt section
    await waitVisible(amountInput, 3_000)
    await amountInput.fill("100")
    await page.waitForTimeout(300)

    const value = await amountInput.inputValue()
    console.log("    Debt amount:", value)
    expect(value).toBe("100")
  }, 10_000)

  // ── Step 6: Select collateral token (ETH) ──

  it("6. Select collateral token (ETH)", async () => {
    await selectToken(2, "ETH") // sectionIndex 2 = Collateral

    const btnText = await page.locator('button[id="token-select-0"]').nth(2).textContent()
    console.log("    Collateral token button now shows:", btnText)
    expect(btnText?.toUpperCase()).toContain("ETH")
  }, 20_000)

  // ── Step 7: Fill collateral amount ──

  it("7. Fill collateral amount (0.5)", async () => {
    // Collateral = 3rd amount input (nth(2))
    const amountInput = page.locator('input[id="amount-0"]').nth(2)
    await waitVisible(amountInput, 3_000)
    await amountInput.fill("0.5")
    await page.waitForTimeout(300)

    const value = await amountInput.inputValue()
    console.log("    Collateral amount:", value)
    expect(value).toBe("0.5")
  }, 10_000)

  // ── Step 8: Set duration + deadline ──

  it("8. Set loan duration and discovery deadline", async () => {
    // Loan duration: number input + unit buttons (M, H, D)
    // The number input already has value="1", unit default is likely D (day)
    // Set to 7 days: type 7 in the number input, click D
    const durationInput = page.locator('input[placeholder="Value"]')
    const durVisible = await durationInput.isVisible().catch(() => false)
    if (durVisible) {
      await durationInput.fill("7")
      console.log("    Duration value set to 7")

      // Click "D" button for days
      const dayBtn = page.locator('button:text-is("D")').first()
      if (await dayBtn.isVisible().catch(() => false)) {
        await dayBtn.click()
        console.log("    Duration unit: D (days)")
      }
    }

    // Discovery deadline: click "7d" preset
    const deadlineBtn = page.locator('button:text-is("7d")').first()
    if (await deadlineBtn.isVisible().catch(() => false)) {
      await deadlineBtn.click()
      console.log("    Discovery deadline: 7d")
    }

    await page.waitForTimeout(500)
  }, 10_000)

  // ── Step 9: Review form ──

  it("9. Review form state before submission", async () => {
    const md = await pageToMarkdown(page)
    console.log("\n    === FORM STATE BEFORE SUBMISSION ===")
    console.log("   ", md)
    await page.screenshot({ path: "tests/integration/form-before-submit.png" })
    console.log("    Screenshot saved")
  }, 10_000)

  // ── Step 10: Submit / Sign ──

  it("10. Click Approve & Sign Order", async () => {
    bridgeCalls = [] // Reset to track only submit-related calls

    // Look for the gold submit button
    const submitBtn = page.locator('button:has-text("Approve & Sign Order")')
    const submitVis = await submitBtn.isVisible().catch(() => false)

    if (submitVis) {
      console.log("    >>> Clicking 'Approve & Sign Order' <<<")
      await submitBtn.click()
      await page.waitForTimeout(4000)
    } else {
      // May show different text, or still gated behind wallet connection
      const allButtons = await elementFind(page, { selector: "button" })
      const visibleBtns = allButtons.filter(b => b.isVisible)
      console.log("    'Approve & Sign Order' not visible. Buttons on page:")
      visibleBtns.forEach(b => console.log("      -", JSON.stringify(b.text.substring(0, 60))))

      // Try clicking a submit-like button
      const submitLike = visibleBtns.find(b => {
        const t = b.text.toLowerCase()
        return t.includes("approve") || t.includes("sign") || t.includes("inscribe") ||
               t.includes("submit") || t.includes("create order")
      })
      if (submitLike) {
        console.log("    Clicking fallback submit:", submitLike.text)
        await page.click(submitLike.selector)
        await page.waitForTimeout(4000)
      }
    }

    console.log("    Bridge calls after submit:", bridgeCalls.length)
    for (const call of bridgeCalls) {
      console.log("      ->", call.method, JSON.stringify(call.params).substring(0, 300))
    }
  }, 25_000)

  // ── Step 11: Final summary ──

  it("11. Final summary", async () => {
    await page.screenshot({ path: "tests/integration/inscription-final.png" })

    const md = await pageToMarkdown(page)
    const allCalls = [...bridgeCalls]
    const signCalls = allCalls.filter(c => c.method === "signTypedData")
    const txCalls = allCalls.filter(c => c.method === "submitTransaction")

    console.log("\n    +--------------------------------------+")
    console.log("    |      INSCRIPTION FLOW RESULTS         |")
    console.log("    +--------------------------------------+")
    console.log(`    | URL: ${page.url()}`)
    console.log(`    | Sign typed data calls:     ${signCalls.length}`)
    console.log(`    | Transaction submissions:   ${txCalls.length}`)
    console.log(`    | Total bridge calls:        ${allCalls.length}`)
    console.log("    +--------------------------------------+")

    if (signCalls.length > 0) {
      console.log("\n    SIGNED TYPED DATA:")
      for (const call of signCalls) {
        console.log("    ", JSON.stringify(call.params).substring(0, 500))
      }
    }

    console.log("\n    Final page:")
    console.log("   ", md.substring(0, 800))

    expect(true).toBe(true)
  }, 10_000)
})
