/**
 * Programmatic Gemini fingerprint capture.
 *
 * Spawns the existing scripts/capture-gemini-request.mjs as a
 * subprocess and runs `gemini -p hi` against it, rather than
 * reimplementing the proxy in TypeScript. The TS port I tried
 * first timed out at 25s even though the mjs script captures in
 * ~4s on the same machine — the mjs path is proven and reused
 * code, so keep the pattern consistent with codex-bootstrap.
 *
 * Note: the mjs script hardcodes port 8789. A collision surfaces
 * as a spawn error we forward to the caller.
 */
export interface GeminiFingerprint {
    project_id: string;
    cli_version: string;
    user_agent: string;
    x_goog_api_client: string;
}
export declare function hasGeminiFingerprint(): boolean;
export declare function bootstrapGeminiFingerprint(opts?: {
    timeoutMs?: number;
}): Promise<GeminiFingerprint>;
