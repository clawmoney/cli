import { uploadCodexImageResult } from "../codex/_upload.js";
import { startProgressTicker } from "../tiktok/_helpers.js";
import { bnbotChatGPTImageGenerate } from "./_bnbot.js";
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
function strings(input, names) {
    const out = [];
    for (const name of names) {
        const value = input[name];
        if (typeof value === "string" && value.trim())
            out.push(value);
        else if (Array.isArray(value)) {
            for (const item of value) {
                if (typeof item === "string" && item.trim())
                    out.push(item);
            }
        }
    }
    return Array.from(new Set(out));
}
export const chatgptImageGenerateSkill = {
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
        ctx.report({ stage: "launching", percent: 5, note: "Launching ChatGPT Desktop Image Gen..." });
        const stop = startProgressTicker(ctx, "ChatGPT image generation working...");
        try {
            const raw = await bnbotChatGPTImageGenerate({
                prompt,
                model: str(i, ["model"]),
                size: str(i, ["size"]),
                quality: str(i, ["quality"]),
                images: strings(i, ["image", "images", "reference_image", "reference_images", "referenceImages"]),
                response_format: responseFormat === "url" ? "path" : responseFormat,
                timeout: num(i, ["timeout", "timeout_s", "timeoutSeconds"]) ?? 300,
                fresh: i.fresh === true || i.new === true,
                restart: i.restart !== false,
            });
            const result = raw;
            if (result.success === false) {
                throw new Error(result.error || "ChatGPT image generation failed");
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
