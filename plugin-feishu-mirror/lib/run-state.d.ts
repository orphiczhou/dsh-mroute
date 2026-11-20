/**
 * Run-state fold: the pure event→state machine behind the Feishu status
 * card. Mirrors dsh-tui-pi's activity phase machine in spirit (fixed live
 * panels, O(1) per event) but renders nothing — the card builder projects
 * this state, the publisher pushes it on a 30s beat.
 *
 * Four entry points:
 * - {@link foldBoundEvent}: firehose events of the BOUND session (turns,
 *   tools, todo, retries, workflow agent-start/end markers).
 * - {@link foldChildEvent}: firehose events of a discovered subagent child
 *   session (header-discovered by the bot; keeps per-child rounds + tail).
 * - {@link foldBoundStreamChunk} / {@link foldChildStreamChunk}: live
 *   streaming chunks of the bound session / its children, delivered as
 *   `agent/assistant-stream` frames (dsh 0.1.5-rc.1 moved the deltas off the
 *   firehose; settlements still arrive on `session/event`).
 *
 * All payload reads go through `unknown` shapes and never throw — a malformed
 * event degrades to a no-op, never a crashed bridge.
 */
import type { SessionEvent } from './dsh-events.ts';
/** Cap on remembered settled-tool rows (the card shows the last few). */
export declare const TOOL_HISTORY_CAP = 8;
/** How much of a tool call's raw arguments the round card surfaces. */
export type ToolDetail = 'off' | 'brief' | 'full';
/** One settled tool for the status line (`✔ bash 1.2s`). */
export interface ToolSettledRow {
    readonly name: string;
    readonly ok: boolean;
    readonly durationMs: number;
    /**
     * Arguments digest per the config's `toolDetail` mode — a whitespace-folded
     * clipped line (`brief`) or the multi-line raw JSON, clipped (`full`).
     * Undefined under `off` (the historical byte-for-byte rows).
     */
    readonly detail?: string;
}
/** One tracked subagent child (compact row on the status card). */
export interface SubagentRow {
    readonly childId: string;
    /** Display label (`workhorse`, `subagent ab12cd34`, …). */
    label: string;
    /** Assistant-message count — the child's LLM round-trips. */
    rounds: number;
    /** Last visible output line (own content only, never a tool name). */
    tail: string | undefined;
    /** Last invoked tool name, when any. */
    lastTool: string | undefined;
    /** Settled marker; undefined while the child works. */
    outcome: 'completed' | 'failed' | 'cancelled' | undefined;
}
/** Whole mutable run state of the bound session. */
export interface RunState {
    /** A turn is in flight on the bound session. */
    running: boolean;
    turnStartedAt: number | undefined;
    turnEndedAt: number | undefined;
    turnEndReason: string | undefined;
    /**
     * A stop is in flight: `agent/turn-stopping` fired (the loop is at its
     * stop boundary / aborting), but the turn/end settlement has not landed
     * yet. The card shows "⛔ 停止中" immediately instead of leaving the phone
     * waiting on the old phase. Cleared on the next turn/start.
     */
    stopping: boolean;
    /** Last request failure summary (agent/request-error), shown in the card. */
    lastError: string | undefined;
    /** assistant/message count within the current turn (the "rounds"). */
    rounds: number;
    /** Epoch ms when the CURRENT round started (turn start or the previous round's message). */
    roundStartedAt: number | undefined;
    /** Duration of the round that just settled — the settled card's header reads it. */
    lastRoundDurationMs: number | undefined;
    /**
     * First-token latency of the round that just settled (ms, from the round's
     * start to the stream's first non-empty text/reasoning token), rebuilt from
     * the embedded AssistantStreamRecord. undefined when the stream carried no
     * token or the round start is unknown.
     */
    lastRoundFirstTokenMs: number | undefined;
    /** Output tokens of the round that just settled (usage.outputTokens). */
    lastRoundOutputTokens: number | undefined;
    /** Text blocks of the round that just settled — its verbatim body card. */
    lastRoundText: string;
    /** Epoch ms of the latest reasoning delta (the thinking phase marker). */
    thinkingSince: number | undefined;
    /** Raw reasoning buffer (capped) — tail source when think display is on. */
    reasoningBuffer: string;
    /** In-flight text deltas of the round's growing message (capped) — streaming tail. */
    textBuffer: string;
    /** Pending tool (between tool/call and tool/result). */
    currentTool: {
        name: string;
        startedAt: number;
        args?: string;
    } | undefined;
    toolsDone: number;
    toolsFailed: number;
    toolHistory: ToolSettledRow[];
    /**
     * How much of each tool call's raw arguments the card surfaces (the
     * config's `toolDetail`, fixed at bot construction — static config, never
     * mutated at runtime). `off` keeps the digest unset everywhere.
     */
    toolDetail: ToolDetail;
    /** Latest todo/write snapshot; cleared on turn/start (TUI semantics). */
    todo: readonly {
        content: string;
        status: string;
    }[] | undefined;
    /** Tracked subagent children keyed by child session id. */
    subagents: Map<string, SubagentRow>;
    /** `${runId}:${seq}` → childId pairing for tool-workflow/agent-end. */
    runSeqToChild: Map<string, string>;
    /** Latest llm/retry counters of the current turn. */
    retries: number;
    maxRetries: number | undefined;
    /** Last visible line of the latest assistant message (status snapshot). */
    lastAssistantLine: string | undefined;
    /** Provider route of the latest `request/header` (undefined until seen). */
    provider: string | undefined;
    /** Model id of the latest `request/header` (undefined until seen). */
    model: string | undefined;
    /** Reasoning effort of the latest `request/header` (undefined = unknown/off). */
    reasoningEffort: string | undefined;
    /** Context window in tokens from the latest `request/context`, when advertised. */
    contextWindow: number | undefined;
    /** Billed context tokens (input+cache+output) of the latest usage snapshot. */
    lastUsageTokens: number | undefined;
    /**
     * Characters streamed (text/reasoning deltas) since the latest usage
     * snapshot — a rough growth estimate, not a billed number.
     */
    pendingChars: number;
    /**
     * Cache-hit accounting, SESSION-cumulative (operator's chosen scope):
     * hit rate = ΣcacheRead / (Σinput + ΣcacheRead + ΣcacheWrite) — output
     * tokens never enter the denominator (cache hit is an input-side metric);
     * cacheWrite counts as this request's miss (the premise of future hits).
     * Route changes do NOT reset the totals — the rate describes the whole
     * session's input traffic.
     */
    cacheInputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    /** Session hit rate in percent (Σread / ΣbilledInput), undefined before any usage. */
    cacheHitRate: number | undefined;
}
/** Fresh state (no turn observed). */
export declare function initialRunState(toolDetail?: ToolDetail): RunState;
/**
 * Per-round reset (the bot calls it right after a round's card settled):
 * the next round's card starts with a fresh activity story — this round's
 * tools, reasoning tail and message line belong to the settled card only.
 * Turn-level state (todo, subagents, cache accounting, rounds) survives.
 */
export declare function beginRound(state: RunState): void;
/**
 * Fold an `agent/turn-stopping` notification: the loop reached its stop
 * boundary (a cancel/stop is being honored) but the turn/end settlement has
 * not landed. Marking the card "stopping" now keeps the phone from waiting
 * on the pre-stop phase. The field survives into the end-state card (the
 * turn/end reason takes over the header there); the next turn/start resets it.
 */
export declare function foldTurnStopping(state: RunState): RunState;
/**
 * Fold an `agent/request-error` notification: a model request failed and a
 * retry is (probably) scheduled. Record a one-line summary for the card's
 * activity section so the failure is visible immediately rather than only at
 * settlement. Cleared by the next turn/start or a landing assistant/message.
 */
export declare function foldRequestError(state: RunState, message: string | undefined): RunState;
/** Whether one tool/result reports failure (event-error or isError block). */
export declare function toolResultFailed(data: unknown): boolean;
/**
 * Fold one event of the BOUND session into the state. Mutates `state` in
 * place for O(1) cost; returns it for chaining.
 */
export declare function foldBoundEvent(state: RunState, event: SessionEvent): RunState;
/**
 * Fold one event of a CHILD (subagent) session into its compact row. The row
 * is created lazily when absent — child discovery may race its first event.
 */
export declare function foldChildEvent(state: RunState, childId: string, event: SessionEvent, label?: string): RunState;
/** Subagent rows in stable order (insertion order), running ones first. */
export declare function subagentRows(state: RunState): SubagentRow[];
/** Reasoning tail — last visible line of the capped reasoning buffer. */
export declare function reasoningTail(state: RunState): string | undefined;
/** Streaming text tail — last visible line of the round's in-flight message. */
export declare function streamingTextTail(state: RunState): string | undefined;
/** One live stream chunk as delivered by an `agent/assistant-stream` frame. */
export interface StreamChunkLike {
    readonly type?: string;
    readonly text?: string;
}
/**
 * Fold one streaming chunk of the BOUND session into the live card state:
 * the thinking marker, the in-flight text tail, and the pending-chars
 * context estimate.
 */
export declare function foldBoundStreamChunk(state: RunState, chunk: StreamChunkLike | undefined, time: number): void;
/**
 * Fold one streaming chunk of a CHILD session into its compact row (the
 * live tail line between settlements). The row is created lazily when
 * absent — frame discovery may race the child's first firehose event.
 */
export declare function foldChildStreamChunk(state: RunState, childId: string, chunk: StreamChunkLike | undefined): void;
/**
 * Live context-occupancy estimate in tokens: the latest billed usage
 * (input+cache+output) plus a rough ~3-chars-per-token estimate of what
 * streamed after it. Undefined before the first usage snapshot with no
 * streamed estimate either — footer omits the field then.
 */
export declare function contextTokensEstimate(state: RunState): number | undefined;
/**
 * Route facts derivable from the BOUND session's own append-only log. The
 * route events (`request/header`, `request/context`) are appended only on
 * session start or on a route CHANGE — a bot that binds mid-run never sees
 * them on the live firehose, so model / think level / context window (and
 * the cache-hit baseline) must be recovered from the log. Same pattern as
 * the child-name backfill and dsh-tui-pi's round reconcile.
 */
export interface RouteBackfill {
    readonly provider: string | undefined;
    readonly model: string | undefined;
    readonly reasoningEffort: string | undefined;
    readonly contextWindow: number | undefined;
    /** Billed context tokens of the LAST usage snapshot in the log (occupancy baseline). */
    readonly lastUsageTokens: number | undefined;
    /** Session-cumulative cache totals at the end of the log (authoritative so far). */
    readonly cacheInputTokens: number;
    readonly cacheReadTokens: number;
    readonly cacheWriteTokens: number;
    readonly cacheHitRate: number | undefined;
}
/**
 * Scan a bound session's log for the route facts. Pure and defensive —
 * malformed payloads degrade to no-ops, never throw.
 */
export declare function backfillRouteFromLog(events: readonly SessionEvent[]): RouteBackfill;
/**
 * Apply route backfill onto the run state. Route display fields only fill
 * holes (a live event is never overwritten); the cache totals are
 * ASSIGNED — the scan is authoritative for everything appended so far, and
 * live folds continue from its boundary without double counting.
 */
export declare function applyRouteBackfill(state: RunState, backfill: RouteBackfill): void;
/**
 * Facts derivable from a child session's own append-only log. A child
 * discovered mid-run (mid-turn attach) or after its events raced the parent's
 * `tool-workflow/agent-start` missed the naming events — the log is the
 * authoritative backfill source, the same pattern dsh-tui-pi uses for its
 * round-count reconcile.
 */
export interface ChildBackfill {
    /** Durable creation label from `subagent/descriptor` (the spawn agent name). */
    readonly label: string | undefined;
    /** assistant/message count in the log (the child's true round count). */
    readonly rounds: number;
    /** Last invoked tool name, when any. */
    readonly lastTool: string | undefined;
    /** Last visible output line of the last assistant message. */
    readonly tail: string | undefined;
}
/**
 * Scan a child session's log for the backfill facts. Pure and defensive —
 * malformed payloads degrade exactly like the live fold (no-op, no throw).
 */
export declare function backfillFromChildLog(events: readonly SessionEvent[]): ChildBackfill;
/**
 * Apply backfill facts onto an existing child row. Rounds only correct UP
 * (never un-count live-folded events); lastTool/tail only fill holes so a
 * fresher live value always wins; a real label always replaces the fallback
 * placeholder.
 */
export declare function applyChildBackfill(state: RunState, childId: string, backfill: ChildBackfill): void;
/**
 * Display label for a subagent row: real name + short-hash suffix when the
 * workflow/descriptor events carried one (`workhorse·49a6`, disambiguates
 * same-name instances), otherwise the raw hash prefix.
 */
export declare function subagentDisplayLabel(row: SubagentRow): string;
