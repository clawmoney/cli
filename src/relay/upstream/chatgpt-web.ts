/**
 * chatgpt-web upstream — serve a relay request by driving the ChatGPT *website*
 * (not the reverse-proxy API). Sends the prompt into a ChatGPT temporary chat
 * via opencli's CDP browser automation, waits for the reply, reads it back.
 *
 * Why this exists alongside the codex reverse-proxy path:
 *  - It's a real person typing in chatgpt.com → OpenAI can't tell it apart from
 *    normal use → effectively un-bannable (the reverse-proxy路径 mimics the
 *    Codex CLI fingerprint, which is safe but not bullet-proof at scale).
 *  - Temporary chat → no history pollution, clean per-session isolation, not
 *    used for training.
 *  - Trade-off: slower (seconds, UI render) and not token-streamed. Fine for
 *    conversation; the buyer still gets a standard reply.
 *
 * Requires the provider machine to have `@jackwener/opencli` installed (with the
 * `chatgpt ask --temporary` support) and a logged-in ChatGPT session in the
 * opencli-controlled Chrome. Point OPENCLI_BIN at a custom binary for local
 * source runs.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { ParsedOutput } from "../types.js";

const execFileP = promisify(execFile);

const OPENCLI_BIN = process.env.OPENCLI_BIN || "opencli";

export interface ChatGPTWebOptions {
  prompt: string;
  model: string;
  /** Max seconds to wait for the assistant reply. */
  timeout?: number;
  /** Continue an existing /c/<id> conversation (multi-turn, non-temporary). */
  conversationId?: string;
  /**
   * Continue the CURRENT chat in place (no --new/--temporary). Used for
   * stateful multi-turn inside a temporary chat: the first turn opens the
   * temporary chat, later turns just send into the same tab so ChatGPT
   * accumulates context. Temporary chats have no /c/<id> to resume by URL,
   * so this in-place continuation is the only way to keep their context.
   */
  continueChat?: boolean;
  /**
   * Per-buyer browser session key → its own ChatGPT tab. Same key reuses the
   * same tab (multi-turn context); different keys run concurrently in separate
   * tabs. Maps to opencli `--session <key>`.
   */
  sessionKey?: string;
  /**
   * This turn is expected to produce an image (generate/edit). Forces a regular
   * chat (ChatGPT temporary chat BLOCKS image generation) and waits for + grabs
   * the image. Maps to opencli `--image-out` + `--new` (first turn).
   */
  imageOut?: boolean;
  /** Local image paths to upload before the prompt (edit the buyer's own image). */
  imagePaths?: string[];
}

interface OpenCliAskRowImg extends OpenCliAskRow {
  images?: string[];
}

interface OpenCliAskRow {
  conversationId?: string;
  conversationUrl?: string;
  tool?: string;
  response?: string;
}

/** Roughly 4 chars per token — web send/read has no real token counts, so we
 *  estimate for billing parity with the API paths. */
function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

export async function callChatGPTWeb(opts: ChatGPTWebOptions): Promise<ParsedOutput> {
  const timeout = opts.timeout ?? 120;
  const args = ["chatgpt", "ask", opts.prompt, "--timeout", String(timeout), "-f", "json"];

  // Turn routing:
  //  - continueChat → no flag; opencli's ensureOnChatGPT stays on the current
  //    page, so a temporary chat continues in place and keeps its context.
  //  - conversationId → resume a saved /c/<id> conversation.
  //  - otherwise → open a fresh temporary chat (first turn / single-shot).
  if (opts.continueChat) {
    // intentionally no flag — continue the current chat in place.
  } else if (opts.conversationId) {
    args.push("--conversation", opts.conversationId);
  } else if (opts.imageOut) {
    // Image generation is blocked in temporary chats → use a regular new chat.
    args.push("--new");
  } else {
    args.push("--temporary");
  }
  if (opts.imageOut) {
    args.push("--image-out");
  }
  if (opts.imagePaths?.length) {
    args.push("--image", opts.imagePaths.join(","));
  }
  // Per-buyer tab isolation: same key → same tab (context kept), different
  // keys → concurrent tabs.
  if (opts.sessionKey) {
    args.push("--session", opts.sessionKey);
  }

  let stdout = "";
  try {
    const result = await execFileP(OPENCLI_BIN, args, {
      timeout: (timeout + 30) * 1000,
      maxBuffer: 96 * 1024 * 1024, // base64 images can be several MB each
      env: { ...process.env },
    });
    stdout = result.stdout;
  } catch (err) {
    const e = err as { message?: string; stdout?: string; stderr?: string };
    const tail = `${e.stdout ?? ""}${e.stderr ?? ""}`.slice(0, 400);
    throw new Error(`opencli chatgpt ask failed: ${e.message ?? String(err)} ${tail}`);
  }

  // opencli `-f json` prints a JSON array; tolerate any leading banner lines.
  const start = stdout.indexOf("[");
  if (start < 0) {
    throw new Error(`opencli chatgpt ask: no JSON in output: ${stdout.slice(0, 300)}`);
  }
  let rows: OpenCliAskRowImg[];
  try {
    rows = JSON.parse(stdout.slice(start)) as OpenCliAskRowImg[];
  } catch {
    throw new Error(`opencli chatgpt ask: bad JSON: ${stdout.slice(start, start + 300)}`);
  }

  const response = String(rows?.[0]?.response ?? "").trim();
  const images = Array.isArray(rows?.[0]?.images) ? rows[0].images! : [];
  if (!response && !images.length) {
    throw new Error(
      `opencli chatgpt ask empty (stdout=${stdout.length}b, keys=[${Object.keys(rows?.[0] ?? {}).join(",")}], imagesType=${typeof rows?.[0]?.images})`,
    );
  }

  // Carry images back inside the chat.completion content as markdown data
  // URLs — the buyer's front-end renders them directly. (Image turns often
  // have little/no text, so the image IS the answer.)
  let text = response;
  if (images.length) {
    const md = images.map((img, i) => `![image${i + 1}](${img})`).join("\n");
    text = text ? `${text}\n\n${md}` : md;
  }

  return {
    text,
    sessionId: String(rows?.[0]?.conversationId ?? ""),
    usage: {
      input_tokens: estimateTokens(opts.prompt),
      // Don't token-count the base64 image (it'd be ~375k "tokens"); bill each
      // generated image as a flat token block instead.
      output_tokens: estimateTokens(response) + images.length * 800,
      cache_creation_tokens: 0,
      cache_read_tokens: 0,
    },
    model: opts.model,
    costUsd: 0,
  };
}
