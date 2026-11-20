/**
 * Turn-card builder: projects the pure {@link RunState} into a Feishu card
 * (JSON schema 2.0, native markdown element) plus a content hash the
 * publisher uses to skip no-op updates. One card per ROUND: opened when a
 * round starts (turn/start, or right after the previous round settled),
 * patched in place on the status beat (30s, hash-gated), settled to
 * "Round N · 💬 回复" when its assistant/message lands — a body that fits one
 * segment embeds into the settle card itself (`💬 Round 回复` section;
 * oversized bodies still ship as standalone body cards) — and the turn's
 * final card carries the end state (✅/❌/⛔ + total duration).
 *
 * Layout: the header carries the round number plus the live phase
 * (🤔 thinking / 🔧 tool / ⚙️ processing / ⏳ subagent / end icon); the body is
 * markdown sections — an activity list (thinking state, tool calls by name,
 * the latest LLM message), a subagent list (status + last output line), a
 * GFM task-list todo section whose first line carries the ☑ x/z progress,
 * and, on the settle card, the round's embedded reply as the LAST section.
 * The stats line (elapsed · model · think level · CH% · tool calls) closes
 * the markdown body after an `---` divider — schema V2 cards REJECT the
 * legacy `note` tag (server error 200861), so no note element may appear in
 * a 2.0 body. The think tail text appears only when the operator turns it on
 * (`/feishu-plugin think off` hides it; on by default).
 */
import type { RunState } from './run-state.ts';
import type { ResumeRow } from './resume-table.ts';
/**
 * Feishu card JSON schema 2.0 (sent as JSON string, msg_type stays
 * `interactive`): markdown elements in the body render headings, task lists,
 * fenced code blocks (with language highlighting) and GFM tables natively.
 * The header is optional — body cards ship without one (a reply should not
 * repeat the turn-card banner).
 */
export interface Schema2Card {
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
/** Any card shape the gateway can send. */
export type AnyCard = Schema2Card;
/** Card build inputs beyond the run state. */
export interface CardContext {
    /** Bound session label (cwd basename · short id). */
    sessionLabel: string;
    /** Whether the think tail line is shown (default off). */
    displayThink: boolean;
    /** Rendering clock (epoch ms) — elapsed timers derive from it. */
    now: number;
    /**
     * Present when settling a round card (its assistant/message just landed):
     * the header renders "Round N · 💬 回复 · <duration>" instead of the live
     * phase. The round count itself comes from the state (already incremented).
     */
    settledRoundMs?: number;
    /**
     * The settled round's full body, embedded into the settle card as a
     * `##### 💬 Round 回复` section placed LAST (right before the `---` stats
     * footer) — the reply grows into the card the eye is already on, instead
     * of arriving as a separate message wedged between status cards. The
     * caller decides fit (one segment or less); undefined/empty = no section,
     * and the activity list keeps its clipped `- 💬` preview line.
     */
    settledRoundText?: string;
    /**
     * Quick actions rendered as buttons under the body (taps arrive via
     * card.action.trigger → parseRoundCardAction). The running card carries the
     * stop gesture; the ended card offers a continue nudge. Absent = no buttons
     * (read-only views keep the card inert).
     */
    actions?: {
        readonly stop?: boolean;
        readonly continue?: boolean;
    };
    /**
     * Agent-preset id of the bound session — a session-level fact the run
     * state never observes, so it rides the context like sessionLabel.
     * undefined = unknown; the footer omits the field entirely.
     */
    preset?: string;
}
/** Emoji for a turn-end reason kind. */
export declare function turnEndIcon(reason: string | undefined): string;
/** Live phase of the turn, in header-priority order. */
export type TurnPhase = {
    readonly kind: 'ended';
    readonly reason: string | undefined;
} | {
    readonly kind: 'stopping';
} | {
    readonly kind: 'tool';
    readonly name: string;
    readonly since: number;
} | {
    readonly kind: 'thinking';
    readonly since: number;
} | {
    readonly kind: 'subagent';
    readonly live: number;
} | {
    readonly kind: 'processing';
};
/**
 * Classify the turn's current phase: a running tool beats thinking, thinking
 * beats waiting on subagents, everything else running is "processing". The
 * subagent phase means the main agent is between rounds while child sessions
 * still work (no live tool call, no reasoning deltas). A stop in flight
 * (agent/turn-stopping observed, settlement pending) beats every live phase.
 */
export declare function turnPhase(state: RunState): TurnPhase;
/**
 * Round number for the header: the round IN FLIGHT while running (completed
 * rounds + 1 — "Round 1 · 🤔 thinking" reads as the first round underway),
 * the total count once the turn ended.
 */
export declare function roundNumber(state: RunState): number;
/**
 * Header title line: `Round 3 · 🔧 bash · 8s` while running,
 * `Round 3 · ✅ 完成 · 3m12s` once ended.
 */
export declare function turnHeaderTitle(state: RunState, now: number, settledRoundMs?: number): string;
/**
 * Optional fields of the shared stats footer. Every field is independent —
 * unavailable data simply stays out of the line and its separator never
 * renders. `ctx` (context occupancy) and `CH` (prompt-cache hit rate) are
 * TWO separate indicators: occupancy = billed context tokens vs the model's
 * window; hit rate = cacheRead / (input + cacheRead + cacheWrite), output
 * excluded, route-segment cumulative (TUI footer semantics).
 */
export interface FooterFields {
    /** Elapsed time of the turn (ms). */
    elapsedMs?: number;
    /** Model id (`deepseek-v4`, provider prefix stripped here). */
    model?: string;
    /** Context occupancy in percent (needs a known window; 0–100). */
    contextPercent?: number;
    /** Fallback context size in tokens when no window is known. */
    contextTokens?: number;
    /** Prompt-cache hit rate in percent — only when the gateway reports caching. */
    cacheHitPercent?: number;
    /** Settled tool-call count of the current turn. */
    toolCalls?: number;
    /**
     * Reasoning-effort level as rendered (`high`, `medium`, `low`, or `off`;
     * undefined = unknown — field omitted entirely).
     */
    thinking?: string;
    /**
     * Agent-preset id of the bound session (`standard`, ...). Session-level
     * fact — the caller supplies it (run state never observes presets);
     * undefined = unknown and the field stays out.
     */
    preset?: string;
    /** First-token latency of the round that just settled (ms) — settled cards only. */
    firstTokenMs?: number;
    /** Output tokens of the round that just settled — settled cards only. */
    outputTokens?: number;
}
/** Short display name of a model id: last path segment (`org/deepseek-v4` → `deepseek-v4`). */
export declare function shortModelName(model: string): string;
/**
 * Assemble the stats-footer line, e.g.
 * `⏱ 12m34s · 🤖 deepseek-v4 · 🧠 high · 🧩 standard · 📊 ctx 43% · ⚡ CH 85.0% · 🔧 23 calls`.
 * The round lives in the card header, never here.
 * Fields with no value (or zero counters) are skipped; separators only join
 * fields that actually rendered. Returns '' when nothing is available.
 */
export declare function buildFooter(fields: FooterFields): string;
/**
 * Derive the footer fields from the run state + rendering clock. Percent
 * needs a known context window; without it the raw estimate stands in.
 * The thinking field only appears once a request/header was observed
 * (before that we cannot distinguish "off" from "unknown").
 */
export declare function footerFieldsOf(state: RunState, now: number): FooterFields;
/**
 * Build the whole per-turn card. The returned hash covers every rendered
 * string (header title, sections, footer) so the publisher can skip a patch
 * when nothing visible changed — while any change (round advance, phase move,
 * tail growth, todo tick) triggers the 30s-beat patch.
 */
export declare function buildStatusCard(state: RunState, context: CardContext): {
    card: Schema2Card;
    hash: string;
};
/** Marker written into every round-card action button's `value.action`. */
export declare const ROUND_ACTION = "dsh_feishu_round";
/** Which quick action a round-card button performs. */
export type RoundActionOp = 'stop' | 'continue';
/**
 * Recognize OUR round-card action in a `card.action.trigger` payload;
 * undefined for anything else. Value first, then the name-prefix fallback
 * (SDK versions may strip values from submits) — the same ladder every
 * interactive card here uses.
 */
export declare function parseRoundCardAction(data: unknown): RoundActionOp | undefined;
/**
 * Build a minimal schema 2.0 card carrying one assistant body segment
 * verbatim as a native markdown element — fenced code blocks (with language
 * highlighting) and GFM tables render as-is, so no legacy downgrade
 * conversion runs here. No header — a reply should not repeat the big
 * status-card banner.
 */
export declare function buildBodyCard(body: string): Schema2Card;
/**
 * The completion push card for a session the phone is not bound to (background
 * mode): header = cause + end state, body = the turn's last visible output
 * line. Deliberately compact — the full round-card pipeline only covers the
 * bound session; this card's job is "something finished over there, here is
 * the one-line gist".
 */
export declare function buildPushCard(input: {
    readonly cause: string;
    readonly reason: string | undefined;
    readonly sessionLabel: string;
    readonly lastAssistant: string | undefined;
    readonly durationMs: number | undefined;
}): Schema2Card;
/**
 * Build the `/resume` picker as a plain GFM ordered list shipped through the
 * same {@link buildBodyCard} channel as assistant bodies. This is the
 * send-time degradation path: it fires only when the table-card send fails on
 * our side — server rejection, rate-limit retries exhausted, or a transport
 * error. An old client that receives the table but renders it silently blank
 * fails AFTER delivery and is undetectable at send time; that scenario needs
 * `resumeListStyle: 'list'` to force this renderer outright. Numbering MUST
 * agree with `pickResumeRow`'s positional lookup (`rows[n - 1]`), so the same
 * 1-based contiguity contract as {@link buildSessionListCard} is enforced.
 */
export declare function buildSessionListAsMarkdown(rowsInput: readonly ResumeRow[], now?: number): Schema2Card;
/** Marker written into the resume picker submit button's `value.action`. */
export declare const RESUME_SUBMIT_ACTION = "dsh_feishu_resume";
/** One recognized card.action.trigger payload for our resume picker. */
export interface ParsedResumeAction {
    readonly pickerId: string;
    readonly index: number;
}
/**
 * Recognize OUR resume submit in a `card.action.trigger` payload; undefined
 * for anything else. Same fallback ladder as the ask card: button `value`
 * first, button `name` when an SDK strips values from form submits.
 */
export declare function parseResumeAction(data: unknown): ParsedResumeAction | undefined;
/**
 * Build the `/resume` session-picker card (schema 2.0): a native table element
 * (`tag: 'table'`, card JSON 2.0; Feishu client ≥7.20) with three narrow columns
 — `#` for the `/resume N` index, `会话` (`preview · dir`), `时间` — so the
 * list stays readable on a phone. The `时间` column shows each row's
 * last-update time: in mtime mode it IS the sort key (jsonl log mtime); in
 * fallback mode (no mtime map / map miss) it is an event-tail approximation
 * and may diverge from the row's actual sort key (`createdAt`). Rows arrive already truncated by
 * {@link buildResumeRows}; an empty list degrades to a plain markdown notice
 * instead of rendering an empty table.
 */
export declare function buildSessionListCard(rowsInput: readonly ResumeRow[], now?: number): Schema2Card;
/** Terminal card for the interactive resume picker: the chosen session (green). */
export declare function buildResumePickedCard(row: ResumeRow): Schema2Card;
/**
 * The `/resume` picker card (schema 2.0): the session table for browsing,
 * then a form — select one session and 🚪 submit (interactive path, needs
 * the console's card.action.trigger subscription), with the `/resume N`
 * text path spelled out right above it as the always-works fallback. Both
 * paths read the same pending picker.
 */
export declare function buildResumePickerCard(rowsInput: readonly ResumeRow[], pickerId: string, now?: number): Schema2Card;
