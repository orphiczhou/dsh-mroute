/**
 * Persisted bot state (bound session, think-display preference, last chat,
 * pairing admins) — a small JSON file in the dsh home
 * (`<dsh home>/dsh-feishu-state.json`).
 *
 * Why not the settings service (the pre-0.1.7 backend): dsh 0.1.7 replaced
 * the settings registry with plugin `static Config` projections where ONLY
 * user-editable `.volatile()` fields are writable at runtime — machine state
 * (pickers, cursors, pairing claims) is exactly what must NOT be volatile
 * (it would surface on the settings page and rewrite the profile patch on
 * every bot event). So the state moved to its own file: same in-memory
 * mirror + write-through semantics as before, zero settings dependency.
 *
 * Upgrade path: a fresh install (no state file yet) absorbs the 0.1.5-era
 * remnants from `<dsh home>/settings.yaml.imported` (or `settings.yaml`)
 * — the host renames the old document on first 0.1.7 boot — by reading the
 * `dsh-feishu:` section with a deliberately conservative flat-scalar parser
 * (anything nested, folded across lines or otherwise unexpected is skipped;
 * the decoders below fail closed). Without it, pairing claims would not
 * survive the upgrade and the bot would re-open pairing mode. The absorption
 * is one-shot and self-evidencing: what was absorbed (and what degraded)
 * is logged once, and the state file is written IMMEDIATELY — the upgrade
 * must not wait for the first mutation to become visible on disk.
 */
import type { Context } from '@deepseek-ai/cordis';
import type { ResumeRow } from './resume-table.ts';
/** A persisted /resume selection awaiting its index reply. */
export interface StoredPicker {
    /** Matches the interactive picker card's submit button. */
    id: string;
    rows: readonly ResumeRow[];
    expiresAt: number;
}
/** What the bot persists. */
export interface BotState {
    /** Bound root session id, when the bot is attached to one. */
    boundSessionId: string | undefined;
    /** Whether the think tail line is rendered on the round card (default on). */
    displayThink: boolean;
    /** Last chat the operator wrote from — where status cards go. */
    lastChatId: string | undefined;
    /**
     * Latest /resume picker. Persisted (not just in-memory) so a dsh restart
     * within the TTL does not strand the operator's `/resume N` reply — the
     * picker's 5-minute TTL still bounds staleness.
     */
    picker: StoredPicker | undefined;
    /**
     * Phone-selected default model (/model on the phone, plus the reasoning
     * effort the interactive /think and /profile-switch adapters may carry):
     * applied live to bot-created sessions and used by /new when no previous
     * route exists.
     */
    phoneModel: {
        provider: string;
        model: string;
        reasoningEffort?: string;
    } | undefined;
    /**
     * Admins added through pairing mode (the zero-config bootstrap): the first
     * p2p chat to tap the pairing card when the allowlist is completely empty.
     * Persisted so a claim survives restarts; unioned with the configured
     * operators on every gate check (read fresh — a claim must take effect
     * in-process immediately).
     */
    pairedOperators: readonly string[];
}
/** The state file, relative to the resolved dsh home. */
export declare const STATE_FILENAME = "dsh-feishu-state.json";
/**
 * The minimal logger seam the store needs. Structural on purpose: any cordis
 * logger (printf-style) or a test double satisfies it.
 */
export interface StateStoreLogger {
    info(format: string, ...values: readonly unknown[]): void;
    warn(format: string, ...values: readonly unknown[]): void;
}
/** Constructor options — tests inject an explicit `path` to stay off the real home. */
export interface StateStoreOptions {
    /** Full state-file path. Default: `<dsh home>/dsh-feishu-state.json`. */
    path?: string;
    /**
     * Where the legacy-absorption summary lines go. Default: the plugin
     * context's logger when it carries one, else silent — a store built with a
     * bare test context (`{ inject }`) must stay quiet, not crash.
     */
    logger?: StateStoreLogger;
}
/**
 * Resolve the dsh home the same way the host does, without importing it:
 * the profile context's home when mounted (structural read — absent in
 * tests/minimal hosts), else `$DSH_HOME`, else `~/.dsh`.
 */
export declare function resolveDshHome(ctx?: Context): string;
/**
 * Extract the top-level `dsh-feishu:` section of the old settings document.
 * Conservative on purpose: flat `key: value` lines only — nested maps,
 * lists, comments and blank-line runs never decode (the section this plugin
 * ever wrote WAS flat). undefined = no section found.
 */
export declare function legacyFeishuSection(text: string): Record<string, unknown> | undefined;
/**
 * File-backed state store. Construction starts the load (state file first,
 * legacy settings remnants on a fresh install); `ready()` resolves once the
 * load settled so early reads see the persisted values. Every mutation
 * mirrors into memory immediately and writes the file through a serialized
 * tmp+rename queue — persistence failures degrade to the in-memory copy
 * (the bot still works, it just re-binds after a restart), exactly the old
 * no-settings-service behavior.
 */
export declare class StateStore {
    private memory;
    private readonly path;
    /** The directory the state file (and the legacy document) live in. */
    private readonly home;
    private readonly logger;
    private readonly loading;
    private writes;
    constructor(ctx: Context, options?: StateStoreOptions);
    /** Wait for the initial load (a file read — settles on its own) so first reads see disk. */
    ready(): Promise<void>;
    /** Current snapshot. */
    get(): BotState;
    /** Merge a patch and persist it. Never throws. */
    update(patch: Partial<BotState>): Promise<void>;
    /**
     * The persisted pairing admins (OnboardStoreSeam shape): read fresh from
     * the store on every call so a claim lands in-process immediately.
     */
    getPairedOperators(): readonly string[];
    /** Add a pairing admin (dedup-merge) and persist. Never throws. */
    addPairedOperator(openId: string): Promise<void>;
    /**
     * Initial load: the state file, else one absorption pass over the legacy
     * document. An absorption persists IMMEDIATELY (before any mutation) — the
     * file must exist as soon as the state was taken over, so an operator (or
     * a support session) can SEE the claims survived the upgrade instead of
     * waiting for the first write to happen to land. Degraded keys and the
     * empty-shell edge each get one log line: the folded-scalar skips are
     * exactly the cases where the operator may need to re-pair.
     */
    private load;
    /** Serialized write-through: one tmp+rename at a time, failures swallowed. */
    private persist;
    private writeNow;
}
