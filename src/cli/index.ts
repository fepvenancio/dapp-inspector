#!/usr/bin/env node

import { Command } from "commander"
import chalk from "chalk"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { runInit } from "./init.js"
import { startServer } from "../mcp/server.js"
import { loadConfig } from "../config/loader.js"

const program = new Command()

program
  .name("dapp-inspector")
  .description(
    "MCP server for AI-assisted DApp frontend testing, inspection, and validation",
  )
  .version("0.1.0")
  .option(
    "-c, --config <path>",
    "Path to config file",
    "dapp-inspector.config.json",
  )

program
  .command("serve", { isDefault: true })
  .description("Start the dapp-inspector MCP server")
  .action(async () => {
    const configPath = program.opts().config

    console.log("")
    console.log(
      chalk.bold("  dapp-inspector") + chalk.dim(" v0.1.0"),
    )
    console.log(chalk.dim("  ─────────────────────────────────"))
    console.log("")

    // Validate config before starting
    let config
    try {
      config = await loadConfig(configPath)
    } catch (err: any) {
      console.error(
        chalk.red("  Error: ") + err.message,
      )
      console.log("")
      console.log(
        chalk.dim("  Run ") +
          chalk.cyan("dapp-inspector init --chain <chain>") +
          chalk.dim(" to create a config file."),
      )
      console.log("")
      process.exit(1)
    }

    // Display startup info
    console.log(
      chalk.dim("  Chain:      ") +
        chalk.cyan(config.chain),
    )

    const adapterConfig = config.adapter as Record<string, unknown>
    if (adapterConfig.devnetUrl) {
      console.log(
        chalk.dim("  Devnet:     ") +
          chalk.white(String(adapterConfig.devnetUrl)),
      )
    }

    const accounts = adapterConfig.accounts as Array<{
      address: string
      label?: string
    }>
    if (accounts && accounts.length > 0) {
      console.log(
        chalk.dim("  Accounts:   ") +
          chalk.white(String(accounts.length)) +
          chalk.dim(" loaded"),
      )
      for (const account of accounts) {
        const label = account.label
          ? chalk.yellow(account.label)
          : chalk.dim("unlabeled")
        const addr = account.address
        const truncated =
          addr.length > 20
            ? addr.slice(0, 10) + "..." + addr.slice(-8)
            : addr
        console.log(
          chalk.dim("              ") +
            label +
            chalk.dim(" → ") +
            chalk.white(truncated),
        )
      }
    }

    const browser = config.browser
    console.log(
      chalk.dim("  Browser:    ") +
        chalk.white(browser.headless ? "headless" : "visible") +
        chalk.dim(
          ` (${browser.viewport?.width ?? 1280}x${browser.viewport?.height ?? 800})`,
        ),
    )

    console.log("")
    console.log(
      chalk.dim("  Starting MCP server on stdio..."),
    )
    console.log("")

    try {
      await startServer(configPath)
    } catch (err: any) {
      console.error("")
      console.error(
        chalk.red("  Fatal: ") + err.message,
      )

      // Provide helpful hints for common errors
      if (err.message.includes("ECONNREFUSED") || err.message.includes("Cannot connect")) {
        console.error("")
        console.error(
          chalk.dim("  Hint: ") +
            "Make sure your local devnet is running.",
        )
        if (config.chain === "starknet") {
          console.error(
            chalk.dim("        ") + "Run: starknet-devnet --seed 0",
          )
        } else if (config.chain === "evm") {
          console.error(
            chalk.dim("        ") + "Run: anvil",
          )
        } else if (config.chain === "solana") {
          console.error(
            chalk.dim("        ") + "Run: solana-test-validator",
          )
        }
      }

      console.log("")
      process.exit(1)
    }
  })

program
  .command("init")
  .description("Generate a dapp-inspector config file for a chain")
  .requiredOption(
    "--chain <chain>",
    "Chain to generate config for (starknet, evm, solana)",
  )
  .action(async (opts) => {
    await runInit(opts.chain)
  })

program.parse()
