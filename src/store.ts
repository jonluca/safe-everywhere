import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { Address, Hex } from "viem";
import type {
  JobStatus,
  ReplayableSafeCreation,
  SafeCreationObservation,
  StoredDeployment,
  StoredJob,
} from "./types.js";

interface DeploymentRow {
  fingerprint: string;
  safe_address: string;
  factory: string;
  singleton: string;
  initializer: string;
  salt_nonce: string;
  method: string;
  version: string;
  creator: string;
  owners_json: string;
  threshold_value: string;
  fallback_handler: string;
  source_chain_id: number;
  source_transaction_hash: string;
  source_block_number: string | null;
  source_block_hash: string | null;
}

interface JobRow {
  fingerprint: string;
  target_chain_id: number;
  status: JobStatus;
  transaction_hash: string | null;
  signed_transaction: string | null;
  attempts: number;
  error: string | null;
}

export class Store {
  readonly #database: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.#database = new DatabaseSync(path);
    this.#database.exec(
      "PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;",
    );
    this.#migrate();
  }

  #migrate(): void {
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS chain_cursors (
        chain_id INTEGER PRIMARY KEY,
        next_block TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS observations (
        id TEXT PRIMARY KEY,
        chain_id INTEGER NOT NULL,
        factory TEXT NOT NULL,
        singleton TEXT NOT NULL,
        safe_address TEXT NOT NULL,
        transaction_hash TEXT NOT NULL,
        block_number TEXT NOT NULL,
        block_hash TEXT NOT NULL,
        log_index INTEGER NOT NULL,
        event_name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'observed',
        error TEXT,
        fingerprint TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE UNIQUE INDEX IF NOT EXISTS observations_chain_log
        ON observations(chain_id, transaction_hash, log_index);

      CREATE TABLE IF NOT EXISTS deployments (
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
        source_block_number TEXT NOT NULL,
        source_block_hash TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS replication_jobs (
        fingerprint TEXT NOT NULL REFERENCES deployments(fingerprint),
        target_chain_id INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        transaction_hash TEXT,
        signed_transaction TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        next_attempt_at TEXT,
        submitted_at TEXT,
        completed_at TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY(fingerprint, target_chain_id)
      );
      CREATE INDEX IF NOT EXISTS replication_jobs_actionable
        ON replication_jobs(status, next_attempt_at);
    `);

    const deploymentColumns = new Set(
      (
        this.#database.prepare("PRAGMA table_info(deployments)").all() as unknown as {
          name: string;
        }[]
      ).map((column) => column.name),
    );
    let invalidatedLegacyJobs = false;
    if (!deploymentColumns.has("source_block_number")) {
      this.#database.exec("ALTER TABLE deployments ADD COLUMN source_block_number TEXT");
      invalidatedLegacyJobs = true;
    }
    if (!deploymentColumns.has("source_block_hash")) {
      this.#database.exec("ALTER TABLE deployments ADD COLUMN source_block_hash TEXT");
      invalidatedLegacyJobs = true;
    }
    const jobColumns = new Set(
      (
        this.#database.prepare("PRAGMA table_info(replication_jobs)").all() as unknown as {
          name: string;
        }[]
      ).map((column) => column.name),
    );
    if (!jobColumns.has("signed_transaction")) {
      this.#database.exec("ALTER TABLE replication_jobs ADD COLUMN signed_transaction TEXT");
    }
    if (invalidatedLegacyJobs) {
      this.#database
        .prepare(
          `UPDATE observations
           SET status = 'error',
               error = 'Legacy deployment must be revalidated to recover source block identity',
               updated_at = CURRENT_TIMESTAMP
           WHERE fingerprint IN (
             SELECT fingerprint FROM deployments
             WHERE source_block_number IS NULL OR source_block_hash IS NULL
           )`,
        )
        .run();
      this.#database
        .prepare(
          `UPDATE replication_jobs
           SET status = 'incompatible',
               error = 'Legacy job lacks source block identity; rescan the source creation',
               completed_at = CURRENT_TIMESTAMP,
               updated_at = CURRENT_TIMESTAMP
           WHERE status IN ('pending', 'retry', 'submitted')`,
        )
        .run();
    }
    this.#database.exec("PRAGMA user_version = 2");
  }

  close(): void {
    this.#database.close();
  }

  getCursor(chainId: number): bigint | undefined {
    const row = this.#database
      .prepare("SELECT next_block FROM chain_cursors WHERE chain_id = ?")
      .get(chainId) as { next_block: string } | undefined;
    return row ? BigInt(row.next_block) : undefined;
  }

  setCursor(chainId: number, nextBlock: bigint): void {
    this.#database
      .prepare(
        `INSERT INTO chain_cursors(chain_id, next_block)
         VALUES (?, ?)
         ON CONFLICT(chain_id) DO UPDATE SET
           next_block = excluded.next_block,
           updated_at = CURRENT_TIMESTAMP`,
      )
      .run(chainId, nextBlock.toString());
  }

  recordObservation(observation: SafeCreationObservation): boolean {
    const result = this.#database
      .prepare(
        `INSERT OR IGNORE INTO observations(
           id, chain_id, factory, singleton, safe_address, transaction_hash,
           block_number, block_hash, log_index, event_name
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        observation.id,
        observation.chainId,
        observation.factory,
        observation.singleton,
        observation.safeAddress,
        observation.transactionHash,
        observation.blockNumber.toString(),
        observation.blockHash,
        observation.logIndex,
        observation.eventName,
      );
    return result.changes > 0;
  }

  getObservationStatus(id: string): string | undefined {
    const row = this.#database.prepare("SELECT status FROM observations WHERE id = ?").get(id) as
      | { status: string }
      | undefined;
    return row?.status;
  }

  markObservation(id: string, status: string, error?: string, fingerprint?: Hex): void {
    this.#database
      .prepare(
        `UPDATE observations
         SET status = ?, error = ?, fingerprint = COALESCE(?, fingerprint), updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
      )
      .run(status, error ?? null, fingerprint ?? null, id);
  }

  saveDeployment(creation: ReplayableSafeCreation): void {
    this.#database
      .prepare(
        `INSERT INTO deployments(
           fingerprint, safe_address, factory, singleton, initializer, salt_nonce,
           method, version, creator, owners_json, threshold_value, fallback_handler,
           source_chain_id, source_transaction_hash, source_block_number, source_block_hash
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(fingerprint) DO UPDATE SET
           source_chain_id = excluded.source_chain_id,
           source_transaction_hash = excluded.source_transaction_hash,
           source_block_number = excluded.source_block_number,
           source_block_hash = excluded.source_block_hash
         WHERE deployments.source_block_number IS NULL OR deployments.source_block_hash IS NULL`,
      )
      .run(
        creation.fingerprint,
        creation.safeAddress,
        creation.factory,
        creation.singleton,
        creation.initializer,
        creation.saltNonce.toString(),
        creation.method,
        creation.version,
        creation.creator,
        JSON.stringify(creation.setup.owners),
        creation.setup.threshold.toString(),
        creation.setup.fallbackHandler,
        creation.chainId,
        creation.transactionHash,
        creation.blockNumber.toString(),
        creation.blockHash,
      );
  }

  getDeployment(fingerprint: Hex): StoredDeployment | undefined {
    const row = this.#database
      .prepare("SELECT * FROM deployments WHERE fingerprint = ?")
      .get(fingerprint) as unknown as DeploymentRow | undefined;
    if (!row) return undefined;
    if (!row.source_block_number || !row.source_block_hash) {
      throw new Error(
        `Deployment ${fingerprint} predates source-block verification and cannot run`,
      );
    }
    return {
      fingerprint: row.fingerprint as Hex,
      safeAddress: row.safe_address as Address,
      factory: row.factory as Address,
      singleton: row.singleton as Address,
      initializer: row.initializer as Hex,
      saltNonce: BigInt(row.salt_nonce),
      method: row.method as StoredDeployment["method"],
      version: row.version as StoredDeployment["version"],
      creator: row.creator as Address,
      owners: JSON.parse(row.owners_json) as Address[],
      threshold: BigInt(row.threshold_value),
      fallbackHandler: row.fallback_handler as Address,
      sourceChainId: row.source_chain_id,
      sourceTransactionHash: row.source_transaction_hash as Hex,
      sourceBlockNumber: BigInt(row.source_block_number),
      sourceBlockHash: row.source_block_hash as Hex,
    };
  }

  ensureJobs(fingerprint: Hex, targetChainIds: number[]): void {
    const insert = this.#database.prepare(
      `INSERT INTO replication_jobs(fingerprint, target_chain_id) VALUES (?, ?)
       ON CONFLICT(fingerprint, target_chain_id) DO UPDATE SET
         status = CASE
           WHEN replication_jobs.status = 'incompatible'
             AND replication_jobs.error LIKE 'Legacy job lacks source block identity%'
           THEN 'pending'
           ELSE replication_jobs.status
         END,
         error = CASE
           WHEN replication_jobs.status = 'incompatible'
             AND replication_jobs.error LIKE 'Legacy job lacks source block identity%'
           THEN NULL
           ELSE replication_jobs.error
         END,
         completed_at = CASE
           WHEN replication_jobs.status = 'incompatible'
             AND replication_jobs.error LIKE 'Legacy job lacks source block identity%'
           THEN NULL
           ELSE replication_jobs.completed_at
         END,
         updated_at = CURRENT_TIMESTAMP`,
    );
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      for (const chainId of targetChainIds) insert.run(fingerprint, chainId);
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  listActionableJobs(limit: number, targetChainIds?: number[]): StoredJob[] {
    if (targetChainIds?.length === 0) return [];
    const targetFilter = targetChainIds
      ? `AND target_chain_id IN (${targetChainIds.map(() => "?").join(", ")})`
      : "";
    const rows = this.#database
      .prepare(
        `SELECT fingerprint, target_chain_id, status, transaction_hash, signed_transaction, attempts, error
         FROM (
           SELECT fingerprint, target_chain_id, status, transaction_hash, signed_transaction,
                  attempts, error, created_at,
                  ROW_NUMBER() OVER (PARTITION BY target_chain_id ORDER BY created_at, fingerprint) AS target_rank
           FROM replication_jobs
           WHERE status IN ('pending', 'retry')
             AND (next_attempt_at IS NULL OR datetime(next_attempt_at) <= CURRENT_TIMESTAMP)
             ${targetFilter}
         )
         WHERE target_rank = 1
         ORDER BY created_at, target_chain_id
         LIMIT ?`,
      )
      .all(...(targetChainIds ?? []), limit) as unknown as JobRow[];
    return rows.map((row) => ({
      fingerprint: row.fingerprint as Hex,
      targetChainId: row.target_chain_id,
      status: row.status,
      ...(row.transaction_hash ? { transactionHash: row.transaction_hash as Hex } : {}),
      ...(row.signed_transaction ? { signedTransaction: row.signed_transaction as Hex } : {}),
      attempts: row.attempts,
      ...(row.error ? { error: row.error } : {}),
    }));
  }

  listSubmittedJobs(): StoredJob[] {
    const rows = this.#database
      .prepare(
        `SELECT fingerprint, target_chain_id, status, transaction_hash, signed_transaction, attempts, error
         FROM replication_jobs
         WHERE status = 'submitted'
         ORDER BY submitted_at, target_chain_id`,
      )
      .all() as unknown as JobRow[];
    return rows.map((row) => ({
      fingerprint: row.fingerprint as Hex,
      targetChainId: row.target_chain_id,
      status: row.status,
      ...(row.transaction_hash ? { transactionHash: row.transaction_hash as Hex } : {}),
      ...(row.signed_transaction ? { signedTransaction: row.signed_transaction as Hex } : {}),
      attempts: row.attempts,
      ...(row.error ? { error: row.error } : {}),
    }));
  }

  submittedSince(isoTimestamp: string): number {
    const row = this.#database
      .prepare("SELECT COUNT(*) AS count FROM replication_jobs WHERE submitted_at >= datetime(?)")
      .get(isoTimestamp) as { count: number };
    return row.count;
  }

  markJob(
    fingerprint: Hex,
    targetChainId: number,
    status: JobStatus,
    options: {
      transactionHash?: Hex;
      signedTransaction?: Hex;
      error?: string;
      retryInSeconds?: number;
    } = {},
  ): void {
    const isAttempt = status === "submitted" || status === "retry";
    const isComplete = ["deployed", "already_deployed", "incompatible", "conflict"].includes(
      status,
    );
    const nextAttempt = options.retryInSeconds
      ? new Date(Date.now() + options.retryInSeconds * 1_000).toISOString()
      : null;
    this.#database
      .prepare(
        `UPDATE replication_jobs SET
           status = ?,
           transaction_hash = COALESCE(?, transaction_hash),
           signed_transaction = COALESCE(?, signed_transaction),
           attempts = attempts + ?,
           error = ?,
           next_attempt_at = ?,
           submitted_at = CASE WHEN ? = 'submitted' THEN CURRENT_TIMESTAMP ELSE submitted_at END,
           completed_at = CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE completed_at END,
           updated_at = CURRENT_TIMESTAMP
         WHERE fingerprint = ? AND target_chain_id = ?`,
      )
      .run(
        status,
        options.transactionHash ?? null,
        options.signedTransaction ?? null,
        isAttempt ? 1 : 0,
        options.error ?? null,
        nextAttempt,
        status,
        isComplete ? 1 : 0,
        fingerprint,
        targetChainId,
      );
  }

  counts(): Record<string, number> {
    const rows = this.#database
      .prepare("SELECT status, COUNT(*) AS count FROM replication_jobs GROUP BY status")
      .all() as unknown as { status: string; count: number }[];
    return Object.fromEntries(rows.map((row) => [row.status, row.count]));
  }

  unsafeQueryForTests(sql: string, ...params: SQLInputValue[]): unknown[] {
    return this.#database.prepare(sql).all(...params);
  }
}
