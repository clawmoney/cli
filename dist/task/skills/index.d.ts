import type { SkillHandler } from "../types.js";
/**
 * In-process skill registry. Each entry maps a skill_id (the same
 * string the provider advertises via `?skills=…` on WS connect, and
 * the same one buyers hit) to a handler. The twitter283
 * compatibility surface on spareai-hub dispatches to these by name.
 *
 * The `x.search` here is the twitter283-compatible mapper (nested
 * envelope). The legacy flat-camelCase version stays exposed as
 * `x.search.legacy` for older buyers / local debug scripts.
 *
 * Tier 3 skills (followers / following / likers / retweeters /
 * article / trends) are registered as stubs that throw a clear
 * "not yet implemented" error. They'll get real impls once bnbot
 * CLI ships the matching scrape commands.
 */
export declare const SKILL_REGISTRY: Record<string, SkillHandler>;
export declare function listSkills(): string[];
export declare function getSkill(skillId: string): SkillHandler | undefined;
