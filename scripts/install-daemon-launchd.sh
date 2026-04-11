#!/usr/bin/env bash
# Install the ClawMoney relay daemon as a launchd user agent on macOS.
#
# Why: macOS Keychain is locked in non-interactive SSH sessions, so running
# `clawmoney relay start` via `ssh host clawmoney relay start` silently fails
# to read Claude Code's OAuth token. A launchd *user* agent (LaunchAgents)
# runs in the user's GUI session context, where the Keychain is unlocked as
# long as the user is logged in at the console.
#
# This script generates ~/Library/LaunchAgents/ai.clawmoney.relay.plist, wires
# it up to the absolute path of the clawmoney binary, and loads it. After
# running this once, the daemon will auto-start on login and auto-restart if
# it crashes — no more "why did my daemon die overnight" pages.
#
# Usage:
#   ./scripts/install-daemon-launchd.sh           # install + start
#   ./scripts/install-daemon-launchd.sh uninstall # unload + remove plist
#
# Pre-reqs:
#   - `clawmoney setup` has already written ~/.clawmoney/config.yaml
#   - `clawmoney antigravity login` (if using antigravity)
#   - You've installed clawmoney globally (npm i -g clawmoney)

set -euo pipefail

LABEL="ai.clawmoney.relay"
PLIST_PATH="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$HOME/.clawmoney"
STDOUT_LOG="$LOG_DIR/launchd.out.log"
STDERR_LOG="$LOG_DIR/launchd.err.log"

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

CLAWMONEY_BIN="$(command -v clawmoney || true)"
if [[ -z "$CLAWMONEY_BIN" ]]; then
  echo "error: clawmoney not found in PATH. Install with: npm i -g clawmoney" >&2
  exit 1
fi

# launchd executes with a minimal PATH, so we resolve the real node too and
# pass it through EnvironmentVariables. The clawmoney binary itself is a
# Node shebang, so we need node on PATH at run time.
NODE_BIN="$(command -v node || true)"
if [[ -z "$NODE_BIN" ]]; then
  echo "error: node not found in PATH" >&2
  exit 1
fi
NODE_DIR="$(dirname "$NODE_BIN")"

mkdir -p "$LOG_DIR"
mkdir -p "$(dirname "$PLIST_PATH")"

cat > "$PLIST_PATH" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>

  <key>ProgramArguments</key>
  <array>
    <string>$CLAWMONEY_BIN</string>
    <string>relay</string>
    <string>start</string>
  </array>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <true/>

  <!-- Restart no more than once per 10 seconds if it crashes in a loop. -->
  <key>ThrottleInterval</key>
  <integer>10</integer>

  <!-- Run inside the user's GUI login session so the Keychain is unlocked
       and we can read Claude Code's OAuth token via `security`. -->
  <key>ProcessType</key>
  <string>Interactive</string>

  <key>EnvironmentVariables</key>
  <dict>
    <!-- launchd's default PATH doesn't include Homebrew / nvm. Point at the
         real node dir so the clawmoney shebang can find its interpreter. -->
    <key>PATH</key>
    <string>$NODE_DIR:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
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
echo "Loading into launchd..."

# bootout first in case we're reinstalling.
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST_PATH"

echo ""
echo "Daemon is running under launchd."
echo "  logs: $STDOUT_LOG / $STDERR_LOG"
echo "  check: clawmoney relay status"
echo "  stop:  ./scripts/install-daemon-launchd.sh uninstall"
