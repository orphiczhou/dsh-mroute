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
import type { SessionEvent } from './dsh-events.ts';
/** Push mode: off (default — silent-start invariant), cron/subagent events only, or every turn. */
export type BackgroundPushMode = 'off' | 'cron' | 'all';
/** Per-session scratch the fold mutates; one per tracked session. */
export interface PushTrack {
    /** A turn is (or was recently) in flight — set by turn/start and any user/message. */
    turnActive: boolean;
    /** Epoch ms the current turn started (duration display), from the event stream. */
    turnStartedAt: number | undefined;
    /** The turn contained a cron delivery. */
    cronSeen: boolean;
    /** The turn contained a subagent-settled notice. */
    subagentSettled: boolean;
    /** Last visible line of the turn's latest assistant message. */
    lastAssistant: string | undefined;
    /** turn/end reason kind, captured when the turn settles. */
    endReason: string | undefined;
}
/** Fresh scratch for one session. */
export declare function initialPushTrack(): PushTrack;
/** Why a completed turn would be pushed (cause order: specific beats generic). */
export type PushCause = 'cron' | 'subagent-settled' | 'turn';
/**
 * Fold one firehose event into the track. On `turn/end` it returns the cause
 * the push decision should consider (specific events beat a plain turn);
 * undefined for everything else. Mutates `track` in place, O(1) per event.
 */
export declare function foldPushEvent(track: PushTrack, event: SessionEvent): PushCause | undefined;
/** Whether `mode` pushes a completed turn with `cause`. */
export declare function shouldPush(mode: BackgroundPushMode, cause: PushCause): boolean;
/** Cause header for the push card title. */
export declare function pushCauseLabel(cause: PushCause): string;
