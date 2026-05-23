import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const MAX_BUFFER = 16 * 1024 * 1024;
const TIMEOUT_MS = 330_000;

export interface CodexImageGenerateArgs {
  prompt: string;
  size?: string;
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
  if (input.fresh) args.push("--new");
  if ((input.response_format ?? "b64_json") === "b64_json") {
    args.push("--inline-artifacts");
  }

  try {
    const { stdout } = await exec("bnbot", args, {
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
      throw new Error(`bnbot codex image-generate failed: ${e.stderr.trim()}`);
    }
    throw err;
  }
}
