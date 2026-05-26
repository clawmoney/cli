import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const MAX_BUFFER = 32 * 1024 * 1024;
const TIMEOUT_BUFFER_MS = 30_000;
const BNBOT_CANDIDATES = [
  process.env.BNBOT_CLI,
  "bnbot",
  "/opt/homebrew/bin/bnbot",
  "/usr/local/bin/bnbot",
].filter((value, index, values): value is string =>
  typeof value === "string" && value.length > 0 && values.indexOf(value) === index,
);

export interface FlowVideoGenerateArgs {
  prompt: string;
  aspect?: string;
  duration?: number;
  count?: number;
  model?: string;
  images?: string[];
  response_format?: string;
  timeout?: number;
  project?: string;
}

export async function bnbotFlowVideoGenerate(input: FlowVideoGenerateArgs): Promise<unknown> {
  const timeoutS = Math.max(60, input.timeout ?? 900);
  const args = [
    "flow",
    "video-generate",
    input.prompt,
    "--timeout",
    String(timeoutS),
    "--response-format",
    input.response_format ?? "path",
  ];
  if (input.aspect) args.push("--aspect", input.aspect);
  if (input.duration) args.push("--duration", String(input.duration));
  if (input.count) args.push("--count", String(input.count));
  if (input.model) args.push("--model", input.model);
  if (input.project) args.push("--project", input.project);
  for (const image of input.images ?? []) args.push("--image", image);
  if ((input.response_format ?? "path") === "b64_json") {
    args.push("--inline-artifacts");
  }

  let lastError: unknown;
  for (const bin of BNBOT_CANDIDATES) {
    try {
      return await execBnbot(bin, args, timeoutS * 1000 + TIMEOUT_BUFFER_MS);
    } catch (err) {
      lastError = err;
      if (!shouldTryNextBnbot(err)) throw err;
    }
  }
  throw lastError;
}

async function execBnbot(bin: string, args: string[], timeoutMs: number): Promise<unknown> {
  try {
    const { stdout } = await exec(bin, args, { maxBuffer: MAX_BUFFER, timeout: timeoutMs });
    if (!stdout.trim()) throw new Error("bnbot returned empty stdout");
    try {
      return JSON.parse(stdout);
    } catch {
      throw new Error(`bnbot returned non-JSON (head=${stdout.slice(0, 200).replace(/\n/g, "\\n")})`);
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
  if (err && typeof err === "object" && (err as NodeJS.ErrnoException).code === "ENOENT") return true;
  const message = err instanceof Error ? err.message : String(err);
  return /unknown command ['"]?flow['"]?/i.test(message);
}

export interface FlowImageGenerateArgs {
  prompt: string;
  aspect?: string;
  count?: number;
  model?: string;
  images?: string[];
  response_format?: string;
  timeout?: number;
  project?: string;
}

export async function bnbotFlowImageGenerate(input: FlowImageGenerateArgs): Promise<unknown> {
  const timeoutS = Math.max(30, input.timeout ?? 300);
  const args = [
    "flow",
    "image-generate",
    input.prompt,
    "--timeout",
    String(timeoutS),
    "--response-format",
    input.response_format ?? "path",
  ];
  if (input.aspect) args.push("--aspect", input.aspect);
  if (input.count) args.push("--count", String(input.count));
  if (input.model) args.push("--model", input.model);
  if (input.project) args.push("--project", input.project);
  for (const image of input.images ?? []) args.push("--image", image);
  if ((input.response_format ?? "path") === "b64_json") args.push("--inline-artifacts");

  let lastError: unknown;
  for (const bin of BNBOT_CANDIDATES) {
    try {
      return await execBnbot(bin, args, timeoutS * 1000 + TIMEOUT_BUFFER_MS);
    } catch (err) {
      lastError = err;
      if (!shouldTryNextBnbot(err)) throw err;
    }
  }
  throw lastError;
}
