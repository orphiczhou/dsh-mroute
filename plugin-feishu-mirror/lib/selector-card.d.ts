/**
 * Generic selection card (selector FW): pure builders/parsers for one-shot
 * choice cards any adapter can present. Two modes:
 * - `select` — a select_static + submit button inside a form; the pick rides
 *   `form_value.pick` on submit;
 * - `buttons` — one immediate button per option (the pick rides the button
 *   `value`), plus a cancel button; no form container.
 *
 * Same card.action.trigger mechanics and hard-won constraints as the ask /
 * resume / model cards:
 * - every BUTTON must carry a `value` — the Feishu client rejects value-less
 *   interactive components with 200340 and never delivers the callback;
 * - the button `name` doubles as the flow-id carrier (some SDK versions
 *   strip `value` from submits);
 * - schema 2.0 cards must not contain `note` elements (server 200861) —
 *   footers ride a `---` line inside a markdown element.
 */
import type { Schema2Card } from './card.ts';
/** Marker written into every selector button's `value.action`. */
export declare const SELECTOR_ACTION = "dsh_feishu_sel";
/** One choice the selector offers. */
export interface SelectorOption {
    readonly value: string;
    readonly label: string;
    readonly description?: string;
}
/** `select` = dropdown + submit (default); `buttons` = one button per option. */
export type SelectorMode = 'select' | 'buttons';
/** What the caller wants to ask. */
export interface SelectorSpec {
    readonly title: string;
    readonly description?: string;
    readonly options: readonly SelectorOption[];
    readonly mode?: SelectorMode;
    readonly submitLabel?: string;
    /**
     * Cancellation lifetime (approval requests carry one): an abort settles the
     * flow as cancelled and patches the terminal card, exactly like a TTL
     * expiry — the awaiting caller sees `{ status: 'cancelled' }`.
     */
    readonly signal?: AbortSignal;
    /**
     * Ask for a second tap before honoring a cancel: a first tap on 取消 swaps
     * the card for a confirm card (确认取消 / 返回选择), and only the confirm tap
     * settles the flow as cancelled. For flows where a stray cancel is costly
     * (approval rejects) and the cancel button sits large on the phone.
     */
    readonly confirmCancel?: boolean;
}
/** Builder/parser flow reference: the manager's live flow, projected. */
export interface SelectorFlowRef {
    readonly id: string;
    readonly spec: SelectorSpec;
}
/** One recognized card.action.trigger payload for a selector button. */
export interface ParsedSelectorAction {
    readonly flowId: string;
    readonly pick?: string;
    readonly cancel?: boolean;
    /** Confirm-cancel button of a confirm card (settles the flow cancelled). */
    readonly confirm?: boolean;
    /** Back button of a confirm card (returns to the live choice card). */
    readonly back?: boolean;
}
/**
 * The interactive selector card (blue). Options past 50 are truncated (the
 * select_static server cap) rather than risking a rejected card.
 */
export declare function buildSelectorCard(flow: SelectorFlowRef): Schema2Card;
/** Terminal card: the operator picked an option (green). */
export declare function buildSelectorSettledCard(flow: SelectorFlowRef, picked: SelectorOption): Schema2Card;
/** Terminal card: cancelled (grey) — by the operator or a session rebind. */
export declare function buildSelectorCancelledCard(flow: SelectorFlowRef): Schema2Card;
/** Terminal card: the flow expired before any submit (grey). */
export declare function buildSelectorExpiredCard(flow: SelectorFlowRef): Schema2Card;
/**
 * Interim card: the operator tapped 取消 on a confirm-cancel flow. Two buttons
 * decide — 确认取消 settles the flow cancelled; 返回选择 swaps back to the
 * live choice card. The flow stays pending underneath (its TTL keeps running).
 */
export declare function buildSelectorConfirmCancelCard(flow: SelectorFlowRef): Schema2Card;
/**
 * Recognize OUR selector submit in a card.action.trigger payload; undefined
 * for anything else. Accepts three shapes defensively — the whole payload
 * (`{ action: {...} }`), the bare action object, or the bare button `value`
 * (whose `action` IS the marker string) — plus an optional explicit button
 * name override. Ladder, same as the other cards:
 * 1. button `value.action` === our marker → flow id (+ pick / cancel);
 * 2. a DIFFERENT string marker → undefined (foreign button — the name
 *    fallback must never fire on it);
 * 3. button `name` prefix fallback (SDK versions may strip values) — the
 *    pick still arrives via `form_value`; a stripped cancel button degrades
 *    to "no pick", which the manager settles as a cancel.
 */
export declare function parseSelectorAction(data: unknown, buttonName?: string): ParsedSelectorAction | undefined;
