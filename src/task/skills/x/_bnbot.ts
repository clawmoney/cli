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

async function runBnbot(args: string[]): Promise<unknown> {
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
    } catch (err) {
      throw new Error(
        `bnbot returned non-JSON output (head=${stdout.slice(0, 200).replace(/\n/g, "\\n")})`,
      );
    }
  } catch (err) {
    const e = err as NodeJS.ErrnoException & {
      stderr?: string;
      stdout?: string;
    };
    if (e.stderr && e.stderr.trim()) {
      throw new Error(`bnbot scrape failed: ${e.stderr.trim()}`);
    }
    throw err;
  }
}

export interface SearchArgs {
  q: string;
  type?: string;
  count?: number;
  safe_search?: boolean;
  cursor?: string;
  /** Extra bnbot filter args, e.g. ["--has", "images", "--from", "solana"] */
  extra?: string[];
}

export async function bnbotXSearch(args: SearchArgs): Promise<unknown[]> {
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

export async function bnbotXUserProfile(username: string): Promise<unknown> {
  return runBnbot(["x", "scrape", "user-profile", username]);
}

export interface UserTweetsArgs {
  username: string;
  count?: number;
  cursor?: string;
  /** When provided, restrict to tweets matching the mode. We do this
   *  client-side because bnbot CLI doesn't accept these flags
   *  directly on `x scrape user-tweets`. */
  mode?: "tweets" | "replies" | "media";
}

export async function bnbotXUserTweets(
  args: UserTweetsArgs,
): Promise<unknown[]> {
  const limit = Math.max(1, Math.min(100, args.count ?? 20));
  const cli = ["x", "scrape", "user-tweets", args.username, "-l", String(limit)];
  const out = await runBnbot(cli);
  if (!Array.isArray(out)) {
    throw new Error(
      `bnbot user-tweets returned non-array: ${typeof out}`,
    );
  }
  if (!args.mode || args.mode === "tweets") return out;
  if (args.mode === "replies") return out; // bnbot doesn't separate; passthrough
  if (args.mode === "media") {
    return out.filter((t) => {
      const tweet = t as { media?: unknown[] };
      return Array.isArray(tweet.media) && tweet.media.length > 0;
    });
  }
  return out;
}

export async function bnbotXThread(tweetId: string): Promise<unknown[]> {
  // X accepts /i/status/{id} and resolves to canonical URL — works
  // even when we don't know the author username.
  const url = `https://twitter.com/i/status/${tweetId}`;
  const out = await runBnbot(["x", "scrape", "thread", url]);
  if (!Array.isArray(out)) {
    throw new Error(`bnbot thread returned non-array: ${typeof out}`);
  }
  return out;
}

// ── Tier 3 ───────────────────────────────────────────────────────

export interface TrendsArgs {
  woeid?: number;
  limit?: number;
}

export async function bnbotXTrends(args: TrendsArgs = {}): Promise<unknown[]> {
  const limit = Math.max(1, Math.min(50, args.limit ?? 20));
  const cli = ["x", "scrape", "trends", "-l", String(limit)];
  if (typeof args.woeid === "number" && Number.isFinite(args.woeid)) {
    cli.push("--woeid", String(args.woeid));
  }
  const out = await runBnbot(cli);
  if (!Array.isArray(out)) {
    throw new Error(`bnbot trends returned non-array: ${typeof out}`);
  }
  return out;
}

export interface UserListArgs {
  username: string;
  count?: number;
  cursor?: string;
}

export interface BnbotUserListResult {
  users: unknown[];
  next_cursor: string | null;
}

function coerceUserListShape(out: unknown, op: string): BnbotUserListResult {
  if (!out || typeof out !== "object") {
    throw new Error(`bnbot ${op} returned non-object: ${typeof out}`);
  }
  const o = out as { users?: unknown; next_cursor?: unknown };
  const users = Array.isArray(o.users) ? o.users : [];
  const next_cursor =
    typeof o.next_cursor === "string" && o.next_cursor.length > 0
      ? o.next_cursor
      : null;
  return { users, next_cursor };
}

export async function bnbotXUserFollowers(
  args: UserListArgs,
): Promise<BnbotUserListResult> {
  const limit = Math.max(1, Math.min(200, args.count ?? 20));
  const cli = ["x", "scrape", "user-followers", args.username, "-l", String(limit)];
  if (args.cursor) cli.push("-c", args.cursor);
  return coerceUserListShape(await runBnbot(cli), "user-followers");
}

export async function bnbotXUserFollowing(
  args: UserListArgs,
): Promise<BnbotUserListResult> {
  const limit = Math.max(1, Math.min(200, args.count ?? 20));
  const cli = ["x", "scrape", "user-following", args.username, "-l", String(limit)];
  if (args.cursor) cli.push("-c", args.cursor);
  return coerceUserListShape(await runBnbot(cli), "user-following");
}

export interface TweetListArgs {
  tweet_id: string;
  count?: number;
  cursor?: string;
}

function tweetIdToUrl(tweetId: string): string {
  return `https://twitter.com/i/status/${tweetId}`;
}

export async function bnbotXTweetLikers(
  args: TweetListArgs,
): Promise<BnbotUserListResult> {
  const limit = Math.max(1, Math.min(200, args.count ?? 20));
  const cli = [
    "x",
    "scrape",
    "tweet-likers",
    tweetIdToUrl(args.tweet_id),
    "-l",
    String(limit),
  ];
  if (args.cursor) cli.push("-c", args.cursor);
  return coerceUserListShape(await runBnbot(cli), "tweet-likers");
}

export async function bnbotXTweetRetweeters(
  args: TweetListArgs,
): Promise<BnbotUserListResult> {
  const limit = Math.max(1, Math.min(200, args.count ?? 20));
  const cli = [
    "x",
    "scrape",
    "tweet-retweeters",
    tweetIdToUrl(args.tweet_id),
    "-l",
    String(limit),
  ];
  if (args.cursor) cli.push("-c", args.cursor);
  return coerceUserListShape(await runBnbot(cli), "tweet-retweeters");
}

export async function bnbotXTweetArticle(tweetId: string): Promise<unknown> {
  const out = await runBnbot([
    "x",
    "scrape",
    "tweet-article",
    tweetIdToUrl(tweetId),
  ]);
  if (!out || typeof out !== "object") {
    throw new Error(`bnbot tweet-article returned non-object: ${typeof out}`);
  }
  return out;
}
