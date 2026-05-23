import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const MAX_BUFFER = 16 * 1024 * 1024;
const TIMEOUT_MS = 330_000;
const BNBOT_CANDIDATES = [
  process.env.BNBOT_CLI,
  "bnbot",
  "/opt/homebrew/bin/bnbot",
  "/usr/local/bin/bnbot",
].filter((value, index, values): value is string =>
  typeof value === "string" && value.length > 0 && values.indexOf(value) === index,
);

export interface CodexImageGenerateArgs {
  prompt: string;
  size?: string;
  quality?: string;
  response_format?: string;
  timeout?: number;
  fresh?: boolean;
}

export async function bnbotCodexImageGenerate(
  input: CodexImageGenerateArgs,
): Promise<unknown> {
  const args = [
    "codex",
    "image-generate",
    input.prompt,
    "--timeout",
    String(input.timeout ?? 300),
    "--response-format",
    input.response_format ?? "b64_json",
  ];
  if (input.size) args.push("--size", input.size);
  if (input.quality) args.push("--quality", input.quality);
  if (input.fresh) args.push("--new");
  if ((input.response_format ?? "b64_json") === "b64_json") {
    args.push("--inline-artifacts");
  }

  let lastError: unknown;
  for (const bin of BNBOT_CANDIDATES) {
    try {
      return await execBnbot(bin, args);
    } catch (err) {
      lastError = err;
      if (!shouldTryNextBnbot(err)) throw err;
    }
  }
  throw lastError;
}

async function execBnbot(bin: string, args: string[]): Promise<unknown> {
  try {
    const { stdout } = await exec(bin, args, {
      maxBuffer: MAX_BUFFER,
      timeout: TIMEOUT_MS,
    });
    if (!stdout.trim()) throw new Error("bnbot returned empty stdout");
    try {
      return JSON.parse(stdout);
    } catch {
      throw new Error(
        `bnbot returned non-JSON (head=${stdout.slice(0, 200).replace(/\n/g, "\\n")})`,
      );
    }
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string };
    if (e.stderr && e.stderr.trim()) {
      throw new Error(`${bin} codex image-generate failed: ${e.stderr.trim()}`);
    }
    throw err;
  }
}

function shouldTryNextBnbot(err: unknown): boolean {
  if (err && typeof err === "object" && (err as NodeJS.ErrnoException).code === "ENOENT") {
    return true;
  }
  const message = err instanceof Error ? err.message : String(err);
  return /unknown command ['"]?codex['"]?/i.test(message);
}
