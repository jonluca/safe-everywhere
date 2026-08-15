import { describe, expect, it } from "vitest";
import { encodeFunctionData, type Address, type Hex } from "viem";
import { safeSetupAbi, zeroAddress } from "../src/contracts.js";
import { revalidateStoredDeploymentPolicy } from "../src/safe-adapter.js";
import type { AppConfig, ChainRuntime, StoredDeployment } from "../src/types.js";

const owner = "0x1111111111111111111111111111111111111111" as Address;
const creator = "0x2222222222222222222222222222222222222222" as Address;
const safeAddress = "0x3333333333333333333333333333333333333333" as Address;

const initializer = encodeFunctionData({
  abi: safeSetupAbi,
  functionName: "setup",
  args: [[owner], 1n, zeroAddress, "0x", zeroAddress, zeroAddress, 0n, zeroAddress],
});

function config(allowedCreators: Address[]): AppConfig {
  return {
    databasePath: ":memory:",
    pollIntervalMs: 1_000,
    maxBlockRange: 2_000n,
    reorgLookbackBlocks: 12n,
    rpcTimeoutMs: 20_000,
    deployerPrivateKeyEnv: "DEPLOYER_PRIVATE_KEY",
    chains: [],
    policy: {
      allowedCreators,
      allowedSafeAddresses: [],
      maxDeploymentsPerRun: 10,
      maxDeploymentsPerDay: 10,
      maxTargetsPerSafe: 10,
      maxEstimatedGas: 500_000n,
      maxFeePerGasWei: 500_000_000_000n,
      requireCanonicalSetup: true,
      allowContractOwners: false,
    },
  };
}

function deployment(): StoredDeployment {
  return {
    fingerprint: `0x${"4".repeat(64)}` as Hex,
    safeAddress,
    factory: "0x5555555555555555555555555555555555555555" as Address,
    singleton: "0x6666666666666666666666666666666666666666" as Address,
    initializer,
    saltNonce: 1n,
    method: "createProxyWithNonce",
    version: "1.4.1",
    creator,
    owners: [owner],
    threshold: 1n,
    fallbackHandler: zeroAddress,
    sourceChainId: 1,
    sourceTransactionHash: `0x${"7".repeat(64)}` as Hex,
    sourceBlockNumber: 100n,
    sourceBlockHash: `0x${"8".repeat(64)}` as Hex,
  };
}

function runtime(accountAddress?: Address): ChainRuntime {
  return {
    registry: { factories: new Map(), singletons: new Map(), handlers: new Map() },
    publicClient: { getCode: async () => "0x" },
    ...(accountAddress ? { account: { address: accountAddress } } : {}),
  } as unknown as ChainRuntime;
}

describe("stored deployment policy revalidation", () => {
  it("rejects a creator removed after dry-run discovery", async () => {
    await expect(
      revalidateStoredDeploymentPolicy(runtime(), config([]), deployment()),
    ).rejects.toThrow(/enrolled/u);
  });

  it("rejects a newly configured gas payer that is a Safe owner", async () => {
    await expect(
      revalidateStoredDeploymentPolicy(runtime(owner), config([creator]), deployment()),
    ).rejects.toThrow("must not be a Safe owner");
  });

  it("accepts a canonical enrolled deployment with EOA owners", async () => {
    await expect(
      revalidateStoredDeploymentPolicy(runtime(), config([creator]), deployment()),
    ).resolves.toBeUndefined();
  });
});
