import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { DappInspectorConfigSchema, validateAdapterConfig, type DappInspectorConfig } from "./schema.js"

export async function loadConfig(configPath?: string): Promise<DappInspectorConfig> {
  const resolvedPath = resolve(configPath ?? "dapp-inspector.config.json")

  let raw: unknown
  try {
    const content = await readFile(resolvedPath, "utf-8")
    raw = JSON.parse(content)
  } catch (err: any) {
    if (err.code === "ENOENT") {
      throw new Error(`Config file not found: ${resolvedPath}\nRun 'dapp-inspector init' to create one.`)
    }
    throw new Error(`Failed to parse config file: ${err.message}`)
  }

  const config = DappInspectorConfigSchema.parse(raw)

  // Validate adapter-specific config
  const adapterConfig = validateAdapterConfig(config.chain, config.adapter as Record<string, unknown>)
  config.adapter = adapterConfig

  return config
}
