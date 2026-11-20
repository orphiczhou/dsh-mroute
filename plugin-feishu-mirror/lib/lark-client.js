/**
 * Lark/Feishu client wrapper — the plugin's ONLY outbound surface. One
 * WebSocket (official SDK WSClient, outbound connect, no public port) carries
 * inbound events; sends go through the SDK's REST client (tenant token).
 *
 * Hard constraints honored here (design §1):
 * - the receive handler must return within ~3s — it only enqueues (the
 *   callback handed to `start` is the bot's sync push);
 * - cluster mode does not broadcast — exactly one bot instance per app may
 *   connect (the single-instance lock in index.ts enforces the local side).
 *
 * Every send is best-effort: failures are reported to `onError` and degrade
 * to a skipped message/patch — a Feishu outage must never crash the dsh
 * process or the attached session. All im/v1 calls go through
 * {@link requestFeishu}, which normalizes fulfilled non-zero-code bodies into
 * {@link FeishuApiError} and retries rate limits with exponential backoff.
 */
import * as lark from '@larksuiteoapi/node-sdk';
/**
 * The dispatcher's notice for events without a registered handler (read
 * receipts, reaction events, …) — expected traffic, not worth a warn.
 */
const NO_HANDLER_RE = /^no \S+ handle[r]?$/i;
/**
 * Build an SDK `Logger` that routes every line into the plugin's log channel
 * instead of the SDK default (bare console writes that bypass the TUI
 * alt-screen renderer). Mapping: info/debug/trace → debug, warn → warn,
 * error → error; "no <event> handler" warnings downgrade to debug.
 */
export function bridgeSdkLogger(sink) {
    // The SDK's LoggerProxy forwards its collected arguments as ONE ARRAY, so
    // `warn(msg)` arrives here as `warn(['no x handler'])` — flatten that array
    // layer first or every string gets a JSON `["…"]` wrapper and pattern
    // matching against the plain text never fires.
    const flatten = (...msg) => msg.flat()
        .map(item => (typeof item === 'string' ? item : JSON.stringify(item)))
        .join(' ');
    return {
        error: (...msg) => { sink('error', flatten(...msg)); },
        warn: (...msg) => {
            const text = flatten(...msg);
            sink(NO_HANDLER_RE.test(text.trim()) ? 'debug' : 'warn', text);
        },
        info: (...msg) => { sink('debug', flatten(...msg)); },
        debug: (...msg) => { sink('debug', flatten(...msg)); },
        trace: () => { },
    };
}
// ----------------------------------------------------- im/v1 request wrapper --
/**
 * Feishu business error: HTTP 200 but the response body carries a non-zero
 * `code` (the SDK fulfills instead of throwing on those).
 */
export class FeishuApiError extends Error {
    feishuCode;
    msg;
    constructor(feishuCode, msg) {
        super(`feishu api error code=${feishuCode}${msg === '' ? '' : ` msg=${msg}`}`);
        this.name = 'FeishuApiError';
        this.feishuCode = feishuCode;
        this.msg = msg;
    }
}
/** Exponential-backoff retry budget for rate-limited sends. */
const MAX_RETRIES = 2;
const BASE_DELAY_MS = 500;
/** Feishu rate-limit business codes treated like HTTP 429. */
const RETRYABLE_FEISHU_CODES = new Set([230020, 11232]);
function envelopeOf(value) {
    return value !== null && typeof value === 'object' ? value : undefined;
}
/** Non-zero business code of an API result, when it is a number. */
function bodyCode(result) {
    const code = envelopeOf(result)?.code;
    return typeof code === 'number' ? code : undefined;
}
/** HTTP status attached to a thrown SDK/axios error, when present. */
function httpStatusOf(error) {
    if (error === null || typeof error !== 'object')
        return undefined;
    const status = error.response?.status;
    return typeof status === 'number' ? status : undefined;
}
/** Rate-limit classification: HTTP 429 or a known Feishu limit code. */
function isRateLimited(error) {
    if (httpStatusOf(error) === 429)
        return true;
    if (error instanceof FeishuApiError)
        return RETRYABLE_FEISHU_CODES.has(error.feishuCode);
    const data = envelopeOf(error.response?.data);
    const code = typeof data?.code === 'number' ? data.code : undefined;
    return code !== undefined && RETRYABLE_FEISHU_CODES.has(code);
}
/**
 * Unified wrapper around every im/v1 call: a fulfilled response whose body
 * carries `code !== 0` is rethrown as {@link FeishuApiError}, and rate-limit
 * failures (HTTP 429 or Feishu codes 230020/11232) are retried with
 * exponential backoff (500ms base, at most 2 retries). Everything else
 * propagates to the caller untouched.
 */
export async function requestFeishu(request, options = {}) {
    const sleep = options.sleep ?? ((ms) => new Promise(resolve => setTimeout(resolve, ms)));
    const baseDelayMs = options.baseDelayMs ?? BASE_DELAY_MS;
    const maxRetries = options.maxRetries ?? MAX_RETRIES;
    let delay = baseDelayMs;
    for (let attempt = 0;; attempt++) {
        try {
            const result = await request();
            // The SDK may fulfill with a rate-limit/error body instead of throwing —
            // normalize it into FeishuApiError so classification sees one shape.
            const code = bodyCode(result);
            if (code !== undefined && code !== 0) {
                const msg = envelopeOf(result)?.msg;
                throw new FeishuApiError(code, typeof msg === 'string' ? msg : '');
            }
            return result;
        }
        catch (error) {
            if (attempt >= maxRetries || !isRateLimited(error))
                throw error;
            await sleep(delay);
            delay *= 2;
        }
    }
}
/**
 * The SDK's WSClient silently DROPS frames whose header type is "card"
 * (card.action.trigger callbacks) — only "event" frames reach the
 * dispatcher (same defect as oapi-sdk-python #126; openclaw-lark patches
 * around it in production). Rewrite the header before the original
 * handler runs; the card payload is already the v2 event shape, so the
 * dispatcher routes it to the registered card.action.trigger handler.
 * Instance-level patch: absent on a future SDK that handles card frames
 * natively, it becomes a no-op.
 */
function patchCardFrames(ws, onLog) {
    const handle = ws;
    const orig = handle.handleEventData;
    if (typeof orig !== 'function')
        return;
    handle.handleEventData = (data) => {
        const headers = data?.headers;
        if (Array.isArray(headers)) {
            for (const header of headers) {
                if (header?.key === 'type' && header?.value === 'card') {
                    header.value = 'event';
                    onLog?.('debug', 'rewrote card frame header to event (card.action.trigger)');
                    break;
                }
            }
        }
        return orig.call(ws, data);
    };
}
function defaultWsFactory(options, onMessage, onError) {
    // Bridge the SDK logger so nothing writes to the console directly —
    // unregistered-event notices and transport warnings flow through onLog.
    const sdkLogger = bridgeSdkLogger(options.onLog ?? (() => { }));
    const dispatcher = new lark.EventDispatcher({ logger: sdkLogger }).register({
        'im.message.receive_v1': (data) => {
            // Enqueue-only: the bot's handler is synchronous and cheap; the 3s
            // window belongs to the SDK's ack, not to our processing.
            try {
                onMessage(data);
            }
            catch (error) {
                onError('event-handler', error);
            }
        },
    });
    if (options.onCardAction !== undefined) {
        dispatcher.register({
            'card.action.trigger': (data) => {
                try {
                    options.onCardAction(data);
                }
                catch (error) {
                    onError('card-action-handler', error);
                }
            },
        });
    }
    const ws = new lark.WSClient({
        appId: options.appId,
        appSecret: options.appSecret,
        domain: options.domain === 'lark' ? lark.Domain.Lark : lark.Domain.Feishu,
        loggerLevel: lark.LoggerLevel.warn,
        logger: sdkLogger,
        autoReconnect: true,
    });
    patchCardFrames(ws, options.onLog);
    return {
        start: () => ws.start({ eventDispatcher: dispatcher }),
        close: () => ws.close({ force: true }),
    };
}
/** Connected Lark client: WS receive + REST send. */
export class LarkClient {
    options;
    client;
    onError;
    sleep;
    wsFactory;
    ws;
    constructor(options) {
        this.options = options;
        this.onError = options.onError ?? (() => { });
        this.sleep = options.sleep;
        this.wsFactory = options.wsFactory ?? defaultWsFactory;
        this.client = new lark.Client({
            appId: options.appId,
            appSecret: options.appSecret,
            appType: lark.AppType.SelfBuild,
            domain: options.domain === 'lark' ? lark.Domain.Lark : lark.Domain.Feishu,
            loggerLevel: lark.LoggerLevel.warn,
            logger: bridgeSdkLogger(options.onLog ?? (() => { })),
        });
    }
    /** Open the event WebSocket; resolves once the connection attempt settles. */
    async start(onMessage) {
        const ws = this.wsFactory(this.options, onMessage, this.onError);
        this.ws = ws;
        await ws.start();
    }
    close() {
        try {
            this.ws?.close();
        }
        catch (error) {
            this.onError('ws-close', error);
        }
        this.ws = undefined;
    }
    async sendText(chatId, text) {
        try {
            const response = await requestFeishu(() => this.client.im.message.create({
                params: { receive_id_type: 'chat_id' },
                data: {
                    receive_id: chatId,
                    msg_type: 'text',
                    content: JSON.stringify({ text }),
                },
            }), { sleep: this.sleep });
            return response?.data?.message_id;
        }
        catch (error) {
            this.onError('send-text', error);
            return undefined;
        }
    }
    /**
     * Create a private group chat with the given open_ids (the bot is added
     * automatically as creator). Requires the `im:chat` tenant scope.
     */
    async createChatGroup(name, openIds) {
        try {
            const response = await requestFeishu(() => this.client.im.chat.create({
                params: { user_id_type: 'open_id' },
                data: {
                    name,
                    chat_mode: 'group',
                    chat_type: 'private',
                    user_id_list: openIds,
                },
            }), { sleep: this.sleep });
            return response?.data?.chat_id;
        }
        catch (error) {
            this.onError('create-chat-group', error);
            return undefined;
        }
    }
    /**
     * Rename a group the bot owns. Requires the `im:chat` tenant scope.
     */
    async updateChatName(chatId, name) {
        try {
            await requestFeishu(() => this.client.im.chat.update({
                path: { chat_id: chatId },
                data: { name },
            }), { sleep: this.sleep });
            return true;
        }
        catch (error) {
            this.onError('update-chat-name', error);
            return false;
        }
    }
    async sendCard(chatId, card) {
        try {
            const response = await requestFeishu(() => this.client.im.message.create({
                params: { receive_id_type: 'chat_id' },
                data: {
                    receive_id: chatId,
                    msg_type: 'interactive',
                    content: JSON.stringify(card),
                },
            }), { sleep: this.sleep });
            return response?.data?.message_id;
        }
        catch (error) {
            this.onError('send-card', error);
            return undefined;
        }
    }
    async patchCard(messageId, card) {
        try {
            await requestFeishu(() => this.client.im.message.patch({
                path: { message_id: messageId },
                data: { content: JSON.stringify(card) },
            }), { sleep: this.sleep });
            return true;
        }
        catch (error) {
            this.onError('patch-card', error);
            return false;
        }
    }
    async react(messageId, emojiType) {
        try {
            await requestFeishu(() => this.client.im.messageReaction.create({
                path: { message_id: messageId },
                data: { reaction_type: { emoji_type: emojiType } },
            }), { sleep: this.sleep });
        }
        catch {
            // Reactions are a low-noise extra channel; never report their failure.
        }
    }
    async downloadImage(messageId, imageKey) {
        try {
            const response = await requestFeishu(() => this.client.im.messageResource.get({
                params: { type: 'image' },
                path: { message_id: messageId, file_key: imageKey },
            }), { sleep: this.sleep });
            const stream = response?.getReadableStream?.();
            if (stream === undefined)
                return undefined;
            const chunks = [];
            for await (const chunk of stream) {
                chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            }
            return new Uint8Array(Buffer.concat(chunks));
        }
        catch (error) {
            this.onError('download-image', error);
            return undefined;
        }
    }
    async fetchBotOpenId() {
        try {
            const response = await requestFeishu(() => this.client.request({
                url: '/open-apis/bot/v3/info',
                method: 'GET',
            }), { sleep: this.sleep });
            const openId = response?.data?.open_id;
            return typeof openId === 'string' && openId !== '' ? openId : undefined;
        }
        catch (error) {
            this.onError('bot-info', error);
            return undefined;
        }
    }
}
/** Emoji keys used by the bot (Feishu reaction API emoji_type values). */
export const EMOJI_SEEN = 'EYES';
export const EMOJI_DONE = 'THUMBSUP';
//# sourceMappingURL=lark-client.js.map