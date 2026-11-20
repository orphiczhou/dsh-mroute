/**
 * Run-state fold: the pure event→state machine behind the Feishu status
 * card. Mirrors dsh-tui-pi's activity phase machine in spirit (fixed live
 * panels, O(1) per event) but renders nothing — the card builder projects
 * this state, the publisher pushes it on a 30s beat.
 *
 * Four entry points:
 * - {@link foldBoundEvent}: firehose events of the BOUND session (turns,
 *   tools, todo, retries, workflow agent-start/end markers).
 * - {@link foldChildEvent}: firehose events of a discovered subagent child
 *   session (header-discovered by the bot; keeps per-child rounds + tail).
 * - {@link foldBoundStreamChunk} / {@link foldChildStreamChunk}: live
 *   streaming chunks of the bound session / its children, delivered as
 *   `agent/assistant-stream` frames (dsh 0.1.5-rc.1 moved the deltas off the
 *   firehose; settlements still arrive on `session/event`).
 *
 * All payload reads go through `unknown` shapes and never throw — a malformed
 * event degrades to a no-op, never a crashed bridge.
 */
import { clipLine, foldLine, lastNonBlankLine, textOfContent, truncateBody } from "./text.js";
/** Cap on remembered settled-tool rows (the card shows the last few). */
export const TOOL_HISTORY_CAP = 8;
/** Cap on the raw reasoning buffer (tail extraction only). */
const REASONING_CAP = 8192;
/** Cap on the in-flight text buffer (streaming tail display only). */
const TEXT_CAP = 8192;
/** Clips for the tool-detail digests (`tool/call`'s raw `arguments` JSON). */
const ARGS_BRIEF_CLIP = 80;
const ARGS_FULL_CLIP = 600;
/** Fresh state (no turn observed). */
export function initialRunState(toolDetail = 'off') {
    return {
        running: false,
        turnStartedAt: undefined,
        turnEndedAt: undefined,
        turnEndReason: undefined,
        stopping: false,
        lastError: undefined,
        rounds: 0,
        roundStartedAt: undefined,
        lastRoundDurationMs: undefined,
        lastRoundFirstTokenMs: undefined,
        lastRoundOutputTokens: undefined,
        lastRoundText: '',
        thinkingSince: undefined,
        reasoningBuffer: '',
        textBuffer: '',
        currentTool: undefined,
        toolsDone: 0,
        toolsFailed: 0,
        toolHistory: [],
        toolDetail,
        todo: undefined,
        subagents: new Map(),
        runSeqToChild: new Map(),
        retries: 0,
        maxRetries: undefined,
        lastAssistantLine: undefined,
        provider: undefined,
        model: undefined,
        reasoningEffort: undefined,
        contextWindow: undefined,
        lastUsageTokens: undefined,
        pendingChars: 0,
        cacheInputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        cacheHitRate: undefined,
    };
}
/**
 * Per-turn reset. The route/window fields (provider, model, reasoningEffort,
 * contextWindow) are turn-INDEPENDENT — they describe the session's current
 * request route and survive across turns; only per-turn counters clear.
 */
function beginTurn(state, time) {
    state.running = true;
    state.turnStartedAt = time;
    state.turnEndedAt = undefined;
    state.turnEndReason = undefined;
    state.stopping = false;
    state.lastError = undefined;
    state.rounds = 0;
    state.roundStartedAt = time;
    state.lastRoundDurationMs = undefined;
    state.lastRoundText = '';
    state.thinkingSince = undefined;
    state.reasoningBuffer = '';
    state.textBuffer = '';
    state.currentTool = undefined;
    state.toolsDone = 0;
    state.toolsFailed = 0;
    state.toolHistory = [];
    state.todo = undefined;
    state.subagents.clear();
    state.runSeqToChild.clear();
    state.retries = 0;
    state.maxRetries = undefined;
    state.lastAssistantLine = undefined;
    // The billed-context baseline SURVIVES turn boundaries — context only
    // grows between turns, and the backfilled baseline of a mid-run bind must
    // not be wiped by the next turn/start (TUI semantics: occupancy is
    // session-level, never turn-level).
    state.pendingChars = 0;
}
function endTurn(state, time, reason) {
    state.running = false;
    state.turnEndedAt = time;
    state.turnEndReason = reason;
    state.stopping = false;
    state.thinkingSince = undefined;
    state.currentTool = undefined;
}
/**
 * Per-round reset (the bot calls it right after a round's card settled):
 * the next round's card starts with a fresh activity story — this round's
 * tools, reasoning tail and message line belong to the settled card only.
 * Turn-level state (todo, subagents, cache accounting, rounds) survives.
 */
export function beginRound(state) {
    state.currentTool = undefined;
    state.thinkingSince = undefined;
    state.reasoningBuffer = '';
    state.textBuffer = '';
    state.toolHistory = [];
    state.lastAssistantLine = undefined;
    state.lastRoundText = '';
    state.lastRoundDurationMs = undefined;
    state.lastRoundFirstTokenMs = undefined;
    state.lastRoundOutputTokens = undefined;
}
/**
 * Fold an `agent/turn-stopping` notification: the loop reached its stop
 * boundary (a cancel/stop is being honored) but the turn/end settlement has
 * not landed. Marking the card "stopping" now keeps the phone from waiting
 * on the pre-stop phase. The field survives into the end-state card (the
 * turn/end reason takes over the header there); the next turn/start resets it.
 */
export function foldTurnStopping(state) {
    if (!state.running)
        return state;
    state.stopping = true;
    return state;
}
/**
 * Fold an `agent/request-error` notification: a model request failed and a
 * retry is (probably) scheduled. Record a one-line summary for the card's
 * activity section so the failure is visible immediately rather than only at
 * settlement. Cleared by the next turn/start or a landing assistant/message.
 */
export function foldRequestError(state, message) {
    state.lastError = message === undefined || message === '' ? undefined : message;
    return state;
}
/** Null-safe record read: any non-object (null included) reads as empty. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rec(data) {
    return (data !== null && typeof data === 'object' ? data : {});
}
/** Read `{chunk:{type,text}}` off a chunk event's data; undefined for other shapes. */
function chunkOf(data) {
    return rec(data).chunk;
}
/** Whether one tool/result reports failure (event-error or isError block). */
export function toolResultFailed(data) {
    if (rec(data).error !== undefined)
        return true;
    const block = rec(data).message?.content?.[0];
    return rec(block).isError === true;
}
/** Extract the text blocks of an assistant/message event into one string. */
function assistantTextOf(data) {
    const content = rec(data).message?.content;
    return textOfContent(content);
}
/**
 * Billed usage of an assistant/message usage snapshot, or undefined when the
 * event carries no usage (adapter reported none). Cache components default to
 * zero — gateways that do not report caching (e.g. zhipu GLM) simply never
 * grow them, and the CH footer field stays absent.
 */
function usageComponentsOf(data) {
    const usage = rec(data).usage;
    if (usage === undefined)
        return undefined;
    const input = typeof usage.inputTokens === 'number' ? usage.inputTokens : undefined;
    const output = typeof usage.outputTokens === 'number' ? usage.outputTokens : undefined;
    if (input === undefined || output === undefined)
        return undefined;
    return {
        inputTokens: input,
        outputTokens: output,
        cacheReadTokens: typeof usage.cacheReadTokens === 'number' ? usage.cacheReadTokens : 0,
        cacheWriteTokens: typeof usage.cacheWriteTokens === 'number' ? usage.cacheWriteTokens : 0,
    };
}
/** Route scalars off a `request/header` event (`data.header.config`). */
function headerConfigOf(data) {
    const config = rec(data).header?.config;
    if (config === undefined)
        return undefined;
    const out = {};
    if (typeof config.provider === 'string')
        out.provider = config.provider;
    if (typeof config.model === 'string')
        out.model = config.model;
    if (typeof config.reasoningEffort === 'string')
        out.reasoningEffort = config.reasoningEffort;
    return out;
}
/** Whether one fragment counts as a token-bearing delta (non-empty). */
function isTokenFragment(fragment) {
    return typeof fragment === 'string' && fragment !== '';
}
/**
 * Rebuild the stream's FIRST token time from compact AssistantStreamRecord
 * members — the same semantics as @deepseek-ai/dsh-llm's
 * `assistantStreamFirstTokenTime` (a name-bearing tool-call run starts at its
 * first member, otherwise the first non-empty fragment; member i of a packed
 * run sits at `time0 + Σ(dt[0..i-1])`; a raw chunk qualifies when it is a
 * token delta). Kept as a local structural read so this fold module stays
 * host-runtime-free and independently testable. Returns undefined when the
 * stream carries no token.
 */
function firstTokenTimeOf(stream) {
    if (!Array.isArray(stream))
        return undefined;
    for (const record of stream) {
        if (record === null || typeof record !== 'object')
            continue;
        if (record.type === 'chunk') {
            const chunk = rec(record.chunk);
            if (typeof record.time === 'number'
                && (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta')
                && isTokenFragment(chunk.text)) {
                return record.time;
            }
            continue;
        }
        if (record.type !== 'text-chunks' && record.type !== 'reasoning-chunks' && record.type !== 'tool-call-chunks')
            continue;
        const members = record.type === 'tool-call-chunks'
            ? (Array.isArray(record.args) ? record.args : undefined)
            : (Array.isArray(record.texts) ? record.texts : undefined);
        if (members === undefined || typeof record.time0 !== 'number' || !Array.isArray(record.dt))
            continue;
        // A name-bearing tool-call run starts at its first member.
        if (record.type === 'tool-call-chunks' && typeof record.name === 'string' && record.name !== '') {
            return record.time0;
        }
        let time = record.time0;
        for (let index = 0; index < members.length; index += 1) {
            if (index > 0)
                time += record.dt[index - 1] ?? 0;
            if (isTokenFragment(members[index]))
                return time;
        }
    }
    return undefined;
}
/** Output tokens of an assistant/message usage snapshot, when reported. */
function outputTokensOf(data) {
    return usageComponentsOf(data)?.outputTokens;
}
/**
 * Fold one event of the BOUND session into the state. Mutates `state` in
 * place for O(1) cost; returns it for chaining.
 */
export function foldBoundEvent(state, event) {
    switch (event.type) {
        case 'turn/start':
            beginTurn(state, event.time);
            break;
        case 'turn/end': {
            const reason = rec(event.data).reason?.kind;
            endTurn(state, event.time, reason ?? 'unknown');
            break;
        }
        case 'assistant/message': {
            const text = assistantTextOf(event.data);
            if (text !== '')
                state.lastAssistantLine = lastNonBlankLine(text);
            // A landed message proves the request round-tripped — clear any
            // intermediate request-error marker (dsh emits no retry-cleared event).
            state.lastError = undefined;
            // One message = one settled round: capture its duration and verbatim
            // text for the settled card + body, then the next round starts now.
            state.lastRoundText = text;
            state.textBuffer = ''; // the streamed text just landed in full
            state.lastRoundDurationMs = state.roundStartedAt === undefined
                ? 0
                : Math.max(0, event.time - state.roundStartedAt);
            // First-token latency + output tokens come from the embedded stream:
            // the TTFT is the stream's first token time minus the round's start
            // (the round start being the previous message's time or turn start).
            state.lastRoundFirstTokenMs = state.roundStartedAt === undefined
                ? undefined
                : (() => {
                    const firstToken = firstTokenTimeOf(event.data.stream);
                    return firstToken === undefined ? undefined : Math.max(0, firstToken - state.roundStartedAt);
                })();
            state.lastRoundOutputTokens = outputTokensOf(event.data);
            state.roundStartedAt = event.time;
            state.rounds += 1;
            // A landed message proves the request round-tripped — clear retry and
            // thinking markers (dsh emits no retry-cleared event).
            state.retries = 0;
            state.maxRetries = undefined;
            state.thinkingSince = undefined;
            // Usage snapshot finalizes the billed context; the streamed estimate
            // restarts from what follows this message. The same components feed the
            // route-segment cache-hit accounting (output stays out of it).
            const usage = usageComponentsOf(event.data);
            if (usage !== undefined) {
                state.lastUsageTokens = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens + usage.outputTokens;
                state.cacheInputTokens += usage.inputTokens;
                state.cacheReadTokens += usage.cacheReadTokens;
                state.cacheWriteTokens += usage.cacheWriteTokens;
                const billedInput = state.cacheInputTokens + state.cacheReadTokens + state.cacheWriteTokens;
                state.cacheHitRate = billedInput > 0 ? (state.cacheReadTokens / billedInput) * 100 : undefined;
            }
            state.pendingChars = 0;
            break;
        }
        case 'request/header': {
            const config = headerConfigOf(event.data);
            if (config === undefined)
                break;
            if (config.provider !== undefined)
                state.provider = config.provider;
            if (config.model !== undefined)
                state.model = config.model;
            // undefined means the field is ABSENT from the header — keep the last
            // known value; an explicit off is not representable here.
            if (config.reasoningEffort !== undefined)
                state.reasoningEffort = config.reasoningEffort;
            // No cache-accumulator reset on a route change: the CH rate is
            // session-cumulative by design (Σread / Σbilled-input over the whole
            // session's input traffic, whatever routes carried it).
            break;
        }
        case 'request/context': {
            const window = rec(event.data).contextWindow;
            if (typeof window === 'number' && Number.isFinite(window) && window > 0) {
                state.contextWindow = window;
            }
            break;
        }
        case 'tool/call': {
            const data = rec(event.data);
            const name = data.name;
            if (name !== undefined && name !== '') {
                // Digest the raw arguments JSON per the toolDetail mode. `off` keeps
                // the digest unset — the historical byte-for-byte rows. `brief` folds
                // the JSON to one clipped line; `full` keeps the multi-line shape at
                // a larger clip. The `arguments` field is the model's verbatim JSON
                // string (dsh-session's tool/call contract).
                const raw = typeof data.arguments === 'string' ? data.arguments : '';
                const digest = state.toolDetail === 'brief'
                    ? clipLine(foldLine(raw), ARGS_BRIEF_CLIP)
                    : state.toolDetail === 'full'
                        ? truncateBody(raw, ARGS_FULL_CLIP)
                        : undefined;
                state.currentTool = { name, startedAt: event.time, args: digest === '' ? undefined : digest };
                state.thinkingSince = undefined;
            }
            break;
        }
        case 'tool/result': {
            const pending = state.currentTool;
            if (pending !== undefined) {
                const ok = !toolResultFailed(event.data);
                const row = pending.args !== undefined
                    ? { name: pending.name, ok, durationMs: Math.max(0, event.time - pending.startedAt), detail: pending.args }
                    : { name: pending.name, ok, durationMs: Math.max(0, event.time - pending.startedAt) };
                if (ok)
                    state.toolsDone += 1;
                else
                    state.toolsFailed += 1;
                state.toolHistory.push(row);
                if (state.toolHistory.length > TOOL_HISTORY_CAP)
                    state.toolHistory.shift();
                state.currentTool = undefined;
            }
            break;
        }
        case 'todo/write': {
            const todos = rec(event.data).todos;
            if (Array.isArray(todos)) {
                state.todo = todos.map(item => ({
                    content: String(item.content ?? ''),
                    status: String(item.status ?? 'pending'),
                }));
            }
            break;
        }
        case 'llm/retry': {
            const retry = rec(event.data).retry;
            if (typeof retry === 'number')
                state.retries = retry;
            const maxRetries = rec(event.data).maxRetries;
            state.maxRetries = typeof maxRetries === 'number' ? maxRetries : undefined;
            break;
        }
        case 'tool-workflow/agent-start': {
            const data = rec(event.data);
            const childId = data.childId;
            // Only a real string label is kept; anything else falls back to the
            // hash-derived placeholder (a numeric label must not leak in).
            const label = typeof data.label === 'string' && data.label !== '' ? data.label : undefined;
            if (childId !== undefined && !state.subagents.has(childId)) {
                state.subagents.set(childId, {
                    childId,
                    label: label ?? `subagent ${childId.slice(0, 8)}`,
                    rounds: 0,
                    tail: undefined,
                    lastTool: undefined,
                    outcome: undefined,
                });
            }
            if (childId !== undefined) {
                const runId = rec(event.data).runId;
                const seq = rec(event.data).seq;
                if (typeof runId === 'string' && typeof seq === 'number') {
                    state.runSeqToChild.set(`${runId}:${seq}`, childId);
                }
                // The spawn label is authoritative — it must also reach a row that a
                // child event already created lazily (cross-session delivery order is
                // not guaranteed, so the child's first events can beat the parent's
                // agent-start append).
                if (label !== undefined) {
                    const row = state.subagents.get(childId);
                    if (row !== undefined)
                        row.label = label;
                }
            }
            break;
        }
        case 'tool-workflow/agent-end': {
            const outcome = rec(event.data).outcome;
            if (outcome === undefined)
                break;
            // Pair by runId:seq — never settle other running children (the TUI's
            // runSeqToChild pairing, one map instead of a global sweep).
            const runId = rec(event.data).runId;
            const seq = rec(event.data).seq;
            const childId = typeof runId === 'string' && typeof seq === 'number'
                ? state.runSeqToChild.get(`${runId}:${seq}`)
                : undefined;
            const row = childId === undefined ? undefined : state.subagents.get(childId);
            if (row !== undefined && row.outcome === undefined)
                row.outcome = outcome;
            break;
        }
        default:
            break;
    }
    return state;
}
/**
 * Fold one event of a CHILD (subagent) session into its compact row. The row
 * is created lazily when absent — child discovery may race its first event.
 */
export function foldChildEvent(state, childId, event, label) {
    let row = state.subagents.get(childId);
    if (row === undefined) {
        row = {
            childId,
            label: label ?? `subagent ${childId.slice(0, 8)}`,
            rounds: 0,
            tail: undefined,
            lastTool: undefined,
            outcome: undefined,
        };
        state.subagents.set(childId, row);
    }
    if (label !== undefined && row.label !== label)
        row.label = label;
    switch (event.type) {
        case 'subagent/descriptor': {
            // The child's own log refines the durable identity (the workflow
            // agent-start label is a fallback): last non-empty label wins.
            const descriptor = rec(event.data);
            if (typeof descriptor.label === 'string' && descriptor.label !== '')
                row.label = descriptor.label;
            break;
        }
        case 'assistant/message': {
            row.rounds += 1;
            const text = assistantTextOf(event.data);
            if (text !== '')
                row.tail = lastNonBlankLine(text);
            break;
        }
        case 'tool/call': {
            const name = rec(event.data).name;
            if (name !== undefined && name !== '')
                row.lastTool = name;
            break;
        }
        case 'turn/end': {
            if (row.outcome === undefined)
                row.outcome = 'completed';
            break;
        }
        default:
            break;
    }
    return state;
}
/** Subagent rows in stable order (insertion order), running ones first. */
export function subagentRows(state) {
    return [...state.subagents.values()].sort((a, b) => {
        const aLive = a.outcome === undefined ? 0 : 1;
        const bLive = b.outcome === undefined ? 0 : 1;
        return aLive - bLive;
    });
}
/** Reasoning tail — last visible line of the capped reasoning buffer. */
export function reasoningTail(state) {
    return state.reasoningBuffer === '' ? undefined : lastNonBlankLine(state.reasoningBuffer);
}
/** Streaming text tail — last visible line of the round's in-flight message. */
export function streamingTextTail(state) {
    return state.textBuffer === '' ? undefined : lastNonBlankLine(state.textBuffer);
}
/**
 * Fold one streaming chunk of the BOUND session into the live card state:
 * the thinking marker, the in-flight text tail, and the pending-chars
 * context estimate.
 */
export function foldBoundStreamChunk(state, chunk, time) {
    if (chunk?.type === 'reasoning-delta' && (chunk.text ?? '') !== '') {
        state.thinkingSince ??= time;
        let buffer = state.reasoningBuffer + (chunk.text ?? '');
        if (buffer.length > REASONING_CAP)
            buffer = buffer.slice(-Math.floor(REASONING_CAP / 2));
        state.reasoningBuffer = buffer;
    }
    if (chunk?.type === 'text-delta' && typeof chunk.text === 'string' && chunk.text !== '') {
        let buffer = state.textBuffer + chunk.text;
        if (buffer.length > TEXT_CAP)
            buffer = buffer.slice(-Math.floor(TEXT_CAP / 2));
        state.textBuffer = buffer;
    }
    if ((chunk?.type === 'text-delta' || chunk?.type === 'reasoning-delta')
        && typeof chunk.text === 'string' && chunk.text !== '') {
        state.pendingChars += chunk.text.length;
    }
}
/**
 * Fold one streaming chunk of a CHILD session into its compact row (the
 * live tail line between settlements). The row is created lazily when
 * absent — frame discovery may race the child's first firehose event.
 */
export function foldChildStreamChunk(state, childId, chunk) {
    let row = state.subagents.get(childId);
    if (row === undefined) {
        row = {
            childId,
            label: `subagent ${childId.slice(0, 8)}`,
            rounds: 0,
            tail: undefined,
            lastTool: undefined,
            outcome: undefined,
        };
        state.subagents.set(childId, row);
    }
    if ((chunk?.type === 'text-delta' || chunk?.type === 'reasoning-delta') && (chunk.text ?? '') !== '') {
        const line = lastNonBlankLine(chunk.text ?? '');
        if (line !== undefined)
            row.tail = line;
    }
}
/**
 * Live context-occupancy estimate in tokens: the latest billed usage
 * (input+cache+output) plus a rough ~3-chars-per-token estimate of what
 * streamed after it. Undefined before the first usage snapshot with no
 * streamed estimate either — footer omits the field then.
 */
export function contextTokensEstimate(state) {
    const pending = Math.ceil(state.pendingChars / 3);
    if (state.lastUsageTokens === undefined)
        return pending > 0 ? pending : undefined;
    return state.lastUsageTokens + pending;
}
/** Default fallback label pattern (`subagent <id8>`) — not a real name. */
const FALLBACK_LABEL_RE = /^subagent [0-9a-f]{8}$/;
/**
 * Scan a bound session's log for the route facts. Pure and defensive —
 * malformed payloads degrade to no-ops, never throw.
 */
export function backfillRouteFromLog(events) {
    let provider;
    let model;
    let reasoningEffort;
    let contextWindow;
    let lastUsageTokens;
    let cacheInput = 0;
    let cacheRead = 0;
    let cacheWrite = 0;
    let cacheHitRate;
    for (const event of events) {
        switch (event.type) {
            case 'request/header': {
                const config = headerConfigOf(event.data);
                if (config === undefined)
                    break;
                if (config.provider !== undefined)
                    provider = config.provider;
                if (config.model !== undefined)
                    model = config.model;
                if (config.reasoningEffort !== undefined)
                    reasoningEffort = config.reasoningEffort;
                break;
            }
            case 'request/context': {
                const window = rec(event.data).contextWindow;
                if (typeof window === 'number' && Number.isFinite(window) && window > 0)
                    contextWindow = window;
                break;
            }
            case 'assistant/message': {
                const usage = usageComponentsOf(event.data);
                if (usage === undefined)
                    break;
                lastUsageTokens = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens + usage.outputTokens;
                cacheInput += usage.inputTokens;
                cacheRead += usage.cacheReadTokens;
                cacheWrite += usage.cacheWriteTokens;
                const billedInput = cacheInput + cacheRead + cacheWrite;
                cacheHitRate = billedInput > 0 ? (cacheRead / billedInput) * 100 : undefined;
                break;
            }
            default:
                break;
        }
    }
    return { provider, model, reasoningEffort, contextWindow, lastUsageTokens, cacheInputTokens: cacheInput, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite, cacheHitRate };
}
/**
 * Apply route backfill onto the run state. Route display fields only fill
 * holes (a live event is never overwritten); the cache totals are
 * ASSIGNED — the scan is authoritative for everything appended so far, and
 * live folds continue from its boundary without double counting.
 */
export function applyRouteBackfill(state, backfill) {
    if (state.provider === undefined && backfill.provider !== undefined)
        state.provider = backfill.provider;
    if (state.model === undefined && backfill.model !== undefined)
        state.model = backfill.model;
    if (state.reasoningEffort === undefined && backfill.reasoningEffort !== undefined)
        state.reasoningEffort = backfill.reasoningEffort;
    if (state.contextWindow === undefined && backfill.contextWindow !== undefined)
        state.contextWindow = backfill.contextWindow;
    if (state.lastUsageTokens === undefined && backfill.lastUsageTokens !== undefined)
        state.lastUsageTokens = backfill.lastUsageTokens;
    state.cacheInputTokens = backfill.cacheInputTokens;
    state.cacheReadTokens = backfill.cacheReadTokens;
    state.cacheWriteTokens = backfill.cacheWriteTokens;
    state.cacheHitRate = backfill.cacheHitRate;
}
/**
 * Scan a child session's log for the backfill facts. Pure and defensive —
 * malformed payloads degrade exactly like the live fold (no-op, no throw).
 */
export function backfillFromChildLog(events) {
    let label;
    let rounds = 0;
    let lastTool;
    let tail;
    for (const event of events) {
        switch (event.type) {
            case 'subagent/descriptor': {
                const found = rec(event.data).label;
                if (typeof found === 'string' && found !== '')
                    label = found;
                break;
            }
            case 'assistant/message': {
                rounds += 1;
                const text = assistantTextOf(event.data);
                if (text !== '')
                    tail = lastNonBlankLine(text);
                break;
            }
            case 'tool/call': {
                const name = rec(event.data).name;
                if (typeof name === 'string' && name !== '')
                    lastTool = name;
                break;
            }
            default:
                break;
        }
    }
    return { label, rounds, lastTool, tail };
}
/**
 * Apply backfill facts onto an existing child row. Rounds only correct UP
 * (never un-count live-folded events); lastTool/tail only fill holes so a
 * fresher live value always wins; a real label always replaces the fallback
 * placeholder.
 */
export function applyChildBackfill(state, childId, backfill) {
    const row = state.subagents.get(childId);
    if (row === undefined)
        return;
    if (backfill.label !== undefined && !FALLBACK_LABEL_RE.test(backfill.label))
        row.label = backfill.label;
    if (backfill.rounds > row.rounds)
        row.rounds = backfill.rounds;
    if (row.lastTool === undefined)
        row.lastTool = backfill.lastTool;
    if (row.tail === undefined)
        row.tail = backfill.tail;
}
/**
 * Display label for a subagent row: real name + short-hash suffix when the
 * workflow/descriptor events carried one (`workhorse·49a6`, disambiguates
 * same-name instances), otherwise the raw hash prefix.
 */
export function subagentDisplayLabel(row) {
    const shortHash = row.childId.slice(0, 4);
    if (row.label !== '' && !FALLBACK_LABEL_RE.test(row.label)) {
        return `${row.label}·${shortHash}`;
    }
    // TODO(subagent-name): use_agent children whose deployment emits neither
    // tool-workflow/agent-start labels nor subagent/descriptor payloads have no
    // name in the event stream — fall back to the hash prefix until a naming
    // source exists.
    return row.childId.slice(0, 8);
}
//# sourceMappingURL=run-state.js.map