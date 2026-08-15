import type { Address, Hex } from "viem";
import type { ChainRuntime, SafeCreationObservation } from "../types.js";

export interface AccountSnapshot {
  family: string;
  address: Address;
  owners: Address[];
  threshold: bigint;
}

export interface DeploymentPlan {
  targetAddress: Address;
  transactionTo: Address;
  transactionData: Hex;
  guarantees: {
    sameAddress: boolean;
    sameOwners: boolean;
    sameThreshold: boolean;
  };
}

/**
 * Extension boundary for translated wallet families. A future adapter must state
 * its guarantees explicitly; it must never silently label a policy translation
 * (for example, Safe to a non-EVM multisig) as an address-preserving clone.
 */
export interface AccountAdapter {
  readonly family: string;
  recover(observation: SafeCreationObservation, source: ChainRuntime): Promise<AccountSnapshot>;
  plan(snapshot: AccountSnapshot, target: ChainRuntime): Promise<DeploymentPlan>;
  verify(snapshot: AccountSnapshot, plan: DeploymentPlan, target: ChainRuntime): Promise<void>;
}
