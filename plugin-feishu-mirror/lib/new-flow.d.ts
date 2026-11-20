/**
 * NewSessionFlowManager: the SINGLE live /new config flow. `/new` presents
 * the config card; the flow settles exactly once — on submit, on cancel, or
 * at TTL expiry — patching the terminal card and resolving the awaiting
 * promise. A second `/new` while one is pending expires the old flow first
 * (the operator obviously restarted the intent). Card submits arrive via the
 * bot's parser chain; authorization is the caller's job (the same operator
 * allowlist gate as every other interactive surface).
 */
import { type NewSessionCardSpec, type NewSessionPicks } from './new-card.ts';
/** How a presented /new config flow ended. */
export type NewSessionOutcome = {
    status: 'submitted';
    picks: NewSessionPicks;
    readonly messageId: string;
} | {
    status: 'cancelled';
    readonly messageId: string;
} | {
    status: 'expired';
    readonly messageId: string;
};
/** Printf-style logger surface (cordis logger compatible; all optional). */
export interface NewFlowLogger {
    warn?(message: string, ...args: unknown[]): void;
}
/** Outbound surface the manager needs. */
export interface NewFlowDeps {
    /** Send one card to a chat; resolves the messageId, undefined on failure. */
    sendCard(chatId: string, card: unknown): Promise<string | undefined>;
    /** Patch a card in place; false on failure. */
    patchCard(messageId: string, card: unknown): Promise<boolean>;
    logger?: NewFlowLogger;
    /** Flow lifetime; default 10 minutes (same as the selector flows). */
    ttlMs?: number;
    /** Timer seam for tests; defaults to a real unref'd setTimeout. */
    sleep?: (ms: number) => Promise<void>;
}
export declare class NewSessionFlowManager {
    private readonly deps;
    private readonly ttlMs;
    private pending;
    private timer;
    constructor(deps: NewFlowDeps);
    /**
     * Send the config card and await the operator's outcome. Resolves undefined
     * only when the card could not be sent at all (no chat, send failure).
     */
    present(chatId: string, spec: NewSessionCardSpec): Promise<NewSessionOutcome | undefined>;
    /** Feed one parsed card action; a foreign/stale flow id is a no-op. */
    handleAction(parsed: {
        flowId: string;
        cancelled?: boolean;
        picks: NewSessionPicks;
    }): void;
    /** Expire the pending flow, if any — used by the TTL and by re-/new. */
    private expirePending;
    private settle;
    private patchTerminal;
    private armExpiry;
    private clearTimer;
}
