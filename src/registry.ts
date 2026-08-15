import {
  getCompatibilityFallbackHandlerDeployments,
  getExtensibleFallbackHandlerDeployments,
  getProxyFactoryDeployments,
  getSafeL2SingletonDeployments,
  getSafeSingletonDeployments,
  getTokenCallbackHandlerDeployments,
  type SingletonDeploymentV2,
} from "@safe-global/safe-deployments";
import { getAddress } from "viem";
import type { Address, Hex } from "viem";
import {
  supportedSafeVersions,
  type ChainRegistry,
  type FactoryContract,
  type RegistryContract,
  type SingletonContract,
  type SupportedSafeVersion,
} from "./types.js";

function addressesFor(deployment: SingletonDeploymentV2 | undefined, chainId: number): Address[] {
  if (!deployment) return [];
  const raw = deployment.networkAddresses[String(chainId)];
  if (!raw) return [];
  return (Array.isArray(raw) ? raw : [raw]).map((address) => getAddress(address));
}

function codeHashFor(deployment: SingletonDeploymentV2, address: Address): Hex {
  const match = Object.values(deployment.deployments).find(
    (candidate) => candidate?.address.toLowerCase() === address.toLowerCase(),
  );
  if (!match) {
    throw new Error(`Deployment metadata is missing a code hash for ${address}`);
  }
  return match.codeHash as Hex;
}

function addRegistryContracts<T extends RegistryContract>(
  target: Map<string, T>,
  deployment: SingletonDeploymentV2 | undefined,
  chainId: number,
  build: (base: RegistryContract) => T,
): void {
  if (!deployment) return;
  for (const address of addressesFor(deployment, chainId)) {
    const base: RegistryContract = {
      address,
      codeHash: codeHashFor(deployment, address),
      version: deployment.version as SupportedSafeVersion,
    };
    target.set(address.toLowerCase(), build(base));
  }
}

export function buildChainRegistry(chainId: number): ChainRegistry {
  const factories = new Map<string, FactoryContract>();
  const singletons = new Map<string, SingletonContract>();
  const handlers = new Map<string, RegistryContract>();

  for (const version of supportedSafeVersions) {
    const filter = { network: String(chainId), version };
    const factory = getProxyFactoryDeployments(filter);
    addRegistryContracts(factories, factory, chainId, (base) => ({
      ...base,
      abi: factory?.abi ?? [],
    }));

    addRegistryContracts(singletons, getSafeSingletonDeployments(filter), chainId, (base) => ({
      ...base,
      kind: "safe",
    }));
    addRegistryContracts(singletons, getSafeL2SingletonDeployments(filter), chainId, (base) => ({
      ...base,
      kind: "safeL2",
    }));

    for (const handlerDeployment of [
      getCompatibilityFallbackHandlerDeployments(filter),
      getExtensibleFallbackHandlerDeployments(filter),
      getTokenCallbackHandlerDeployments(filter),
    ]) {
      addRegistryContracts(handlers, handlerDeployment, chainId, (base) => base);
    }
  }

  return { factories, singletons, handlers };
}
