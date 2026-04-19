/**
 * Fallback credential source: OpenClaw's auth-profiles.json store.
 *
 * OpenClaw (https://openclaw.ai) is a meta-CLI that wraps many AI provider
 * subscriptions behind its own onboarding flow. Users who installed only
 * openclaw — and not the underlying claude / codex / gemini official CLIs —
 * still have valid OAuth tokens on disk, but at a different path with a
 * different JSON shape. This helper reads those profiles so the existing
 * claude-api / codex-api / gemini-api adapters can fall back to openclaw's
 * store when the native CLI's own credential file is missing.
 *
 * Store layout (verified against openclaw 2026.4.5):
 *
 *   ~/.openclaw/agents/<agent-name>/agent/auth-profiles.json
 *
 * Default agent is "main"; users with multiple personas have additional
 * directories. We scan every agent under ~/.openclaw/agents/* and merge
 * matching profiles.
 *
 * File shape:
 *
 *   {
 *     "version": 1,
 *     "profiles": {
 *       "openai-codex:user@example.com": {
 *         "type": "oauth",
 *         "provider": "openai-codex",
 *         "access":  "<jwt>",
 *         "refresh": "<refresh-token>",
 *         "expires": 1777301154961,           // ms since epoch
 *         "email":   "user@example.com",
 *         "accountId": "<uuid>"                // openai-codex only
 *       },
 *       "anthropic:user@example.com": {
 *         "type": "oauth",
 *         "provider": "anthropic",
 *         "access":  "...",
 *         "refresh": "...",
 *         "expires": ...
 *       },
 *       "openai:default": {
 *         "type": "api_key", "provider": "openai", "key": "sk-..."
 *       }
 *     },
 *     "lastGood": { "openai-codex": "openai-codex:user@example.com", ... }
 *   }
 *
 * We only surface profiles with `type: "oauth"` — API-key profiles are out
 * of scope for this fallback (relay adapters are OAuth-only). `lastGood`
 * picks the default profile per provider; if absent we take the first
 * oauth profile whose `provider` field matches.
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const OPENCLAW_AGENTS_DIR = join(homedir(), ".openclaw", "agents");

interface OpenclawOAuthProfileRaw {
  type: "oauth";
  provider: string;
  access: string;
  refresh: string;
  expires: number;
  email?: string;
  accountId?: string;
  resourceUrl?: string;
}

interface OpenclawApiKeyProfileRaw {
  type: "api_key";
  provider: string;
  key: string;
}

type OpenclawProfileRaw = OpenclawOAuthProfileRaw | OpenclawApiKeyProfileRaw;

interface OpenclawAuthProfilesFile {
  version?: number;
  profiles?: Record<string, OpenclawProfileRaw>;
  lastGood?: Record<string, string>;
  // Other fields (usageStats, etc.) are preserved on writeback but unused here.
  [key: string]: unknown;
}

export interface OpenclawOAuthProfile {
  /** Upstream provider id as openclaw calls it: "openai-codex", "anthropic", "google", ... */
  provider: string;
  /** Opaque key the profile is stored under inside `profiles{}`. Needed for writeback. */
  profileKey: string;
  /** User email if openclaw recorded one. */
  email?: string;
  /** OAuth access token. */
  access: string;
  /** OAuth refresh token. */
  refresh: string;
  /** Expiry as UNIX ms. */
  expires: number;
  /** ChatGPT account UUID — populated for `openai-codex` only. */
  accountId?: string;
  /**
   * Provider-specific resource base URL returned alongside the OAuth token.
   * Populated for `minimax-portal` where the /oauth/token response carries a
   * `resource_url` that pins the API host for this account.
   */
  resourceUrl?: string;
  /** Absolute path to the auth-profiles.json this profile was read from. */
  storePath: string;
}

/**
 * API-key profile shape — providers that authenticate with a static Bearer
 * token stashed in openclaw (`type: "api_key"`). No refresh flow, no expiry.
 */
export interface OpenclawApiKeyProfile {
  provider: string;
  profileKey: string;
  key: string;
  storePath: string;
}

function listAgentDirs(): string[] {
  if (!existsSync(OPENCLAW_AGENTS_DIR)) return [];
  try {
    return readdirSync(OPENCLAW_AGENTS_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => join(OPENCLAW_AGENTS_DIR, e.name, "agent", "auth-profiles.json"))
      .filter((p) => existsSync(p));
  } catch {
    return [];
  }
}

function readStore(path: string): OpenclawAuthProfilesFile | null {
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as OpenclawAuthProfilesFile;
  } catch {
    return null;
  }
}

function selectProfile(
  file: OpenclawAuthProfilesFile,
  provider: string
): { key: string; raw: OpenclawOAuthProfileRaw } | null {
  const profiles = file.profiles ?? {};
  // Preferred: lastGood pointer for this provider.
  const preferredKey = file.lastGood?.[provider];
  if (preferredKey && profiles[preferredKey]?.type === "oauth") {
    const raw = profiles[preferredKey] as OpenclawOAuthProfileRaw;
    if (raw.provider === provider) return { key: preferredKey, raw };
  }
  // Fallback: first oauth profile whose provider matches.
  for (const [k, v] of Object.entries(profiles)) {
    if (v.type === "oauth" && v.provider === provider) {
      return { key: k, raw: v as OpenclawOAuthProfileRaw };
    }
  }
  return null;
}

/**
 * Read the OAuth profile for `provider` from the first openclaw auth-profiles.json
 * that has one. Agent iteration order is whatever readdirSync returns (typically
 * alphabetical on macOS), so users with multiple agents that both carry the same
 * provider profile will get the earliest match. In practice most installs only
 * have `main`.
 *
 * Returns null when openclaw is not installed, no agent has a matching oauth
 * profile, or any of the required fields (access/refresh/expires) are missing.
 */
export function readOpenclawOAuthProfile(provider: string): OpenclawOAuthProfile | null {
  for (const storePath of listAgentDirs()) {
    const file = readStore(storePath);
    if (!file) continue;
    const picked = selectProfile(file, provider);
    if (!picked) continue;
    const { key, raw } = picked;
    if (!raw.access || !raw.refresh || !raw.expires) continue;
    return {
      provider,
      profileKey: key,
      email: raw.email,
      access: raw.access,
      refresh: raw.refresh,
      expires: raw.expires,
      accountId: raw.accountId,
      resourceUrl: raw.resourceUrl,
      storePath,
    };
  }
  return null;
}

/**
 * Read an API-key profile (type: "api_key") for `provider`. Scans every
 * agent under ~/.openclaw/agents/*. Returns the first match.
 *
 * `lastGood` is not consulted for api_key (openclaw's own picker doesn't
 * write lastGood for static keys) — we just take the first profile whose
 * `provider` field matches.
 */
export function readOpenclawApiKeyProfile(provider: string): OpenclawApiKeyProfile | null {
  for (const storePath of listAgentDirs()) {
    const file = readStore(storePath);
    if (!file?.profiles) continue;
    for (const [k, v] of Object.entries(file.profiles)) {
      if (v.type === "api_key" && v.provider === provider && typeof v.key === "string" && v.key.length > 0) {
        return { provider, profileKey: k, key: v.key, storePath };
      }
    }
  }
  return null;
}

/**
 * List every openclaw provider id for which at least one OAuth profile exists
 * on disk. Used by relay-setup detection so a machine that only has openclaw
 * installed still surfaces the relevant cli_types.
 */
export function listOpenclawOAuthProviders(): string[] {
  const seen = new Set<string>();
  for (const storePath of listAgentDirs()) {
    const file = readStore(storePath);
    if (!file?.profiles) continue;
    for (const v of Object.values(file.profiles)) {
      if (v.type === "oauth" && v.provider) seen.add(v.provider);
    }
  }
  return Array.from(seen);
}

/**
 * Same as listOpenclawOAuthProviders but for `type: "api_key"` profiles.
 * Used by passthrough detection so the wizard can show "zai api_key present
 * via openclaw" without requiring the user to re-enter their key.
 */
export function listOpenclawApiKeyProviders(): string[] {
  const seen = new Set<string>();
  for (const storePath of listAgentDirs()) {
    const file = readStore(storePath);
    if (!file?.profiles) continue;
    for (const v of Object.values(file.profiles)) {
      if (v.type === "api_key" && v.provider && typeof v.key === "string" && v.key.length > 0) {
        seen.add(v.provider);
      }
    }
  }
  return Array.from(seen);
}

/**
 * Write a refreshed access/refresh/expires triple back into the same profile
 * the token was read from. Preserves every other field in the auth-profiles.json
 * (other providers' profiles, usageStats, lastGood, etc.) so we don't clobber
 * state belonging to a running openclaw process.
 *
 * Atomic: write to <path>.tmp + rename, same pattern as openclaw itself.
 * If the profile is no longer present (user logged out of openclaw
 * concurrently) we re-insert it rather than fail silently.
 */
export function persistOpenclawOAuthProfile(
  prof: OpenclawOAuthProfile,
  updates: {
    access: string;
    refresh: string;
    expires: number;
    accountId?: string;
    resourceUrl?: string;
  }
): void {
  const file = readStore(prof.storePath) ?? ({ version: 1, profiles: {} } as OpenclawAuthProfilesFile);
  const profiles = file.profiles ?? {};
  const existing = profiles[prof.profileKey];
  const base: OpenclawOAuthProfileRaw =
    existing?.type === "oauth"
      ? (existing as OpenclawOAuthProfileRaw)
      : {
          type: "oauth",
          provider: prof.provider,
          access: "",
          refresh: "",
          expires: 0,
          email: prof.email,
          accountId: prof.accountId,
          resourceUrl: prof.resourceUrl,
        };
  profiles[prof.profileKey] = {
    ...base,
    access: updates.access,
    refresh: updates.refresh,
    expires: updates.expires,
    ...(updates.accountId !== undefined ? { accountId: updates.accountId } : {}),
    ...(updates.resourceUrl !== undefined ? { resourceUrl: updates.resourceUrl } : {}),
  };
  file.profiles = profiles;
  file.lastGood = { ...(file.lastGood ?? {}), [prof.provider]: prof.profileKey };

  const tmp = `${prof.storePath}.tmp`;
  writeFileSync(tmp, JSON.stringify(file, null, 2), { encoding: "utf-8", mode: 0o600 });
  renameSync(tmp, prof.storePath);
}
