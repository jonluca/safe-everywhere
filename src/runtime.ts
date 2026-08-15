import {
  createPublicClient,
  createWalletClient,
  defineChain,
  getAddress,
  http,
  isHex,
  keccak256,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Address, Hex } from "viem";
import type { AppConfig, ChainRuntime, RegistryContract } from "./types.js";
import { buildChainRegistry } from "./registry.js";

function getPrivateKey(config: AppConfig, execute: boolean): Hex | undefined {
  const value = process.env[config.deployerPrivateKeyEnv];
  if (!value) {
    if (execute) {
      throw new Error(`Execution requires ${config.deployerPrivateKeyEnv} in the environment`);
    }
    return undefined;
  }
  if (!isHex(value) || value.length !== 66) {
    throw new Error(`${config.deployerPrivateKeyEnv} must be a 32-byte 0x-prefixed private key`);
  }
  return value;
}

export function createRuntimes(config: AppConfig, execute: boolean): ChainRuntime[] {
  const privateKey = getPrivateKey(config, execute);
  const account = privateKey ? privateKeyToAccount(privateKey) : undefined;

  return config.chains.map((chainConfig) => {
    const chain = defineChain({
      id: chainConfig.chainId,
      name: chainConfig.name,
      nativeCurrency: { name: "Native token", symbol: "NATIVE", decimals: 18 },
      rpcUrls: { default: { http: [chainConfig.rpcUrl] } },
    });
    const transport = http(chainConfig.rpcUrl, { timeout: config.rpcTimeoutMs, retryCount: 3 });
    const publicClient = createPublicClient({ chain, transport });
    const walletClient = account ? createWalletClient({ account, chain, transport }) : undefined;
    return {
      config: chainConfig,
      chain,
      publicClient,
      registry: buildChainRegistry(chainConfig.chainId),
      ...(account ? { account } : {}),
      ...(walletClient ? { walletClient } : {}),
    } as ChainRuntime;
  });
}

export async function verifyRpcIdentity(runtime: ChainRuntime): Promise<void> {
  const actualChainId = await runtime.publicClient.getChainId();
  if (actualChainId !== runtime.config.chainId) {
    throw new Error(
      `${runtime.config.name} RPC returned chainId ${actualChainId}; expected ${runtime.config.chainId}`,
    );
  }
}

export async function verifyRegistryContract(
  runtime: ChainRuntime,
  contract: RegistryContract,
): Promise<void> {
  const code = await runtime.publicClient.getCode({ address: contract.address });
  if (!code || code === "0x") {
    throw new Error(
      `${runtime.config.name} has no code at registered ${contract.version} address ${contract.address}`,
    );
  }
  const actualHash = keccak256(code);
  if (actualHash.toLowerCase() !== contract.codeHash.toLowerCase()) {
    throw new Error(
      `${runtime.config.name} code hash mismatch at ${contract.address}: ${actualHash} != ${contract.codeHash}`,
    );
  }
}

export async function singletonAt(
  runtime: ChainRuntime,
  safeAddress: Address,
  blockNumber?: bigint,
): Promise<Address> {
  const value = await runtime.publicClient.getStorageAt({
    address: safeAddress,
    slot: `0x${"0".repeat(64)}`,
    ...(blockNumber === undefined ? {} : { blockNumber }),
  });
  if (!value || value === "0x") throw new Error(`Cannot read singleton storage at ${safeAddress}`);
  return getAddress(`0x${value.slice(-40)}`);
}
