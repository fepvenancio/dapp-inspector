import { chromium, type Browser, type BrowserContext, type Page } from "playwright"
import { ConsoleCapture } from "./console.js"
import { NetworkCapture } from "./network.js"

export type BrowserLaunchOptions = {
  headless?: boolean
  viewport?: { width: number; height: number }
  recordVideo?: boolean
}

export class BrowserManager {
  private config: BrowserLaunchOptions
  private browser: Browser | null = null
  private context: BrowserContext | null = null
  private page: Page | null = null
  private consoleCapture: ConsoleCapture | null = null
  private networkCapture: NetworkCapture | null = null

  constructor(config: BrowserLaunchOptions = {}) {
    this.config = config
  }

  async launch(overrides: BrowserLaunchOptions = {}): Promise<BrowserContext> {
    if (this.browser) {
      await this.close()
    }

    const options = { ...this.config, ...overrides }
    const headless = options.headless ?? false
    const viewport = options.viewport ?? { width: 1280, height: 800 }

    this.browser = await chromium.launch({ headless })

    const contextOptions: Record<string, unknown> = {
      viewport,
    }

    if (options.recordVideo) {
      contextOptions.recordVideo = {
        dir: "./recordings",
        size: viewport,
      }
    }

    this.context = await this.browser.newContext(contextOptions)
    this.page = await this.context.newPage()

    this.consoleCapture = new ConsoleCapture(this.page)
    this.networkCapture = new NetworkCapture(this.page)

    return this.context
  }

  async close(): Promise<void> {
    if (this.consoleCapture) {
      this.consoleCapture.detach()
      this.consoleCapture = null
    }
    if (this.networkCapture) {
      this.networkCapture.detach()
      this.networkCapture = null
    }
    if (this.context) {
      await this.context.close()
      this.context = null
    }
    if (this.browser) {
      await this.browser.close()
      this.browser = null
    }
    this.page = null
  }

  getPage(): Page {
    if (!this.page) {
      throw new Error("Browser not launched. Call launch() first.")
    }
    return this.page
  }

  getContext(): BrowserContext {
    if (!this.context) {
      throw new Error("Browser not launched. Call launch() first.")
    }
    return this.context
  }

  getConsoleCapture(): ConsoleCapture {
    if (!this.consoleCapture) {
      throw new Error("Browser not launched. Call launch() first.")
    }
    return this.consoleCapture
  }

  getNetworkCapture(): NetworkCapture {
    if (!this.networkCapture) {
      throw new Error("Browser not launched. Call launch() first.")
    }
    return this.networkCapture
  }

  isLaunched(): boolean {
    return this.browser !== null
  }
}
