import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);
const MAX_BUFFER = 16 * 1024 * 1024;
const TIMEOUT_MS = 120_000;
async function runBnbot(args) {
    try {
        const { stdout } = await exec("bnbot", args, {
            maxBuffer: MAX_BUFFER,
            timeout: TIMEOUT_MS,
        });
        if (!stdout.trim())
            throw new Error("bnbot returned empty stdout");
        try {
            return JSON.parse(stdout);
        }
        catch {
            throw new Error(`bnbot returned non-JSON (head=${stdout.slice(0, 200).replace(/\n/g, "\\n")})`);
        }
    }
    catch (err) {
        const e = err;
        if (e.stderr && e.stderr.trim())
            throw new Error(`bnbot linkedin failed: ${e.stderr.trim()}`);
        throw err;
    }
}
function add(args, flag, value) {
    if (value == null || value === "")
        return;
    args.push(flag, String(value));
}
export async function bnbotLIJobSearch(a) {
    const args = ["linkedin", "search", a.query];
    add(args, "--limit", a.limit);
    add(args, "--location", a.location);
    add(args, "--experience-level", a.experienceLevel);
    add(args, "--job-type", a.jobType);
    add(args, "--date-posted", a.datePosted);
    add(args, "--remote", a.remote);
    return runBnbot(args);
}
