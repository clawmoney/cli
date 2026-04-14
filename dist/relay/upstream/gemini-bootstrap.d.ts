/**
 * Programmatic Gemini fingerprint capture.
 *
 * Mirrors scripts/capture-gemini-request.mjs but runs inline so the
 * setup wizard can bootstrap ~/.clawmoney/gemini-fingerprint.json
 * without the two-terminal dance.
 *
 * Flow:
 *   1. Listen on a random localhost port.
 *   2. Spawn `gemini -p "hi"` with CODE_ASSIST_ENDPOINT pointing at us.
 *   3. When the first POST hits a /v1internal:generateContent (or
 *      similar) path, extract project_id / user_agent / cli_version /
 *      x_goog_api_client from the body + headers, persist to
 *      ~/.clawmoney/gemini-fingerprint.json, and forward the request
 *      to cloudcode-pa.googleapis.com so the gemini CLI still sees a
 *      valid response.
 *   4. Clean up proxy server + gemini subprocess.
 *
 * Note: the :loadCodeAssist bootstrap request that Gemini CLI fires
 * first carries only `{metadata}` without a project — we skip it and
 * wait for a subsequent v1internal request that actually carries a
 * project field. Mirrors the mjs script's extractFingerprint guard.
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
