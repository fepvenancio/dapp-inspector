import { z } from "zod"

const AccountSchema = z.object({
  address: z.string().min(1, "Account address is required"),
  privateKey: z.string().min(1, "Account private key is required"),
  label: z.string().optional(),
})

const BrowserConfigSchema = z.object({
  headless: z.boolean().default(false),
  viewport: z.object({
    width: z.number().int().positive().default(1280),
    height: z.number().int().positive().default(800),
  }).default({ width: 1280, height: 800 }),
  recordVideo: z.boolean().default(false),
}).default({})

const BaseAdapterConfigSchema = z.object({
  devnetUrl: z.string().url().optional(),
  accounts: z.array(AccountSchema).min(1, "At least one account is required"),
  autoApprove: z.boolean().default(false),
})

export const StarkNetAdapterConfigSchema = BaseAdapterConfigSchema.extend({
  devnetUrl: z.string().url().default("http://localhost:5050"),
  starknetVersion: z.enum(["v5", "v6"]).default("v6"),
  chainId: z.string().default("SN_SEPOLIA"),
})

export const EVMAdapterConfigSchema = BaseAdapterConfigSchema.extend({
  devnetUrl: z.string().url().default("http://localhost:8545"),
  chainId: z.number().int().default(31337),
  gasConfig: z.object({
    gasLimit: z.string().optional(),
    gasPrice: z.string().optional(),
  }).optional(),
})

export const SolanaAdapterConfigSchema = BaseAdapterConfigSchema.extend({
  devnetUrl: z.string().url().default("http://localhost:8899"),
  wsUrl: z.string().default("ws://localhost:8900"),
  commitment: z.enum(["processed", "confirmed", "finalized"]).default("confirmed"),
})

export const DappInspectorConfigSchema = z.object({
  chain: z.string().min(1, "Chain is required"),
  adapterPath: z.string().optional(),
  browser: BrowserConfigSchema,
  adapter: z.record(z.unknown()),
})

export type DappInspectorConfig = z.infer<typeof DappInspectorConfigSchema>
export type StarkNetAdapterConfig = z.infer<typeof StarkNetAdapterConfigSchema>
export type EVMAdapterConfig = z.infer<typeof EVMAdapterConfigSchema>
export type SolanaAdapterConfig = z.infer<typeof SolanaAdapterConfigSchema>

export function validateAdapterConfig(chain: string, raw: Record<string, unknown>) {
  switch (chain) {
    case "starknet":
      return StarkNetAdapterConfigSchema.parse(raw)
    case "evm":
      return EVMAdapterConfigSchema.parse(raw)
    case "solana":
      return SolanaAdapterConfigSchema.parse(raw)
    default:
      return BaseAdapterConfigSchema.parse(raw)
  }
}
