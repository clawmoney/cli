#!/usr/bin/env bash
# Install the ClawMoney Market Provider daemon as a launchd user agent on macOS.
#
# Why: providers who registered Market skills need their daemon running 7x24
# so buyer calls (via web chat / market call / etc) actually reach them.
# Without this script, `clawmoney market start` is a detached one-shot
# process — fine until the user reboots, closes their laptop, or the
# daemon crashes overnight.
#
# This script generates ~/Library/LaunchAgents/ai.clawmoney.market.plist
# pointing at the absolute path of the clawmoney binary, then loads it.
# After running once:
#   - Daemon auto-starts when the user logs into GUI
#   - Daemon auto-restarts if it crashes (with 10s throttle)
#   - WebSocket reconnects to api.bnbot.ai automatically (logic inside
#     the daemon itself; launchd just keeps the host process alive)
#
# Usage:
#   ./scripts/install-market-launchd.sh             # install + start (default: cli=openclaw)
#   ./scripts/install-market-launchd.sh --cli codex # install + start with codex backend
#   ./scripts/install-market-launchd.sh --cli claude --auto-accept
#                                                   # codex/claude + auto-accept escrow gigs
#   ./scripts/install-market-launchd.sh uninstall   # unload + remove plist
#
# Pre-reqs:
#   - `clawmoney setup` has written ~/.clawmoney/config.yaml
#   - Provider role registered: `clawmoney market setup` (or `register`)
#   - Whatever underlying CLI you pass via --cli must work standalone first:
#       e.g. `codex --version`, `claude --version`, `openclaw --version`
#   - clawmoney installed globally: npm i -g clawmoney

set -euo pipefail

LABEL="ai.clawmoney.market"
PLIST_PATH="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$HOME/.clawmoney"
STDOUT_LOG="$LOG_DIR/market.launchd.out.log"
STDERR_LOG="$LOG_DIR/market.launchd.err.log"

if [[ "$(uname)" != "Darwin" ]]; then
  echo "error: this script is for macOS only (launchd)" >&2
  exit 1
fi

if [[ "${1:-}" == "uninstall" ]]; then
  echo "Unloading $LABEL..."
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  rm -f "$PLIST_PATH"
  echo "Removed $PLIST_PATH."
  exit 0
fi

# ── Parse args: --cli <backend> [--auto-accept] ───────────────────────────
CLI=""
AUTO_ACCEPT=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --cli)
      CLI="$2"
      shift 2
      ;;
    --auto-accept)
      AUTO_ACCEPT="--auto-accept"
      shift
      ;;
    -h|--help)
      sed -n '2,30p' "$0"
      exit 0
      ;;
    *)
      echo "error: unknown arg '$1'. Run with -h for usage." >&2
      exit 1
      ;;
  esac
done

CLAWMONEY_BIN="$(command -v clawmoney || true)"
if [[ -z "$CLAWMONEY_BIN" ]]; then
  echo "error: clawmoney not found in PATH. Install with: npm i -g clawmoney" >&2
  exit 1
fi

# launchd executes with a minimal PATH, so we resolve node + the underlying
# CLI binary (codex / claude / etc) here and pass their dirs through
# EnvironmentVariables. The clawmoney binary itself is a Node shebang;
# its `market start` spawns the configured CLI as a child process, so the
# child needs to be on PATH at run time.
NODE_BIN="$(command -v node || true)"
if [[ -z "$NODE_BIN" ]]; then
  echo "error: node not found in PATH" >&2
  exit 1
fi
NODE_DIR="$(dirname "$NODE_BIN")"

# If the user passed --cli, sanity-check it exists.
CLI_DIR=""
if [[ -n "$CLI" ]]; then
  CLI_BIN="$(command -v "$CLI" || true)"
  if [[ -z "$CLI_BIN" ]]; then
    echo "warning: '$CLI' not found in PATH. Daemon will spawn it and may fail." >&2
  else
    CLI_DIR="$(dirname "$CLI_BIN")"
  fi
fi

mkdir -p "$LOG_DIR"
mkdir -p "$(dirname "$PLIST_PATH")"

# Build the ProgramArguments array dynamically based on flags.
PROGRAM_ARGS="    <string>$CLAWMONEY_BIN</string>
    <string>market</string>
    <string>start</string>"
if [[ -n "$CLI" ]]; then
  PROGRAM_ARGS+="
    <string>--cli</string>
    <string>$CLI</string>"
fi
if [[ -n "$AUTO_ACCEPT" ]]; then
  PROGRAM_ARGS+="
    <string>$AUTO_ACCEPT</string>"
fi

# Build a PATH that includes node + the CLI binary's dir + common locations.
RUN_PATH="$NODE_DIR"
if [[ -n "$CLI_DIR" && "$CLI_DIR" != "$NODE_DIR" ]]; then
  RUN_PATH="$RUN_PATH:$CLI_DIR"
fi
RUN_PATH="$RUN_PATH:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin"

cat > "$PLIST_PATH" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>

  <key>ProgramArguments</key>
  <array>
$PROGRAM_ARGS
  </array>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <true/>

  <!-- Restart no more than once per 10 seconds if it crashes in a loop. -->
  <key>ThrottleInterval</key>
  <integer>10</integer>

  <!-- Interactive: run inside the user's GUI login session so any CLI
       that needs the Keychain (codex with ChatGPT OAuth, claude with
       its own OAuth) can read its tokens. -->
  <key>ProcessType</key>
  <string>Interactive</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$RUN_PATH</string>
    <key>HOME</key>
    <string>$HOME</string>
  </dict>

  <key>WorkingDirectory</key>
  <string>$HOME</string>

  <key>StandardOutPath</key>
  <string>$STDOUT_LOG</string>
  <key>StandardErrorPath</key>
  <string>$STDERR_LOG</string>
</dict>
</plist>
EOF

chmod 0644 "$PLIST_PATH"

echo "Wrote $PLIST_PATH."

# Stop the foreground daemon (if any) before launchd takes over — otherwise
# both processes try to claim the same WebSocket slot and the second one
# loses (or worse, they fight over orders).
EXISTING_PID="$("$CLAWMONEY_BIN" market status 2>/dev/null | sed -nE 's/.*PID ([0-9]+).*/\1/p' | head -1 || true)"
if [[ -n "$EXISTING_PID" ]]; then
  echo "Stopping existing foreground daemon (PID $EXISTING_PID)..."
  "$CLAWMONEY_BIN" market stop >/dev/null 2>&1 || true
  sleep 1
fi

echo "Loading into launchd..."
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST_PATH"

echo ""
echo "Market Provider is running under launchd."
echo "  Label:    $LABEL"
echo "  cli:      ${CLI:-(default: openclaw)}"
echo "  auto-accept: ${AUTO_ACCEPT:+yes}${AUTO_ACCEPT:-no}"
echo "  logs:     $STDOUT_LOG"
echo "            $STDERR_LOG"
echo "            $LOG_DIR/provider.log  (daemon-internal log)"
echo "  status:   clawmoney market status"
echo "  uninstall: ./scripts/install-market-launchd.sh uninstall"
