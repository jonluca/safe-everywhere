import type { ChainRuntime } from "./types.js";
import { verifyRegistryContract, verifyRpcIdentity } from "./runtime.js";

export interface DoctorResult {
  chainId: number;
  name: string;
  factoryCount: number;
  singletonCount: number;
  handlerCount: number;
  signerAddress?: string;
  signerBalance?: string;
}

export async function doctorRuntime(runtime: ChainRuntime): Promise<DoctorResult> {
  await verifyRpcIdentity(runtime);
  if (runtime.registry.factories.size === 0 || runtime.registry.singletons.size === 0) {
    throw new Error(`${runtime.config.name} has no supported Safe factory/singleton deployments`);
  }
  const contracts = new Map(
    [
      ...runtime.registry.factories.values(),
      ...runtime.registry.singletons.values(),
      ...runtime.registry.handlers.values(),
    ].map((contract) => [contract.address.toLowerCase(), contract]),
  );
  for (const contract of contracts.values()) await verifyRegistryContract(runtime, contract);
  const balance = runtime.account
    ? await runtime.publicClient.getBalance({ address: runtime.account.address })
    : undefined;
  return {
    chainId: runtime.config.chainId,
    name: runtime.config.name,
    factoryCount: runtime.registry.factories.size,
    singletonCount: runtime.registry.singletons.size,
    handlerCount: runtime.registry.handlers.size,
    ...(runtime.account ? { signerAddress: runtime.account.address } : {}),
    ...(balance === undefined ? {} : { signerBalance: balance.toString() }),
  };
}
