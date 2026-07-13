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
export declare function spareaiDir(): string;
/** join(spareaiDir(), ...parts) shorthand. */
export declare function spareaiPath(...parts: string[]): string;
