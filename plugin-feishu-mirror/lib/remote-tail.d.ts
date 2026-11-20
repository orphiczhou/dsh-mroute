/**
 * RemoteSessionTail — a READ-ONLY view over a session log that another
 * dsh PROCESS is driving. Firehose events do not cross the process
 * boundary, so a surface refusing to fork the log (single-writer guard)
 * can still satisfy "both ends eventually show the final reply" by
 * watching persisted bytes: poll-decode the whole jsonl.zstd (frames are
 * independent concatenations, so full decode is append-correct), and emit
 * only the durable suffix rows that appeared since the previous tick.
 *
 * Display contract (deliberately lossy): streaming deltas are skipped;
 * durable rows only — user/message, assistant/message (the FINAL LLM text),
 * tool/call + tool/result, plus turn/start|end so the viewer can
 * synthesize a working/idle indicator from the driver's lifecycle.
 * Latency is the poll interval; detail may be coarser than the driving
 * surface's live view — but every turn's final assistant message arrives.
 */
export interface RemoteTailEvent {
    type?: string;
    seq?: number;
}
export interface RemoteTailCallbacks {
    /** New durable events, in log-append order (possibly empty per tick). */
    onEvents(events: RemoteTailEvent[]): void;
    /** Decode failure tick — transient IO hiccups are non-fatal noise. */
    onError?(error: unknown): void;
}
export interface RemoteTailOptions {
    /** Poll cadence; defaults to 2s (cross-process latency is accepted). */
    intervalMs?: number;
    /** Decoder seam — tests substitute a pure function; default shells zstd. */
    decode?(file: string): Promise<string>;
}
export declare class RemoteSessionTail {
    private timer;
    private ticking;
    /** Rows already emitted — append-only watermark across ticks. */
    private seenRows;
    private readonly file;
    private readonly callbacks;
    private readonly options;
    constructor(file: string, callbacks: RemoteTailCallbacks, options?: RemoteTailOptions);
    start(): void;
    stop(): void;
    /** Force one poll immediately — the deterministic backfill entry point. */
    tickOnce(): Promise<void>;
    /** Where the watched log lives — tests assert on it. */
    getWatchedFile(): string;
    private tick;
}
