import type { ToolDefinition, ToolRegistry } from "../interface.js"
import { toolError } from "../interface.js"
import type { StarkNetAdapter } from "./index.js"

/**
 * Registers all StarkNet-specific MCP tools plus the shared wallet control tools.
 */
export function registerStarknetTools(
  registry: ToolRegistry,
  adapter: StarkNetAdapter,
): void {
  // ── Shared wallet tools ──

  registry.register({
    name: "wallet_connect",
    description:
      "Connect the test wallet to the DApp. Optionally specify an account address or label.",
    inputSchema: {
      type: "object",
      properties: {
        account: {
          type: "string",
          description:
            "Account address or label to connect. If omitted, the first configured account is used.",
        },
      },
    },
    handler: async (input: { account?: string }) => {
      try {
        return await adapter.connect(input.account)
      } catch (err) {
        return toolError(
          "CONNECT_FAILED",
          `Failed to connect wallet: ${err instanceof Error ? err.message : err}`,
        )
      }
    },
  })

  registry.register({
    name: "wallet_disconnect",
    description: "Disconnect the test wallet from the DApp.",
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      try {
        await adapter.disconnect()
        return { success: true }
      } catch (err) {
        return toolError(
          "DISCONNECT_FAILED",
          `Failed to disconnect: ${err instanceof Error ? err.message : err}`,
        )
      }
    },
  })

  registry.register({
    name: "wallet_switch_account",
    description:
      "Switch the active wallet account. Accepts an address or a configured account label (e.g. 'borrower').",
    inputSchema: {
      type: "object",
      properties: {
        address: {
          type: "string",
          description: "Account address or label to switch to.",
        },
      },
      required: ["address"],
    },
    handler: async (input: { address: string }) => {
      try {
        await adapter.switchAccount(input.address)
        const state = adapter.getWalletState()
        return {
          activeAccount: state.activeAccount,
          chainId: state.chainId,
        }
      } catch (err) {
        return toolError(
          "SWITCH_ACCOUNT_FAILED",
          `Failed to switch account: ${err instanceof Error ? err.message : err}`,
        )
      }
    },
  })

  registry.register({
    name: "wallet_set_auto_approve",
    description:
      "Enable or disable automatic transaction approval. When enabled, all transactions are approved without needing explicit wallet_approve_transaction calls.",
    inputSchema: {
      type: "object",
      properties: {
        enabled: {
          type: "boolean",
          description: "Set to true to auto-approve all transactions.",
        },
      },
      required: ["enabled"],
    },
    handler: async (input: { enabled: boolean }) => {
      adapter.setAutoApprove(input.enabled)
      return { autoApprove: input.enabled }
    },
  })

  registry.register({
    name: "wallet_approve_transaction",
    description:
      "Approve the currently pending transaction. Only works when autoApprove is disabled and a transaction is pending.",
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      try {
        return await adapter.approveTransaction()
      } catch (err) {
        return toolError(
          "APPROVE_FAILED",
          `Failed to approve transaction: ${err instanceof Error ? err.message : err}`,
        )
      }
    },
  })

  registry.register({
    name: "wallet_reject_transaction",
    description: "Reject the currently pending transaction with an optional reason.",
    inputSchema: {
      type: "object",
      properties: {
        reason: {
          type: "string",
          description: "Optional reason for rejecting the transaction.",
        },
      },
    },
    handler: async (input: { reason?: string }) => {
      try {
        await adapter.rejectTransaction(input.reason)
        return { success: true }
      } catch (err) {
        return toolError(
          "REJECT_FAILED",
          `Failed to reject transaction: ${err instanceof Error ? err.message : err}`,
        )
      }
    },
  })

  registry.register({
    name: "wallet_get_state",
    description: "Get the current wallet state including connection status, active account, chain ID, and pending transaction info.",
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      return adapter.getWalletState()
    },
  })

  registry.register({
    name: "wallet_get_pending_transaction",
    description: "Get the currently pending transaction payload, if one exists.",
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      const pending = adapter.getPendingTransaction()
      if (!pending) {
        return { pending: false, transaction: null }
      }
      return { pending: true, transaction: pending }
    },
  })

  // ── StarkNet-specific tools ──

  registry.register({
    name: "starknet_mint_tokens",
    description:
      "Mint ETH or STRK tokens to a test account on the StarkNet devnet. The amount is specified in wei (1 ETH = 10^18 wei).",
    inputSchema: {
      type: "object",
      properties: {
        address: {
          type: "string",
          description: "Account address or label to mint tokens to.",
        },
        amount: {
          type: "string",
          description: "Amount in wei as a decimal string (e.g. '1000000000000000000' for 1 ETH).",
        },
        token: {
          type: "string",
          enum: ["ETH", "STRK"],
          description: "Token to mint. Defaults to ETH.",
        },
      },
      required: ["address", "amount"],
    },
    handler: async (input: {
      address: string
      amount: string
      token?: "ETH" | "STRK"
    }) => {
      const address = adapter.resolveAddress(input.address)
      return await adapter.devnet.mintTokens(
        address,
        input.amount,
        input.token ?? "ETH",
      )
    },
  })

  registry.register({
    name: "starknet_get_balance",
    description:
      "Get the ETH or STRK balance of an address on the StarkNet devnet.",
    inputSchema: {
      type: "object",
      properties: {
        address: {
          type: "string",
          description: "Account address or label.",
        },
        token: {
          type: "string",
          enum: ["ETH", "STRK"],
          description: "Token to check balance of. Defaults to ETH.",
        },
      },
      required: ["address"],
    },
    handler: async (input: { address: string; token?: "ETH" | "STRK" }) => {
      const address = adapter.resolveAddress(input.address)
      return await adapter.devnet.getBalance(address, input.token ?? "ETH")
    },
  })

  registry.register({
    name: "starknet_advance_time",
    description:
      "Advance the devnet block timestamp by a number of seconds. Useful for testing time-dependent logic like loan expiry, vesting schedules, or liquidation windows.",
    inputSchema: {
      type: "object",
      properties: {
        seconds: {
          type: "number",
          description: "Number of seconds to advance.",
        },
      },
      required: ["seconds"],
    },
    handler: async (input: { seconds: number }) => {
      return await adapter.devnet.advanceTime(input.seconds)
    },
  })

  registry.register({
    name: "starknet_mine_block",
    description:
      "Force the devnet to mine a new block immediately. Useful when devnet is in interval mining mode.",
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      return await adapter.devnet.mineBlock()
    },
  })

  registry.register({
    name: "starknet_get_transaction",
    description:
      "Get the status and receipt of a transaction by its hash.",
    inputSchema: {
      type: "object",
      properties: {
        txHash: {
          type: "string",
          description: "The transaction hash.",
        },
      },
      required: ["txHash"],
    },
    handler: async (input: { txHash: string }) => {
      return await adapter.devnet.getTransaction(input.txHash)
    },
  })

  registry.register({
    name: "starknet_call",
    description:
      "Make a read-only contract call directly through the devnet RPC, bypassing the browser. Useful for asserting on-chain state.",
    inputSchema: {
      type: "object",
      properties: {
        contractAddress: {
          type: "string",
          description: "The contract address to call.",
        },
        entrypoint: {
          type: "string",
          description: "The function name to call (e.g. 'balanceOf', 'get_owner').",
        },
        calldata: {
          type: "array",
          items: { type: "string" },
          description: "Array of calldata arguments as hex strings. Defaults to empty.",
        },
      },
      required: ["contractAddress", "entrypoint"],
    },
    handler: async (input: {
      contractAddress: string
      entrypoint: string
      calldata?: string[]
    }) => {
      try {
        const result = await adapter.devnet.call(
          input.contractAddress,
          input.entrypoint,
          input.calldata ?? [],
        )
        return { result }
      } catch (err) {
        return toolError(
          "CALL_FAILED",
          `Contract call failed: ${err instanceof Error ? err.message : err}`,
        )
      }
    },
  })

  registry.register({
    name: "starknet_deploy_account",
    description:
      "Deploy a test account contract on the devnet. Devnet pre-deployed accounts are already deployed; use this for custom accounts.",
    inputSchema: {
      type: "object",
      properties: {
        address: {
          type: "string",
          description: "Address or label of a configured account to deploy.",
        },
      },
      required: ["address"],
    },
    handler: async (input: { address: string }) => {
      try {
        const resolved = adapter.resolveAddress(input.address)
        const accountConfig = adapter.getAccountConfig(resolved)
        if (!accountConfig) {
          return toolError(
            "ACCOUNT_NOT_FOUND",
            `No configured account matching "${input.address}". Check your adapter config.`,
          )
        }

        // Use starknet.js Account to deploy
        const { Account, RpcProvider } = await import("starknet")
        const provider = new RpcProvider({ nodeUrl: adapter.devnetUrl })
        const account = new Account(
          provider,
          accountConfig.address,
          accountConfig.privateKey,
        )

        // Try to get nonce to check if already deployed
        try {
          await provider.getNonceForAddress(accountConfig.address)
          return {
            address: accountConfig.address,
            alreadyDeployed: true,
            message: "Account is already deployed.",
          }
        } catch {
          // Not deployed yet, proceed with deployment
        }

        // Deploy account using DEPLOY_ACCOUNT transaction
        const deployResult = await account.deployAccount({
          classHash:
            "0x061dac032f228abef9c6626f995015233097ae253a7f72d68552db02f2971b8f",
          constructorCalldata: [],
          addressSalt: "0x0",
        })

        return {
          address: accountConfig.address,
          txHash: deployResult.transaction_hash,
          alreadyDeployed: false,
        }
      } catch (err) {
        return toolError(
          "DEPLOY_ACCOUNT_FAILED",
          `Failed to deploy account: ${err instanceof Error ? err.message : err}`,
        )
      }
    },
  })

  registry.register({
    name: "starknet_get_storage",
    description:
      "Read raw contract storage at a given key.",
    inputSchema: {
      type: "object",
      properties: {
        contractAddress: {
          type: "string",
          description: "The contract address.",
        },
        key: {
          type: "string",
          description: "The storage key (felt as hex string).",
        },
      },
      required: ["contractAddress", "key"],
    },
    handler: async (input: { contractAddress: string; key: string }) => {
      try {
        const value = await adapter.devnet.getStorage(
          input.contractAddress,
          input.key,
        )
        return { value }
      } catch (err) {
        return toolError(
          "GET_STORAGE_FAILED",
          `Failed to read storage: ${err instanceof Error ? err.message : err}`,
        )
      }
    },
  })

  registry.register({
    name: "starknet_fork_reset",
    description:
      "Reset the devnet to its initial state (or forked block if started in fork mode). Useful for resetting between test scenarios.",
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      return await adapter.devnet.forkReset()
    },
  })
}
