import type { ToolRegistry, DappInspectorAdapter } from "../adapters/interface.js"
import { toolError } from "../adapters/interface.js"
import type { BrowserManager } from "./browser.js"
import { pageToMarkdown, elementGet, elementFind } from "./inspector.js"

export function registerCoreTools(
  registry: ToolRegistry,
  browserManager: BrowserManager,
  adapter: DappInspectorAdapter
): void {
  // ── Browser lifecycle ──

  registry.register({
    name: "browser_launch",
    description:
      "Launch a new browser instance (or relaunch with different options). Returns confirmation of the browser state.",
    inputSchema: {
      properties: {
        headless: { type: "boolean", description: "Run in headless mode" },
        viewport: {
          type: "object",
          description: "Viewport size",
          properties: {
            width: { type: "number" },
            height: { type: "number" },
          },
        },
        recordVideo: {
          type: "boolean",
          description: "Record a video of the session",
        },
      },
    },
    handler: async (input) => {
      try {
        await browserManager.launch({
          headless: input.headless,
          viewport: input.viewport,
          recordVideo: input.recordVideo,
        })

        // Re-initialize adapter with the new context
        await adapter.initialize(
          browserManager.getContext(),
          {} as any
        )

        return {
          status: "launched",
          headless: input.headless ?? false,
          viewport: input.viewport ?? { width: 1280, height: 800 },
        }
      } catch (err: any) {
        return toolError("BROWSER_LAUNCH_FAILED", err.message)
      }
    },
  })

  registry.register({
    name: "browser_close",
    description: "Close the browser and release all resources.",
    inputSchema: { properties: {} },
    handler: async () => {
      try {
        await browserManager.close()
        return { status: "closed" }
      } catch (err: any) {
        return toolError("BROWSER_CLOSE_FAILED", err.message)
      }
    },
  })

  registry.register({
    name: "browser_screenshot",
    description:
      "Take a screenshot of the current page. Returns a base64-encoded PNG image.",
    inputSchema: {
      properties: {
        selector: {
          type: "string",
          description: "CSS selector to screenshot a specific element",
        },
        fullPage: {
          type: "boolean",
          description: "Capture the full scrollable page",
        },
      },
    },
    handler: async (input) => {
      try {
        const page = browserManager.getPage()
        let buffer: Buffer

        if (input.selector) {
          const element = await page.$(input.selector)
          if (!element) {
            return toolError(
              "ELEMENT_NOT_FOUND",
              `No element matching selector: ${input.selector}`
            )
          }
          buffer = await element.screenshot()
        } else {
          buffer = await page.screenshot({
            fullPage: input.fullPage ?? false,
          })
        }

        const base64 = buffer.toString("base64")
        return {
          image: base64,
          mimeType: "image/png",
          width: (await page.viewportSize())?.width,
          height: (await page.viewportSize())?.height,
        }
      } catch (err: any) {
        return toolError("SCREENSHOT_FAILED", err.message)
      }
    },
  })

  // ── Page navigation ──

  registry.register({
    name: "page_navigate",
    description:
      "Navigate to a URL. Waits for the page to reach the 'load' state.",
    inputSchema: {
      properties: {
        url: { type: "string", description: "The URL to navigate to" },
        waitUntil: {
          type: "string",
          enum: ["load", "domcontentloaded", "networkidle", "commit"],
          description: "Navigation wait condition (default: load)",
        },
      },
      required: ["url"],
    },
    handler: async (input) => {
      try {
        const page = browserManager.getPage()
        const response = await page.goto(input.url, {
          waitUntil: input.waitUntil ?? "load",
        })
        return {
          url: page.url(),
          status: response?.status() ?? null,
          title: await page.title(),
        }
      } catch (err: any) {
        return toolError("NAVIGATION_FAILED", err.message)
      }
    },
  })

  registry.register({
    name: "page_reload",
    description: "Reload the current page.",
    inputSchema: {
      properties: {
        waitUntil: {
          type: "string",
          enum: ["load", "domcontentloaded", "networkidle", "commit"],
          description: "Wait condition (default: load)",
        },
      },
    },
    handler: async (input) => {
      try {
        const page = browserManager.getPage()
        const response = await page.reload({
          waitUntil: input.waitUntil ?? "load",
        })
        return {
          url: page.url(),
          status: response?.status() ?? null,
          title: await page.title(),
        }
      } catch (err: any) {
        return toolError("RELOAD_FAILED", err.message)
      }
    },
  })

  registry.register({
    name: "page_go_back",
    description: "Navigate back in browser history.",
    inputSchema: { properties: {} },
    handler: async () => {
      try {
        const page = browserManager.getPage()
        const response = await page.goBack({ waitUntil: "load" })
        if (!response) {
          return toolError("NAVIGATION_FAILED", "No previous page in history")
        }
        return {
          url: page.url(),
          status: response.status(),
          title: await page.title(),
        }
      } catch (err: any) {
        return toolError("NAVIGATION_FAILED", err.message)
      }
    },
  })

  registry.register({
    name: "page_go_forward",
    description: "Navigate forward in browser history.",
    inputSchema: { properties: {} },
    handler: async () => {
      try {
        const page = browserManager.getPage()
        const response = await page.goForward({ waitUntil: "load" })
        if (!response) {
          return toolError("NAVIGATION_FAILED", "No next page in history")
        }
        return {
          url: page.url(),
          status: response.status(),
          title: await page.title(),
        }
      } catch (err: any) {
        return toolError("NAVIGATION_FAILED", err.message)
      }
    },
  })

  // ── DOM inspection ──

  registry.register({
    name: "page_to_markdown",
    description:
      "Convert the current page DOM to a readable Markdown representation. Headings, links, buttons, inputs, selects, tables, and images are all converted to descriptive Markdown annotations.",
    inputSchema: {
      properties: {
        selector: {
          type: "string",
          description: "CSS selector to scope the conversion to a subtree",
        },
        includeHidden: {
          type: "boolean",
          description: "Include hidden elements (default: false)",
        },
        simplify: {
          type: "boolean",
          description:
            "Simplify output by omitting annotations and markdown escaping (default: false)",
        },
      },
    },
    handler: async (input) => {
      try {
        const page = browserManager.getPage()
        const markdown = await pageToMarkdown(page, {
          selector: input.selector,
          includeHidden: input.includeHidden,
          simplify: input.simplify,
        })
        return {
          url: page.url(),
          title: await page.title(),
          markdown,
        }
      } catch (err: any) {
        return toolError("INSPECT_FAILED", err.message)
      }
    },
  })

  registry.register({
    name: "element_get",
    description:
      "Get detailed information about a specific DOM element including tag, text, attributes, visibility, bounding box, and computed styles.",
    inputSchema: {
      properties: {
        selector: {
          type: "string",
          description: "CSS selector for the target element",
        },
      },
      required: ["selector"],
    },
    handler: async (input) => {
      try {
        const page = browserManager.getPage()
        const info = await elementGet(page, input.selector)
        return info
      } catch (err: any) {
        return toolError("ELEMENT_GET_FAILED", err.message)
      }
    },
  })

  registry.register({
    name: "element_find",
    description:
      "Find elements matching criteria (CSS selector, text content, ARIA role). Returns an array of matching elements with their selectors.",
    inputSchema: {
      properties: {
        selector: { type: "string", description: "CSS selector to match" },
        text: {
          type: "string",
          description: "Text content to search for (case-insensitive substring match)",
        },
        role: {
          type: "string",
          description: "ARIA role to filter by",
        },
      },
    },
    handler: async (input) => {
      try {
        const page = browserManager.getPage()
        const elements = await elementFind(page, {
          selector: input.selector,
          text: input.text,
          role: input.role,
        })
        return { count: elements.length, elements }
      } catch (err: any) {
        return toolError("ELEMENT_FIND_FAILED", err.message)
      }
    },
  })

  // ── Element interaction ──

  registry.register({
    name: "element_click",
    description:
      "Click an element identified by a CSS selector. Optionally wait for navigation after clicking.",
    inputSchema: {
      properties: {
        selector: {
          type: "string",
          description: "CSS selector for the element to click",
        },
        button: {
          type: "string",
          enum: ["left", "right", "middle"],
          description: "Mouse button to use (default: left)",
        },
        clickCount: {
          type: "number",
          description: "Number of clicks (default: 1, use 2 for double-click)",
        },
        waitForNavigation: {
          type: "boolean",
          description: "Wait for navigation after click (default: false)",
        },
      },
      required: ["selector"],
    },
    handler: async (input) => {
      try {
        const page = browserManager.getPage()

        if (input.waitForNavigation) {
          const [response] = await Promise.all([
            page.waitForNavigation({ waitUntil: "load" }).catch(() => null),
            page.click(input.selector, {
              button: input.button ?? "left",
              clickCount: input.clickCount ?? 1,
            }),
          ])
          return {
            clicked: input.selector,
            navigated: response !== null,
            url: page.url(),
            title: await page.title(),
          }
        }

        await page.click(input.selector, {
          button: input.button ?? "left",
          clickCount: input.clickCount ?? 1,
        })
        return {
          clicked: input.selector,
          url: page.url(),
        }
      } catch (err: any) {
        return toolError("CLICK_FAILED", err.message)
      }
    },
  })

  registry.register({
    name: "element_type",
    description:
      "Type text into an input or textarea element. Optionally clear the field first.",
    inputSchema: {
      properties: {
        selector: {
          type: "string",
          description: "CSS selector for the input element",
        },
        text: {
          type: "string",
          description: "Text to type",
        },
        clear: {
          type: "boolean",
          description: "Clear the field before typing (default: false)",
        },
        delay: {
          type: "number",
          description: "Delay between keystrokes in ms (default: 0)",
        },
      },
      required: ["selector", "text"],
    },
    handler: async (input) => {
      try {
        const page = browserManager.getPage()

        if (input.clear) {
          await page.fill(input.selector, "")
        }

        await page.type(input.selector, input.text, {
          delay: input.delay ?? 0,
        })
        return {
          typed: input.text,
          selector: input.selector,
        }
      } catch (err: any) {
        return toolError("TYPE_FAILED", err.message)
      }
    },
  })

  registry.register({
    name: "element_select",
    description:
      "Select an option from a <select> element by value, label, or index.",
    inputSchema: {
      properties: {
        selector: {
          type: "string",
          description: "CSS selector for the <select> element",
        },
        value: {
          type: "string",
          description: "Option value to select",
        },
        label: {
          type: "string",
          description: "Option label to select",
        },
        index: {
          type: "number",
          description: "Option index to select (0-based)",
        },
      },
      required: ["selector"],
    },
    handler: async (input) => {
      try {
        const page = browserManager.getPage()
        let selected: string[]

        if (input.value !== undefined) {
          selected = await page.selectOption(input.selector, {
            value: input.value,
          })
        } else if (input.label !== undefined) {
          selected = await page.selectOption(input.selector, {
            label: input.label,
          })
        } else if (input.index !== undefined) {
          selected = await page.selectOption(input.selector, {
            index: input.index,
          })
        } else {
          return toolError(
            "INVALID_INPUT",
            "Provide one of: value, label, or index"
          )
        }

        return {
          selector: input.selector,
          selectedValues: selected,
        }
      } catch (err: any) {
        return toolError("SELECT_FAILED", err.message)
      }
    },
  })

  registry.register({
    name: "keyboard_press",
    description:
      "Press a keyboard key or key combination (e.g., 'Enter', 'Tab', 'Control+a', 'Escape').",
    inputSchema: {
      properties: {
        key: {
          type: "string",
          description:
            "Key to press. Supports key names (Enter, Tab, Escape, etc.) and combinations (Control+a, Shift+Tab).",
        },
      },
      required: ["key"],
    },
    handler: async (input) => {
      try {
        const page = browserManager.getPage()
        await page.keyboard.press(input.key)
        return { pressed: input.key }
      } catch (err: any) {
        return toolError("KEYBOARD_FAILED", err.message)
      }
    },
  })

  // ── Waiting ──

  registry.register({
    name: "page_wait_for",
    description:
      "Wait for a condition on the page: a CSS selector to appear, text to be present, navigation to complete, network to be idle, or a timeout.",
    inputSchema: {
      properties: {
        selector: {
          type: "string",
          description: "CSS selector to wait for",
        },
        text: {
          type: "string",
          description: "Text content to wait for on the page",
        },
        state: {
          type: "string",
          enum: ["attached", "detached", "visible", "hidden"],
          description:
            "Element state to wait for when using selector (default: visible)",
        },
        navigation: {
          type: "boolean",
          description: "Wait for the next navigation event",
        },
        networkIdle: {
          type: "boolean",
          description: "Wait for network to be idle (no requests for 500ms)",
        },
        timeout: {
          type: "number",
          description: "Timeout in milliseconds (default: 30000)",
        },
      },
    },
    handler: async (input) => {
      try {
        const page = browserManager.getPage()
        const timeout = input.timeout ?? 30000

        if (input.selector) {
          await page.waitForSelector(input.selector, {
            state: input.state ?? "visible",
            timeout,
          })
          return { waited: "selector", selector: input.selector }
        }

        if (input.text) {
          await page.waitForFunction(
            (text) => {
              /* eslint-disable no-undef */
              return (document as any).body.innerText.includes(text)
              /* eslint-enable no-undef */
            },
            input.text,
            { timeout }
          )
          return { waited: "text", text: input.text }
        }

        if (input.navigation) {
          await page.waitForNavigation({
            waitUntil: "load",
            timeout,
          })
          return {
            waited: "navigation",
            url: page.url(),
            title: await page.title(),
          }
        }

        if (input.networkIdle) {
          await page.waitForLoadState("networkidle", { timeout })
          return { waited: "networkIdle" }
        }

        // Plain timeout
        if (input.timeout) {
          await page.waitForTimeout(input.timeout)
          return { waited: "timeout", ms: input.timeout }
        }

        return toolError(
          "INVALID_INPUT",
          "Provide one of: selector, text, navigation, networkIdle, or timeout"
        )
      } catch (err: any) {
        return toolError("WAIT_FAILED", err.message)
      }
    },
  })

  // ── Console logs ──

  registry.register({
    name: "console_get_logs",
    description:
      "Get captured browser console logs. Optionally filter by type (log, warn, error, info, debug) and time range.",
    inputSchema: {
      properties: {
        types: {
          type: "array",
          items: { type: "string" },
          description:
            "Log types to include (e.g., ['error', 'warn']). Default: all types.",
        },
        since: {
          type: "number",
          description: "Only return logs after this Unix timestamp (ms)",
        },
        limit: {
          type: "number",
          description: "Maximum number of logs to return (most recent)",
        },
        clear: {
          type: "boolean",
          description: "Clear the log buffer after reading (default: false)",
        },
      },
    },
    handler: async (input) => {
      try {
        const capture = browserManager.getConsoleCapture()
        const logs = capture.getLogs({
          types: input.types,
          since: input.since,
          limit: input.limit,
          clear: input.clear,
        })
        return { count: logs.length, logs }
      } catch (err: any) {
        return toolError("CONSOLE_FAILED", err.message)
      }
    },
  })

  registry.register({
    name: "console_clear",
    description: "Clear the captured console log buffer.",
    inputSchema: { properties: {} },
    handler: async () => {
      try {
        const capture = browserManager.getConsoleCapture()
        capture.clear()
        return { status: "cleared" }
      } catch (err: any) {
        return toolError("CONSOLE_FAILED", err.message)
      }
    },
  })

  // ── Network capture ──

  registry.register({
    name: "network_get_requests",
    description:
      "Get captured network requests. Filter by URL substring, HTTP method, status code, resource type, and time range.",
    inputSchema: {
      properties: {
        url: {
          type: "string",
          description: "Filter by URL substring",
        },
        method: {
          type: "string",
          description: "Filter by HTTP method (GET, POST, etc.)",
        },
        status: {
          type: "number",
          description: "Filter by HTTP status code",
        },
        resourceType: {
          type: "string",
          description:
            "Filter by resource type (xhr, fetch, document, stylesheet, image, font, script, etc.)",
        },
        since: {
          type: "number",
          description: "Only return requests after this Unix timestamp (ms)",
        },
        limit: {
          type: "number",
          description: "Maximum number of requests to return (most recent)",
        },
      },
    },
    handler: async (input) => {
      try {
        const capture = browserManager.getNetworkCapture()
        const requests = capture.getRequests({
          url: input.url,
          method: input.method,
          status: input.status,
          resourceType: input.resourceType,
          since: input.since,
          limit: input.limit,
        })
        return { count: requests.length, requests }
      } catch (err: any) {
        return toolError("NETWORK_FAILED", err.message)
      }
    },
  })

  registry.register({
    name: "network_get_rpc_calls",
    description:
      "Get captured JSON-RPC calls (blockchain RPC). Parses request/response bodies to extract rpcMethod, rpcParams, rpcResult, and rpcError.",
    inputSchema: {
      properties: {
        rpcMethod: {
          type: "string",
          description: "Filter by RPC method name (e.g., 'eth_call', 'starknet_call')",
        },
        url: {
          type: "string",
          description: "Filter by RPC endpoint URL substring",
        },
        since: {
          type: "number",
          description: "Only return calls after this Unix timestamp (ms)",
        },
        limit: {
          type: "number",
          description: "Maximum number of calls to return (most recent)",
        },
      },
    },
    handler: async (input) => {
      try {
        const capture = browserManager.getNetworkCapture()
        const calls = capture.getRpcCalls({
          rpcMethod: input.rpcMethod,
          url: input.url,
          since: input.since,
          limit: input.limit,
        })
        return { count: calls.length, calls }
      } catch (err: any) {
        return toolError("NETWORK_FAILED", err.message)
      }
    },
  })

  // ── Page scripting ──

  registry.register({
    name: "page_evaluate",
    description:
      "Execute JavaScript code in the browser page context. Returns the result of the expression.",
    inputSchema: {
      properties: {
        expression: {
          type: "string",
          description: "JavaScript expression or function body to evaluate",
        },
      },
      required: ["expression"],
    },
    handler: async (input) => {
      try {
        const page = browserManager.getPage()
        const result = await page.evaluate(input.expression)
        return { result }
      } catch (err: any) {
        return toolError("EVALUATE_FAILED", err.message)
      }
    },
  })

  // ── Page summary ──

  registry.register({
    name: "page_get_summary",
    description:
      "Get a summary of the current page including URL, title, viewport size, number of links, buttons, inputs, images, and any console errors.",
    inputSchema: { properties: {} },
    handler: async () => {
      try {
        const page = browserManager.getPage()
        const url = page.url()
        const title = await page.title()
        const viewport = page.viewportSize()

        const counts = await page.evaluate(() => {
          /* eslint-disable no-undef */
          const doc = document as any
          return {
            links: doc.querySelectorAll("a[href]").length as number,
            buttons: doc.querySelectorAll(
              'button, input[type="button"], input[type="submit"]'
            ).length as number,
            inputs: doc.querySelectorAll(
              'input:not([type="button"]):not([type="submit"]), textarea, select'
            ).length as number,
            images: doc.querySelectorAll("img").length as number,
            forms: doc.querySelectorAll("form").length as number,
            headings: doc.querySelectorAll("h1, h2, h3, h4, h5, h6")
              .length as number,
          }
          /* eslint-enable no-undef */
        })

        // Get recent console errors
        let consoleErrors: string[] = []
        try {
          const capture = browserManager.getConsoleCapture()
          const errorLogs = capture.getLogs({ types: ["error"], limit: 5 })
          consoleErrors = errorLogs.map((l) => l.message)
        } catch {
          // Console capture might not be available
        }

        return {
          url,
          title,
          viewport,
          counts,
          consoleErrors,
        }
      } catch (err: any) {
        return toolError("SUMMARY_FAILED", err.message)
      }
    },
  })
}
