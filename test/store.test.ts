import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { Address, Hex } from "viem";
import { zeroAddress } from "../src/contracts.js";
import { Store } from "../src/store.js";
import type { ReplayableSafeCreation } from "../src/types.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function fixture(): ReplayableSafeCreation {
  return {
    id: "1:tx:0",
    chainId: 1,
    factory: "0x1111111111111111111111111111111111111111" as Address,
    singleton: "0x2222222222222222222222222222222222222222" as Address,
    safeAddress: "0x3333333333333333333333333333333333333333" as Address,
    transactionHash: `0x${"4".repeat(64)}` as Hex,
    blockNumber: 1n,
    blockHash: `0x${"5".repeat(64)}` as Hex,
    logIndex: 0,
    eventName: "ProxyCreation",
    fingerprint: `0x${"6".repeat(64)}` as Hex,
    version: "1.4.1",
    method: "createProxyWithNonce",
    creator: "0x7777777777777777777777777777777777777777" as Address,
    initializer: "0x1234",
    saltNonce: 42n,
    setup: {
      owners: ["0x8888888888888888888888888888888888888888" as Address],
      threshold: 1n,
      to: zeroAddress,
      data: "0x",
      fallbackHandler: zeroAddress,
      paymentToken: zeroAddress,
      payment: 0n,
      paymentReceiver: zeroAddress,
    },
  };
}

describe("Store", () => {
  it("persists cursors and idempotent target jobs", () => {
    const directory = mkdtempSync(join(tmpdir(), "safe-everywhere-"));
    temporaryDirectories.push(directory);
    const store = new Store(join(directory, "state.sqlite"));
    const creation = fixture();
    try {
      store.setCursor(1, 123n);
      expect(store.getCursor(1)).toBe(123n);
      store.saveDeployment(creation);
      store.ensureJobs(creation.fingerprint, [10, 100]);
      store.ensureJobs(creation.fingerprint, [10, 100]);
      expect(store.listActionableJobs(10)).toHaveLength(2);
      expect(store.getDeployment(creation.fingerprint)).toMatchObject({
        saltNonce: 42n,
        owners: creation.setup.owners,
        sourceBlockNumber: 1n,
        sourceBlockHash: creation.blockHash,
      });
      store.markJob(creation.fingerprint, 100, "retry", { retryInSeconds: -1 });
      expect(store.listActionableJobs(10).map((job) => job.targetChainId)).toContain(100);
      store.markJob(creation.fingerprint, 10, "already_deployed");
      store.markJob(creation.fingerprint, 100, "submitted", {
        transactionHash: `0x${"9".repeat(64)}` as Hex,
        signedTransaction: "0x1234",
      });
      const startOfUtcDay = new Date();
      startOfUtcDay.setUTCHours(0, 0, 0, 0);
      expect(store.submittedSince(startOfUtcDay.toISOString())).toBe(1);
      expect(store.listSubmittedJobs()).toMatchObject([
        { targetChainId: 100, signedTransaction: "0x1234" },
      ]);
      expect(store.counts()).toEqual({ already_deployed: 1, submitted: 1 });
    } finally {
      store.close();
    }
  });

  it("migrates the pre-source-block schema in place", () => {
    const directory = mkdtempSync(join(tmpdir(), "safe-everywhere-migration-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "state.sqlite");
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      CREATE TABLE deployments (
        fingerprint TEXT PRIMARY KEY,
        safe_address TEXT NOT NULL,
        factory TEXT NOT NULL,
        singleton TEXT NOT NULL,
        initializer TEXT NOT NULL,
        salt_nonce TEXT NOT NULL,
        method TEXT NOT NULL,
        version TEXT NOT NULL,
        creator TEXT NOT NULL,
        owners_json TEXT NOT NULL,
        threshold_value TEXT NOT NULL,
        fallback_handler TEXT NOT NULL,
        source_chain_id INTEGER NOT NULL,
        source_transaction_hash TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE replication_jobs (
        fingerprint TEXT NOT NULL REFERENCES deployments(fingerprint),
        target_chain_id INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        transaction_hash TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        next_attempt_at TEXT,
        submitted_at TEXT,
        completed_at TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY(fingerprint, target_chain_id)
      );
    `);
    legacy.close();

    const store = new Store(path);
    try {
      const deploymentColumns = store.unsafeQueryForTests("PRAGMA table_info(deployments)") as {
        name: string;
      }[];
      const jobColumns = store.unsafeQueryForTests("PRAGMA table_info(replication_jobs)") as {
        name: string;
      }[];
      expect(deploymentColumns.map((column) => column.name)).toEqual(
        expect.arrayContaining(["source_block_number", "source_block_hash"]),
      );
      expect(jobColumns.map((column) => column.name)).toContain("signed_transaction");
      expect(store.unsafeQueryForTests("PRAGMA user_version")).toEqual([{ user_version: 2 }]);
    } finally {
      store.close();
    }
  });
});
