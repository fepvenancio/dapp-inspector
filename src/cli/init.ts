import * as fs from "node:fs"
import * as path from "node:path"

type ChainTemplate = {
  chain: string
  browser: { headless: boolean }
  adapter: Record<string, unknown>
  instructions: string[]
}

const TEMPLATES: Record<string, ChainTemplate> = {
  starknet: {
    chain: "starknet",
    browser: { headless: false },
    adapter: {
      devnetUrl: "http://localhost:5050",
      starknetVersion: "v6",
      chainId: "SN_SEPOLIA",
      accounts: [
        {
          address:
            "0x064b48806902a367c8598f4f95c305e8c1a1acba5f082d294a43793113115691",
          privateKey:
            "0x0000000000000000000000000000000071d7bb07b9a64f6f78ac4c816aff4da9",
          label: "deployer",
        },
        {
          address:
            "0x078662e7352d062084b0010068b99288486c2d8b914f6e2a55ce945f8792c8b1",
          privateKey:
            "0x00000000000000000000000000000000e1406455b7d66b1690803be066cbe5e4",
          label: "user",
        },
      ],
    },
    instructions: [
      "Install and start starknet-devnet-rs:",
      "  cargo install starknet-devnet",
      "  starknet-devnet --seed 0",
      "",
      "Replace the account addresses and private keys above with",
      "the predeployed accounts from your devnet instance.",
    ],
  },
  evm: {
    chain: "evm",
    browser: { headless: false },
    adapter: {
      devnetUrl: "http://localhost:8545",
      chainId: 31337,
      accounts: [
        {
          address: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
          privateKey:
            "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
          label: "deployer",
        },
        {
          address: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
          privateKey:
            "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
          label: "user",
        },
      ],
    },
    instructions: [
      "Install and start Anvil (from Foundry):",
      "  curl -L https://foundry.paradigm.xyz | bash",
      "  foundryup",
      "  anvil",
      "",
      "The accounts above are Anvil's default test accounts.",
    ],
  },
  solana: {
    chain: "solana",
    browser: { headless: false },
    adapter: {
      devnetUrl: "http://localhost:8899",
      wsUrl: "ws://localhost:8900",
      commitment: "confirmed",
      accounts: [
        {
          address: "YOUR_PUBKEY_1",
          privateKey: "YOUR_BASE58_PRIVATE_KEY_1",
          label: "deployer",
        },
        {
          address: "YOUR_PUBKEY_2",
          privateKey: "YOUR_BASE58_PRIVATE_KEY_2",
          label: "user",
        },
      ],
    },
    instructions: [
      "Install and start solana-test-validator:",
      "  sh -c \"$(curl -sSfL https://release.anza.xyz/stable/install)\"",
      "  solana-test-validator",
      "",
      "Generate test keypairs:",
      "  solana-keygen new --outfile ~/.config/solana/deployer.json --no-bip39-passphrase",
      "  solana-keygen new --outfile ~/.config/solana/user.json --no-bip39-passphrase",
      "",
      "Then update the accounts in the config with the generated keys.",
      "You can get the base58 private key with:",
      "  cat ~/.config/solana/deployer.json | node -e \"const bs58=require('bs58');process.stdin.on('data',d=>{console.log(bs58.encode(Buffer.from(JSON.parse(d))))})\"",
    ],
  },
}

const CONFIG_FILENAME = "dapp-inspector.config.json"

export async function runInit(chain: string): Promise<void> {
  const template = TEMPLATES[chain]
  if (!template) {
    const available = Object.keys(TEMPLATES).join(", ")
    console.error(
      `Unknown chain: "${chain}". Available chains: ${available}`,
    )
    process.exit(1)
  }

  const configPath = path.resolve(process.cwd(), CONFIG_FILENAME)

  if (fs.existsSync(configPath)) {
    console.error(
      `Config file already exists: ${configPath}\n` +
        `Delete it first or edit it manually.`,
    )
    process.exit(1)
  }

  const config = {
    chain: template.chain,
    browser: template.browser,
    adapter: template.adapter,
  }

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8")

  console.log(`\nCreated ${CONFIG_FILENAME} for ${chain}.\n`)
  console.log("Next steps:")
  for (const line of template.instructions) {
    console.log(`  ${line}`)
  }
  console.log("")
  console.log(
    `Then run: npx dapp-inspector serve`,
  )
  console.log("")
}
