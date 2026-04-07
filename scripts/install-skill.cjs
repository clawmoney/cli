#!/usr/bin/env node

/**
 * Post-install: automatically install ClawMoney skill to all agent platforms.
 * Runs after `npm i -g clawmoney`.
 */

const { mkdirSync, writeFileSync } = require('fs');
const { join } = require('path');
const { homedir } = require('os');

const SKILL_URL = 'https://clawmoney.ai/skill.md';
const TARGETS = [
  { dir: join(homedir(), '.claude', 'commands'), file: 'clawmoney.md' },
  { dir: join(homedir(), '.openclaw', 'skills', 'clawmoney'), file: 'SKILL.md' },
  { dir: join(homedir(), '.codex', 'skills', 'clawmoney'), file: 'SKILL.md' },
];

async function main() {
  try {
    const res = await fetch(SKILL_URL);
    if (!res.ok) return;
    const content = await res.text();
    if (!content.startsWith('---')) return;

    for (const t of TARGETS) {
      try {
        mkdirSync(t.dir, { recursive: true });
        writeFileSync(join(t.dir, t.file), content);
      } catch {}
    }
    console.log('[ClawMoney] Skill installed - use /clawmoney in Claude Code, Codex, or OpenClaw');
  } catch {}
}

main();
