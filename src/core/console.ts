import type { Page, ConsoleMessage } from "playwright"

export type ConsoleLogEntry = {
  type: string
  message: string
  args: string[]
  timestamp: number
  location: string
}

export type ConsoleGetLogsOptions = {
  types?: string[]
  since?: number
  limit?: number
  clear?: boolean
}

export class ConsoleCapture {
  private buffer: ConsoleLogEntry[] = []
  private maxSize: number
  private page: Page
  private handler: (msg: ConsoleMessage) => void

  constructor(page: Page, maxSize: number = 1000) {
    this.page = page
    this.maxSize = maxSize

    this.handler = (msg: ConsoleMessage) => {
      const entry: ConsoleLogEntry = {
        type: msg.type(),
        message: msg.text(),
        args: msg.args().map((arg) => String(arg)),
        timestamp: Date.now(),
        location: msg.location()
          ? `${msg.location().url}:${msg.location().lineNumber}:${msg.location().columnNumber}`
          : "",
      }

      this.buffer.push(entry)

      // Circular buffer: trim from the front when exceeding max
      if (this.buffer.length > this.maxSize) {
        this.buffer = this.buffer.slice(this.buffer.length - this.maxSize)
      }
    }

    this.page.on("console", this.handler)
  }

  getLogs(options: ConsoleGetLogsOptions = {}): ConsoleLogEntry[] {
    let logs = this.buffer

    if (options.types && options.types.length > 0) {
      const typeSet = new Set(options.types)
      logs = logs.filter((entry) => typeSet.has(entry.type))
    }

    if (options.since !== undefined) {
      logs = logs.filter((entry) => entry.timestamp >= options.since!)
    }

    if (options.limit !== undefined && options.limit > 0) {
      logs = logs.slice(-options.limit)
    }

    if (options.clear) {
      this.clear()
    }

    return logs
  }

  clear(): void {
    this.buffer = []
  }

  detach(): void {
    this.page.removeListener("console", this.handler)
  }
}
