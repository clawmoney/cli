import { logger } from "./logger.js";
const TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const seen = new Map();
let cleanupTimer = null;
export function isProcessed(orderId) {
    return seen.has(orderId);
}
export function markProcessed(orderId) {
    seen.set(orderId, Date.now());
}
function cleanup() {
    const cutoff = Date.now() - TTL_MS;
    let removed = 0;
    for (const [id, ts] of seen) {
        if (ts < cutoff) {
            seen.delete(id);
            removed++;
        }
    }
    if (removed > 0) {
        logger.info(`Dedup cleanup: removed ${removed} stale entries, ${seen.size} remaining`);
    }
}
export function startDedup() {
    if (cleanupTimer) {
        return;
    }
    cleanupTimer = setInterval(cleanup, CLEANUP_INTERVAL_MS);
    cleanupTimer.unref();
}
export function stopDedup() {
    if (cleanupTimer) {
        clearInterval(cleanupTimer);
        cleanupTimer = null;
    }
    seen.clear();
}
