import { uploadFile } from "../../../hub/media.js";
import type { ProviderConfig, ProviderSettings } from "../../../hub/types.js";
import { loadConfig } from "../../../utils/config.js";

const DEFAULT_API_BASE_URL = "https://api.bnbot.ai/api/v1";

interface MediaItem {
  path?: string;
  mime?: string;
  width?: number;
  height?: number;
  bytes?: number;
  [key: string]: unknown;
}

interface MediaResult {
  images?: MediaItem[];
  videos?: MediaItem[];
  [key: string]: unknown;
}

export async function uploadCodexImageResult(
  raw: unknown,
): Promise<MediaResult> {
  return uploadMediaResult(raw, "images");
}

export async function uploadMediaResult(
  raw: unknown,
  collectionKey: "images" | "videos",
): Promise<MediaResult> {
  const result = normalizeResult(raw);
  const config = loadUploadConfig();
  const uploadedItems: MediaItem[] = [];

  for (const item of result[collectionKey] ?? []) {
    if (!item.path) continue;
    const url = await uploadFile(item.path, config);
    if (!url) {
      throw new Error(`failed to upload generated media: ${item.path}`);
    }
    const { path: _path, base64: _base64, b64_json: _b64Json, ...rest } = item;
    uploadedItems.push({
      ...rest,
      url,
    });
  }

  if (uploadedItems.length === 0) {
    throw new Error(`no generated ${collectionKey.slice(0, -1)} path available for CDN upload`);
  }

  return {
    ...result,
    response_format: "url",
    [collectionKey]: uploadedItems,
    artifacts: undefined,
  };
}

function normalizeResult(raw: unknown): MediaResult {
  if (!raw || typeof raw !== "object") {
    throw new Error("bnbot returned invalid media generation result");
  }
  return raw as MediaResult;
}

function loadUploadConfig(): ProviderConfig {
  const config = loadConfig();
  const apiKey =
    (process.env.SPAREAI_API_KEY ?? process.env.CLAWMONEY_API_KEY) ||
    process.env.API_KEY ||
    config?.api_key;
  if (!apiKey) {
    throw new Error(
      "missing API key for CDN upload; set API_KEY or run spareai setup",
    );
  }

  const providerRaw = (config?.provider ?? {}) as Partial<ProviderSettings>;
  const apiBaseUrl =
    (process.env.SPAREAI_API_BASE_URL ?? process.env.CLAWMONEY_API_BASE_URL) ||
    process.env.BNBOT_API_BASE_URL ||
    providerRaw.api_base_url ||
    DEFAULT_API_BASE_URL;

  return {
    api_key: apiKey,
    agent_id: process.env.AGENT_ID || config?.agent_id,
    agent_slug: config?.agent_slug,
    provider: {
      cli_command: providerRaw.cli_command ?? "bnbot",
      max_concurrent: providerRaw.max_concurrent ?? 1,
      auto_accept: providerRaw.auto_accept ?? false,
      ws_url: providerRaw.ws_url ?? "",
      api_base_url: apiBaseUrl,
      polling: providerRaw.polling ?? {
        connected_interval: 120,
        disconnected_interval: 15,
      },
      reconnect: providerRaw.reconnect ?? {
        initial: 5,
        max: 300,
        multiplier: 2,
      },
      skills: providerRaw.skills,
    },
  };
}
