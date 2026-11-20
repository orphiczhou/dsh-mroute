/**
 * Pure text helpers shared by the renderer and the /resume table. No dsh or
 * Lark imports — everything here is unit-testable string arithmetic.
 */
/** Strip ANSI SGR escape sequences (the only escapes that reach assistant text). */
export declare function stripAnsi(text: string): string;
/** Collapse CRLF/CR onto LF and fold runs of whitespace to single spaces. */
export declare function foldLine(line: string): string;
/**
 * Last visible non-blank line of a text body (whitespace-folded), or undefined
 * when the body has no visible line. Used for reasoning tails and subagent
 * compact rows — the same "is it alive" signal dsh-tui-pi's editor shows.
 */
export declare function lastNonBlankLine(text: string): string | undefined;
/** Clip a one-line string to `max` characters, appending an ellipsis when cut. */
export declare function clipLine(text: string, max: number): string;
/**
 * Truncate a multi-line markdown body to ~`max` characters for a
 * phone-narrow progress card, keeping the text verbatim up to the cut
 * (formatting survives) and appending a visible omission notice when cut.
 * Returns at least the notice-free body when it already fits.
 */
export declare function truncateBody(text: string, max: number): string;
/**
 * Segment a long body for Feishu messages: split at the last newline before
 * the size cap so paragraphs survive — but never at a newline inside a fenced
 * code block (an unclosed ``` renders the rest of the card as garbage). When
 * no usable boundary exists (over-long fence content forces a hard cut), the
 * dangling fence is closed and REOPENED at the top of the next segment so
 * every segment is independently valid markdown with balanced fences when the
 * input itself is balanced (an unclosed fence at end-of-input stays open in
 * the final segment).
 * Returns at least one segment for non-empty input.
 *
 * Fence tracking is marker-aware (a fence only closes on a SAME-CHARACTER
 * run at least as long as its opener), so a literal ``` inside a `~~~`
 * fence does not count. Known limitation: nesting the same marker inside
 * itself is not supported — an inner ``` inside an outer ``` fence closes
 * it early, exactly like plain CommonMark.
 */
export declare function segmentText(text: string, max: number): string[];
/**
 * Append a closing fence line when `text` ends inside an open fence (``` or
 * ~~~, marker-aware — same tracking as {@link segmentText}), so whatever the
 * caller appends AFTER the text (a `---` stats footer, following card
 * sections) does not get swallowed into the code block: an unclosed ```
 * renders the rest of the card as garbage. Card-side rendering repair only —
 * a text that ships verbatim keeps the author's fences untouched. Returns
 * the text unchanged when its fences already balance.
 */
export declare function closeOpenFence(text: string): string;
/** Join the text blocks of a message content array into one trimmed string. */
export declare function textOfContent(content: unknown): string;
/** Format an elapsed duration in ms as a compact human string (`1m23s`, `45s`). */
export declare function formatDuration(ms: number): string;
/** Format an epoch-ms timestamp for the /resume table rows (local time, minute precision). */
export declare function formatWhen(epochMs: number, now?: number): string;
/**
 * Repair UTF-8-read-as-1252 mojibake in model output (`ðŸ˜Š` → `😊`).
 * Each candidate run is re-encoded to bytes and decoded as UTF-8; a run that
 * does not decode cleanly (legit `café`, a lone `é`, real European text)
 * fails the U+FFFD check and stays verbatim — ASCII and CJK sit outside the
 * run ranges entirely and are never touched.
 */
export declare function repairMojibake(text: string): string;
