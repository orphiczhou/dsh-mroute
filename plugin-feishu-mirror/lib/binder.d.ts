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
import type { Context } from '@deepseek-ai/cordis';
import { type Agent, type Model, type ModelSelection } from '@deepseek-ai/dsh-agent';
/** How the current binding came to be. */
export type BindMode = 'attached' | 'resumed' | 'created';
/** Result of a successful bind. */
export interface BindResult {
    readonly sessionId: string;
    readonly mode: BindMode;
    readonly agent: Agent;
    /** Created sessions only: the agent-owned selection surface (/model live-switch
     * reads `current()` and writes `select()`). dsh ≥ 0.2.2-rc.1 moved the mutable
     * ref inside the host — the loop's concrete agent always exposes `.model`. */
    readonly model?: Model;
    /** The bound session was the one under an active read-only remote watch —
     * an explicit takeover; the caller drains the queued follow-ups into the
     * freshly bound agent. */
    readonly tookOverWatch?: boolean;
    /** Queued follow-ups dropped because they addressed a DIFFERENT watched
     * session (the user switched away). */
    readonly droppedQueued?: number;
}
/**
 * One-bound-session-at-a-time binder. Concurrent binds serialize on the
 * in-flight task so `/resume 3` racing `/resume 5` cannot leak handles.
 */
export declare class SessionBinder {
    private readonly agents;
    /** Handle we own (from our own resume); disposed on rebind/detach. */
    private owned;
    /** Session id of the current binding (live or ours). */
    private sessionId;
    private binding;
    /** Kept for the persistence seam that resolves header metadata. */
    private readonly ctx;
    /** Decoder/interval seam for the read-only remote view (tests inject). */
    private readonly viewerOptions;
    private hook;
    /** Registered by the host bot AFTER construction (needs its private UI). */
    setOnPromotable(hook: (id: string) => Promise<void>): void;
    /** Active read-only view (another process drives the session). */
    private remoteTail;
    /** Id of the session watched right now. */
    private remoteWatchId;
    /** onEvents of the active watch — a failed promote re-watches with it
     * (a no-op callback would leave the phone painting nothing). */
    private remoteOnEvents;
    /** Follow-ups typed while watching — sent once promotion wins the lock. */
    private readonly outbox;
    private promotingRemote;
    private promoteTimer;
    constructor(ctx: Context, options?: {
        viewerOptions?: {
            intervalMs?: number;
            decode?(file: string): Promise<string>;
        };
    });
    /** While a remote watch is active the phone queues instead of driving. */
    isReadOnlyView(): boolean;
    queueRemoteFollowup(text: string): void;
    takeOutbox(): string[];
    hasOutbox(): boolean;
    outboxSize(): number;
    private opChain;
    private runExclusive;
    private startPromotePoll;
    private stopPromotePoll;
    /** Queue non-empty + bind winnable ⇒ take over via registered hook. */
    private maybePromoteRemoteInner;
    /** Send the drained follow-ups into the freshly bound local agent. */
    drainOutboxIntoAgent(): void;
    /**
     * READ-ONLY cross-process view: another dsh process drives this session
     * (the writer guard refused our cold resume), so sync the phone's cards
     * from its persisted log instead. Durable rows only — every turn's final
     * assistant message arrives (poll-delayed, streaming detail omitted).
     */
    watchRemote(sessionId: string, onEvents: (events: Array<Record<string, unknown>>) => void): Promise<void>;
    private watchRemoteInner;
    private stopWatchRemote;
    /** The persisted header for a session id — best-effort (absent = undefined). */
    private headerOf;
    /** Historical cwd for a session from persisted headers — best-effort. */
    private headerCwdOf;
    /**
     * The preset a session composes under — the host's projection of the
     * `agent-preset/selected` events the presets service appends on mount
     * (the controller reads the same value off its observation before ITS
     * resumes). NOT the meta header: agentPreset never persists there.
     * undefined = query absent or session predates preset tracking.
     */
    private presetOfSession;
    /** The host's agent-presets service — undefined in compositions without one. */
    private presetsService;
    /**
     * The preset a fresh session must join — the id the /new card picked, or
     * the configured default when it named none. undefined = compose bare:
     * every failure path degrades there rather than failing /new (tui profiles
     * resolve no presets and load their tools globally, where bare is the
     * correct composition).
     */
    private resolveSessionPreset;
    /**
     * Join the agent to the preset inside the factory setup. Failure degrades
     * to a bare composition rather than failing the create/resume — the host's
     * own "published without joining an agent preset" warning is the visible
     * backstop, and the phone-side flow must not die on a misconfigured preset.
     */
    private mountPreset;
    /** Best-effort warn — compositions without a logger silently skip. */
    private warn;
    /**
     * Resolve the directory the jsonl backend owns for a session id — the same
     * derivation the lock guard and the remote view use (`<sessionRoot>/
     * <projectKey(cwd)>/<id>`); undefined when the session's cwd is unknown
     * (a derived path would be a decoy the real writer never touches).
     */
    sessionDirOf(sessionId: string): Promise<string | undefined>;
    /** The bound session id, when bound. */
    getSessionId(): string | undefined;
    /** Live agent for an arbitrary session id, when one exists (no binding change). */
    getAgentFor(id: string): Agent | undefined;
    /**
     * The bound live agent. Re-probes the registry when our cached reference
     * went away (the TUI resumed the same id into its own handle) — an attach
     * must always route followups to whoever is live NOW.
     */
    getAgent(): Agent | undefined;
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
    createNew(cwd: string, selection?: ModelSelection, presetId?: string): Promise<BindResult>;
    private createNewInner;
    /** Bind one session id (attach when live, else resume). */
    bind(id: string, agentOptions?: {
        provider?: string;
        model?: string;
    }): Promise<BindResult>;
    private bindInner;
    /** Drop the binding (detach). Only OUR handle is disposed — never an attached one. */
    detach(): Promise<void>;
    private releaseOwned;
    /** Dispose everything we own (plugin teardown). */
    dispose(): Promise<void>;
}
