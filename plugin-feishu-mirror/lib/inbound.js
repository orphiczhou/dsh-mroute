/**
 * Inbound Feishu event parsing — pure translation of the
 * `im.message.receive_v1` payload into the one shape the bot reasons about.
 * Kept dependency-free (structurally typed against the SDK's payload) so the
 * parsing table is unit-testable without a Lark connection.
 */
/** The open_id of one SDK mention entry; undefined for malformed entries. */
function mentionOpenIdOf(entry) {
    if (entry === null || typeof entry !== 'object')
        return undefined;
    const id = entry.id;
    if (typeof id === 'string')
        return id === '' ? undefined : id;
    const openId = id?.open_id;
    return typeof openId === 'string' && openId !== '' ? openId : undefined;
}
/** Placeholder text (@_user_N style) the sender's text carries per mention. */
function mentionKeyOf(entry) {
    if (entry === null || typeof entry !== 'object')
        return undefined;
    const key = entry.key;
    return typeof key === 'string' && key !== '' ? key : undefined;
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
export function parseReceiveEvent(payload) {
    if (payload === null || typeof payload !== 'object')
        return undefined;
    const data = payload;
    const openId = data.sender?.sender_id?.open_id;
    const message = data.message;
    const chatId = message?.chat_id;
    const messageId = message?.message_id;
    if (openId === undefined || openId === '' || chatId === undefined || chatId === '' || messageId === undefined || messageId === '') {
        return undefined;
    }
    const messageType = message?.message_type ?? '';
    const mentionEntries = message?.mentions ?? [];
    const mentions = [];
    for (const entry of mentionEntries) {
        const id = mentionOpenIdOf(entry);
        if (id !== undefined)
            mentions.push({ openId: id });
    }
    let text;
    let imageKey;
    if (messageType === 'text') {
        // Text message content is a JSON envelope: {"text":"..."} — degrade to
        // raw string when the envelope is not JSON (defensive; SDK sends JSON).
        const raw = message?.content ?? '';
        let parsedText = raw;
        try {
            const parsed = JSON.parse(raw);
            if (typeof parsed === 'object' && parsed !== null) {
                const value = parsed.text;
                parsedText = typeof value === 'string' ? value : raw;
            }
        }
        catch {
            // keep raw
        }
        // Strip every mention placeholder so group dispatches read naturally;
        // p2p text has no placeholders, so the pass is a no-op there.
        for (const entry of mentionEntries) {
            const key = mentionKeyOf(entry);
            if (key !== undefined)
                parsedText = parsedText.split(key).join(' ');
        }
        text = parsedText.trim();
    }
    else if (messageType === 'image') {
        // Image content is a JSON envelope: {"image_key":"..."}.
        try {
            const parsed = JSON.parse(message?.content ?? '');
            const key = parsed.image_key;
            if (typeof key === 'string' && key !== '')
                imageKey = key;
        }
        catch {
            // no usable key — the caller treats it as an unsupported message
        }
    }
    return {
        openId,
        chatId,
        chatType: message?.chat_type ?? '',
        messageId,
        messageType,
        text,
        imageKey,
        mentions,
    };
}
//# sourceMappingURL=inbound.js.map