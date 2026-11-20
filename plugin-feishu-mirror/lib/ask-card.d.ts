/**
 * Ask-user interactive card: pure builders/parsers for the Feishu side of
 * dsh's `ctx.userQuestions` protocol. One form card per ask request — every
 * control is value-less (no per-component callbacks, no loading flicker);
 * the single submit button carries the question id in BOTH `name` and
 * `value` and delivers all answers at once via `form_value`.
 *
 * Hard-won constraints baked in (see the research doc):
 * - the submit button MUST carry a `value` — the Feishu client rejects
 *   value-less interactive components with 200340 and never delivers the
 *   callback;
 * - `name` doubles as the fallback id carrier (some SDK versions strip
 *   `value` from form submits);
 * - schema V2 cards must not contain `note` elements (server 200861).
 */
import type { AskUserQuestionAnswerItem, AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions';
import type { Schema2Card } from './card.ts';
/** Marker written into the submit button's `value.action`. */
export declare const ASK_SUBMIT_ACTION = "dsh_feishu_ask_submit";
/** One recognized card.action.trigger payload for our submit button. */
export interface ParsedAskAction {
    readonly questionId: string;
    readonly formValue: Record<string, unknown>;
}
/**
 * Recognize OUR submit action in a `card.action.trigger` payload; undefined
 * for anything else (other buttons, foreign cards). Defensive — malformed
 * payloads degrade to undefined, never throw.
 */
export declare function parseAskAction(data: unknown): ParsedAskAction | undefined;
/** Outcome of parsing a submitted form against the asked questions. */
export type AskParseResult = {
    readonly kind: 'answers';
    readonly answers: AskUserQuestionAnswerItem[];
} | {
    readonly kind: 'missing';
    readonly missing: string[];
};
/**
 * Parse `form_value` into the dsh answer shape. Selects arrive as the option
 * label (single: string, multi: array); free-text inputs become `custom`
 * answers with an empty selection. A question with no usable value lands in
 * `missing` (headers preferred for the reminder list).
 */
export declare function parseAskFormValue(questions: readonly AskUserQuestionItem[], formValue: Record<string, unknown>): AskParseResult;
/**
 * The interactive ask card (blue, 待回答): one form container holding every
 * question's label + control and the single primary submit button.
 */
export declare function buildAskCard(questions: readonly AskUserQuestionItem[], questionId: string): Schema2Card;
/** Terminal card: answered (green) — every question with its chosen answer. */
export declare function buildAskAnsweredCard(questions: readonly AskUserQuestionItem[], answers: readonly AskUserQuestionAnswerItem[]): Schema2Card;
/** Why an ask card left the interactive state without an answer from here. */
export type AskDismissReason = 'elsewhere' | 'cancelled';
/** Terminal card: dismissed (grey) — answered on another surface or aborted. */
export declare function buildAskDismissedCard(questions: readonly AskUserQuestionItem[], reason: AskDismissReason, by: string): Schema2Card;
