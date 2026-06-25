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
 * article / trends) are real implementations backed by bnbot CLI's
 * tier-3 scrape commands.
 */
export declare const SKILL_REGISTRY: Record<string, SkillHandler>;
export declare function listSkills(): string[];
/**
 * Skills now served directly by the SpareAPI backend — plain-HTTP public APIs
 * (Y Combinator / IndieHackers / Hacker News) that the gateway fetches itself
 * instead of dispatching to operators. The handlers stay registered, so an
 * explicit `SKILLS=yc.companies,...` can still opt in, but operators DON'T
 * advertise them by default: the hub no longer routes these to operators, and
 * advertising them would just invite redundant single-fetch jobs.
 *
 * Browser-walled platforms (Kickstarter `ks.*` / Indiegogo `igg.*`, behind
 * Cloudflare) are NOT here — they still need a real operator Chrome, so they
 * keep being advertised. Other public read surfaces (wiki / bbc / bloomberg /
 * stackoverflow / v2ex …) also stay, since the backend doesn't fetch them yet.
 */
export declare const DIRECT_SERVED_SKILLS: Set<string>;
/** Skills an operator advertises when the `SKILLS` env var is unset. */
export declare function defaultAdvertiseSkills(): string[];
export declare function getSkill(skillId: string): SkillHandler | undefined;
