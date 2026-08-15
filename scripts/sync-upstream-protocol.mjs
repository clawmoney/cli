#!/usr/bin/env node
/**
 * Pull official OSS CLI sources and report protocol drift vs docs/upstream-pins.json.
 *
 *   node scripts/sync-upstream-protocol.mjs
 *
 * Does not auto-edit adapters. Prints a JSON report. Exit 1 when a pin is stale.
 */
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PINS_PATH = join(ROOT, "docs", "upstream-pins.json");
const MIRROR = process.env.UPSTREAM_CLIS_DIR
  || join(homedir(), "Projects", ".upstream-clis");

const pins = JSON.parse(readFileSync(PINS_PATH, "utf-8"));

function sh(cmd, cwd) {
  return execSync(cmd, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function npmVersion(pkg) {
  try {
    return sh(`npm view ${pkg} version`);
  } catch {
    return null;
  }
}

function ensureClone(name, repo) {
  const dir = join(MIRROR, name);
  mkdirSync(MIRROR, { recursive: true });
  if (existsSync(join(dir, ".git"))) {
    sh("git fetch --depth 1 origin HEAD", dir);
    sh("git reset --hard FETCH_HEAD", dir);
  } else {
    sh(`git clone --depth 1 --single-branch ${repo} ${name}`, MIRROR);
  }
  return {
    dir,
    head: sh("git log -1 --format=%h", dir),
    date: sh("git log -1 --format=%ci", dir),
    subject: sh("git log -1 --format=%s", dir),
  };
}

function readJsonVersion(dir, rel) {
  const p = join(dir, rel);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf-8")).version ?? null;
  } catch {
    return null;
  }
}

const report = { updatedAt: new Date().toISOString(), stale: [], items: {} };

for (const [name, spec] of Object.entries(pins.clis)) {
  const git = ensureClone(name, spec.repo);
  const sourceVersion =
    readJsonVersion(git.dir, "package.json")
    || readJsonVersion(git.dir, "apps/kimi-code/package.json")
    || spec.version;
  const published = spec.npm ? npmVersion(spec.npm) : null;
  const headMoved = Boolean(spec.gitHead) && git.head !== spec.gitHead && !git.head.startsWith(spec.gitHead);
  const stale =
    headMoved
    || (published && spec.version !== "source-head" && published !== spec.version)
    || (sourceVersion && spec.version !== "source-head" && sourceVersion !== spec.version && !String(sourceVersion).includes("nightly"));
  const item = {
    pin: spec.version,
    npm: published,
    sourceVersion,
    git: { head: git.head, date: git.date, subject: git.subject },
    pinnedHead: spec.gitHead ?? null,
    adapterFile: spec.adapterFile ?? null,
    stale: Boolean(stale),
  };
  report.items[name] = item;
  if (item.stale) report.stale.push(name);
}

console.log(JSON.stringify(report, null, 2));
if (report.stale.length) {
  console.error(`\nstale pins: ${report.stale.join(", ")}`);
  process.exit(1);
}
