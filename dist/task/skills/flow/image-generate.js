import { uploadMediaResult } from "../codex/_upload.js";
import { startProgressTicker } from "../tiktok/_helpers.js";
import { bnbotFlowImageGenerate } from "./_bnbot.js";
function str(input, names) {
    for (const name of names) {
        const v = input[name];
        if (typeof v === "string" && v.trim())
            return v;
    }
    return undefined;
}
function num(input, names) {
    for (const name of names) {
        const v = input[name];
        if (typeof v === "number" && Number.isFinite(v))
            return v;
        if (typeof v === "string" && v.trim()) {
            const parsed = Number.parseInt(v, 10);
            if (Number.isFinite(parsed))
                return parsed;
        }
    }
    return undefined;
}
function strings(input, names) {
    const out = [];
    for (const name of names) {
        const v = input[name];
        if (typeof v === "string" && v.trim())
            out.push(v);
        else if (Array.isArray(v)) {
            for (const item of v) {
                if (typeof item === "string" && item.trim())
                    out.push(item);
            }
        }
    }
    return Array.from(new Set(out));
}
export const flowImageGenerateSkill = {
    price_usd: 0.1,
    async run(input, ctx) {
        const i = (input ?? {});
        const prompt = str(i, ["prompt"]);
        if (!prompt)
            throw new Error("missing 'prompt'");
        const responseFormat = str(i, ["response_format", "responseFormat"]) ?? "path";
        if (responseFormat !== "url" && responseFormat !== "path" && responseFormat !== "b64_json") {
            throw new Error("response_format must be one of: url, path, b64_json");
        }
        ctx.report({ stage: "launching", percent: 5, note: "Driving Flow image generation..." });
        const stop = startProgressTicker(ctx, "Flow image generation working...");
        try {
            const raw = await bnbotFlowImageGenerate({
                prompt,
                aspect: str(i, ["aspect", "aspect_ratio", "aspectRatio", "ratio"]),
                count: num(i, ["count", "num", "variants"]),
                model: str(i, ["model", "model_name", "modelName"]),
                images: strings(i, ["image", "images", "reference_image", "reference_images", "referenceImages", "ingredient", "ingredients"]),
                project: str(i, ["project", "project_id", "projectId"]),
                response_format: responseFormat === "url" ? "path" : responseFormat,
                timeout: num(i, ["timeout", "timeout_s", "timeoutSeconds"]) ?? 300,
            });
            const result = raw;
            if (result.success === false) {
                throw new Error(result.error || "Flow image generation failed");
            }
            if (responseFormat === "url") {
                ctx.report({ stage: "uploading", percent: 90, note: "Uploading generated images..." });
                const uploaded = await uploadMediaResult(raw, "images");
                ctx.report({ stage: "done", percent: 100, note: "Images generated and uploaded" });
                return uploaded;
            }
            ctx.report({ stage: "done", percent: 100, note: "Images generated" });
            return raw;
        }
        finally {
            stop();
        }
    },
};
