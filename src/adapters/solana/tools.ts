import type { ToolDefinition, ToolRegistry } from "../interface.js"
import { toolError } from "../interface.js"
import type { SolanaValidatorClient } from "./validator.js"
import { Keypair, PublicKey } from "@solana/web3.js"
import type { AccountConfig } from "../interface.js"

type ResolveKeypair = (addressOrLabel: string) => Keypair | null

export function registerSolanaTools(
  registry: ToolRegistry,
  validator: SolanaValidatorClient,
  accounts: AccountConfig[],
  resolveKeypair: ResolveKeypair,
): void {
  registry.register({
    name: "solana_airdrop",
    description:
      "Airdrops SOL to an address using the devnet faucet. Amount is in SOL.",
    inputSchema: {
      properties: {
        address: { type: "string", description: "Solana address to airdrop SOL to" },
        amount: { type: "number", description: "Amount in SOL (e.g. 10)" },
      },
      required: ["address", "amount"],
    },
    handler: async (input: { address: string; amount: number }) => {
      if (!input.address) return toolError("INVALID_INPUT", "address is required")
      if (!input.amount || input.amount <= 0) return toolError("INVALID_INPUT", "amount must be positive")
      try {
        return await validator.airdrop(input.address, input.amount)
      } catch (err: any) {
        return toolError("AIRDROP_FAILED", `Airdrop failed: ${err.message}`)
      }
    },
  })

  registry.register({
    name: "solana_get_balance",
    description:
      "Gets SOL balance or SPL token balance for an address. Omit mintAddress for SOL balance.",
    inputSchema: {
      properties: {
        address: { type: "string", description: "Solana address" },
        mintAddress: {
          type: "string",
          description: "SPL token mint address. Omit for SOL balance.",
        },
      },
      required: ["address"],
    },
    handler: async (input: { address: string; mintAddress?: string }) => {
      if (!input.address) return toolError("INVALID_INPUT", "address is required")
      try {
        return await validator.getBalance(input.address, input.mintAddress)
      } catch (err: any) {
        return toolError("BALANCE_FETCH_FAILED", `Failed to get balance: ${err.message}`)
      }
    },
  })

  registry.register({
    name: "solana_mint_spl_tokens",
    description:
      "Mints SPL tokens to an associated token account, creating the ATA if needed. " +
      "The mintAuthority must be a configured test account (address or label).",
    inputSchema: {
      properties: {
        mintAddress: { type: "string", description: "SPL token mint address" },
        toAddress: { type: "string", description: "Recipient address" },
        amount: { type: "number", description: "Amount in token units (respects decimals)" },
        mintAuthority: {
          type: "string",
          description: "Label or address of the mint authority account (must be configured)",
        },
      },
      required: ["mintAddress", "toAddress", "amount"],
    },
    handler: async (input: {
      mintAddress: string
      toAddress: string
      amount: number
      mintAuthority?: string
    }) => {
      if (!input.mintAddress) return toolError("INVALID_INPUT", "mintAddress is required")
      if (!input.toAddress) return toolError("INVALID_INPUT", "toAddress is required")
      if (!input.amount || input.amount <= 0) return toolError("INVALID_INPUT", "amount must be positive")

      const authorityRef = input.mintAuthority ?? accounts[0]?.address
      if (!authorityRef) return toolError("NO_ACCOUNTS", "No accounts configured for mint authority")

      const keypair = resolveKeypair(authorityRef)
      if (!keypair) {
        return toolError(
          "UNKNOWN_ACCOUNT",
          `Cannot find keypair for mint authority "${authorityRef}". It must be a configured test account.`,
        )
      }

      try {
        return await validator.mintSplTokens(
          input.mintAddress,
          input.toAddress,
          input.amount,
          keypair,
        )
      } catch (err: any) {
        return toolError("MINT_FAILED", `Failed to mint SPL tokens: ${err.message}`)
      }
    },
  })

  registry.register({
    name: "solana_create_mint",
    description:
      "Creates a new SPL token mint on the devnet. Returns the mint address.",
    inputSchema: {
      properties: {
        decimals: { type: "number", description: "Token decimals (default: 9)" },
        mintAuthority: {
          type: "string",
          description: "Label or address of the mint authority (must be a configured account)",
        },
        freezeAuthority: {
          type: "string",
          description: "Label or address for freeze authority (optional)",
        },
      },
      required: [],
    },
    handler: async (input: {
      decimals?: number
      mintAuthority?: string
      freezeAuthority?: string
    }) => {
      const decimals = input.decimals ?? 9
      const authorityRef = input.mintAuthority ?? accounts[0]?.address
      if (!authorityRef) return toolError("NO_ACCOUNTS", "No accounts configured")

      const keypair = resolveKeypair(authorityRef)
      if (!keypair) {
        return toolError(
          "UNKNOWN_ACCOUNT",
          `Cannot find keypair for "${authorityRef}". It must be a configured test account.`,
        )
      }

      let freezeAuthorityPubkey: PublicKey | null = null
      if (input.freezeAuthority) {
        const freezeKp = resolveKeypair(input.freezeAuthority)
        freezeAuthorityPubkey = freezeKp
          ? freezeKp.publicKey
          : new PublicKey(input.freezeAuthority)
      }

      try {
        return await validator.createMint(decimals, keypair, freezeAuthorityPubkey)
      } catch (err: any) {
        return toolError("CREATE_MINT_FAILED", `Failed to create mint: ${err.message}`)
      }
    },
  })

  registry.register({
    name: "solana_get_transaction",
    description:
      "Gets a confirmed transaction by signature. Returns status, slot, fee, instructions, and logs.",
    inputSchema: {
      properties: {
        signature: { type: "string", description: "Transaction signature" },
      },
      required: ["signature"],
    },
    handler: async (input: { signature: string }) => {
      if (!input.signature) return toolError("INVALID_INPUT", "signature is required")
      try {
        return await validator.getTransaction(input.signature)
      } catch (err: any) {
        return toolError("TX_FETCH_FAILED", `Failed to get transaction: ${err.message}`)
      }
    },
  })

  registry.register({
    name: "solana_get_account_info",
    description:
      "Gets raw account data for any Solana address. Supports base58, base64, and jsonParsed encoding.",
    inputSchema: {
      properties: {
        address: { type: "string", description: "Solana address" },
        encoding: {
          type: "string",
          enum: ["base58", "base64", "jsonParsed"],
          description: "Data encoding (default: jsonParsed)",
        },
      },
      required: ["address"],
    },
    handler: async (input: {
      address: string
      encoding?: "base58" | "base64" | "jsonParsed"
    }) => {
      if (!input.address) return toolError("INVALID_INPUT", "address is required")
      try {
        return await validator.getAccountInfo(
          input.address,
          input.encoding ?? "jsonParsed",
        )
      } catch (err: any) {
        return toolError("ACCOUNT_FETCH_FAILED", `Failed to get account info: ${err.message}`)
      }
    },
  })

  registry.register({
    name: "solana_advance_clock",
    description:
      "Advances the validator clock by a number of slots. Only works with solana-test-validator " +
      "that supports the warpSlot admin RPC. Setting absolute unix timestamps is not supported.",
    inputSchema: {
      properties: {
        slots: { type: "number", description: "Number of slots to advance" },
        unixTimestamp: {
          type: "number",
          description: "Absolute unix timestamp to set (not supported on most validators)",
        },
      },
      required: [],
    },
    handler: async (input: { slots?: number; unixTimestamp?: number }) => {
      try {
        return await validator.advanceClock(input.slots, input.unixTimestamp)
      } catch (err: any) {
        return toolError("CLOCK_ADVANCE_FAILED", `Failed to advance clock: ${err.message}`)
      }
    },
  })

  registry.register({
    name: "solana_get_program_accounts",
    description:
      "Gets all accounts owned by a program. Useful for asserting protocol state. " +
      "Supports memcmp and dataSize filters.",
    inputSchema: {
      properties: {
        programId: { type: "string", description: "Program ID to query" },
        filters: {
          type: "array",
          description: "Optional filters (memcmp or dataSize)",
          items: {
            type: "object",
            properties: {
              memcmp: {
                type: "object",
                properties: {
                  offset: { type: "number" },
                  bytes: { type: "string" },
                },
              },
              dataSize: { type: "number" },
            },
          },
        },
      },
      required: ["programId"],
    },
    handler: async (input: {
      programId: string
      filters?: Array<{
        memcmp?: { offset: number; bytes: string }
        dataSize?: number
      }>
    }) => {
      if (!input.programId) return toolError("INVALID_INPUT", "programId is required")
      try {
        return await validator.getProgramAccounts(input.programId, input.filters)
      } catch (err: any) {
        return toolError(
          "PROGRAM_ACCOUNTS_FAILED",
          `Failed to get program accounts: ${err.message}`,
        )
      }
    },
  })
}
