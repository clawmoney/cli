/**
 * Default marketplace listing metadata for each built-in skill.
 *
 * `syncSkillRegistry` reads this table to figure out which skills to
 * auto-publish to the marketplace on `clawmoney market start`. Anything
 * not in this map is intentionally not auto-registered — typically
 * because it requires manual configuration (e.g. chatgpt.ask) or is a
 * back-compat alias.
 *
 * `requiresPlatform` is a forward-looking field for the eventual
 * platform-login check. v1 of syncSkillRegistry ignores it and
 * registers everything.
 */
export interface SkillDefault {
    category: string;
    description: string;
    price: number;
    skill_type?: "instant" | "escrow";
    /** Cookie/login dependency. Empty/undefined = standalone. */
    requiresPlatform?: string;
}
export declare const SKILL_DEFAULTS: Record<string, SkillDefault>;
export declare function listDefaultSkillNames(): string[];
