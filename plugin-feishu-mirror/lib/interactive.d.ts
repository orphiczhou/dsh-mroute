/**
 * Interactive command adapters — the selector-FW consumers. Each adapter
 * renders one desktop picker through the generic selection card and applies
 * the picked option through an existing channel:
 *
 * - /think — reasoning-effort picker for the bound session's current model
 *   (`llm.resolveModelInfo(...).reasoning.efforts`, same source the TUI's
 *   effort picker uses); applies via the shared model-selection core;
 * - /permission — permission-preset picker (`ctx.get('permissionPresets')`);
 *   the pick is REPLAYED through the canonical `/permission <name>` command
 *   execution, the same path the desktop TUI uses for its picker;
 * - /select-skill — user-invocable skill picker (`ctx.get('skills').list`);
 *   activation rides the harness's OWN `/name` skill gesture — the picked
 *   name is injected as a plain user message through the steer/followup
 *   channel, which tool-skill scans for gestures (never a bespoke API call);
 * - /profile-switch — model-profile switcher over `$DSH_HOME/model-profiles.json`
 *   (same schema the TUI owns); applies the profile's route via the shared
 *   model-selection core. Desktop-only side effects (agent frontmatter
 *   writes, `current` persistence) are deliberately NOT replicated.
 *
 * Every adapter owns its degraded replies (missing service, unbound session,
 * unknown model) so the dispatch loop never sees a throw.
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { SelectorOutcome } from './selector.ts';
import type { SelectorSpec } from './selector-card.ts';
import type { SessionBinder } from './binder.ts';
import type { StateStore } from './state-store.ts';
/** A model selection handed to the shared apply core (effort optional). */
export interface ModelSelectionUpdate {
    readonly provider: string;
    readonly model: string;
    readonly reasoningEffort?: string;
}
/** Best-effort current model selection of the bound session. */
export interface CurrentSelection {
    readonly provider: string;
    readonly model: string;
    readonly reasoningEffort?: string;
}
/**
 * The bot-side surfaces the adapters drive. Implemented by FeishuBot — the
 * shared apply core, the prompt-injection channel and the current-selection
 * chain stay bot-owned so /model and these adapters cannot drift apart.
 */
export interface InteractiveHost {
    readonly ctx: Context;
    readonly store: StateStore;
    readonly binder: SessionBinder;
    /** Reply with a body card in the operator's last chat. */
    reply(text: string): Promise<void>;
    /** Present a selection card; resolves with the operator's outcome. */
    presentSelection(chatId: string, spec: SelectorSpec): Promise<SelectorOutcome>;
    /** Shared model-selection apply (live ref vs phone default). */
    applyModelSelection(selection: ModelSelectionUpdate): Promise<'live' | 'phone-default'>;
    /**
     * Inject text as a plain user message (steer when running, followup when
     * idle). 'refused' = read-only view or no bound session.
     */
    injectPrompt(text: string): Promise<'steered' | 'opened' | 'refused'>;
    /** Execute a dsh command line through the command registry (replies itself). */
    executeCommand(name: string, line: string): Promise<void>;
    /** Current model selection of the bound session (best-effort chain). */
    currentSelection(): Promise<CurrentSelection | undefined>;
    /** The bound live agent (resuming when needed); undefined when unbound. */
    boundAgent(): Promise<Agent | undefined>;
}
/** Option value that explicitly clears the effort override (TUI's default row). */
export declare const DEFAULT_EFFORT = "default";
/**
 * /think — pick a reasoning effort for the bound session's CURRENT model.
 * Efforts come from the model adapter (`resolveModelInfo`), matching the
 * TUI's effort picker; an unknown route asks for /model first.
 */
export declare function runThinkCommand(host: InteractiveHost): Promise<void>;
/**
 * /permission — pick a permission preset and replay it through the canonical
 * `/permission <name>` command execution (the registry owns the switch, so
 * sandbox/approval knobs ride the same path as the desktop picker).
 */
export declare function runPermissionCommand(host: InteractiveHost): Promise<void>;
/**
 * /select-skill — pick a user-invocable skill and activate it by injecting
 * the harness's own `/name` skill gesture as a plain user message. This is
 * the official activation path: tool-skill scans direct user input for the
 * gesture and injects the rendered skill content itself.
 */
export declare function runSelectSkillCommand(host: InteractiveHost): Promise<void>;
/** The profile's default model route (subset of the TUI's on-disk schema). */
export interface ProfileRoute {
    readonly provider: string;
    readonly model: string;
    readonly reasoningEffort?: string;
}
/** One named profile (only the fields the switcher reads). */
export interface ModelProfileEntry {
    readonly name: string;
    readonly defaultModel?: ProfileRoute;
}
/** The stored document (subset of the TUI's on-disk schema, version 1). */
export interface ModelProfilesDoc {
    readonly current?: string;
    readonly profiles: readonly ModelProfileEntry[];
}
/** `$DSH_HOME/model-profiles.json` — same store the TUI owns. */
export declare function modelProfilesPath(home?: string): string;
/**
 * Read + validate `$DSH_HOME/model-profiles.json` (version 1, same schema the
 * TUI owns). Returns undefined when the file is missing, unreadable or
 * corrupt — the adapter answers with a pointer instead of guessing.
 */
export declare function loadModelProfilesDoc(path: string): Promise<ModelProfilesDoc | undefined>;
/**
 * /profile-switch — pick one of the stored model profiles and apply its
 * route (provider/model/effort) through the shared model-selection core.
 */
export declare function runProfileSwitchCommand(host: InteractiveHost, path?: string): Promise<void>;
