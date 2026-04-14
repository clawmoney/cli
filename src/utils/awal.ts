import { spawn } from 'node:child_process';

export interface AwalResult {
  success: boolean;
  data: Record<string, unknown>;
  raw: string;
}

/**
 * Execute an awal CLI command and parse the JSON output.
 * Always appends --json flag for machine-readable output.
 */
export async function awalExec(args: string[]): Promise<AwalResult> {
  // Ensure --json flag is present
  const finalArgs = args.includes('--json') ? args : [...args, '--json'];

  return new Promise((resolve, reject) => {
    const child = spawn('npx', ['awal', ...finalArgs], {
      stdio: ['inherit', 'pipe', 'pipe'],
      shell: true,
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on('close', (code) => {
      if (code !== 0) {
        // Try to parse stderr or stdout for error details
        const errorMsg = stderr.trim() || stdout.trim() || `awal exited with code ${code}`;
        reject(new Error(errorMsg));
        return;
      }

      try {
        // awal may output non-JSON lines before the JSON; find the JSON part
        const jsonStart = stdout.indexOf('{');
        const jsonEnd = stdout.lastIndexOf('}');
        if (jsonStart === -1 || jsonEnd === -1) {
          // Try array
          const arrStart = stdout.indexOf('[');
          const arrEnd = stdout.lastIndexOf(']');
          if (arrStart !== -1 && arrEnd !== -1) {
            const data = JSON.parse(stdout.slice(arrStart, arrEnd + 1));
            resolve({ success: true, data, raw: stdout });
            return;
          }
          resolve({ success: true, data: {}, raw: stdout });
          return;
        }
        const data = JSON.parse(stdout.slice(jsonStart, jsonEnd + 1));
        resolve({ success: true, data, raw: stdout });
      } catch {
        // Not valid JSON, return raw
        resolve({ success: true, data: {}, raw: stdout });
      }
    });

    child.on('error', (err) => {
      reject(new Error(`Failed to spawn awal: ${err.message}`));
    });
  });
}

/**
 * Execute an awal command that requires interactive stdin (e.g., for OTP).
 * Returns the parsed JSON output.
 */
export async function awalExecInteractive(args: string[]): Promise<string> {
  const finalArgs = args.includes('--json') ? args : [...args, '--json'];

  return new Promise((resolve, reject) => {
    const child = spawn('npx', ['awal', ...finalArgs], {
      stdio: ['inherit', 'pipe', 'pipe'],
      shell: true,
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `awal exited with code ${code}`));
        return;
      }
      resolve(stdout.trim());
    });

    child.on('error', (err) => {
      reject(new Error(`Failed to spawn awal: ${err.message}`));
    });
  });
}

/**
 * Check if awal is installed and available.
 */
export async function isAwalAvailable(): Promise<boolean> {
  try {
    await awalExec(['--version']);
    return true;
  } catch {
    return false;
  }
}

/**
 * Kill a wedged awal server process using the pattern documented in
 * clawmoney-skill's SKILL.md. Reads the pid from `awal status --json`
 * and SIGKILLs it. Safe to call even when awal isn't running (the
 * inner command fails, kill -9 gets nothing, we swallow both).
 *
 * awal's Electron "Payments MCP" wrapper occasionally wedges on
 * macOS (GPU render hang, stdin/stdout pipe full, or upstream
 * Coinbase MCP endpoint unreachable). A hard kill lets the next
 * `awal status` cold-start a fresh process.
 */
export async function killAwal(): Promise<void> {
  await new Promise<void>((resolve) => {
    const child = spawn(
      'sh',
      [
        '-c',
        'kill -9 $(npx awal status --json 2>/dev/null | grep -o \'"pid":[0-9]*\' | grep -o \'[0-9]*\') 2>/dev/null',
      ],
      { stdio: 'ignore', shell: false }
    );
    child.on('exit', () => resolve());
    child.on('error', () => resolve());
  });
  // Give the OS a moment to reclaim the process + named pipes.
  await new Promise((r) => setTimeout(r, 800));
}

/**
 * Execute an awal command with timeout + one automatic retry on
 * failure. On the first failure we kill any wedged awal process
 * (using the SKILL-documented kill pattern) and re-run.
 *
 * Safe ONLY for READ operations (status, address, balance, etc).
 * Do NOT use for writes (send, x402 pay, auth verify) — those
 * either cost money twice on retry, or consume a single-use OTP
 * and fail the second time. For writes, use awalExec directly
 * and let the failure surface to the user.
 */
export async function awalExecSafe(
  args: string[],
  opts: { timeoutMs?: number } = {}
): Promise<AwalResult> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const runWithTimeout = (): Promise<AwalResult> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`awal ${args.join(' ')} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      awalExec(args).then(
        (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        (e) => {
          clearTimeout(timer);
          reject(e);
        }
      );
    });

  try {
    return await runWithTimeout();
  } catch (firstErr) {
    // First attempt failed — kill any wedged server and retry once.
    await killAwal();
    try {
      return await runWithTimeout();
    } catch (secondErr) {
      // Preserve the first error too — it's usually the more
      // informative one (the retry typically just times out again).
      throw new Error(
        `awal ${args.join(' ')} failed after retry: ${(secondErr as Error).message} (initial: ${(firstErr as Error).message})`
      );
    }
  }
}
