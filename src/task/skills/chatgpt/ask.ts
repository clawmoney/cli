import type { SkillHandler } from "../../types.js";
import { bnbotChatGPTAsk } from "./_bnbot.js";
import { startProgressTicker } from "../tiktok/_helpers.js";

type Input = Record<string, unknown>;

interface ChatMessage {
  role?: unknown;
  content?: unknown;
}

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

function promptFromInput(input: Input): string | undefined {
  const prompt = str(input, ["prompt", "text", "input"]);
  if (prompt) return prompt;

  const messages = input.messages;
  if (!Array.isArray(messages)) return undefined;
  const parts = messages
    .map((message) => messageToText(message as ChatMessage))
    .filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

function messageToText(message: ChatMessage): string | undefined {
  const role = typeof message.role === "string" ? message.role : "user";
  const content = message.content;
  if (typeof content === "string") return `${role}: ${content}`;
  if (Array.isArray(content)) {
    const text = content
      .map((part) => {
        if (!part || typeof part !== "object") return "";
        const value = (part as { text?: unknown }).text;
        return typeof value === "string" ? value : "";
      })
      .filter(Boolean)
      .join("\n");
    return text ? `${role}: ${text}` : undefined;
  }
  return undefined;
}

export const chatgptAskSkill: SkillHandler = {
  price_usd: 0.02,
  async run(input, ctx) {
    const i = (input ?? {}) as Input;
    const prompt = promptFromInput(i);
    if (!prompt) throw new Error("missing 'prompt' or 'messages'");

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
      const result = raw as { success?: boolean; response?: string; error?: string; timedOut?: boolean };
      if (result.success === false) {
        throw new Error(result.error || "ChatGPT did not return a response");
      }
      ctx.report({ stage: "done", percent: 100, note: "ChatGPT response received" });
      return raw;
    } finally {
      stop();
    }
  },
};
