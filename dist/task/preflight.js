/**
 * Provider preflight.
 *
 * Before advertising skills to the hub we probe each platform's external
 * dependency — a local desktop app (Codex / ChatGPT), a logged-in browser
 * session (X / 小红书 / 抖音 / ChatGPT Web / Gemini / Flow), or the BNBot
 * Chrome extension link they all share. A skill whose dependency is
 * missing will fail *every* task and burn the provider's reputation, so
 * we drop those platforms from the advertise set instead of letting the
 * hub route work to them.
 *
 * Design choices:
 *   - Probes are LIGHT. We never run a real scrape/generation — only the
 *     `status` / `whoami` introspection commands bnbot already ships, or a
 *     filesystem/env check. The operator explicitly asked us not to hammer
 *     the machine on every boot. One exception: Codex SELF-HEALS — a
 *     portless/stopped Codex is relaunched with the CDP flag right here
 *     (see probeCodex) instead of being reported for manual fixing.
 *   - Only platforms with a *deterministic* dependency are probed. Public
 *     read surfaces (wiki / google / hn / reddit / youtube …) have no local
 *     dependency beyond network, so they are never dropped here — that
 *     avoids false-positives taking good platforms offline.
 *   - The extension link (`bnbot status`) is the shared gate for every
 *     browser-driven platform; we probe it once and reuse the verdict.
 *   - Everything re-runs on each daemon start. KeepAlive (launchd) and the
 *     desktop app's self-heal both restart the daemon, so installing Codex
 *     or logging into x.com recovers the platform on the next boot — no
 *     persistent blacklist to clear.
 *
 * The verdict is written to ~/.spareai/preflight.json for the desktop
 * app to surface as a home-screen notice + per-card status.
 */
import { execFile } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spareaiDir } from "../utils/home.js";
const PREFLIGHT_FILE = join(spareaiDir(), "preflight.json");
// A navigation login-probe costs ~15s and login state rarely flips, so reuse a
// recent verdict across daemon restarts (KeepAlive / app self-heal) instead of
// re-probing every browser platform each boot. Local-app probes (codex/chatgpt)
// are cheap + volatile, so they're always re-run, never cached.
const CACHE_FRESH_MS = 30 * 60 * 1000;
// Same resolution order as the skill handlers' bnbot lookup so the probe
// hits the exact binary the skills will use.
const BNBOT_CANDIDATES = [
    process.env.BNBOT_CLI,
    "bnbot",
    "/opt/homebrew/bin/bnbot",
    "/usr/local/bin/bnbot",
].filter((value, index, values) => typeof value === "string" && value.length > 0 && values.indexOf(value) === index);
function runBnbot(args, timeoutMs) {
    return new Promise((resolve) => {
        const attempt = (idx) => {
            const bin = BNBOT_CANDIDATES[idx];
            if (!bin) {
                resolve({ ok: false, stdout: "", stderr: "bnbot not found on PATH", missing: true });
                return;
            }
            execFile(bin, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
                const e = err;
                // Binary not at this path → try the next candidate.
                if (e && e.code === "ENOENT") {
                    attempt(idx + 1);
                    return;
                }
                resolve({
                    ok: !err,
                    stdout: stdout ?? "",
                    stderr: stderr ?? "",
                    missing: false,
                });
            });
        };
        attempt(0);
    });
}
/** Pull the first JSON object out of bnbot stdout (it may prefix a banner). */
function parseJson(stdout) {
    const trimmed = stdout.trim();
    if (!trimmed)
        return null;
    try {
        return JSON.parse(trimmed);
    }
    catch {
        const start = trimmed.indexOf("{");
        const end = trimmed.lastIndexOf("}");
        if (start >= 0 && end > start) {
            try {
                return JSON.parse(trimmed.slice(start, end + 1));
            }
            catch {
                return null;
            }
        }
        return null;
    }
}
// ── Shared extension gate ────────────────────────────────────────────
/** `bnbot status` — is the Chrome extension connected to `bnbot serve`?
 *  This is the common dependency for every browser-driven platform. */
async function probeExtensionLink() {
    const r = await runBnbot(["status"], 8000);
    if (r.missing) {
        return {
            status: "failed",
            reason: "未找到 bnbot 命令",
            hint: "安装 @bnbot/cli(provider 机器需要 bnbot)",
        };
    }
    // `bnbot status` prints a banner; "connected" only appears when the
    // extension handshake succeeded.
    if (/extension[\s\S]*connected/i.test(r.stdout) || /connected/i.test(r.stdout)) {
        return { status: "ok" };
    }
    return {
        status: "failed",
        reason: "BNBot 浏览器扩展未连接",
        hint: "打开 Chrome，确认已安装 BNBot 扩展且 `bnbot serve` 在运行",
    };
}
async function codexCdpStatus(extraArgs, timeoutMs) {
    const r = await runBnbot(["codex", "status", ...extraArgs], timeoutMs);
    if (r.missing)
        return { missing: true, connected: false, processRunning: false };
    const j = parseJson(r.stdout);
    return {
        missing: false,
        connected: j?.connected === true,
        processRunning: j?.processRunning === true,
    };
}
/**
 * Quit Codex the way Cmd+Q does (Apple Event). NEVER signal it instead:
 * SIGTERM reads as a crash to macOS, which reopens the app via launchd a
 * few seconds later — without our debug flag — and that zombie then owns
 * the single-instance lock, defeating the relaunch (verified live).
 */
function quitCodexGracefully() {
    return new Promise((resolve) => {
        execFile("osascript", ["-e", 'tell application id "com.openai.codex" to quit'], { timeout: 8000 }, (err) => resolve(!err));
    });
}
function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}
function codexProcessAlive() {
    return new Promise((resolve) => {
        execFile("pgrep", ["-x", "Codex"], (err) => resolve(!err));
    });
}
/** A CDP-style failure means the app launches fine but never opens the
 *  debug port (current Codex builds dropped CDP support entirely), so a
 *  fresh quit+relaunch cycle can't fix it — don't churn the operator's
 *  Codex again until the backoff expires or the failure mode changes. */
const HEAL_BACKOFF_MS = 6 * 60 * 60 * 1000;
function codexHealRecentlyFailed() {
    const prev = readPreviousReport();
    const last = prev?.platforms?.codex;
    if (!last || last.status !== "failed")
        return false;
    // Matches both the post-heal verdict ("…CDP 未就绪") and the backoff
    // verdict itself ("不支持 CDP 调试…") so the backoff renews each boot.
    if (!last.reason?.includes("CDP"))
        return false;
    const ts = Date.parse(prev?.ts ?? "");
    return Number.isFinite(ts) && Date.now() - ts < HEAL_BACKOFF_MS;
}
/**
 * Codex is the one dependency we try to SELF-HEAL instead of just reporting:
 * CDP can only be enabled at launch (Chromium limitation), and bnbot already
 * knows how to launch Codex with the debug port (`status --launch`). So a
 * portless instance gets a graceful quit + relaunch here, and "Codex not
 * running" gets a plain launch — the operator only sees a notice when that
 * automation genuinely failed (e.g. current Codex builds ignore the CDP
 * flag altogether — Chromium-148 shell, no remote debugging).
 */
async function probeCodex() {
    const first = await codexCdpStatus([], 8000);
    if (first.missing) {
        return { status: "failed", reason: "未找到 bnbot 命令", hint: "安装 @bnbot/cli" };
    }
    if (first.connected)
        return { status: "ok" };
    if (codexHealRecentlyFailed()) {
        return {
            status: "failed",
            reason: "Codex 不支持 CDP 调试(端口 9238)，自动修复已暂停重试",
            hint: "当前版本的 Codex 无法开启远程调试，绘图技能暂不可用；等待 bnbot 适配新版 Codex",
            actionable: false,
        };
    }
    if (first.processRunning) {
        // Quit the portless instance first: its single-instance lock would
        // swallow a relaunch (args forwarded to the old process, port ignored).
        console.log("[preflight] codex running without CDP — restarting with debug port…");
        await quitCodexGracefully();
        let gone = false;
        for (let i = 0; i < 8; i++) {
            await sleep(1000);
            if (!(await codexProcessAlive())) {
                gone = true;
                break;
            }
        }
        if (!gone) {
            return {
                status: "failed",
                reason: "Codex 已运行但 CDP 未就绪(端口 9238)，自动重启未成功",
                hint: "请手动退出 Codex(Cmd+Q)，接单守护会自动以调试端口重新拉起",
            };
        }
    }
    // Not running (or just quit) — launch with the CDP port and re-verify,
    // allowing a slow cold start some runway.
    const launched = await codexCdpStatus(["--launch"], 30000);
    if (launched.connected)
        return { status: "ok" };
    for (let i = 0; i < 6; i++) {
        await sleep(2000);
        const s = await codexCdpStatus([], 8000);
        if (s.connected)
            return { status: "ok" };
    }
    const stillRunning = launched.processRunning || (await codexProcessAlive());
    return {
        status: "failed",
        reason: stillRunning
            ? "Codex 已自动拉起但 CDP 未就绪(端口 9238)"
            : "Codex Desktop 自动启动未成功",
        hint: stillRunning
            ? "当前版本的 Codex 可能不支持远程调试；绘图技能暂不可用"
            : "安装并打开 Codex.app(运行 `codex app` 可自动下载)",
        // App launches fine but never opens the port → nothing the operator
        // can click to fix. A missing install IS fixable, keep that one loud.
        actionable: !stillRunning,
    };
}
async function probeChatGpt() {
    const r = await runBnbot(["chatgpt", "status"], 8000);
    if (r.missing) {
        return { status: "failed", reason: "未找到 bnbot 命令", hint: "安装 @bnbot/cli" };
    }
    const j = parseJson(r.stdout);
    if (j && j.running === true)
        return { status: "ok" };
    return {
        status: "failed",
        reason: "ChatGPT Desktop 未运行",
        hint: "安装并打开 ChatGPT.app 并保持登录",
    };
}
/** A landed URL matching this means the navigation bounced to a login wall. */
const DEFAULT_LOGGED_OUT = /login|signin|sign[_-]?in|passport|\/sso\b|accounts\.google\.com|auth\.openai\.com/i;
/**
 * Real login-state probe — the product's edge. Instead of guessing, drive the
 * extension to the platform's must-login page and read where it actually
 * landed: a logged-out session gets bounced to a login wall, a logged-in one
 * stays on the page. No business request is sent — same signal bnbot's own
 * `checkLoginRedirect` uses, just surfaced as a standalone check.
 */
async function probeLoginByNavigation(def) {
    const nav = await runBnbot(["navigate", def.url], def.navTimeoutMs ?? 18000);
    if (nav.missing) {
        return { status: "failed", reason: "未找到 bnbot 命令", hint: "安装 @bnbot/cli" };
    }
    // `debug eval` prints the live tab's URL as `.url` regardless of the
    // expression result — that's the signal we want.
    const ev = await runBnbot(["debug", "eval", "location.href"], 8000);
    const landed = parseJson(ev.stdout);
    const finalUrl = typeof landed?.url === "string" ? landed.url : "";
    if (!finalUrl) {
        return {
            status: "unknown",
            reason: `${def.label} 登录态探测超时`,
            hint: `若 ${def.label} 接单失败，请确认 Chrome 已登录`,
            loginUrl: def.url,
        };
    }
    const loggedOut = def.loggedOut || DEFAULT_LOGGED_OUT;
    if (loggedOut.test(finalUrl)) {
        return {
            status: "failed",
            reason: `${def.label} 未登录`,
            hint: `在 Chrome 登录 ${def.label} 后，接单守护重启即自动恢复`,
            loginUrl: def.url,
        };
    }
    return { status: "ok" };
}
/** Wrap a login-by-navigation probe, gated on the extension link being up
 *  (no extension → no browser session to read, so it's a hard fail). */
function navProbe(def) {
    return async (extensionOk) => {
        if (!extensionOk) {
            return {
                status: "failed",
                reason: "BNBot 浏览器扩展未连接",
                hint: "打开 Chrome 并确认 BNBot 扩展已连接",
            };
        }
        return probeLoginByNavigation(def);
    };
}
/** X: extension link is the gate; on top of it we read the active handle
 *  via `bnbot x whoami` (no real request — the extension reads the pool
 *  window's session). whoami needs a cold pool window so it's slow; on
 *  timeout we stay conservative ("unknown", keep advertising) rather than
 *  drop a platform that may well be logged in. */
async function probeX(extensionOk) {
    if (!extensionOk) {
        return {
            status: "failed",
            reason: "BNBot 浏览器扩展未连接",
            hint: "打开 Chrome 并确认 BNBot 扩展已连接",
        };
    }
    const r = await runBnbot(["x", "whoami"], 10000);
    const j = parseJson(r.stdout);
    const handle = j && (j.username || j.handle || j.screen_name || j.screenName || j.name);
    if (typeof handle === "string" && handle.trim()) {
        return { status: "ok" };
    }
    // Explicit "not logged in" signal → drop it.
    if (/not\s*logged|no\s*account|logged\s*out|null/i.test(`${r.stdout}\n${r.stderr}`)) {
        return {
            status: "failed",
            reason: "X(Twitter)未登录",
            hint: "在 Chrome 登录 x.com 后重启接单",
            loginUrl: "https://x.com/login",
        };
    }
    // whoami timed out / unparseable — fall back to the navigation probe. The
    // x.com/home page bounces to a login wall when logged out, which is more
    // robust than whoami's cold-pool-window read.
    return probeLoginByNavigation({ label: "X / Twitter", url: "https://x.com/home" });
}
// ── Registry ─────────────────────────────────────────────────────────
/**
 * Platforms with a deterministic external dependency. Anything not listed
 * here is assumed ready (public read surfaces) and never dropped.
 *
 * Keyed by platform prefix — the segment before the first dot in a
 * skill_id (e.g. "codex.image_generate" → "codex").
 *
 * Login-walled sites use a real navigation probe: open the must-login page,
 * read whether it bounced to a login wall. The `url` must be a page that
 * REQUIRES login (a creator dashboard / app home), so a logged-out session
 * redirects. Add a platform by dropping one line here.
 */
const PLATFORM_PROBES = {
    // Local desktop apps — exact, fast probes.
    codex: { label: "Codex 绘图", category: "local-app", probe: probeCodex },
    chatgpt: { label: "ChatGPT", category: "local-app", probe: probeChatGpt },
    // X keeps its dedicated handle read (cheaper, and names the account).
    x: { label: "X / Twitter", category: "social-login", probe: probeX },
    // Login-walled sites — real login-state probe by navigation.
    xhs: {
        label: "小红书", category: "social-login",
        probe: navProbe({ label: "小红书", url: "https://creator.xiaohongshu.com/" }),
    },
    dy: {
        label: "抖音", category: "social-login",
        probe: navProbe({ label: "抖音", url: "https://creator.douyin.com/" }),
    },
    gemini: {
        label: "Gemini 绘图", category: "web-login",
        // Google properties are slow from CN networks — same runway as Flow.
        probe: navProbe({ label: "Gemini", url: "https://gemini.google.com/app", navTimeoutMs: 28000 }),
    },
    flow: {
        label: "Google Flow", category: "web-login",
        probe: navProbe({ label: "Flow", url: "https://labs.google/fx/tools/flow", navTimeoutMs: 28000 }),
    },
    chatgpt_web: {
        label: "ChatGPT 网页", category: "web-login",
        probe: navProbe({ label: "ChatGPT 网页", url: "https://chatgpt.com/" }),
    },
};
/** Whether any probed platform depends on the Chrome extension. */
function needsExtension(prefixes) {
    for (const p of prefixes) {
        const probe = PLATFORM_PROBES[p];
        if (probe && probe.category !== "local-app")
            return true;
    }
    return false;
}
function prefixOf(skillId) {
    const dot = skillId.indexOf(".");
    return dot < 0 ? skillId : skillId.slice(0, dot);
}
/**
 * Probe every platform that has a registered dependency, drop the failures
 * from the advertise set, and build the report. `unknown` verdicts are
 * kept advertising (conservative) but recorded so the app can hint.
 */
export async function runPreflight(skills) {
    // Count skills per platform prefix so the report can show "3 skills off".
    const skillsByPrefix = new Map();
    for (const s of skills) {
        const p = prefixOf(s);
        const list = skillsByPrefix.get(p);
        if (list)
            list.push(s);
        else
            skillsByPrefix.set(p, [s]);
    }
    const probedPrefixes = new Set([...skillsByPrefix.keys()].filter((p) => PLATFORM_PROBES[p]));
    // Probe the shared extension link once if anything needs it.
    let extensionOk = true;
    if (needsExtension(probedPrefixes)) {
        const ext = await probeExtensionLink();
        extensionOk = ext.status === "ok";
        if (!extensionOk) {
            console.warn(`[preflight] extension link down: ${ext.reason}`);
        }
    }
    const platforms = {};
    const dropped = [];
    // Reuse a recent verdict for browser-login platforms (their nav probe is
    // slow). Only when the extension is up — a down extension invalidates every
    // cached "ok". `unknown` is never cached (it means "retry next time").
    const prev = readPreviousReport();
    const cacheFresh = !!prev &&
        Number.isFinite(Date.parse(prev.ts)) &&
        Date.now() - Date.parse(prev.ts) < CACHE_FRESH_MS;
    // Serial — these talk to one Chrome / one desktop app; parallel probes
    // would contend on the same UI and skew results.
    for (const prefix of probedPrefixes) {
        const def = PLATFORM_PROBES[prefix];
        const prefixSkills = skillsByPrefix.get(prefix) ?? [];
        const cached = prev?.platforms?.[prefix];
        const useCache = def.category !== "local-app" &&
            extensionOk &&
            cacheFresh &&
            !!cached &&
            cached.status !== "unknown";
        let result;
        if (useCache && cached) {
            result = {
                status: cached.status,
                reason: cached.reason,
                hint: cached.hint,
                actionable: cached.actionable,
                loginUrl: cached.loginUrl,
            };
        }
        else {
            try {
                result = await def.probe(extensionOk);
            }
            catch (err) {
                result = {
                    status: "unknown",
                    reason: `预演异常: ${err instanceof Error ? err.message : String(err)}`,
                    hint: "查看 ~/.spareai/task.log",
                };
            }
        }
        platforms[prefix] = {
            label: def.label,
            category: def.category,
            status: result.status,
            skills: prefixSkills.length,
            reason: result.reason,
            hint: result.hint,
            actionable: result.actionable,
            loginUrl: result.loginUrl,
        };
        console.log(`[preflight] ${prefix} (${def.label}): ${result.status}` +
            (useCache ? " (cached)" : "") +
            (result.reason ? ` — ${result.reason}` : ""));
        if (result.status === "failed") {
            dropped.push(...prefixSkills);
        }
    }
    const droppedSet = new Set(dropped);
    const keptSkills = skills.filter((s) => !droppedSet.has(s));
    const failed = Object.values(platforms).filter((p) => p.status === "failed").length;
    const report = {
        ts: new Date().toISOString(),
        ok: failed === 0,
        summary: {
            checked: probedPrefixes.size,
            failed,
            droppedSkills: dropped.length,
        },
        platforms,
        dropped,
    };
    return { skills: keptSkills, report };
}
/** Persist the verdict for the desktop app to read on its next dashboard load. */
export function writePreflightReport(report) {
    try {
        mkdirSync(spareaiDir(), { recursive: true });
        writeFileSync(PREFLIGHT_FILE, JSON.stringify(report, null, 2), "utf-8");
    }
    catch (err) {
        console.error(`[preflight] failed to write report: ${err instanceof Error ? err.message : String(err)}`);
    }
}
/** Read the last written report so fresh login-state verdicts can be reused
 *  across restarts (see CACHE_FRESH_MS). Null when absent/corrupt. */
function readPreviousReport() {
    try {
        if (!existsSync(PREFLIGHT_FILE))
            return null;
        return JSON.parse(readFileSync(PREFLIGHT_FILE, "utf-8"));
    }
    catch {
        return null;
    }
}
