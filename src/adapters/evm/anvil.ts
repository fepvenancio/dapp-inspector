import { formatEther, parseEther, toHex, encodeFunctionData, decodeFunctionResult } from "viem"

const ERC20_BALANCE_OF_ABI = [
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const

const ERC20_TRANSFER_ABI = [
  {
    name: "transfer",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const

const ERC20_DECIMALS_ABI = [
  {
    name: "decimals",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
] as const

export class AnvilClient {
  private url: string
  private chainId: number | null = null
  private requestId = 0

  constructor(url: string) {
    this.url = url
  }

  async connect(): Promise<{ chainId: number }> {
    const result = await this.rpc("eth_chainId", [])
    this.chainId = parseInt(result, 16)
    return { chainId: this.chainId }
  }

  getChainId(): number {
    if (this.chainId === null) {
      throw new Error("AnvilClient not connected. Call connect() first.")
    }
    return this.chainId
  }

  async mintEth(address: string, amount: string): Promise<{ newBalance: string }> {
    const wei = parseEther(amount)
    await this.rpc("anvil_setBalance", [address, toHex(wei)])
    const balanceHex = await this.rpc("eth_getBalance", [address, "latest"])
    return { newBalance: balanceHex }
  }

  async mintErc20(
    tokenAddress: string,
    toAddress: string,
    amount: string,
  ): Promise<{ success: boolean }> {
    // Get token decimals
    const decimalsData = encodeFunctionData({
      abi: ERC20_DECIMALS_ABI,
      functionName: "decimals",
    })
    const decimalsResult = await this.rpc("eth_call", [
      { to: tokenAddress, data: decimalsData },
      "latest",
    ])
    const decimals = decodeFunctionResult({
      abi: ERC20_DECIMALS_ABI,
      functionName: "decimals",
      data: decimalsResult as `0x${string}`,
    })

    // Parse amount with correct decimals
    const rawAmount = BigInt(
      Math.floor(parseFloat(amount) * 10 ** Number(decimals)),
    )

    // Impersonate the token contract itself to mint via direct storage manipulation
    // First, fund the token contract address so it can send txs
    await this.rpc("anvil_setBalance", [tokenAddress, toHex(parseEther("1"))])

    // Impersonate the token contract
    await this.rpc("anvil_impersonateAccount", [tokenAddress])

    try {
      // Transfer tokens from the token contract to the target
      const transferData = encodeFunctionData({
        abi: ERC20_TRANSFER_ABI,
        functionName: "transfer",
        args: [toAddress as `0x${string}`, rawAmount],
      })

      await this.rpc("eth_sendTransaction", [
        {
          from: tokenAddress,
          to: tokenAddress,
          data: transferData,
        },
      ])
    } finally {
      await this.rpc("anvil_stopImpersonatingAccount", [tokenAddress])
    }

    return { success: true }
  }

  async getBalance(
    address: string,
    tokenAddress?: string,
  ): Promise<{ balance: string; formatted: string }> {
    if (!tokenAddress) {
      const balanceHex = await this.rpc("eth_getBalance", [address, "latest"])
      const balanceWei = BigInt(balanceHex)
      return {
        balance: balanceHex,
        formatted: formatEther(balanceWei) + " ETH",
      }
    }

    // ERC20 balance
    const data = encodeFunctionData({
      abi: ERC20_BALANCE_OF_ABI,
      functionName: "balanceOf",
      args: [address as `0x${string}`],
    })

    const result = await this.rpc("eth_call", [
      { to: tokenAddress, data },
      "latest",
    ])

    // Get decimals
    const decimalsData = encodeFunctionData({
      abi: ERC20_DECIMALS_ABI,
      functionName: "decimals",
    })
    let decimals = 18
    try {
      const decimalsResult = await this.rpc("eth_call", [
        { to: tokenAddress, data: decimalsData },
        "latest",
      ])
      decimals = Number(
        decodeFunctionResult({
          abi: ERC20_DECIMALS_ABI,
          functionName: "decimals",
          data: decimalsResult as `0x${string}`,
        }),
      )
    } catch {
      // Default to 18 if decimals() call fails
    }

    const rawBalance = BigInt(result)
    const formatted = (Number(rawBalance) / 10 ** decimals).toString()

    return {
      balance: toHex(rawBalance),
      formatted: formatted + " tokens",
    }
  }

  async advanceTime(seconds: number): Promise<{ newTimestamp: number }> {
    await this.rpc("evm_increaseTime", [toHex(seconds)])
    await this.rpc("evm_mine", [])
    // Get the new block timestamp
    const block = await this.rpc("eth_getBlockByNumber", ["latest", false])
    return { newTimestamp: parseInt(block.timestamp, 16) }
  }

  async mineBlock(count: number = 1): Promise<{ blockNumber: number }> {
    for (let i = 0; i < count; i++) {
      await this.rpc("evm_mine", [])
    }
    const blockNumHex = await this.rpc("eth_blockNumber", [])
    return { blockNumber: parseInt(blockNumHex, 16) }
  }

  async impersonateAccount(address: string): Promise<void> {
    await this.rpc("anvil_impersonateAccount", [address])
    // Fund the impersonated account so it can send txs
    await this.rpc("anvil_setBalance", [address, toHex(parseEther("10"))])
  }

  async stopImpersonating(address: string): Promise<void> {
    await this.rpc("anvil_stopImpersonatingAccount", [address])
  }

  async call(to: string, data: string, from?: string): Promise<{ result: string }> {
    const callObj: Record<string, string> = { to, data }
    if (from) callObj.from = from
    const result = await this.rpc("eth_call", [callObj, "latest"])
    return { result }
  }

  async getTransaction(txHash: string): Promise<{
    status: "pending" | "success" | "reverted"
    blockNumber: number
    gasUsed: string
    logs: Array<{ address: string; topics: string[]; data: string }>
    revertReason?: string
  }> {
    const receipt = await this.rpc("eth_getTransactionReceipt", [txHash])

    if (!receipt) {
      return {
        status: "pending",
        blockNumber: 0,
        gasUsed: "0x0",
        logs: [],
      }
    }

    const status = receipt.status === "0x1" ? "success" : "reverted"
    const logs = (receipt.logs || []).map(
      (log: { address: string; topics: string[]; data: string }) => ({
        address: log.address,
        topics: log.topics,
        data: log.data,
      }),
    )

    const result: {
      status: "pending" | "success" | "reverted"
      blockNumber: number
      gasUsed: string
      logs: Array<{ address: string; topics: string[]; data: string }>
      revertReason?: string
    } = {
      status,
      blockNumber: parseInt(receipt.blockNumber, 16),
      gasUsed: receipt.gasUsed,
      logs,
    }

    // Attempt to decode revert reason if transaction reverted
    if (status === "reverted") {
      try {
        const tx = await this.rpc("eth_getTransactionByHash", [txHash])
        if (tx) {
          const callResult = await this.rpc("eth_call", [
            { from: tx.from, to: tx.to, data: tx.input, value: tx.value },
            receipt.blockNumber,
          ]).catch((e: Error) => e.message)
          if (typeof callResult === "string" && callResult.includes("revert")) {
            result.revertReason = callResult
          }
        }
      } catch {
        // Could not decode revert reason
      }
    }

    return result
  }

  async snapshot(): Promise<{ snapshotId: string }> {
    const snapshotId = await this.rpc("evm_snapshot", [])
    return { snapshotId }
  }

  async revert(snapshotId: string): Promise<{ success: boolean }> {
    const success = await this.rpc("evm_revert", [snapshotId])
    return { success: Boolean(success) }
  }

  async reset(): Promise<void> {
    await this.rpc("anvil_reset", [])
  }

  async rpc(method: string, params: unknown[] = []): Promise<any> {
    this.requestId++
    const response = await fetch(this.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: this.requestId,
        method,
        params,
      }),
    })

    if (!response.ok) {
      throw new Error(`Anvil RPC error: HTTP ${response.status} ${response.statusText}`)
    }

    const json: any = await response.json()
    if (json.error) {
      throw new Error(`Anvil RPC error: ${json.error.message || JSON.stringify(json.error)}`)
    }

    return json.result
  }
}
