/**
 * First-settler-wins arbiter for the phone ask/approval surfaces (design doc
 * §3.2/§3.3, B1/B2 revision).
 *
 * The host's client bridge claims `user-questions/request` /
 * `approval/request` for GUI-opened sessions at the head of the waterfall and
 * never calls next(). We prepend our own answerer and fork BOTH routes for a
 * bound session: our phone card (`card`) and the downstream chain (`next()`).
 * Whoever settles first wins; the loser is swallowed.
 *
 * Both handlers are attached in the same tick so a synchronously-rejecting
 * route never surfaces as an unhandled rejection (card has five settle exits:
 * answer / signal / dispose / NO_CHAT / CARD_SEND_FAILED).
 */
export interface RaceOptions {
    /**
     * Originating request signal. B2: `aborted === true` at settle time marks a
     * terminal abort (R-C); a non-aborted card rejection is "card path death"
     * (R-D/E/F) and must not fail the whole waterfall while downstream lives.
     */
    readonly signal?: AbortSignal;
    /**
     * Called synchronously when downstream wins (R-B), so the caller can
     * dismiss the card. The settle gate is already closed at that point, so a
     * reject caused by the dismissal is ignored.
     */
    readonly onDownstreamWin: () => void;
    /**
     * Card error codes that mean "the phone surface is unusable" rather than a
     * phone-side answer. In the both-rejected terminal these fall back to the
     * downstream error (R-C: NO_CHAT / CARD_SEND_FAILED).
     */
    readonly cardDeathCodes?: readonly string[];
}
/**
 * Arbitrate `card` against `downstream`; first settle wins.
 * Rejections from a dead card path are swallowed while downstream is pending.
 */
export declare function raceSurfaces<T>(card: Promise<T>, downstream: Promise<T>, options: RaceOptions): Promise<T>;
