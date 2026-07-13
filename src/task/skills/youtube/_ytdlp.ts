/**
 * yt-dlp shell-out helpers for YouTube data that the chrome-extension
 * path can't reach reliably.
 *
 * Why: in 2026 YouTube's anti-automation gates (page-load JS challenge,
 * pot/proof-of-token, /youtubei/v1 precondition checks) reject our
 * page-context POSTs and our window.fetch overrides for endpoints like
 * /get_transcript. yt-dlp ships a maintained workaround stack (deno
 * JS challenge solver, jsinterp, PO token providers) that has stayed
 * one step ahead of these gates. Shell-out keeps spareai itself out
 * of the JS-reverse-engineering arms race.
 *
 * Install on the provider host:
 *   brew install yt-dlp     (mac)
 *   pipx install yt-dlp     (linux)
 *   pip install yt-dlp deno (if jsinterp needed; usually optional)
 */

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

/** Run a command, return {stdout, stderr, code}. Times out after `timeoutMs`. */
function run(cmd: string, args: string[], timeoutMs = 30_000): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${cmd} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (b) => { stdout += b.toString(); });
    child.stderr.on("data", (b) => { stderr += b.toString(); });
    child.on("error", (err) => { clearTimeout(timer); reject(err); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ stdout, stderr, code: code ?? -1 }); });
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

export interface TranscriptLine {
  start: number;
  duration: number;
  text: string;
}

export interface TranscriptResult {
  id: string;
  language: string;
  language_code: string;
  is_translatable: boolean;
  lines: TranscriptLine[];
}

/**
 * Fetch a video's transcript using yt-dlp. Prefers human-uploaded
 * captions for the requested lang, then auto-generated for the
 * requested lang, then human English, then auto-generated English.
 *
 * Throws if yt-dlp isn't installed or no transcript exists.
 */
export async function ytdlpTranscript(videoId: string, langPref = "en"): Promise<TranscriptResult> {
  if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) {
    throw new Error(`invalid videoId: ${videoId}`);
  }
  if (!(await isYtDlpInstalled())) {
    throw new Error("yt-dlp not found on PATH — install with `brew install yt-dlp` or `pipx install yt-dlp`");
  }

  // Use a per-call scratch dir so concurrent requests don't collide.
  const scratch = path.join(os.tmpdir(), `spareai-yt-${crypto.randomBytes(6).toString("hex")}`);
  await fs.mkdir(scratch, { recursive: true });

  try {
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    // First pass: try uploaded captions for langPref, then English.
    // --write-subs picks human-uploaded; --write-auto-subs falls back
    // to YouTube's ASR. yt-dlp will combine both when listed in the
    // language spec, preferring human captions.
    const subLangs = Array.from(new Set([langPref, "en", `${langPref}-orig`])).join(",");
    const args = [
      "--skip-download",
      "--write-subs",
      "--write-auto-subs",
      "--sub-langs", subLangs,
      "--sub-format", "json3",
      "--no-warnings",
      "-o", path.join(scratch, "%(id)s.%(ext)s"),
      url,
    ];
    const { code, stderr } = await run("yt-dlp", args, 60_000);
    if (code !== 0) {
      throw new Error(`yt-dlp exited ${code}: ${stderr.split("\n").slice(-5).join(" | ").slice(0, 400)}`);
    }

    // Discover whichever json3 file landed (lang code can drift —
    // e.g. requesting `en` may land `en.json3` or `en-orig.json3`).
    const files = await fs.readdir(scratch);
    const json3 = files.find((f) => f.startsWith(videoId) && f.endsWith(".json3"));
    if (!json3) {
      throw new Error(`no .json3 transcript produced — video may have no captions in ${subLangs}`);
    }

    // Filename: <id>.<lang>.json3 (auto-captions sometimes use
    // `<id>.<lang>-orig.json3`). Parse the lang code out for the
    // response envelope.
    const langMatch = json3.match(new RegExp(`^${videoId}\\.([^.]+)\\.json3$`));
    const langCode = langMatch ? langMatch[1] : langPref;

    const raw = await fs.readFile(path.join(scratch, json3), "utf-8");
    const json = JSON.parse(raw) as { events?: Array<{ tStartMs?: number; dDurationMs?: number; segs?: Array<{ utf8?: string }> }> };

    const lines: TranscriptLine[] = [];
    for (const ev of json.events || []) {
      if (!ev || !Array.isArray(ev.segs)) continue;
      const text = ev.segs.map((s) => s.utf8 || "").join("").replace(/\s+/g, " ").trim();
      if (!text) continue;
      lines.push({
        start: (ev.tStartMs || 0) / 1000,
        duration: (ev.dDurationMs || 0) / 1000,
        text,
      });
    }

    return {
      id: videoId,
      language: langCode.replace(/-orig$/, "") === "en" ? "English" : langCode,
      language_code: langCode.replace(/-orig$/, ""),
      // yt-dlp can request translated versions, so the source is
      // translatable as long as any captions exist.
      is_translatable: lines.length > 0,
      lines,
    };
  } finally {
    // Best-effort cleanup; don't fail the request on rm errors.
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}

export interface StreamingFormat {
  itag: number;
  url: string;
  mime_type: string;
  bitrate: number;
  width: number;
  height: number;
  fps: number;
  quality: string;
  quality_label: string;
  audio_quality: string;
  audio_sample_rate: string;
  audio_channels: number;
  approx_duration_ms: string;
  content_length: string;
  signature_cipher: string;
  has_audio: boolean;
  has_video: boolean;
}

export interface StreamingDataResult {
  id: string;
  expires_in_seconds: string;
  formats: StreamingFormat[];
  adaptive_formats: StreamingFormat[];
  hls_manifest_url: string;
  dash_manifest_url: string;
}

/**
 * Fetch a video's streaming formats (download URLs + manifests) via
 * yt-dlp.
 *
 * The browser-context fallback was unreliable because YouTube returns
 * stub data for the target video on hooked sessions (it serves real
 * data only for the autoplay-preloaded *next* video). yt-dlp solves
 * the JS challenge / PO token machinery and impersonates an ANDROID_VR
 * client which YouTube currently lets through.
 */
export async function ytdlpStreamingData(videoId: string): Promise<StreamingDataResult> {
  if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) {
    throw new Error(`invalid videoId: ${videoId}`);
  }
  if (!(await isYtDlpInstalled())) {
    throw new Error("yt-dlp not found on PATH — install with `brew install yt-dlp` or `pipx install yt-dlp`");
  }

  const { stdout, stderr, code } = await run(
    "yt-dlp",
    ["--dump-json", "--skip-download", "--no-warnings", `https://www.youtube.com/watch?v=${videoId}`],
    45_000,
  );
  if (code !== 0) {
    throw new Error(`yt-dlp exited ${code}: ${stderr.split("\n").slice(-5).join(" | ").slice(0, 400)}`);
  }

  // yt-dlp may emit warnings on stderr but the JSON should be a single
  // line on stdout. Tolerate trailing whitespace.
  let info: any;
  try {
    info = JSON.parse(stdout.trim());
  } catch {
    throw new Error("yt-dlp output was not valid JSON");
  }

  const durationMs = info.duration ? String(Math.round(info.duration * 1000)) : "";
  const audioBitrateBand = (abr: number) => abr >= 192 ? "AUDIO_QUALITY_HIGH" : abr >= 96 ? "AUDIO_QUALITY_MEDIUM" : "AUDIO_QUALITY_LOW";

  const mapFormat = (f: any): StreamingFormat => {
    const hasVideo = !!(f.vcodec && f.vcodec !== "none");
    const hasAudio = !!(f.acodec && f.acodec !== "none");
    const codecs: string[] = [];
    if (hasVideo && f.vcodec !== "none") codecs.push(f.vcodec);
    if (hasAudio && f.acodec !== "none") codecs.push(f.acodec);
    const codecPart = codecs.length ? `; codecs="${codecs.join(", ")}"` : "";
    const mimeBase = hasVideo ? `video/${f.video_ext || f.ext}` : hasAudio ? `audio/${f.audio_ext || f.ext}` : (f.ext || "application/octet-stream");
    return {
      itag: parseInt(String(f.format_id || "0"), 10) || 0,
      url: f.url || "",
      mime_type: `${mimeBase}${codecPart}`,
      bitrate: f.tbr ? Math.round(f.tbr * 1000) : (f.abr ? Math.round(f.abr * 1000) : 0),
      width: f.width || 0,
      height: f.height || 0,
      fps: f.fps || 0,
      quality: f.format_note || (f.height ? `hd${f.height}` : "tiny"),
      quality_label: f.height ? `${f.height}p${f.fps && f.fps > 30 ? f.fps : ""}` : "",
      audio_quality: hasAudio && f.abr ? audioBitrateBand(f.abr) : "",
      audio_sample_rate: f.asr ? String(f.asr) : "",
      audio_channels: f.audio_channels || 0,
      approx_duration_ms: durationMs,
      content_length: f.filesize ? String(f.filesize) : (f.filesize_approx ? String(f.filesize_approx) : ""),
      signature_cipher: "",
      has_audio: hasAudio,
      has_video: hasVideo,
    };
  };

  // yt-dlp lists every format flat. Storyboard ('mhtml'), images, and
  // formats without a URL are filtered out. YouTube's compat surface
  // separates muxed (`formats`) from streams-only (`adaptive_formats`).
  const allFormats: StreamingFormat[] = (info.formats || [])
    .filter((f: any) => f && f.url && f.ext !== "mhtml" && f.protocol !== "mhtml")
    .map(mapFormat);
  const formats = allFormats.filter((f) => f.has_audio && f.has_video);
  const adaptive = allFormats.filter((f) => !(f.has_audio && f.has_video));

  return {
    id: info.id || videoId,
    expires_in_seconds: "21540",
    formats,
    adaptive_formats: adaptive,
    hls_manifest_url: info.hls_url || "",
    dash_manifest_url: info.dash_url || "",
  };
}
