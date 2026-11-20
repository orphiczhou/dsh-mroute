/**
 * SelectionFlowManager: multi-slot registry of one-shot selection cards.
 * A caller presents a spec; the manager sends the card and settles the flow
 * exactly once — on a pick, a cancel, or TTL expiry — patching the terminal
 * card and resolving the awaiting promise. Card submits arrive via the bot's
 * parser chain; authorization reuses the operator allowlist with the ask
 * branch's silent-ignore semantics (non-operators and stale/replayed cards
 * are no-ops, never errors).
 */
import { type ParsedSelectorAction, type SelectorSpec } from './selector-card.ts';
/** How a presented selection ended. */
export type SelectorOutcome = {
    status: 'picked';
    value: string;
    label: string;
} | {
    status: 'cancelled';
} | {
    status: 'expired';
};
/** Printf-style logger surface (cordis logger compatible; all optional). */
export interface SelectorLogger {
    info?(message: string, ...args: unknown[]): void;
    warn?(message: string, ...args: unknown[]): void;
    error?(message: string, ...args: unknown[]): void;
}
/** Outbound + authorization surface the manager needs. */
export interface SelectorDeps {
    /** Send one card to a chat; resolves the messageId, undefined on failure. */
    sendCard(chatId: string, card: unknown): Promise<string | undefined>;
    /** Patch a card in place; false on failure. */
    patchCard(messageId: string, card: unknown): Promise<boolean>;
    /** Operator gate — same allowlist semantics as the ask branch. */
    allowlisted(openId: string | undefined): boolean;
    logger: SelectorLogger;
    /** Flow lifetime; default 10 minutes. */
    ttlMs?: number;
    /** Timer seam for tests; defaults to an unref'd real setTimeout. */
    sleep?: (ms: number) => Promise<void>;
}
export declare class SelectorManager {
    private readonly deps;
    private readonly flows;
    /** Race-only audit: flows ended by cancelAll(); consumed once by the caller. */
    private readonly cancelAllFlows;
    constructor(deps: SelectorDeps);
    /** Live pending-flow count (tests / debugging) — confirm-cancel included. */
    get pendingCount(): number;
    /**
     * Send a selector card and resolve with the operator's outcome. Rejects
     * only when the card cannot be delivered (the flow is removed then); a
     * pick, a cancel or the TTL expiry all resolve normally.
     *
     * INVARIANT: never call from inside the caller's own card-op chain (if it
     * serializes on the same sendCard/patchCard gateway) — sendCard enqueues a
     * new task there, so awaiting this promise from within that chain
     * dead-locks.
     */
    present(chatId: string, spec: SelectorSpec): Promise<SelectorOutcome>;
    /**
     * Race-only variant: the caller also gets a per-flow dismiss handle (R-B).
     * Dismissing settles the flow exactly like a cancel — grey card, timer
     * cleared, flow removed so a late card submit is ignored — and resolves the
     * awaiting outcome, which the race arbiter discards after downstream won.
     */
    presentWithDismiss(chatId: string, spec: SelectorSpec): {
        outcome: Promise<SelectorOutcome>;
        dismiss: () => void;
        /** True when cancelAll() (dispose/rebind) ended this flow — R-E card death. */
        cancelledByManager: () => boolean;
    };
    /** Settle a still-live flow as dismissed (idempotent, like handleAction). */
    dismiss(id: string): void;
    private start;
    /**
     * Settle the flow a selector submit belongs to. Unknown / already-settled
     * flows (stale or replayed cards) and non-operators are ignored silently;
     * a pick that matches no option is treated as a cancel (warned). A confirm-
     * cancel flow defers a cancel tap to a confirm card first (see below).
     */
    handleAction(parsed: ParsedSelectorAction, operatorOpenId: string | undefined): void;
    /** Cancel every pending flow (e.g. the session view was rebound). */
    cancelAll(reason?: string): void;
    /** Swap a pending flow's card for the confirm-cancel interim card. */
    private enterConfirmCancel;
    /** Swap a confirm-cancel flow back to its live choice card. */
    private restoreChoiceCard;
    /** Best-effort patch of a non-terminal card (state stays live). */
    private patchChoiceCard;
    private sendFor;
    private armTimer;
    private clearTimer;
    /** Exactly-once settle: state guard → terminal patch → resolve. */
    private settle;
    /** Remove an undeliverable flow and reject its awaiting caller. */
    private fail;
    /** Best-effort terminal patch — failure is warned, never thrown. */
    private patchTerminal;
}
