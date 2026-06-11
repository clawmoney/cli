export type PreflightStatus = "ok" | "failed" | "unknown";
export interface PlatformPreflight {
    /** Display name surfaced in the app notice. */
    label: string;
    /** "local-app" | "web-login" | "social-login" — drives the app hint copy. */
    category: string;
    status: PreflightStatus;
    /** How many advertised skills sit under this platform prefix. */
    skills: number;
    /** Human-readable failure reason (only when failed/unknown). */
    reason?: string;
    /** Actionable fix shown to the operator. */
    hint?: string;
    /** false = nothing the operator can do (e.g. upstream app dropped the
     *  capability); the app keeps it off the notice banner. Default true. */
    actionable?: boolean;
    /** Login page the app can open for the operator to fix a logged-out
     *  browser platform in one click. */
    loginUrl?: string;
}
export interface PreflightReport {
    ts: string;
    /** false when any probed platform failed. */
    ok: boolean;
    summary: {
        checked: number;
        failed: number;
        droppedSkills: number;
    };
    /** Keyed by platform prefix (the segment before the first dot in a skill_id). */
    platforms: Record<string, PlatformPreflight>;
    /** skill_ids removed from the advertise set. */
    dropped: string[];
}
export interface PreflightOutcome {
    /** Skills that passed (or were never probed) — the advertise set. */
    skills: string[];
    report: PreflightReport;
}
/**
 * Probe every platform that has a registered dependency, drop the failures
 * from the advertise set, and build the report. `unknown` verdicts are
 * kept advertising (conservative) but recorded so the app can hint.
 */
export declare function runPreflight(skills: string[]): Promise<PreflightOutcome>;
/** Persist the verdict for the desktop app to read on its next dashboard load. */
export declare function writePreflightReport(report: PreflightReport): void;
