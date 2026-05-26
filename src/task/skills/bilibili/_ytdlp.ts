import { spawn } from "node:child_process";

function run(
  cmd: string,
  args: string[],
  timeoutMs = 60_000,
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

export async function isYtDlpInstalled(): Promise<boolean> {
  try {
    const { code } = await run("yt-dlp", ["--version"], 5_000);
    return code === 0;
  } catch {
    return false;
  }
}

export interface BilibiliDownloadFormat {
  format_id: string;
  url: string;
  ext: string;
  mime_type: string;
  width: number;
  height: number;
  fps: number;
  bitrate: number;
  content_length: string;
  has_audio: boolean;
  has_video: boolean;
  vcodec: string;
  acodec: string;
  protocol: string;
}

export interface BilibiliDownloadResult {
  id: string;
  title: string;
  author: string;
  duration: number;
  thumbnail: string;
  webpage_url: string;
  best_video?: BilibiliDownloadFormat;
  best_audio?: BilibiliDownloadFormat;
  requested_formats: BilibiliDownloadFormat[];
  formats: BilibiliDownloadFormat[];
}

function toBilibiliUrl(value: string): string {
  const s = value.trim();
  if (/^https?:\/\//i.test(s)) return s;
  const match = s.match(/(BV[A-Za-z0-9]+)/i);
  if (match) return `https://www.bilibili.com/video/${match[1]}`;
  return s;
}

function mapFormat(f: any): BilibiliDownloadFormat {
  const vcodec = String(f.vcodec || "");
  const acodec = String(f.acodec || "");
  const hasVideo = !!(vcodec && vcodec !== "none");
  const hasAudio = !!(acodec && acodec !== "none");
  const codecs: string[] = [];
  if (hasVideo) codecs.push(vcodec);
  if (hasAudio) codecs.push(acodec);
  const codecPart = codecs.length ? `; codecs="${codecs.join(", ")}"` : "";
  const mimeBase = hasVideo
    ? `video/${f.video_ext || f.ext || "mp4"}`
    : hasAudio
      ? `audio/${f.audio_ext || f.ext || "m4a"}`
      : f.ext || "application/octet-stream";
  return {
    format_id: String(f.format_id || ""),
    url: String(f.url || ""),
    ext: String(f.ext || ""),
    mime_type: `${mimeBase}${codecPart}`,
    width: Number(f.width) || 0,
    height: Number(f.height) || 0,
    fps: Number(f.fps) || 0,
    bitrate: f.tbr ? Math.round(Number(f.tbr) * 1000) : f.abr ? Math.round(Number(f.abr) * 1000) : 0,
    content_length: f.filesize ? String(f.filesize) : f.filesize_approx ? String(f.filesize_approx) : "",
    has_audio: hasAudio,
    has_video: hasVideo,
    vcodec,
    acodec,
    protocol: String(f.protocol || ""),
  };
}

export async function ytdlpBilibiliDownload(input: string): Promise<BilibiliDownloadResult> {
  if (!(await isYtDlpInstalled())) {
    throw new Error("yt-dlp not found on PATH — install with `brew install yt-dlp` or `pipx install yt-dlp`");
  }

  const url = toBilibiliUrl(input);
  const args = [
    "--cookies-from-browser",
    "chrome",
    "--dump-json",
    "--skip-download",
    "--no-warnings",
    url,
  ];
  const { stdout, stderr, code } = await run("yt-dlp", args, 75_000);
  if (code !== 0) {
    throw new Error(`yt-dlp exited ${code}: ${stderr.split("\n").slice(-5).join(" | ").slice(0, 500)}`);
  }

  let info: any;
  try {
    info = JSON.parse(stdout.trim());
  } catch {
    throw new Error("yt-dlp output was not valid JSON");
  }

  const formats = (info.formats || [])
    .filter((f: any) => f && f.url && f.ext !== "mhtml" && f.protocol !== "mhtml")
    .map(mapFormat);
  const requestedFormats = (info.requested_formats || [])
    .filter((f: any) => f && f.url)
    .map(mapFormat);
  const bestVideo =
    requestedFormats.find((f: BilibiliDownloadFormat) => f.has_video && !f.has_audio)
    ?? formats
      .filter((f: BilibiliDownloadFormat) => f.has_video)
      .sort((a: BilibiliDownloadFormat, b: BilibiliDownloadFormat) => (b.height - a.height) || (b.bitrate - a.bitrate))[0];
  const bestAudio =
    requestedFormats.find((f: BilibiliDownloadFormat) => f.has_audio && !f.has_video)
    ?? formats
      .filter((f: BilibiliDownloadFormat) => f.has_audio)
      .sort((a: BilibiliDownloadFormat, b: BilibiliDownloadFormat) => b.bitrate - a.bitrate)[0];

  return {
    id: String(info.id || input),
    title: String(info.title || ""),
    author: String(info.uploader || info.channel || ""),
    duration: Number(info.duration) || 0,
    thumbnail: String(info.thumbnail || ""),
    webpage_url: String(info.webpage_url || url),
    best_video: bestVideo,
    best_audio: bestAudio,
    requested_formats: requestedFormats,
    formats,
  };
}
