# SpareAI CLI

> Earn with your idle AI subscriptions — turn spare Claude / Codex / Gemini capacity into income.

**SpareAI** is a two-sided marketplace for AI capacity. Consumers get one OpenAI-compatible API backed by real subscription-grade models; providers (that's you, with this CLI) serve those requests through the AI subscriptions already sitting idle on your machine and get paid per request.

🌐 Homepage: [spareai.org](https://spareai.org) · 🖥️ Desktop app: [SpareAI for macOS](https://github.com/jackleeio/spareai-releases/releases/latest)

## How it works

```
buyer (OpenAI-compatible API) → SpareAI hub → your machine → your Claude/Codex/Gemini subscription
```

- Your machine keeps a lightweight relay daemon connected to the SpareAI hub.
- When a buyer requests a model you offer, the hub routes it to you; the daemon serves it with your local subscription credentials and streams the response back.
- You earn per request, with per-model concurrency caps and a daily spend limit you control. Your credentials never leave your machine.

## Quick start

```bash
npm install -g spareai

# 1. Create your provider account / log in
spareai setup

# 2. Detect installed AI CLIs, pick models, register — all in one go
spareai relay setup

# 3. Start serving
spareai relay start

# Check your models, load and earnings anytime
spareai relay status
```

Supported upstreams today: **Claude** (claude.ai subscription), **Codex** (ChatGPT subscription), **Gemini** (Google account), with more rolling out.

## Everyday commands

| Command | What it does |
| --- | --- |
| `spareai relay status` | Per-model online status, load, and earnings |
| `spareai relay logs` | Tail the relay daemon log |
| `spareai relay preflight` | Validate upstream credentials without starting the daemon |
| `spareai relay stop` | Stop serving |
| `spareai ui` | Menu-bar dashboard (uses the desktop app if installed) |
| `spareai task start` | Serve agent-skill tasks (social, data) in addition to relay |

## 中文简介

SpareAI 是一个 AI 算力双边市场：买方拿到一个 OpenAI 兼容 API，背后由真实订阅级模型提供服务；供给方（你）用这个 CLI 把闲置的 Claude / Codex / Gemini 订阅额度挂到市场上按请求计费赚钱。凭据始终留在本机，并发与每日额度由你控制。

```bash
npm i -g spareai && spareai setup && spareai relay setup && spareai relay start
```

## Config & data

Everything lives in `~/.spareai` (migrated automatically from the legacy `~/.clawmoney`). The `clawmoney` command remains as a compatibility alias for `spareai`.

## License

MIT
