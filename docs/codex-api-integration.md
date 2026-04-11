# Codex API Integration

**Status**: Live against codex-cli 0.118.0 — WebSocket wire format validated against real chatgpt.com traffic on 2026-04-11.

## What ships

| File | Purpose |
|---|---|
| `src/relay/upstream/codex-api.ts` | Production module — WebSocket client mirroring `claude-api.ts` structure |
| `scripts/capture-codex-request.mjs` | Bootstrap tool — WebSocket-aware CONNECT tunnel + fingerprint extractor (port 8788) |
| `docs/codex-api-integration.md` | This writeup |

## Upstream URL

```
wss://chatgpt.com/backend-api/codex/responses
```

Same path as the old HTTP POST endpoint, just accessed via WebSocket upgrade. Confirmed by capturing a real `codex exec` handshake against a local MITM proxy on 2026-04-11.

## Wire format

codex-cli 0.118+ speaks **one WebSocket per turn**:

1. Client sends HTTP GET /v1/responses to `chatgpt.com` with `Connection: Upgrade` / `Upgrade: websocket` plus the handshake headers below.
2. Server responds `HTTP/1.1 101 Switching Protocols` (with `Sec-WebSocket-Accept` + negotiated `permessage-deflate`).
3. Client sends a single **text frame** containing a JSON object equivalent to the old POST body with `type: "response.create"` injected:
    ```json
    {
      "type": "response.create",
      "model": "gpt-5.4",
      "input": [{"type":"message","role":"user","content":"<prompt>"}],
      "instructions": "...",
      "store": false,
      "stream": true
    }
    ```
4. Server streams text frames mirroring the old SSE event names:
    - `response.created`, `response.in_progress`, `response.output_item.added`
    - `response.output_text.delta` — `{"delta":"..."}` text chunks
    - `response.output_item.done`, `response.completed` — terminal, carries `response.usage` and `response.output[]`
    - `rate_limits` — standalone frame with `primary` / `secondary` reset windows
    - `response.failed` / `response.error` — error terminal; carries `error.code`, `error.type`, `error.message`
5. Client closes with status 1000 after observing the terminal event.

All frames are permessage-deflate compressed on the wire. The `ws` npm package handles deflate negotiation transparently, so in production we see already-decoded UTF-8 JSON.

## Handshake headers (captured)

Required (sent on the Upgrade request):

| Header | Source | Notes |
|---|---|---|
| `authorization` | `~/.codex/auth.json` → `tokens.access_token` | `Bearer <jwt>` |
| `chatgpt-account-id` | `~/.codex/auth.json` → `tokens.account_id` | UUID, identifies the ChatGPT subscription |
| `originator` | `codex_exec` | Literal value from real CLI capture (not `codex_cli_rs`) |
| `openai-beta` | `responses_websockets=2026-02-06` | WebSocket protocol version flag |
| `session_id` | 15-min masked UUID | Same value as `x-client-request-id` in capture |
| `version` | `0.118.0` | Literally the header name "version", not `x-version` |
| `x-codex-turn-metadata` | `{"session_id":"...","turn_id":"...","workspaces":{...}}` | JSON blob tracking turn context |
| `x-client-request-id` | UUID | Same value as `session_id` in capture |
| `sec-websocket-*` | Auto | Handled by `ws` package |

Notably **no `user-agent`** was observed in the real codex-cli 0.118 handshake — the binary does not send one. Our client omits `user-agent` by default; only sends one if the fingerprint file explicitly contains a non-empty string (for compatibility with older capture runs).

## OAuth token source

`~/.codex/auth.json` shape:

- `auth_mode`: `"chatgpt"` for OAuth subscriptions
- `tokens.id_token` — OIDC id token (not sent on requests)
- `tokens.access_token` — Bearer JWT (expiry decoded from `exp` claim at load time)
- `tokens.refresh_token` — Refresh token
- `tokens.account_id` — UUID, becomes `chatgpt-account-id` header

**No explicit `expiresAt` field** — `decodeJwtExp()` reads `exp` from the payload.

## Token refresh

```
POST https://auth.openai.com/oauth/token
Content-Type: application/x-www-form-urlencoded

grant_type=refresh_token&refresh_token=<rt>&client_id=app_EMoamEEZ73f0CkXaXp7hrann&scope=openid+profile+email
```

Scope: `openid profile email` (drops `offline_access` on refresh, per sub2api `openai/pkg/oauth.go:RefreshScopes`). Refreshed tokens persist back to `~/.codex/auth.json` so the user's real Codex CLI stays in sync.

Triggered in two paths:
1. **Proactive** — `getFreshCreds()` refreshes when within `REFRESH_SKEW_MS` (3 min) of JWT `exp`.
2. **Reactive** — a 401 on the upgrade response triggers one-shot refresh + retry (`hasRefreshed` guard).

## Rate limits

Codex surfaces rate-limit state in **two** places on the WS protocol:

1. **Upgrade-phase HTTP headers** (on 4xx/5xx upgrade responses) — `x-codex-primary-reset-after-seconds`, `x-codex-secondary-reset-after-seconds`, `retry-after`. `cooldownFromHttpHeaders()` parses and picks the nearest real reset time.
2. **Inline `rate_limits` JSON frames** over the socket — same fields, nested under `rate_limits.primary.reset_after_seconds`. Parsed by `cooldownFromRateLimitsFrame()` and fed to `rateGuard.triggerCooldown()`.

429 on the upgrade → hard cooldown + immediate error (no retry).
Transient `rate_limits` mid-stream → soft cooldown hint (we still complete the current request; next request will short-circuit at the guard).

## Retry matrix

| Failure | Action |
|---|---|
| 401 upgrade | One-shot token refresh + retry |
| 429 upgrade | Cooldown + fail (no retry) |
| 5xx upgrade | Exponential backoff + jitter, up to 2 retries |
| Transport error (DNS/TCP/TLS) | Exponential backoff + jitter, up to 2 retries |
| WS closed mid-turn | Exponential backoff + jitter, up to 2 retries |
| `response.failed` / `response.error` frame | Fail, no retry |
| Overall timeout (180s) | Fail, no retry |

## Fingerprint schema (`~/.clawmoney/codex-fingerprint.json`)

```json
{
  "user_agent": "",
  "cli_version": "0.118.0",
  "originator": "codex_exec",
  "openai_beta": "responses_websockets=2026-02-06"
}
```

- `user_agent` — Empty string if codex-cli does not send one (0.118 default). Non-empty string overrides.
- `cli_version` — Used as the literal `version` header value.
- `originator` — `originator` header; must match `CodexOfficialClientOriginatorPrefixes` pattern (`codex_` prefix).
- `openai_beta` — The `openai-beta` handshake header; pin to the exact WS protocol version.

**No `device_id` / `account_uuid`** — Codex uses `chatgpt-account-id` (loaded from `auth.json` at runtime) instead of per-device metadata. The fingerprint file is safe to check into dev environments; it contains zero secrets.

## Proxy support

When `HTTPS_PROXY` / `https_proxy` is set, we:
1. Install an undici `ProxyAgent` as the global dispatcher so the OAuth refresh `fetch()` tunnels correctly.
2. Use an inline `HttpsConnectAgent` subclass that speaks HTTP CONNECT to the proxy for the WebSocket dial. No third-party proxy-agent dep required — ~50 lines of native `net` + `tls` glue in `codex-api.ts`.

SOCKS proxies are **not** supported (logged and ignored).

## Bootstrap / capture procedure

The capture script at `scripts/capture-codex-request.mjs` is a WebSocket-aware MITM proxy:

1. Listens on `127.0.0.1:8788` as a plain HTTP server.
2. On an incoming `Upgrade: websocket` request, opens a raw TLS socket to `chatgpt.com:443` (tunneling via `HTTPS_PROXY` if set), replays the upgrade line + headers, pipes the `101 Switching Protocols` response back, and then relays frames in both directions verbatim so codex-cli talks to the real upstream.
3. Decodes every frame on the fly (one-sided unmasking for client → server) and appends a scrubbed JSON log to `~/.clawmoney/capture-codex-<ts>-handshake.json`.
4. Extracts the fingerprint (`version`, `originator`, `openai-beta`) on the first upgrade and writes `~/.clawmoney/codex-fingerprint.json`.
5. On Ctrl-C, scrubs all `capture-codex-*.json` files (they contain OAuth Bearer tokens even if individual values are redacted).

```bash
# Terminal A — run the capture
https_proxy=http://127.0.0.1:7890 node scripts/capture-codex-request.mjs

# Terminal B — run codex through it
OPENAI_BASE_URL=http://127.0.0.1:8788/v1 \
  NO_PROXY=127.0.0.1,localhost no_proxy=127.0.0.1,localhost \
  https_proxy=http://127.0.0.1:7890 \
  codex exec --skip-git-repo-check "say ok"
```

`NO_PROXY=127.0.0.1` is **critical** — without it codex will try to tunnel the loopback connection through the upstream proxy and fail.

## Known gaps / follow-ups

1. **Multi-turn via `previous_response_id`** — codex-cli maintains turn state by echoing `previous_response_id` on subsequent frames. Relay is single-turn so we don't need this, but continuations would require plumbing it through `CallCodexApiOptions`.
2. **`x-codex-turn-metadata` payload fidelity** — We synthesize a minimal JSON (`{session_id, turn_id, workspaces: {}}`) matching the observed keys. Real codex populates `workspaces` with workspace metadata for the current repo; upstream might track this as a fingerprint signal.
3. **`reasoning.effort` field** — `gpt-5.4` / `gpt-5.4-codex` support configurable reasoning effort; we don't forward it. Buyers that need reasoning control would need a new `CallCodexApiOptions` field.
4. **`cache_creation_tokens`** — Responses API `usage` does not expose cache write separately. Hard-coded `0`.
5. **Permessage-deflate tuning** — We let `ws` default-negotiate deflate. Real codex specifies `permessage-deflate; client_max_window_bits`; ws's default is compatible but not byte-identical on the `Sec-WebSocket-Extensions` line. No observable upstream rejection so far.
6. **Tools / function-calling** — Real `response.create` frames from codex-cli typically include a `tools` array and `tool_choice`. We omit both (pure text relay). If upstream starts gating tools on presence, we'd need to send an empty `tools: []` at minimum.

## Wiring into `provider.ts`

Unchanged from the previous HTTP integration — `callCodexApi` and `preflightCodexApi` preserve the same signatures. The old "temporarily disabled" throw in `preflightCodexApi` has been removed; providers with `execution_mode: "api"` and `cli_type: "codex"` now activate the WebSocket path directly.

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
