import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);
const MAX_BUFFER = 24 * 1024 * 1024;
const TIMEOUT_MS = 120_000;
function addFlag(args, flag, value) {
    if (value == null || value === "")
        return;
    if (typeof value === "boolean") {
        if (value)
            args.push(flag);
        return;
    }
    args.push(flag, String(value));
}
export async function bnbotCommand(base, positional = [], flags = {}) {
    const args = [...base, ...positional];
    for (const [name, value] of Object.entries(flags)) {
        addFlag(args, `--${name}`, value);
    }
    const bin = process.env.BNBOT_CLI || "bnbot";
    try {
        const { stdout } = await exec(bin, args, { maxBuffer: MAX_BUFFER, timeout: TIMEOUT_MS });
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
            throw new Error(`bnbot failed: ${e.stderr.trim()}`);
        throw err;
    }
}
export async function opencliCommand(base, positional = [], flags = {}) {
    const args = [...base, ...positional];
    for (const [name, value] of Object.entries(flags)) {
        addFlag(args, `--${name}`, value);
    }
    args.push("-f", "json");
    const rawBin = process.env.OPENCLI_CLI || "opencli";
    const bin = rawBin.endsWith(".js") ? process.execPath : rawBin;
    const finalArgs = rawBin.endsWith(".js") ? [rawBin, ...args] : args;
    try {
        const { stdout } = await exec(bin, finalArgs, { maxBuffer: MAX_BUFFER, timeout: TIMEOUT_MS });
        if (!stdout.trim())
            throw new Error("opencli returned empty stdout");
        try {
            return JSON.parse(stdout);
        }
        catch {
            throw new Error(`opencli returned non-JSON (head=${stdout.slice(0, 200).replace(/\n/g, "\\n")})`);
        }
    }
    catch (err) {
        const e = err;
        if (e.stderr && e.stderr.trim())
            throw new Error(`opencli failed: ${e.stderr.trim()}`);
        throw err;
    }
}
