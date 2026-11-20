/**
 * SelectionFlowManager: multi-slot registry of one-shot selection cards.
 * A caller presents a spec; the manager sends the card and settles the flow
 * exactly once — on a pick, a cancel, or TTL expiry — patching the terminal
 * card and resolving the awaiting promise. Card submits arrive via the bot's
 * parser chain; authorization reuses the operator allowlist with the ask
 * branch's silent-ignore semantics (non-operators and stale/replayed cards
 * are no-ops, never errors).
 */
import { randomUUID } from 'node:crypto';
import { buildSelectorCancelledCard, buildSelectorCard, buildSelectorConfirmCancelCard, buildSelectorExpiredCard, buildSelectorSettledCard, } from "./selector-card.js";
/** Default flow lifetime: 10 minutes. */
const DEFAULT_TTL_MS = 10 * 60 * 1000;
export class SelectorManager {
    deps;
    flows = new Map();
    /** Race-only audit: flows ended by cancelAll(); consumed once by the caller. */
    cancelAllFlows = new Set();
    constructor(deps) {
        this.deps = deps;
    }
    /** Live pending-flow count (tests / debugging) — confirm-cancel included. */
    get pendingCount() {
        let count = 0;
        for (const flow of this.flows.values()) {
            if (flow.state === 'pending' || flow.state === 'awaiting-confirm')
                count += 1;
        }
        return count;
    }
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
    present(chatId, spec) {
        return this.start(chatId, spec).outcome;
    }
    /**
     * Race-only variant: the caller also gets a per-flow dismiss handle (R-B).
     * Dismissing settles the flow exactly like a cancel — grey card, timer
     * cleared, flow removed so a late card submit is ignored — and resolves the
     * awaiting outcome, which the race arbiter discards after downstream won.
     */
    presentWithDismiss(chatId, spec) {
        const { id, outcome } = this.start(chatId, spec);
        return {
            outcome,
            dismiss: () => this.dismiss(id),
            cancelledByManager: () => {
                const cancelled = this.cancelAllFlows.has(id);
                this.cancelAllFlows.delete(id);
                return cancelled;
            },
        };
    }
    /** Settle a still-live flow as dismissed (idempotent, like handleAction). */
    dismiss(id) {
        const flow = this.flows.get(id);
        if (flow === undefined)
            return;
        this.settle(flow, { status: 'cancelled' }, buildSelectorCancelledCard(flow));
    }
    start(chatId, spec) {
        const id = randomUUID();
        const outcome = new Promise((resolve, reject) => {
            const ttlMs = this.deps.ttlMs ?? DEFAULT_TTL_MS;
            const flow = {
                id,
                chatId,
                spec,
                messageId: undefined,
                state: 'pending',
                expiresAt: Date.now() + ttlMs,
                terminalCard: undefined,
                resolve,
                reject,
                timer: undefined,
            };
            this.flows.set(id, flow);
            this.armTimer(flow, ttlMs);
            if (flow.spec.signal !== undefined) {
                // The requesting side cancelled (turn aborted) — settle immediately;
                // a settle that raced the send is handled by sendFor's state guard.
                flow.spec.signal.addEventListener('abort', () => {
                    if (flow.state !== 'pending' || this.flows.get(flow.id) !== flow)
                        return;
                    this.settle(flow, { status: 'cancelled' }, buildSelectorCancelledCard(flow));
                }, { once: true });
            }
            void this.sendFor(flow);
        });
        return { id, outcome };
    }
    /**
     * Settle the flow a selector submit belongs to. Unknown / already-settled
     * flows (stale or replayed cards) and non-operators are ignored silently;
     * a pick that matches no option is treated as a cancel (warned). A confirm-
     * cancel flow defers a cancel tap to a confirm card first (see below).
     */
    handleAction(parsed, operatorOpenId) {
        const flow = this.flows.get(parsed.flowId);
        if (flow === undefined)
            return;
        if (!this.deps.allowlisted(operatorOpenId))
            return;
        // Confirm-cancel handshake: the interim card's buttons are only valid in
        // the awaiting-confirm state; the choice card's buttons only in pending.
        if (flow.state === 'awaiting-confirm') {
            if (parsed.confirm === true) {
                this.settle(flow, { status: 'cancelled' }, buildSelectorCancelledCard(flow));
            }
            else if (parsed.back === true) {
                this.restoreChoiceCard(flow);
            }
            return;
        }
        if (flow.state !== 'pending')
            return;
        if (parsed.cancel === true) {
            if (flow.spec.confirmCancel === true) {
                // First tap on 取消: swap to the confirm card, keep the flow pending
                // underneath (its TTL keeps running). The settle only happens on the
                // 确认取消 tap.
                this.enterConfirmCancel(flow);
            }
            else {
                this.settle(flow, { status: 'cancelled' }, buildSelectorCancelledCard(flow));
            }
            return;
        }
        const option = parsed.pick === undefined
            ? undefined
            : flow.spec.options.find(candidate => candidate.value === parsed.pick);
        if (option === undefined) {
            if (parsed.pick === undefined) {
                this.deps.logger.warn?.('dsh-feishu: selector flow %s submit carried no pick — settling as cancelled', flow.id);
            }
            else {
                this.deps.logger.warn?.('dsh-feishu: selector flow %s pick %s matched no option — settling as cancelled', flow.id, parsed.pick);
            }
            this.settle(flow, { status: 'cancelled' }, buildSelectorCancelledCard(flow));
            return;
        }
        this.settle(flow, { status: 'picked', value: option.value, label: option.label }, buildSelectorSettledCard(flow, option));
    }
    /** Cancel every pending flow (e.g. the session view was rebound). */
    cancelAll(reason) {
        for (const flow of [...this.flows.values()]) {
            if (flow.state === 'picked' || flow.state === 'cancelled' || flow.state === 'expired' || flow.state === 'failed')
                continue;
            if (reason !== undefined)
                this.deps.logger.info?.('dsh-feishu: selector flow %s cancelled: %s', flow.id, reason);
            this.cancelAllFlows.add(flow.id);
            this.settle(flow, { status: 'cancelled' }, buildSelectorCancelledCard(flow));
        }
    }
    /** Swap a pending flow's card for the confirm-cancel interim card. */
    enterConfirmCancel(flow) {
        flow.state = 'awaiting-confirm';
        this.patchChoiceCard(flow, buildSelectorConfirmCancelCard(flow));
    }
    /** Swap a confirm-cancel flow back to its live choice card. */
    restoreChoiceCard(flow) {
        flow.state = 'pending';
        this.patchChoiceCard(flow, buildSelectorCard(flow));
    }
    /** Best-effort patch of a non-terminal card (state stays live). */
    patchChoiceCard(flow, card) {
        if (flow.messageId === undefined)
            return;
        void this.patchTerminal(flow.messageId, card);
    }
    // ------------------------------------------------------------- internals --
    async sendFor(flow) {
        let messageId;
        try {
            messageId = await this.deps.sendCard(flow.chatId, buildSelectorCard(flow));
        }
        catch (error) {
            this.fail(flow, error);
            return;
        }
        if (flow.state !== 'pending') {
            // Settled while the send was in flight — dismiss the stray card so no
            // interactive control lingers (same cleanup the ask flow does).
            if (messageId !== undefined && flow.terminalCard !== undefined) {
                void this.patchTerminal(messageId, flow.terminalCard);
            }
            return;
        }
        if (messageId === undefined) {
            // sendCard swallows API errors into undefined — that is the only
            // send-time failure signal, and it must reject the awaiting caller.
            this.fail(flow, new Error('the selection card could not be delivered'));
            return;
        }
        flow.messageId = messageId;
    }
    armTimer(flow, ttlMs) {
        const fire = () => {
            // State + map membership double as the cancel check for injected-sleep
            // timers that have no clearable handle.
            if (flow.state !== 'pending' && flow.state !== 'awaiting-confirm')
                return;
            if (this.flows.get(flow.id) !== flow)
                return;
            this.settle(flow, { status: 'expired' }, buildSelectorExpiredCard(flow));
        };
        if (this.deps.sleep !== undefined) {
            void this.deps.sleep(ttlMs).then(fire, () => undefined);
            return;
        }
        const timer = setTimeout(fire, ttlMs);
        timer.unref?.(); // never hold the process open for a flow's TTL
        flow.timer = timer;
    }
    clearTimer(flow) {
        if (flow.timer !== undefined) {
            clearTimeout(flow.timer);
            flow.timer = undefined;
        }
    }
    /** Exactly-once settle: state guard → terminal patch → resolve. */
    settle(flow, outcome, card) {
        if (flow.state !== 'pending' && flow.state !== 'awaiting-confirm')
            return;
        flow.state = outcome.status;
        flow.terminalCard = card;
        this.clearTimer(flow);
        this.flows.delete(flow.id);
        if (flow.messageId !== undefined)
            void this.patchTerminal(flow.messageId, card);
        flow.resolve(outcome);
    }
    /** Remove an undeliverable flow and reject its awaiting caller. */
    fail(flow, error) {
        if (flow.state !== 'pending')
            return;
        flow.state = 'failed';
        this.clearTimer(flow);
        this.flows.delete(flow.id);
        flow.reject(error instanceof Error ? error : new Error(String(error)));
    }
    /** Best-effort terminal patch — failure is warned, never thrown. */
    async patchTerminal(messageId, card) {
        try {
            const ok = await this.deps.patchCard(messageId, card);
            if (!ok)
                this.deps.logger.warn?.('dsh-feishu: selector terminal patch failed (message %s)', messageId);
        }
        catch (error) {
            this.deps.logger.warn?.('dsh-feishu: selector terminal patch threw: %o', error);
        }
    }
}
//# sourceMappingURL=selector.js.map