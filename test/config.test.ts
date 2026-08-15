import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const environmentNames = [
  "SAFE_CREATOR_ADDRESS",
  "ETHEREUM_RPC_URL",
  "OPTIMISM_RPC_URL",
  "BNB_RPC_URL",
  "GNOSIS_RPC_URL",
  "POLYGON_RPC_URL",
  "BASE_RPC_URL",
  "ARBITRUM_RPC_URL",
  "CELO_RPC_URL",
  "AVALANCHE_RPC_URL",
  "MANTLE_RPC_URL",
  "LINEA_RPC_URL",
  "SCROLL_RPC_URL",
] as const;

const originalEnvironment = new Map(
  environmentNames.map((name) => [name, process.env[name]] as const),
);
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const [name, value] of originalEnvironment) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("configuration", () => {
  it("loads the checked-in main-chain example with explicit deployment flags", () => {
    for (const name of environmentNames) {
      process.env[name] =
        name === "SAFE_CREATOR_ADDRESS"
          ? "0x1111111111111111111111111111111111111111"
          : "https://rpc.example";
    }
    const config = loadConfig(resolve("config/chains.example.yaml"));
    expect(config.chains).toHaveLength(12);
    expect(config.chains.every((chain) => chain.deploy && chain.create2Compatible)).toBe(true);
  });

  it("rejects misspelled safety fields instead of applying permissive defaults", () => {
    const directory = mkdtempSync(join(tmpdir(), "safe-everywhere-config-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "chains.yaml");
    writeFileSync(
      path,
      `chains:
  ethereum:
    name: Ethereum
    chainId: 1
    rpcUrl: https://rpc.example
    deply: false
    deploy: true
    create2Compatible: true
`,
    );
    expect(() => loadConfig(path)).toThrow(/deply/u);
  });
});
