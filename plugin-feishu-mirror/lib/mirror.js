/**
 * Session mirror — one private Feishu group per root DSH session.
 *
 * The upstream plugin binds ONE session at a time and drives it from the
 * management DM. This module adds a second, independent surface: when a root
 * session is created, the bot creates a private group containing the operator
 * and the bot, persists `sessionId <-> chatId`, and routes that group's text
 * into the session. Final assistant messages are mirrored back into the group.
 *
 * It deliberately does not touch the management DM / `/resume` flow. The
 * single Feishu WebSocket remains owned by FeishuBot (one bot per app), so the
 * mirror is a router on top of the same connection, never a second client.
 */
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import { SessionBinder } from './binder.js';
import { textOfContent, truncateBody } from './text.js';

const MAX_GROUP_NAME = 60;
const MAX_CARD_CHARS = 10000;

function sessionTitle(session) {
    const header = session?.header;
    const raw = typeof header?.title === 'string' && header.title.trim() !== ''
        ? header.title
        : typeof session?.title === 'string' && session.title.trim() !== ''
            ? session.title
            : `新会话 ${String(session?.id ?? '').replace(/^session-/, '').slice(0, 8)}`;
    return raw.trim();
}

function buildGroupName(prefix, title) {
    const full = `${prefix} - ${title}`;
    return full.length > MAX_GROUP_NAME ? `${full.slice(0, MAX_GROUP_NAME - 1)}…` : full;
}

function answerCard(title, text) {
    return {
        config: { wide_screen_mode: true },
        header: {
            template: 'blue',
            title: { tag: 'plain_text', content: title },
        },
        elements: [{
                tag: 'div',
                text: { tag: 'lark_md', content: truncateBody(text, MAX_CARD_CHARS) },
            }],
    };
}

function welcomeCard(groupName, sessionId) {
    return {
        config: { wide_screen_mode: true },
        header: {
            template: 'green',
            title: { tag: 'plain_text', content: groupName },
        },
        elements: [{
                tag: 'div',
                text: {
                    tag: 'lark_md',
                    content: `已绑定 DSH 会话 \`${sessionId.slice(0, 8)}\`。\n直接在本群发消息即可继续该会话；不需要 @ 机器人，也不需要 /resume。`,
                },
            }],
    };
}

export class SessionMirror {
    ctx;
    config;
    lark;
    store;
    allowlist;
    binders = new Map();
    pending = new Set();
    disposers = [];
    disposed = false;
    startedAt = 0;
    constructor(deps) {
        this.ctx = deps.ctx;
        this.config = deps.config;
        this.lark = deps.lark;
        this.store = deps.store;
        this.allowlist = deps.allowlist;
    }
    get logger() {
        return this.ctx?.logger;
    }
    operatorOpenId() {
        const state = this.store.get();
        const paired = Array.isArray(state.pairedOperators) ? state.pairedOperators : [];
        if (paired.length > 0)
            return paired[0];
        for (const id of this.allowlist) {
            if (typeof id === 'string' && id.trim() !== '')
                return id.trim();
        }
        return undefined;
    }
    async start() {
        if (this.config.mirrorMode !== 'group')
            return;
        await this.store.ready();
        this.startedAt = Date.now();
        const offCreated = this.ctx.on('session/created', (session) => {
            void this.onSessionCreated(session).catch((error) => {
                this.logger?.warn('dsh-feishu: mirror create failed: %o', error);
            });
        });
        const offEvent = this.ctx.on('session/event', (session, event) => {
            try {
                this.onSessionEvent(session, event);
            }
            catch (error) {
                this.logger?.warn('dsh-feishu: mirror event fold failed: %o', error);
            }
        });
        this.disposers.push(offCreated, offEvent);
        this.logger?.info('dsh-feishu: session mirror armed (%d existing binding(s))', Object.keys(this.store.get().sessionToChat ?? {}).length);
    }
    async dispose() {
        this.disposed = true;
        for (const off of this.disposers.splice(0))
            off();
        for (const binder of this.binders.values()) {
            try {
                await binder.detach();
            }
            catch { /* teardown is best-effort */ }
        }
        this.binders.clear();
    }
    /** Called from FeishuBot.process BEFORE the group @ gate. Returns true when consumed. */
    handleInbound(message) {
        const state = this.store.get();
        const binding = state.chatBindings?.[message.chatId];
        const sessionId = binding?.sessionId;
        if (typeof sessionId !== 'string' || sessionId === '')
            return false;
        if (message.messageType !== 'text' || typeof message.text !== 'string' || message.text.trim() === '') {
            void this.lark.sendText(message.chatId, '本群是 DSH 会话镜像，目前只支持文本消息。');
            return true;
        }
        if (binding !== undefined && /^(新会话|会话 )/.test(binding.title)) {
            const snippet = message.text.trim().replace(/\s+/g, ' ').slice(0, 24);
            const name = buildGroupName(this.config.mirrorGroupPrefix, snippet);
            void this.lark.updateChatName(message.chatId, name).then(async (ok) => {
                if (!ok)
                    return;
                const fresh = this.store.get();
                const current = fresh.chatBindings?.[message.chatId];
                if (current !== undefined) {
                    await this.store.update({
                        chatBindings: {
                            ...(fresh.chatBindings ?? {}),
                            [message.chatId]: { ...current, title: snippet },
                        },
                    });
                }
            }).catch(() => undefined);
        }
        void this.prompt(message.chatId, sessionId, message.text).catch(async (error) => {
            this.logger?.warn('dsh-feishu: mirror prompt failed: %o', error);
            await this.lark.sendText(message.chatId, `会话注入失败：${error instanceof Error ? error.message : String(error)}`);
        });
        return true;
    }
    async onSessionCreated(session) {
        if (this.disposed || this.config.mirrorMode !== 'group')
            return;
        const header = session?.header;
        if (header?.parentSession !== undefined)
            return; // subagent / delegation child — root sessions only
        if (header?.origin === 'subagent')
            return;
        if ((header?.delegationDepth ?? 0) !== 0)
            return;
        // Ignore sessions that already existed when this router started: they
        // are backfill, not new root sessions, and would create noisy groups.
        if (typeof header?.createdAt === 'number' && header.createdAt < this.startedAt)
            return;
        const sessionId = String(session.id);
        const state = this.store.get();
        if (typeof state.sessionToChat?.[sessionId] === 'string')
            return;
        if (this.pending.has(sessionId))
            return;
        const operator = this.operatorOpenId();
        if (operator === undefined) {
            this.logger?.warn('dsh-feishu: mirror skipped session %s — no operator open_id configured', sessionId);
            return;
        }
        this.pending.add(sessionId);
        try {
            const title = sessionTitle(session);
            const groupName = buildGroupName(this.config.mirrorGroupPrefix, title);
            const chatId = await this.lark.createChatGroup(groupName, [operator]);
            if (typeof chatId !== 'string' || chatId === '') {
                this.logger?.warn('dsh-feishu: mirror group create returned no chat_id for session %s', sessionId);
                return;
            }
            const fresh = this.store.get();
            await this.store.update({
                chatBindings: {
                    ...(fresh.chatBindings ?? {}),
                    [chatId]: { sessionId, title, createdAt: Date.now() },
                },
                sessionToChat: {
                    ...(fresh.sessionToChat ?? {}),
                    [sessionId]: chatId,
                },
            });
            await this.lark.sendCard(chatId, welcomeCard(groupName, sessionId));
            this.logger?.info('dsh-feishu: mirrored session %s → chat %s (%s)', sessionId, chatId, groupName);
        }
        finally {
            this.pending.delete(sessionId);
        }
    }
    binderFor(sessionId) {
        let binder = this.binders.get(sessionId);
        if (binder === undefined) {
            binder = new SessionBinder(this.ctx);
            this.binders.set(sessionId, binder);
        }
        return binder;
    }
    async prompt(chatId, sessionId, text) {
        const binder = this.binderFor(sessionId);
        const bound = await binder.bind(sessionId);
        const agent = bound.agent;
        if (agent === undefined || typeof agent.followup !== 'function')
            throw new Error(`会话 ${SessionId(sessionId)} 没有可用的 agent`);
        agent.followup(createUserMessage({
            content: [{ type: 'text', text }],
            source: { kind: 'user' },
        }));
    }
    onSessionEvent(session, event) {
        if (this.disposed || event?.type !== 'assistant/message')
            return;
        const sessionId = String(session.id);
        const chatId = this.store.get().sessionToChat?.[sessionId];
        if (typeof chatId !== 'string' || chatId === '')
            return;
        const text = textOfContent(event?.data?.message?.content);
        if (typeof text !== 'string' || text.trim() === '')
            return;
        const title = this.store.get().chatBindings?.[chatId]?.title ?? `会话 ${sessionId.slice(0, 8)}`;
        void this.lark.sendCard(chatId, answerCard(title, text)).catch(() => undefined);
    }
}
