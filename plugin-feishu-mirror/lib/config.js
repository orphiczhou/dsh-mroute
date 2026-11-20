/**
 * Plugin configuration: schema + validation + defaults. Sources, in ascending
 * priority: patch-file `config:` block, then `DSH_FEISHU_*` environment
 * variables. Secrets (app secret) are deliberately NOT accepted from the
 * static config schema except as an explicit escape hatch — prefer the dsh
 * credentials service or the env var; see README.
 */
import z from '@deepseek-ai/schemastery';
/** Runtime schema for {@link Config} (cordis validates the patch config with it). */
export const Config = z.object({
    mode: z.union([z.const('on'), z.const('off')]).default('on'),
    domain: z.union([z.const('feishu'), z.const('lark')]).default('feishu'),
    operators: z.array(z.string()).default([]),
    appId: z.string().default(''),
    appSecret: z.string().default(''),
    appIdRef: z.string().default('DSH_FEISHU_APP_ID'),
    appSecretRef: z.string().default('DSH_FEISHU_APP_SECRET'),
    statusIntervalMs: z.number().min(5000).max(600000).step(1).default(5000),
    bodySegmentChars: z.number().min(500).max(30000).step(1).default(3500),
    resumeListStyle: z.union([z.const('auto'), z.const('table'), z.const('list')]).default('auto'),
    btwContextMessages: z.number().min(0).max(50).step(1).default(6),
    backgroundPush: z.union([z.const('off'), z.const('cron'), z.const('all')]).default('off'),
    roundButtons: z.union([z.const('on'), z.const('off')]).default('off'),
    toolDetail: z.union([z.const('off'), z.const('brief'), z.const('full')]).default('off'),
    askRace: z.boolean().default(true),
    askRouterTakeover: z.boolean().default(false),
    mirrorMode: z.union([z.const('off'), z.const('group')]).default('off'),
    mirrorGroupPrefix: z.string().default('DSH'),
});
const CONFIG_KEYS = new Set([
    'mode', 'domain', 'operators', 'appId', 'appSecret', 'appIdRef', 'appSecretRef',
    'statusIntervalMs', 'bodySegmentChars', 'resumeListStyle', 'btwContextMessages',
    'backgroundPush', 'roundButtons', 'toolDetail', 'askRace', 'askRouterTakeover',
    'mirrorMode', 'mirrorGroupPrefix',
]);
function envString(env, key) {
    const value = env[key]?.trim();
    return value === undefined || value === '' ? undefined : value;
}
/** Boolean env override — accepts on/off, true/false, 1/0 (case-insensitive); junk = unset. */
function envBoolean(env, key) {
    const value = envString(env, key)?.toLowerCase();
    if (value === 'on' || value === 'true' || value === '1')
        return true;
    if (value === 'off' || value === 'false' || value === '0')
        return false;
    return undefined;
}
/**
 * Validate, default, and merge the static config with `DSH_FEISHU_*` env
 * overrides (`DSH_FEISHU_OPERATORS` is APPENDED to the config list; the rest
 * are first-wins). Throws on unknown keys (a typo'd patch config must not
 * silently disarm the bot).
 */
export function resolveConfig(config, env = process.env) {
    if (config !== undefined) {
        for (const key of Object.keys(config)) {
            if (!CONFIG_KEYS.has(key))
                throw new Error(`dsh-feishu: unknown config key "${key}"`);
        }
    }
    const domain = config?.domain === 'lark' ? 'lark' : 'feishu';
    const statusIntervalMs = config?.statusIntervalMs ?? 5000;
    if (!Number.isSafeInteger(statusIntervalMs) || statusIntervalMs < 5000 || statusIntervalMs > 600000) {
        throw new Error('dsh-feishu: statusIntervalMs must be an integer in [5000, 600000]');
    }
    const bodySegmentChars = config?.bodySegmentChars ?? 3500;
    if (!Number.isSafeInteger(bodySegmentChars) || bodySegmentChars < 500 || bodySegmentChars > 30000) {
        throw new Error('dsh-feishu: bodySegmentChars must be an integer in [500, 30000]');
    }
    const resumeListStyle = config?.resumeListStyle ?? 'auto';
    if (resumeListStyle !== 'auto' && resumeListStyle !== 'table' && resumeListStyle !== 'list') {
        throw new Error('dsh-feishu: resumeListStyle must be one of "auto", "table", "list"');
    }
    const btwConfigValue = config?.btwContextMessages;
    if (btwConfigValue !== undefined && (!Number.isSafeInteger(btwConfigValue) || btwConfigValue < 0 || btwConfigValue > 50)) {
        throw new Error('dsh-feishu: btwContextMessages must be an integer in [0, 50]');
    }
    const envPush = envString(env, 'DSH_FEISHU_BACKGROUND_PUSH');
    const pushValue = config?.backgroundPush ?? (envPush === 'cron' || envPush === 'all' ? envPush : undefined);
    const backgroundPush = pushValue === 'cron' || pushValue === 'all' ? pushValue : 'off';
    const envRoundButtons = envString(env, 'DSH_FEISHU_ROUND_BUTTONS');
    const buttonsValue = config?.roundButtons ?? (envRoundButtons === 'on' || envRoundButtons === 'off' ? envRoundButtons : undefined);
    const roundButtons = buttonsValue === 'on' ? 'on' : 'off';
    const envToolDetail = envString(env, 'DSH_FEISHU_TOOL_DETAIL');
    const toolDetailValue = config?.toolDetail
        ?? (envToolDetail === 'off' || envToolDetail === 'brief' || envToolDetail === 'full' ? envToolDetail : undefined);
    if (toolDetailValue !== undefined && toolDetailValue !== 'off' && toolDetailValue !== 'brief' && toolDetailValue !== 'full') {
        throw new Error('dsh-feishu: toolDetail must be one of "off", "brief", "full"');
    }
    const toolDetail = toolDetailValue ?? 'off';
    const askRace = config?.askRace ?? envBoolean(env, 'DSH_FEISHU_ASK_RACE') ?? true;
    const askRouterTakeover = config?.askRouterTakeover ?? envBoolean(env, 'DSH_FEISHU_ASK_ROUTER_TAKEOVER') ?? false;
    const mirrorMode = config?.mirrorMode === 'group' ? 'group' : 'off';
    const mirrorGroupPrefix = (config?.mirrorGroupPrefix ?? 'DSH').trim() || 'DSH';
    const configAppId = config?.appId?.trim();
    const configAppSecret = config?.appSecret?.trim();
    // DSH_FEISHU_OPERATORS (comma-separated open_ids) EXTENDS the config list —
    // the dormant-state warning has long promised this variable to users, so the
    // resolver must actually read it. Entries are trimmed; empties are dropped.
    const envOperators = env.DSH_FEISHU_OPERATORS;
    const envOperatorList = envOperators === undefined || envOperators.trim() === ''
        ? []
        : envOperators.split(',').map(id => id.trim()).filter(id => id !== '');
    // Ref names must be valid environment-variable-style identifiers — the host
    // credentials service rejects anything else (dsh-credentials REF_PATTERN),
    // and a ref written under an invalid name bricks the NEXT dsh boot with a
    // parse error. The v0.13.0 defaults carried hyphens (`dsh-feishu-app-id`);
    // any configured ref outside the grammar is swapped for the legal default.
    const REF_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
    const appIdRef = config?.appIdRef !== undefined && REF_NAME.test(config.appIdRef)
        ? config.appIdRef
        : 'DSH_FEISHU_APP_ID';
    const appSecretRef = config?.appSecretRef !== undefined && REF_NAME.test(config.appSecretRef)
        ? config.appSecretRef
        : 'DSH_FEISHU_APP_SECRET';
    return Object.freeze({
        mode: config?.mode === 'off' ? 'off' : 'on',
        domain,
        operators: Object.freeze([...(config?.operators ?? []), ...envOperatorList]),
        appId: configAppId && configAppId !== '' ? configAppId : envString(env, 'DSH_FEISHU_APP_ID'),
        appSecret: configAppSecret && configAppSecret !== ''
            ? configAppSecret
            : envString(env, 'DSH_FEISHU_APP_SECRET'),
        appIdRef,
        appSecretRef,
        statusIntervalMs,
        bodySegmentChars,
        resumeListStyle,
        btwContextMessages: btwConfigValue ?? 6,
        backgroundPush,
        roundButtons,
        toolDetail,
        askRace,
        askRouterTakeover,
        mirrorMode,
        mirrorGroupPrefix,
    });
}
//# sourceMappingURL=config.js.map