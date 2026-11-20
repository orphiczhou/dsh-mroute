/**
 * Phone-side driver for the vendored repair tool (scripts/repair-session-
 * log.mjs, byte-identical with dsh-tui-pi's). The script is self-contained
 * (node builtins + an external `zstd` binary) and NEVER touches the original
 * log: `--apply` writes `<stem>.repaired.jsonl[.zstd]` beside it; swapping
 * the repaired file in is this module's job (with a .corrupt-bak kept).
 *
 * Script contract (verified empirically, 2026-08):
 * - dry-run (`no --apply`): exit 0 = clean · exit 3 = corruption diagnosed,
 *   NOTHING written · exit 2 = torn lines / usage / environment error.
 * - `--apply`: exit 0 = repaired file written (or "verdict: CLEAN" — no
 *   violations found, no file) · exit 2 = error. Missing input dies with an
 *   uncaught ENOENT (exit 1).
 * Exit 3 therefore only occurs in dry-runs, where it maps to `failed` (the
 * log is still corrupt) — `verifyClean` is the only dry-run consumer.
 */
/** One repair-tool outcome (an applied repair carries the generated path). */
export interface RepairResult {
    status: 'clean' | 'repaired' | 'failed';
    /** Failure reason (tool stderr/stdout snippet, spawn error, or timeout). */
    detail?: string;
    /** The `*.repaired` file the script wrote (status 'repaired' only). */
    repairedPath?: string;
}
/**
 * Injectable repair seam — the bot talks to THIS interface so tests swap the
 * process-spawning implementation for a fake.
 */
export interface RepairBackend {
    /** Probe the session dir for its log file (zstd first, raw fallback). */
    locateSessionLog(dir: string): Promise<string | undefined>;
    runRepair(logPath: string, options: {
        apply: boolean;
    }): Promise<RepairResult>;
    verifyClean(logPath: string): Promise<boolean>;
    swapRepaired(logPath: string, repairedPath: string): Promise<void>;
}
/** Mirror of the script's own output-name rule for `<stem>.repaired…`. */
export declare function repairedPathFor(logPath: string): string;
/**
 * The log file of a session dir: the current generation first (the artifact
 * name carries the format version since the V3 format —
 * `session.v3.jsonl[.zstd]`), then the legacy `session.jsonl[.zstd]`;
 * compressed when present, the raw jsonl otherwise (sessions written by
 * tooling without zstd exist on disk). The script itself accepts both
 * spellings — this only picks WHICH path to fix.
 */
export declare function locateSessionLog(dir: string): Promise<string | undefined>;
/** Run the vendored script once and map its exit onto a RepairResult. */
export declare function runRepair(logPath: string, options: {
    apply: boolean;
}): Promise<RepairResult>;
/** Dry-run the log through the script; true only on a CLEAN verdict. */
export declare function verifyClean(logPath: string): Promise<boolean>;
/**
 * Put the repaired log in place of the corrupted one. The original moves to
 * `<log>.corrupt-bak` (timestamped when that name is taken) — never deleted;
 * a failed swap-in restores it best-effort before rethrowing.
 */
export declare function swapRepaired(logPath: string, repairedPath: string): Promise<void>;
/** The real, process-spawning backend (the bot's default). */
export declare const defaultRepairBackend: RepairBackend;
