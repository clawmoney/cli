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

async function runBnbot(args: string[]): Promise<unknown> {
  try {
    const { stdout } = await exec("bnbot", args, {
      maxBuffer: MAX_BUFFER,
      timeout: TIMEOUT_MS,
    });
    if (!stdout.trim()) throw new Error("bnbot returned empty stdout");
    try {
      return JSON.parse(stdout);
    } catch {
      throw new Error(
        `bnbot returned non-JSON (head=${stdout.slice(0, 200).replace(/\n/g, "\\n")})`,
      );
    }
  } catch (err) {
    const e = err as NodeJS.ErrnoException & {
      stderr?: string;
      stdout?: string;
    };
    if (e.stderr && e.stderr.trim()) {
      throw new Error(`bnbot douyin failed: ${e.stderr.trim()}`);
    }
    throw err;
  }
}

// ── User ─────────────────────────────────────────────────────

export async function bnbotDYUserInfo(secUid: string): Promise<unknown> {
  return runBnbot(["douyin", "user-info", secUid]);
}

export interface UserCursorArgs {
  secUid: string;
  limit?: number;
  cursor?: string;
}

export async function bnbotDYUserPosts(a: UserCursorArgs): Promise<unknown> {
  const args = ["douyin", "user-posts", a.secUid];
  if (a.limit) args.push("--limit", String(a.limit));
  if (a.cursor) args.push("--cursor", a.cursor);
  return runBnbot(args);
}

export async function bnbotDYUserLiked(a: UserCursorArgs): Promise<unknown> {
  const args = ["douyin", "user-liked", a.secUid];
  if (a.limit) args.push("--limit", String(a.limit));
  if (a.cursor) args.push("--cursor", a.cursor);
  return runBnbot(args);
}

export interface UserMaxTimeArgs {
  secUid: string;
  limit?: number;
  max_time?: string;
}

export async function bnbotDYUserFollowers(
  a: UserMaxTimeArgs,
): Promise<unknown> {
  const args = ["douyin", "user-followers", a.secUid];
  if (a.limit) args.push("--limit", String(a.limit));
  if (a.max_time) args.push("--max-time", a.max_time);
  return runBnbot(args);
}

export async function bnbotDYUserFollowing(
  a: UserMaxTimeArgs,
): Promise<unknown> {
  const args = ["douyin", "user-following", a.secUid];
  if (a.limit) args.push("--limit", String(a.limit));
  if (a.max_time) args.push("--max-time", a.max_time);
  return runBnbot(args);
}

// ── Post ─────────────────────────────────────────────────────

export interface PostCommentsArgs {
  video: string;
  limit?: number;
  cursor?: string;
}

export async function bnbotDYPostComments(
  a: PostCommentsArgs,
): Promise<unknown> {
  const args = ["douyin", "post-comments", a.video];
  if (a.limit) args.push("--limit", String(a.limit));
  if (a.cursor) args.push("--cursor", a.cursor);
  return runBnbot(args);
}

export interface PostCommentRepliesArgs {
  video: string;
  commentId: string;
  limit?: number;
  cursor?: string;
}

export async function bnbotDYPostCommentReplies(
  a: PostCommentRepliesArgs,
): Promise<unknown> {
  const args = ["douyin", "post-comment-replies", a.video, a.commentId];
  if (a.limit) args.push("--limit", String(a.limit));
  if (a.cursor) args.push("--cursor", a.cursor);
  return runBnbot(args);
}

// ── Search ───────────────────────────────────────────────────

export interface SearchOffsetArgs {
  query: string;
  limit?: number;
  offset?: number;
}

export async function bnbotDYSearchGeneral(
  a: SearchOffsetArgs,
): Promise<unknown> {
  const args = ["douyin", "search-general", a.query];
  if (a.limit) args.push("--limit", String(a.limit));
  if (a.offset != null) args.push("--offset", String(a.offset));
  return runBnbot(args);
}

export async function bnbotDYSearchVideo(
  a: SearchOffsetArgs,
): Promise<unknown> {
  const args = ["douyin", "search-video", a.query];
  if (a.limit) args.push("--limit", String(a.limit));
  if (a.offset != null) args.push("--offset", String(a.offset));
  return runBnbot(args);
}

export interface SearchCursorArgs {
  query: string;
  limit?: number;
  cursor?: string;
}

export async function bnbotDYSearchAccount(
  a: SearchCursorArgs,
): Promise<unknown> {
  const args = ["douyin", "search-account", a.query];
  if (a.limit) args.push("--limit", String(a.limit));
  if (a.cursor) args.push("--cursor", a.cursor);
  return runBnbot(args);
}

export async function bnbotDYSearchLive(
  a: SearchOffsetArgs,
): Promise<unknown> {
  const args = ["douyin", "search-live", a.query];
  if (a.limit) args.push("--limit", String(a.limit));
  if (a.offset != null) args.push("--offset", String(a.offset));
  return runBnbot(args);
}

// ── Challenge / Music ────────────────────────────────────────

export interface ChallengePostsArgs {
  hashtag: string;
  limit?: number;
  offset?: number;
}

export async function bnbotDYChallengePosts(
  a: ChallengePostsArgs,
): Promise<unknown> {
  const args = ["douyin", "challenge-posts", a.hashtag];
  if (a.limit) args.push("--limit", String(a.limit));
  if (a.offset != null) args.push("--offset", String(a.offset));
  return runBnbot(args);
}

export interface MusicPostsArgs {
  musicId: string;
  limit?: number;
  cursor?: string;
}

export async function bnbotDYMusicPosts(
  a: MusicPostsArgs,
): Promise<unknown> {
  const args = ["douyin", "music-posts", a.musicId];
  if (a.limit) args.push("--limit", String(a.limit));
  if (a.cursor) args.push("--cursor", a.cursor);
  return runBnbot(args);
}
