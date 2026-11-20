/**
 * platform-map.js — DSH 模型供应商 id → quota 面板平台 id 映射（M2 移植件）。
 *
 * 出处（NOTICE 已登记，MIT）：移植自 plugin-quota-multi/src/platform-map.ts `platformForProvider`
 * （上游为 Minokun/dsh-quota 0.14.10 的 fork dsh-quota-multi），连注释一起搬运、移植即冻结
 * （AGENTS §5：移植代码不再跟上游升级，端点/宿主 API 漂移写维护兜底）。
 *
 * mroute 侧用途（与上游不同，记录差异）：quota 插件用它在运行时自动认领供应商的额度卡；
 * mroute **不在运行时用映射结果自动采信数值**——采信依据只有注册表显式声明的
 * `quota_platform` + `quota_account_verified=true`（任务书 §3.8 红线：映射命中 ≠ 账户体系一致）。
 * 本函数仅用于注册表读侧交叉核对：显式声明与映射推导不一致时告警提示人工复核（registry.js）。
 */

/** 火山方舟在面板里的平台 id（额度行与 `/models` 探活兜底行共用）。 */
export const ARK_PLATFORM_ID = 'volcark'

/**
 * 小米 MiMo 按量（`api.xiaomimimo.com`）在面板里的平台 id。与 DSH 的
 * `xiaomi` 模型供应商 id 对齐（apiKeyEnv=`XIAOMI_API_KEY`），自动发现直接命中。
 */
export const XIAOMI_PLATFORM_ID = 'xiaomi'

/** 小米 MiMo Token Plan（`token-plan-*.xiaomimimo.com`）在面板里的平台 id。 */
export const XIAOMI_TOKEN_PLAN_PLATFORM_ID = 'xiaomi-token-plan'

/**
 * Magpie 本机网关在面板里的平台 id。额度行 id 是 `magpie#<provider>`
 * （同一 provider 多账号再带 `/user` 后缀），所以认领时按前缀匹配。
 */
export const MAGPIE_PLATFORM_ID = 'magpie'

/**
 * Map a model-provider id onto a quota platform id.
 * @param {string} provider - DSH 模型供应商 id（不区分大小写）。
 * @returns {string} 面板平台 id；没有对应平台时返回空串。
 */
export function platformForProvider(provider) {
  const p = String(provider ?? '').toLowerCase()
  // Magpie 放在最前：它的供应商 id 是 `magpie` / `magpie-anthropic` /
  // `magpie-responses`，后两个含 'anthropic'，会被下面的官方 Admin 映射
  // 抢先命中，于是把本机网关错认成 Anthropic 组织账号。
  if (p.includes('magpie')) return MAGPIE_PLATFORM_ID
  if (p.includes('kimi')) return 'kimi'
  if (p.includes('deepseek')) return 'deepseek'
  if (p.includes('zhipu') || p.includes('glm')) return 'zhipu'
  if (p.includes('zai')) return 'zhipu'
  if (p.includes('bigmodel')) return 'bigmodel'
  if (p.includes('qwen') || p.includes('dashscope')) return 'qianwen' // 注意：不带 'bailian'——自定义 bailian 供应商常是别人的 key，映射到自己账号的 MCP 行会显示错账号
  if (p.includes('scnet')) return 'scnet'
  if (p.includes('tokenrouter')) return 'tokenrouter'
  if (p.includes('moonshot')) return 'moonshot'
  if (p.includes('openrouter')) return 'openrouter'
  if (p.includes('siliconflow')) return 'siliconflow'
  if (p.includes('minimax')) return 'minimax'
  // 小米 MiMo（fork 新增）：Token Plan 供应商 id 含 'xiaomi-token-plan' /
  // 'mimo-token-plan'，必须排在通用 xiaomi 规则之前——通用规则是 includes
  // 匹配，放后面会把 tp 供应商错认到按量余额卡上（那把 key 查不了余额）。
  if (p.includes('xiaomi-token-plan') || p.includes('mimo-token-plan')) return XIAOMI_TOKEN_PLAN_PLATFORM_ID
  if (p.includes('xiaomi') || p.includes('mimo')) return XIAOMI_PLATFORM_ID
  if (p.includes('step')) return 'stepfun'
  if (p.includes('xai') || p.includes('grok')) return 'xai'
  if (p.includes('opendesign') || p.includes('open-design')) return 'opendesign'
  if (p.includes('opencode')) return 'opencode-go'
  if (p.includes('openai')) return 'openai-admin'
  if (p.includes('anthropic') || p.includes('claude')) return 'anthropic-admin'
  // 火山方舟：供应商 id 就是 ark（另有 volcengine / doubao 等常见写法）；别把
  // 'ark' 写成 includes 匹配——会误伤其它含 ark 的 id。
  if (p === 'ark' || p.includes('volc') || p.includes('doubao')) return ARK_PLATFORM_ID
  return ''
}
