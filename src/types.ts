import type { Account, Address, Chain, Hex, PublicClient, Transport, WalletClient } from "viem";

export const supportedSafeVersions = ["1.3.0", "1.4.1", "1.5.0"] as const;

export type SupportedSafeVersion = (typeof supportedSafeVersions)[number];

export interface ChainConfig {
  key: string;
  name: string;
  chainId: number;
  rpcUrl: string;
  watch: boolean;
  deploy: boolean;
  confirmations: number;
  startBlock: bigint | "latest";
  create2Compatible: boolean;
}

export interface PolicyConfig {
  allowedCreators: Address[];
  allowedSafeAddresses: Address[];
  maxDeploymentsPerRun: number;
  maxDeploymentsPerDay: number;
  maxTargetsPerSafe: number;
  maxEstimatedGas: bigint;
  maxFeePerGasWei: bigint;
  requireCanonicalSetup: boolean;
  allowContractOwners: boolean;
}

export interface AppConfig {
  databasePath: string;
  pollIntervalMs: number;
  maxBlockRange: bigint;
  reorgLookbackBlocks: bigint;
  rpcTimeoutMs: number;
  deployerPrivateKeyEnv: string;
  chains: ChainConfig[];
  policy: PolicyConfig;
}

export interface RegistryContract {
  address: Address;
  codeHash: Hex;
  version: SupportedSafeVersion;
}

export interface FactoryContract extends RegistryContract {
  abi: readonly unknown[];
}

export interface SingletonContract extends RegistryContract {
  kind: "safe" | "safeL2";
}

export interface ChainRegistry {
  factories: Map<string, FactoryContract>;
  singletons: Map<string, SingletonContract>;
  handlers: Map<string, RegistryContract>;
}

export interface ChainRuntime {
  config: ChainConfig;
  chain: Chain;
  publicClient: PublicClient<Transport, Chain>;
  walletClient?: WalletClient<Transport, Chain, Account>;
  account?: Account;
  registry: ChainRegistry;
}

export interface SafeSetup {
  owners: Address[];
  threshold: bigint;
  to: Address;
  data: Hex;
  fallbackHandler: Address;
  paymentToken: Address;
  payment: bigint;
  paymentReceiver: Address;
}

export type ReplayMethod = "createProxyWithNonce" | "createProxyWithNonceL2";

export interface SafeCreationObservation {
  id: string;
  chainId: number;
  factory: Address;
  singleton: Address;
  safeAddress: Address;
  transactionHash: Hex;
  blockNumber: bigint;
  blockHash: Hex;
  logIndex: number;
  eventName: string;
  eventInitializer?: Hex;
  eventSaltNonce?: bigint;
}

export interface ReplayableSafeCreation extends SafeCreationObservation {
  fingerprint: Hex;
  version: SupportedSafeVersion;
  method: ReplayMethod;
  creator: Address;
  initializer: Hex;
  saltNonce: bigint;
  setup: SafeSetup;
}

export type JobStatus =
  | "pending"
  | "submitted"
  | "deployed"
  | "already_deployed"
  | "incompatible"
  | "conflict"
  | "retry";

export interface StoredDeployment {
  fingerprint: Hex;
  safeAddress: Address;
  factory: Address;
  singleton: Address;
  initializer: Hex;
  saltNonce: bigint;
  method: ReplayMethod;
  version: SupportedSafeVersion;
  creator: Address;
  owners: Address[];
  threshold: bigint;
  fallbackHandler: Address;
  sourceChainId: number;
  sourceTransactionHash: Hex;
  sourceBlockNumber: bigint;
  sourceBlockHash: Hex;
}

export interface StoredJob {
  fingerprint: Hex;
  targetChainId: number;
  status: JobStatus;
  transactionHash?: Hex;
  signedTransaction?: Hex;
  attempts: number;
  error?: string;
}
