# Codex API Integration

**Status**: Pre-capture — needs one real `codex exec` run through `scripts/capture-codex-request.mjs` to confirm wire format.

## What ships

| File | Purpose |
|---|---|
| `src/relay/upstream/codex-api.ts` | Production module — mirrors `claude-api.ts` structure |
| `scripts/capture-codex-request.mjs` | Bootstrap tool — proxy + fingerprint extractor (port 8788) |
| `docs/codex-api-integration.md` | This writeup |

## Upstream URL

```
POST https://chatgpt.com/backend-api/codex/responses
```

Confirmed from `sub2api/backend/internal/service/openai_gateway_service.go:codexCLIVersion`.

## Request shape (Responses API)

```json
{
  "model": "gpt-5.3-codex",
  "input": [{"type": "message", "role": "user", "content": "<prompt>"}],
  "instructions": "You are a helpful AI assistant...",
  "store": false,
  "stream": true
}
```

Constraints (from sub2api `openai_codex_transform.go`):

- `store` must be `false` — ChatGPT internal API rejects `true`
- `stream` must be `true` — internal endpoint always returns SSE
- `max_output_tokens`, `temperature`, `top_p` are stripped upstream — we omit them
- `instructions` must be non-empty — endpoint rejects empty instructions

## Required headers

| Header | Value |
|---|---|
| `Authorization` | `Bearer <access_token>` |
| `chatgpt-account-id` | From `~/.codex/auth.json` → `tokens.account_id` |
| `user-agent` | `codex_cli_rs/<version>` (from fingerprint) |
| `originator` | `codex_cli_rs` (from fingerprint) |
| `openai-beta` | `responses=experimental` |
| `session_id` | 15-min masked UUID (anti-bot-signal) |
| `conversation_id` | Same value as `session_id` |
| `accept` | `text/event-stream` |
| `content-type` | `application/json` |

## OAuth token source

`~/.codex/auth.json` shape:

- `tokens.access_token` — Bearer token (JWT; expiry decoded from `exp` claim)
- `tokens.refresh_token` — Refresh token
- `tokens.account_id` — chatgpt_account_id (sent as `chatgpt-account-id` header)

**No explicit `expiresAt` field** — expiry is decoded from the JWT `exp` claim at load time (`decodeJwtExp()`).

## Token refresh

```
POST https://auth.openai.com/oauth/token
Content-Type: application/x-www-form-urlencoded

grant_type=refresh_token&refresh_token=<rt>&client_id=app_EMoamEEZ73f0CkXaXp7hrann&scope=openid+profile+email
```

Scope uses `openid profile email` (drops `offline_access` on refresh, per sub2api `openai/pkg/oauth.go:RefreshScopes`). Refreshed tokens persist back to `~/.codex/auth.json` so the user's real Codex CLI stays in sync.

## Response shape (SSE)

Always streamed. Terminal event carries the complete state:

```
data: {"type":"response.done","response":{"model":"gpt-5.3-codex","output":[{"type":"message","content":[{"type":"output_text","text":"..."}]}],"usage":{"input_tokens":42,"output_tokens":123,"input_tokens_details":{"cached_tokens":0}}}}
```

Delta events arrive before the terminal:
```
data: {"type":"response.output_text.delta","delta":"..."}
```

`parseCodexSSE()` handles both; uses terminal `output[]` text if present, falls back to delta accumulation.

## Rate-limit headers

ChatGPT Codex surfaces quota state via:

- `x-codex-primary-used-percent` / `x-codex-primary-reset-after-seconds` — primary window (typically weekly)
- `x-codex-secondary-used-percent` / `x-codex-secondary-reset-after-seconds` — secondary window (typically 5h)

`parseCodexRateLimitHeaders()` picks the nearest real reset time to drive `rateGuard.triggerCooldown()` on 429 responses.

## Fingerprint schema (`~/.clawmoney/codex-fingerprint.json`)

```json
{
  "user_agent": "codex_cli_rs/0.104.0",
  "cli_version": "0.104.0",
  "originator": "codex_cli_rs"
}
```

- `user_agent` — sent as `User-Agent`; must match `CodexOfficialClientUserAgentPrefixes` for ChatGPT's official-client check
- `cli_version` — extracted from UA for version-drift logging
- `originator` — sent as `originator` header; must match `CodexOfficialClientOriginatorPrefixes` pattern (`codex_` prefix)

**No `device_id` / `account_uuid`** — Codex uses `chatgpt-account-id` (loaded from `auth.json` at runtime) instead of per-device metadata. This means the fingerprint file is safe to share / check into dev environments; it contains zero secrets.

## Bootstrap procedure

```bash
# Terminal A
node scripts/capture-codex-request.mjs

# Terminal B (Option A — if env var works with installed codex version)
OPENAI_BASE_URL=http://127.0.0.1:8788/v1 codex exec "hi"

# Terminal B (Option B — config.toml, always works)
echo 'openai_base_url = "http://127.0.0.1:8788/v1"' >> ~/.codex/config.toml
codex exec "hi"
# Remove that line afterward
```

## Wiring into `provider.ts`

```typescript
// 1. Import at top alongside callClaudeApi:
import { callCodexApi, preflightCodexApi } from "./upstream/codex-api.js";

// 2. Broaden useApiMode:
const useApiMode =
  config.relay.execution_mode === "api" &&
  (cliType === "claude" || cliType === "codex");

// 3. Branch on cliType inside the api-mode dispatch block:
if (useApiMode) {
  if (cliType === "codex") {
    parsed = await callCodexApi({
      prompt,
      model,
      maxTokens: max_budget_usd ? undefined : 4096,
    });
  } else {
    parsed = await callClaudeApi({
      prompt,
      model,
      maxTokens: max_budget_usd ? undefined : 4096,
    });
  }
}

// 4. In runRelayProvider(), add Codex preflight alongside Claude's:
if (config.relay.execution_mode === "api" && config.relay.cli_type === "codex") {
  preflightCodexApi(config.relay.rate_guard).catch((err) => {
    logger.error(
      `Codex API preflight failed — falling back to CLI mode: ${(err as Error).message}`
    );
    config.relay.execution_mode = "cli";
  });
}
```

## Known gaps

1. **Exact SSE terminal event name** — sub2api accepts both `response.done` and `response.completed`. Capture will confirm which the real CLI receives.
2. **`chatgpt-account-id` enforcement** — confirm upstream hard-requires it vs. optional.
3. **`OPENAI_BASE_URL` support** — the Codex CLI may not honor the env var on all versions; `config.toml` override is the documented fallback.
4. **`store: true` handling** — sub2api strips and forces `false`; we do the same. Unknown if upstream 400s on `true` vs just ignores.
5. **`cache_creation_tokens`** — Responses API `usage` does not expose cache write separately. Hard-coded `0`.
6. **`reasoning.effort` field** — `gpt-5.3-codex` / `gpt-5.4` support this; we don't forward it yet. Follow-up PR if buyers need reasoning control.

## Missing pricing entries (pricing.ts)

These Codex models exist in sub2api `codexModelMap` but are absent from `API_PRICES`. Will fall back to `DEFAULT_PRICING` (`{input: 5, output: 25}`) which is **too high** for smaller models:

| Missing model | Suggested `$/1M tokens` |
|---|---|
| `gpt-5.1` | input: 2.00, output: 8.00 |
| `gpt-5.1-codex` | input: 1.50, output: 6.00 |
| `gpt-5.1-codex-mini` | input: 0.75, output: 3.00 |
| `gpt-5.1-codex-max` | input: 5.00, output: 20.00 |
| `gpt-5.2` | input: 2.50, output: 10.00 |
| `gpt-5.2-codex` | input: 2.00, output: 8.00 |
| `gpt-5.3-codex-spark` | input: 1.75, output: 7.00 |

Already present: `gpt-5.3-codex`, `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.4-nano`, `gpt-5.4-pro`, `o3`, `o4-mini`.

File a follow-up PR after confirming which models ChatGPT Plus/Pro subscriptions actually expose.
