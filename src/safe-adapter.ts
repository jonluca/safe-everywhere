import {
  decodeEventLog,
  decodeFunctionData,
  encodeAbiParameters,
  getAddress,
  isAddressEqual,
  keccak256,
  parseAbiParameters,
} from "viem";
import type { Abi, Address, Hex, Log } from "viem";
import { safeReadAbi, safeSetupAbi, zeroAddress } from "./contracts.js";
import {
  PolicyRejectionError,
  SafeConfigurationMismatchError,
  UnsupportedCreationError,
} from "./errors.js";
import { singletonAt } from "./runtime.js";
import type {
  AppConfig,
  ChainRuntime,
  FactoryContract,
  ReplayMethod,
  ReplayableSafeCreation,
  SafeCreationObservation,
  SafeSetup,
  StoredDeployment,
} from "./types.js";

const replayMethods = new Set<ReplayMethod>(["createProxyWithNonce", "createProxyWithNonceL2"]);

function asAddress(value: unknown, label: string): Address {
  if (typeof value !== "string") throw new UnsupportedCreationError(`Missing ${label}`);
  return getAddress(value);
}

function asHex(value: unknown, label: string): Hex {
  if (typeof value !== "string" || !value.startsWith("0x")) {
    throw new UnsupportedCreationError(`Missing ${label}`);
  }
  return value as Hex;
}

function asBigInt(value: unknown, label: string): bigint {
  if (typeof value !== "bigint") throw new UnsupportedCreationError(`Missing ${label}`);
  return value;
}

function normalizeArgs(args: unknown): Record<string, unknown> {
  if (!args || typeof args !== "object")
    throw new UnsupportedCreationError("Event has no arguments");
  return args as Record<string, unknown>;
}

export function decodeFactoryLog(
  chainId: number,
  factory: FactoryContract,
  log: Log,
): SafeCreationObservation | undefined {
  if (!log.transactionHash || !log.blockHash || log.blockNumber === null || log.logIndex === null) {
    throw new Error("Finalized factory log is missing block or transaction metadata");
  }
  const decoded = decodeEventLog({
    abi: factory.abi as Abi,
    data: log.data,
    topics: log.topics,
    strict: true,
  });
  const eventName = decoded.eventName;
  if (
    !eventName ||
    !["ProxyCreation", "ProxyCreationL2", "ChainSpecificProxyCreationL2"].includes(eventName)
  ) {
    return undefined;
  }
  const args = normalizeArgs(decoded.args);
  const safeAddress = asAddress(args.proxy, "proxy");
  const singleton = asAddress(args.singleton, "singleton");
  const observation: SafeCreationObservation = {
    id: `${chainId}:${log.transactionHash}:${log.logIndex}`,
    chainId,
    factory: factory.address,
    singleton,
    safeAddress,
    transactionHash: log.transactionHash,
    blockNumber: log.blockNumber,
    blockHash: log.blockHash,
    logIndex: log.logIndex,
    eventName,
  };
  if ("initializer" in args) observation.eventInitializer = asHex(args.initializer, "initializer");
  if ("saltNonce" in args) observation.eventSaltNonce = asBigInt(args.saltNonce, "saltNonce");
  return observation;
}

export function decodeSafeSetup(initializer: Hex): SafeSetup {
  if (initializer === "0x") throw new PolicyRejectionError("Empty initializer is unsafe");
  const decoded = (() => {
    try {
      return decodeFunctionData({ abi: safeSetupAbi, data: initializer });
    } catch (error) {
      throw new PolicyRejectionError("Initializer is not the canonical Safe setup call", {
        cause: error,
      });
    }
  })();
  if (decoded.functionName !== "setup" || !decoded.args) {
    throw new PolicyRejectionError("Initializer is not Safe.setup");
  }
  const [owners, threshold, to, data, fallbackHandler, paymentToken, payment, paymentReceiver] =
    decoded.args;
  return {
    owners: [...owners].map((owner) => getAddress(owner)),
    threshold,
    to: getAddress(to),
    data,
    fallbackHandler: getAddress(fallbackHandler),
    paymentToken: getAddress(paymentToken),
    payment,
    paymentReceiver: getAddress(paymentReceiver),
  };
}

export function fingerprintCreation(
  factory: Address,
  singleton: Address,
  initializer: Hex,
  saltNonce: bigint,
): Hex {
  return keccak256(
    encodeAbiParameters(parseAbiParameters("address, address, bytes32, uint256"), [
      factory,
      singleton,
      keccak256(initializer),
      saltNonce,
    ]),
  );
}

function enforceEnrollment(config: AppConfig, creator: Address, safeAddress: Address): void {
  const creators = new Set(config.policy.allowedCreators.map((address) => address.toLowerCase()));
  const safes = new Set(config.policy.allowedSafeAddresses.map((address) => address.toLowerCase()));
  if (creators.size === 0 && safes.size === 0) {
    throw new PolicyRejectionError("No source creator or Safe address is enrolled");
  }
  if (!creators.has(creator.toLowerCase()) && !safes.has(safeAddress.toLowerCase())) {
    throw new PolicyRejectionError(
      `Source creator ${creator} and Safe ${safeAddress} are not enrolled`,
    );
  }
}

async function validateSetupPolicy(
  runtime: ChainRuntime,
  config: AppConfig,
  setup: SafeSetup,
  blockNumber: bigint,
): Promise<void> {
  if (setup.owners.length === 0) throw new PolicyRejectionError("Safe has no owners");
  if (setup.threshold === 0n || setup.threshold > BigInt(setup.owners.length)) {
    throw new PolicyRejectionError("Safe threshold is invalid");
  }
  if (
    runtime.account &&
    setup.owners.some((owner) => isAddressEqual(owner, runtime.account?.address ?? zeroAddress))
  ) {
    throw new PolicyRejectionError("The gas-payer account must not be a Safe owner");
  }
  if (config.policy.requireCanonicalSetup) {
    if (!isAddressEqual(setup.to, zeroAddress) || setup.data !== "0x") {
      throw new PolicyRejectionError("Setup delegatecalls are disabled by policy");
    }
    if (setup.payment !== 0n) {
      throw new PolicyRejectionError("Setup payments are disabled by policy");
    }
    if (
      !isAddressEqual(setup.fallbackHandler, zeroAddress) &&
      !runtime.registry.handlers.has(setup.fallbackHandler.toLowerCase())
    ) {
      throw new PolicyRejectionError(`Fallback handler ${setup.fallbackHandler} is not official`);
    }
  }
  if (!config.policy.allowContractOwners) {
    for (const owner of setup.owners) {
      const code = await runtime.publicClient.getCode({ address: owner, blockNumber });
      if (code && code !== "0x") {
        throw new PolicyRejectionError(`Contract owner ${owner} is disabled by policy`);
      }
    }
  }
}

function sameOwnerSet(left: readonly Address[], right: readonly Address[]): boolean {
  if (left.length !== right.length) return false;
  const leftSet = new Set(left.map((address) => address.toLowerCase()));
  return right.every((address) => leftSet.has(address.toLowerCase()));
}

export async function verifySafeConfiguration(
  runtime: ChainRuntime,
  deployment: Pick<StoredDeployment, "safeAddress" | "singleton" | "owners" | "threshold">,
  blockNumber?: bigint,
): Promise<void> {
  const [owners, threshold, singleton] = await Promise.all([
    runtime.publicClient.readContract({
      address: deployment.safeAddress,
      abi: safeReadAbi,
      functionName: "getOwners",
      ...(blockNumber === undefined ? {} : { blockNumber }),
    }),
    runtime.publicClient.readContract({
      address: deployment.safeAddress,
      abi: safeReadAbi,
      functionName: "getThreshold",
      ...(blockNumber === undefined ? {} : { blockNumber }),
    }),
    singletonAt(runtime, deployment.safeAddress, blockNumber),
  ]);
  if (!sameOwnerSet(owners, deployment.owners)) {
    throw new SafeConfigurationMismatchError("Safe owner set does not match");
  }
  if (threshold !== deployment.threshold) {
    throw new SafeConfigurationMismatchError("Safe threshold does not match");
  }
  if (!isAddressEqual(singleton, deployment.singleton))
    throw new SafeConfigurationMismatchError("Safe singleton does not match");
}

export async function recoverReplayableCreation(
  runtime: ChainRuntime,
  config: AppConfig,
  observation: SafeCreationObservation,
): Promise<ReplayableSafeCreation> {
  const factory = runtime.registry.factories.get(observation.factory.toLowerCase());
  if (!factory) throw new UnsupportedCreationError("Factory is not registered");
  const singleton = runtime.registry.singletons.get(observation.singleton.toLowerCase());
  if (!singleton || singleton.version !== factory.version) {
    throw new UnsupportedCreationError("Singleton is not a matching registered Safe deployment");
  }
  if (observation.eventName === "ChainSpecificProxyCreationL2") {
    throw new UnsupportedCreationError(
      "Chain-specific CREATE2 deployments cannot preserve the address",
    );
  }

  const transaction = await runtime.publicClient.getTransaction({
    hash: observation.transactionHash,
  });
  const creator = getAddress(transaction.from);
  enforceEnrollment(config, creator, observation.safeAddress);
  if (!transaction.to || !isAddressEqual(transaction.to, observation.factory)) {
    throw new UnsupportedCreationError(
      "Nested factory call: recover the initializer/salt with traces before replaying",
    );
  }

  const decoded = (() => {
    try {
      return decodeFunctionData({ abi: factory.abi as Abi, data: transaction.input });
    } catch (error) {
      throw new UnsupportedCreationError("Cannot decode factory transaction input", {
        cause: error,
      });
    }
  })();
  if (!replayMethods.has(decoded.functionName as ReplayMethod)) {
    throw new UnsupportedCreationError(`Factory method ${decoded.functionName} is not replayable`);
  }
  if (!decoded.args || decoded.args.length < 3) {
    throw new UnsupportedCreationError("Factory transaction is missing replay arguments");
  }
  const method = decoded.functionName as ReplayMethod;
  const decodedSingleton = asAddress(decoded.args[0], "singleton");
  const initializer = asHex(decoded.args[1], "initializer");
  const saltNonce = asBigInt(decoded.args[2], "saltNonce");
  if (!isAddressEqual(decodedSingleton, observation.singleton)) {
    throw new UnsupportedCreationError("Event singleton differs from transaction singleton");
  }
  if (observation.eventInitializer && observation.eventInitializer !== initializer) {
    throw new UnsupportedCreationError("Event initializer differs from transaction initializer");
  }
  if (observation.eventSaltNonce !== undefined && observation.eventSaltNonce !== saltNonce) {
    throw new UnsupportedCreationError("Event salt differs from transaction salt");
  }

  const setup = decodeSafeSetup(initializer);
  await validateSetupPolicy(runtime, config, setup, observation.blockNumber);

  const creation: ReplayableSafeCreation = {
    ...observation,
    fingerprint: fingerprintCreation(
      observation.factory,
      observation.singleton,
      initializer,
      saltNonce,
    ),
    version: factory.version,
    method,
    creator,
    initializer,
    saltNonce,
    setup,
  };
  await verifySafeConfiguration(
    runtime,
    {
      safeAddress: creation.safeAddress,
      singleton: creation.singleton,
      owners: creation.setup.owners,
      threshold: creation.setup.threshold,
    },
    creation.blockNumber,
  );
  return creation;
}

export async function revalidateStoredDeploymentPolicy(
  runtime: ChainRuntime,
  config: AppConfig,
  deployment: StoredDeployment,
): Promise<void> {
  enforceEnrollment(config, deployment.creator, deployment.safeAddress);
  const setup = decodeSafeSetup(deployment.initializer);
  await validateSetupPolicy(runtime, config, setup, deployment.sourceBlockNumber);
}
