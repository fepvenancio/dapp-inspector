import type { ToolDefinition, ToolRegistry } from "../interface.js"
import { toolError } from "../interface.js"
import type { AnvilClient } from "./anvil.js"

export function registerEvmTools(
  registry: ToolRegistry,
  getAnvil: () => AnvilClient,
): void {
  const tools: ToolDefinition[] = [
    {
      name: "evm_mint_eth",
      description:
        "Mints ETH to an address using Anvil's anvil_setBalance. Amount is in ETH (e.g. '10.5').",
      inputSchema: {
        type: "object",
        properties: {
          address: { type: "string", description: "Target address (0x...)" },
          amount: {
            type: "string",
            description: "Amount of ETH to set as the balance (e.g. '10.5')",
          },
        },
        required: ["address", "amount"],
      },
      handler: async (input: { address: string; amount: string }) => {
        try {
          return await getAnvil().mintEth(input.address, input.amount)
        } catch (e: any) {
          return toolError("MINT_ETH_FAILED", e.message)
        }
      },
    },
    {
      name: "evm_mint_erc20",
      description:
        "Mints ERC20 tokens to an address by impersonating the token contract. Amount is in token units with decimals.",
      inputSchema: {
        type: "object",
        properties: {
          tokenAddress: {
            type: "string",
            description: "ERC20 token contract address",
          },
          toAddress: {
            type: "string",
            description: "Recipient address",
          },
          amount: {
            type: "string",
            description: "Amount in token units (e.g. '1000.5')",
          },
        },
        required: ["tokenAddress", "toAddress", "amount"],
      },
      handler: async (input: {
        tokenAddress: string
        toAddress: string
        amount: string
      }) => {
        try {
          return await getAnvil().mintErc20(
            input.tokenAddress,
            input.toAddress,
            input.amount,
          )
        } catch (e: any) {
          return toolError("MINT_ERC20_FAILED", e.message)
        }
      },
    },
    {
      name: "evm_get_balance",
      description:
        "Gets ETH or ERC20 balance. Omit tokenAddress for ETH balance.",
      inputSchema: {
        type: "object",
        properties: {
          address: { type: "string", description: "Address to check" },
          tokenAddress: {
            type: "string",
            description:
              "ERC20 token contract address (omit for native ETH balance)",
          },
        },
        required: ["address"],
      },
      handler: async (input: { address: string; tokenAddress?: string }) => {
        try {
          return await getAnvil().getBalance(input.address, input.tokenAddress)
        } catch (e: any) {
          return toolError("GET_BALANCE_FAILED", e.message)
        }
      },
    },
    {
      name: "evm_advance_time",
      description:
        "Advances the block timestamp by the specified number of seconds and mines a new block.",
      inputSchema: {
        type: "object",
        properties: {
          seconds: {
            type: "number",
            description: "Number of seconds to advance",
          },
        },
        required: ["seconds"],
      },
      handler: async (input: { seconds: number }) => {
        try {
          return await getAnvil().advanceTime(input.seconds)
        } catch (e: any) {
          return toolError("ADVANCE_TIME_FAILED", e.message)
        }
      },
    },
    {
      name: "evm_mine_block",
      description: "Forces new block(s) to be mined on the devnet.",
      inputSchema: {
        type: "object",
        properties: {
          count: {
            type: "number",
            description: "Number of blocks to mine (default: 1)",
          },
        },
        required: [],
      },
      handler: async (input: { count?: number }) => {
        try {
          return await getAnvil().mineBlock(input.count ?? 1)
        } catch (e: any) {
          return toolError("MINE_BLOCK_FAILED", e.message)
        }
      },
    },
    {
      name: "evm_impersonate_account",
      description:
        "Impersonates any address on the devnet. Useful for testing admin functions or simulating whale behavior. The impersonated account is funded with 10 ETH.",
      inputSchema: {
        type: "object",
        properties: {
          address: { type: "string", description: "Address to impersonate" },
        },
        required: ["address"],
      },
      handler: async (input: { address: string }) => {
        try {
          await getAnvil().impersonateAccount(input.address)
          return { success: true, address: input.address }
        } catch (e: any) {
          return toolError("IMPERSONATE_FAILED", e.message)
        }
      },
    },
    {
      name: "evm_stop_impersonating",
      description: "Stops impersonating an account on the devnet.",
      inputSchema: {
        type: "object",
        properties: {
          address: {
            type: "string",
            description: "Address to stop impersonating",
          },
        },
        required: ["address"],
      },
      handler: async (input: { address: string }) => {
        try {
          await getAnvil().stopImpersonating(input.address)
          return { success: true, address: input.address }
        } catch (e: any) {
          return toolError("STOP_IMPERSONATING_FAILED", e.message)
        }
      },
    },
    {
      name: "evm_call",
      description:
        "Makes a read-only eth_call to a contract. Data must be ABI-encoded calldata (hex).",
      inputSchema: {
        type: "object",
        properties: {
          to: { type: "string", description: "Contract address" },
          data: {
            type: "string",
            description: "ABI-encoded calldata (hex string starting with 0x)",
          },
          from: {
            type: "string",
            description: "Sender address (optional)",
          },
        },
        required: ["to", "data"],
      },
      handler: async (input: { to: string; data: string; from?: string }) => {
        try {
          return await getAnvil().call(input.to, input.data, input.from)
        } catch (e: any) {
          return toolError("CALL_FAILED", e.message)
        }
      },
    },
    {
      name: "evm_get_transaction",
      description:
        "Gets a transaction receipt including status, gas used, logs, and revert reason if applicable.",
      inputSchema: {
        type: "object",
        properties: {
          txHash: { type: "string", description: "Transaction hash" },
        },
        required: ["txHash"],
      },
      handler: async (input: { txHash: string }) => {
        try {
          return await getAnvil().getTransaction(input.txHash)
        } catch (e: any) {
          return toolError("GET_TRANSACTION_FAILED", e.message)
        }
      },
    },
    {
      name: "evm_snapshot",
      description:
        "Takes an Anvil state snapshot. Returns a snapshotId that can be used with evm_revert to restore the state later.",
      inputSchema: {
        type: "object",
        properties: {},
        required: [],
      },
      handler: async () => {
        try {
          return await getAnvil().snapshot()
        } catch (e: any) {
          return toolError("SNAPSHOT_FAILED", e.message)
        }
      },
    },
    {
      name: "evm_revert",
      description:
        "Reverts Anvil state to a previously taken snapshot.",
      inputSchema: {
        type: "object",
        properties: {
          snapshotId: {
            type: "string",
            description: "Snapshot ID returned by evm_snapshot",
          },
        },
        required: ["snapshotId"],
      },
      handler: async (input: { snapshotId: string }) => {
        try {
          return await getAnvil().revert(input.snapshotId)
        } catch (e: any) {
          return toolError("REVERT_FAILED", e.message)
        }
      },
    },
    {
      name: "evm_reset",
      description:
        "Resets Anvil to its initial state (or re-forks from the fork URL if applicable).",
      inputSchema: {
        type: "object",
        properties: {},
        required: [],
      },
      handler: async () => {
        try {
          await getAnvil().reset()
          return { success: true }
        } catch (e: any) {
          return toolError("RESET_FAILED", e.message)
        }
      },
    },
  ]

  for (const tool of tools) {
    registry.register(tool)
  }
}
