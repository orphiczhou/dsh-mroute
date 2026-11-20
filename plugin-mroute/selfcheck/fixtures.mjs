/**
 * selfcheck/fixtures.mjs — quota 快照 fixture 集（形态证据 = plugin-quota-multi/src/config.ts
 * ProviderSnapshot/QuotaItem + direct.ts 各 format 的条目实测）。
 * 覆盖：providers ok（含余额）/ ok（无余额 usage 型）/ error / missing-key、
 * display 兜底解析、畸形行、HTML 响应、坏 JSON。
 */

/** 正常快照：xiaomi（verified 渠道代表，余额行 '总可用余额'+remaining，direct.ts:493 实测形态）、
 *  deepseek（'CNY 总余额' label，direct.ts:278）、zhipu（missing-key——zai-coding-cn 的映射目标）、
 *  opencode-go（ok 但 usage 型无余额行）、magpie（'账户余额' display 兜底解析形态，magpie.ts:205）。 */
export const SNAPSHOT_OK = {
  refreshedAt: '2026-11-15T03:00:00.000Z',
  refreshing: false,
  providers: [
    {
      id: 'xiaomi',
      label: '小米 MiMo',
      status: 'ok',
      via: 'api',
      keyRef: 'XIAOMI_API_KEY',
      keySource: 'user-env',
      items: [
        { label: '总可用余额', display: '¥57.93', remaining: 57.93 },
        { label: '近 7 天消耗', display: '¥23.57' },
        { label: '近 7 天 Tokens', display: '82,540,000' },
      ],
    },
    {
      id: 'deepseek',
      label: 'DeepSeek',
      status: 'ok',
      via: 'api',
      keyRef: 'DEEPSEEK_API_KEY',
      keySource: 'user-env',
      items: [{ label: 'CNY 总余额', display: '¥42.50', remaining: 42.5 }],
    },
    {
      id: 'zhipu',
      label: '智谱 Coding Plan',
      status: 'missing-key',
      message: '未配置 ZAI_CODING_CN_API_KEY / ZHIPU_API_KEY',
      items: [],
    },
    {
      id: 'opencode-go',
      label: 'OpenCode Go',
      status: 'ok',
      via: 'api',
      keyRef: 'OPENCODE_GO_API_KEY',
      items: [{ label: '周窗口', percent: 28, resetAt: '2026-11-17T00:00:00Z' }],
    },
    {
      id: 'magpie',
      label: 'Magpie',
      status: 'ok',
      via: 'api',
      items: [{ label: '账户余额', display: '¥284.73' }],
    },
    {
      id: 'broken-platform',
      label: 'Broken',
      status: 'error',
      message: 'boom（模拟上游失败）',
      items: [],
    },
  ],
  currentModel: { provider: 'zai-coding-cn', model: 'glm-4.6', platform: 'zhipu', summary: '周额度 剩68' },
  providerKeyRefs: { 'xiaomi': 'XIAOMI_API_KEY', 'deepseek-official': 'DEEPSEEK_API_KEY' },
}

/** 空渠道快照（§6.2：providers 空 → 对应渠道回落 manual）。 */
export const SNAPSHOT_EMPTY = { refreshedAt: '2026-11-15T03:05:00.000Z', refreshing: false, providers: [] }

/** 全 missing-key 快照（§6.2：全 missing-key → 渠道回落 manual，行状态透出）。 */
export const SNAPSHOT_ALL_MISSING_KEY = {
  refreshedAt: '2026-11-15T03:10:00.000Z',
  refreshing: false,
  providers: [
    { id: 'xiaomi', label: '小米 MiMo', status: 'missing-key', message: '未配置 XIAOMI_API_KEY', items: [] },
  ],
}

/** 畸形快照：providers 元素混入 null / 数字 / 无 id 对象（归一化必须跳过不炸，红线 §5.5 渠道隔离）。 */
export const SNAPSHOT_MALFORMED = {
  refreshedAt: '2026-11-15T03:15:00.000Z',
  refreshing: false,
  providers: [null, 42, 'x', { id: '', label: 'no-id' }, { id: 'xiaomi', status: 'ok', items: [{ label: '总可用余额', display: '¥9.90', remaining: 9.9 }] }],
}

/**
 * 多账号快照（M2 补修，lead 2026-11-15 实测反馈）：多账号平台行 id 是 `<平台id>#<keyRef>` 形态
 * （实测 opencode-go#OPENCODE_GO_API_KEY / opencode-go#OPENCODEGOSOTA_API_KEY；controller.ts
 * MAGPIE 注释同款前缀认领模式）。xiaomi 保持裸 id（单账号精确匹配路径回归）。
 */
export const SNAPSHOT_MULTI_ACCOUNT = {
  refreshedAt: '2026-11-15T04:00:00.000Z',
  refreshing: false,
  providers: [
    {
      id: 'opencode-go#OPENCODE_GO_API_KEY',
      label: 'OpenCode Go',
      status: 'ok',
      via: 'api',
      keyRef: 'OPENCODE_GO_API_KEY',
      items: [{ label: '总可用余额', display: '$10.00', remaining: 10 }],
    },
    {
      id: 'opencode-go#OPENCODEGOSOTA_API_KEY',
      label: 'OpenCode Go',
      status: 'ok',
      via: 'api',
      keyRef: 'OPENCODEGOSOTA_API_KEY',
      items: [{ label: '总可用余额', display: '$20.00', remaining: 20 }],
    },
    { id: 'xiaomi', label: '小米 MiMo', status: 'ok', items: [{ label: '总可用余额', display: '¥57.93', remaining: 57.93 }] },
  ],
  providerKeyRefs: { 'opencode-go': 'OPENCODEGOSOTA_API_KEY' },
}

/** 200+HTML 陷阱体（07a 宿主侧配套 4）。 */
export const HTML_BODY = '<html><body><h1>Gateway Error</h1></body></html>'

/** 坏 JSON 体。 */
export const BAD_JSON_BODY = '{"refreshedAt": "oops",,'
