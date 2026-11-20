/**
 * The `/resume` picker: candidate rows + index reply, per the design doc's
 * settled interaction (rendering lives in `buildSessionListCard`, a native
 * schema 2.0 table card). Candidate filtering mirrors dsh-tui-pi's picker
 * exactly (root sessions only — value test on delegationDepth, never a
 * presence test). Ordering matches the TUI picker's "last update" sort:
 * the jsonl log's mtime when known (best-effort walk of the persistence
 * store, `loadSessionLastUpdates`), else the header's `createdAt` — so a
 * session touched yesterday but created last month surfaces above a
 * newer-created stale one, identically on phone and terminal. Only the
 * shortlist gets a bounded concurrent inspect for the preview/lastTime
 * columns (spike S2b: 10–33ms per session).
 *
 * `list()` is only ever called on an explicit `/resume` (spike S2c: cold
 * listing can take seconds on a long history) — never at startup.
 *
 * Scratch filtering: the TUI's startup /resume flow leaves a one-command
 * session behind on EVERY dsh boot (bootstrap events + a command/run, no
 * conversation), always with the freshest mtime — without filtering these
 * poison the picker's top rows and `/resume 1` lands on garbage. A session
 * whose inspected log carries no user/assistant message is dropped and the
 * next candidate fills the row; an INSPECT FAILURE keeps the row (unknown
 * is not scratch).
 */
import { SessionId, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session';
/** One `persistence.list()` entry: dsh ≥ 0.1.5-rc.1 wraps each header in a `{header, revision, sizeBytes}` snapshot; ≤ 0.1.2 returned the bare header. */
export type SessionListEntry = SessionHeader | {
    header: SessionHeader;
};
/**
 * Normalize one {@link SessionPersistenceLike.list} entry to its bare header
 * (port of dsh-tui-pi's `headerOf`): the 0.1.5 host returns snapshots, older
 * hosts return the header directly.
 */
export declare function headerOf<T extends {
    id: unknown;
}>(entry: T | {
    header: T;
}): T;
/** Read side of the 0.1.5 cold-read handle (`open(id, 'read')`). */
interface SessionReadHandle {
    header: SessionHeader;
    read(offset?: number, length?: number, options?: {
        signal?: AbortSignal;
    }): Promise<{
        events: readonly SessionEvent[];
    }>;
    close(): Promise<void>;
}
/** The `sessionPersistence` surface this module needs (structural). */
export interface SessionPersistenceLike {
    list(signal?: AbortSignal): Promise<readonly SessionListEntry[]>;
    /**
     * Legacy (≤ 0.1.2) one-shot validated read. dsh 0.1.5-rc.1 removed it —
     * {@link readPersistedSession} routes through `open` + a read-handle drain
     * when `open` is present.
     */
    inspect?(id: SessionId, signal?: AbortSignal): Promise<{
        meta: SessionHeader;
        events: readonly SessionEvent[];
    }>;
    /** dsh 0.1.5-rc.1: validated cold read = `open(id, 'read')` + a full read-handle drain. */
    open?(sessionId: SessionId, access: 'read' | 'write', options?: {
        signal?: AbortSignal;
    }): Promise<SessionReadHandle>;
}
/**
 * Validated cold read of one stored session's full log, `{meta, events}`.
 * Routes the two host seam generations: the 0.1.5 `open` + read-handle drain
 * when present, else the legacy one-shot `inspect` (port of dsh-tui-pi's
 * `readPersistedSession`).
 */
export declare function readPersistedSession(persistence: SessionPersistenceLike, id: SessionId): Promise<{
    meta: SessionHeader;
    events: readonly SessionEvent[];
}>;
/** One table row shown to the operator (preview/lastTime enrich during build). */
export interface ResumeRow {
    /** Assigned last (contiguous from 1) — scratch filtering reorders rows. */
    index: number;
    readonly sessionId: string;
    /** cwd basename (or `?`). */
    readonly dir: string;
    /** Created time, epoch ms. */
    readonly createdAt: number;
    /** Last update time, epoch ms (jsonl log mtime; else the inspect event tail; undefined when both unavailable). */
    lastTime: number | undefined;
    /** First-prompt preview (or fallback label). */
    preview: string;
}
/** Rows shown per `/resume` (design: take the most recent 10). */
export declare const RESUME_ROW_LIMIT = 10;
/** Concurrent inspects while enriching rows (TUI picker uses 6). */
export declare const RESUME_CONCURRENCY = 6;
/** Hard character cap for a preview. */
export declare const PREVIEW_MAX_CHARS = 60;
/**
 * The jsonl persistence root guess: `$DSH_SESSION_ROOT`, else
 * `$DSH_HOME/sessions`, else `~/.dsh/sessions` — the dsh CLI convention,
 * same as dsh-tui-pi's picker. Only used for the mtime-based last-update
 * enrichment; a mismatched root simply leaves rows sorted by `createdAt`.
 */
export declare function sessionLogRoot(): string;
/**
 * Best-effort session-id → last-write time map from the jsonl store's file
 * mtimes — ported from dsh-tui-pi (`loadSessionLastUpdates`) so the phone
 * list and the TUI list order identically. One walk of
 * `<root>/<project>/<session>/session.jsonl[.zstd]`, stat per log; session
 * directory names are the path-encoded session ids (UUID ids encode to
 * themselves). Any failure resolves an empty map (rows degrade to
 * `createdAt` ordering) — never throws.
 */
export declare function loadSessionLastUpdates(root?: string): Promise<Map<string, number>>;
/**
 * Whether a persisted header is a resumable ROOT session — the exact filter
 * dsh-tui-pi applies (value test on delegationDepth; presence test would drop
 * every jsonl-restored header which materialises `delegationDepth: 0`).
 * Semantics note for dsh 0.1.7: the host dropped the subagent depth default
 * from 8 to 1, which changes nothing here — the test reads the header's OWN
 * effective `delegationDepth` (roots are 0 / absent at ANY max depth), never
 * a hardcoded default.
 */
export declare function isResumableSessionHeader(header: SessionHeader): boolean;
/**
 * The session's "first sentence": the first direct human prompt, falling back
 * to the first non-injected user-role text, then the first assistant message
 * (same ladder as the TUI picker, minus the TUI imports).
 */
export declare function previewOfEvents(events: readonly SessionEvent[]): string | undefined;
/**
 * Build the recent-rows table. Never throws: listing errors propagate (the
 * caller phrases the error), per-row inspect failures degrade to a fallback
 * preview and an absent lastTime.
 *
 * Ordering follows the TUI picker: `lastUpdates[id] ?? createdAt`, newest
 * first, ties broken by `createdAt` then id (deterministic). The map comes
 * from {@link loadSessionLastUpdates} (jsonl mtimes — a cheap stat walk, no
 * log reads); passing an empty/undefined map keeps the createdAt ordering.
 * Sorting and truncation happen BEFORE the inspect enrichment, so the index
 * contract below is assigned on the final order.
 */
export declare function buildResumeRows(persistence: SessionPersistenceLike, lastUpdates?: ReadonlyMap<string, number>, limit?: number, concurrency?: number): Promise<ResumeRow[]>;
/** Resolve `/resume N` against a pending table. */
export declare function pickResumeRow(rows: readonly ResumeRow[], n: number): ResumeRow | undefined;
export {};
