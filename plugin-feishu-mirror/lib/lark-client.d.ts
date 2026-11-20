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
import type { AnyCard } from './card.ts';
/** Minimal outbound surface the bot depends on (mockable in tests). */
export interface LarkGateway {
    /** Open the event stream; `onMessage` is the sync enqueue-only callback. */
    start(onMessage: (data: unknown) => void): Promise<void>;
    close(): void;
    sendText(chatId: string, text: string): Promise<string | undefined>;
    /** Create a private group; returns its chat_id (undefined on failure). */
    createChatGroup(name: string, openIds: string[]): Promise<string | undefined>;
    /** Rename a group the bot owns; false on failure. */
    updateChatName(chatId: string, name: string): Promise<boolean>;
    sendCard(chatId: string, card: AnyCard): Promise<string | undefined>;
    patchCard(messageId: string, card: AnyCard): Promise<boolean>;
    react(messageId: string, emojiType: string): Promise<void>;
    /** Download one image resource; undefined on failure (best-effort). */
    downloadImage(messageId: string, imageKey: string): Promise<Uint8Array | undefined>;
    /** The bot's own open_id (mention routing); undefined when unresolvable. */
    fetchBotOpenId(): Promise<string | undefined>;
}
/** Best-effort error sink (`what` names the failed operation). */
export type LarkErrorSink = (what: string, error: unknown) => void;
/** Severity a bridged SDK log line is delivered at. */
export type BridgedLogLevel = 'debug' | 'warn' | 'error';
/** Sink that receives bridged SDK log lines (wired to the plugin's logger). */
export type LarkLogSink = (level: BridgedLogLevel, message: string) => void;
/**
 * Build an SDK `Logger` that routes every line into the plugin's log channel
 * instead of the SDK default (bare console writes that bypass the TUI
 * alt-screen renderer). Mapping: info/debug/trace → debug, warn → warn,
 * error → error; "no <event> handler" warnings downgrade to debug.
 */
export declare function bridgeSdkLogger(sink: LarkLogSink): lark.Logger;
/**
 * Feishu business error: HTTP 200 but the response body carries a non-zero
 * `code` (the SDK fulfills instead of throwing on those).
 */
export declare class FeishuApiError extends Error {
    readonly feishuCode: number;
    readonly msg: string;
    constructor(feishuCode: number, msg: string);
}
export interface RequestFeishuOptions {
    /** Injectable timer seam for tests (defaults to a real setTimeout sleep). */
    sleep?: (ms: number) => Promise<void>;
    /** Base backoff delay in ms; doubles per retry. */
    baseDelayMs?: number;
    /** Retry budget beyond the first attempt. */
    maxRetries?: number;
}
/**
 * Unified wrapper around every im/v1 call: a fulfilled response whose body
 * carries `code !== 0` is rethrown as {@link FeishuApiError}, and rate-limit
 * failures (HTTP 429 or Feishu codes 230020/11232) are retried with
 * exponential backoff (500ms base, at most 2 retries). Everything else
 * propagates to the caller untouched.
 */
export declare function requestFeishu<T>(request: () => Promise<T>, options?: RequestFeishuOptions): Promise<T>;
export interface LarkClientOptions {
    readonly appId: string;
    readonly appSecret: string;
    readonly domain: 'feishu' | 'lark';
    readonly onError?: LarkErrorSink;
    /** Receives every SDK log line, bridged into the plugin's log channel. */
    readonly onLog?: LarkLogSink;
    /**
     * Card interaction callbacks (`card.action.trigger` over the long
     * connection — requires the app to subscribe the event in the developer
     * console). Undefined disables the handler entirely.
     */
    readonly onCardAction?: (data: unknown) => void;
    /** Test seam: overrides the WS client factory. */
    readonly wsFactory?: (options: LarkClientOptions, onMessage: (data: unknown) => void, onError: LarkErrorSink) => LarkWsHandle;
    /** Test seam: overrides the retry backoff timer (see requestFeishu). */
    readonly sleep?: (ms: number) => Promise<void>;
}
/** The WSClient surface this wrapper needs (structural for testability). */
export interface LarkWsHandle {
    start(): Promise<void>;
    close(): void;
}
/** Connected Lark client: WS receive + REST send. */
export declare class LarkClient implements LarkGateway {
    private readonly options;
    private readonly client;
    private readonly onError;
    private readonly sleep;
    private readonly wsFactory;
    private ws;
    constructor(options: LarkClientOptions);
    /** Open the event WebSocket; resolves once the connection attempt settles. */
    start(onMessage: (data: unknown) => void): Promise<void>;
    close(): void;
    sendText(chatId: string, text: string): Promise<string | undefined>;
    /** Create a private group; returns its chat_id (undefined on failure). */
    createChatGroup(name: string, openIds: string[]): Promise<string | undefined>;
    /** Rename a group the bot owns; false on failure. */
    updateChatName(chatId: string, name: string): Promise<boolean>;
    sendCard(chatId: string, card: AnyCard): Promise<string | undefined>;
    patchCard(messageId: string, card: AnyCard): Promise<boolean>;
    react(messageId: string, emojiType: string): Promise<void>;
    downloadImage(messageId: string, imageKey: string): Promise<Uint8Array | undefined>;
    fetchBotOpenId(): Promise<string | undefined>;
}
/** Emoji keys used by the bot (Feishu reaction API emoji_type values). */
export declare const EMOJI_SEEN = "EYES";
export declare const EMOJI_DONE = "THUMBSUP";
