/**
 * Background-push decision layer — pure fold over the session-event firehose
 * for sessions the phone is NOT bound to (bound sessions already have live
 * round cards; pushing them again would duplicate every turn).
 *
 * What it watches for (host event shapes verified in the dsh closure):
 * - cron deliveries land as `user/message` with
 *   `source = { kind: 'plugin', plugin: 'cron' }` (dsh-cron's framing);
 * - background-subagent settlements land as `user/message` with
 *   `source.kind === 'subagent-settled'` (dsh-subagent's continuation notices);
 * - plain turns are only interesting in `all` mode.
 *
 * The fold marks the flags DURING a turn and the caller decides on
 * `turn/end` — the completion moment — using the last assistant line as the
 * summary. All payload reads are defensive: malformed events are no-ops.
 */
import { lastNonBlankLine, textOfContent } from "./text.js";
/** Fresh scratch for one session. */
export function initialPushTrack() {
    return {
        turnActive: false,
        turnStartedAt: undefined,
        cronSeen: false,
        subagentSettled: false,
        lastAssistant: undefined,
        endReason: undefined,
    };
}
/** Object-or-empty record read (same defensive shape as run-state's `rec`). */
function rec(data) {
    return (data !== null && typeof data === 'object' ? data : {});
}
/**
 * Fold one firehose event into the track. On `turn/end` it returns the cause
 * the push decision should consider (specific events beat a plain turn);
 * undefined for everything else. Mutates `track` in place, O(1) per event.
 */
export function foldPushEvent(track, event) {
    switch (event.type) {
        case 'turn/start': {
            Object.assign(track, initialPushTrack());
            track.turnActive = true;
            track.turnStartedAt = typeof event.time === 'number' ? event.time : undefined;
            return undefined;
        }
        case 'user/message': {
            track.turnActive = true;
            const source = rec(rec(event.data).source);
            if (source.kind === 'plugin' && source.plugin === 'cron')
                track.cronSeen = true;
            if (source.kind === 'subagent-settled')
                track.subagentSettled = true;
            return undefined;
        }
        case 'assistant/message': {
            const text = textOfContent(rec(event.data).message?.content);
            if (text !== '')
                track.lastAssistant = lastNonBlankLine(text);
            return undefined;
        }
        case 'turn/end': {
            track.turnActive = false;
            track.endReason = typeof rec(event.data).reason?.kind === 'string' ? rec(event.data).reason.kind : undefined;
            if (track.cronSeen)
                return 'cron';
            if (track.subagentSettled)
                return 'subagent-settled';
            return 'turn';
        }
        default:
            return undefined;
    }
}
/** Whether `mode` pushes a completed turn with `cause`. */
export function shouldPush(mode, cause) {
    if (mode === 'off')
        return false;
    if (mode === 'cron')
        return cause !== 'turn';
    return true;
}
/** Cause header for the push card title. */
export function pushCauseLabel(cause) {
    switch (cause) {
        case 'cron': return '⏰ 定时任务';
        case 'subagent-settled': return '🧵 子代理完成';
        case 'turn': return '🖥️ 桌面回合完成';
    }
}
//# sourceMappingURL=push.js.map