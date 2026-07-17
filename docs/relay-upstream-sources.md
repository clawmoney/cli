# Relay 上游家族：开源仓库 × 中转适配器 参考表

**用途**：每个供给家族（cli_type）对应的「官方客户端是否开源 / 官方仓库 /
本仓库的中转适配器 / 上游端点 / 已知坑」。以后要跟新模型、修请求兼容、
排查被拒，**直接照这张表去开源源码里找请求怎么发的**——中转的核心优势就是
「照着官方客户端 1:1 模拟请求，服务器分不出真假，不易被封」。

> 校验日期 2026-07-17。仓库 URL 均实测 HTTP 200（除标注）。

## 总表

| cli_type | 家族/产品 | 开源? | 官方仓库 | 适配器（本仓库 src/relay/upstream/） | 上游端点 |
|---|---|---|---|---|---|
| `grok` | Grok Build (xAI) | ✅ Rust | github.com/xai-org/grok-build | `grok-api.ts` | `cli-chat-proxy.grok.com/v1/responses` |
| `claude` | Claude Code (Anthropic) | ❌ 闭源 | — | `claude-api.ts` | `api.anthropic.com/v1/messages` |
| `codex` | Codex (OpenAI) | ⚠️ source-available | github.com/openai/codex | `codex-api.ts` | ChatGPT 后端（backend-api） |
| `gemini` | Gemini CLI (Google) | ✅ Apache | github.com/google-gemini/gemini-cli | `gemini-api.ts` | `cloudcode-pa.googleapis.com` |
| `antigravity` | Antigravity (Google) | ❌ 闭源 | — | `antigravity-api.ts` | `daily-cloudcode-pa.sandbox.googleapis.com` |
| `kimi-coding` | Kimi Code (Moonshot) | ✅ | github.com/MoonshotAI/kimi-code（OAuth 参照 MoonshotAI/kimi-cli） | `kimi-coding-api.ts` | `api.kimi.com/coding/v1`（OAuth `auth.kimi.com`） |
| `zai-coding` | ZCode (Z.ai / GLM) | ✅ MIT | github.com/zai-org（ZCode harness，确切 repo 名待补） | 经 openclaw/passthrough | GLM coding 端点 |
| `qwen-coding` | Qwen Code (阿里 QwenLM) | ✅ Apache（Gemini-CLI fork） | github.com/QwenLM/qwen-code | 经 openclaw/passthrough | dashscope / 百炼 |
| `minimax` | MiniMax（见下注） | ⚠️ 模型开源、无开源 coding CLI | github.com/MiniMax-AI/MiniMax-M2（模型）；MiniMax-AI/cli（多媒体 CLI，非 coding） | `minimax-api.ts` | `api.minimax.io`（Anthropic 兼容 `/anthropic`） |
| `qoder` | Qoder（阿里） | ❌ 闭源，私有 wire | — | 计划中（未做） | 私有 |
| `kiro` | Kiro（AWS） | ❌ 闭源（Code-OSS fork 二进制） | — | `kiro-cli.ts`（计划中） | AWS/Bedrock |
| `factory` | Factory Droid | ❌ 闭源 | — | 计划中（未做） | Factory 网关 |

## 关键澄清

- **Qwen Code ≠ Qoder**：两个不同产品。
  - **Qwen Code** = 阿里 QwenLM 的**开源** coding CLI（Gemini-CLI fork，Apache），跑 Qwen 模型 → `qwen-coding` 供给家族，好搞。
  - **Qoder** = 阿里另一条**闭源**的 agentic IDE/平台（qoder.com），私有 wire、不开放自定义端点 → 消费端接不进，供给端要反代其 headless CLI/SDK（难）。「Qwen-Coder-Qoder」是给 Qoder 平台训的模型，别混。
- **MiniMax「Code」不是一个独立开源 coding CLI**：模型 MiniMax-M2 开源（MIT）；官方 `MiniMax-AI/cli`（命令 `mmx`）是图/视频/语音的多媒体 CLI，不是 coding agent。coding 路子 = Claude Code + MiniMax 的 Anthropic 兼容端点。所以供给靠 `minimax-api.ts` 直连端点，不靠模拟某个 coding CLI。
- **开源 = 好搞**：撞到「请求被拒 / 缺头 / 参数不兼容」，直接读开源客户端的请求构造代码抄对。闭源那几个（qoder/kiro/factory/claude/antigravity）没这条捷径。

## grok 实战记录（2026-07-17 打通）

grok 从 426 到通，靠的就是读 `xai-org/grok-build` 源码。要点（`grok-api.ts`）：

- **必带头**（否则 `cli-chat-proxy` 426「version (none)」）：
  - `x-grok-client-version`（≥0.1.202，本仓库常量 `GROK_CLIENT_VERSION`，本机 CLI 0.2.93）
  - `x-grok-client-identifier: grok-shell`
- **body 不能带 `background` 字段**：Grok Responses API 报 400「Argument not supported: background」（与 OpenAI 不同）。`store: false` 可以带。
- **官方客户端完整头集**（`crates/codegen/xai-grok-sampler/src/client.rs`，可按需增强保真度/抗封）：
  `x-grok-conv-id` / `x-grok-req-id` / `x-grok-session-id` / `x-grok-agent-id` /
  `x-grok-model-override`（路由，grok-build 为默认路由可省）/ 条件性
  `x-grok-turn-idx` `x-grok-deployment-id` `x-grok-user-id` /
  base 层 `x-grok-client-version` `x-grok-client-identifier` `x-grok-client-mode`
  `x-grok-client-surface`。当前只带了必需的两个 + 已验证可通；其余为可选增强，
  逐个探测确认不破坏再加。
- **验证**：`curl api.spareai.org/v1/chat/completions -d '{"model":"grok-4.5",...}'`
  → 返回 `model: grok-4.5-build` 真实回复即通。

## 维护约定

- 新增/更新家族：先确认官方客户端仓库，读它请求构造 → 对齐适配器 header/body →
  自买自卖（`api.spareai.org`）验证 → 更新本表。
- 改了适配器请求行为 = 改接单行为：**提交 spareai-cli + 发 npm** 才对所有用户生效
  （见根 CLAUDE.md）。
