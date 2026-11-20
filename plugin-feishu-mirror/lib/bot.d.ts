/**
 * The bot orchestrator: inbound queue → command routing → session binding →
 * status-card lifecycle.
 *
 * Lifecycle rules (design doc §2/§5 定稿):
 * - silent startup — the bot never sends anything unprompted;
 * - pairing mode: with a COMPLETELY empty operator list (config ∪ persisted
 *   paired), the first p2p DM is offered a pairing confirmation card whose
 *   tap claims admin (persisted, effective in-process immediately); groups
 *   never pair, and once any admin exists strangers are silent again;
 * - binding only through /resume; unbound input gets one hint line;
 * - prompts inject via `agent.steer` while a turn runs (join the CURRENT
 *   turn's next round — the operator's mid-course corrections land
 *   immediately) and `agent.followup` when idle (open the next turn);
 * - one card per ROUND: opened when the round starts (turn/start, or right
 *   after the previous round settled), patched in place on the 5s status
 *   beat ONLY when content changed (pseudo-streaming: in-flight text grows
 *   a ✍️ tail between beats), settled to "Round N · 💬 回复" when its
 *   assistant/message lands — the round's text ships verbatim as a body
 *   card right after — and the turn's last card carries the end state;
 * - card operations serialize on a chain so settle-patch → body → next-open
 *   never interleave with the beat or turn/end;
 * - no replay of session history on bind (live events from bind time on).
 */
import type { Context } from '@deepseek-ai/cordis';
import { type RepairBackend } from './log-repair.ts';
import { type SelectorOutcome } from './selector.ts';
import { type SelectorSpec } from './selector-card.ts';
import type { ResolvedConfig } from './config.ts';
import { type LarkGateway } from './lark-client.ts';
import type { SessionBinder } from './binder.ts';
import type { StateStore } from './state-store.ts';
/**
 * Decide whether a settled round's body embeds into its settle card (the
 * `💬 Round 回复` section) instead of shipping as standalone body-card
 * message(s). Empty bodies never embed (nothing to render); a body longer
 * than one body segment keeps the segmented body-card path — embedding would
 * duplicate segmentation inside the card for no gain.
 */
export declare function shouldEmbedRoundText(roundText: string, bodySegmentChars: number): boolean;
export interface BotDeps {
    readonly ctx: Context;
    readonly config: ResolvedConfig;
    readonly lark: LarkGateway;
    readonly binder: SessionBinder;
    readonly store: StateStore;
    readonly allowlist: ReadonlySet<string>;
    /** Clock seam for deterministic tests. */
    readonly now?: () => number;
    /** Corrupt-log repair seam (tests inject a fake; default spawns the tool). */
    readonly repair?: RepairBackend;
}
export declare class FeishuBot {
    private readonly ctx;
    private readonly config;
    private readonly lark;
    private readonly binder;
    private readonly store;
    private readonly allowlist;
    private readonly now;
    private readonly repair;
    private readonly runState;
    /** Serializes card operations (open/patch/settle/finalize) in event order. */
    private cardChain;
    private pendingPicker;
    private cardMessageId;
    private cardHash;
    /** Session id whose route facts were already backfilled from its log. */
    private routeBackfilledFor;
    /** Live ask-user questions keyed by the card's question id. */
    private readonly pendingAsks;
    /** ask() request object → question id (router settled() arrives per-request). */
    private readonly askRequestIds;
    /** The interactive /resume picker card awaiting a form submit. */
    private resumeCardMessageId;
    /** Bot-created sessions' agent-owned model selection surfaces (/model live-switch). */
    private readonly selectionRefs;
    /** Session id → agent-preset id learned at bind/create time (footer display). */
    private readonly presetBySession;
    /** /btw side-question manager (phone surface; per-surface by design). */
    private readonly btw;
    /** The in-flight /model two-step flow. */
    private modelFlow;
    /** Generic selection-card flows (selector FW; driven via presentSelection). */
    private readonly selectors;
    private readonly newFlow;
    /** Session ids with a corrupt-repair confirmation card currently out. */
    private readonly repairFlows;
    /** A /stop confirmation card is currently out (single slot). */
    private stopConfirmInFlight;
    /** Bot-side surfaces the interactive adapters drive (selector-FW commands). */
    private readonly host;
    /** Inbound message that triggered the current turn (for the done reaction). */
    private turnOriginMessageId;
    /** The bot's own open_id — group mention routing (resolved at start; optional). */
    private botOpenId;
    /**
     * Pairing-offer cards currently out (chatId → messageId), so a repeated DM
     * in the same chat PATCHES the existing card instead of stacking a new one.
     * Bounded: over the cap the oldest chat's entry is dropped (a fresh card is
     * simply sent next time — self-healing, no correctness impact).
     */
    private readonly pairingCards;
    /** Per-session background-push scratch (firehose fold; bounded). */
    private readonly pushTracks;
    private ticker;
    private disposed;
    /** Inbound queue — the WS handler only pushes; a serial drain processes. */
    private readonly queue;
    private draining;
    constructor(deps: BotDeps);
    /** Wire subscriptions, start the beat, open the Lark connection. */
    start(): Promise<void>;
    /**
     * Attach the stored binding when its session is ALREADY live — never resume.
     *
     * Runs at startup and again from the firehose. A session the desktop opens
     * after this plugin started is not live at startup time, so the attach was
     * skipped and the phone went silent: `binder.getSessionId()` stays undefined,
     * which drops every card (`onSessionEvent` returns early) and makes every
     * claim false. `session/event` is a global subscription, so the stored
     * session's first event is a reliable second chance to finish the attach.
     *
     * @param reason - what triggered the attempt (log only).
     * @returns whether a live agent was found and bound.
     */
    private attachStoredBindingIfLive;
    /** One stored-binding attach in flight; the firehose may fire many events. */
    private storedAttachInFlight;
    private readonly cleanupFns;
    dispose(): Promise<void>;
    /** WS receive callback — enqueue-only (3s ack window; no business logic). */
    private enqueue;
    /** Run a card operation after every previously queued one completes. */
    private chain;
    private drain;
    /** Reply with a body card — markdown renders in lark_md, not in msg_type=text. */
    private reply;
    /** Reply with a long body, segmented at the configured size; each segment ships as its own card. */
    private replyLong;
    /**
     * Group gate: only @-mentions of the bot are dispatched — group traffic
     * delivers EVERY message to the bot, and replying to all of them would
     * spam the chat. Without a resolvable bot open_id any mention counts (a
     * gate that dropped everything forever would be worse than a loose one).
     *
     * Images are the one exception to the mention rule: an image message cannot
     * carry @mentions, so a group image counts as addressed when THIS chat is
     * the bot's current dispatch surface (the operator has been driving from
     * here) and a session is bound. A group that never touched the bot never
     * receives image injection.
     */
    private groupGate;
    private process;
    /**
     * Effective operator gate: the configured allowlist OR a persisted pairing
     * admin (read fresh — a claim must take effect in-process immediately).
     * Every interactive surface (card callbacks, selector FW) funnels through
     * here so a paired admin is a first-class operator everywhere, not only on
     * the message path.
     */
    private mayOperate;
    /**
     * Whether an admin exists at all (config ∪ paired, freshly read) — the
     * pairing card's claim window is open only while this is false.
     */
    private hasAnyOperator;
    /**
     * Offer the pairing confirmation card in a p2p chat. A repeated DM in the
     * same chat patches the already-out card (no stacking); a patch failure
     * (card deleted/too old) falls back to a fresh send. Both sends swallow
     * API errors — `undefined` messageId simply means the offer never landed
     * and the next DM retries.
     */
    private offerPairing;
    /**
     * A pairing-card tap arrived: claim admin for the TAPPER (the open_id in
     * the event, never the card's original target). The claim window is
     * re-checked at tap time against the CURRENT config ∪ paired union — a
     * stale card tapped after an operator was configured resolves to the
     * "已有管理员" terminal state instead of a second admin. Never throws:
     * a failed claim degrades to a log line, the card callback contract
     * forbids leaking errors into the SDK dispatcher.
     */
    private handlePairingClaim;
    /** Reverse lookup: which chat a tracked pairing card was sent to. */
    private pairingChatIdOf;
    private handleResumeList;
    /**
     * The effective picker: the in-memory one wins, the PERSISTED one is the
     * fallback after a restart (bot state survives reboots; the raw picker
     * previously died with the process, stranding `/resume N` replies).
     */
    private currentPicker;
    private handleResumePick;
    /** Interactive picker submit (card.action.trigger) → same core as /resume N. */
    private handleResumeAction;
    /** Shared bind flow for the text path (/resume N) and the card submit. */
    private resumePickCore;
    /**
     * The host's single-writer guard fired on a bind (SessionAlreadyOwnedError):
     * another dsh process drives the session under its kernel write lease.
     * Degrade to a READ-ONLY view over its persisted log instead of a dead end
     * — the same fold pipeline paints round cards, so every turn's final reply
     * lands on the phone (poll-delayed). Queued follow-ups drive an automatic
     * takeover once the other process releases the session. Shared by the
     * /resume failure path and the post-repair re-entry (a racer can take the
     * session in the gap between the repair and the bind).
     */
    private degradeToRemoteWatch;
    /**
     * The bind + first-reply + picker-settle half of a successful /resume —
     * shared by the picker path and the post-repair re-entry (whose picker is
     * long gone; the row alone is enough). `notice`, when given, prefixes the
     * announcement so a repair lands as ONE message after the bind succeeded.
     */
    private bindAndAnnounce;
    /**
     * A /resume died on a corrupt log: resolve the session's storage dir and
     * put up a repair confirmation card. The interactive part runs DETACHED —
     * resumePickCore can be executing inside a card-chain task (card submit
     * path), and presentSelection dead-locks when awaited from that chain
     * (its sends enqueue on the very same chain).
     */
    private offerCorruptRepair;
    /** The desktop-tool pointer (degrade path when no log dir is resolvable). */
    private corruptPointerText;
    /** Confirmation card → one-shot repair → re-enter the session. */
    private repairFlow;
    /**
     * The guarded repair: rebuild the corrupt log, verify the result, then swap
     * and re-enter. Every failure path leaves the original byte-identical.
     *
     * Cross-process arbitration note (0.1.5): a corrupt log cannot be DRIVEN —
     * any process that tries to open it for write fails at log validation and
     * the host's kernel write lease is released with that failure, so there is
     * no live writer to exclude during the rebuild window (the pre-0.1.5
     * pid-file guard here was deleted with the host lease taking over
     * arbitration). A racer that takes the session after the swap degrades the
     * re-entry below to the same read-only watch a refused /resume gets.
     */
    private repairAndEnter;
    /**
     * /new: close the current binding and start a FRESH session bound to the
     * bot. The old stream gets its visual boundary — the last card greys out
     * (已解绑), then a 🆕 header card marks where the new session begins; the
     * chat history itself is never deleted (round cards are the operator's
     * record). The new session inherits the previous one's cwd when readable,
     * else the process cwd.
     */
    private handleBtw;
    private handleNew;
    /** The cwd a fresh session starts in: the bound session's cwd, else here. */
    private newSessionCwd;
    /**
     * Model selection the /new card PRE-FILLS (a bare agents.create has NO
     * provider/model — the first request dies with "agent has no
     * provider/model", Round 0 ❌ in live use). Resolution order:
     * 1. the previous session's own selection incl. reasoning effort
     *    (continuity: same model + effort, fresh context) from its log;
     * 2. the phone's own stored default (provider/model/effort saved by
     *    /model, /think or /profile-switch on the phone) — the operator's
     *    explicit pick beats the settings default;
     * 3. the settings' default model via ctx.agentDefaultModel — the same
     *    fallback the TUI seeds from before creating.
     */
    private newSessionDefaultSelection;
    /**
     * Dropdown sources for the /new config card — every field is best-effort:
     * a source that is absent (no presets service on this profile), fails, or
     * answers nothing just omits its dropdown, and the submit falls back to
     * the default-resolution chain for that key.
     */
    private buildNewSessionSpec;
    /**
     * The operator submitted (or closed) the /new config card. Only a submit
     * mints a session: the picks overlay the resolved defaults, each absent
     * key keeping the default. The preset id goes to the binder verbatim —
     * omitted resolves the deployment default (issue #2 parity).
     */
    private handleNewOutcome;
    private handleStop;
    /** Confirmation card → the actual everything-stop on 确认停止 only. */
    private stopConfirmFlow;
    /** The everything-stop: phone-side btw calls die too. */
    private stopNow;
    /**
     * Round-card quick action: ⛔ 停止 is exactly the /stop path (btw calls die
     * too); ▶️ 继续 nudges the agent with the literal word — a turn that ended
     * mid-work (or an unattended question in text) picks up from there. The
     * injected prompt IS the feedback when it lands (the new turn opens its own
     * card); only the refused paths need a reply.
     */
    private handleRoundAction;
    private handleSub;
    private handlePassthrough;
    /**
     * Shared prompt-injection channel (operator messages AND the interactive
     * adapters' skill activation): running turns get steered (join the CURRENT
     * turn's next round), idle sessions open the next turn. 'refused' covers
     * the read-only view and the missing binding — callers word their replies.
     * Content is a block array: text for prompts, text+image for pictures.
     */
    private injectContent;
    private injectPrompt;
    private handlePrompt;
    /**
     * An image message from an operator: download the resource bytes, sniff the
     * media type (Feishu declares none), commit a durable attachment ref, and
     * inject an image-block user message through the shared steer/followup
     * channel. The model route must accept image input (inputModalities) —
     * a route that does not fails the turn visibly, same as the desktop.
     */
    private handleImage;
    /**
     * Model route for a COLD resume: the target session's own log route first
     * (sessions created before the route fix have none), then the settings'
     * default model. Without it a resumed agent can come back route-less and
     * every message dies with "agent has no provider/model".
     */
    private resolveResumeRoute;
    /** Resolve the bound session to a live agent, resuming it if needed. */
    private ensureBoundAgent;
    /** Route one live stream frame to the bound-session or child fold. */
    private onStreamFrame;
    private onSessionEvent;
    /**
     * Background completion push: fold non-bound ROOT sessions' events into a
     * per-session scratch and, at turn/end, push a compact card when the config
     * mode covers the cause. Bound sessions never double-push (their live round
     * cards already flow); subagent children are skipped (their settlement
     * reaches the parent as a subagent-settled notice, which IS pushed).
     */
    private trackBackgroundPush;
    /**
     * Backfill the route facts (provider/model/think level/context window and
     * the cache-hit segment) from the BOUND session's own log. The route events
     * are appended only at session start or on a route change, so a mid-run
     * bind never sees them live — without this the footer shows no model, no
     * think level and a windowless ctx. Runs once per bound session; best-effort.
     */
    private backfillRoute;
    /**
     * Backfill a newly discovered child row from the child's OWN session log.
     * Discovery can happen long after spawn (mid-turn attach) or with the
     * child's events beating the parent's agent-start — either way the naming
     * events never reach the live firehose, and without this the card shows the
     * bare hash prefix instead of the agent name. Best-effort: no sessions
     * service or an unreadable log just keeps the fallback label.
     */
    private backfillChild;
    private sessionLabel;
    /**
     * Preset id of the bound session for the stats footer — sync lookup of the
     * cache populated at bind/create time. undefined = never learned (sessions
     * predating preset tracking, query-less profiles); the footer omits it.
     */
    private sessionPreset;
    /**
     * Learn a session's preset: the operator's explicit /new pick when given,
     * else the host's sessionQuery projection of `agent-preset/selected` (the
     * same record binder.presetOfSession reads for resume rejoins). Best-effort
     * — a missing/failed query leaves the cache untouched, the footer omits
     * the field, and nothing else depends on it.
     */
    private learnPreset;
    /**
     * Round-card quick actions, config-gated: `roundButtons: 'off'` (default)
     * keeps the card inert — no ⛔ 停止 / ▶️ 继续 at all; `/stop` is the stop
     * path either way. Read-only views never get buttons even when enabled.
     */
    private roundActions;
    /** Open the per-turn card (bound session's agent is mid-turn). */
    private openCard;
    /** A bind landed while the agent is already running — open the card late. */
    private maybeOpenCardForRunningAgent;
    /** Status beat: patch the open card only when rendered content changed. */
    private beat;
    /**
     * Immediate (off-beat) patch of the live round card — the turn-stopping /
     * request-error handlers call this so the phone reflects the lifecycle
     * change without waiting for the 30s beat. Hash-gated like the beat; a
     * change lands only when the rendered content actually differs.
     */
    private patchCurrentCard;
    /**
     * One assistant/message landed = one round settled (the fold already
     * incremented rounds and captured the round's duration/text). Settle the
     * round's card to "Round N · 💬 回复" — a body that fits a single segment
     * embeds into that very card (`💬 Round 回复` section), oversized bodies
     * ship verbatim as their own cards — then open the next round's card. Runs
     * serialized on the card chain.
     */
    private settleRound;
    /** turn/end: finalize the current card into the turn's end state. */
    private finalizeTurn;
    /** Patch the open card into a detached state and forget it (/new). */
    private closeCardAsDetached;
    /** Clear the run view (new binding / detach) — no history replay. */
    private resetRunView;
    /** The llm service surface the model cards need (structural). */
    private llm;
    /**
     * Enrich a provider's model list with each model's context window, resolved
     * in bounded-parallel and fail-open (a resolution failure leaves the model
     * without a window rather than failing the picker). The catalog entries from
     * `listModels` carry no context — only `resolveModelInfo` knows it.
     */
    private enrichModelsWithContext;
    /**
     * /model step 1: list the registered providers (grouped classification —
     * the next step lists the chosen provider's models).
     */
    private handleModel;
    /** /model step 2: list the chosen provider's models. */
    private handleModelProviderPicked;
    /**
     * Shared model-selection apply core — /model submits AND the interactive
     * adapters (/think, /profile-switch) land here so the live-switch and
     * phone-default branches cannot drift apart. Live-switches bot-created
     * sessions through their agent-owned selection surface (an absent effort
     * follows adapter defaults without inheriting a previous one —
     * Model.select's contract, same clear semantics the old mutable ref had);
     * otherwise remembers the pick as the phone default (used by /new,
     * honored on the next live bind).
     */
    private applyModelSelection;
    /**
     * Best-effort current model selection of the BOUND session — the data
     * source for the interactive /think adapter. Chain (mirrors the /model
     * and cold-resume routes): the bot-owned selection ref, the run view
     * (live route folds + the bind-time log backfill), the persisted log
     * itself, then the settings' default model. Undefined = nothing known.
     */
    private currentModelSelection;
    /**
     * /model submit: live-switch bot-created sessions through their selection
     * ref; otherwise remember the pick as the phone default (used by /new)
     * and point desktop-driven sessions at the desktop switcher.
     */
    private handleModelSubmitted;
    /**
     * Register the phone as an ask-user surface. With dsh-ask-router present
     * this registers as one surface among several (first answer wins across
     * surfaces). Without it: a claim-scoped 'user-questions/request' cordis
     * waterfall answerer — answer by returning, delegate unclaimed asks via
     * next(). (alpha.3 removed the rc-era registerProvider slot along with its
     * DUPLICATE_PROVIDER yield protocol; the waterfall is the host's single
     * dispatch.)
     */
    private registerAskSurface;
    /**
     * Bound-session race (design doc §3.2). Unclaimed requests still delegate
     * verbatim via next() (C4). For claimed ones we fork next() and the card in
     * the same tick and let the arbiter pick the first settle.
     */
    private raceAsk;
    /** Whether the bound session is the one asking (claim routing). The read
     * is structural on purpose — ask requests and approval requests share the
     * `agent.session.id` identity but nothing else. */
    private claimsAskSession;
    /**
     * Send the interactive ask card and resolve when the operator submits
     * (or reject when the owning turn aborts). The card stays submittable
     * until answered or aborted — no TTL: expiring would fail the agent's
     * tool call just because the phone sat in a pocket.
     */
    private askViaCard;
    /** Router notification: another surface answered — settle and dismiss. */
    private dismissAsk;
    /** Entry-handle form — shared by router settled() and the race's R-B. */
    private dismissAskEntry;
    /** Best-effort terminal patch of an ask card. */
    private patchAskCard;
    /**
     * Register the phone as an approval answerer on the host's
     * 'approval/request' cordis waterfall — the same dispatch shape as the ask
     * waterfall (dsh-acp is the host's own reference answerer; the TUI plugin
     * registers none, so the phone is the sole interactive approver). Claiming
     * means the requesting session is the bound one and a delivery chat exists;
     * anything else delegates via next(), which the host treats as
     * 'unavailable' (fail-closed) when no other answerer takes it.
     */
    private registerApprovalSurface;
    /**
     * Approval race (design doc §3.2, mapped onto the selector-FW card path).
     * Unclaimed requests delegate via next() verbatim (C4). Claimed ones fork
     * next() and the phone card in the same tick.
     *
     * Approval has no typed error vocabulary: the card settles with an outcome
     * ('allowed-once' / 'rejected' / 'cancelled' / 'unavailable') rather than a
     * UserQuestionError. Mapping to R-A..R-F:
     * - R-A card outcome wins; R-B downstream wins → dismiss the selector flow;
     * - R-D/R-E a dead card (send failure / cancelAll via dispose or rebind),
     *   with signal NOT aborted, is swallowed while downstream is pending;
     * - R-C a request signal abort settles as 'cancelled' (approval's terminal
     *   abort answer, the analogue of ask's ASK_ABORTED);
     * - R-F a dead card followed by a downstream outcome returns downstream.
     * The listener never rejects (fail-closed 'unavailable'), as in legacy.
     */
    private raceApproval;
    /** Shared card spec so legacy and race paths render byte-identical cards. */
    private buildApprovalSpec;
    /**
     * Send the approval card and resolve with the operator's decision. The
     * request's own abort signal cancels the card mid-wait (turn aborted →
     * 'cancelled'); the selector's standard 10-minute TTL bounds an ignored
     * card, whose expiry fails closed as 'unavailable' — never an implicit
     * allow.
     */
    private approvalViaCard;
    /** Race-mode card path: same card, plus a dismiss handle and card-death flag. */
    private approvalViaCardTracked;
    /**
     * card.action.trigger entry (ask-card submits, selector FW submits).
     * Unknown actions and foreign cards are ignored; only allowlisted
     * operators may answer.
     */
    onCardAction(data: unknown): void;
    /**
     * Present a generic selection card in a chat and resolve with the
     * operator's outcome (picked / cancelled / expired). Submits arrive via
     * onCardAction → SelectorManager, and resetRunView cancels flows pending
     * on a rebind.
     *
     * INVARIANT: never call from inside a card-chain task (a chain(() => …)
     * callback) — sendCard enqueues a NEW task on that same chain, so awaiting
     * the outcome from within the chain dead-locks. Callers must run at the
     * top level (command dispatch) or on their own async context.
     */
    presentSelection(chatId: string, spec: SelectorSpec): Promise<SelectorOutcome>;
    /**
     * Run one interactive command adapter (selector-FW consumer). The adapters
     * own their degraded replies; this wrapper only contains an unexpected
     * throw (e.g. a rejected selection card) so the dispatch loop survives.
     */
    private interactiveCommand;
    /** Effective bound id: live binding first, then the stored (not-yet-resumed) one. */
    private boundId;
    private statusText;
}
