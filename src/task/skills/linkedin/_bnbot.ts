import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const MAX_BUFFER = 16 * 1024 * 1024;
const TIMEOUT_MS = 120_000;

export interface LinkedInJobSearchArgs {
  query: string;
  limit?: number;
  location?: string;
  experienceLevel?: string;
  jobType?: string;
  datePosted?: string;
  remote?: string;
}

async function runBnbot(args: string[]): Promise<unknown> {
  try {
    const { stdout } = await exec("bnbot", args, {
      maxBuffer: MAX_BUFFER,
      timeout: TIMEOUT_MS,
    });
    if (!stdout.trim()) throw new Error("bnbot returned empty stdout");
    try {
      return JSON.parse(stdout);
    } catch {
      throw new Error(`bnbot returned non-JSON (head=${stdout.slice(0, 200).replace(/\n/g, "\\n")})`);
    }
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string };
    if (e.stderr && e.stderr.trim()) throw new Error(`bnbot linkedin failed: ${e.stderr.trim()}`);
    throw err;
  }
}

function add(args: string[], flag: string, value: string | number | undefined): void {
  if (value == null || value === "") return;
  args.push(flag, String(value));
}

export async function bnbotLIJobSearch(a: LinkedInJobSearchArgs): Promise<unknown> {
  const args = ["linkedin", "search", a.query];
  add(args, "--limit", a.limit);
  add(args, "--location", a.location);
  add(args, "--experience-level", a.experienceLevel);
  add(args, "--job-type", a.jobType);
  add(args, "--date-posted", a.datePosted);
  add(args, "--remote", a.remote);
  return runBnbot(args);
}
