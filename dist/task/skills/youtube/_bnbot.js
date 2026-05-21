/**
 * Thin wrappers around `bnbot youtube <command>` CLI calls.
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
            throw new Error(`bnbot youtube failed: ${e.stderr.trim()}`);
        }
        throw err;
    }
}
export async function bnbotYTVideoDetails(idOrUrl) {
    return runBnbot(["youtube", "video", idOrUrl]);
}
export async function bnbotYTChannelDetails(idOrHandle) {
    return runBnbot(["youtube", "channel-details", idOrHandle]);
}
export async function bnbotYTChannelVideos(a) {
    const args = ["youtube", "channel-videos", a.id];
    if (a.filter)
        args.push("--filter", a.filter);
    if (a.limit)
        args.push("--limit", String(a.limit));
    if (a.cursor)
        args.push("--cursor", a.cursor);
    return runBnbot(args);
}
export async function bnbotYTTrending(limit) {
    const args = ["youtube", "trending"];
    if (limit)
        args.push("--limit", String(limit));
    return runBnbot(args);
}
export async function bnbotYTChannelSearch(channelId, query, limit) {
    const args = ["youtube", "channel-search", channelId, query];
    if (limit)
        args.push("--limit", String(limit));
    return runBnbot(args);
}
export async function bnbotYTStreamingData(idOrUrl) {
    return runBnbot(["youtube", "streaming-data", idOrUrl]);
}
export async function bnbotYTRelated(idOrUrl, limit) {
    const args = ["youtube", "related", idOrUrl];
    if (limit)
        args.push("--limit", String(limit));
    return runBnbot(args);
}
export async function bnbotYTComments(idOrUrl, limit) {
    const args = ["youtube", "comments", idOrUrl];
    if (limit)
        args.push("--limit", String(limit));
    return runBnbot(args);
}
export async function bnbotYTTranscript(idOrUrl, lang) {
    const args = ["youtube", "transcript", idOrUrl];
    if (lang)
        args.push("--lang", lang);
    return runBnbot(args);
}
