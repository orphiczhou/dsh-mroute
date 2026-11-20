/**
 * Inbound Feishu event parsing — pure translation of the
 * `im.message.receive_v1` payload into the one shape the bot reasons about.
 * Kept dependency-free (structurally typed against the SDK's payload) so the
 * parsing table is unit-testable without a Lark connection.
 */
/** One @mention parsed off a group message (open_id only — the allowlist key). */
export interface InboundMention {
    /** The mentioned entity's open_id (the bot's own id included). */
    readonly openId: string;
}
/** A parsed inbound message. */
export interface InboundMessage {
    /** Sender open_id — the allowlist key. */
    readonly openId: string;
    /** Chat to reply into. */
    readonly chatId: string;
    /** `p2p` or `group`. */
    readonly chatType: string;
    /** The message the reply/reaction targets. */
    readonly messageId: string;
    /** Message type (`text`, `image`, …). */
    readonly messageType: string;
    /** Plain text body for `text` messages (mention placeholders stripped); undefined otherwise. */
    readonly text: string | undefined;
    /** `image_key` for `image` messages; undefined otherwise. */
    readonly imageKey: string | undefined;
    /** @mentions carried by the message (group traffic; empty in p2p). */
    readonly mentions: readonly InboundMention[];
}
/** Structural shape of one SDK mention entry. */
interface MentionEntry {
    key?: string;
    id?: {
        open_id?: string;
    } | string;
    name?: string;
}
/**
 * Structural shape of the SDK's `im.message.receive_v1` data — declared
 * locally so this module has no runtime dependency on the SDK types.
 */
export interface ReceiveV1Payload {
    sender?: {
        sender_id?: {
            open_id?: string;
        };
        sender_type?: string;
    };
    message?: {
        message_id?: string;
        chat_id?: string;
        chat_type?: string;
        message_type?: string;
        content?: string;
        mentions?: MentionEntry[];
    };
}
/**
 * Parse one receive event. Returns undefined when the payload is structurally
 * unusable (no sender/chat/message id) — the caller drops it silently.
 *
 * Group text carries the @bot placeholder inline (`@_user_1 任务…`); every
 * mention placeholder is stripped from the text so the remaining body is the
 * actual dispatch/command. Group messages also may carry NO text at all
 * (a bare @) — text degrades to '' and the caller ignores it.
 */
export declare function parseReceiveEvent(payload: unknown): InboundMessage | undefined;
export {};
