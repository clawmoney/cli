/**
 * Thin wrappers around `bnbot reddit <command>` CLI calls.
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
            throw new Error(`bnbot reddit failed: ${e.stderr.trim()}`);
        }
        throw err;
    }
}
function add(args, flag, value) {
    if (value == null || value === "")
        return;
    args.push(flag, String(value));
}
export async function bnbotRDPopularPosts(a) {
    const args = ["reddit", "popular-posts"];
    add(args, "--sort", a.sort);
    add(args, "--limit", a.limit);
    return runBnbot(args);
}
export async function bnbotRDTopPopularPosts(a) {
    const args = ["reddit", "top-popular-posts"];
    add(args, "--time", a.time);
    add(args, "--limit", a.limit);
    return runBnbot(args);
}
export async function bnbotRDRisingPopularPosts(a) {
    const args = ["reddit", "rising-popular-posts"];
    add(args, "--limit", a.limit);
    return runBnbot(args);
}
export async function bnbotRDBestPopularPosts(a) {
    const args = ["reddit", "best-popular-posts"];
    add(args, "--limit", a.limit);
    return runBnbot(args);
}
export async function bnbotRDPopularPostsByCountry(a) {
    const args = ["reddit", "popular-posts-by-country", a.country];
    add(args, "--sort", a.sort);
    add(args, "--time", a.time);
    add(args, "--limit", a.limit);
    return runBnbot(args);
}
export async function bnbotRDPostsBySubreddit(a) {
    const args = ["reddit", "posts-by-subreddit", a.subreddit];
    add(args, "--sort", a.sort);
    add(args, "--time", a.time);
    add(args, "--limit", a.limit);
    return runBnbot(args);
}
export async function bnbotRDTopPostsBySubreddit(a) {
    const args = ["reddit", "top-posts-by-subreddit", a.subreddit];
    add(args, "--time", a.time);
    add(args, "--limit", a.limit);
    return runBnbot(args);
}
export async function bnbotRDControversialPostsBySubreddit(a) {
    const args = ["reddit", "controversial-posts-by-subreddit", a.subreddit];
    add(args, "--time", a.time);
    add(args, "--limit", a.limit);
    return runBnbot(args);
}
export async function bnbotRDCommentsBySubreddit(a) {
    const args = ["reddit", "comments-by-subreddit", a.subreddit];
    add(args, "--limit", a.limit);
    return runBnbot(args);
}
export async function bnbotRDSubredditInfo(subreddit) {
    return runBnbot(["reddit", "subreddit-info", subreddit]);
}
export async function bnbotRDSubredditModerators(subreddit) {
    return runBnbot(["reddit", "subreddit-moderators", subreddit]);
}
export async function bnbotRDSubredditRules(subreddit) {
    return runBnbot(["reddit", "subreddit-rules", subreddit]);
}
export async function bnbotRDSimilarSubreddits(a) {
    const args = ["reddit", "similar-subreddits", a.subreddit];
    add(args, "--limit", a.limit);
    return runBnbot(args);
}
export async function bnbotRDNewSubreddits(a) {
    const args = ["reddit", "new-subreddits"];
    add(args, "--limit", a.limit);
    return runBnbot(args);
}
export async function bnbotRDPopularSubreddits(a) {
    const args = ["reddit", "popular-subreddits"];
    add(args, "--limit", a.limit);
    return runBnbot(args);
}
export async function bnbotRDPostsByUsername(a) {
    const args = ["reddit", "posts-by-username", a.username];
    add(args, "--sort", a.sort);
    add(args, "--time", a.time);
    add(args, "--limit", a.limit);
    return runBnbot(args);
}
export async function bnbotRDTopPostsByUsername(a) {
    const args = ["reddit", "top-posts-by-username", a.username];
    add(args, "--time", a.time);
    add(args, "--limit", a.limit);
    return runBnbot(args);
}
export async function bnbotRDCommentsByUsername(a) {
    const args = ["reddit", "comments-by-username", a.username];
    add(args, "--sort", a.sort);
    add(args, "--time", a.time);
    add(args, "--limit", a.limit);
    return runBnbot(args);
}
export async function bnbotRDTopCommentsByUsername(a) {
    const args = ["reddit", "top-comments-by-username", a.username];
    add(args, "--time", a.time);
    add(args, "--limit", a.limit);
    return runBnbot(args);
}
export async function bnbotRDUserOverview(a) {
    const args = ["reddit", "user-overview", a.username];
    add(args, "--sort", a.sort);
    add(args, "--time", a.time);
    add(args, "--limit", a.limit);
    return runBnbot(args);
}
export async function bnbotRDUserPostRankInSubreddit(a) {
    const args = ["reddit", "user-post-rank-in-subreddit", a.username, a.subreddit];
    add(args, "--sort", a.sort);
    add(args, "--limit", a.limit);
    return runBnbot(args);
}
export async function bnbotRDProfile(username) {
    return runBnbot(["reddit", "profile", username]);
}
export async function bnbotRDUserStats(username) {
    return runBnbot(["reddit", "user-stats", username]);
}
export async function bnbotRDSearchUsers(a) {
    const args = ["reddit", "search-users", a.query];
    add(args, "--limit", a.limit);
    return runBnbot(args);
}
export async function bnbotRDSearchPosts(a) {
    const args = ["reddit", "search-posts", a.query];
    add(args, "--subreddit", a.subreddit);
    add(args, "--sort", a.sort);
    add(args, "--time", a.time);
    add(args, "--limit", a.limit);
    return runBnbot(args);
}
export async function bnbotRDSearchSubreddits(a) {
    const args = ["reddit", "search-subreddits", a.query];
    add(args, "--limit", a.limit);
    return runBnbot(args);
}
export async function bnbotRDPostDetails(a) {
    return runBnbot(["reddit", "post-details", a.post_url]);
}
export async function bnbotRDPostComments(a) {
    const args = ["reddit", "post-comments", a.post_url];
    add(args, "--limit", a.limit);
    return runBnbot(args);
}
export async function bnbotRDPostCommentsWithSort(a) {
    const args = ["reddit", "post-comments-with-sort", a.post_url];
    add(args, "--sort", a.sort);
    add(args, "--limit", a.limit);
    return runBnbot(args);
}
export async function bnbotRDPostDuplicates(a) {
    const args = ["reddit", "post-duplicates", a.post_url];
    add(args, "--limit", a.limit);
    return runBnbot(args);
}
