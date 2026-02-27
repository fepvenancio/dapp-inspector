import type { DappInspectorAdapter } from "./interface.js"

const BUILT_IN_ADAPTERS: Record<string, () => Promise<DappInspectorAdapter>> = {
  starknet: async () => {
    const { StarkNetAdapter } = await import("./starknet/index.js")
    return new StarkNetAdapter()
  },
  evm: async () => {
    const { EVMAdapter } = await import("./evm/index.js")
    return new EVMAdapter()
  },
  solana: async () => {
    const { SolanaAdapter } = await import("./solana/index.js")
    return new SolanaAdapter()
  },
}

/**
 * Loads and instantiates an adapter for the given chain.
 *
 * Built-in adapters are resolved by name ("starknet", "evm", "solana").
 * Custom adapters are loaded via dynamic import from the given path.
 *
 * Returns an instantiated adapter that has NOT been initialized yet.
 * Initialization (with browser context and config) happens later.
 */
export async function loadAdapter(
  chain: string,
  adapterPath?: string,
): Promise<DappInspectorAdapter> {
  // If a custom adapter path is provided, use it
  if (adapterPath) {
    try {
      const module = await import(adapterPath)

      // Support both default export and named export patterns
      const AdapterClass =
        module.default ?? module[`${chain}Adapter`] ?? module.Adapter

      if (!AdapterClass) {
        throw new Error(
          `Custom adapter module at "${adapterPath}" does not export a default class, ` +
            `"${chain}Adapter", or "Adapter".`,
        )
      }

      if (typeof AdapterClass === "function") {
        return new AdapterClass()
      }

      // If it's already an instance (e.g. a factory pattern)
      if (typeof AdapterClass === "object" && AdapterClass.name && AdapterClass.initialize) {
        return AdapterClass as DappInspectorAdapter
      }

      throw new Error(
        `Custom adapter at "${adapterPath}" does not export a valid adapter class or instance.`,
      )
    } catch (err: any) {
      if (err.code === "ERR_MODULE_NOT_FOUND" || err.code === "MODULE_NOT_FOUND") {
        throw new Error(
          `Custom adapter not found at "${adapterPath}". ` +
            `Make sure the path is correct and the module is installed.`,
        )
      }
      throw err
    }
  }

  // Look up built-in adapter
  const factory = BUILT_IN_ADAPTERS[chain]
  if (!factory) {
    const available = Object.keys(BUILT_IN_ADAPTERS).join(", ")
    throw new Error(
      `Unknown chain "${chain}". Built-in adapters: ${available}. ` +
        `For custom chains, provide an "adapterPath" in your config.`,
    )
  }

  return factory()
}
