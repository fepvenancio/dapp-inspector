# Core Spec

The core engine is the chain-agnostic heart of dapp-inspector. It owns the browser session and all inspection capabilities. Every tool in this section works regardless of which chain adapter is loaded.

---

## Browser management

### `browser_launch`
Launches a new Playwright browser session. Called automatically on MCP server startup — not typically needed manually.

**Input**
```ts
{
  headless?: boolean       // default: false (visible browser helps debugging)
  viewport?: { width: number, height: number }  // default: 1280x800
  recordVideo?: boolean    // default: false
}
```

**Behavior**
- Launches Chromium (no extensions)
- Attaches console + network listeners immediately
- Signals the adapter to inject the wallet shim into the browser context

---

### `browser_close`
Closes the current browser session and cleans up all listeners.

---

### `browser_screenshot`
Takes a screenshot of the current page.

**Output**
```ts
{ imageBase64: string, width: number, height: number }
```

---

## Navigation

### `page_navigate`
Navigates to a URL and waits for the page to reach a stable state.

**Input**
```ts
{
  url: string
  waitFor?: "load" | "domcontentloaded" | "networkidle"  // default: "networkidle"
  timeout?: number  // ms, default: 30000
}
```

**Output**
```ts
{
  url: string           // final URL after redirects
  title: string
  status: number        // HTTP status
  loadTime: number      // ms
}
```

---

### `page_reload`
Reloads the current page.

---

### `page_go_back` / `page_go_forward`
Browser history navigation.

---

## DOM inspection

### `page_to_markdown`
Converts the current page DOM to readable Markdown. This is the primary tool for giving Claude a text representation of the UI state.

**Input**
```ts
{
  selector?: string    // scope to a CSS selector (default: full page)
  includeHidden?: boolean  // include hidden elements (default: false)
  simplify?: boolean   // strip decorative elements, focus on content (default: true)
}
```

**Output**
```ts
{
  markdown: string
  elementCount: number
  truncated: boolean   // true if page was too large and was summarized
}
```

**Conversion rules**
- Headings → Markdown headings
- Links → `[text](href)`
- Buttons → `[BUTTON: label]` with disabled state noted
- Inputs → `[INPUT: type, placeholder, value, name]`
- Selects → `[SELECT: current value, options...]`
- Images → `[IMAGE: alt text]`
- Tables → Markdown tables
- Hidden / display:none elements are excluded by default
- `aria-label` and `data-testid` attributes are preserved as annotations

---

### `element_get`
Gets detailed info about a specific element.

**Input**
```ts
{
  selector: string
}
```

**Output**
```ts
{
  tagName: string
  text: string
  attributes: Record<string, string>
  isVisible: boolean
  isEnabled: boolean
  boundingBox: { x, y, width, height }
  computedStyles: Record<string, string>  // key styles only
}
```

---

### `element_find`
Finds all elements matching a selector or text content.

**Input**
```ts
{
  selector?: string
  text?: string        // find by text content
  role?: string        // ARIA role
}
```

**Output**
```ts
{
  elements: Array<{ selector: string, text: string, isVisible: boolean }>
  count: number
}
```

---

## Interaction

### `element_click`
Clicks an element.

**Input**
```ts
{
  selector: string
  waitForNavigation?: boolean  // default: false
  timeout?: number
}
```

---

### `element_type`
Types text into an input field. Clears existing value first by default.

**Input**
```ts
{
  selector: string
  text: string
  clear?: boolean   // default: true
  delay?: number    // ms between keystrokes, default: 0
}
```

---

### `element_select`
Selects an option in a `<select>` element.

**Input**
```ts
{
  selector: string
  value?: string
  label?: string
}
```

---

### `keyboard_press`
Presses a key or key combination.

**Input**
```ts
{
  key: string   // e.g. "Enter", "Escape", "Tab", "Control+A"
}
```

---

### `page_wait_for`
Waits for a condition before continuing.

**Input**
```ts
{
  type: "selector" | "text" | "navigation" | "timeout" | "network_idle"
  value?: string    // selector or text to wait for
  timeout?: number  // ms
}
```

---

## Console inspection

The core engine attaches a console listener to every page immediately on load. All console output is buffered continuously.

### `console_get_logs`
Returns buffered console output.

**Input**
```ts
{
  types?: Array<"log" | "warn" | "error" | "info" | "debug">  // default: all
  since?: number       // timestamp — only logs after this time
  limit?: number       // default: 200
  clear?: boolean      // clear buffer after returning (default: false)
}
```

**Output**
```ts
{
  logs: Array<{
    type: "log" | "warn" | "error" | "info" | "debug"
    message: string
    args: any[]
    timestamp: number
    location?: { url: string, line: number, col: number }
  }>
  total: number
  hasErrors: boolean
  hasWarnings: boolean
}
```

---

### `console_clear`
Clears the log buffer.

---

## Network inspection

Network events are captured continuously from page load. Request/response pairs are stored as a circular buffer (last 500 by default).

### `network_get_requests`
Returns captured network requests.

**Input**
```ts
{
  filter?: {
    url?: string           // substring match
    method?: string        // GET, POST, etc.
    status?: number | "error" | "pending"
    resourceType?: string  // "fetch", "xhr", "document", "script", etc.
  }
  since?: number           // timestamp
  limit?: number           // default: 100
}
```

**Output**
```ts
{
  requests: Array<{
    id: string
    url: string
    method: string
    status: number | null
    resourceType: string
    requestHeaders: Record<string, string>
    requestBody: string | null
    responseHeaders: Record<string, string>
    responseBody: string | null    // captured for XHR/fetch only
    duration: number               // ms
    timestamp: number
    failed: boolean
    failureReason?: string
  }>
  totalCaptured: number
  failedCount: number
}
```

---

### `network_get_rpc_calls`
Shortcut tool that filters network requests to only JSON-RPC calls (the most relevant for DApp debugging). Automatically parses the JSON body and response.

**Input**
```ts
{
  method?: string    // filter by RPC method name, e.g. "starknet_call"
  failed?: boolean   // only failed calls
}
```

**Output**: same as `network_get_requests` but with parsed `rpcMethod`, `rpcParams`, and `rpcResult` fields added.

---

## JavaScript execution

### `page_evaluate`
Executes JavaScript in the page context and returns the result.

**Input**
```ts
{
  script: string
}
```

**Output**
```ts
{
  result: any
  error?: string
}
```

This is a power-user tool. Adapters use it internally to communicate with the wallet shim. It can also be used directly by Claude for one-off inspection tasks.

---

## Page state summary

### `page_get_summary`
Returns a combined summary of the current page state. Designed to give Claude a quick orientation without multiple round-trips.

**Output**
```ts
{
  url: string
  title: string
  markdown: string          // simplified DOM
  consoleErrors: number
  consoleWarnings: number
  failedRequests: number
  walletConnected: boolean  // from adapter
  walletAccount: string | null
  screenshot: string        // base64
}
```

This is often the first tool Claude should call when given a new URL to inspect.
