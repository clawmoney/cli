import type { SkillHandler } from "../../types.js";
import { bnbotCodexImageGenerate } from "./_bnbot.js";
import { startProgressTicker } from "../tiktok/_helpers.js";

type Input = Record<string, unknown>;

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

export const codexImageGenerateSkill: SkillHandler = {
  price_usd: 0.03,
  async run(input, ctx) {
    const i = (input ?? {}) as Input;
    const prompt = str(i, ["prompt"]);
    if (!prompt) throw new Error("missing 'prompt'");

    const responseFormat = str(i, ["response_format", "responseFormat"]) ?? "b64_json";
    if (responseFormat !== "b64_json" && responseFormat !== "path") {
      throw new Error("response_format must be one of: b64_json, path");
    }

    ctx.report({ stage: "launching", percent: 5, note: "Launching Codex Desktop Image Gen..." });
    const stop = startProgressTicker(ctx, "Codex image generation working...");
    try {
      const raw = await bnbotCodexImageGenerate({
        prompt,
        size: str(i, ["size"]),
        response_format: responseFormat,
        timeout: num(i, ["timeout", "timeout_s", "timeoutSeconds"]) ?? 300,
        fresh: i.fresh === true || i.new === true,
      });
      const result = raw as { success?: boolean; error?: string };
      if (result.success === false) {
        throw new Error(result.error || "Codex image generation failed");
      }
      ctx.report({ stage: "done", percent: 100, note: "Image generated" });
      return raw;
    } finally {
      stop();
    }
  },
};
