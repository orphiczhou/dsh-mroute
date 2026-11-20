/**
 * btw card builders — project the pure {@link BtwRunState} into Feishu
 * schema-2.0 cards (same JSON family as the round/ask/model cards). One live
 * card per btw run: opened when the run starts, patched on the 5s beat while
 * streaming (pseudo-streaming, hash-free — the answer tail grows almost
 * every beat), settled in place when the run finishes. Bare `/btw` review
 * re-ships the settled shape as a fresh card.
 *
 * Pure JSON in / JSON out — no Lark calls, unit-testable (test/btw-card.test.mjs).
 */
import type { BtwRunState } from './btw.ts';
/** Feishu card JSON schema 2.0 (mirrors card.ts's shape). */
export interface BtwSchema2Card {
    schema: '2.0';
    config: {
        width_mode: string;
    };
    header?: {
        title: {
            tag: 'plain_text';
            content: string;
        };
        subtitle?: {
            tag: 'plain_text';
            content: string;
        };
        template: 'blue' | 'green' | 'red' | 'grey' | 'orange';
    };
    body: {
        elements: Array<Record<string, unknown>>;
    };
}
/** Last answer chars that fit the card; the hidden prefix is named. */
export declare function btwAnswerTail(answer: string): string;
/**
 * The one card for every run state: header template carries the outcome
 * (streaming blue → done green / error red / canceled grey); the body is
 * question quote + answer tail (or status line) + the footer note.
 */
export declare function buildBtwCard(run: BtwRunState, queuedCount: number): BtwSchema2Card;
