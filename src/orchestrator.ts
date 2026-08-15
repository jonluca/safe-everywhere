import {
  decodeFunctionResult,
  encodeFunctionData,
  getAddress,
  isAddressEqual,
  keccak256,
  parseTransaction,
} from "viem";
import type { Hex, Log } from "viem";
import { replayFactoryAbi, zeroAddress } from "./contracts.js";
import {
  DeploymentConflictError,
  IncompatibleTargetError,
  PolicyRejectionError,
  SafeConfigurationMismatchError,
  UnsupportedCreationError,
} from "./errors.js";
import { logger as defaultLogger } from "./logger.js";
import { verifyRegistryContract, verifyRpcIdentity } from "./runtime.js";
import {
  decodeFactoryLog,
  recoverReplayableCreation,
  revalidateStoredDeploymentPolicy,
  verifySafeConfiguration,
} from "./safe-adapter.js";
import { errorMessage } from "./sanitize.js";
import { Store } from "./store.js";
import type {
  AppConfig,
  ChainRuntime,
  RegistryContract,
  StoredDeployment,
  StoredJob,
} from "./types.js";

interface LoggerLike {
  debug(bindings: object, message: string): void;
  info(bindings: object, message: string): void;
  warn(bindings: object, message: string): void;
  error(bindings: object, message: string): void;
}

export interface RunSummary {
  observations: number;
  accepted: number;
  rejected: number;
  unsupported: number;
  failedChains: number;
  jobsProcessed: number;
  jobCounts: Record<string, number>;
}

function isEmptyCode(code: Hex | undefined): boolean {
  return !code || code === "0x";
}

export class Orchestrator {
  readonly #runtimeByChainId: Map<number, ChainRuntime>;
  readonly #verifiedContracts = new Set<string>();

  constructor(
    readonly config: AppConfig,
    readonly runtimes: ChainRuntime[],
    readonly store: Store,
    readonly execute: boolean,
    readonly log: LoggerLike = defaultLogger,
  ) {
    this.#runtimeByChainId = new Map(runtimes.map((runtime) => [runtime.config.chainId, runtime]));
  }

  async initialize(): Promise<void> {
    if (
      this.execute &&
      this.config.policy.allowedCreators.length === 0 &&
      this.config.policy.allowedSafeAddresses.length === 0
    ) {
      throw new Error("Execution requires at least one enrolled creator or Safe address");
    }
    await Promise.all(this.runtimes.map(verifyRpcIdentity));
    for (const runtime of this.runtimes.filter((candidate) => candidate.config.watch)) {
      for (const factory of runtime.registry.factories.values()) {
        await this.#verifyContract(runtime, factory);
      }
    }
  }

  async #verifyContract(runtime: ChainRuntime, contract: RegistryContract): Promise<void> {
    const key = `${runtime.config.chainId}:${contract.address.toLowerCase()}:${contract.codeHash}`;
    if (this.#verifiedContracts.has(key)) return;
    await verifyRegistryContract(runtime, contract);
    this.#verifiedContracts.add(key);
  }

  async runOnce(): Promise<RunSummary> {
    const summary: RunSummary = {
      observations: 0,
      accepted: 0,
      rejected: 0,
      unsupported: 0,
      failedChains: 0,
      jobsProcessed: 0,
      jobCounts: {},
    };
    const watchRuntimes = this.runtimes.filter((runtime) => runtime.config.watch);
    const results = await Promise.allSettled(
      watchRuntimes.map((runtime) => this.#scanChain(runtime, summary)),
    );
    for (let index = 0; index < results.length; index += 1) {
      const result = results[index];
      if (result?.status !== "rejected") continue;
      const runtime = watchRuntimes[index];
      summary.failedChains += 1;
      this.log.error(
        { chainId: runtime?.config.chainId, error: errorMessage(result.reason) },
        "Chain scan failed; cursor was not advanced past the failed range",
      );
    }

    const startOfUtcDay = new Date();
    startOfUtcDay.setUTCHours(0, 0, 0, 0);
    const submittedToday = this.store.submittedSince(startOfUtcDay.toISOString());
    const dailyRemaining = Math.max(0, this.config.policy.maxDeploymentsPerDay - submittedToday);
    const jobLimit = this.execute
      ? Math.min(this.config.policy.maxDeploymentsPerRun, dailyRemaining)
      : this.config.policy.maxDeploymentsPerRun;
    if (this.execute && jobLimit === 0) {
      this.log.warn(
        { submittedToday, limit: this.config.policy.maxDeploymentsPerDay },
        "Daily deployment circuit breaker is active",
      );
    }
    const enabledTargetChainIds = this.runtimes
      .filter((runtime) => runtime.config.deploy)
      .map((runtime) => runtime.config.chainId);
    const submittedJobs = this.store.listSubmittedJobs();
    const busyTargetChainIds = new Set(submittedJobs.map((job) => job.targetChainId));
    for (let index = 0; index < submittedJobs.length; index += 8) {
      const batch = submittedJobs.slice(index, index + 8);
      await Promise.all(batch.map((job) => this.#processJob(job)));
      summary.jobsProcessed += batch.length;
    }
    const jobs = this.store.listActionableJobs(
      jobLimit,
      enabledTargetChainIds.filter((chainId) => !busyTargetChainIds.has(chainId)),
    );
    for (const job of jobs) {
      await this.#processJob(job);
      summary.jobsProcessed += 1;
    }
    summary.jobCounts = this.store.counts();
    return summary;
  }

  async #scanChain(runtime: ChainRuntime, summary: RunSummary): Promise<void> {
    const head = await runtime.publicClient.getBlockNumber();
    if (head < BigInt(runtime.config.confirmations)) return;
    const safeHead = head - BigInt(runtime.config.confirmations);
    const cursor = this.store.getCursor(runtime.config.chainId);
    let fromBlock: bigint;
    if (cursor === undefined) {
      fromBlock =
        runtime.config.startBlock === "latest"
          ? safeHead > this.config.reorgLookbackBlocks
            ? safeHead - this.config.reorgLookbackBlocks
            : 0n
          : runtime.config.startBlock;
    } else {
      fromBlock =
        cursor > this.config.reorgLookbackBlocks ? cursor - this.config.reorgLookbackBlocks : 0n;
      if (runtime.config.startBlock !== "latest" && fromBlock < runtime.config.startBlock) {
        fromBlock = runtime.config.startBlock;
      }
    }
    if (fromBlock > safeHead) return;

    const addresses = [...runtime.registry.factories.values()].map((factory) => factory.address);
    if (addresses.length === 0) {
      throw new Error(`No supported Safe factories registered for ${runtime.config.name}`);
    }
    while (fromBlock <= safeHead) {
      const toBlock =
        fromBlock + this.config.maxBlockRange - 1n < safeHead
          ? fromBlock + this.config.maxBlockRange - 1n
          : safeHead;
      const logs = await runtime.publicClient.getLogs({ address: addresses, fromBlock, toBlock });
      const ordered = [...logs].sort((left, right) => {
        if (left.blockNumber !== right.blockNumber) {
          return Number((left.blockNumber ?? 0n) - (right.blockNumber ?? 0n));
        }
        return (left.logIndex ?? 0) - (right.logIndex ?? 0);
      });
      for (const rawLog of ordered) {
        await this.#processFactoryLog(runtime, rawLog, summary);
      }
      this.store.setCursor(runtime.config.chainId, toBlock + 1n);
      fromBlock = toBlock + 1n;
    }
  }

  async #processFactoryLog(runtime: ChainRuntime, log: Log, summary: RunSummary): Promise<void> {
    const factory = runtime.registry.factories.get(log.address.toLowerCase());
    if (!factory) return;
    let observation;
    try {
      observation = decodeFactoryLog(runtime.config.chainId, factory, log);
    } catch (error) {
      this.log.warn(
        {
          chainId: runtime.config.chainId,
          transactionHash: log.transactionHash,
          error: errorMessage(error),
        },
        "Ignored undecodable factory log",
      );
      return;
    }
    if (!observation) return;
    summary.observations += 1;
    this.store.recordObservation(observation);
    const existingStatus = this.store.getObservationStatus(observation.id);
    if (existingStatus && !["observed", "error"].includes(existingStatus)) return;

    try {
      const sourceBlock = await runtime.publicClient.getBlock({
        blockNumber: observation.blockNumber,
      });
      if (
        !sourceBlock.hash ||
        sourceBlock.hash.toLowerCase() !== observation.blockHash.toLowerCase()
      ) {
        throw new Error("Source block is no longer canonical");
      }
      const creation = await recoverReplayableCreation(runtime, this.config, observation);
      const sourceSingleton = runtime.registry.singletons.get(creation.singleton.toLowerCase());
      if (!sourceSingleton) throw new Error("Accepted creation lost its singleton registry entry");
      await this.#verifyContract(runtime, sourceSingleton);
      if (!isAddressEqual(creation.setup.fallbackHandler, zeroAddress)) {
        const sourceHandler = runtime.registry.handlers.get(
          creation.setup.fallbackHandler.toLowerCase(),
        );
        if (!sourceHandler)
          throw new Error("Accepted creation lost its fallback-handler registry entry");
        await this.#verifyContract(runtime, sourceHandler);
      }
      this.store.saveDeployment(creation);
      const targetChainIds = this.runtimes
        .filter((target) => target.config.deploy && target.config.chainId !== creation.chainId)
        .slice(0, this.config.policy.maxTargetsPerSafe)
        .map((target) => target.config.chainId);
      this.store.ensureJobs(creation.fingerprint, targetChainIds);
      this.store.markObservation(observation.id, "accepted", undefined, creation.fingerprint);
      summary.accepted += 1;
      this.log.info(
        {
          sourceChainId: creation.chainId,
          safeAddress: creation.safeAddress,
          version: creation.version,
          targets: targetChainIds,
        },
        "Accepted replayable Safe creation",
      );
    } catch (error) {
      if (error instanceof PolicyRejectionError) {
        this.store.markObservation(observation.id, "rejected", error.message);
        summary.rejected += 1;
        this.log.info(
          {
            chainId: observation.chainId,
            safeAddress: observation.safeAddress,
            reason: error.message,
          },
          "Safe creation rejected by policy",
        );
        return;
      }
      if (error instanceof UnsupportedCreationError) {
        this.store.markObservation(observation.id, "unsupported", error.message);
        summary.unsupported += 1;
        this.log.warn(
          {
            chainId: observation.chainId,
            safeAddress: observation.safeAddress,
            reason: error.message,
          },
          "Safe creation is not automatically replayable",
        );
        return;
      }
      this.store.markObservation(observation.id, "error", errorMessage(error));
      throw error;
    }
  }

  async #reconcileSubmittedJob(
    runtime: ChainRuntime,
    deployment: StoredDeployment,
    job: StoredJob,
    sourceState: "canonical" | "orphaned" | "unknown",
    allowRebroadcast: boolean,
  ): Promise<void> {
    if (!job.transactionHash) {
      throw new DeploymentConflictError("Submitted job is missing its transaction hash");
    }
    if (job.signedTransaction && allowRebroadcast) {
      try {
        const rebroadcastHash = await runtime.publicClient.sendRawTransaction({
          serializedTransaction: job.signedTransaction,
        });
        if (rebroadcastHash.toLowerCase() !== job.transactionHash.toLowerCase()) {
          throw new DeploymentConflictError("Rebroadcast transaction hash changed");
        }
      } catch (error) {
        if (error instanceof DeploymentConflictError) throw error;
        this.log.debug(
          {
            targetChainId: job.targetChainId,
            transactionHash: job.transactionHash,
            error: errorMessage(error),
          },
          "Signed deployment rebroadcast was not accepted; checking its receipt",
        );
      }
    }
    let receipt;
    try {
      receipt = await runtime.publicClient.getTransactionReceipt({ hash: job.transactionHash });
    } catch {
      this.log.debug(
        { targetChainId: job.targetChainId, transactionHash: job.transactionHash },
        "Submitted deployment is still pending",
      );
      return;
    }
    const [targetHead, receiptBlock] = await Promise.all([
      runtime.publicClient.getBlockNumber(),
      runtime.publicClient.getBlock({ blockNumber: receipt.blockNumber }),
    ]);
    if (!receiptBlock.hash || receiptBlock.hash.toLowerCase() !== receipt.blockHash.toLowerCase()) {
      this.log.warn(
        { targetChainId: job.targetChainId, transactionHash: job.transactionHash },
        "Deployment receipt was reorganized; keeping the signed transaction submitted",
      );
      return;
    }
    const confirmations =
      targetHead >= receipt.blockNumber ? targetHead - receipt.blockNumber + 1n : 0n;
    if (confirmations < BigInt(runtime.config.confirmations)) {
      this.log.debug(
        {
          targetChainId: job.targetChainId,
          transactionHash: job.transactionHash,
          confirmations: confirmations.toString(),
          requiredConfirmations: runtime.config.confirmations,
        },
        "Submitted deployment is mined but not final enough",
      );
      return;
    }
    if (receipt.status === "reverted") {
      throw new DeploymentConflictError("Finalized deployment transaction reverted");
    }
    try {
      await verifySafeConfiguration(runtime, deployment);
    } catch (error) {
      if (error instanceof SafeConfigurationMismatchError) {
        throw new DeploymentConflictError(`Mined deployment failed verification: ${error.message}`);
      }
      throw error;
    }
    if (sourceState === "unknown") {
      this.log.error(
        { sourceChainId: deployment.sourceChainId, targetChainId: job.targetChainId },
        "Target deployment is final but source canonicality is still unknown",
      );
      return;
    }
    this.store.markJob(
      job.fingerprint,
      job.targetChainId,
      sourceState === "orphaned" ? "conflict" : "deployed",
      {
        transactionHash: job.transactionHash,
        ...(sourceState === "orphaned"
          ? { error: "Source creation was reorganized after target deployment" }
          : {}),
      },
    );
  }

  async #assertTargetOwnerPolicy(
    runtime: ChainRuntime,
    deployment: StoredDeployment,
  ): Promise<void> {
    if (this.config.policy.allowContractOwners) return;
    for (const owner of deployment.owners) {
      const ownerCode = await runtime.publicClient.getCode({ address: owner });
      if (!isEmptyCode(ownerCode)) {
        throw new PolicyRejectionError(`Owner ${owner} has contract code on the target chain`);
      }
    }
  }

  #signedTransactionMatchesCurrentCaps(deployment: StoredDeployment, job: StoredJob): boolean {
    if (
      !job.signedTransaction ||
      !job.transactionHash ||
      keccak256(job.signedTransaction).toLowerCase() !== job.transactionHash.toLowerCase()
    ) {
      return false;
    }
    try {
      const transaction = parseTransaction(job.signedTransaction);
      const expectedData = encodeFunctionData({
        abi: replayFactoryAbi,
        functionName: deployment.method,
        args: [deployment.singleton, deployment.initializer, deployment.saltNonce],
      });
      const fee = transaction.maxFeePerGas ?? transaction.gasPrice;
      return (
        transaction.chainId === job.targetChainId &&
        transaction.to !== null &&
        transaction.to !== undefined &&
        isAddressEqual(transaction.to, deployment.factory) &&
        transaction.data !== undefined &&
        transaction.data.toLowerCase() === expectedData.toLowerCase() &&
        (transaction.value ?? 0n) === 0n &&
        transaction.gas !== undefined &&
        transaction.gas <= this.config.policy.maxEstimatedGas &&
        fee !== undefined &&
        fee <= this.config.policy.maxFeePerGasWei
      );
    } catch (error) {
      this.log.error(
        { targetChainId: job.targetChainId, error: errorMessage(error) },
        "Persisted signed transaction could not be revalidated",
      );
      return false;
    }
  }

  async #processJob(job: StoredJob): Promise<void> {
    const deployment = this.store.getDeployment(job.fingerprint);
    const runtime = this.#runtimeByChainId.get(job.targetChainId);
    if (!deployment) {
      this.store.markJob(job.fingerprint, job.targetChainId, "incompatible", {
        error: "Deployment record is missing",
      });
      return;
    }
    if (!runtime) {
      if (job.status === "submitted") {
        this.log.error(
          { targetChainId: job.targetChainId, transactionHash: job.transactionHash },
          "Submitted deployment cannot be reconciled until the target chain is configured again",
        );
      } else {
        this.store.markJob(job.fingerprint, job.targetChainId, "incompatible", {
          error: "Target chain configuration is missing",
        });
      }
      return;
    }
    if (job.status !== "submitted" && !runtime.config.deploy) {
      this.log.info({ targetChainId: job.targetChainId }, "Target deployment is paused by config");
      return;
    }

    let submittedHash: Hex | undefined;
    try {
      const sourceRuntime = this.#runtimeByChainId.get(deployment.sourceChainId);
      if (job.status === "submitted") {
        let sourceState: "canonical" | "orphaned" | "unknown" = "unknown";
        let allowRebroadcast = false;
        if (!sourceRuntime) {
          this.log.error(
            {
              sourceChainId: deployment.sourceChainId,
              targetChainId: job.targetChainId,
              transactionHash: job.transactionHash,
            },
            "Source chain is unavailable; target receipt will be monitored without rebroadcast",
          );
        } else {
          try {
            const sourceBlock = await sourceRuntime.publicClient.getBlock({
              blockNumber: deployment.sourceBlockNumber,
            });
            const sourceOrphaned =
              !sourceBlock.hash ||
              sourceBlock.hash.toLowerCase() !== deployment.sourceBlockHash.toLowerCase();
            sourceState = sourceOrphaned ? "orphaned" : "canonical";
            if (sourceOrphaned) {
              this.log.error(
                {
                  sourceChainId: deployment.sourceChainId,
                  targetChainId: job.targetChainId,
                  transactionHash: job.transactionHash,
                },
                "Source creation was reorganized after target submission",
              );
            } else if (this.execute && runtime.config.deploy && runtime.config.create2Compatible) {
              try {
                await revalidateStoredDeploymentPolicy(sourceRuntime, this.config, deployment);
                await this.#assertTargetOwnerPolicy(runtime, deployment);
                const factory = runtime.registry.factories.get(deployment.factory.toLowerCase());
                const singleton = runtime.registry.singletons.get(
                  deployment.singleton.toLowerCase(),
                );
                if (!factory || !singleton) {
                  throw new PolicyRejectionError(
                    "Matching factory/singleton is no longer registered on target",
                  );
                }
                await this.#verifyContract(runtime, factory);
                await this.#verifyContract(runtime, singleton);
                if (!isAddressEqual(deployment.fallbackHandler, zeroAddress)) {
                  const handler = runtime.registry.handlers.get(
                    deployment.fallbackHandler.toLowerCase(),
                  );
                  if (!handler) {
                    throw new PolicyRejectionError(
                      "Matching fallback handler is no longer registered on target",
                    );
                  }
                  await this.#verifyContract(runtime, handler);
                }
                allowRebroadcast = this.#signedTransactionMatchesCurrentCaps(deployment, job);
              } catch (error) {
                this.log.error(
                  {
                    targetChainId: job.targetChainId,
                    transactionHash: job.transactionHash,
                    error: errorMessage(error),
                  },
                  "Current policy blocked signed deployment rebroadcast",
                );
              }
            }
          } catch (error) {
            this.log.error(
              {
                sourceChainId: deployment.sourceChainId,
                targetChainId: job.targetChainId,
                error: errorMessage(error),
              },
              "Source finality could not be rechecked; target receipt will be monitored without rebroadcast",
            );
          }
        }
        await this.#reconcileSubmittedJob(runtime, deployment, job, sourceState, allowRebroadcast);
        return;
      }
      if (!sourceRuntime) {
        throw new IncompatibleTargetError("Source chain is no longer configured");
      }
      const sourceBlock = await sourceRuntime.publicClient.getBlock({
        blockNumber: deployment.sourceBlockNumber,
      });
      if (
        !sourceBlock.hash ||
        sourceBlock.hash.toLowerCase() !== deployment.sourceBlockHash.toLowerCase()
      ) {
        throw new DeploymentConflictError(
          "Source creation block was reorganized before deployment",
        );
      }
      if (!runtime.config.create2Compatible) {
        throw new IncompatibleTargetError("Target is not marked CREATE2-compatible");
      }
      const factory = runtime.registry.factories.get(deployment.factory.toLowerCase());
      const singleton = runtime.registry.singletons.get(deployment.singleton.toLowerCase());
      if (!factory || factory.version !== deployment.version) {
        throw new IncompatibleTargetError("Matching factory/version is not registered on target");
      }
      if (!singleton || singleton.version !== deployment.version) {
        throw new IncompatibleTargetError("Matching singleton/version is not registered on target");
      }
      await this.#verifyContract(runtime, factory);
      await this.#verifyContract(runtime, singleton);
      if (!isAddressEqual(deployment.fallbackHandler, zeroAddress)) {
        const handler = runtime.registry.handlers.get(deployment.fallbackHandler.toLowerCase());
        if (!handler) {
          throw new IncompatibleTargetError(
            "Matching fallback handler is not registered on target",
          );
        }
        await this.#verifyContract(runtime, handler);
      }

      const targetCode = await runtime.publicClient.getCode({ address: deployment.safeAddress });
      if (!isEmptyCode(targetCode)) {
        try {
          await verifySafeConfiguration(runtime, deployment);
        } catch (error) {
          if (error instanceof SafeConfigurationMismatchError) {
            throw new DeploymentConflictError(
              `Target address has incompatible code: ${error.message}`,
            );
          }
          throw error;
        }
        this.store.markJob(job.fingerprint, job.targetChainId, "already_deployed");
        return;
      }

      try {
        await revalidateStoredDeploymentPolicy(sourceRuntime, this.config, deployment);
      } catch (error) {
        if (error instanceof PolicyRejectionError) {
          throw new IncompatibleTargetError(`Current policy rejected deployment: ${error.message}`);
        }
        throw error;
      }
      try {
        await this.#assertTargetOwnerPolicy(runtime, deployment);
      } catch (error) {
        if (error instanceof PolicyRejectionError) {
          throw new IncompatibleTargetError(error.message);
        }
        throw error;
      }

      const data = encodeFunctionData({
        abi: replayFactoryAbi,
        functionName: deployment.method,
        args: [deployment.singleton, deployment.initializer, deployment.saltNonce],
      });
      const from = runtime.account?.address ?? zeroAddress;
      const simulation = await runtime.publicClient.call({
        account: from,
        to: deployment.factory,
        data,
      });
      if (!simulation.data)
        throw new IncompatibleTargetError("Factory simulation returned no address");
      const predicted = getAddress(
        decodeFunctionResult({
          abi: replayFactoryAbi,
          functionName: deployment.method,
          data: simulation.data,
        }),
      );
      if (!isAddressEqual(predicted, deployment.safeAddress)) {
        throw new IncompatibleTargetError(
          `Predicted target ${predicted} differs from source ${deployment.safeAddress}`,
        );
      }
      const gas = await runtime.publicClient.estimateGas({
        account: from,
        to: deployment.factory,
        data,
      });
      if (gas > this.config.policy.maxEstimatedGas) {
        throw new IncompatibleTargetError(
          `Estimated gas ${gas} exceeds policy limit ${this.config.policy.maxEstimatedGas}`,
        );
      }
      const fees = await runtime.publicClient.estimateFeesPerGas();
      const maximumFee = fees.maxFeePerGas ?? fees.gasPrice;
      if (maximumFee > this.config.policy.maxFeePerGasWei) {
        throw new Error(
          `Current maximum fee ${maximumFee} exceeds policy limit ${this.config.policy.maxFeePerGasWei}`,
        );
      }

      if (!this.execute) {
        this.log.info(
          {
            targetChainId: job.targetChainId,
            safeAddress: deployment.safeAddress,
            factory: deployment.factory,
            estimatedGas: gas.toString(),
          },
          "Dry run: Safe deployment is compatible and ready",
        );
        return;
      }
      if (!runtime.walletClient || !runtime.account) {
        throw new Error("Execution runtime has no signer");
      }
      const request = await runtime.walletClient.prepareTransactionRequest({
        account: runtime.account,
        chain: runtime.chain,
        to: deployment.factory,
        data,
        gas,
        ...(fees.maxFeePerGas === undefined
          ? { gasPrice: fees.gasPrice }
          : {
              maxFeePerGas: fees.maxFeePerGas,
              maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
            }),
      });
      const signedTransaction = await runtime.walletClient.signTransaction(request);
      const hash = keccak256(signedTransaction);
      this.store.markJob(job.fingerprint, job.targetChainId, "submitted", {
        transactionHash: hash,
        signedTransaction,
      });
      submittedHash = hash;
      const broadcastHash = await runtime.publicClient.sendRawTransaction({
        serializedTransaction: signedTransaction,
      });
      if (broadcastHash.toLowerCase() !== hash.toLowerCase()) {
        throw new DeploymentConflictError("RPC returned a different transaction hash");
      }
      this.log.info(
        {
          targetChainId: job.targetChainId,
          safeAddress: deployment.safeAddress,
          transactionHash: hash,
        },
        "Safe deployment submitted; later polling cycles will verify finality and configuration",
      );
    } catch (error) {
      if (error instanceof IncompatibleTargetError) {
        this.store.markJob(job.fingerprint, job.targetChainId, "incompatible", {
          error: error.message,
        });
        this.log.warn(
          {
            targetChainId: job.targetChainId,
            safeAddress: deployment.safeAddress,
            reason: error.message,
          },
          "Target is incompatible",
        );
        return;
      }
      if (error instanceof DeploymentConflictError) {
        this.store.markJob(job.fingerprint, job.targetChainId, "conflict", {
          error: error.message,
        });
        this.log.error(
          {
            targetChainId: job.targetChainId,
            safeAddress: deployment.safeAddress,
            reason: error.message,
          },
          "Target deployment conflict",
        );
        return;
      }
      const persistedSubmittedHash =
        submittedHash ?? (job.status === "submitted" ? job.transactionHash : undefined);
      if (persistedSubmittedHash) {
        this.log.error(
          {
            targetChainId: job.targetChainId,
            safeAddress: deployment.safeAddress,
            transactionHash: persistedSubmittedHash,
            error: errorMessage(error),
          },
          "Deployment was submitted; receipt reconciliation will continue on the next run",
        );
        return;
      }
      const retryInSeconds = Math.min(3_600, 2 ** Math.min(job.attempts, 10) * 15);
      this.store.markJob(job.fingerprint, job.targetChainId, "retry", {
        error: errorMessage(error),
        retryInSeconds,
      });
      this.log.error(
        {
          targetChainId: job.targetChainId,
          safeAddress: deployment.safeAddress,
          retryInSeconds,
          error: errorMessage(error),
        },
        "Target deployment failed and will retry",
      );
    }
  }
}
