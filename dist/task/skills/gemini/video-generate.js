import { startProgressTicker } from "../tiktok/_helpers.js";
import { bnbotGeminiVideoGenerate } from "./_bnbot.js";
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
export const geminiVideoGenerateSkill = {
    price_usd: 0.5,
    async run(input, ctx) {
        const i = (input ?? {});
        const prompt = str(i, ["prompt"]);
        if (!prompt)
            throw new Error("missing 'prompt'");
        const responseFormat = str(i, ["response_format", "responseFormat"]) ?? "path";
        if (responseFormat !== "path" && responseFormat !== "b64_json") {
            throw new Error("response_format must be one of: path, b64_json");
        }
        ctx.report({ stage: "launching", percent: 5, note: "Driving Gemini web video generation..." });
        const stop = startProgressTicker(ctx, "Gemini web video generation working...");
        try {
            const raw = await bnbotGeminiVideoGenerate({
                prompt,
                aspect: str(i, ["aspect", "aspect_ratio", "aspectRatio", "ratio"]),
                images: strings(i, ["image", "images", "reference_image", "reference_images", "referenceImages"]),
                response_format: responseFormat,
                timeout: num(i, ["timeout", "timeout_s", "timeoutSeconds"]) ?? 900,
            });
            const result = raw;
            if (result.success === false) {
                throw new Error(result.error || "Gemini video generation failed");
            }
            ctx.report({ stage: "done", percent: 100, note: "Video generated" });
            return raw;
        }
        finally {
            stop();
        }
    },
};
