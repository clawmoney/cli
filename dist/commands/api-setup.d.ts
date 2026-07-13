/**
 * SpareAI "API" provider setup.
 *
 * Enables this agent to serve SpareAPI marketplace requests via bnbot
 * browser delegation. End-to-end flow when a customer hits SpareAPI:
 *
 *   customer  →  spareapi.io/v1/<platform>/scrape/...
 *             →  SpareAI router picks an online "api" operator
 *             →  this operator's bnbot daemon (local WS @ port 18900)
 *             →  real logged-in Chrome on the operator's machine
 *             →  target platform (X / XHS / IG / ...)
 *             ←  JSON results back through the chain
 *
 * This wizard only collects the operator's preferences (which platforms
 * to serve, soft RPM cap) and persists them to ~/.spareai/config.yaml.
 * The runtime piece — bnbot listening for SpareAI router messages and
 * dispatching to the right scrape command — is provided separately by
 * the bnbot CLI (`bnbot serve`).
 */
export declare function apiSetupCommand(opts?: {
    nested?: boolean;
}): Promise<void>;
