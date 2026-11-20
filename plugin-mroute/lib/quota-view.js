/**
 * quota-view.js — quota 面板快照 providers[] → mroute QuotaView 归一化（M2）。
 *
 * QuotaView 契约（mroute/07a-balance-adapters.md §推荐适配器接口：机读视图、上游原始 JSON
 * 不出宿主）+ 本文件按 quota 插件实际快照形状（plugin-quota-multi/src/config.ts:111-124
 * ProviderSnapshot）落码。纪律：
 * - `balance_source:'machine'`、`source:'quota-plugin'`、`as_of=refreshedAt`（任务书 §4.3）；
 * - items 按 label 匹配余额条目（label 语义映射表写死+注释，见 BALANCE_LABELS）；
 * - `remaining` 数值优先，`display` 字符串兜底解析数字；解析失败**不伪造 0**（07a 契约
 *   「缺失绝不伪造 0%」同款纪律）；
 * - 渠道间错误隔离（红线 §5.5）：单平台行畸形只跳过该行，不拖垮整表归一化。
 *
 * M4 增量（0.5.0，窗口型余额语义）：包月渠道（zai-coding-cn→zhipu、opencode-go）的 quota
 * 卡片只有「已用 N%」窗口文本，没有金额 remaining，M2 因此整行回落 manual。现按确定性规则
 * 归一化为三种模式（`mode`，向后兼容：remaining/currency/display/as_of/source/degraded 全保留）：
 *
 *   ① **window**（优先）：row.items 里存在 display 命中 `已用 N%` 的窗口项 →
 *      `mode='window'`，`windows=[{label,used_pct,text}]`（顺序=快照 items 顺序），
 *      `worst_used_pct=max(...)`，`display` 生成紧凑串（如 `5h 4% · 本周 8% · 本月 4%`），
 *      `balance/currency=null`。**窗口模式先于金额模式判定**：真实 zhipu 行同时含
 *      `账户余额 ¥0.94` / `累计消费 ¥140`，这两项是账户语义、不是包月渠道可用额度
 *      （M2 红线「账户语义不同」）——只要存在窗口项就绝不取 ¥ 项。
 *   ② **amount**：无窗口项，且存在可解析金额数值（label 命中闭集 + remaining 数值，
 *      或 label 命中 + display 可解析）→ `mode='amount'`（M2 现状不变）。
 *   ③ **status**：无窗口、无金额，但存在纯状态文本（如 `在线`，不含数字）→
 *      `mode='status'`，`display` 用原文。
 *   ④ 全无 → `mode=null`（现行回落 manual 判据不变，tool-query 标注原因）。
 *
 * 窗口解析只认 **display 里的 `已用 N%`**，绝不回退 item.percent：真实快照的
 * `搜索/工具额度` 也带 percent=12.2（配额用量，不是时间窗口），按 percent 猜会误判。
 */

/**
 * 余额型条目 label 语义映射表（写死+注释；证据 = plugin-quota-multi/src/direct.ts 实读）。
 * 命中判定 = 精确匹配闭集 ∪ 以 '总余额' 结尾（deepseek-balance 的 `${currency} 总余额`）。
 * 用量窗口型条目（'5h 窗口'/'周额度'/'今日消耗' 等）不在表内——它们不是余额，不伪造余额数值。
 *
 * | label               | format（出处 direct.ts）            | 证据行号 |
 * |---------------------|--------------------------------------|---------|
 * | 总可用余额          | xiaomi-balance（'same convention as deepseek-balance'） | direct.ts:493 |
 * | <CURRENCY> 总余额   | deepseek-balance                     | direct.ts:278 |
 * | 余额                | openrouter/siliconflow/moonshot/stepfun/xai | direct.ts:297/306/316/323/333 |
 * | 账户余额            | magpie / MCP bigmodel / MCP qianwen  | magpie.ts:205 / mcp.ts:273/706 |
 * | 账户余额 (USD)      | newapi-account 自定义平台            | direct.ts:1138 |
 * | 钱包余额            | opendesign                           | direct.ts:922 |
 * | 预付余额            | openai-admin                         | direct.ts:409/411/442 |
 * | USD 余额            | venice/deepinfra 族                  | direct.ts:425 |
 * | 额度 (USD)          | openai-billing / tokenrouter MCP（套餐额度，remaining 语义） | direct.ts:1106-1108 / mcp.ts:396 |
 */
export const BALANCE_LABELS = [
  '总可用余额',
  '余额',
  '账户余额',
  '账户余额 (USD)',
  '钱包余额',
  '预付余额',
  'USD 余额',
  '额度 (USD)',
]

/**
 * 窗口型用量文本正则：只认 display 里的 `已用 N%`（真实快照 zhipu/opencode-go 的窗口项形态，
 * 如 `已用 1%` / `已用 12.2%`）。`已用 $0.5 · 无限额度` 这类**金额型已用量**没有 `%`，不命中。
 */
export const WINDOW_USED_RE = /已用\s*(\d+(?:\.\d+)?)\s*%/

/**
 * label 是否命中余额语义闭集。
 * @param {string} label
 * @returns {boolean}
 */
export function isBalanceLabel(label) {
  if (typeof label !== 'string') return false
  if (BALANCE_LABELS.includes(label)) return true
  return label.endsWith('总余额') // deepseek-balance 的 `${currency} 总余额`（direct.ts:278）
}

/**
 * display 字符串兜底解析数字（带形态守卫）：串必须以币符（¥/$）或数字开头才解析——
 * '已用 $0.5 · 无限额度'（openai-billing unlimited 行，direct.ts:1106）这类**已用量**串
 * 以汉字开头，直接判 null，防止把已用量误当余额；解析失败返回 null（不伪造 0）。
 * '¥57.93' → 57.93；'$1,234.5' → 1234.5；'已用 1,234 / 5,678 credits' → null。
 * @param {string} display
 * @returns {number|null}
 */
export function parseDisplayNumber(display) {
  if (typeof display !== 'string') return null
  const head = display.trimStart()
  if (!/^[¥$\d-]/.test(head)) return null
  const m = /-?\d[\d,]*(?:\.\d+)?/.exec(head.replace(/\s+/g, ''))
  if (!m) return null
  const n = Number.parseFloat(m[0].replace(/,/g, ''))
  return Number.isFinite(n) ? n : null
}

/**
 * 窗口项 `已用 N%` 解析（M4）。
 * @param {*} display
 * @returns {number|null} 0–100 的百分比数值；非 `已用 N%` 形态 → null
 */
export function parseWindowUsedPct(display) {
  if (typeof display !== 'string') return null
  const m = WINDOW_USED_RE.exec(display)
  if (!m) return null
  const n = Number.parseFloat(m[1])
  if (!Number.isFinite(n) || n < 0) return null
  return n
}

/**
 * 窗口 label 紧凑化（只用于 display 串；windows[].label 保留原文）。
 * 规则：5 小时/5h → `5h`；本周/周 → `本周`；本月/月 → `本月`；其余去掉「窗口」后缀。
 * @param {string} label
 * @returns {string}
 */
export function shortWindowLabel(label) {
  const raw = typeof label === 'string' ? label.trim() : ''
  if (raw === '') return '窗口'
  if (/5\s*(?:h|小时)/i.test(raw)) return '5h'
  if (raw.includes('周')) return '本周'
  if (raw.includes('月')) return '本月'
  const stripped = raw.replace(/窗口$/, '').trim()
  return stripped === '' ? raw : stripped
}

/**
 * 从 items 提取窗口项（M4，顺序=快照原序）。
 * 只认 display 的 `已用 N%`（见头注：percent 字段有非窗口用途，不采信）。
 * @param {object[]} items
 * @returns {{label:string, used_pct:number, text:string}[]}
 */
export function windowItemsOf(items) {
  const rows = Array.isArray(items) ? items : []
  const windows = []
  for (const item of rows) {
    if (item === null || typeof item !== 'object') continue
    const used = parseWindowUsedPct(item.display)
    if (used === null) continue
    const label = typeof item.label === 'string' && item.label.trim() !== '' ? item.label.trim() : '窗口'
    windows.push({ label, used_pct: used, text: item.display.trim() })
  }
  return windows
}

/**
 * 窗口模式 display 紧凑串：`5h 4% · 本周 8% · 本月 4%`（顺序按快照 items 顺序）。
 * @param {{label:string, used_pct:number}[]} windows
 * @returns {string}
 */
export function compactWindowDisplay(windows) {
  const rows = Array.isArray(windows) ? windows : []
  return rows.map((row) => `${shortWindowLabel(row.label)} ${row.used_pct}%`).join(' · ')
}

/** 币种识别：display 首个币符（¥→CNY、$→USD），识别不出 → null。label 前缀币种（'CNY 总余额'）作兜底。 */
export function currencyOf(display, label) {
  const d = typeof display === 'string' ? display.trim() : ''
  if (d.startsWith('¥')) return 'CNY'
  if (d.startsWith('$')) return 'USD'
  const l = typeof label === 'string' ? label : ''
  const prefix = /^(CNY|USD)\s/.exec(l)
  if (prefix) return prefix[1]
  return null
}

/**
 * 单平台行 → 归一化余额视图（该平台行的余额语义摘要；原始 row 绝不透出）。
 *
 * 模式判定顺序见文件头注（window → amount → status → null）。`mode` 恒在视图形状里，
 * 便于消费方分支；`windows`/`worst_used_pct` 只在 window 模式出现（可选键，不污染金额行）。
 *
 * @param {object} row ProviderSnapshot（config.ts:111-124）
 * @param {string} asOf 快照 refreshedAt
 * @returns {{ balance_source:'machine', source:'quota-plugin', as_of:string, status:string,
 *             balance:number|null, currency:string|null, display:string|null,
 *             message:string|null, mode:'amount'|'window'|'status'|null,
 *             windows?:{label:string,used_pct:number,text:string}[], worst_used_pct?:number }}
 */
export function platformViewOf(row, asOf) {
  const status = typeof row.status === 'string' ? row.status : 'error'
  const items = Array.isArray(row.items) ? row.items.filter((it) => it !== null && typeof it === 'object') : []
  // message 人读失败详情：quota 插件快照不含密钥值（config.ts:4 模块注释明证，§3.7 红线），
  // 可透出；截断 120 字符防超长。
  const message = typeof row.message === 'string' && row.message !== '' ? row.message.slice(0, 120) : null

  // ① window（先于金额）：存在 `已用 N%` 窗口项即窗口模式，绝不把同行的账户余额/累计消费当额度。
  const windows = windowItemsOf(items)
  if (windows.length > 0) {
    return {
      balance_source: 'machine',
      source: 'quota-plugin',
      as_of: asOf,
      status,
      balance: null,
      currency: null,
      display: compactWindowDisplay(windows),
      message,
      mode: 'window',
      windows,
      worst_used_pct: Math.max(...windows.map((w) => w.used_pct)),
    }
  }

  // ② amount：M2 现状不变（label 命中 + remaining 优先；其次 label 命中 + display 兜底解析）。
  // 多币种行（deepseek 可能同时返回 CNY/USD 两行）：取第一个可解析行，避免跨币种相加。
  let picked = null
  for (const item of items) {
    if (!isBalanceLabel(item.label)) continue
    const remaining = typeof item.remaining === 'number' && Number.isFinite(item.remaining) ? item.remaining : null
    if (remaining !== null) {
      picked = { balance: remaining, currency: currencyOf(item.display, item.label), display: typeof item.display === 'string' ? item.display : null }
      break
    }
    if (picked === null) {
      const parsed = parseDisplayNumber(item.display)
      if (parsed !== null) {
        // display 兜底 = 没有数值字段的 ¥ 项：必须标明来源 label（任务书交付 A 红线：
        // 「仅当没有任何窗口项时才允许用 ¥ 项，且必须在 display 里标明来源 label」）。
        const label = typeof item.label === 'string' ? item.label.trim() : ''
        picked = {
          balance: parsed,
          currency: currencyOf(item.display, item.label),
          display: typeof item.display === 'string' ? `${label === '' ? '余额' : label} ${item.display.trim()}` : null,
        }
      }
    }
  }
  if (picked !== null) {
    return {
      balance_source: 'machine',
      source: 'quota-plugin',
      as_of: asOf,
      status,
      balance: picked.balance,
      currency: picked.currency,
      display: picked.display,
      message,
      mode: 'amount',
    }
  }

  // ③ status：纯状态文本（'在线' 等，不含数字）→ 原文展示；不是余额，不伪造数值。
  let statusText = null
  for (const item of items) {
    const text = typeof item.display === 'string' ? item.display.trim() : ''
    if (text === '' || /\d/.test(text)) continue
    statusText = text
    break
  }
  return {
    balance_source: 'machine',
    source: 'quota-plugin',
    as_of: asOf,
    status,
    balance: null,
    currency: null,
    display: statusText,
    message,
    mode: statusText === null ? null : 'status',
  }
}

/**
 * 整快照归一化：providers[] → by_platform Map（quota 平台 id → 视图）。
 * 畸形行（null/非对象/无 id）跳过不炸（渠道间错误隔离）。
 * @param {object} snapshot quota-source 裁剪后的快照（refreshedAt/providers 必在，见 quota-source.js）
 * @returns {{ source:'quota-plugin', balance_source:'machine', as_of:string,
 *             by_platform:Map<string,object>, current_model:object|null,
 *             provider_key_refs:object }|null}
 */
export function normalizeQuotaSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return null
  const asOf = typeof snapshot.refreshedAt === 'string' ? snapshot.refreshedAt : ''
  const rows = Array.isArray(snapshot.providers) ? snapshot.providers : []
  const byPlatform = new Map()
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue
    if (typeof row.id !== 'string' || row.id === '') continue
    byPlatform.set(row.id, platformViewOf(row, asOf))
  }
  return {
    source: 'quota-plugin',
    balance_source: 'machine',
    as_of: asOf,
    by_platform: byPlatform,
    current_model:
      snapshot.currentModel && typeof snapshot.currentModel === 'object' ? snapshot.currentModel : null,
    provider_key_refs:
      snapshot.providerKeyRefs && typeof snapshot.providerKeyRefs === 'object' ? snapshot.providerKeyRefs : {},
  }
}

/**
 * 平台行选取（M2 补修，lead 2026-11-15 实测反馈）：多账号平台的行 id 是 `<平台id>#<keyRef>`
 * 形态（实测 `opencode-go#OPENCODE_GO_API_KEY` / `opencode-go#OPENCODEGOSOTA_API_KEY`；
 * plugin-quota-multi/src/controller.ts MAGPIE 注释即同款「`magpie#<provider>` 前缀认领」模式）。
 * 匹配 = 精确相等 ∪ 以 `<声明值>#` 开头。多行命中时的选取：
 * ① 用 provider_key_refs[routeProvider]（渠道 DSH provider id → 凭证引用名）精选 `#<该keyRef>` 行；
 * ② 该 ref 未登记 / 无对应行 → 取首个前缀命中行，multiUnpicked=true 供 note 标注「未按 keyRef 精选」。
 * 窗口模式（M4）同样走本选取逻辑：归一化只改变"行内余额语义"，不改变"行选取"。
 * @param {object} quota normalizeQuotaSnapshot 视图
 * @param {string} platform 注册表显式声明的 quota_platform
 * @param {string} routeProvider 渠道的 DSH provider id（keyRef 反查键）
 * @returns {{ view:object|undefined, pickedByRef:boolean, prefixMatched:boolean, multiUnpicked:boolean }}
 */
export function pickPlatformView(quota, platform, routeProvider) {
  if (!quota || !(quota.by_platform instanceof Map)) {
    return { view: undefined, pickedByRef: false, prefixMatched: false, multiUnpicked: false }
  }
  const exact = quota.by_platform.get(platform)
  if (exact !== undefined) return { view: exact, pickedByRef: false, prefixMatched: false, multiUnpicked: false }
  const prefix = `${platform}#`
  const hits = []
  for (const [id, view] of quota.by_platform) {
    if (typeof id === 'string' && id.startsWith(prefix)) hits.push([id, view])
  }
  if (hits.length === 0) return { view: undefined, pickedByRef: false, prefixMatched: false, multiUnpicked: false }
  const ref = quota.provider_key_refs ? quota.provider_key_refs[routeProvider] : undefined
  if (typeof ref === 'string' && ref !== '') {
    const byRef = quota.by_platform.get(`${platform}#${ref}`)
    if (byRef !== undefined) return { view: byRef, pickedByRef: true, prefixMatched: true, multiUnpicked: false }
  }
  return { view: hits[0][1], pickedByRef: false, prefixMatched: true, multiUnpicked: true }
}
