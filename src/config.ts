import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { getAddress, isAddress, parseGwei } from "viem";
import { parse } from "yaml";
import { z } from "zod";
import type { Address } from "viem";
import type { AppConfig, ChainConfig } from "./types.js";

const addressSchema = z
  .string()
  .refine(isAddress, "must be an EVM address")
  .transform((value) => getAddress(value));

const chainSchema = z
  .object({
    name: z.string().min(1),
    chainId: z.number().int().positive(),
    rpcUrl: z.string().url(),
    watch: z.boolean().default(true),
    deploy: z.boolean(),
    confirmations: z.number().int().nonnegative().default(12),
    startBlock: z.union([z.literal("latest"), z.number().int().nonnegative()]).default("latest"),
    create2Compatible: z.boolean(),
  })
  .strict();

const rawConfigSchema = z
  .object({
    databasePath: z.string().min(1).default("./data/safe-everywhere.sqlite"),
    pollIntervalMs: z.number().int().min(1_000).default(12_000),
    maxBlockRange: z.number().int().positive().default(2_000),
    reorgLookbackBlocks: z.number().int().nonnegative().default(12),
    rpcTimeoutMs: z.number().int().positive().default(20_000),
    deployerPrivateKeyEnv: z.string().min(1).default("DEPLOYER_PRIVATE_KEY"),
    policy: z
      .object({
        allowedCreators: z.array(addressSchema).default([]),
        allowedSafeAddresses: z.array(addressSchema).default([]),
        maxDeploymentsPerRun: z.number().int().positive().default(20),
        maxDeploymentsPerDay: z.number().int().positive().default(50),
        maxTargetsPerSafe: z.number().int().positive().default(12),
        maxEstimatedGas: z.number().int().positive().default(500_000),
        maxFeePerGasGwei: z.number().positive().default(500),
        requireCanonicalSetup: z.boolean().default(true),
        allowContractOwners: z.boolean().default(false),
      })
      .strict()
      .default({
        allowedCreators: [],
        allowedSafeAddresses: [],
        maxDeploymentsPerRun: 20,
        maxDeploymentsPerDay: 50,
        maxTargetsPerSafe: 12,
        maxEstimatedGas: 500_000,
        maxFeePerGasGwei: 500,
        requireCanonicalSetup: true,
        allowContractOwners: false,
      }),
    chains: z.record(z.string(), chainSchema),
  })
  .strict();

function loadLocalEnvironment(configPath: string): void {
  const candidates = [resolve(process.cwd(), ".env"), resolve(dirname(configPath), ".env")];
  for (const candidate of new Set(candidates)) {
    if (!existsSync(candidate)) continue;
    try {
      loadEnvFile(candidate);
    } catch (error) {
      throw new Error(`Unable to load environment file ${candidate}`, { cause: error });
    }
  }
}

export function interpolateEnvironment(source: string): string {
  return source.replace(/\$\{([A-Z][A-Z0-9_]*)\}/g, (_match, name: string) => {
    const value = process.env[name];
    if (value === undefined || value.length === 0) {
      throw new Error(`Missing required environment variable ${name}`);
    }
    return value;
  });
}

export function loadConfig(configPathInput: string): AppConfig {
  const configPath = resolve(configPathInput);
  loadLocalEnvironment(configPath);
  const rawText = readFileSync(configPath, "utf8");
  const parsed = rawConfigSchema.parse(parse(interpolateEnvironment(rawText)));

  const seenChainIds = new Set<number>();
  const chains: ChainConfig[] = Object.entries(parsed.chains).map(([key, chain]) => {
    if (seenChainIds.has(chain.chainId)) {
      throw new Error(`Duplicate chainId ${chain.chainId} in configuration`);
    }
    seenChainIds.add(chain.chainId);
    return {
      ...chain,
      key,
      startBlock: chain.startBlock === "latest" ? "latest" : BigInt(chain.startBlock),
    };
  });

  if (chains.filter((chain) => chain.watch).length === 0) {
    throw new Error("At least one chain must have watch: true");
  }
  if (chains.filter((chain) => chain.deploy).length === 0) {
    throw new Error("At least one chain must have deploy: true");
  }

  return {
    ...parsed,
    databasePath: resolve(dirname(configPath), parsed.databasePath),
    maxBlockRange: BigInt(parsed.maxBlockRange),
    reorgLookbackBlocks: BigInt(parsed.reorgLookbackBlocks),
    policy: {
      ...parsed.policy,
      allowedCreators: parsed.policy.allowedCreators as Address[],
      allowedSafeAddresses: parsed.policy.allowedSafeAddresses as Address[],
      maxEstimatedGas: BigInt(parsed.policy.maxEstimatedGas),
      maxFeePerGasWei: parseGwei(String(parsed.policy.maxFeePerGasGwei)),
    },
    chains,
  };
}
