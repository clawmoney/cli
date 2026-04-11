#!/usr/bin/env node

/**
 * Daemon entry point for the Relay Provider.
 * This file is spawned as a detached child process by `clawmoney relay start`.
 * It runs the relay provider main loop (WS + Executor).
 */

import { runRelayProvider } from "./provider.js";
import { relayLogger as logger } from "./logger.js";

// Process-level safety net: an unhandled promise rejection anywhere in the
// async reconnect / request path must NOT silently kill the daemon. Log it
// loudly and keep running — the reconnect loop will self-heal any broken WS.
process.on("unhandledRejection", (reason) => {
  logger.error(
    "Unhandled promise rejection (daemon continues running):",
    reason instanceof Error ? reason.stack ?? reason.message : reason
  );
});
process.on("uncaughtException", (err) => {
  logger.error(
    "Uncaught exception (daemon continues running):",
    err.stack ?? err.message
  );
});

// Parse CLI args passed from the parent
let cliType: string | undefined;

const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--cli" && args[i + 1]) {
    cliType = args[i + 1];
    i++;
  }
}

// Run the relay provider (this blocks until shutdown signal)
runRelayProvider(cliType);
