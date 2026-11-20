/**
 * /new session-config card: ONE form the operator fills before a session is
 * minted — agent preset, model, and reasoning effort as three `select_static`
 * dropdowns, submitted together. Pure builders/parsers, same hard-won card
 * constraints as the ask / resume / model / selector cards:
 * - every BUTTON must carry a `value` (200340 client rejection otherwise);
 * - the button `name` doubles as the flow-id carrier (SDK versions may strip
 *   `value` from submits);
 * - schema 2.0 cards must not contain `note` elements (200861).
 *
 * Every dropdown is OPTIONAL at build time: a field the bot could not source
 * (no presets service on this profile, no models known) is omitted entirely
 * and its submit key simply stays absent — the bot falls back to its own
 * default-resolution chain for whatever the card did not offer.
 */
import type { Schema2Card } from './card.ts';
/** Marker written into the form submit / cancel buttons' `value.action`. */
export declare const NEW_SESSION_ACTION = "dsh_feishu_new";
/** One dropdown choice: `value` rides form_value, `label` renders. */
export interface NewCardChoice {
    readonly value: string;
    readonly label: string;
}
/** The dropdowns the card offers; absent field = no dropdown. */
export interface NewSessionCardSpec {
    /**
     * EXISTING workspaces only (`value` = the workspace path, used verbatim as
     * the new session's cwd) — the operator never types a path. The caller
     * decides NA policy; an empty environment never reaches the card.
     */
    readonly workspaces?: readonly NewCardChoice[];
    readonly defaultWorkspace?: string;
    /** Agent presets (`value` = preset id); `defaultPreset` preselects. */
    readonly presets?: readonly NewCardChoice[];
    readonly defaultPreset?: string;
    /** Models of the resolved default provider (`value` = model id). */
    readonly models?: readonly NewCardChoice[];
    readonly defaultModel?: string;
    /** Reasoning efforts of the default model; `defaultEffort` preselects. */
    readonly efforts?: readonly NewCardChoice[];
    readonly defaultEffort?: string;
    /** Context line under the title (current route, provider notes). */
    readonly contextLine?: string;
}
/** What the operator submitted (absent key = the field was not offered). */
export interface NewSessionPicks {
    /** Workspace PATH — used verbatim as the new session's cwd. */
    readonly workspace?: string;
    readonly preset?: string;
    readonly model?: string;
    readonly effort?: string;
}
/** Summary row of the created-confirmation card. */
export interface NewSummaryRow {
    readonly field: string;
    readonly value: string;
}
/** The interactive config card (blue): fill the form, tap 开始新会话. */
export declare function buildNewSessionCard(spec: NewSessionCardSpec, flowId: string): Schema2Card;
/**
 * The submit's summary as bold per-row lines (what the operator picked).
 * Deliberately NOT a GFM table — Feishu mobile clients render table markdown
 * as raw pipes (reads as mojibake); bullets render everywhere.
 */
export declare function newSummaryLines(rows: readonly NewSummaryRow[]): string;
/** Terminal card: the session was minted (green) with the pick summary. */
export declare function buildNewSessionCreatedCard(rows: readonly NewSummaryRow[], sessionId: string): Schema2Card;
/** Terminal card: creation failed after submit (orange) with the reason. */
export declare function buildNewSessionFailedCard(reason: string): Schema2Card;
/** Terminal card: cancelled (grey) — for the record. */
export declare function buildNewSessionCancelledCard(): Schema2Card;
/** Terminal card: the flow expired before submit (grey). */
export declare function buildNewSessionExpiredCard(): Schema2Card;
/**
 * One recognized card.action.trigger payload for the /new card; undefined for
 * anything else. Same ladder as the selector parser: the button `value.action`
 * marker wins (flow id + cancel flag + the form_value picks); a DIFFERENT
 * string marker means a foreign button (undefined — the name fallback must
 * never fire on it); the `name` prefix fallback covers SDK versions that strip
 * submit values (picks still arrive via form_value; a stripped cancel degrades
 * to an empty submit, which the caller treats as defaults-only).
 */
export declare function parseNewSessionAction(data: unknown, buttonName?: string): {
    flowId: string;
    cancelled?: boolean;
    picks: NewSessionPicks;
} | undefined;
