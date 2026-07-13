import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const root = fileURLToPath(new URL("..", import.meta.url));
// Keep the temporary build under the repo so Node's ESM resolver can walk up
// to this package's node_modules (an OS temp directory cannot resolve undici).
const outDir = mkdtempSync(join(root, ".grok-test-"));

try {
  const compile = spawnSync(
    process.execPath,
    [
      join(root, "node_modules", "typescript", "bin", "tsc"),
      "--outDir",
      outDir,
      "--declaration",
      "false",
    ],
    { cwd: root, stdio: "inherit" }
  );
  if (compile.status !== 0) {
    process.exitCode = compile.status ?? 1;
  } else {
    const moduleUrl = pathToFileURL(
      join(outDir, "relay", "upstream", "grok-api.js")
    ).href;
    const tests = spawnSync(
      process.execPath,
      ["--test", "tests/grok-api.test.mjs"],
      {
        cwd: root,
        stdio: "inherit",
        env: { ...process.env, GROK_API_TEST_MODULE: moduleUrl },
      }
    );
    process.exitCode = tests.status ?? 1;
  }
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
