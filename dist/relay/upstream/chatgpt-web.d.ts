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
import type { ParsedOutput } from "../types.js";
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
export declare function callChatGPTWeb(opts: ChatGPTWebOptions): Promise<ParsedOutput>;
