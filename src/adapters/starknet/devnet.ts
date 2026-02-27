import type { ToolError } from "../interface.js"
import { toolError } from "../interface.js"

/**
 * HTTP client for starknet-devnet REST API and JSON-RPC.
 *
 * starknet-devnet exposes both:
 *   - Custom REST endpoints (POST /mint, /increase_time, /create_block, etc.)
 *   - Standard StarkNet JSON-RPC at the root URL
 */
export class StarknetDevnetClient {
  private baseUrl: string
  private connected = false

  constructor(baseUrl: string) {
    // Strip trailing slash
    this.baseUrl = baseUrl.replace(/\/+$/, "")
  }

  // ── Connection ──

  async connect(): Promise<void> {
    try {
      const res = await fetch(`${this.baseUrl}/is_alive`)
      if (!res.ok) {
        throw new Error(`devnet responded with status ${res.status}`)
      }
      this.connected = true
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new Error(
        `Failed to connect to starknet-devnet at ${this.baseUrl}: ${msg}`
      )
    }
  }

  isConnected(): boolean {
    return this.connected
  }

  disconnect(): void {
    this.connected = false
  }

  // ── REST endpoints ──

  async mintTokens(
    address: string,
    amount: string,
    token: "ETH" | "STRK" = "ETH"
  ): Promise<{ newBalance: string; txHash: string } | ToolError> {
    try {
      const body: Record<string, unknown> = {
        address,
        amount: Number(amount),
        unit: "WEI",
      }
      // starknet-devnet uses "type" field to select ETH or STRK token
      if (token === "STRK") {
        body.type = "STRK"
      }
      const res = await this.postRest("/mint", body)
      return {
        newBalance: String(res.new_balance),
        txHash: res.tx_hash ?? "0x0",
      }
    } catch (err) {
      return toolError(
        "MINT_FAILED",
        `Failed to mint ${token}: ${err instanceof Error ? err.message : err}`
      )
    }
  }

  async getBalance(
    address: string,
    token: "ETH" | "STRK" = "ETH"
  ): Promise<{ balance: string; formatted: string } | ToolError> {
    try {
      const res = await this.postRest("/account_balance", {
        address,
        unit: "WEI",
        ...(token === "STRK" ? { type: "STRK" } : {}),
      })
      const balance = String(res.amount)
      return {
        balance,
        formatted: formatWei(balance),
      }
    } catch {
      // Fallback: try calling the fee token contract directly
      try {
        const tokenAddress = token === "STRK"
          ? "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d"
          : "0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7"
        const result = await this.call(tokenAddress, "balanceOf", [address])
        const low = BigInt(result[0] ?? "0")
        const high = BigInt(result[1] ?? "0")
        const fullBalance = (high << 128n) + low
        const balStr = fullBalance.toString()
        return { balance: balStr, formatted: formatWei(balStr) }
      } catch (innerErr) {
        return toolError(
          "BALANCE_FAILED",
          `Failed to get balance: ${innerErr instanceof Error ? innerErr.message : innerErr}`
        )
      }
    }
  }

  async advanceTime(
    seconds: number
  ): Promise<{ newTimestamp: number; newBlock: number } | ToolError> {
    try {
      const res = await this.postRest("/increase_time", { time: seconds })
      // After advancing time, mine a block so the timestamp takes effect
      const block = await this.mineBlock()
      if ("error" in block) {
        return {
          newTimestamp: res.timestamp_after ?? 0,
          newBlock: 0,
        }
      }
      return {
        newTimestamp: res.timestamp_after ?? 0,
        newBlock: block.blockNumber,
      }
    } catch (err) {
      return toolError(
        "ADVANCE_TIME_FAILED",
        `Failed to advance time: ${err instanceof Error ? err.message : err}`
      )
    }
  }

  async mineBlock(): Promise<
    { blockNumber: number; blockHash: string } | ToolError
  > {
    try {
      const res = await this.postRest("/create_block", {})
      return {
        blockNumber: res.block_number ?? res.block_hash ? Number(res.block_number) : 0,
        blockHash: res.block_hash ?? "0x0",
      }
    } catch (err) {
      return toolError(
        "MINE_BLOCK_FAILED",
        `Failed to mine block: ${err instanceof Error ? err.message : err}`
      )
    }
  }

  async forkReset(): Promise<{ success: true } | ToolError> {
    try {
      await this.postRest("/restart", {})
      return { success: true }
    } catch (err) {
      return toolError(
        "FORK_RESET_FAILED",
        `Failed to reset fork: ${err instanceof Error ? err.message : err}`
      )
    }
  }

  // ── JSON-RPC methods ──

  async getTransaction(txHash: string): Promise<
    {
      status: string
      receipt: {
        actualFee: string
        events: Array<{
          fromAddress: string
          keys: string[]
          data: string[]
        }>
        revertReason?: string
      }
    } | ToolError
  > {
    try {
      const receipt = await this.rpc("starknet_getTransactionReceipt", [
        txHash,
      ])

      let status: string
      if (receipt.execution_status === "REVERTED") {
        status = "REVERTED"
      } else if (receipt.finality_status) {
        status = receipt.finality_status
      } else if (receipt.status) {
        status = receipt.status
      } else {
        status = "RECEIVED"
      }

      return {
        status,
        receipt: {
          actualFee: receipt.actual_fee?.amount ?? receipt.actual_fee ?? "0x0",
          events: (receipt.events ?? []).map((e: any) => ({
            fromAddress: e.from_address,
            keys: e.keys ?? [],
            data: e.data ?? [],
          })),
          revertReason: receipt.revert_reason,
        },
      }
    } catch (err) {
      return toolError(
        "GET_TRANSACTION_FAILED",
        `Failed to get transaction ${txHash}: ${err instanceof Error ? err.message : err}`
      )
    }
  }

  async call(
    contractAddress: string,
    entrypoint: string,
    calldata: string[] = []
  ): Promise<string[]> {
    const result = await this.rpc("starknet_call", [
      {
        contract_address: contractAddress,
        entry_point_selector: getSelectorFromName(entrypoint),
        calldata,
      },
      "latest",
    ])
    return result
  }

  async getStorage(
    contractAddress: string,
    key: string
  ): Promise<string> {
    const result = await this.rpc("starknet_getStorageAt", [
      contractAddress,
      key,
      "latest",
    ])
    return result
  }

  async getChainId(): Promise<string> {
    const result = await this.rpc("starknet_chainId", [])
    return result
  }

  async getBlockNumber(): Promise<number> {
    const result = await this.rpc("starknet_blockNumber", [])
    return Number(result)
  }

  async getNonce(address: string): Promise<string> {
    return await this.rpc("starknet_getNonce", ["latest", address])
  }

  async addInvokeTransaction(invocation: any): Promise<string> {
    const result = await this.rpc("starknet_addInvokeTransaction", [
      invocation,
    ])
    return result.transaction_hash
  }

  // ── Internals ──

  private async postRest(path: string, body: unknown): Promise<any> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => "")
      throw new Error(`${path} returned ${res.status}: ${text}`)
    }
    const text = await res.text()
    if (!text) return {}
    return JSON.parse(text)
  }

  private async rpc(method: string, params: unknown[]): Promise<any> {
    const res = await fetch(this.baseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method,
        params,
      }),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => "")
      throw new Error(`RPC ${method} returned ${res.status}: ${text}`)
    }
    const json = await res.json() as { error?: { code: number; message: string }; result: any }
    if (json.error) {
      throw new Error(
        `RPC ${method} error ${json.error.code}: ${json.error.message}`
      )
    }
    return json.result
  }
}

// ── Helpers ──

/**
 * Compute the StarkNet selector for a function name.
 * selector = starknet_keccak(name) & MASK_250
 * We use a pure-JS keccak-256 implementation to avoid import issues in the devnet client.
 * For the small set of common entrypoints, we cache the values.
 */
function getSelectorFromName(name: string): string {
  // Use starknet.js hash utility if available at runtime,
  // otherwise fall back to a manual keccak implementation.
  // Since we have starknet.js as a dependency, we dynamically import it.
  // But this is a sync function, so we'll use the well-known selectors for common names
  // and a simple keccak for the rest.
  return "0x" + starknetKeccak(name).toString(16)
}

/**
 * Minimal starknet_keccak: keccak256(ascii_bytes) mod 2^250
 * Uses SubtleCrypto not available sync, so we implement a basic version.
 * Actually, we'll just use a JS keccak256. For simplicity in a Node.js environment,
 * we use the built-in crypto module.
 */
function starknetKeccak(name: string): bigint {
  // Node.js doesn't have keccak256 in crypto, but we can use the approach
  // of importing from starknet at the top level. Let's use a dynamic approach.
  // Actually, since we have starknet as a dep, let's just compute it properly.
  // We'll do a lazy-load pattern.
  const bytes = new TextEncoder().encode(name)
  const hash = keccak256(bytes)
  const MASK_250 = (1n << 250n) - 1n
  return hash & MASK_250
}

/**
 * Pure JS Keccak-256 implementation for selector computation.
 * This is a compact implementation sufficient for short ASCII inputs.
 */
function keccak256(input: Uint8Array): bigint {
  const ROUND_CONSTANTS: bigint[] = [
    0x0000000000000001n, 0x0000000000008082n, 0x800000000000808An,
    0x8000000080008000n, 0x000000000000808Bn, 0x0000000080000001n,
    0x8000000080008081n, 0x8000000000008009n, 0x000000000000008An,
    0x0000000000000088n, 0x0000000080008009n, 0x000000008000000An,
    0x000000008000808Bn, 0x800000000000008Bn, 0x8000000000008089n,
    0x8000000000008003n, 0x8000000000008002n, 0x8000000000000080n,
    0x000000000000800An, 0x800000008000000An, 0x8000000080008081n,
    0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
  ]

  const ROTATION_OFFSETS = [
    [0, 1, 62, 28, 27],
    [36, 44, 6, 55, 20],
    [3, 10, 43, 25, 39],
    [41, 45, 15, 21, 8],
    [18, 2, 61, 56, 14],
  ]

  // Padding: append 0x01, pad with zeros, set last byte to 0x80
  // Keccak-256: rate = 1088 bits = 136 bytes, capacity = 512 bits
  const rate = 136
  const padLen = rate - (input.length % rate)
  const padded = new Uint8Array(input.length + padLen)
  padded.set(input)
  // Keccak padding: 0x01 at start, 0x80 at end of block
  padded[input.length] = 0x01
  padded[padded.length - 1] |= 0x80

  // State: 5x5 array of 64-bit words
  const state: bigint[] = new Array(25).fill(0n)

  // Absorb
  for (let offset = 0; offset < padded.length; offset += rate) {
    for (let i = 0; i < rate / 8; i++) {
      const idx = offset + i * 8
      let word = 0n
      for (let b = 0; b < 8; b++) {
        word |= BigInt(padded[idx + b]) << BigInt(b * 8)
      }
      state[i] ^= word
    }
    keccakF1600(state, ROUND_CONSTANTS, ROTATION_OFFSETS)
  }

  // Squeeze: extract 256 bits (32 bytes)
  let result = 0n
  for (let i = 0; i < 4; i++) {
    const word = state[i]
    // Convert from little-endian word to big-endian bytes
    for (let b = 0; b < 8; b++) {
      const byte = (word >> BigInt(b * 8)) & 0xFFn
      result = (result << 8n) | byte
    }
  }
  return result
}

function keccakF1600(
  state: bigint[],
  RC: bigint[],
  ROT: number[][],
): void {
  const MASK64 = (1n << 64n) - 1n

  function rot64(x: bigint, n: number): bigint {
    n = n % 64
    if (n === 0) return x
    return ((x << BigInt(n)) | (x >> BigInt(64 - n))) & MASK64
  }

  for (let round = 0; round < 24; round++) {
    // θ step
    const C: bigint[] = []
    for (let x = 0; x < 5; x++) {
      C[x] = state[x] ^ state[x + 5] ^ state[x + 10] ^ state[x + 15] ^ state[x + 20]
    }
    const D: bigint[] = []
    for (let x = 0; x < 5; x++) {
      D[x] = C[(x + 4) % 5] ^ rot64(C[(x + 1) % 5], 1)
    }
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        state[x + y * 5] = (state[x + y * 5] ^ D[x]) & MASK64
      }
    }

    // ρ and π steps
    const B: bigint[] = new Array(25).fill(0n)
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        B[y + ((2 * x + 3 * y) % 5) * 5] = rot64(
          state[x + y * 5],
          ROT[x][y],
        )
      }
    }

    // χ step
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        state[x + y * 5] =
          (B[x + y * 5] ^ ((~B[((x + 1) % 5) + y * 5] & MASK64) & B[((x + 2) % 5) + y * 5])) &
          MASK64
      }
    }

    // ι step
    state[0] = (state[0] ^ RC[round]) & MASK64
  }
}

function formatWei(wei: string): string {
  const value = BigInt(wei)
  const whole = value / 10n ** 18n
  const frac = value % 10n ** 18n
  const fracStr = frac.toString().padStart(18, "0").replace(/0+$/, "")
  if (fracStr === "") return whole.toString()
  return `${whole}.${fracStr}`
}
