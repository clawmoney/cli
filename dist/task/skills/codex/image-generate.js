import { bnbotCodexImageGenerate } from "./_bnbot.js";
import { uploadCodexImageResult } from "./_upload.js";
import { startProgressTicker } from "../tiktok/_helpers.js";
function str(input, names) {
    for (const name of names) {
        const value = input[name];
        if (typeof value === "string" && value.trim())
            return value;
    }
    return undefined;
}
function num(input, names) {
    for (const name of names) {
        const value = input[name];
        if (typeof value === "number" && Number.isFinite(value))
            return value;
        if (typeof value === "string" && value.trim()) {
            const parsed = Number.parseInt(value, 10);
            if (Number.isFinite(parsed))
                return parsed;
        }
    }
    return undefined;
}
export const codexImageGenerateSkill = {
    price_usd: 0.03,
    async run(input, ctx) {
        const i = (input ?? {});
        const prompt = str(i, ["prompt"]);
        if (!prompt)
            throw new Error("missing 'prompt'");
        const responseFormat = str(i, ["response_format", "responseFormat"]) ?? "url";
        if (responseFormat !== "url" && responseFormat !== "b64_json" && responseFormat !== "path") {
            throw new Error("response_format must be one of: url, b64_json, path");
        }
        ctx.report({ stage: "launching", percent: 5, note: "Launching Codex Desktop Image Gen..." });
        const stop = startProgressTicker(ctx, "Codex image generation working...");
        try {
            const raw = await bnbotCodexImageGenerate({
                prompt,
                size: str(i, ["size"]),
                quality: str(i, ["quality"]),
                response_format: responseFormat === "url" ? "path" : responseFormat,
                timeout: num(i, ["timeout", "timeout_s", "timeoutSeconds"]) ?? 300,
                fresh: i.fresh === true || i.new === true,
            });
            const result = raw;
            if (result.success === false) {
                throw new Error(result.error || "Codex image generation failed");
            }
            if (responseFormat === "url") {
                ctx.report({ stage: "uploading", percent: 90, note: "Uploading generated image..." });
                const uploaded = await uploadCodexImageResult(raw);
                ctx.report({ stage: "done", percent: 100, note: "Image generated and uploaded" });
                return uploaded;
            }
            ctx.report({ stage: "done", percent: 100, note: "Image generated" });
            return raw;
        }
        finally {
            stop();
        }
    },
};
