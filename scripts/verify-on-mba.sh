#!/usr/bin/env bash
# Verify clawmoney-cli api-mode relay on a second Mac (mba).
#
# Prerequisites on mba:
#   1. Claude Code logged in in a GUI terminal at least once (so the
#      Keychain entry "Claude Code-credentials" exists and is unlocked).
#   2. node >= 18 installed.
#   3. An HTTP proxy at localhost:7897 (or wherever) reachable from Node.
#
# This script:
#   1. Builds the current working tree.
#   2. rsyncs dist/ + scripts/ + package.json to mba:~/clawmoney-verify/.
#   3. Prints the exact commands Jack should run locally on mba to:
#       a) bootstrap claude-fingerprint.json (one-time, from a real claude call)
#       b) run the probe script
#       c) run the deep test
#
# Usage:
#   ./scripts/verify-on-mba.sh [ssh-host]
#
# Default ssh host: "mba".

set -euo pipefail

SSH_HOST="${1:-mba}"
REMOTE_DIR="~/clawmoney-verify"

echo "━━━ clawmoney-cli api-mode verification on ${SSH_HOST} ━━━"
echo

# ── 1. Build locally ──────────────────────────────────────────────
echo "→ Building locally..."
npm run build

# ── 2. Sync to mba ────────────────────────────────────────────────
echo
echo "→ Syncing to ${SSH_HOST}:${REMOTE_DIR}/ ..."
ssh "${SSH_HOST}" "mkdir -p ${REMOTE_DIR}"
rsync -az --delete \
  --include='dist/' \
  --include='dist/**' \
  --include='scripts/' \
  --include='scripts/**' \
  --include='package.json' \
  --include='package-lock.json' \
  --exclude='*' \
  ./ "${SSH_HOST}:${REMOTE_DIR}/"

# node_modules is large but we only need undici. Install it remotely.
echo
echo "→ Installing runtime deps on ${SSH_HOST}..."
ssh "${SSH_HOST}" "source ~/.zshrc 2>/dev/null; export PATH=\"/opt/homebrew/bin:\$HOME/.local/bin:\$PATH\"; cd ${REMOTE_DIR} && npm install --omit=dev --no-audit --no-fund 2>&1 | tail -5"

# ── 3. Print manual instructions ──────────────────────────────────
cat <<'INSTRUCTIONS'

━━━ Manual steps (run these in a LOGIN-GUI terminal on mba) ━━━
(SSH sessions can't unlock the login Keychain non-interactively.)

# ── Step A: bootstrap fingerprint (ONCE, takes ~10 seconds) ──
# In terminal 1 on mba — launch capture server, giving it the proxy so it
# can forward the request upstream (anthropic blocks CN IPs directly):
cd ~/clawmoney-verify
https_proxy=http://127.0.0.1:7897 http_proxy=http://127.0.0.1:7897 \
  node scripts/capture-claude-request.mjs

# In terminal 2 on mba (leave capture-server running):
env -u http_proxy -u https_proxy -u all_proxy \
  ANTHROPIC_BASE_URL=http://127.0.0.1:8787 \
  /opt/homebrew/bin/claude -p "hi"

# After the capture server prints "Captured POST /v1/messages?beta=true",
# Ctrl+C the capture server. Then extract the fingerprint:
DEVICE=$(jq -r '.body.metadata.user_id' ~/.clawmoney/capture-*.json | jq -r '.device_id')
ACCOUNT=$(jq -r '.body.metadata.user_id' ~/.clawmoney/capture-*.json | jq -r '.account_uuid')
printf '{"device_id":"%s","account_uuid":"%s"}\n' "$DEVICE" "$ACCOUNT" \
  > ~/.clawmoney/claude-fingerprint.json

# IMPORTANT — security hygiene: capture files contain OAuth bearer tokens
# from the request headers. Delete them after extracting the fingerprint:
rm ~/.clawmoney/capture-*.json

# ── Step B: run probe (should return HTTP 200 and "ok") ──
cd ~/clawmoney-verify
https_proxy=http://127.0.0.1:7897 http_proxy=http://127.0.0.1:7897 \
  node scripts/probe-claude-api.mjs

# ── Step C: run deep test (concurrency + budget guard) ──
https_proxy=http://127.0.0.1:7897 http_proxy=http://127.0.0.1:7897 \
  node /tmp/deep-test-claude-api.mjs

# (If /tmp/deep-test-claude-api.mjs doesn't exist on mba, copy it from
#  the primary machine with: scp /tmp/deep-test-claude-api.mjs mba:/tmp/ )

━━━ Done ━━━
INSTRUCTIONS
