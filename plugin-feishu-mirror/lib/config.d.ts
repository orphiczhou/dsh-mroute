/**
 * Plugin configuration: schema + validation + defaults. Sources, in ascending
 * priority: patch-file `config:` block, then `DSH_FEISHU_*` environment
 * variables. Secrets (app secret) are deliberately NOT accepted from the
 * static config schema except as an explicit escape hatch — prefer the dsh
 * credentials service or the env var; see README.
 */
import z from '@deepseek-ai/schemastery';
/** Plugin configuration as written in the patch-file `config:` block. */
export interface Config {
    /** `off` disables the plugin entirely (default `on`). */
    mode?: 'on' | 'off';
    /** Feishu tenant (default) or Lark. */
    domain?: 'feishu' | 'lark';
    /**
     * Operator open_id allowlist. REQUIRED to arm the bot — an empty list
     * leaves the bot inert (it connects to nothing and replies to nobody).
     */
    operators?: string[];
    /**
     * Plaintext app id (not secret). Preferred sources: credentials service ref
     * or DSH_FEISHU_APP_ID.
     */
    appId?: string;
    /**
     * Plaintext app secret — escape hatch for local tests ONLY. Preferred
     * sources: credentials service ref or DSH_FEISHU_APP_SECRET.
     */
    appSecret?: string;
    /** Credentials-service ref for the app id (default `DSH_FEISHU_APP_ID`). */
    appIdRef?: string;
    /** Credentials-service ref for the app secret (default `DSH_FEISHU_APP_SECRET`). */
    appSecretRef?: string;
    /** Status-card update beat in ms (default 5000 — pseudo-streaming; clamped to [5000, 600000]). */
    statusIntervalMs?: number;
    /**
     * Minimum interval between mid-turn progress-card pushes in ms
     * (default 180000 = 3 min; clamped to [30000, 3600000]). Output produced
     * inside the window merges into the next push.
     */
    /** Long assistant bodies are segmented for Feishu at this size (default 3500). */
    bodySegmentChars?: number;
    /**
     * `/resume` list rendering style (default `auto`): `auto` sends the native
     * table card first and falls back to a markdown ordered list when the send
     * fails; `table` / `list` force one renderer.
     */
    resumeListStyle?: 'auto' | 'table' | 'list';
    /**
     * Recent-conversation messages carried into a `/btw` side call
     * (default 6, clamped to [0, 50]; 0 = no snapshot). Parity with
     * dsh-tui-pi's DSH_TUI_BTW_CONTEXT_MESSAGES knob.
     */
    btwContextMessages?: number;
    /**
     * Background completion push for sessions the phone is NOT bound to
     * (default `off` — the bot never messages unprompted unless told to):
     * `cron` pushes turns that carried a cron delivery or a subagent-settled
     * notice; `all` pushes every completed turn. Delivered to the last active
     * chat. Override: DSH_FEISHU_BACKGROUND_PUSH.
     */
    backgroundPush?: 'off' | 'cron' | 'all';
    /**
     * Quick-action buttons on the round cards (default `off`): `on` renders
     * ⛔ 停止 under the live card and ▶️ 继续 under the ended card. Off keeps
     * both buttons out — stopping still works via the `/stop` command (which
     * asks for a confirmation). Override: DSH_FEISHU_ROUND_BUTTONS.
     */
    roundButtons?: 'on' | 'off';
    /**
     * Surface tool arguments on the round card's activity section (default
     * `off`, which keeps today's output byte-for-byte). `brief` shows a
     * whitespace-folded, clipped single-line digest of the raw arguments JSON;
     * `full` keeps the multi-line shape, clipped at a larger budget.
     * Override: DSH_FEISHU_TOOL_DETAIL.
     */
    toolDetail?: 'off' | 'brief' | 'full';
    /**
     * Ask/approval prepend + race against the host's client bridge (default
     * `on`): register the phone answerer at the waterfall head and let the
     * GUI/phone surfaces race for bound sessions. `off` keeps the legacy
     * tail-registered, claim-and-consume behaviour byte-for-byte.
     * Override: DSH_FEISHU_ASK_RACE.
     */
    askRace?: boolean;
    /**
     * Escape hatch for an unpatched dsh-ask-router (default `off`): when an
     * `askSurfaces` service is present AND askRace is on, `on` skips
     * `router.register` and races on the standalone waterfall instead. `off`
     * keeps today's router path. Never both — a takeover must not stack a
     * second card. Override: DSH_FEISHU_ASK_ROUTER_TAKEOVER.
     */
    askRouterTakeover?: boolean;
}
/** Runtime schema for {@link Config} (cordis validates the patch config with it). */
export declare const Config: z<Config>;
/** Fully resolved, immutable runtime configuration. */
export interface ResolvedConfig {
    readonly mode: 'on' | 'off';
    readonly domain: 'feishu' | 'lark';
    readonly operators: readonly string[];
    readonly appId: string | undefined;
    readonly appSecret: string | undefined;
    readonly appIdRef: string;
    readonly appSecretRef: string;
    readonly statusIntervalMs: number;
    readonly bodySegmentChars: number;
    readonly resumeListStyle: 'auto' | 'table' | 'list';
    readonly btwContextMessages: number;
    readonly backgroundPush: 'off' | 'cron' | 'all';
    readonly roundButtons: 'on' | 'off';
    readonly toolDetail: 'off' | 'brief' | 'full';
    readonly askRace: boolean;
    readonly askRouterTakeover: boolean;
}
/**
 * Validate, default, and merge the static config with `DSH_FEISHU_*` env
 * overrides (`DSH_FEISHU_OPERATORS` is APPENDED to the config list; the rest
 * are first-wins). Throws on unknown keys (a typo'd patch config must not
 * silently disarm the bot).
 */
export declare function resolveConfig(config: Config | undefined, env?: NodeJS.ProcessEnv): ResolvedConfig;
