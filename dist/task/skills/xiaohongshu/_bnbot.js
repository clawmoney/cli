import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);
const MAX_BUFFER = 16 * 1024 * 1024;
const TIMEOUT_MS = 110_000;
async function runBnbot(args) {
    try {
        const { stdout } = await exec("bnbot", args, { maxBuffer: MAX_BUFFER, timeout: TIMEOUT_MS });
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
            throw new Error(`bnbot xiaohongshu failed: ${e.stderr.trim()}`);
        throw err;
    }
}
function add(args, flag, value) {
    if (value == null || value === "")
        return;
    args.push(flag, String(value));
}
export async function bnbotXHS(command, positional = [], a = {}) {
    const args = ["xiaohongshu", command, ...positional];
    add(args, "--region", a.region);
    add(args, "--sku-id", a.sku_id);
    add(args, "--source", a.source);
    add(args, "--page-id", a.page_id);
    add(args, "--index", a.index);
    add(args, "--cursor", a.cursor);
    add(args, "--note-id", a.note_id);
    add(args, "--share-text", a.share_text);
    add(args, "--sort-strategy", a.sort_strategy);
    add(args, "--from-page", a.from_page);
    add(args, "--sort", a.sort);
    add(args, "--page", a.page);
    add(args, "--note-type", a.note_type);
    add(args, "--sort-type", a.sort_type);
    add(args, "--time-filter", a.time_filter);
    add(args, "--pre-page", a.pre_page);
    add(args, "--tab", a.tab);
    add(args, "--limit", a.limit);
    return runBnbot(args);
}
