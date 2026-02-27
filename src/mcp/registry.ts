import type { ToolDefinition, ToolRegistry, ToolError } from "../adapters/interface.js"
import { toolError } from "../adapters/interface.js"

export type McpToolSchema = {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export type DispatchResult = {
  content: Array<{ type: "text"; text: string }>
  isError?: boolean
}

export class ToolRegistryImpl implements ToolRegistry {
  private tools: Map<string, ToolDefinition> = new Map()

  register(tool: ToolDefinition): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool "${tool.name}" is already registered`)
    }
    if (!tool.name || typeof tool.name !== "string") {
      throw new Error("Tool name must be a non-empty string")
    }
    if (!tool.handler || typeof tool.handler !== "function") {
      throw new Error(`Tool "${tool.name}" must have a handler function`)
    }
    this.tools.set(tool.name, tool)
  }

  getTools(): McpToolSchema[] {
    const result: McpToolSchema[] = []
    for (const tool of this.tools.values()) {
      result.push({
        name: tool.name,
        description: tool.description,
        inputSchema: {
          type: "object",
          ...tool.inputSchema,
        },
      })
    }
    return result
  }

  async dispatch(name: string, input: Record<string, unknown>): Promise<DispatchResult> {
    const tool = this.tools.get(name)
    if (!tool) {
      const err = toolError("UNKNOWN_TOOL", `No tool registered with name "${name}"`)
      return {
        content: [{ type: "text", text: JSON.stringify(err) }],
        isError: true,
      }
    }

    try {
      const result = await tool.handler(input)

      // If the handler returned a ToolError, mark as error
      if (result && typeof result === "object" && result.error === true) {
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          isError: true,
        }
      }

      // Normalize result to string
      const text = typeof result === "string" ? result : JSON.stringify(result, null, 2)
      return {
        content: [{ type: "text", text }],
      }
    } catch (err: any) {
      const toolErr = toolError(
        "TOOL_EXECUTION_ERROR",
        `Tool "${name}" threw an error: ${err.message ?? String(err)}`,
        { stack: err.stack },
      )
      return {
        content: [{ type: "text", text: JSON.stringify(toolErr) }],
        isError: true,
      }
    }
  }

  has(name: string): boolean {
    return this.tools.has(name)
  }

  count(): number {
    return this.tools.size
  }
}
