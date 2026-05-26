import type { SkillHandler } from "../../types.js";
import { uploadCodexImageResult } from "../codex/_upload.js";
import { startProgressTicker } from "../tiktok/_helpers.js";
import { bnbotChatGPTWebImageGenerate } from "./_bnbot.js";

type Input = Record<string, unknown>;
const BASE_PRICE_USD = 0.04;
const MAX_IMAGES = 6;

function str(input: Input, names: string[]): string | undefined {
  for (const name of names) {
    const value = input[name];
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

function num(input: Input, names: string[]): number | undefined {
  for (const name of names) {
    const value = input[name];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim()) {
      const parsed = Number.parseInt(value, 10);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

function bool(input: Input, names: string[]): boolean | undefined {
  for (const name of names) {
    const value = input[name];
    if (typeof value === "boolean") return value;
    if (typeof value === "string" && value.trim()) {
      if (/^(true|1|yes)$/i.test(value)) return true;
      if (/^(false|0|no)$/i.test(value)) return false;
    }
  }
  return undefined;
}

function strings(input: Input, names: string[]): string[] {
  const out: string[] = [];
  for (const name of names) {
    const value = input[name];
    if (typeof value === "string" && value.trim()) out.push(value);
    else if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === "string" && item.trim()) out.push(item);
      }
    }
  }
  return Array.from(new Set(out));
}

function imageCount(input: Input): number {
  const requested = num(input, ["n", "count", "image_count", "imageCount"]) ?? 1;
  return Math.max(1, Math.min(MAX_IMAGES, requested));
}

export const chatgptWebImageGenerateSkill: SkillHandler = {
  price_usd: (input) => BASE_PRICE_USD * imageCount((input ?? {}) as Input),
  async run(input, ctx) {
    const i = (input ?? {}) as Input;
    const prompt = str(i, ["prompt"]);
    if (!prompt) throw new Error("missing 'prompt'");

    const responseFormat = str(i, ["response_format", "responseFormat"]) ?? "url";
    if (responseFormat !== "url" && responseFormat !== "b64_json" && responseFormat !== "path") {
      throw new Error("response_format must be one of: url, b64_json, path");
    }

    ctx.report({ stage: "launching", percent: 5, note: "Driving ChatGPT web image generation..." });
    const stop = startProgressTicker(ctx, "ChatGPT web image generation working...");
    try {
      const raw = await bnbotChatGPTWebImageGenerate({
        prompt,
        n: imageCount(i),
        size: str(i, ["size", "image_size", "imageSize", "aspect_ratio", "aspectRatio", "ratio"]),
        quality: str(i, ["quality"]),
        images: strings(i, ["image", "images", "reference_image", "reference_images", "referenceImages"]),
        response_format: responseFormat === "url" ? "path" : responseFormat,
        timeout: num(i, ["timeout", "timeout_s", "timeoutSeconds"]) ?? 300,
        tab_id: str(i, ["tab_id", "tabId"]),
        url: str(i, ["url"]),
        keep_chat: bool(i, ["keep_chat", "keepChat"]),
      });
      const result = raw as { success?: boolean; error?: string };
      if (result.success === false) {
        throw new Error(result.error || "ChatGPT web image generation failed");
      }
      if (responseFormat === "url") {
        ctx.report({ stage: "uploading", percent: 90, note: "Uploading generated image..." });
        const uploaded = await uploadCodexImageResult(raw);
        ctx.report({ stage: "done", percent: 100, note: "Image generated and uploaded" });
        return uploaded;
      }
      ctx.report({ stage: "done", percent: 100, note: "Image generated" });
      return raw;
    } finally {
      stop();
    }
  },
};
