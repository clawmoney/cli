import { bnbotChatGPTAsk } from "./_bnbot.js";
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
function promptFromInput(input) {
    const prompt = str(input, ["prompt", "text", "input"]);
    if (prompt)
        return prompt;
    const messages = input.messages;
    if (!Array.isArray(messages))
        return undefined;
    const parts = messages
        .map((message) => messageToText(message))
        .filter((part) => Boolean(part));
    return parts.length > 0 ? parts.join("\n\n") : undefined;
}
function messageToText(message) {
    const role = typeof message.role === "string" ? message.role : "user";
    const content = message.content;
    if (typeof content === "string")
        return `${role}: ${content}`;
    if (Array.isArray(content)) {
        const text = content
            .map((part) => {
            if (!part || typeof part !== "object")
                return "";
            const value = part.text;
            return typeof value === "string" ? value : "";
        })
            .filter(Boolean)
            .join("\n");
        return text ? `${role}: ${text}` : undefined;
    }
    return undefined;
}
export const chatgptAskSkill = {
    price_usd: 0.02,
    async run(input, ctx) {
        const i = (input ?? {});
        const prompt = promptFromInput(i);
        if (!prompt)
            throw new Error("missing 'prompt' or 'messages'");
        const timeout = num(i, ["timeout", "timeout_s", "timeoutSeconds"]) ?? 60;
        ctx.report({ stage: "launching", percent: 5, note: "Launching ChatGPT Desktop..." });
        const stop = startProgressTicker(ctx, "ChatGPT Desktop is responding...");
        try {
            const raw = await bnbotChatGPTAsk({
                prompt,
                model: str(i, ["model"]),
                timeout,
                fresh: i.fresh === true || i.new === true,
            });
            const result = raw;
            if (result.success === false) {
                throw new Error(result.error || "ChatGPT did not return a response");
            }
            ctx.report({ stage: "done", percent: 100, note: "ChatGPT response received" });
            return raw;
        }
        finally {
            stop();
        }
    },
};
