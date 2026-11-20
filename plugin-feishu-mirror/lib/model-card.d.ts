/**
 * /model interactive selection cards: two-step flow — pick a provider, then
 * pick one of its models. Pure builders/parsers over the llm service's
 * provider/model metadata; same card.action.trigger mechanics as the ask
 * and resume cards (submit buttons MUST carry a `value` — 200340).
 *
 * Applying the choice is the bot's job: live-switch when the bound session
 * carries a bot-owned selection ref, otherwise store it as the phone-side
 * default for future /new sessions.
 */
import type { Schema2Card } from './card.ts';
/** Marker for the provider-step submit button's `value.action`. */
export declare const MODEL_PROVIDER_ACTION = "dsh_feishu_model_provider";
/** Marker for the model-step submit button's `value.action`. */
export declare const MODEL_SUBMIT_ACTION = "dsh_feishu_model_submit";
/** Minimal provider/model metadata the cards render (llm service shapes). */
export interface ModelProviderInfo {
    readonly id: string;
    readonly name: string;
}
export interface ModelInfo {
    readonly id: string;
    readonly name: string;
    readonly description?: string;
    /** Combined request+response context window in tokens, when the adapter reports it. */
    readonly contextWindow?: number;
}
/** One recognized provider-step submit. */
export interface ParsedModelProviderAction {
    readonly provider: string;
    readonly flowId: string;
}
/** One recognized model-step submit. */
export interface ParsedModelSubmitAction {
    readonly flowId: string;
    readonly model: string;
}
/**
 * Recognize the provider-step submit: button `value` carries our action
 * marker + the provider id; the button `name` doubles as the fallback id
 * carrier. Undefined for anything else.
 */
export declare function parseModelProviderAction(data: unknown): ParsedModelProviderAction | undefined;
/**
 * Recognize the model-step submit: button `value` carries our action marker
 * + the flow id; the model itself arrives in `form_value.model`.
 */
export declare function parseModelSubmitAction(data: unknown): ParsedModelSubmitAction | undefined;
/** Step-1 card: pick a provider (dropdown + submit), current route shown. */
export declare function buildModelProviderCard(providers: readonly ModelProviderInfo[], flowId: string, current?: {
    provider?: string;
    model?: string;
}): Schema2Card;
/**
 * Step-2 card: pick one of the provider's models. The provider rides in the
 * submit `value` so the handler does not need to remember it.
 */
export declare function buildModelPickCard(provider: string, models: readonly ModelInfo[], flowId: string): Schema2Card;
/** Terminal card: the provider step is done — the flow moved to model pick (grey). */
export declare function buildModelProviderSettledCard(provider: string): Schema2Card;
/** Terminal card: the selection was applied (green). */
export declare function buildModelSettledCard(provider: string, model: string, note?: string): Schema2Card;
