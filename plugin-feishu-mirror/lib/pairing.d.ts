/**
 * Pairing mode (zero-config bootstrap) — pure decision + card builders.
 *
 * When the operator allowlist is completely empty (no `operators` config, no
 * `DSH_FEISHU_OPERATORS`, no persisted `pairedOperators`), the bot still arms
 * with valid credentials but answers NOBODY — except that the first person to
 * DM it gets a pairing confirmation card and may claim admin by tapping it.
 * The claim persists through the state store (`dsh-feishu.pairedOperators`)
 * and takes effect immediately (the bot re-reads the list per message).
 *
 * Groups never pair. Once ANY admin exists (config or paired), further DMs
 * from strangers are silently ignored again — the same close-world posture as
 * the pre-pairing allowlist gate.
 *
 * Everything here is a pure function so the truth table is unit-testable
 * without a Lark connection; {@link module:bot} owns the stateful flow
 * (card dedup per chat, callback handling, persistence).
 */
import type { Schema2Card } from './card.ts';
/** What one inbound message does under pairing mode. */
export type PairingDecision = {
    readonly kind: 'allow';
} | {
    readonly kind: 'offer-pairing';
} | {
    readonly kind: 'ignore';
};
/**
 * Decide what to do with one inbound message. The config and paired lists are
 * unioned (either grants access); pairing is offered only when the union is
 * EMPTY and the message is a direct (p2p) chat from an identified sender —
 * groups never pair, and an empty sender id has no one to pair.
 */
export declare function decidePairing(input: {
    chatType: string;
    senderOpenId: string;
    configOperators: readonly string[];
    pairedOperators: readonly string[];
}): PairingDecision;
/** Marker written into the pairing button's `value.dsh_feishu`. */
export declare const PAIR_ACTION_VALUE = "pair";
/** The pairing button's `name` — must be unique across the whole card
 *  (platform hard rule 230099); this card carries exactly one button. */
export declare const PAIR_BUTTON_NAME = "pair_confirm";
/** The pairing confirmation card: explains the situation and offers the
 *  one-tap admin claim. Re-sends patch THIS card in place (the bot keeps the
 *  chatId → messageId map), so a chat never accumulates pairing cards. */
export declare function buildPairingOfferCard(): Schema2Card;
/** Terminal state after a successful claim (green): the tapper is now an
 *  admin in this very process — no restart needed. */
export declare function buildPairingSuccessCard(): Schema2Card;
/** Terminal state when someone tapped a stale pairing card after an admin
 *  already exists (grey): the claim is refused, nothing changed. */
export declare function buildPairingRejectedCard(): Schema2Card;
/** The user-visible note sent right after a successful claim. */
export declare const PAIRING_PERSIST_NOTE = "\u914D\u7F6E\u5DF2\u6301\u4E45\u5316\uFF08dsh \u4E3B\u76EE\u5F55 dsh-feishu-state.json\uFF09\uFF0C\u7ACB\u5373\u751F\u6548\uFF0C\u65E0\u9700\u91CD\u542F\u3002";
/**
 * Recognize OUR pairing button in a `card.action.trigger` payload; undefined
 * for anything else. Same fallback ladder as every interactive card here:
 * button `value` first, button `name` when an SDK strips values from submits.
 */
export declare function parsePairingAction(data: unknown): true | undefined;
/** The card-action facts a pairing claim needs beyond the open_id. */
export interface PairingActionContext {
    /** Chat the tapped card lives in (the persistence note goes here). */
    readonly chatId: string | undefined;
    /** Message the tapped card IS (the terminal patch targets it). */
    readonly messageId: string | undefined;
}
/**
 * Extract the card message/chat ids from a `card.action.trigger` payload.
 * Current shape (observed from v2): ids are nested under `context`; top-level
 * variants kept as fallback for older/alternate surfaces — the same reading
 * the SDK payload documents.
 */
export declare function pairingActionContextOf(data: unknown): PairingActionContext;
