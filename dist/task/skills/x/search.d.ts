import type { SkillHandler } from "../../types.js";
/**
 * `x.search` — twitter283 /Search compatibility. Spareai-hub builds
 * the input from the buyer's GET query; we shell out to `bnbot x
 * scrape search` and re-wrap the result into twitter283's nested
 * envelope.
 */
export declare const xSearchSkill: SkillHandler;
