import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const MAX_BUFFER = 16 * 1024 * 1024;
const TIMEOUT_MS = 120_000;

export type BiliArgs = Record<string, string | number | undefined>;

async function runBnbot(args: string[]): Promise<unknown> {
  try {
    const bin = process.env.BNBOT_CLI || "bnbot";
    const { stdout } = await exec(bin, args, { maxBuffer: MAX_BUFFER, timeout: TIMEOUT_MS });
    if (!stdout.trim()) throw new Error("bnbot returned empty stdout");
    try {
      return JSON.parse(stdout);
    } catch {
      throw new Error(`bnbot returned non-JSON (head=${stdout.slice(0, 200).replace(/\n/g, "\\n")})`);
    }
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string };
    if (e.stderr && e.stderr.trim()) throw new Error(`bnbot bilibili failed: ${e.stderr.trim()}`);
    throw err;
  }
}

function add(args: string[], flag: string, value: string | number | undefined): void {
  if (value == null || value === "") return;
  args.push(flag, String(value));
}

export async function bnbotBili(command: string, positional: string[] = [], a: BiliArgs = {}): Promise<unknown> {
  const args = ["bilibili", command, ...positional];
  add(args, "--limit", a.limit);
  add(args, "--parent", a.parent);
  add(args, "--lang", a.lang);
  add(args, "--page", a.page);
  add(args, "--order", a.order);
  add(args, "--fid", a.fid);
  add(args, "--pages", a.pages);
  add(args, "--type", a.type);
  return runBnbot(args);
}
