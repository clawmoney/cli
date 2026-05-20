import { echoSkill } from "./echo.js";
import { xSearchSkill } from "./x-search.js";
/**
 * In-process skill registry. Each entry maps a skill_id (the same
 * string the provider advertises via `?skills=…` on WS connect, and
 * the same one buyers hit at `POST /v1/skills/{id}` on hub) to a
 * handler. Phase 3 will load these dynamically from the user's
 * `~/.clawmoney/skills/` directory; for now the demo ships two
 * built-ins.
 */
export const SKILL_REGISTRY = {
    echo: echoSkill,
    "x.search": xSearchSkill,
};
export function listSkills() {
    return Object.keys(SKILL_REGISTRY);
}
export function getSkill(skillId) {
    return SKILL_REGISTRY[skillId];
}
