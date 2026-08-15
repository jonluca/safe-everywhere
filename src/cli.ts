#!/usr/bin/env node
import { setTimeout as delay } from "node:timers/promises";
import { loadConfig } from "./config.js";
import { doctorRuntime } from "./doctor.js";
import { logger } from "./logger.js";
import { Orchestrator } from "./orchestrator.js";
import { createRuntimes } from "./runtime.js";
import { errorMessage } from "./sanitize.js";
import { Store } from "./store.js";

interface CliOptions {
  command: "doctor" | "help" | "once" | "start" | "status";
  configPath: string;
  execute: boolean;
}

function printHelp(): void {
  process.stdout.write(`safe-everywhere — replicate opted-in Safe deployments across EVM chains

Usage:
  safe-everywhere doctor [--config PATH]
  safe-everywhere once   [--config PATH] [--execute]
  safe-everywhere start  [--config PATH] [--execute]
  safe-everywhere status [--config PATH]

Commands:
  doctor  Verify RPC chain IDs and every registered factory/singleton code hash.
  once    Scan finalized blocks and plan compatible deployments once (dry-run by default).
  start   Run continuously (dry-run by default).
  status  Print persisted replication job counts without contacting RPC endpoints.

Safety:
  --execute enables real transactions and requires an enrolled creator/Safe plus the
  configured deployer key environment variable. Without it, no transaction is signed.
`);
}

function parseArguments(argv: string[]): CliOptions {
  const rawCommand = argv[0] ?? "help";
  if (!["doctor", "help", "once", "start", "status", "--help", "-h"].includes(rawCommand)) {
    throw new Error(`Unknown command ${rawCommand}`);
  }
  const command = rawCommand === "--help" || rawCommand === "-h" ? "help" : rawCommand;
  let configPath = "./config/chains.yaml";
  let execute = false;
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--execute") {
      execute = true;
      continue;
    }
    if (argument === "--config") {
      const value = argv[index + 1];
      if (!value) throw new Error("--config requires a path");
      configPath = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown option ${argument}`);
  }
  return { command: command as CliOptions["command"], configPath, execute };
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  if (options.command === "help") {
    printHelp();
    return;
  }
  const config = loadConfig(options.configPath);
  const store = new Store(config.databasePath);
  try {
    if (options.command === "status") {
      process.stdout.write(`${JSON.stringify(store.counts(), null, 2)}\n`);
      return;
    }
    const runtimes = createRuntimes(config, options.execute);
    if (options.command === "doctor") {
      const results = [];
      for (const runtime of runtimes) results.push(await doctorRuntime(runtime));
      process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
      return;
    }

    const orchestrator = new Orchestrator(config, runtimes, store, options.execute);
    await orchestrator.initialize();
    if (options.command === "once") {
      const summary = await orchestrator.runOnce();
      logger.info({ execute: options.execute, ...summary }, "Run completed");
      if (summary.failedChains > 0) process.exitCode = 1;
      return;
    }

    const abortController = new AbortController();
    const stop = (signal: string): void => {
      logger.info({ signal }, "Stopping after the current operation");
      abortController.abort();
    };
    process.once("SIGINT", () => stop("SIGINT"));
    process.once("SIGTERM", () => stop("SIGTERM"));
    logger.info({ execute: options.execute }, "Safe replication daemon started");
    while (!abortController.signal.aborted) {
      const summary = await orchestrator.runOnce();
      logger.info(summary, "Polling cycle completed");
      try {
        await delay(config.pollIntervalMs, undefined, { signal: abortController.signal });
      } catch (error) {
        if (!abortController.signal.aborted) throw error;
      }
    }
  } finally {
    store.close();
  }
}

main().catch((error: unknown) => {
  logger.fatal({ error: errorMessage(error) }, "Fatal error");
  process.exitCode = 1;
});
