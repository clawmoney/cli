import { readFileSync, statSync } from "node:fs";
import { basename, extname } from "node:path";

const MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
};
import type { ProviderConfig } from "./types.js";
import { logger } from "./logger.js";

/**
 * Upload a local file to the Hub media endpoint (R2).
 * Returns the public CDN URL on success, or null on failure.
 */
export async function uploadFile(
  filePath: string,
  config: ProviderConfig
): Promise<string | null> {
  const url = `${config.provider.api_base_url}/hub/media/upload`;

  try {
    const stat = statSync(filePath);
    if (!stat.isFile()) {
      logger.warn(`uploadFile: not a regular file: ${filePath}`);
      return null;
    }

    const fileBuffer = readFileSync(filePath);
    const fileName = basename(filePath);

    const ext = extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || "application/octet-stream";

    const formData = new FormData();
    formData.append("file", new Blob([fileBuffer], { type: contentType }), fileName);

    const resp = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.api_key}`,
      },
      body: formData,
    });

    if (!resp.ok) {
      const body = await resp.text();
      logger.error(`uploadFile failed (${resp.status}): ${body}`);
      return null;
    }

    const data = (await resp.json()) as { file_url?: string };
    if (!data.file_url) {
      logger.error("uploadFile: response missing file_url");
      return null;
    }

    logger.info(`Uploaded ${fileName} -> ${data.file_url}`);
    return data.file_url;
  } catch (err) {
    logger.error(`uploadFile error for ${filePath}:`, err);
    return null;
  }
}

/** Known output keys that may contain local file paths. */
const FILE_PATH_KEYS = [
  "image_path",
  "video_path",
  "audio_path",
  "file_path",
  "document_path",
];

/**
 * Walk the output object and replace any local file paths with CDN URLs.
 * Mutates the object in-place and returns it.
 */
export async function replaceLocalPaths(
  output: Record<string, unknown>,
  config: ProviderConfig
): Promise<Record<string, unknown>> {
  for (const key of FILE_PATH_KEYS) {
    const val = output[key];
    if (typeof val === "string" && val.startsWith("/")) {
      const cdnUrl = await uploadFile(val, config);
      if (cdnUrl) {
        const urlKey = key.replace("_path", "_url");
        output[urlKey] = cdnUrl;
        delete output[key];
      }
    }
  }
  return output;
}
