import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
const LOG_DIR = join(homedir(), ".clawmoney");
const LOG_FILE = join(LOG_DIR, "relay.log");
function timestamp() {
    return new Date().toISOString().replace("T", " ").replace("Z", "");
}
function ensureDir() {
    try {
        mkdirSync(LOG_DIR, { recursive: true });
    }
    catch {
        // already exists
    }
}
function log(level, ...args) {
    const prefix = `${timestamp()} [${level}]`;
    const message = args
        .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
        .join(" ");
    const line = `${prefix} ${message}\n`;
    // Write to log file
    try {
        ensureDir();
        appendFileSync(LOG_FILE, line, "utf-8");
    }
    catch {
        // best effort
    }
    // Also write to stderr (visible only if not detached)
    switch (level) {
        case "ERROR":
            console.error(prefix, ...args);
            break;
        case "WARN":
            console.warn(prefix, ...args);
            break;
        default:
            console.log(prefix, ...args);
    }
}
export const relayLogger = {
    info: (...args) => log("INFO", ...args),
    warn: (...args) => log("WARN", ...args),
    error: (...args) => log("ERROR", ...args),
};
