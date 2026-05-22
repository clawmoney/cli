/**
 * Thin wrappers around `bnbot douyin <command>` CLI calls.
 *
 * Each function shells out, captures stdout JSON, and either returns
 * the parsed object or throws on failure. bnbot CLI handles the
 * actual scraping inside the browser extension on douyin.com; we
 * just glue here.
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
            throw new Error(`bnbot douyin failed: ${e.stderr.trim()}`);
        }
        throw err;
    }
}
// ── User ─────────────────────────────────────────────────────
export async function bnbotDYUserInfo(secUid) {
    return runBnbot(["douyin", "user-info", secUid]);
}
export async function bnbotDYUserPosts(a) {
    const args = ["douyin", "user-posts", a.secUid];
    if (a.limit)
        args.push("--limit", String(a.limit));
    if (a.cursor)
        args.push("--cursor", a.cursor);
    return runBnbot(args);
}
export async function bnbotDYUserLiked(a) {
    const args = ["douyin", "user-liked", a.secUid];
    if (a.limit)
        args.push("--limit", String(a.limit));
    if (a.cursor)
        args.push("--cursor", a.cursor);
    return runBnbot(args);
}
export async function bnbotDYUserFollowers(a) {
    const args = ["douyin", "user-followers", a.secUid];
    if (a.limit)
        args.push("--limit", String(a.limit));
    if (a.max_time)
        args.push("--max-time", a.max_time);
    return runBnbot(args);
}
export async function bnbotDYUserFollowing(a) {
    const args = ["douyin", "user-following", a.secUid];
    if (a.limit)
        args.push("--limit", String(a.limit));
    if (a.max_time)
        args.push("--max-time", a.max_time);
    return runBnbot(args);
}
export async function bnbotDYPostComments(a) {
    const args = ["douyin", "post-comments", a.video];
    if (a.limit)
        args.push("--limit", String(a.limit));
    if (a.cursor)
        args.push("--cursor", a.cursor);
    return runBnbot(args);
}
export async function bnbotDYSearchGeneral(a) {
    const args = ["douyin", "search-general", a.query];
    if (a.limit)
        args.push("--limit", String(a.limit));
    if (a.offset != null)
        args.push("--offset", String(a.offset));
    return runBnbot(args);
}
export async function bnbotDYSearchVideo(a) {
    const args = ["douyin", "search-video", a.query];
    if (a.limit)
        args.push("--limit", String(a.limit));
    if (a.offset != null)
        args.push("--offset", String(a.offset));
    return runBnbot(args);
}
export async function bnbotDYSearchAccount(a) {
    const args = ["douyin", "search-account", a.query];
    if (a.limit)
        args.push("--limit", String(a.limit));
    if (a.cursor)
        args.push("--cursor", a.cursor);
    return runBnbot(args);
}
export async function bnbotDYSearchLive(a) {
    const args = ["douyin", "search-live", a.query];
    if (a.limit)
        args.push("--limit", String(a.limit));
    if (a.offset != null)
        args.push("--offset", String(a.offset));
    return runBnbot(args);
}
export async function bnbotDYChallengePosts(a) {
    const args = ["douyin", "challenge-posts", a.hashtag];
    if (a.limit)
        args.push("--limit", String(a.limit));
    if (a.offset != null)
        args.push("--offset", String(a.offset));
    return runBnbot(args);
}
export async function bnbotDYMusicPosts(a) {
    const args = ["douyin", "music-posts", a.musicId];
    if (a.limit)
        args.push("--limit", String(a.limit));
    if (a.cursor)
        args.push("--cursor", a.cursor);
    return runBnbot(args);
}
