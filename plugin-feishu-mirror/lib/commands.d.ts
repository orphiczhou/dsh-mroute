/**
 * Inbound command classification — the pure routing table. Mirrors the design
 * doc §4 three-way split:
 *
 * - bot-owned mirrors: /resume (picker), /new (detach), /status, /help,
 *   /stop, /feishu-plugin, /sub, /model — implemented here, no host
 *   involvement; plus the interactive adapters (/think /permission
 *   /select-skill /profile-switch) that present a selection card through the
 *   selector FW and apply the pick over an existing channel;
 * - host passthrough: a whitelist of agent-addressed dsh commands forwarded
 *   through ctx.commands.execute — currently EMPTY as a standing table (the
 *   former entries are interactive on the desktop and are answered with the
 *   "use the desktop" notice via REJECTED_COMMANDS); the /permission adapter
 *   hands its explicit `/permission <name>` form here directly;
 * - rejected: two refuse tiers answered with a desktop pointer —
 *   TUI_PI_COMMANDS (owned by the desktop dsh-tui-pi plugin) and
 *   UNADAPTED_COMMANDS (exist in the runtime, no phone UI yet).
 *
 * Anything else — including syntactically-valid but unregistered slash names —
 * falls through as a prompt, matching dsh's own "unknown command goes to the
 * model" behavior.
 */
/** What one inbound text becomes. */
export type Intent = {
    kind: 'prompt';
    text: string;
} | {
    kind: 'resume';
} | {
    kind: 'resume-pick';
    n: number;
} | {
    kind: 'new';
} | {
    kind: 'status';
} | {
    kind: 'help';
} | {
    kind: 'stop';
} | {
    kind: 'sub';
    n: number;
} | {
    kind: 'model';
} | {
    kind: 'think';
} | {
    kind: 'permission';
} | {
    kind: 'select-skill';
} | {
    kind: 'profile-switch';
} | {
    kind: 'display';
    target: 'think';
    value: 'on' | 'off';
} | {
    kind: 'btw';
    line: string;
} | {
    kind: 'onboard';
} | {
    kind: 'passthrough';
    name: string;
    line: string;
} | {
    kind: 'rejected';
    name: string;
};
/**
 * dsh commands forwarded verbatim to the host registry (design §4 透传表).
 * Deliberately EMPTY for now: the former entries are interactive on the
 * desktop (panels/selectors with no phone UI) — see UNADAPTED_COMMANDS.
 * A command becomes passthrough-eligible only when it acts on the
 * agent/session and returns plain text.
 */
export declare const PASSTHROUGH_COMMANDS: readonly string[];
/**
 * Commands owned by the desktop dsh-tui-pi plugin. Without that plugin they
 * do not exist in the runtime at all; with it they open desktop-only UI.
 * Either way the phone refuses them with a pointer to the desktop instead of
 * letting them fall through to the model as a prompt.
 */
export declare const TUI_PI_COMMANDS: readonly string[];
/**
 * Commands that exist in the dsh runtime (core or other plugins) but have no
 * phone adaptation yet — refused with a plain desktop pointer. Distinct tier
 * from TUI_PI_COMMANDS: these are not dsh-tui-pi's, so the reply must not
 * claim they are.
 */
export declare const UNADAPTED_COMMANDS: readonly string[];
/** Union of both refuse tiers (classification treats them the same). */
export declare const REJECTED_COMMANDS: readonly string[];
/** The reply text for refused commands. */
export declare function refusedReply(name: string): string;
/**
 * Classify one inbound text. Slash-prefixed lines that parse as command names
 * route by the tables above; everything else is a prompt (also the fallback
 * for unknown commands, matching dsh's fall-through).
 */
export declare function classifyInbound(text: string): Intent;
/** The /help text. */
export declare function helpText(bound: boolean): string;
