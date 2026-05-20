/**
 * Thin wrapper around `bnbot` CLI scrape commands.
 *
 * Every X skill calls one of these helpers. They handle argument
 * building, stdout/stderr capture, JSON parsing, and turning bnbot
 * failures into thrown Errors so the daemon's error→task_response
 * path picks them up.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);
const DEFAULT_MAX_BUFFER = 16 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 110_000;
async function runBnbot(args) {
    try {
        const { stdout } = await exec("bnbot", args, {
            maxBuffer: DEFAULT_MAX_BUFFER,
            timeout: DEFAULT_TIMEOUT_MS,
        });
        if (!stdout.trim()) {
            throw new Error("bnbot returned empty stdout");
        }
        try {
            return JSON.parse(stdout);
        }
        catch (err) {
            throw new Error(`bnbot returned non-JSON output (head=${stdout.slice(0, 200).replace(/\n/g, "\\n")})`);
        }
    }
    catch (err) {
        const e = err;
        if (e.stderr && e.stderr.trim()) {
            throw new Error(`bnbot scrape failed: ${e.stderr.trim()}`);
        }
        throw err;
    }
}
export async function bnbotXSearch(args) {
    const tab = (args.type ?? "Top").toLowerCase(); // bnbot uses lowercase tab names
    const limit = Math.max(1, Math.min(100, args.count ?? 20));
    const cli = [
        "x",
        "scrape",
        "search",
        args.q,
        "-l",
        String(limit),
        "-t",
        tab,
        ...(args.extra ?? []),
    ];
    const out = await runBnbot(cli);
    if (!Array.isArray(out)) {
        throw new Error(`bnbot search returned non-array: ${typeof out}`);
    }
    return out;
}
export async function bnbotXUserProfile(username) {
    return runBnbot(["x", "scrape", "user-profile", username]);
}
export async function bnbotXUserTweets(args) {
    const limit = Math.max(1, Math.min(100, args.count ?? 20));
    const cli = ["x", "scrape", "user-tweets", args.username, "-l", String(limit)];
    const out = await runBnbot(cli);
    if (!Array.isArray(out)) {
        throw new Error(`bnbot user-tweets returned non-array: ${typeof out}`);
    }
    if (!args.mode || args.mode === "tweets")
        return out;
    if (args.mode === "replies")
        return out; // bnbot doesn't separate; passthrough
    if (args.mode === "media") {
        return out.filter((t) => {
            const tweet = t;
            return Array.isArray(tweet.media) && tweet.media.length > 0;
        });
    }
    return out;
}
export async function bnbotXThread(tweetId) {
    // X accepts /i/status/{id} and resolves to canonical URL — works
    // even when we don't know the author username.
    const url = `https://twitter.com/i/status/${tweetId}`;
    const out = await runBnbot(["x", "scrape", "thread", url]);
    if (!Array.isArray(out)) {
        throw new Error(`bnbot thread returned non-array: ${typeof out}`);
    }
    return out;
}
