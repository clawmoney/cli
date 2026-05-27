/**
 * Auto-sync the built-in skill registry to the marketplace.
 *
 * Runs once on `clawmoney market start` (fire-and-forget, see provider.ts).
 * For each skill in SKILL_DEFAULTS that the agent has not yet listed and
 * has not opted out of, POST it to /api/v1/market/skills.
 *
 * Failures are warn-logged and never crash the daemon. The user can put
 * skill names in `provider.disabled_skills` (config.yaml) to opt out;
 * we never delete or modify listings the user already has.
 */

import { apiGet, apiPost } from "../utils/api.js";
import { logger } from "./logger.js";
import { SKILL_DEFAULTS, type SkillDefault } from "./skill-defaults.js";
import type { ProviderConfig } from "./types.js";

const REGISTER_DELAY_MS = 200;

interface MineSkill {
  skill_name?: string;
  name?: string;
}

interface MineResponse {
  data?: MineSkill[];
}

interface RegisterPayload {
  skill_name: string;
  category: string;
  description: string;
  price: number;
  skill_type: "instant" | "escrow";
}

async function fetchMineSkillNames(apiKey: string): Promise<Set<string> | null> {
  const resp = await apiGet<MineResponse | MineSkill[]>(
    "/api/v1/market/skills/mine",
    apiKey
  );
  if (!resp.ok) {
    logger.warn(`Skill sync: /skills/mine returned ${resp.status}`);
    return null;
  }
  const rows = Array.isArray(resp.data)
    ? resp.data
    : (resp.data?.data ?? []);
  const names = new Set<string>();
  for (const row of rows) {
    const name = row?.skill_name ?? row?.name;
    if (typeof name === "string" && name) {
      names.add(name);
    }
  }
  return names;
}

async function registerOne(
  apiKey: string,
  name: string,
  meta: SkillDefault
): Promise<boolean> {
  const payload: RegisterPayload = {
    skill_name: name,
    category: meta.category,
    description: meta.description,
    price: meta.price,
    skill_type: meta.skill_type ?? "instant",
  };
  const resp = await apiPost<unknown>(
    "/api/v1/market/skills",
    payload,
    apiKey
  );
  if (!resp.ok) {
    const detail =
      typeof resp.data === "object" && resp.data !== null && "detail" in resp.data
        ? (resp.data as { detail: unknown }).detail
        : resp.data;
    logger.warn(
      `Skill sync: failed to register "${name}" (${resp.status}): ${
        typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 120)
      }`
    );
    return false;
  }
  return true;
}

export async function syncSkillRegistry(config: ProviderConfig): Promise<void> {
  if (!config.api_key) {
    return;
  }

  const mine = await fetchMineSkillNames(config.api_key);
  if (mine === null) {
    return;
  }

  const disabled = new Set(config.provider.disabled_skills ?? []);
  const toRegister: Array<[string, SkillDefault]> = [];

  for (const [name, meta] of Object.entries(SKILL_DEFAULTS)) {
    if (mine.has(name)) continue;
    if (disabled.has(name)) continue;
    toRegister.push([name, meta]);
  }

  if (toRegister.length === 0) {
    logger.info(`Skill sync: nothing to register (${mine.size} already listed)`);
    return;
  }

  logger.info(
    `Skill sync: registering ${toRegister.length} new skill(s) (${mine.size} already listed)…`
  );

  let ok = 0;
  let fail = 0;
  for (const [name, meta] of toRegister) {
    const success = await registerOne(config.api_key, name, meta);
    if (success) ok++;
    else fail++;
    if (REGISTER_DELAY_MS > 0) {
      await new Promise((r) => setTimeout(r, REGISTER_DELAY_MS));
    }
  }

  logger.info(`Skill sync: done (${ok} added, ${fail} failed)`);
}
