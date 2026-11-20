/**
 * /btw — by-the-way side questions, Feishu copy of dsh-tui-pi's engine
 * (CONTEXT.md: Btw, Side call, Btw overlay→here card, Last-btw slot, Queued
 * btw).
 *
 * DELIBERATE DUPLICATION (docs/adr/0001-btw-duplicated-not-shared.md): this
 * is a line-for-line port of dsh-tui-pi@1.1.0's src/btw.ts pure layer with
 * ZERO package dependency between the two plugins — the user chose copy
 * over a shared package. When you fix a bug here, check the TUI twin (and
 * the other way round); drift is the accepted trade-off.
 *
 * Semantics (identical to the TUI): while the bound main line is mid-turn,
 * `/btw <question>` fires ONE tool-less one-shot model call over a read-only
 * snapshot of the recent conversation and streams the answer into a Feishu
 * card. Nothing enters the session log, the inbox, or any main-line model
 * request. An idle main line refuses (a normal phone message is strictly
 * better there — tools, history, full context). Concurrency is per-surface:
 * the phone queue here is independent of the TUI's overlay queue. Session
 * disruptions on the phone (/new, /resume, /stop) cancel this side's calls.
 *
 * Split: pure decision layer here (unit-tested without a terminal or Lark —
 * test/btw.test.mjs); the card builders in btw-card.ts; the bot wiring
 * (card publish/beat/cancel hooks) in btw-bot.ts.
 */
import { type Message } from '@deepseek-ai/dsh-llm';
export declare const BTW_IDLE_NOTICE = "\u300C/btw\u300D\u53EA\u5728\u4E3B\u7EBF\u4EFB\u52A1\u8FD0\u884C\u4E2D\u53EF\u7528\u2014\u2014\u4E3B\u7EBF\u7A7A\u95F2\u65F6\u76F4\u63A5\u53D1\u6D88\u606F\u5C31\u597D\uFF08\u6709\u5DE5\u5177\u3001\u8FDB\u4F1A\u8BDD\u3001\u5168\u4E0A\u4E0B\u6587\uFF09\u3002";
export declare const BTW_USAGE: string;
export type ParsedBtwInput = {
    kind: 'empty';
} | {
    kind: 'ok';
    question: string;
    modelOverride?: string;
} | {
    kind: 'error';
    error: string;
};
/**
 * Parse the text after `/btw`. Everything is the question except one
 * optional `--model provider/model` override (extractable from anywhere in
 * the line). No input at all → `'empty'` (review / usage hint); a `--model`
 * flag without a question, or a value without a `/`, → `'error'`.
 */
export declare function parseBtwInput(rawInput: string | undefined): ParsedBtwInput;
/** Default recent-conversation messages carried into a side call. */
export declare const BTW_SNAPSHOT_DEFAULT_MESSAGES = 6;
/** Hard ceiling for the configurable snapshot size (config/env clamp). */
export declare const BTW_SNAPSHOT_MAX_MESSAGES = 50;
/** Per-message text cap — the snapshot is context, not a transcript replay. */
export declare const BTW_MAX_MESSAGE_CHARS = 4000;
/**
 * Resolve the snapshot size from the `DSH_FEISHU_BTW_CONTEXT_MESSAGES` env
 * (or the `btwContextMessages` config key, resolved to a string by the
 * caller): integer clamped to [0, BTW_SNAPSHOT_MAX_MESSAGES], anything else
 * (unset, non-numeric) falls back to the default. 0 disables the snapshot —
 * the side call then answers from the question alone.
 */
export declare function resolveSnapshotLimit(env: string | undefined): number;
/**
 * Project the last `limit` user/assistant text exchanges out of the derived
 * message history, oldest first. Tool results, developer and system messages
 * are not dialog turns and are dropped; the user side keeps REAL prompts only
 * (`source.kind === 'user'`) — `agent.inject()` synthetic context (file
 * notices, skill content, cron pings) rides the same role and must not crowd
 * the dialog window. Malformed content is skipped, never thrown.
 *
 * Input is `session.deriveMessages()` — the surface-driven history (dsh
 * 0.1.7), which replaces the soft-deprecated raw `snapshotEvents()` scan:
 * compaction-replaced turns correctly drop off, so the side call sees the
 * history the main agent actually holds.
 */
export declare function buildBtwSnapshot(messages: readonly Message[], limit: number): Message[];
/**
 * The side-call message list: the snapshot in order, then the question as a
 * plugin-sourced user message (it is not a real user turn of any session).
 * dsh 0.1.7 removed the shared catch-all `plugin` source kind — every
 * producer declares its OWN kind through the merge-extensible
 * `MessageSourceMap` (the same move `dsh-schedule`/`dsh-tool-jobs` make);
 * consumers that switch on `kind` fall through unknown values by contract.
 */
declare module '@deepseek-ai/dsh-llm' {
    interface MessageSourceMap {
        'dsh-feishu': {
            kind: 'dsh-feishu';
        };
    }
}
export declare function buildBtwMessages(snapshot: readonly Message[], question: string): Message[];
/** System prompt for the side call — no tools, snapshot is context only. */
export declare const BTW_SYSTEM_PROMPT: string;
/** Maximum queued btw requests while one is running. */
export declare const BTW_QUEUE_CAP = 5;
export interface BtwJob {
    readonly question: string;
    readonly modelOverride?: string;
}
export type BtwSubmitResult = {
    kind: 'started';
} | {
    kind: 'queued';
    position: number;
} | {
    kind: 'rejected';
    reason: string;
};
/**
 * Single-flight queue: one running btw, bounded FIFO behind it. The queue is
 * the concurrency truth — the card view state is derived from it.
 */
export declare class BtwQueue {
    private currentJob;
    private readonly waiting;
    get running(): boolean;
    get queuedCount(): number;
    submit(job: BtwJob): BtwSubmitResult;
    /** Settle the current job; returns the next job to launch, if any. */
    finishCurrent(): BtwJob | undefined;
    cancelAll(): {
        canceledRunning: boolean;
        canceledQueued: number;
    };
}
/**
 * Structural stream chunk — the subset of dsh-llm's StreamChunk a side call
 * consumes (text deltas for the live view, the finish chunk for the outcome).
 */
export interface BtwStreamChunk {
    readonly type: string;
    readonly text?: string;
    readonly reason?: {
        readonly kind: string;
        readonly failure?: {
            readonly message?: string;
        };
    };
}
export interface BtwCallOptions {
    provider: string;
    model: string;
    /** Plain string here — the branded ReasoningEffortId is restored at the
     * llm.stream boundary (feishu's selection refs carry plain strings). */
    reasoningEffort?: string;
    messages: Message[];
    system: string;
    signal?: AbortSignal;
}
export type BtwStreamFn = (options: BtwCallOptions) => AsyncIterable<BtwStreamChunk>;
export type BtwFinish = {
    kind: 'stop';
    answer: string;
} | {
    kind: 'aborted';
} | {
    kind: 'error';
    message: string;
};
/**
 * Drain one side-call stream: forward text deltas as they arrive, map the
 * finish chunk (or the stream's end / a throw) to a terminal outcome. A
 * stream that ends without a finish chunk is an error, never a silent
 * success; an aborted signal wins over whatever the iterator does next.
 */
export declare function consumeBtwStream(chunks: AsyncIterable<BtwStreamChunk>, onDelta: (text: string) => void, signal?: AbortSignal): Promise<BtwFinish>;
export type BtwRunStatus = 'streaming' | 'done' | 'error' | 'canceled';
/** View state of the running (or just-finished) side call; card-facing. */
export interface BtwRunState {
    readonly question: string;
    readonly modelLabel: string;
    status: BtwRunStatus;
    answerText: string;
    error?: string;
}
/** The Last-btw slot — the in-process record of the most recent exchange. */
export interface BtwLastExchange {
    readonly question: string;
    readonly answer: string;
    readonly modelLabel: string;
}
export type BtwNoticeKind = 'info' | 'error' | 'warning';
export interface BtwSelection {
    provider: string;
    model: string;
    reasoningEffort?: string;
}
export interface BtwControllerDeps {
    stream: BtwStreamFn;
    resolveSelection: () => BtwSelection | undefined;
    buildSnapshot: () => readonly Message[];
    requestRender: () => void;
    notify: (message: string, kind: BtwNoticeKind) => void;
    /** The bot opens (or re-sends) the card for a launched run. */
    onRunStarted: (run: BtwRunState) => void;
    /** cancelAll: the bot settles the live card (the run is gone either way). */
    onCardRequestedClose: () => void;
    /**
     * Whether the phone-side flow is currently mid-card-operation (a selector
     * or another modal flow). Queue-drained launches under one skip the new
     * card and run into the slot instead — bare /btw reopens the result.
     */
    hasCapturingSurface?: () => boolean;
}
/**
 * Owns the btw concurrency, the side-call execution and the Last-btw slot —
 * the same contract as the TUI controller, with card callbacks instead of
 * overlay callbacks.
 */
export declare class BtwController {
    private readonly deps;
    private readonly queue;
    private abortController;
    private run;
    private lastExchange;
    private cardOpen;
    constructor(deps: BtwControllerDeps);
    /** View state for the card: the live/just-settled run wins over the slot. */
    get currentRun(): BtwRunState | undefined;
    get last(): BtwLastExchange | undefined;
    get queuedCount(): number;
    /** The bot reports card lifecycle so error notices know where to land. */
    setCardOpen(open: boolean): void;
    submit(job: BtwJob): BtwSubmitResult;
    /**
     * Bare `/btw`: an active run reopens live on its card; otherwise the
     * Last-btw slot is shown; nothing at all → the caller shows the usage.
     */
    openReview(): 'live' | 'review' | 'empty';
    /**
     * Main-line disruption (/new, /resume, /stop): abort the running call,
     * drop the queue, settle the live card. The slot is untouched — a canceled
     * run never overwrites the last completed one.
     */
    cancelAll(): void;
    /** Bot teardown: same as cancelAll without the card ceremony. */
    dispose(): void;
    private launch;
    private execute;
    /** Settle the queue slot; a queued job (if any) launches immediately. */
    private drain;
}
