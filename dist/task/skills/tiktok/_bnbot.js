/**
 * Thin wrappers around `bnbot tiktok <command>` CLI calls.
 *
 * Each function shells out, captures stdout JSON, and either returns
 * the parsed object or throws on failure. bnbot CLI handles the
 * actual scraping inside the browser extension; we just glue here.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);
const MAX_BUFFER = 16 * 1024 * 1024;
const TIMEOUT_MS = 110_000;
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
        if (e.stderr && e.stderr.trim()) {
            throw new Error(`bnbot tiktok failed: ${e.stderr.trim()}`);
        }
        throw err;
    }
}
export async function bnbotTTSearchVideo(query, limit) {
    const args = ["tiktok", "search", query];
    if (limit)
        args.push("--limit", String(limit));
    return runBnbot(args);
}
export async function bnbotTTSearchAccount(query, limit) {
    const args = ["tiktok", "search-account", query];
    if (limit)
        args.push("--limit", String(limit));
    return runBnbot(args);
}
export async function bnbotTTUserInfo(uniqueId) {
    return runBnbot(["tiktok", "profile", uniqueId]);
}
export async function bnbotTTUserPosts(a) {
    const args = ["tiktok", "user-posts", a.user];
    if (a.limit)
        args.push("--limit", String(a.limit));
    if (a.cursor)
        args.push("--cursor", a.cursor);
    return runBnbot(args);
}
export async function bnbotTTUserFollowers(a) {
    const args = ["tiktok", "user-followers", a.user];
    if (a.limit)
        args.push("--limit", String(a.limit));
    if (a.cursor)
        args.push("--cursor", a.cursor);
    return runBnbot(args);
}
export async function bnbotTTPostDetail(video) {
    return runBnbot(["tiktok", "post-detail", video]);
}
export async function bnbotTTPostComments(a) {
    const args = ["tiktok", "post-comments", a.video];
    if (a.limit)
        args.push("--limit", String(a.limit));
    if (a.cursor)
        args.push("--cursor", a.cursor);
    return runBnbot(args);
}
export async function bnbotTTTrending(limit) {
    const args = ["tiktok", "explore"];
    if (limit)
        args.push("--limit", String(limit));
    return runBnbot(args);
}
