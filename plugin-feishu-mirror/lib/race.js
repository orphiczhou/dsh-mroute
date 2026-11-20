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
/** Read an error's diagnostic code (`UserQuestionError.code` and friends). */
function errorCodeOf(error) {
    if (typeof error !== 'object' || error === null)
        return undefined;
    const code = error.code;
    return typeof code === 'string' ? code : undefined;
}
/**
 * Arbitrate `card` against `downstream`; first settle wins.
 * Rejections from a dead card path are swallowed while downstream is pending.
 */
export function raceSurfaces(card, downstream, options) {
    return new Promise((resolve, reject) => {
        let settled = false;
        let cardRejected = false;
        let downstreamRejected = false;
        let cardError;
        let downstreamError;
        const aborted = () => options.signal?.aborted === true;
        /** Finish once, with the winner's value or the chosen terminal error. */
        const finish = (complete) => {
            if (settled)
                return;
            settled = true;
            complete();
        };
        /** Both routes rejected — pick the terminal error per R-C. */
        const doubleReject = () => finish(() => {
            if (aborted()) {
                reject(cardError);
                return;
            }
            const code = errorCodeOf(cardError);
            if (code !== undefined && options.cardDeathCodes?.includes(code)) {
                // NO_CHAT / CARD_SEND_FAILED: the phone never delivered — surface the
                // downstream failure instead (B1).
                reject(downstreamError);
                return;
            }
            // Otherwise the card's diagnostic code is the strongest available.
            reject(cardError);
        });
        // Attach BOTH handlers synchronously (same tick) — this is what prevents
        // an unhandledRejection when one route rejects before the other settles.
        Promise.resolve(card).then(answer => finish(() => resolve(answer)), error => {
            if (settled)
                return;
            if (aborted()) {
                // Signal abort: downstream is also aborting, card is the surviving
                // path — its ASK_ABORTED must pass through, never be swallowed (R-C).
                finish(() => reject(error));
                return;
            }
            // Non-abort rejection (NO_CHAT / CARD_SEND_FAILED / dispose): the
            // card path is dead, keep waiting for downstream (R-D/E/F).
            cardRejected = true;
            cardError = error;
            if (downstreamRejected)
                doubleReject();
        });
        Promise.resolve(downstream).then(answer => finish(() => {
            options.onDownstreamWin(); // R-B: dismiss the card before returning
            resolve(answer);
        }), error => {
            if (settled)
                return;
            downstreamRejected = true;
            downstreamError = error;
            if (cardRejected)
                doubleReject();
        });
    });
}
//# sourceMappingURL=race.js.map