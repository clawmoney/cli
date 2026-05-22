/**
 * yt-dlp shell-out helpers for TikTok video downloads.
 *
 * Why yt-dlp: TikTok's signed playAddr URLs rotate frequently, expire
 * quickly, and (more importantly) bake in a visible watermark. yt-dlp
 * walks the (currently) watermark-free `aweme/v1/feed` API path that
 * mobile clients use, so the returned `url` field is suitable for
 * direct download without re-encoding.
 *
 * Install:
 *   brew install yt-dlp     (mac)
 *   pipx install yt-dlp     (linux)
 */

import { spawn } from "node:child_process";

/** Run a command, return {stdout, stderr, code}. Times out after `timeoutMs`. */
function run(
  cmd: string,
  args: string[],
  timeoutMs = 30_000,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${cmd} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (b) => {
      stdout += b.toString();
    });
    child.stderr.on("data", (b) => {
      stderr += b.toString();
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code: code ?? -1 });
    });
  });
}

/** Returns true iff `yt-dlp` is on PATH and exits 0 to `--version`. */
export async function isYtDlpInstalled(): Promise<boolean> {
  try {
    const { code } = await run("yt-dlp", ["--version"], 5_000);
    return code === 0;
  } catch {
    return false;
  }
}

export interface TikTokDownloadFormat {
  itag: number;
  url: string;
  mime_type: string;
  width: number;
  height: number;
  fps: number;
  bitrate: number;
  content_length: string;
  has_audio: boolean;
  has_video: boolean;
}

export interface TikTokDownloadResult {
  id: string;
  title: string;
  author: string;
  duration: number;
  formats: TikTokDownloadFormat[];
}

/** Normalize an `id` or full URL to a TikTok watch URL yt-dlp accepts. */
function toTikTokUrl(idOrUrl: string): string {
  const s = idOrUrl.trim();
  if (/^https?:\/\//i.test(s)) return s;
  // Pure numeric video id — use the canonical /video/ form; @user is
  // accepted as "_" by yt-dlp's TikTok extractor.
  if (/^\d{6,}$/.test(s)) return `https://www.tiktok.com/@_/video/${s}`;
  return s;
}

/**
 * Fetch a TikTok video's download formats. TikTok typically returns
 * a single muxed mp4 + a separate audio track — far fewer formats
 * than YouTube, so the `formats` array is usually 1-2 entries.
 *
 * Throws if yt-dlp isn't installed or the video can't be resolved.
 */
export async function ytdlpTikTokVideo(
  videoIdOrUrl: string,
): Promise<TikTokDownloadResult> {
  if (!(await isYtDlpInstalled())) {
    throw new Error(
      "yt-dlp not found on PATH — install with `brew install yt-dlp` or `pipx install yt-dlp`",
    );
  }
  const url = toTikTokUrl(videoIdOrUrl);

  const { stdout, stderr, code } = await run(
    "yt-dlp",
    ["--dump-json", "--skip-download", "--no-warnings", url],
    45_000,
  );
  if (code !== 0) {
    throw new Error(
      `yt-dlp exited ${code}: ${stderr.split("\n").slice(-5).join(" | ").slice(0, 400)}`,
    );
  }

  let info: any;
  try {
    info = JSON.parse(stdout.trim());
  } catch {
    throw new Error("yt-dlp output was not valid JSON");
  }

  const mapFormat = (f: any): TikTokDownloadFormat => {
    const hasVideo = !!(f.vcodec && f.vcodec !== "none");
    const hasAudio = !!(f.acodec && f.acodec !== "none");
    const codecs: string[] = [];
    if (hasVideo && f.vcodec !== "none") codecs.push(f.vcodec);
    if (hasAudio && f.acodec !== "none") codecs.push(f.acodec);
    const codecPart = codecs.length ? `; codecs="${codecs.join(", ")}"` : "";
    const mimeBase = hasVideo
      ? `video/${f.video_ext || f.ext || "mp4"}`
      : hasAudio
        ? `audio/${f.audio_ext || f.ext || "mp4"}`
        : f.ext || "application/octet-stream";
    return {
      itag: parseInt(String(f.format_id || "0"), 10) || 0,
      url: f.url || "",
      mime_type: `${mimeBase}${codecPart}`,
      width: f.width || 0,
      height: f.height || 0,
      fps: f.fps || 0,
      bitrate: f.tbr
        ? Math.round(f.tbr * 1000)
        : f.abr
          ? Math.round(f.abr * 1000)
          : 0,
      content_length: f.filesize
        ? String(f.filesize)
        : f.filesize_approx
          ? String(f.filesize_approx)
          : "",
      has_audio: hasAudio,
      has_video: hasVideo,
    };
  };

  const formats: TikTokDownloadFormat[] = (info.formats || [])
    .filter((f: any) => f && f.url && f.ext !== "mhtml" && f.protocol !== "mhtml")
    .map(mapFormat);

  return {
    id: String(info.id || videoIdOrUrl),
    title: info.title || info.description || "",
    author: info.uploader || info.creator || info.channel || "",
    duration:
      typeof info.duration === "number" ? info.duration : Number(info.duration) || 0,
    formats,
  };
}

// ─── User posts (yt-dlp flat-playlist) ──────────────────────────────
//
// TikTok's `/api/post/item_list/` web endpoint returns empty bodies to
// chrome.debugger sessions (anti-bot). yt-dlp's TikTok extractor walks
// the mobile aweme API which is currently un-rate-limited for the
// flat-playlist case.

export interface TikTokVideoSummary {
  id: string;
  url: string;
  desc: string;
  author: string;
  authorName: string;
  createTime: number;
  duration: number;
  cover: string;
  hashtags: string[];
  music: string;
  plays: number;
  likes: number;
  comments: number;
  shares: number;
  collects: number;
}

export interface TikTokUserPostsResult {
  videos: TikTokVideoSummary[];
  cursor: string;
  has_more: boolean;
}

export async function ytdlpTikTokUserPosts(
  handleOrUrl: string,
  limit = 30,
): Promise<TikTokUserPostsResult> {
  if (!(await isYtDlpInstalled())) {
    throw new Error(
      "yt-dlp not found on PATH — install with `brew install yt-dlp` or `pipx install yt-dlp`",
    );
  }
  // Accept '@taylorswift', 'taylorswift', or full @user URL.
  let handle = handleOrUrl.trim();
  if (handle.startsWith("http")) {
    const m = handle.match(/tiktok\.com\/@([^/?#]+)/i);
    if (m) handle = m[1];
  }
  handle = handle.replace(/^@/, "");
  const url = `https://www.tiktok.com/@${handle}`;

  const { stdout, stderr, code } = await run(
    "yt-dlp",
    [
      "--flat-playlist",
      "--dump-json",
      "--skip-download",
      "--no-warnings",
      "--playlist-end",
      String(limit),
      url,
    ],
    60_000,
  );
  if (code !== 0) {
    throw new Error(
      `yt-dlp exited ${code}: ${stderr.split("\n").slice(-5).join(" | ").slice(0, 400)}`,
    );
  }

  const lines = stdout.trim().split("\n").filter(Boolean);
  const videos: TikTokVideoSummary[] = lines.map((line) => {
    const e = JSON.parse(line);
    const desc: string = e.description || e.title || "";
    const hashtags = Array.from(
      desc.matchAll(/#([一-龥\w]+)/g),
      (m) => m[1],
    );
    return {
      id: String(e.id || ""),
      url: e.webpage_url || e.url || "",
      desc: desc.replace(/\n/g, " ").slice(0, 200),
      author: e.uploader || "",
      authorName: e.channel || e.uploader || "",
      createTime: e.timestamp || 0,
      duration: e.duration || 0,
      cover: (e.thumbnails || []).find((t: any) => t.id === "cover")?.url
        || (e.thumbnails || [])[0]?.url
        || "",
      hashtags: Array.from(new Set(hashtags)),
      music: [e.track, e.album, ...(e.artists || [])].filter(Boolean).join(" - "),
      plays: e.view_count || 0,
      likes: e.like_count || 0,
      comments: e.comment_count || 0,
      shares: e.repost_count || 0,
      collects: e.save_count || 0,
    };
  });

  return {
    videos,
    // yt-dlp flat-playlist returns everything up to --playlist-end in one
    // shot; there's no incremental cursor. has_more is best-effort
    // (true if we got back the full requested limit).
    cursor: "",
    has_more: videos.length >= limit,
  };
}

// ─── Post detail (yt-dlp single video) ──────────────────────────────

export interface TikTokPostDetail {
  id: string;
  url: string;
  desc: string;
  author: string;
  authorName: string;
  createTime: number;
  duration: number;
  cover: string;
  hashtags: string[];
  music: string;
  plays: number;
  likes: number;
  comments: number;
  shares: number;
  collects: number;
  width: number;
  height: number;
  ratio: string;
  music_id: string;
  music_url: string;
  video_url: string;
}

export async function ytdlpTikTokPostDetail(
  videoIdOrUrl: string,
): Promise<TikTokPostDetail> {
  if (!(await isYtDlpInstalled())) {
    throw new Error(
      "yt-dlp not found on PATH — install with `brew install yt-dlp` or `pipx install yt-dlp`",
    );
  }
  // Accept bare 19-digit id or full URL.
  let url = videoIdOrUrl.trim();
  if (/^\d{15,25}$/.test(url)) {
    // The desktop `/video/<id>` path 404s; the mobile `/v/<id>.html`
    // path 302s to the canonical `@user/video/<id>` URL with all
    // author context — yt-dlp follows the redirect cleanly.
    url = `https://m.tiktok.com/v/${url}.html`;
  }

  const { stdout, stderr, code } = await run(
    "yt-dlp",
    ["--dump-json", "--skip-download", "--no-warnings", url],
    45_000,
  );
  if (code !== 0) {
    throw new Error(
      `yt-dlp exited ${code}: ${stderr.split("\n").slice(-5).join(" | ").slice(0, 400)}`,
    );
  }
  const e = JSON.parse(stdout.trim());
  const desc: string = e.description || e.title || "";
  const hashtags = Array.from(
    desc.matchAll(/#([一-龥\w]+)/g),
    (m) => m[1],
  );
  // Pick a representative video format for `video_url`.
  const video = (e.formats || []).find(
    (f: any) => f.vcodec && f.vcodec !== "none" && f.url,
  );
  const ratio = e.width && e.height
    ? e.width > e.height ? "landscape" : e.width < e.height ? "portrait" : "square"
    : "";

  return {
    id: String(e.id || ""),
    url: e.webpage_url || url,
    desc: desc.replace(/\n/g, " ").slice(0, 500),
    author: e.uploader || "",
    authorName: e.channel || e.uploader || "",
    createTime: e.timestamp || 0,
    duration: e.duration || 0,
    cover: (e.thumbnails || []).find((t: any) => t.id === "cover")?.url
      || (e.thumbnails || [])[0]?.url
      || "",
    hashtags: Array.from(new Set(hashtags)),
    music: [e.track, e.album, ...(e.artists || [])].filter(Boolean).join(" - "),
    plays: e.view_count || 0,
    likes: e.like_count || 0,
    comments: e.comment_count || 0,
    shares: e.repost_count || 0,
    collects: e.save_count || 0,
    width: e.width || 0,
    height: e.height || 0,
    ratio,
    music_id: String(e.music_id || ""),
    music_url: e.music_url || "",
    video_url: video?.url || "",
  };
}

// ─── Music download (yt-dlp audio-only) ─────────────────────────────
//
// `--extract-audio --audio-format mp3` would re-encode locally; instead
// we just `--dump-json` the video metadata and pluck the audio-only
// format's URL out of `info.formats`. TikTok typically exposes a single
// audio-only stream alongside the muxed mp4 — that's the bare music
// track without the user's voiceover layer (when one exists).

export interface TikTokMusicDownloadResult {
  video_id: string;
  music_url: string;     // direct stream URL (may expire — fetch promptly)
  music_format: string;  // 'mp3' | 'm4a' | 'mp4' (audio-only)
  music_title: string;
  music_author: string;
}

export async function ytdlpTikTokMusicDownload(
  videoUrl: string,
): Promise<TikTokMusicDownloadResult> {
  if (!(await isYtDlpInstalled())) {
    throw new Error(
      "yt-dlp not found on PATH — install with `brew install yt-dlp` or `pipx install yt-dlp`",
    );
  }
  let url = videoUrl.trim();
  // Accept bare numeric id (same as ytdlpTikTokPostDetail).
  if (/^\d{15,25}$/.test(url)) {
    url = `https://m.tiktok.com/v/${url}.html`;
  }

  const { stdout, stderr, code } = await run(
    "yt-dlp",
    ["--dump-json", "--skip-download", "--no-warnings", url],
    45_000,
  );
  if (code !== 0) {
    throw new Error(
      `yt-dlp exited ${code}: ${stderr.split("\n").slice(-5).join(" | ").slice(0, 400)}`,
    );
  }
  const info = JSON.parse(stdout.trim());

  // Find the audio-only format (acodec set, vcodec === 'none'). On
  // TikTok this is typically one entry; if none exists, fall back to a
  // muxed mp4's URL — the caller can still play it as audio.
  const audioOnly = (info.formats || []).find(
    (f: any) => f && f.acodec && f.acodec !== "none" && (!f.vcodec || f.vcodec === "none"),
  );
  const muxed = (info.formats || []).find(
    (f: any) => f && f.acodec && f.acodec !== "none" && f.vcodec && f.vcodec !== "none",
  );
  const pick = audioOnly || muxed || null;

  const fmt: string = pick?.audio_ext || pick?.ext || "mp4";
  const artists: string[] = Array.isArray(info.artists) ? info.artists : [];
  const author: string = (artists.join(", ") || info.artist || info.uploader || "") as string;

  return {
    video_id: String(info.id || ""),
    music_url: pick?.url || "",
    music_format: fmt,
    music_title: (info.track || info.title || "") as string,
    music_author: author,
  };
}

// ─── User-video batch download (yt-dlp full playlist with URLs) ─────
//
// Like ytdlpTikTokUserPosts, but resolves each entry's direct mp4
// download URL too — useful for buyers who want to bulk-archive a
// creator's catalog. We do NOT `--flat-playlist` here because the
// flat shape only carries id+webpage_url; the per-video `formats[]`
// (which is where `video_url` lives) is only populated when yt-dlp
// fully traverses each entry. That makes this call ~10x slower than
// the flat variant, but unavoidable for the use case.

export interface TikTokUserBatchVideo {
  id: string;
  url: string;           // canonical webpage URL
  video_url: string;     // direct mp4 URL (may expire)
  cover: string;
  title: string;
  duration: number;
}

export interface TikTokUserBatchDownloadResult {
  user: string;
  total_videos: number;
  videos: TikTokUserBatchVideo[];
}

export async function ytdlpTikTokUserBatchDownload(
  handleOrUrl: string,
  opts: { limit?: number } = {},
): Promise<TikTokUserBatchDownloadResult> {
  if (!(await isYtDlpInstalled())) {
    throw new Error(
      "yt-dlp not found on PATH — install with `brew install yt-dlp` or `pipx install yt-dlp`",
    );
  }
  // Accept @handle, bare handle, full URL, or secUid (yt-dlp accepts
  // the @handle form most reliably — secUid paths 404 the web URL).
  let handle = handleOrUrl.trim();
  if (handle.startsWith("http")) {
    const m = handle.match(/tiktok\.com\/@([^/?#]+)/i);
    if (m) handle = m[1];
  }
  handle = handle.replace(/^@/, "");
  const url = `https://www.tiktok.com/@${handle}`;
  const limit = Math.min(Math.max(opts.limit || 30, 1), 200);

  // NB: NO --flat-playlist here — we need formats[] to land per entry.
  const { stdout, stderr, code } = await run(
    "yt-dlp",
    [
      "--dump-json",
      "--skip-download",
      "--no-warnings",
      "--playlist-end",
      String(limit),
      url,
    ],
    180_000, // can be slow — one HTTP round-trip per video
  );
  if (code !== 0) {
    throw new Error(
      `yt-dlp exited ${code}: ${stderr.split("\n").slice(-5).join(" | ").slice(0, 400)}`,
    );
  }

  const lines = stdout.trim().split("\n").filter(Boolean);
  const videos: TikTokUserBatchVideo[] = lines.map((line) => {
    const e = JSON.parse(line);
    const formats: any[] = Array.isArray(e.formats) ? e.formats : [];
    // Prefer a muxed mp4 (video+audio); fall back to video-only.
    const muxed = formats.find(
      (f: any) => f && f.url && f.vcodec && f.vcodec !== "none" && f.acodec && f.acodec !== "none",
    );
    const videoOnly = formats.find(
      (f: any) => f && f.url && f.vcodec && f.vcodec !== "none",
    );
    const pick = muxed || videoOnly || null;
    return {
      id: String(e.id || ""),
      url: e.webpage_url || e.url || "",
      video_url: pick?.url || "",
      cover: (e.thumbnails || []).find((t: any) => t.id === "cover")?.url
        || (e.thumbnails || [])[0]?.url
        || "",
      title: (e.title || e.description || "").replace(/\n/g, " ").slice(0, 200),
      duration: typeof e.duration === "number" ? e.duration : Number(e.duration) || 0,
    };
  });

  return {
    user: handle,
    total_videos: videos.length,
    videos,
  };
}
