import { homedir } from "os";
import { join } from "path";
import { existsSync, lstatSync, mkdirSync, renameSync, symlinkSync, } from "fs";
let cached = null;
/**
 * SpareAI config dir (~/.spareai), migrating the legacy ~/.clawmoney dir on
 * first use.
 *
 * Migration contract (must stay true for old binaries to keep working):
 * - If ~/.spareai doesn't exist but a real ~/.clawmoney dir does, the old dir
 *   is renamed to ~/.spareai and a symlink is left at ~/.clawmoney. rename()
 *   doesn't invalidate open fds, so a relay/task daemon still running the old
 *   code keeps logging to the same files; its next open() lands on the same
 *   data through the symlink.
 * - The ~/.clawmoney symlink is (re)created whenever it's missing, otherwise a
 *   pre-rename desktop app or npm version would mkdir a fresh ~/.clawmoney and
 *   the two dirs would silently diverge.
 * - On any fs error we fall back to whichever dir exists rather than throwing:
 *   a failed rename must never take the provider offline.
 */
export function spareaiDir() {
    if (cached)
        return cached;
    const newDir = join(homedir(), ".spareai");
    const oldDir = join(homedir(), ".clawmoney");
    try {
        let newExists = existsSync(newDir);
        let oldIsRealDir = false;
        try {
            oldIsRealDir = lstatSync(oldDir).isDirectory();
        }
        catch {
            // no legacy dir
        }
        // A stale ~/.spareai (pre-rename experiments) must not shadow the live
        // config in ~/.clawmoney — whichever dir holds config.yaml is the real
        // one. Park the stale dir and let the migration below proceed.
        if (newExists &&
            oldIsRealDir &&
            !existsSync(join(newDir, "config.yaml")) &&
            existsSync(join(oldDir, "config.yaml"))) {
            try {
                renameSync(newDir, join(homedir(), `.spareai.stale-${Date.now()}.bak`));
                newExists = false;
            }
            catch {
                // couldn't park it — leave newDir as the winner rather than risk data
            }
        }
        if (!newExists) {
            if (oldIsRealDir) {
                renameSync(oldDir, newDir);
            }
            else {
                mkdirSync(newDir, { recursive: true });
            }
        }
        if (!existsSync(oldDir)) {
            try {
                symlinkSync(newDir, oldDir);
            }
            catch {
                // e.g. dangling symlink already present — harmless
            }
        }
    }
    catch {
        // best effort — resolved below
    }
    cached = existsSync(newDir) ? newDir : oldDir;
    return cached;
}
/** join(spareaiDir(), ...parts) shorthand. */
export function spareaiPath(...parts) {
    return join(spareaiDir(), ...parts);
}
