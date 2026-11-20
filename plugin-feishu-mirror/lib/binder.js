/**
 * Session binder — the "attach, never create" core (design §2 定稿).
 *
 * Binding an existing session has two arms:
 *  1. ATTACH: the session already has a live agent in this process (the TUI
 *     is driving it, or a previous bot resume is alive) — `ctx.agents.get()`
 *     hands back the SAME Agent reference; followups land in that agent's
 *     inbox. The bot does NOT own this agent and never disposes it.
 *  2. RESUME: not live — `ctx.agents.resume({ resumeSessionId })` loads the
 *     persisted session; the bot OWNS that handle.
 *
 * Owned handles are never DISPOSED on rebind/detach: in the multi-surface
 * world another surface may have adopted the live agent (the TUI attaching
 * to a bot-created session), and disposing would kill it mid-flight.
 * Created/resumed agents stay live in the registry until the process ends.
 *
 * `agents.create` is called from exactly one place — the operator's explicit
 * /new (never implicitly mid-flow), so the bot cannot mint surprise sessions.
 * Resuming an already-live session is equally forbidden (the registry would
 * race the live agent) — the attach arm covers that case.
 */
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { installModelSelection } from '@deepseek-ai/dsh-agent';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import { headerOf as headerOfEntry, sessionLogRoot } from "./resume-table.js";
import { RemoteSessionTail } from "./remote-tail.js";
import { projectKeyFor } from "./session-dir.js";
/**
 * The agent-owned model-selection surface (`Model`: `current()` / `select()`).
 * Every agent created through the registry's factory is the loop's concrete
 * agent and always carries it as `.model`, but the public `Agent` face is
 * just `{ id }` — so read the property structurally instead of importing the
 * loop's concrete class. Returns undefined when the surface is absent (e.g. a
 * future host that moves it again) — callers degrade to the phone-default
 * branch instead of crashing.
 */
function modelSurfaceOf(agent) {
    const candidate = agent.model;
    if (typeof candidate !== 'object' || candidate === null)
        return undefined;
    const surface = candidate;
    return typeof surface.current === 'function' && typeof surface.select === 'function' ? candidate : undefined;
}
/**
 * One-bound-session-at-a-time binder. Concurrent binds serialize on the
 * in-flight task so `/resume 3` racing `/resume 5` cannot leak handles.
 */
export class SessionBinder {
    agents;
    /** Handle we own (from our own resume); disposed on rebind/detach. */
    owned;
    /** Session id of the current binding (live or ours). */
    sessionId;
    binding;
    /** Kept for the persistence seam that resolves header metadata. */
    ctx;
    /** Decoder/interval seam for the read-only remote view (tests inject). */
    viewerOptions;
    hook;
    /** Registered by the host bot AFTER construction (needs its private UI). */
    setOnPromotable(hook) {
        this.hook = hook;
    }
    /** Active read-only view (another process drives the session). */
    remoteTail;
    /** Id of the session watched right now. */
    remoteWatchId;
    /** onEvents of the active watch — a failed promote re-watches with it
     * (a no-op callback would leave the phone painting nothing). */
    remoteOnEvents;
    /** Follow-ups typed while watching — sent once promotion wins the lock. */
    outbox = [];
    promotingRemote = false;
    promoteTimer;
    constructor(ctx, options = {}) {
        this.ctx = ctx;
        this.viewerOptions = { promoteIntervalMs: 1000, ...(options.viewerOptions ?? {}) };
        this.hook = options.onPromotable;
        // ctx.agents is injected (plugin `inject`); the structural cast keeps
        // this module free of the full registry type.
        this.agents = ctx.agents;
    }
    /** While a remote watch is active the phone queues instead of driving. */
    isReadOnlyView() {
        return this.remoteTail !== undefined;
    }
    queueRemoteFollowup(text) {
        this.outbox.push(text);
        // The watch may predate the first queued message (the poll only starts
        // at watch time when the outbox is already non-empty) — arm it now so
        // the takeover actually gets probed.
        if (this.remoteWatchId !== undefined)
            this.startPromotePoll(this.remoteWatchId);
    }
    takeOutbox() {
        return this.outbox.splice(0);
    }
    hasOutbox() {
        return this.outbox.length > 0;
    }
    outboxSize() {
        return this.outbox.length;
    }
    opChain = Promise.resolve();
    runExclusive(op) {
        const next = this.opChain.then(op, op);
        this.opChain = next.then(() => undefined, () => undefined);
        return next;
    }
    startPromotePoll(watchId) {
        if (this.promoteTimer !== undefined)
            return;
        this.promoteTimer = setInterval(() => void this.runExclusive(async () => {
            await this.maybePromoteRemoteInner(watchId);
        }), this.viewerOptions.promoteIntervalMs ?? 1000);
    }
    stopPromotePoll() {
        if (this.promoteTimer === undefined)
            return;
        clearInterval(this.promoteTimer);
        this.promoteTimer = undefined;
    }
    /** Queue non-empty + bind winnable ⇒ take over via registered hook. */
    async maybePromoteRemoteInner(watchId) {
        if (this.promotingRemote || !this.hasOutbox())
            return;
        const hook = this.hook;
        if (hook === undefined)
            return;
        // Saved BEFORE stopWatchRemote: the failure path re-watches with the
        // SAME view callback — a no-op would leave the phone painting nothing.
        const onEvents0 = this.remoteOnEvents;
        this.promotingRemote = true;
        try {
            // Stop spectating FIRST so bot-side folds during binding stay sane.
            // The bind itself is the takeover probe: a host-side owner still
            // driving the session makes it throw SessionAlreadyOwnedError and we
            // fall back to the watch below, retrying on a later poll.
            await this.stopWatchRemote();
            await this.bind(watchId);
        }
        catch {
            this.promotingRemote = false;
            try {
                await this.watchRemoteInner(watchId, onEvents0 ?? (() => { }));
            }
            catch { /* log gone */ }
            return;
        }
        this.promotingRemote = false;
        // Takeover WON: the bind holds the host lease. Finalize through the
        // registered bot hook (store binding, reset run view, drain the outbox
        // into the fresh agent, settle the cards + takeover announce).
        // Best-effort — a failed Lark reply must NOT re-enter the watch (the
        // lease is already ours; re-watching would fight our own binding).
        try {
            await hook(watchId);
        }
        catch (error) {
            const logger = this.ctx.logger;
            logger?.warn('dsh-feishu: promote finalize hook failed: %o', error);
        }
    }
    /** Send the drained follow-ups into the freshly bound local agent. */
    drainOutboxIntoAgent() {
        const agent = this.getAgent();
        if (agent === undefined)
            return;
        for (const text of this.takeOutbox()) {
            agent.followup(createUserMessage({
                content: [{ type: 'text', text }],
                source: { kind: 'user' },
            }));
        }
    }
    /**
     * READ-ONLY cross-process view: another dsh process drives this session
     * (the writer guard refused our cold resume), so sync the phone's cards
     * from its persisted log instead. Durable rows only — every turn's final
     * assistant message arrives (poll-delayed, streaming detail omitted).
     */
    watchRemote(sessionId, onEvents) {
        return this.runExclusive(() => this.watchRemoteInner(sessionId, onEvents));
    }
    async watchRemoteInner(sessionId, onEvents) {
        await this.stopWatchRemote();
        // Kept for the promote-failure re-watch (same view, not a blank one).
        this.remoteOnEvents = onEvents;
        // The watched id — the queue arm (queueRemoteFollowup) and the explicit
        // takeover detection (bindInner) both key off this. It was NEVER assigned
        // before (stopWatchRemote cleared a field nothing set) — one more wire
        // the dead channel was missing.
        this.remoteWatchId = sessionId;
        const cwd = await this.headerCwdOf(sessionId);
        if (cwd === undefined)
            throw new Error(`cannot locate the log of ${sessionId} for read-only viewing`);
        this.sessionId = sessionId;
        const dir = join(sessionLogRoot(), projectKeyFor(cwd), sessionId);
        // The artifact name carries the format generation since the V3 format
        // (session.v3.jsonl[.zstd]); legacy sessions keep session.jsonl[.zstd].
        // Prefer the current generation, compressed over raw; when nothing is
        // on disk yet (cold view before the writer flushes) fall back to the
        // legacy canonical name — the tail tolerates a not-yet-existing file.
        let file = join(dir, 'session.jsonl.zstd');
        for (const name of ['session.v3.jsonl.zstd', 'session.v3.jsonl', 'session.jsonl.zstd', 'session.jsonl']) {
            const candidate = join(dir, name);
            try {
                await stat(candidate);
                file = candidate;
                break;
            }
            catch {
                // Not this name — try the next one.
            }
        }
        const tail = new RemoteSessionTail(file, {
            onEvents: list => {
                if (this.remoteTail !== tail)
                    return;
                onEvents(list);
            },
        }, this.viewerOptions);
        this.remoteTail = tail;
        await tail.tickOnce(); // deterministic backfill of stored history
        tail.start();
        if (this.hasOutbox())
            this.startPromotePoll(sessionId);
    }
    async stopWatchRemote() {
        this.stopPromotePoll();
        this.remoteWatchId = undefined;
        this.remoteOnEvents = undefined;
        if (this.remoteTail === undefined)
            return;
        this.remoteTail.stop();
        this.remoteTail = undefined;
    }
    /** The persisted header for a session id — best-effort (absent = undefined). */
    async headerOf(sessionId) {
        try {
            const persistence = this.ctx.get('sessionPersistence');
            const stored = ((await persistence?.list().catch(() => [])) ?? []).map(headerOfEntry);
            return stored.find(candidate => String(candidate.id) === sessionId);
        }
        catch {
            return undefined;
        }
    }
    /** Historical cwd for a session from persisted headers — best-effort. */
    async headerCwdOf(sessionId) {
        const header = await this.headerOf(sessionId);
        return typeof header?.cwd === 'string' && header.cwd !== '' ? header.cwd : undefined;
    }
    /**
     * The preset a session composes under — the host's projection of the
     * `agent-preset/selected` events the presets service appends on mount
     * (the controller reads the same value off its observation before ITS
     * resumes). NOT the meta header: agentPreset never persists there.
     * undefined = query absent or session predates preset tracking.
     */
    async presetOfSession(sessionId) {
        try {
            const query = this.ctx.get('sessionQuery');
            if (query === undefined)
                return undefined;
            const observation = await query.observeSession(SessionId(sessionId));
            const preset = observation?.projections?.values?.agentPreset;
            return typeof preset === 'string' && preset !== '' ? preset : undefined;
        }
        catch {
            return undefined;
        }
    }
    /** The host's agent-presets service — undefined in compositions without one. */
    presetsService() {
        try {
            return this.ctx.get('agentPresets');
        }
        catch {
            return undefined;
        }
    }
    /**
     * The preset a fresh session must join — the id the /new card picked, or
     * the configured default when it named none. undefined = compose bare:
     * every failure path degrades there rather than failing /new (tui profiles
     * resolve no presets and load their tools globally, where bare is the
     * correct composition).
     */
    async resolveSessionPreset(presetId) {
        const presets = this.presetsService();
        if (presets === undefined)
            return undefined;
        try {
            return await presets.resolve(presetId);
        }
        catch (error) {
            this.warn(`preset "${presetId ?? 'default'}" resolve failed — composing bare: ${String(error)}`);
            return undefined;
        }
    }
    /**
     * Join the agent to the preset inside the factory setup. Failure degrades
     * to a bare composition rather than failing the create/resume — the host's
     * own "published without joining an agent preset" warning is the visible
     * backstop, and the phone-side flow must not die on a misconfigured preset.
     */
    async mountPreset(agentCtx, presetId) {
        const presets = this.presetsService();
        if (presets === undefined)
            return;
        try {
            await presets.mount(agentCtx, presetId);
        }
        catch (error) {
            this.warn(`preset "${presetId}" mount failed — agent composes bare: ${String(error)}`);
        }
    }
    /** Best-effort warn — compositions without a logger silently skip. */
    warn(message) {
        try {
            this.ctx.logger?.warn(`dsh-feishu: ${message}`);
        }
        catch {
            // No logger here — nothing to fall back to.
        }
    }
    /**
     * Resolve the directory the jsonl backend owns for a session id — the same
     * derivation the lock guard and the remote view use (`<sessionRoot>/
     * <projectKey(cwd)>/<id>`); undefined when the session's cwd is unknown
     * (a derived path would be a decoy the real writer never touches).
     */
    async sessionDirOf(sessionId) {
        const cwd = await this.headerCwdOf(sessionId);
        if (cwd === undefined)
            return undefined;
        return join(sessionLogRoot(), projectKeyFor(cwd), sessionId);
    }
    /** The bound session id, when bound. */
    getSessionId() {
        return this.sessionId;
    }
    /** Live agent for an arbitrary session id, when one exists (no binding change). */
    getAgentFor(id) {
        return this.agents.get(SessionId(id));
    }
    /**
     * The bound live agent. Re-probes the registry when our cached reference
     * went away (the TUI resumed the same id into its own handle) — an attach
     * must always route followups to whoever is live NOW.
     */
    getAgent() {
        const id = this.sessionId;
        if (id === undefined)
            return undefined;
        const live = this.agents.get(SessionId(id));
        if (live !== undefined)
            return live;
        return this.owned?.agent;
    }
    /**
     * Create a FRESH root session and bind to it — the explicit /new flow.
     * The "never create" invariant now means "never create IMPLICITLY": this
     * is the operator's deliberate action, same right the TUI/web surfaces
     * have. We own the resulting handle exactly like the resume arm.
     */
    /**
     * Create a fresh agent bound to the given model selection. The selection
     * rides in twice: agentOptions carries the route INCLUDING the reasoning
     * effort (dsh ≥ 0.2.2-rc.1 AgentOptions gained `reasoningEffort`; before
     * that a setup hook had to couple a mutable ref in because agentOptions
     * alone could not carry an effort, and effort-less requests die on
     * endpoints that mandate reasoning — 400 "Reasoning is mandatory"), and
     * installModelSelection(agentCtx) arms the model-switch notice so a later
     * /model live-switch is announced on the next admitted request.
     */
    async createNew(cwd, selection, presetId) {
        if (this.binding !== undefined)
            await this.binding.catch(() => undefined);
        const task = this.createNewInner(cwd, selection, presetId);
        this.binding = task;
        try {
            return await task;
        }
        finally {
            this.binding = undefined;
        }
    }
    async createNewInner(cwd, selection, presetId) {
        // Same exit rule as bindInner: /new must not inherit a stale read-only
        // view from an earlier degrade — the fresh session is locally owned.
        await this.stopWatchRemote();
        // Queued follow-ups addressed the previously watched session; a deliberate
        // fresh start strands them (logged-only drop — no announce surface here).
        const stranded = this.takeOutbox();
        if (stranded.length > 0) {
            const logger = this.ctx.logger;
            logger?.warn('dsh-feishu: /new dropped %d queued follow-up(s) from the watched session', stranded.length);
        }
        await this.releaseOwned();
        // A fresh UUID cannot collide: no other process knows this id, and the
        // host's own write lease covers it from the first materializing write.
        const sessionId = crypto.randomUUID();
        // Join an agent preset — parity with the host's own creators
        // (session-controller `composeAgent`, webhook `createWebhookSession`).
        // A bare create composes against the empty global layer: web/headless
        // profiles load their tool plugins per-agent THROUGH the preset, so an
        // unjoined agent publishes with only the `skill` tool (issue #2). The
        // id comes from the /new config card when the operator picked one;
        // omitted resolves the deployment's default. Failure degrades to the
        // bare create (tui profiles resolve no presets and load tools globally
        // — bare is correct there); the host's own "published without joining
        // an agent preset" warning stays as the visible backstop.
        const preset = await this.resolveSessionPreset(presetId);
        const handle = await this.agents.create({
            sessionId: SessionId(sessionId),
            meta: { cwd, ...(preset === undefined ? {} : { agentPreset: preset.id }) },
            // A bare create has NO route — the first request dies with "agent has
            // no provider/model" (the TUI composes its default selection before
            // creating; the bot inherits the previous session's route instead).
            ...(selection !== undefined
                ? {
                    agentOptions: {
                        provider: selection.provider,
                        model: selection.model,
                        ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
                    },
                }
                : {}),
            setup: async (agentCtx) => {
                installModelSelection(agentCtx);
                if (preset !== undefined)
                    await this.mountPreset(agentCtx, preset.id);
            },
        });
        this.owned = handle;
        this.sessionId = String(handle.agent.session.id);
        // The created session's model selection is host-owned — handing the
        // agent's selection surface back lets the bot live-switch the route
        // later (/model). The loop's concrete agent (dsh-agent-loop
        // ReactLoopAgent, lib/index.js:545 `this.model = new AgentModel(...)`)
        // always carries `.model`; the public `Agent` face (`{ id }`) does not
        // declare it, so read it structurally.
        const model = modelSurfaceOf(handle.agent);
        return { sessionId: this.sessionId, mode: 'created', agent: handle.agent, model };
    }
    /** Bind one session id (attach when live, else resume). */
    async bind(id, agentOptions) {
        if (this.binding !== undefined)
            await this.binding.catch(() => undefined);
        const task = this.bindInner(id, agentOptions);
        this.binding = task;
        try {
            return await task;
        }
        finally {
            this.binding = undefined;
        }
    }
    async bindInner(id, agentOptions) {
        // A successful local bind IS the exit from a read-only remote view.
        // Without this, one SessionAlreadyOwnedError degrade poisons every later
        // surface: resuming ANY session (even a fresh /new one) keeps reporting
        // 只读旁观 because isReadOnlyView() only ever cleared on detach. Resuming
        // the watched session is the takeover; anything else is a switch away.
        // No-op when no watch is active.
        const watchTarget = this.remoteWatchId;
        await this.stopWatchRemote();
        // Queued follow-ups address the WATCHED session: switching to a different
        // one strands them — drop (the count rides back to the caller's announce)
        // instead of leaking them into an unrelated session later.
        const droppedQueued = watchTarget !== undefined && watchTarget !== id ? this.takeOutbox().length : 0;
        const watchNote = {
            ...(watchTarget === id ? { tookOverWatch: true } : {}),
            ...(droppedQueued > 0 ? { droppedQueued } : {}),
        };
        const live = this.agents.get(SessionId(id));
        if (live !== undefined) {
            if (this.owned !== undefined && this.owned.agent === live) {
                // The live agent IS our own resumed handle — keep ownership as is.
                this.sessionId = id;
                return { sessionId: id, mode: 'resumed', agent: live, ...watchNote };
            }
            // Someone else owns the live agent — release any handle of OURS (for
            // another session, or a stale duplicate) and attach to theirs.
            await this.releaseOwned();
            this.sessionId = id;
            return { sessionId: id, mode: 'attached', agent: live, ...watchNote };
        }
        // Resume arm: load the persisted session; we own the handle.
        const previous = this.owned;
        if (previous !== undefined && String(previous.agent.session.id) === id) {
            // Already our own binding.
            this.sessionId = id;
            return { sessionId: id, mode: 'resumed', agent: previous.agent };
        }
        // A cold resume with no agentOptions can revive a route-less agent
        // (sessions created before the route fix have no request/header in
        // their log) — the caller resolves the route, we pass it through.
        // Cross-process single-writer arbitration is the HOST's job since 0.1.5:
        // `agents.resume` opens the write handle under the host's kernel lease,
        // and a session owned by another process refuses here with
        // SessionAlreadyOwnedError (the bot degrades to a read-only watch).
        // Adopt/attach flows above never open a write handle.
        // Rejoin the session's OWN recorded preset: `agents.resume` carries no
        // composition of its own (the controller's resume recomposes via
        // composeAgent), so without this a web-created session revived after a
        // host restart lands in the empty global layer again — tools gone.
        // Sessions with no recorded preset (pre-fix bot sessions) resume bare.
        const presetId = await this.presetOfSession(id);
        const handle = await this.agents.resume({
            resumeSessionId: SessionId(id),
            ...(agentOptions !== undefined ? { agentOptions } : {}),
            ...(presetId === undefined ? {} : {
                setup: async (agentCtx) => {
                    await this.mountPreset(agentCtx, presetId);
                },
            }),
        });
        // No dispose of `previous` (same multi-surface rule as releaseOwned):
        // the old agent stays live and adoptable by other surfaces.
        this.owned = handle;
        this.sessionId = id;
        return { sessionId: id, mode: 'resumed', agent: handle.agent, ...watchNote };
    }
    /** Drop the binding (detach). Only OUR handle is disposed — never an attached one. */
    async detach() {
        await this.stopWatchRemote();
        this.sessionId = undefined;
        await this.releaseOwned();
    }
    async releaseOwned() {
        // Deliberately NO dispose: in the multi-surface world an owned handle
        // may already have been ADOPTED by another surface (the TUI attaching
        // to a bot-created session) — disposing here would kill the agent out
        // from under it (live: the attach succeeded, then every message failed
        // because the returned agent had just been disposed). Surfaces attach
        // and detach freely; created/resumed agents simply stay live in the
        // registry until the process ends.
        this.owned = undefined;
    }
    /** Dispose everything we own (plugin teardown). */
    async dispose() {
        await this.stopWatchRemote();
        await this.detach();
    }
}
//# sourceMappingURL=binder.js.map