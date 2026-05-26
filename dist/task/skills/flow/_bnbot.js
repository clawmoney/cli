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
].filter((value, index, values) => typeof value === "string" && value.length > 0 && values.indexOf(value) === index);
export async function bnbotFlowVideoGenerate(input) {
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
    if (input.aspect)
        args.push("--aspect", input.aspect);
    if (input.duration)
        args.push("--duration", String(input.duration));
    if (input.count)
        args.push("--count", String(input.count));
    if (input.model)
        args.push("--model", input.model);
    if (input.project)
        args.push("--project", input.project);
    for (const image of input.images ?? [])
        args.push("--image", image);
    if ((input.response_format ?? "path") === "b64_json") {
        args.push("--inline-artifacts");
    }
    let lastError;
    for (const bin of BNBOT_CANDIDATES) {
        try {
            return await execBnbot(bin, args, timeoutS * 1000 + TIMEOUT_BUFFER_MS);
        }
        catch (err) {
            lastError = err;
            if (!shouldTryNextBnbot(err))
                throw err;
        }
    }
    throw lastError;
}
async function execBnbot(bin, args, timeoutMs) {
    try {
        const { stdout } = await exec(bin, args, { maxBuffer: MAX_BUFFER, timeout: timeoutMs });
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
        if (e.stderr && e.stderr.trim()) {
            throw new Error(`${bin} ${args.join(" ")} failed: ${e.stderr.trim()}`);
        }
        throw err;
    }
}
function shouldTryNextBnbot(err) {
    if (err && typeof err === "object" && err.code === "ENOENT")
        return true;
    const message = err instanceof Error ? err.message : String(err);
    return /unknown command ['"]?flow['"]?/i.test(message);
}
export async function bnbotFlowImageGenerate(input) {
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
    if (input.aspect)
        args.push("--aspect", input.aspect);
    if (input.count)
        args.push("--count", String(input.count));
    if (input.model)
        args.push("--model", input.model);
    if (input.project)
        args.push("--project", input.project);
    for (const image of input.images ?? [])
        args.push("--image", image);
    if ((input.response_format ?? "path") === "b64_json")
        args.push("--inline-artifacts");
    let lastError;
    for (const bin of BNBOT_CANDIDATES) {
        try {
            return await execBnbot(bin, args, timeoutS * 1000 + TIMEOUT_BUFFER_MS);
        }
        catch (err) {
            lastError = err;
            if (!shouldTryNextBnbot(err))
                throw err;
        }
    }
    throw lastError;
}
