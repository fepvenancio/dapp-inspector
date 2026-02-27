import type { Page } from "playwright"

export type PageToMarkdownOptions = {
  selector?: string
  includeHidden?: boolean
  simplify?: boolean
}

export type ElementInfo = {
  tagName: string
  text: string
  attributes: Record<string, string>
  isVisible: boolean
  isEnabled: boolean
  boundingBox: { x: number; y: number; width: number; height: number } | null
  computedStyles: Record<string, string>
}

export type ElementFindOptions = {
  selector?: string
  text?: string
  role?: string
}

export type FoundElement = {
  index: number
  tagName: string
  text: string
  selector: string
  attributes: Record<string, string>
  isVisible: boolean
}

/**
 * Converts the page DOM to a readable Markdown representation.
 * All DOM manipulation happens inside page.evaluate (browser context).
 */
export async function pageToMarkdown(
  page: Page,
  options: PageToMarkdownOptions = {}
): Promise<string> {
  const { selector, includeHidden = false, simplify = false } = options

  const markdown: string = await page.evaluate(
    (opts: { selector: string | null; includeHidden: boolean; simplify: boolean }) => {
      /* eslint-disable no-undef -- runs in browser context */
      const root = opts.selector
        ? document.querySelector(opts.selector)
        : document.body

      if (!root) return "*Element not found*"

      function isElementVisible(el: any): boolean {
        if (opts.includeHidden) return true
        const style = window.getComputedStyle(el)
        if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
          return false
        }
        // offsetParent is null for fixed/sticky/body elements and in headless mode.
        // Only use it as a hint combined with zero dimensions to detect truly hidden elements.
        if (el.offsetParent === null && el.tagName !== "BODY" && el.tagName !== "HTML") {
          const pos = style.position
          if (pos !== "fixed" && pos !== "sticky") {
            // Check if element has dimensions — headless sometimes lacks offsetParent
            const rect = el.getBoundingClientRect()
            if (rect.width === 0 && rect.height === 0) return false
          }
        }
        return true
      }

      function getAnnotation(el: any): string {
        const parts: string[] = []
        const ariaLabel = el.getAttribute("aria-label")
        if (ariaLabel) parts.push(`aria="${ariaLabel}"`)
        const testId = el.getAttribute("data-testid")
        if (testId) parts.push(`testid="${testId}"`)
        if (parts.length === 0) return ""
        return ` (${parts.join(", ")})`
      }

      function escapeMarkdown(text: string): string {
        return text.replace(/([|\\`*_{}[\]()#+\-.!])/g, "\\$1")
      }

      function processTable(table: any): string {
        const rows: string[][] = []
        const trs = table.querySelectorAll("tr")
        for (const tr of trs) {
          const cells: string[] = []
          const tds = tr.querySelectorAll("th, td")
          for (const td of tds) {
            cells.push((td.textContent || "").trim())
          }
          if (cells.length > 0) rows.push(cells)
        }
        if (rows.length === 0) return ""

        const colCount = Math.max(...rows.map((r: string[]) => r.length))
        const normalized = rows.map((r: string[]) => {
          while (r.length < colCount) r.push("")
          return r
        })

        let md = ""
        md += "| " + normalized[0].map((c: string) => c || " ").join(" | ") + " |\n"
        md += "| " + normalized[0].map(() => "---").join(" | ") + " |\n"
        for (let i = 1; i < normalized.length; i++) {
          md += "| " + normalized[i].map((c: string) => c || " ").join(" | ") + " |\n"
        }
        return md
      }

      function processNode(node: any, depth: number): string {
        if (node.nodeType === 3 /* TEXT_NODE */) {
          const text = (node.textContent || "").trim()
          return text ? (opts.simplify ? text : escapeMarkdown(text)) : ""
        }

        if (node.nodeType !== 1 /* ELEMENT_NODE */) return ""

        const el = node
        const tag = el.tagName.toLowerCase()

        if (!isElementVisible(el)) return ""

        if (["script", "style", "noscript"].includes(tag)) return ""
        if (tag === "br") return "\n"

        const annotation = opts.simplify ? "" : getAnnotation(el)

        // Headings
        if (/^h[1-6]$/.test(tag)) {
          const level = parseInt(tag[1])
          const text = (el.textContent || "").trim()
          if (!text) return ""
          return "\n" + "#".repeat(level) + " " + text + annotation + "\n"
        }

        // Links
        if (tag === "a") {
          const href = el.getAttribute("href") || ""
          const text = (el.textContent || "").trim()
          if (!text) return ""
          return `[${text}](${href})${annotation}`
        }

        // Images
        if (tag === "img") {
          const alt = el.getAttribute("alt") || "image"
          return `[IMAGE: ${alt}]${annotation}`
        }

        // Buttons
        if (tag === "button" || (tag === "input" && (el.type === "button" || el.type === "submit"))) {
          const label =
            (el.textContent || "").trim() ||
            el.getAttribute("aria-label") ||
            el.getAttribute("value") ||
            ""
          const disabled = el.disabled ? " (disabled)" : ""
          return `[BUTTON: ${label}${disabled}]${annotation}`
        }

        // Inputs
        if (tag === "input") {
          const type = el.type || "text"
          const placeholder = el.placeholder ? `, placeholder="${el.placeholder}"` : ""
          const value = el.value ? `, value="${el.value}"` : ""
          const name = el.name ? `, name="${el.name}"` : ""
          const disabled = el.disabled ? ", disabled" : ""
          return `[INPUT: type=${type}${name}${placeholder}${value}${disabled}]${annotation}`
        }

        // Textareas
        if (tag === "textarea") {
          const placeholder = el.placeholder ? `, placeholder="${el.placeholder}"` : ""
          const value = el.value ? `, value="${el.value.substring(0, 100)}"` : ""
          const name = el.name ? `, name="${el.name}"` : ""
          return `[TEXTAREA${name}${placeholder}${value}]${annotation}`
        }

        // Selects
        if (tag === "select") {
          const current = el.options[el.selectedIndex]?.text ?? ""
          const allOpts = Array.from(el.options) as any[]
          const optTexts = allOpts.map((o: any) => o.text).slice(0, 10)
          const moreCount = el.options.length - optTexts.length
          const more = moreCount > 0 ? `, +${moreCount} more` : ""
          const name = el.name ? `, name="${el.name}"` : ""
          return `[SELECT: "${current}"${name}, options: ${optTexts.join(", ")}${more}]${annotation}`
        }

        // Tables
        if (tag === "table") {
          return "\n" + processTable(el) + "\n"
        }

        // Skip table internals (handled by processTable)
        if (["thead", "tbody", "tfoot", "tr", "th", "td"].includes(tag)) {
          return ""
        }

        // Lists
        if (tag === "ul" || tag === "ol") {
          const items: string[] = []
          const lis = el.querySelectorAll(":scope > li")
          lis.forEach((li: any, i: number) => {
            const text = processChildren(li, depth + 1).trim()
            if (text) {
              const prefix = tag === "ol" ? `${i + 1}. ` : "- "
              items.push(prefix + text)
            }
          })
          return items.length > 0 ? "\n" + items.join("\n") + "\n" : ""
        }

        if (tag === "li") {
          return processChildren(el, depth).trim()
        }

        // Paragraphs
        if (tag === "p") {
          const content = processChildren(el, depth).trim()
          return content ? "\n" + content + "\n" : ""
        }

        // Block-level elements
        if (["div", "section", "article", "main", "header", "footer", "nav", "aside", "form", "fieldset"].includes(tag)) {
          return processChildren(el, depth)
        }

        // Inline formatting
        if (tag === "strong" || tag === "b") {
          const text = processChildren(el, depth).trim()
          return text ? `**${text}**` : ""
        }

        if (tag === "em" || tag === "i") {
          const text = processChildren(el, depth).trim()
          return text ? `*${text}*` : ""
        }

        if (tag === "code") {
          const text = (el.textContent || "").trim()
          return text ? `\`${text}\`` : ""
        }

        if (tag === "pre") {
          const text = (el.textContent || "").trim()
          return text ? "\n```\n" + text + "\n```\n" : ""
        }

        if (tag === "svg") {
          return "[SVG]"
        }

        return processChildren(el, depth)
      }

      function processChildren(el: any, depth: number): string {
        const parts: string[] = []
        for (const child of el.childNodes) {
          const result = processNode(child, depth)
          if (result) parts.push(result)
        }
        return parts.join(" ").replace(/ {2,}/g, " ")
      }

      let result = processNode(root, 0)

      result = result
        .replace(/\n{3,}/g, "\n\n")
        .replace(/ +\n/g, "\n")
        .trim()

      return result
      /* eslint-enable no-undef */
    },
    { selector: selector ?? null, includeHidden, simplify }
  )

  return markdown
}

/**
 * Get detailed information about a specific DOM element.
 */
export async function elementGet(
  page: Page,
  selector: string
): Promise<ElementInfo> {
  const handle = await page.$(selector)
  if (!handle) {
    throw new Error(`Element not found: ${selector}`)
  }

  const info: ElementInfo = await handle.evaluate((el: any) => {
    /* eslint-disable no-undef -- runs in browser context */
    const style = window.getComputedStyle(el)
    const attrs: Record<string, string> = {}
    for (const attr of el.attributes) {
      attrs[attr.name] = attr.value
    }

    const rect = el.getBoundingClientRect()
    const boundingBox =
      rect.width > 0 && rect.height > 0
        ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
        : null

    const isVisible =
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      style.opacity !== "0" &&
      el.offsetParent !== null

    const isEnabled = !el.disabled

    const keyStyles: Record<string, string> = {
      display: style.display,
      visibility: style.visibility,
      opacity: style.opacity,
      color: style.color,
      backgroundColor: style.backgroundColor,
      fontSize: style.fontSize,
      fontWeight: style.fontWeight,
      position: style.position,
      overflow: style.overflow,
      cursor: style.cursor,
    }

    return {
      tagName: el.tagName.toLowerCase(),
      text: (el.textContent ?? "").trim().substring(0, 500),
      attributes: attrs,
      isVisible,
      isEnabled,
      boundingBox,
      computedStyles: keyStyles,
    }
    /* eslint-enable no-undef */
  })

  await handle.dispose()
  return info
}

/**
 * Find elements matching criteria (CSS selector, text content, ARIA role).
 */
export async function elementFind(
  page: Page,
  options: ElementFindOptions
): Promise<FoundElement[]> {
  const { selector, text, role } = options

  let cssSelector = selector ?? "*"
  if (role) {
    cssSelector = selector
      ? `${selector}[role="${role}"]`
      : `[role="${role}"]`
  }

  const found: FoundElement[] = await page.evaluate(
    (args: { cssSelector: string; text: string | null }) => {
      /* eslint-disable no-undef -- runs in browser context */
      const elements = document.querySelectorAll(args.cssSelector)
      const results: Array<{
        index: number
        tagName: string
        text: string
        selector: string
        attributes: Record<string, string>
        isVisible: boolean
      }> = []

      function buildSelector(element: any): string {
        const testId = element.getAttribute("data-testid")
        if (testId) return `[data-testid="${testId}"]`
        if (element.id) return `#${element.id}`

        const parent = element.parentElement
        if (!parent) return element.tagName.toLowerCase()

        const siblings = Array.from(parent.children).filter(
          (s: any) => s.tagName === element.tagName
        )
        if (siblings.length === 1) {
          return buildSelector(parent) + " > " + element.tagName.toLowerCase()
        }
        const index = siblings.indexOf(element) + 1
        return (
          buildSelector(parent) +
          " > " +
          element.tagName.toLowerCase() +
          `:nth-of-type(${index})`
        )
      }

      let idx = 0
      for (const el of elements) {
        const style = window.getComputedStyle(el)
        const isVisible =
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          style.opacity !== "0" &&
          (el as any).offsetParent !== null

        const elText = (el.textContent ?? "").trim()

        if (args.text && !elText.toLowerCase().includes(args.text.toLowerCase())) {
          continue
        }

        const attrs: Record<string, string> = {}
        for (const attr of el.attributes) {
          attrs[attr.name] = attr.value
        }

        results.push({
          index: idx++,
          tagName: el.tagName.toLowerCase(),
          text: elText.substring(0, 200),
          selector: buildSelector(el),
          attributes: attrs,
          isVisible,
        })

        if (results.length >= 50) break
      }

      return results
      /* eslint-enable no-undef */
    },
    { cssSelector, text: text ?? null }
  )

  return found
}
