#!/usr/bin/env node

/**
 * Daemon entry point for the Relay Provider.
 * This file is spawned as a detached child process by `clawmoney relay start`.
 * It runs the relay provider main loop (WS + Executor).
 */

import { runRelayProvider } from "./provider.js";

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
