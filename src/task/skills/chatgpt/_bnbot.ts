import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const MAX_BUFFER = 4 * 1024 * 1024;
const TIMEOUT_BUFFER_MS = 15_000;
const BNBOT_CANDIDATES = [
  process.env.BNBOT_CLI,
  "bnbot",
  "/opt/homebrew/bin/bnbot",
  "/usr/local/bin/bnbot",
].filter((value, index, values): value is string =>
  typeof value === "string" && value.length > 0 && values.indexOf(value) === index,
);

export interface ChatGPTAskArgs {
  prompt: string;
  model?: string;
  timeout?: number;
  fresh?: boolean;
}

export interface ChatGPTImageGenerateArgs {
  prompt: string;
  model?: string;
  size?: string;
  quality?: string;
  images?: string[];
  response_format?: string;
  timeout?: number;
  fresh?: boolean;
  restart?: boolean;
}

export async function bnbotChatGPTAsk(input: ChatGPTAskArgs): Promise<unknown> {
  const timeoutS = Math.max(1, input.timeout ?? 60);
  const askArgs = [
    "chatgpt",
    "ask",
    input.prompt,
    "--timeout",
    String(timeoutS),
  ];
  if (input.model) askArgs.push("--model", input.model);

  let lastError: unknown;
  for (const bin of BNBOT_CANDIDATES) {
    try {
      if (input.fresh) {
        await execBnbot(bin, ["chatgpt", "new"], 30_000);
      }
      return await execBnbot(bin, askArgs, timeoutS * 1000 + TIMEOUT_BUFFER_MS);
    } catch (err) {
      lastError = err;
      if (!shouldTryNextBnbot(err)) throw err;
    }
  }
  throw lastError;
}

export async function bnbotChatGPTImageGenerate(
  input: ChatGPTImageGenerateArgs,
): Promise<unknown> {
  const timeoutS = Math.max(1, input.timeout ?? 300);
  const args = [
    "chatgpt",
    "image-generate",
    input.prompt,
    "--timeout",
    String(timeoutS),
    "--response-format",
    input.response_format ?? "b64_json",
  ];
  if (input.model) args.push("--model", input.model);
  if (input.size) args.push("--size", input.size);
  if (input.quality) args.push("--quality", input.quality);
  for (const image of input.images ?? []) args.push("--image", image);
  if (input.fresh) args.push("--new");
  if (input.restart) args.push("--restart");
  if ((input.response_format ?? "b64_json") === "b64_json") {
    args.push("--inline-artifacts");
  }

  let lastError: unknown;
  for (const bin of BNBOT_CANDIDATES) {
    try {
      return await execBnbot(bin, args, timeoutS * 1000 + 30_000);
    } catch (err) {
      lastError = err;
      if (!shouldTryNextBnbot(err)) throw err;
    }
  }
  throw lastError;
}

async function execBnbot(bin: string, args: string[], timeoutMs: number): Promise<unknown> {
  try {
    const { stdout } = await exec(bin, args, {
      maxBuffer: MAX_BUFFER,
      timeout: timeoutMs,
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
      throw new Error(`${bin} ${args.join(" ")} failed: ${e.stderr.trim()}`);
    }
    throw err;
  }
}

function shouldTryNextBnbot(err: unknown): boolean {
  if (err && typeof err === "object" && (err as NodeJS.ErrnoException).code === "ENOENT") {
    return true;
  }
  const message = err instanceof Error ? err.message : String(err);
  return /unknown command ['"]?chatgpt['"]?/i.test(message);
}
