/**
 * btw bot wiring — the bridge between the pure controller (btw.ts) and the
 * Feishu card surface: command entry, card publish + 5s beat, settle/cancel
 * card lifecycle. All card ops ride the bot's serial chain (passed in
 * pre-wrapped, like SelectorManager's), so a btw patch never interleaves
 * with a round-card settle or a selector flow.
 *
 * Per-surface by design (docs/adr/0001-btw-duplicated-not-shared.md): this
 * manager's queue/slot/cancellation are independent of the TUI's overlay —
 * phone-side disruptions (/new, /resume, /stop) cancel phone-side calls via
 * Bot.cancelAll hooks, and nothing else touches them.
 */
import type { Message } from '@deepseek-ai/dsh-llm';
import { type BtwSelection, type BtwStreamFn } from './btw.ts';
import { type BtwSchema2Card } from './btw-card.ts';
export interface BtwManagerDeps {
    /** The side-call stream — ctx.get('llm').stream adapted to BtwCallOptions. */
    stream: BtwStreamFn;
    sendCard: (chatId: string, card: BtwSchema2Card) => Promise<string | undefined>;
    patchCard: (messageId: string, card: BtwSchema2Card) => Promise<boolean>;
    /** Reply channel for background outcomes (errors / drained-background runs). */
    notify: (text: string) => void;
    resolveSelection: () => BtwSelection | undefined;
    buildSnapshot: () => readonly Message[];
    isMainRunning: () => boolean;
    isReadOnlyView: () => boolean;
    hasCapturingSurface?: () => boolean;
    /** Card beat cadence — the same statusIntervalMs the round cards use. */
    beatMs: number;
    logger: {
        warn: (format: string, ...values: readonly unknown[]) => void;
    };
}
/**
 * Owns the phone-side btw lifecycle. One live card at a time; the 5s beat
 * patches it while streaming; the settle/cancel path patches once and stops
 * the beat. Bare `/btw` re-ships the live or last exchange as a fresh card.
 */
export declare class BtwManager {
    private readonly deps;
    private readonly controller;
    private cardMessageId;
    private beat;
    /** Most recent run handed to a card — the cancel path renders from it. */
    private cardRun;
    /** Whether the streaming card already shipped its first content patch. */
    private firstFrameShipped;
    private chatId;
    private disposed;
    constructor(deps: BtwManagerDeps);
    /** `/btw` entry: returns the reply text; cards go out on their own. */
    handleBtw(rawInput: string, chatId: string): Promise<string>;
    /** Phone-side disruption (/new, /resume, /stop): kill runs, settle the card. */
    cancelAll(): void;
    dispose(): void;
    private openCard;
    /**
     * Controller render callback: the FIRST text delta ships immediately (the
     * phone sees the answer start the moment the first token lands, not 5s
     * later); later deltas defer to the beat (throttled — no per-delta Lark
     * patch while the stream runs). A settle finalizes the card in place.
     */
    private onControllerRender;
    private finalizeCard;
    private settleLiveCardAsCanceled;
    private startBeat;
    private stopBeat;
    private patchCardIfLive;
}
