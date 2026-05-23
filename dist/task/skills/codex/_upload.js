import { uploadFile } from "../../../hub/media.js";
import { loadConfig } from "../../../utils/config.js";
const DEFAULT_API_BASE_URL = "https://api.bnbot.ai/api/v1";
export async function uploadCodexImageResult(raw) {
    const result = normalizeResult(raw);
    const config = loadUploadConfig();
    const uploadedImages = [];
    for (const image of result.images ?? []) {
        if (!image.path)
            continue;
        const url = await uploadFile(image.path, config);
        if (!url) {
            throw new Error(`failed to upload generated image: ${image.path}`);
        }
        uploadedImages.push({
            url,
            mime: image.mime,
            width: image.width,
            height: image.height,
            bytes: image.bytes,
        });
    }
    if (uploadedImages.length === 0) {
        throw new Error("no generated image path available for CDN upload");
    }
    return {
        ...result,
        response_format: "url",
        images: uploadedImages,
        artifacts: undefined,
    };
}
function normalizeResult(raw) {
    if (!raw || typeof raw !== "object") {
        throw new Error("bnbot returned invalid image generation result");
    }
    const result = raw;
    if (!Array.isArray(result.images)) {
        throw new Error("bnbot returned no images array");
    }
    return result;
}
function loadUploadConfig() {
    const config = loadConfig();
    const apiKey = process.env.CLAWMONEY_API_KEY ||
        process.env.API_KEY ||
        config?.api_key;
    if (!apiKey) {
        throw new Error("missing API key for CDN upload; set API_KEY or run clawmoney setup");
    }
    const providerRaw = (config?.provider ?? {});
    const apiBaseUrl = process.env.CLAWMONEY_API_BASE_URL ||
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
