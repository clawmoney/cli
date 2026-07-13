import { spawn } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";
import chalk from "chalk";
import ora from "ora";
import { requireConfig } from "../utils/config.js";
import { readTaskPid, isPidAlive } from "../task/daemon.js";

import { spareaiDir } from "../utils/home.js";
const LOG_FILE = join(spareaiDir(), "task.log");

export async function taskStartCommand(): Promise<void> {
  const config = requireConfig();

  const existing = readTaskPid();
  if (existing !== null && isPidAlive(existing)) {
    console.log(
      chalk.yellow(`Task daemon is already running (PID ${existing}). Use "spareai task stop" first.`)
    );
    return;
  }

  const spinner = ora("Starting Task daemon...").start();
  try {
    const thisDir = import.meta.url.replace("file://", "").replace(/\/[^/]+$/, "");
    const parentDir = thisDir.replace(/\/[^/]+$/, "");
    const daemonScript = join(parentDir, "task", "daemon.js");

    // Daemon writes its own log file via console.log redirect. Parent
    // uses stdio:"ignore" so it doesn't keep any fd open — that lets the
    // parent process exit cleanly after spawn, which is the only way
    // desktop's ensure_task_daemon_running can poll for a live PID.
    const child = spawn(process.execPath, [daemonScript], {
      stdio: "ignore",
      detached: true,
      env: {
        ...process.env,
        SPAREAI_DAEMON: "1",
        // daemon reads these from env first, then ~/.spareai/config.yaml as fallback
        API_KEY: config.api_key,
        AGENT_ID: config.agent_id ?? "",
        AGENT_NAME: config.agent_slug ?? "spareai-task",
      },
    });

    child.unref();

    await new Promise((r) => setTimeout(r, 1000));
    const pid = readTaskPid();
    if (pid && isPidAlive(pid)) {
      spinner.succeed(chalk.green(`Task daemon started (PID ${pid})`));
      console.log(chalk.dim(`  Log file: ${LOG_FILE}`));
      console.log(chalk.dim(`  Hub: wss://api.spareapi.ai/ws/relay`));
    } else {
      spinner.fail(chalk.red(`Failed to start Task daemon. Check logs at: ${LOG_FILE}`));
      process.exit(1);
    }
  } catch (e) {
    spinner.fail(chalk.red("Failed to start Task daemon"));
    throw e;
  }
}

export async function taskStopCommand(): Promise<void> {
  const pid = readTaskPid();
  if (pid === null) {
    console.log(chalk.dim("Task daemon is not running (no PID file)."));
    return;
  }
  if (!isPidAlive(pid)) {
    console.log(chalk.dim(`Task daemon PID ${pid} not alive. Cleaning up.`));
    // daemon's own SIGTERM handler removes the PID file; if dead, we'd
    // typically clean here. Skip for simplicity — next start replaces.
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
    console.log(chalk.green(`Task daemon stopped (PID ${pid}).`));
  } catch (e) {
    console.error(chalk.red(`Failed to stop process ${pid}:`), (e as Error).message);
  }
  await new Promise((r) => setTimeout(r, 500));
}

export async function taskStatusCommand(): Promise<void> {
  const pid = readTaskPid();
  if (pid === null) {
    console.log(chalk.dim("Task daemon is not running."));
    return;
  }
  if (isPidAlive(pid)) {
    console.log(chalk.green(`Task daemon is running (PID ${pid}).`));
    console.log(chalk.dim(`  Log file: ${LOG_FILE}`));
  } else {
    console.log(chalk.yellow(`Task daemon PID ${pid} not alive (stale PID file).`));
  }
}
