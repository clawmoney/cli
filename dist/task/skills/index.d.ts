import type { SkillHandler } from "../types.js";
/**
 * In-process skill registry. Each entry maps a skill_id (the same
 * string the provider advertises via `?skills=…` on WS connect, and
 * the same one buyers hit at `POST /v1/skills/{id}` on hub) to a
 * handler. Phase 3 will load these dynamically from the user's
 * `~/.clawmoney/skills/` directory; for now the demo ships two
 * built-ins.
 */
export declare const SKILL_REGISTRY: Record<string, SkillHandler>;
export declare function listSkills(): string[];
export declare function getSkill(skillId: string): SkillHandler | undefined;
