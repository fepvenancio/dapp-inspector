import {
  Connection,
  Keypair,
  PublicKey,
  LAMPORTS_PER_SOL,
  type Commitment,
} from "@solana/web3.js"
import {
  createMint as splCreateMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  getAccount,
  getMint,
} from "@solana/spl-token"
import type { SolanaAdapterConfig } from "../../config/schema.js"
import { toolError, type ToolError } from "../interface.js"

export class SolanaValidatorClient {
  private connection: Connection | null = null
  private commitment: Commitment = "confirmed"
  private rpcUrl = "http://localhost:8899"

  async connect(config: SolanaAdapterConfig): Promise<void> {
    this.rpcUrl = config.devnetUrl ?? "http://localhost:8899"
    this.commitment = config.commitment ?? "confirmed"
    const wsUrl = config.wsUrl ?? "ws://localhost:8900"

    this.connection = new Connection(this.rpcUrl, {
      commitment: this.commitment,
      wsEndpoint: wsUrl,
    })

    // Verify the validator is reachable
    try {
      await this.connection.getVersion()
    } catch (err: any) {
      throw new Error(
        `Cannot connect to Solana validator at ${this.rpcUrl}: ${err.message}. ` +
          `Make sure solana-test-validator is running.`,
      )
    }
  }

  getConnection(): Connection {
    if (!this.connection) {
      throw new Error("Validator client not connected. Call connect() first.")
    }
    return this.connection
  }

  async airdrop(
    address: string,
    amountSol: number,
  ): Promise<{ signature: string; newBalance: number }> {
    const conn = this.getConnection()
    const pubkey = new PublicKey(address)
    const lamports = amountSol * LAMPORTS_PER_SOL

    const signature = await conn.requestAirdrop(pubkey, lamports)
    await conn.confirmTransaction(signature, this.commitment)

    const newBalance = await conn.getBalance(pubkey)
    return {
      signature,
      newBalance: newBalance / LAMPORTS_PER_SOL,
    }
  }

  async getBalance(
    address: string,
    mintAddress?: string,
  ): Promise<{ balance: number; formatted: string }> {
    const conn = this.getConnection()
    const pubkey = new PublicKey(address)

    if (!mintAddress) {
      const lamports = await conn.getBalance(pubkey)
      const sol = lamports / LAMPORTS_PER_SOL
      return { balance: sol, formatted: `${sol} SOL` }
    }

    // SPL token balance
    const mintPubkey = new PublicKey(mintAddress)
    const mintInfo = await getMint(conn, mintPubkey)

    // Find the associated token account
    const tokenAccounts = await conn.getTokenAccountsByOwner(pubkey, {
      mint: mintPubkey,
    })

    if (tokenAccounts.value.length === 0) {
      return { balance: 0, formatted: `0 (no token account)` }
    }

    const tokenAccountInfo = await getAccount(
      conn,
      tokenAccounts.value[0].pubkey,
    )
    const rawBalance = Number(tokenAccountInfo.amount)
    const decimals = mintInfo.decimals
    const formatted = rawBalance / Math.pow(10, decimals)
    return { balance: formatted, formatted: `${formatted}` }
  }

  async mintSplTokens(
    mintAddress: string,
    toAddress: string,
    amount: number,
    mintAuthorityKeypair: Keypair,
  ): Promise<{ signature: string; ata: string }> {
    const conn = this.getConnection()
    const mintPubkey = new PublicKey(mintAddress)
    const toPubkey = new PublicKey(toAddress)

    const mintInfo = await getMint(conn, mintPubkey)
    const rawAmount = amount * Math.pow(10, mintInfo.decimals)

    // Get or create the associated token account
    const ata = await getOrCreateAssociatedTokenAccount(
      conn,
      mintAuthorityKeypair, // payer
      mintPubkey,
      toPubkey,
    )

    const signature = await mintTo(
      conn,
      mintAuthorityKeypair, // payer
      mintPubkey,
      ata.address,
      mintAuthorityKeypair, // mint authority
      BigInt(Math.floor(rawAmount)),
    )

    return {
      signature: String(signature),
      ata: ata.address.toBase58(),
    }
  }

  async createMint(
    decimals: number,
    mintAuthorityKeypair: Keypair,
    freezeAuthority: PublicKey | null,
  ): Promise<{ mintAddress: string }> {
    const conn = this.getConnection()

    const mint = await splCreateMint(
      conn,
      mintAuthorityKeypair, // payer
      mintAuthorityKeypair.publicKey, // mint authority
      freezeAuthority, // freeze authority
      decimals,
    )

    return { mintAddress: mint.toBase58() }
  }

  async getTransaction(signature: string): Promise<
    | {
        status: "confirmed" | "finalized" | "failed"
        slot: number
        fee: number
        instructions: Array<{
          programId: string
          data: string
          accounts: string[]
        }>
        logs: string[]
        error?: string
      }
    | ToolError
  > {
    const conn = this.getConnection()

    const tx = await conn.getTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    })

    if (!tx) {
      return toolError(
        "TRANSACTION_NOT_FOUND",
        `Transaction ${signature} not found. It may still be processing.`,
      )
    }

    const instructions =
      tx.transaction.message.compiledInstructions?.map((ix) => ({
        programId: tx.transaction.message.staticAccountKeys[ix.programIdIndex].toBase58(),
        data: Buffer.from(ix.data).toString("base64"),
        accounts: ix.accountKeyIndexes.map(
          (idx) => tx.transaction.message.staticAccountKeys[idx]?.toBase58() ?? `index:${idx}`,
        ),
      })) ?? []

    return {
      status: tx.meta?.err ? "failed" : "confirmed",
      slot: tx.slot,
      fee: tx.meta?.fee ?? 0,
      instructions,
      logs: tx.meta?.logMessages ?? [],
      error: tx.meta?.err ? JSON.stringify(tx.meta.err) : undefined,
    }
  }

  async getAccountInfo(
    address: string,
    encoding: "base58" | "base64" | "jsonParsed" = "jsonParsed",
  ): Promise<any> {
    const conn = this.getConnection()
    const pubkey = new PublicKey(address)

    if (encoding === "jsonParsed") {
      const info = await conn.getParsedAccountInfo(pubkey)
      if (!info.value) {
        return toolError("ACCOUNT_NOT_FOUND", `Account ${address} not found.`)
      }
      return {
        lamports: info.value.lamports,
        owner: info.value.owner.toBase58(),
        executable: info.value.executable,
        rentEpoch: info.value.rentEpoch,
        data: info.value.data,
      }
    }

    const info = await conn.getAccountInfo(pubkey)
    if (!info) {
      return toolError("ACCOUNT_NOT_FOUND", `Account ${address} not found.`)
    }
    return {
      lamports: info.lamports,
      owner: info.owner.toBase58(),
      executable: info.executable,
      rentEpoch: info.rentEpoch,
      data:
        encoding === "base64"
          ? info.data.toString("base64")
          : info.data.toString("hex"),
    }
  }

  async advanceClock(
    slots?: number,
    unixTimestamp?: number,
  ): Promise<{ success: boolean; message: string } | ToolError> {
    // solana-test-validator admin RPC for warp slot
    if (slots) {
      try {
        const currentSlot = await this.getConnection().getSlot()
        const targetSlot = currentSlot + slots

        const response = await fetch(this.rpcUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "warpSlot",
            params: [targetSlot],
          }),
        })

        const result = (await response.json()) as any

        if (result.error) {
          return toolError(
            "NOT_SUPPORTED",
            `Clock advancement failed: ${result.error.message}. ` +
              `The solana-test-validator may not support warpSlot. ` +
              `Consider restarting the validator with the desired slot offset.`,
          )
        }

        return {
          success: true,
          message: `Advanced clock by ${slots} slots to slot ${targetSlot}`,
        }
      } catch (err: any) {
        return toolError(
          "NOT_SUPPORTED",
          `Clock advancement not supported: ${err.message}. ` +
            `Solana test validator has limited clock control compared to EVM/StarkNet.`,
        )
      }
    }

    if (unixTimestamp) {
      return toolError(
        "NOT_SUPPORTED",
        `Setting absolute unix timestamp is not supported on solana-test-validator. ` +
          `Use slot advancement instead, or restart the validator with --warp-slot.`,
      )
    }

    return toolError(
      "INVALID_INPUT",
      "Must provide either slots or unixTimestamp.",
    )
  }

  async getProgramAccounts(
    programId: string,
    filters?: Array<{
      memcmp?: { offset: number; bytes: string }
      dataSize?: number
    }>,
  ): Promise<
    Array<{ pubkey: string; lamports: number; data: string; owner: string }>
  > {
    const conn = this.getConnection()
    const programPubkey = new PublicKey(programId)

    const rpcFilters: any[] = (filters ?? []).map((f) => {
      if (f.memcmp) {
        return { memcmp: { offset: f.memcmp.offset, bytes: f.memcmp.bytes } }
      }
      if (f.dataSize !== undefined) {
        return { dataSize: f.dataSize }
      }
      return f
    })

    const accounts = await conn.getProgramAccounts(programPubkey, {
      filters: rpcFilters.length > 0 ? rpcFilters : undefined,
    })

    return accounts.map((a) => ({
      pubkey: a.pubkey.toBase58(),
      lamports: a.account.lamports,
      data: a.account.data.toString("base64"),
      owner: a.account.owner.toBase58(),
    }))
  }

  async sendRawTransaction(serializedTx: Buffer): Promise<string> {
    const conn = this.getConnection()
    const signature = await conn.sendRawTransaction(serializedTx, {
      skipPreflight: false,
      preflightCommitment: this.commitment,
    })
    await conn.confirmTransaction(signature, this.commitment)
    return signature
  }

  disconnect(): void {
    this.connection = null
  }
}
