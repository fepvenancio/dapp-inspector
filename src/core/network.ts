import type { Page, Request, Response } from "playwright"

export type NetworkRequestEntry = {
  url: string
  method: string
  status: number | null
  resourceType: string
  requestHeaders: Record<string, string>
  responseHeaders: Record<string, string>
  requestBody: string | null
  responseBody: string | null
  duration: number | null
  timestamp: number
  failed: boolean
  failureText: string | null
}

export type NetworkFilter = {
  url?: string
  method?: string
  status?: number
  resourceType?: string
  since?: number
  limit?: number
}

export type RpcCallEntry = {
  url: string
  rpcMethod: string
  rpcParams: unknown
  rpcId: unknown
  rpcResult: unknown
  rpcError: unknown
  status: number | null
  duration: number | null
  timestamp: number
}

export type RpcFilter = {
  rpcMethod?: string
  url?: string
  since?: number
  limit?: number
}

export class NetworkCapture {
  private buffer: NetworkRequestEntry[] = []
  private pending: Map<Request, { timestamp: number }> = new Map()
  private maxSize: number
  private page: Page
  private requestHandler: (request: Request) => void
  private responseHandler: (response: Response) => void
  private failedHandler: (request: Request) => void

  constructor(page: Page, maxSize: number = 500) {
    this.page = page
    this.maxSize = maxSize

    this.requestHandler = (request: Request) => {
      this.pending.set(request, { timestamp: Date.now() })
    }

    this.responseHandler = async (response: Response) => {
      const request = response.request()
      const pendingInfo = this.pending.get(request)
      const timestamp = pendingInfo?.timestamp ?? Date.now()
      this.pending.delete(request)

      let requestBody: string | null = null
      try {
        requestBody = request.postData() ?? null
      } catch {
        // postData not available for some request types
      }

      let responseBody: string | null = null
      const resourceType = request.resourceType()
      if (resourceType === "xhr" || resourceType === "fetch") {
        try {
          responseBody = await response.text()
        } catch {
          // Response body may not be available
        }
      }

      let requestHeaders: Record<string, string> = {}
      try {
        requestHeaders = await request.allHeaders()
      } catch {
        requestHeaders = request.headers()
      }

      let responseHeaders: Record<string, string> = {}
      try {
        responseHeaders = await response.allHeaders()
      } catch {
        responseHeaders = response.headers()
      }

      const entry: NetworkRequestEntry = {
        url: request.url(),
        method: request.method(),
        status: response.status(),
        resourceType,
        requestHeaders,
        responseHeaders,
        requestBody,
        responseBody,
        duration: Date.now() - timestamp,
        timestamp,
        failed: false,
        failureText: null,
      }

      this.pushEntry(entry)
    }

    this.failedHandler = (request: Request) => {
      const pendingInfo = this.pending.get(request)
      const timestamp = pendingInfo?.timestamp ?? Date.now()
      this.pending.delete(request)

      let requestBody: string | null = null
      try {
        requestBody = request.postData() ?? null
      } catch {
        // postData not available for some request types
      }

      const entry: NetworkRequestEntry = {
        url: request.url(),
        method: request.method(),
        status: null,
        resourceType: request.resourceType(),
        requestHeaders: request.headers(),
        responseHeaders: {},
        requestBody,
        responseBody: null,
        duration: Date.now() - timestamp,
        timestamp,
        failed: true,
        failureText: request.failure()?.errorText ?? "Unknown failure",
      }

      this.pushEntry(entry)
    }

    this.page.on("request", this.requestHandler)
    this.page.on("response", this.responseHandler)
    this.page.on("requestfailed", this.failedHandler)
  }

  private pushEntry(entry: NetworkRequestEntry): void {
    this.buffer.push(entry)
    if (this.buffer.length > this.maxSize) {
      this.buffer = this.buffer.slice(this.buffer.length - this.maxSize)
    }
  }

  getRequests(filter: NetworkFilter = {}): NetworkRequestEntry[] {
    let results = this.buffer

    if (filter.url) {
      const urlSubstring = filter.url
      results = results.filter((e) => e.url.includes(urlSubstring))
    }

    if (filter.method) {
      const method = filter.method.toUpperCase()
      results = results.filter((e) => e.method.toUpperCase() === method)
    }

    if (filter.status !== undefined) {
      results = results.filter((e) => e.status === filter.status)
    }

    if (filter.resourceType) {
      results = results.filter((e) => e.resourceType === filter.resourceType)
    }

    if (filter.since !== undefined) {
      results = results.filter((e) => e.timestamp >= filter.since!)
    }

    if (filter.limit !== undefined && filter.limit > 0) {
      results = results.slice(-filter.limit)
    }

    return results
  }

  getRpcCalls(filter: RpcFilter = {}): RpcCallEntry[] {
    // Filter to only XHR/fetch requests that look like JSON-RPC
    const candidates = this.buffer.filter(
      (e) =>
        (e.resourceType === "xhr" || e.resourceType === "fetch") &&
        e.requestBody !== null
    )

    const rpcCalls: RpcCallEntry[] = []

    for (const entry of candidates) {
      let parsed: any
      try {
        parsed = JSON.parse(entry.requestBody!)
      } catch {
        continue
      }

      // Handle both single and batch JSON-RPC requests
      const requests = Array.isArray(parsed) ? parsed : [parsed]

      for (const req of requests) {
        if (typeof req !== "object" || req === null) continue
        if (!req.method || req.jsonrpc !== "2.0") continue

        let rpcResult: unknown = null
        let rpcError: unknown = null

        if (entry.responseBody) {
          try {
            const respParsed = JSON.parse(entry.responseBody)
            // For batch responses, try to match by ID
            if (Array.isArray(respParsed)) {
              const matching = respParsed.find((r: any) => r.id === req.id)
              if (matching) {
                rpcResult = matching.result ?? null
                rpcError = matching.error ?? null
              }
            } else {
              rpcResult = respParsed.result ?? null
              rpcError = respParsed.error ?? null
            }
          } catch {
            // Response body is not valid JSON
          }
        }

        rpcCalls.push({
          url: entry.url,
          rpcMethod: req.method,
          rpcParams: req.params ?? null,
          rpcId: req.id ?? null,
          rpcResult,
          rpcError,
          status: entry.status,
          duration: entry.duration,
          timestamp: entry.timestamp,
        })
      }
    }

    let results = rpcCalls

    if (filter.rpcMethod) {
      const method = filter.rpcMethod
      results = results.filter((e) => e.rpcMethod === method)
    }

    if (filter.url) {
      const urlSubstring = filter.url
      results = results.filter((e) => e.url.includes(urlSubstring))
    }

    if (filter.since !== undefined) {
      results = results.filter((e) => e.timestamp >= filter.since!)
    }

    if (filter.limit !== undefined && filter.limit > 0) {
      results = results.slice(-filter.limit)
    }

    return results
  }

  clear(): void {
    this.buffer = []
    this.pending.clear()
  }

  detach(): void {
    this.page.removeListener("request", this.requestHandler)
    this.page.removeListener("response", this.responseHandler)
    this.page.removeListener("requestfailed", this.failedHandler)
  }
}
