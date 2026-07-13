/**
 * Auto-sync the built-in skill registry to the marketplace.
 *
 * Runs once on `spareai market start` (fire-and-forget, see provider.ts).
 * For each skill in SKILL_DEFAULTS that the agent has not yet listed and
 * has not opted out of, POST it to /api/v1/market/skills.
 *
 * Failures are warn-logged and never crash the daemon. The user can put
 * skill names in `provider.disabled_skills` (config.yaml) to opt out;
 * we never delete or modify listings the user already has.
 */
import type { ProviderConfig } from "./types.js";
export declare function syncSkillRegistry(config: ProviderConfig): Promise<void>;
