import type { SkillContext } from "../../types.js";
/** Fire fake progress every 1.5s while a slow bnbot call runs.
 *  Returns a cleanup function — call it in a finally block. */
export declare function startProgressTicker(ctx: SkillContext, label: string): () => void;
