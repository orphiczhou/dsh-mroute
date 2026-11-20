/**
 * NewSessionFlowManager: the SINGLE live /new config flow. `/new` presents
 * the config card; the flow settles exactly once — on submit, on cancel, or
 * at TTL expiry — patching the terminal card and resolving the awaiting
 * promise. A second `/new` while one is pending expires the old flow first
 * (the operator obviously restarted the intent). Card submits arrive via the
 * bot's parser chain; authorization is the caller's job (the same operator
 * allowlist gate as every other interactive surface).
 */
import { randomUUID } from 'node:crypto';
import { buildNewSessionCancelledCard, buildNewSessionCard, buildNewSessionExpiredCard, } from "./new-card.js";
const DEFAULT_TTL_MS = 10 * 60 * 1000;
export class NewSessionFlowManager {
    deps;
    ttlMs;
    pending;
    timer;
    constructor(deps) {
        this.deps = deps;
        this.ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS;
    }
    /**
     * Send the config card and await the operator's outcome. Resolves undefined
     * only when the card could not be sent at all (no chat, send failure).
     */
    async present(chatId, spec) {
        await this.expirePending();
        const flowId = randomUUID();
        const messageId = await this.deps.sendCard(chatId, buildNewSessionCard(spec, flowId));
        if (messageId === undefined)
            return undefined;
        return await new Promise(resolve => {
            const settle = (outcome) => this.settle(flowId, outcome, resolve);
            this.pending = { flowId, messageId, state: 'pending', settle };
            this.armExpiry();
        });
    }
    /** Feed one parsed card action; a foreign/stale flow id is a no-op. */
    handleAction(parsed) {
        const flow = this.pending;
        if (flow === undefined || flow.flowId !== parsed.flowId || flow.state !== 'pending')
            return;
        if (parsed.cancelled === true) {
            flow.settle({ status: 'cancelled', messageId: flow.messageId });
            return;
        }
        flow.settle({ status: 'submitted', picks: parsed.picks, messageId: flow.messageId });
    }
    /** Expire the pending flow, if any — used by the TTL and by re-/new. */
    async expirePending() {
        const flow = this.pending;
        if (flow === undefined || flow.state !== 'pending')
            return;
        flow.settle({ status: 'expired', messageId: flow.messageId });
    }
    settle(flowId, outcome, resolve) {
        const flow = this.pending;
        if (flow === undefined || flow.flowId !== flowId || flow.state !== 'pending')
            return;
        flow.state = outcome.status === 'submitted' ? 'submitted' : outcome.status === 'cancelled' ? 'cancelled' : 'expired';
        this.clearTimer();
        this.pending = undefined;
        void this.patchTerminal(flow.messageId, outcome.status);
        resolve(outcome);
    }
    patchTerminal(messageId, status) {
        // submitted → the CALLER patches the real created card once the session
        // actually exists; here only the unsavory endings get their grey card.
        if (status === 'submitted')
            return;
        const card = status === 'cancelled' ? buildNewSessionCancelledCard() : buildNewSessionExpiredCard();
        void this.deps.patchCard(messageId, card).catch(() => undefined);
    }
    armExpiry() {
        this.clearTimer();
        const fire = () => {
            const flow = this.pending;
            if (flow === undefined || flow.state !== 'pending')
                return;
            this.deps.logger?.warn?.('dsh-feishu: /new config flow expired');
            flow.settle({ status: 'expired', messageId: flow.messageId });
        };
        if (this.deps.sleep !== undefined) {
            // Test seam: no real timer exists, nothing to clear later.
            void this.deps.sleep(this.ttlMs).then(fire);
            return;
        }
        const timer = setTimeout(fire, this.ttlMs);
        // Unref IMMEDIATELY — a ref'd 10-minute timer would pin the host process
        // (and every test runner) until it fires.
        typeof timer.unref === 'function' && timer.unref();
        this.timer = timer;
    }
    clearTimer() {
        this.timer !== undefined && clearTimeout(this.timer);
        this.timer = undefined;
    }
}
//# sourceMappingURL=new-flow.js.map