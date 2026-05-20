import type { SkillHandler } from "../types.js";
/**
 * Real x.search via bnbot CLI. Shell-outs to:
 *   bnbot x scrape search <q> -l <limit> [-t <tab>] [...]
 * which talks to the local `bnbot serve` daemon over CDP and dumps the
 * parsed result as a single JSON document on stdout.
 *
 * Provider machine needs:
 *   - bnbot CLI installed and authed (X login persisted in profile)
 *   - `bnbot serve` running (or it'll auto-spawn on first command)
 *
 * Progress is synthesized — bnbot doesn't stream mid-scrape, so we
 * emit fake heartbeats every second while the child runs to keep the
 * NDJSON stream alive past Cloudflare's idle threshold.
 */
export declare const xSearchSkill: SkillHandler;
