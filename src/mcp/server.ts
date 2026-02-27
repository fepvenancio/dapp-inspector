import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js"
import { loadConfig } from "../config/loader.js"
import { ToolRegistryImpl } from "./registry.js"
import { BrowserManager } from "../core/browser.js"
import { registerCoreTools } from "../core/tools.js"
import { loadAdapter } from "../adapters/loader.js"
import type { DappInspectorAdapter } from "../adapters/interface.js"

export type ServerContext = {
  server: Server
  registry: ToolRegistryImpl
  browserManager: BrowserManager
  adapter: DappInspectorAdapter
  shutdown: () => Promise<void>
}

export async function createServer(configPath?: string): Promise<ServerContext> {
  // 1. Load configuration
  const config = await loadConfig(configPath)

  // 2. Create tool registry
  const registry = new ToolRegistryImpl()

  // 3. Create browser manager and launch browser
  const browserManager = new BrowserManager(config.browser)
  const browserContext = await browserManager.launch()

  // 4. Load the chain adapter
  const adapter = await loadAdapter(config.chain, config.adapterPath)

  // 5. Initialize adapter with browser context and adapter config
  await adapter.initialize(browserContext, config.adapter as any)

  // 6. Register core tools (navigate, screenshot, inspect, console, etc.)
  registerCoreTools(registry, browserManager, adapter)

  // 7. Register adapter-specific tools
  adapter.registerTools(registry)

  // 8. Create MCP server
  const server = new Server(
    {
      name: "dapp-inspector",
      version: "0.1.0",
    },
    {
      capabilities: {
        tools: {},
      },
    },
  )

  // Handle tools/list requests
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: registry.getTools(),
    }
  })

  // Handle tools/call requests
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params
    const result = await registry.dispatch(name, args ?? {})
    return result
  })

  // Shutdown function for clean teardown
  const shutdown = async () => {
    try {
      await adapter.teardown()
    } catch {
      // Best-effort teardown
    }
    try {
      await browserManager.close()
    } catch {
      // Best-effort close
    }
    await server.close()
  }

  // Handle process signals for graceful shutdown
  const onSignal = () => {
    shutdown().finally(() => process.exit(0))
  }
  process.on("SIGINT", onSignal)
  process.on("SIGTERM", onSignal)

  return { server, registry, browserManager, adapter, shutdown }
}

export async function startServer(configPath?: string): Promise<void> {
  const { server } = await createServer(configPath)
  const transport = new StdioServerTransport()
  await server.connect(transport)
}
