/**
 * Task protocol — wire frames exchanged with spareai-hub (Cloudflare).
 *
 * Mirrors spareai-hub/src/wire.ts. When that file changes, this one
 * must follow. Phase 4 work item: publish `@spareai/wire` and replace
 * both copies with a single dependency.
 *
 * The task protocol is distinct from `src/hub/types.ts` (the legacy
 * bnbot-api market protocol that this module will eventually replace).
 * Both daemons run side by side during the migration window.
 */
export {};
