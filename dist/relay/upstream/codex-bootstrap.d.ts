/**
 * Programmatic Codex fingerprint capture.
 *
 * Codex CLI 0.118+ talks to chatgpt.com over a WebSocket Upgrade
 * (GET /v1/responses Upgrade: websocket) rather than plain HTTPS,
 * which makes the in-process TS proxy approach used for Claude and
 * Gemini much harder — we'd need to port the full handshake + frame
 * decoder. So instead we reuse the existing
 * `scripts/capture-codex-request.mjs` script which already handles
 * all of that correctly: spawn it as a subprocess, run `codex -p hi`
 * against it, and wait for `~/.clawmoney/codex-fingerprint.json` to
 * appear. On success we SIGINT the capture proxy so it can scrub the
 * transient capture files the way the manual flow does.
 *
 * Note: the mjs script hardcodes port 8788. If something else on the
 * machine is already using that port, the spawn fails and we surface
 * the error.
 */
export declare function hasCodexFingerprint(): boolean;
export declare function bootstrapCodexFingerprint(opts?: {
    timeoutMs?: number;
}): Promise<void>;
