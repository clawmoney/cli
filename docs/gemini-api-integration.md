# Gemini API Mode Integration

**Status**: Pre-capture — needs one real `gemini -p` run through `scripts/capture-gemini-request.mjs` to confirm wire format.

## What ships

| File | Purpose |
|---|---|
| `src/relay/upstream/gemini-api.ts` | Production module — mirrors `claude-api.ts` structure |
| `scripts/capture-gemini-request.mjs` | Bootstrap tool — proxy + fingerprint extractor (port 8789) |
| `docs/gemini-api-integration.md` | This writeup |

## Upstream URL

```
POST https://cloudcode-pa.googleapis.com/v1internal:generateContent
```

Confirmed from sub2api source (`internal/pkg/geminicli/constants.go` `GeminiCliBaseURL` and `geminicli_codeassist_client.go` path `/v1internal:generateContent`). This is the Code Assist API — NOT `generativelanguage.googleapis.com` (which is AI Studio and requires an API key, not OAuth).

## Request shape

```json
{
  "project": "<google-cloud-project-id>",
  "requestId": "<uuid-stable-15min>",
  "userAgent": "GeminiCLI/0.36.0 (darwin; arm64)",
  "model": "gemini-2.5-pro",
  "request": {
    "contents": [{"role": "user", "parts": [{"text": "..."}]}],
    "generationConfig": {"maxOutputTokens": 8192},
    "safetySettings": [{"category": "...", "threshold": "OFF"}, ...]
  }
}
```

Note the outer envelope `{project, requestId, userAgent, model, request}` — this is specific to `v1internal:generateContent` and wraps the standard Gemini API body inside `request`.

## Required headers

| Header | Value |
|---|---|
| `Authorization` | `Bearer <access_token>` |
| `Content-Type` | `application/json` |
| `User-Agent` | `GeminiCLI/<version> (<platform>)` |
| `x-goog-user-project` | `<google-cloud-project-id>` — **mandatory**, 403 SERVICE_DISABLED without it |
| `x-goog-api-client` | `gemini-cli/<version>` |

## OAuth token source

`~/.gemini/oauth_creds.json` shape:
```
access_token, refresh_token, id_token, scope, expiry_date (UNIX ms), token_type
```

Refresh uses standard Google OAuth2 **form-encoded** POST (different from Claude's JSON refresh):
```
POST https://oauth2.googleapis.com/token
Content-Type: application/x-www-form-urlencoded

grant_type=refresh_token&refresh_token=<rt>&client_id=<cid>&client_secret=<cs>
```

The client_id / client_secret are the well-known Gemini CLI public credentials (not secrets in the security sense — they're embedded in the CLI binary itself). Refreshed tokens persist back to `~/.gemini/oauth_creds.json`.

## Fingerprint schema (`~/.clawmoney/gemini-fingerprint.json`)

```json
{
  "project_id": "<google-cloud-project-id>",
  "cli_version": "0.36.0",
  "user_agent": "GeminiCLI/0.36.0 (darwin; arm64)"
}
```

Fields and why each is there:

- **`project_id`** — Google Cloud project for billing attribution. Sourced from the `project` field in the v1internal request envelope. Required for `x-goog-user-project`. Without it: 403 SERVICE_DISABLED.
- **`cli_version`** — parsed from the User-Agent header. Keeps `x-goog-api-client` aligned with what the real CLI sends after auto-updates.
- **`user_agent`** — exact User-Agent string. Prevents version fingerprint mismatch if Google validates UA format.

## Bootstrap procedure

```bash
# Terminal 1
node scripts/capture-gemini-request.mjs

# Terminal 2
CODE_ASSIST_ENDPOINT=http://127.0.0.1:8789 gemini -p "hi"
```

After a successful capture:
1. `~/.clawmoney/gemini-fingerprint.json` is written automatically.
2. All `capture-gemini-*.json` files are deleted (they contained OAuth tokens).
3. Daemon with `execution_mode: api, cli_type: gemini` will work.

**Fallback if `CODE_ASSIST_ENDPOINT` isn't honored by your CLI version**: upgrade the CLI (`npm install -g @google/gemini-cli`) and retry. An HTTPS MITM proxy workaround is possible but requires a trusted CA cert and isn't implemented in the capture script.

## Wiring into `provider.ts`

Add import:
```typescript
import {
  callGeminiApi,
  preflightGeminiApi,
  getGeminiRateGuardSnapshot,
} from "./upstream/gemini-api.js";
```

Broaden `useApiMode`:
```typescript
const useApiMode =
  config.relay.execution_mode === "api" &&
  (cliType === "claude" || cliType === "codex" || cliType === "gemini");
```

Branch on `cliType` in the dispatch block:
```typescript
if (useApiMode) {
  if (cliType === "gemini") {
    parsed = await callGeminiApi({
      prompt,
      model,
      maxTokens: max_budget_usd ? undefined : 8192,
    });
  } else if (cliType === "codex") {
    parsed = await callCodexApi({ ... });
  } else {
    parsed = await callClaudeApi({ ... });
  }
}
```

Add Gemini preflight alongside Claude's and Codex's:
```typescript
if (config.relay.execution_mode === "api" && config.relay.cli_type === "gemini") {
  preflightGeminiApi(config.relay.rate_guard).catch((err) => {
    logger.error(
      `Gemini API preflight failed — falling back to CLI mode: ${(err as Error).message}`
    );
    config.relay.execution_mode = "cli";
  });
}
```

## Session window telemetry

Gemini's Code Assist API does **not** surface a rolling-window utilization header equivalent to Anthropic's `anthropic-ratelimit-unified-5h-*`. The `session_window` field in `RelayResponse` will always be `undefined` for Gemini providers. The Hub treats absence as "window unknown, proceed normally" (see `claim_relay_provider` SQL: `COALESCE(session_window_utilization, 0) ASC`).

## Known gaps

1. **`CODE_ASSIST_ENDPOINT` support** — not confirmed against the installed CLI binary. Fallback is HTTPS MITM + CA cert, not implemented.
2. **`x-goog-api-client` format** — the exact value (e.g. `gemini-cli/0.36.0` vs `gl-node/0.36.0`) is unconfirmed without real traffic capture.
3. **Additional validation headers** — unknown if v1internal performs fingerprint checks beyond what we send.
4. **Some CLI versions may send extra headers** (`x-gemini-api-privileged-user-id`, session identifiers) we don't currently send.

## Missing pricing entries

These Gemini model IDs may appear in sub2api's model list but are absent from `pricing.ts::API_PRICES`:
- `gemini-2.0-flash`
- `gemini-2.5-flash-image`
- `gemini-3-pro-preview`
- `gemini-3.1-flash-image`

Existing fallback (`{input: 5, output: 25}`) is **too high** for these. Add them after confirming the pricing tier from Google docs.

Already present: `gemini-2.5-pro`, `gemini-2.5-flash`, `gemini-2.5-flash-lite`, `gemini-3-flash-preview`, `gemini-3.1-pro-preview`.
