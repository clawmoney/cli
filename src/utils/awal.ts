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
