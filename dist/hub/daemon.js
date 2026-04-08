#!/usr/bin/env node
/**
 * Daemon entry point for the Hub Provider.
 * This file is spawned as a detached child process by `clawmoney hub start`.
 * It runs the provider main loop (WS + Poller + Executor).
 */
import { runProvider } from "./provider.js";
// Parse CLI args passed from the parent
let cliCommand;
let autoAccept;
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
    if (args[i] === "--cli" && args[i + 1]) {
        cliCommand = args[i + 1];
        i++;
    }
    else if (args[i] === "--auto-accept") {
        autoAccept = true;
    }
}
// Run the provider (this blocks until shutdown signal)
runProvider(cliCommand, autoAccept);
