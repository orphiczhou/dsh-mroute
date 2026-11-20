/**
 * model_route_query 工具（MVP 主缝，模型消费）：读注册表 → llm 活校验 → channel_type 三级排序 →
 * 带理由的结构化列表。不改写任何请求（07 方案 §3.4 注 2 的 v1 红线）。
 *
 * M1 增量（0.2.0-m1.0）：
 * - warning 标注（FR-A6-1/2 M1 部分）：status=disabled|exhausted 或 manual 余额低于阈值 →
 *   **条目保留在表中**（不沉底、不出列、不阻断——advisory-only NFR-0 红线），条目带
 *   warning{reason, suggestion}，suggestion 取 fallbacks[] 首选或排序下一项。
 *   与 FR-A2 的分工：本处是**注册表静态标记与低余额阈值**的标注路径；运行时账本的动态
 *   exhausted/cooling 沉底/出列属 FR-A2 L2 mask（M2 账本层，本文件不实现）。
 * - review_alerts（FR-A3-4/D3-1）：channel.reviewed_at 距今 >90 天（本说明书设定值）→
 *   review_alert=true + review_alerts[] 复核提示文案。
 * - capability 过滤生效（FR-A3-3 M1 标注级）：capability 入参按评级匹配——excellent/good 命中、
 *   fair 未命中；命中与否**均不过滤**（未命中 reason 注明不满足，条目保留），无数据渠道
 *   reason 注明 M2 接入（评级门槛的「不入 routes[]」强过滤语义属 M2 数据建模后裁决，
 *   M1 按 advisory-only 只标注）。
 * - DecisionRecord（FR-E2 最小版）：每次查询追加一行 JSONL 到 ~/.dsh/mroute/decisions/
 *   （lib/decision-log.js），写失败静默降级不影响返回。
 *
 * M2 增量（0.3.0-m2.0，quota 数据源接入）：
 * - balance_source 枚举加 'machine'：经 quota 插件面板快照（webServer getOrigin loopback，
 *   lib/quota-source.js）自动读取的机读余额。采信前提（任务书 §4.4/§3.8 红线）：渠道显式声明
 *   quota_platform + quota_account_verified=true + 平台行 ok + 余额可解析；任一不满足回落
 *   manual（quota 缺席时无感回落无噪音，§6.1；映射命中但未核实回落并标注原因，§6.3）。
 *   machine 行带可选 balance{remaining,currency,display,as_of,source,degraded} 标注；
 *   stale（缓存降级期）数据带 degraded:true。
 * - 低余额阈值 Config 可配置 low_balance_threshold_cny（缺省 10 兼容 M1 常量）；machine 数值
 *   优先于 manual 参与阈值判定（CNY/未知币种才比——USD 不臆测汇率）。
 * - meta.quota 区块 + advisory 表头：「自动余额经 quota 插件读取，仅供参考」——无任何阻断语义，
 *   无 tools.guard（advisory-only 红线）。
 *
 * M4 增量（0.5.0，窗口型余额 + 目录一致性告警）：
 * - machine 采信面扩展 quota-view 的三种 mode：amount（M2 现状）/ window（包月渠道的
 *   `已用 N%` 窗口，balance 无 remaining，改带 windows[] + worst_used_pct）/ status（纯在线
 *   状态文本）。三者的采信闸门一致：quota_platform 非空 + verified=true + 行 status=ok。
 *   窗口模式只是「建议参考的用量读数」，不做阈值判定（CNY 阈值只对 amount 生效）。
 * - review_alerts 增补「注册表 models 与宿主目录不一致」告警（目录非空才比，缺/多余双向列出）；
 *   仍为 advisory-only：不降权、不阻断、排序全序键不变（ranking.js 零改动）。
 *
 * M4.5 增量（动态数据影响排序，advisory-only）：
 * - routes[] 新增 dynamic{state,reasons[],metrics{}}（恒在；ok 时 state='ok'、reasons 空数组）；
 * - ranking.js 在 livecheck unknown 与 channel_type 之间插入 dynamicTight 一档：周窗口高水位/
 *   金额型低余额 → tight 沉底（只改推荐顺序，仍出现在 routes[]，excluded 不变）；
 * - 5h 窗口高水位 → hint 只标注不沉底；文本渲染 tight 用「⚠ 动态沉底」、hint 用「· 提示」；
 * - meta.dynamic_thresholds 记录本次生效阈值（复盘用）；阈值读 Config 两个新 volatile 字段。
 *
 * 返回字段 = 任务书清单 {rank, provider, models, channel_type, tier, priority, balance_source,
 * reason, degraded, note} 全保留；增补 channel_id / livecheck / excluded / current / meta
 * （MVP，增不改）+ M1 增补 warning（可选，仅告警条目）/ review_alert / review_alerts
 * + M2 增补 balance（可选，仅 machine 条目）/ meta.quota
 * + M4.6 增补 models_index（可选，模型优先视图；按归并规范名分组，channels 按既有 rank 升序；
 *   routes[] 语义与顺序零变化，balance_state 只给状态枚举、不透出数值）。
 *
 * M4.8 增量（能力匹配推荐，advisory-only）：
 * - 可选入参 need（{coding|tools|long_context|vision}: fair|good|excellent，多键 AND）：只增
 *   routes[i].matching_models/suggested_model、顶层 model_picks、meta.capability_need/unrated_models；
 *   routes[] 排序与既有键逐行不变；不传 need 时上述键全部缺席（不是 undefined，是不出现）。
 * - 'none'（明确无能力）= 序值 0，不满足任何需求；未登记（缺键）= 未知，不计入匹配，单独统计
 *   meta.unrated_models（红线：两者不得混为一类）。
 * - 文本渲染无条件补每模型档位（模型归并视图 `[coding:… vision:无]`），传 need 时增
 *   「能力需求」表头、「匹配模型」行（最低评级）与「能力匹配推荐」段（fit/min 可手算复核）。
 */
import { readRegistry, manualStatusOf, capabilityRatingOf, canonicalOf, ratingsForModel } from './registry.js'
import { normalizeNeed, matchesNeed, fitScore, minMarginInNeed, minRatingInNeed, needSummary, RATING_NONE_LABEL, NEED_VALUES, ratingValueOf } from './capability-need.js'
import { CAPABILITY_KEYS, CAPABILITY_RATINGS } from './config-schema.js'
import { livecheckAll, rankChannels, rankOf, TIER_RANK } from './ranking.js'
import { appendDecisionRecord, reasonHead } from './decision-log.js'
import { pickPlatformView } from './quota-view.js'
import { dynamicStateOf, dynamicThresholdsOf, buildDynamicSnapshot, snapshotRowsEqual } from './dynamic-state.js'
import { errorMessage } from './errors.js'

export const TOOL_NAME = 'model_route_query'

const TIER_MIN_VALUES = ['overseas_sota', 'domestic_sota', 'bulk']
const INHERIT_NOTE = '无可用渠道时不填 provider/model——子会话继承父路由（宿主缺省链语义）'

/** 低余额阈值缺省值（M1 内置常量 10 CNY；M2 起 Config low_balance_threshold_cny 可覆盖，此常量保留为缺省与导出兼容）。 */
export const LOW_BALANCE_THRESHOLD_CNY = 10
/** 复核超期阈值（FR-A3-4 本说明书设定值 90 天）。 */
export const REVIEW_STALE_DAYS = 90

/** balance_source 派生（任务书清单字段；manual 登记对象存在即人工登记路径，数值是否占位写入 note）。 */
function balanceSourceOf(channel) {
  const manual = channel.manual
  if (manual && typeof manual === 'object') return 'manual'
  return 'unknown'
}

/**
 * machine 采信判定（M2，任务书 §4.4 采信前提 + §6.3 问题路径）。
 * quota 缺席（view=null）→ `{use:'manual', why:null}`——无感回落不加噪（§6.1：health unknown
 * 无告警噪音）；映射命中但未核实 → 回落 manual + why 标注原因（§6.3 note 纪律）。
 * 多账号行（M2 补修，lead 2026-11-15 实测反馈）：行选取经 pickPlatformView——精确相等 ∪
 * `<声明值>#` 前缀匹配，多行命中优先按 provider_key_refs[routeProvider] 的 keyRef 精选，
 * 未精选时 multiUnpicked=true 供 note 标注。
 * @param {object} channel 注册表渠道行
 * @param {object|null} quota normalizeQuotaSnapshot 视图（by_platform Map）
 * @param {{ degraded?:boolean }} [opts] degraded=true = stale 降级期（cache 失败携带旧快照）
 * @returns {{ use:'machine'|'manual', view?:object, why?:string|null, multiUnpicked?:boolean }}
 */
export function machineBalanceOf(channel, quota, opts = {}) {
  if (!quota || !(quota.by_platform instanceof Map)) return { use: 'manual', why: null }
  const platform = typeof channel.quota_platform === 'string' ? channel.quota_platform.trim() : ''
  if (platform === '') return { use: 'manual', why: null } // 空=不接 machine（显式声明红线）
  // 行选取（M2 补修）：`平台id#keyRef` 多账号形态前缀认领（quota 插件 controller.ts MAGPIE
  // 同款模式）；providerKeyRefs 反查渠道 keyRef 精选，未精选 → 首行 + multiUnpicked。
  const pick = pickPlatformView(quota, platform, channel.routeProvider)
  const view = pick.view
  if (!view) return { use: 'manual', why: `quota 快照无平台 "${platform}" 行（quota 插件未装/未启用该平台）` }
  if (channel.quota_account_verified !== true) {
    return { use: 'manual', why: `quota 平台 "${platform}" 映射命中但账户未核实（quota_account_verified=false，不采信数值）` }
  }
  if (view.status !== 'ok') {
    return { use: 'manual', why: `quota 平台 "${platform}" 状态 ${view.status}${view.message ? `（${view.message}）` : ''}` }
  }
  // mode 判定（M4）：quota-view 已按 window → amount → status 归一；这里只校验消费侧契约。
  // window/status 无 remaining 也可采信（窗口用量/在线状态本身就是有效读数），amount 必须有数值。
  if (view.mode !== 'amount' && view.mode !== 'window' && view.mode !== 'status') {
    return { use: 'manual', why: `quota 平台 "${platform}" 无可解析余额（金额/窗口/状态文本均无，不伪造 0）` }
  }
  if (view.mode === 'amount' && typeof view.balance !== 'number') {
    return { use: 'manual', why: `quota 平台 "${platform}" 无可解析余额数值（解析失败不伪造 0）` }
  }
  return {
    use: 'machine',
    view,
    why: opts.degraded === true ? 'stale' : null,
    multiUnpicked: pick.multiUnpicked === true,
  }
}

function noteOf(channel, live, quotaNote) {
  const parts = []
  const manual = channel.manual && typeof channel.manual === 'object' ? channel.manual : {}
  if (manual.quota_total === '—' || !manual.quota_total) {
    // M2 措辞：machine 通道已接入；占位"—"仍说明该渠道无人工登记数值（quota 回落原因另行标注）。
    parts.push('人工登记余额为占位"—"')
  }
  if (manual.note) parts.push(manual.note)
  // M2 machine 采信/回落标注（quota 缺席时 quotaNote=null，无感回落零噪音——§6.1）
  if (quotaNote) parts.push(quotaNote)
  return parts.join('；')
}

/**
 * warning 标注（FR-A6-1/2 M1 部分，静态注册表层；M2 扩展 machine 数值源 + 阈值可配）：
 * reason 优先级 disabled > exhausted > low_balance（单 warning 对象取主因）。
 * 低余额解析（M2）：machine 数值优先（更新鲜）——仅 CNY/未知币种参与 CNY 阈值比较（USD 等
 * 其它币种不臆测汇率，只展示不触发）；否则回落 M1 manual.quota_total 解析（可 parseFloat
 * 且 < 阈值才触发，占位"—"或非数值=未知余额，不触发）。
 * 阈值：options.thresholdCny（Config low_balance_threshold_cny，缺省 LOW_BALANCE_THRESHOLD_CNY=10）。
 * 红线：本函数只产生标注，调用方不据此沉底/出列/拦截（NFR-0 advisory-only）。
 */
export function warningOf(channel, options = {}) {
  const status = manualStatusOf(channel)
  if (status === 'disabled' || status === 'exhausted') {
    return { reason: status }
  }
  const rawThreshold = options.thresholdCny
  const threshold =
    typeof rawThreshold === 'number' && Number.isFinite(rawThreshold) && rawThreshold >= 0
      ? rawThreshold
      : LOW_BALANCE_THRESHOLD_CNY
  const machine = options.machine
  if (machine && typeof machine.balance === 'number') {
    if ((machine.currency === null || machine.currency === 'CNY') && machine.balance < threshold) {
      return { reason: 'low_balance' }
    }
    return null
  }
  const total = Number.parseFloat(String(channel?.manual?.quota_total ?? ''))
  if (Number.isFinite(total) && total < threshold) {
    return { reason: 'low_balance' }
  }
  return null
}

/**
 * 替代建议（FR-A6「至少一条替代建议」）：fallbacks[] 首选 → 排序下一项 → 排序前一项。
 * 简化裁决（记 devlog）：不校验 suggestion 目标自身是否告警（M1 从简，避免级联计算）。
 */
export function suggestionFor(channel, rankedIds) {
  const self = channel?.id
  const fb = (Array.isArray(channel?.fallbacks) ? channel.fallbacks : [])
    .find((id) => typeof id === 'string' && id !== '' && id !== self)
  if (fb) return fb
  const idx = rankedIds.indexOf(self)
  if (idx >= 0) {
    const next = rankedIds[idx + 1] ?? rankedIds[idx - 1]
    if (typeof next === 'string' && next !== '') return next
  }
  return ''
}

/** capability 标注（FR-A3-3 M1 标注级）：命中/未满足/无数据三分，均不过滤只写 reason。 */
export function capabilityNoteOf(channel, capabilityRequested) {
  if (!capabilityRequested) return ''
  const rating = capabilityRatingOf(channel, capabilityRequested)
  if (rating === 'excellent' || rating === 'good') {
    return `；capability=${capabilityRequested} 命中（评级 ${rating}）`
  }
  if (rating === 'fair') {
    return `；capability=${capabilityRequested} 未满足（评级 fair，仅标注不过滤）`
  }
  return '；capability 过滤未生效（渠道无结构化能力数据，M2 接入）'
}

/** review_alerts（FR-A3-4）：reviewed_at 距今 >90 天 → 提示文案数组；空/不可解析日期不触发。 */
export function reviewAlertsOf(channel, now = Date.now()) {
  const raw = typeof channel?.reviewed_at === 'string' ? channel.reviewed_at.trim() : ''
  if (raw === '') return []
  const t = Date.parse(raw)
  if (!Number.isFinite(t)) return []
  const days = Math.floor((now - t) / 86_400_000)
  if (days <= REVIEW_STALE_DAYS) return []
  return [`reviewed_at 超期 ${days} 天（阈值 ${REVIEW_STALE_DAYS} 天），建议人工复核 tier/priority 与 capability 评级`]
}

/**
 * 目录一致性告警（M4，交付 B）：注册表 models[] 与 llm.listModels() 目录不一致时给出双向差异。
 * 纪律（advisory-only）：只是 review_alerts 文案，不降权/不过滤/不改排序；目录为空视为「读不到」，
 * 不判为不一致（避免陈旧 mock 或宿主目录暂缺时的噪音）。
 * @param {object} channel 注册表渠道
 * @param {{status?:string, availableModels?:string[]}} live livecheck 结果
 * @returns {string[]} 0 或 1 条告警
 */
export function catalogAlertsOf(channel, live) {
  if (!live || live.status !== 'ok') return []
  const catalog = Array.isArray(live.availableModels) ? live.availableModels.map(String) : []
  if (catalog.length === 0) return []
  const current = Array.isArray(channel?.models) ? channel.models.map(String) : []
  const missing = catalog.filter((model) => !current.includes(model))
  const extra = current.filter((model) => !catalog.includes(model))
  if (missing.length === 0 && extra.length === 0) return []
  const parts = []
  if (missing.length > 0) parts.push(`注册表缺 ${missing.join(', ')}`)
  if (extra.length > 0) parts.push(`注册表多余（目录未列） ${extra.join(', ')}`)
  return [`注册表 models 与宿主目录不一致（建议性，可能仍可用）：${parts.join('；')}`]
}

/**
 * machine 余额展示串：amount → `machine(¥57.93 as_of=… stale)` 口径（M2 不变）；
 * window → `machine(5h 4% · 本周 8% · 本月 4%)`（M4 交付 A 的文本形态）；
 * status → `machine(在线)`。非 machine 返回 balance_source 原值。
 */
function balanceDisplayText(route) {
  if (route.balance_source !== 'machine' || !route.balance) return route.balance_source
  const stale = route.balance.degraded === true ? ' stale' : ''
  if (route.balance.mode === 'window') return `machine(${route.balance.display ?? ''}${stale})`
  if (route.balance.mode === 'status') return `machine(${route.balance.display ?? 'status'}${stale})`
  const currency = route.balance.currency === 'USD' ? '$' : '¥'
  return `machine(${currency}${route.balance.remaining}${stale})`
}

/**
 * 每模型能力档位文本（M3.1，advisory 标注）：`glm-4.6 coding=excellent tools=good；deepseek-chat long_context=excellent`。
 * 只渲染闭集内维度；不参与排序/过滤（排序全序键见 ranking.js）。
 */
function modelCapabilityText(rows) {
  return rows
    .map((row) => {
      const dims = CAPABILITY_KEYS.filter((key) => CAPABILITY_RATINGS.includes(row[key])).map((key) => `${key}=${row[key]}`)
      return dims.length === 0 ? String(row.model) : `${row.model} ${dims.join(' ')}`
    })
    .join('；')
}

/** 评级名文本（'none' → 无；其余原样）。 */
function ratingTextOf(value) {
  return value === 'none' ? RATING_NONE_LABEL : String(value)
}

/** 四维档位文本（模型归并视图/推荐段用）：`coding:good tools:excellent … vision:无`；只列有值维度。 */
function ratingsDimsText(ratings) {
  if (ratings === null || typeof ratings !== 'object' || Array.isArray(ratings)) return ''
  return CAPABILITY_KEYS
    .filter((dim) => CAPABILITY_RATINGS.includes(ratings[dim]) || ratings[dim] === 'none')
    .map((dim) => `${dim}:${ratingTextOf(ratings[dim])}`)
    .join(' ')
}

/** 给模型看的文本渲染（与 output.schema 同源，read-only 摘要）。⚠ = 非阻断标注前缀。 */
export function renderRouteResult(value) {
  const lines = []
  lines.push('模型路由排序表（财务一级键：monthly > voucher > prepaid；tier/priority 次级；标注均不阻断，最终选择权在会话与用户）')
  // M4.8：need 表头只在传了 need 时出现；advisory 口径与全文一致（不阻断、不改顺序）。
  const capabilityNeed = value.meta?.capability_need !== null
    && typeof value.meta?.capability_need === 'object'
    && !Array.isArray(value.meta.capability_need)
    && Object.keys(value.meta.capability_need).length > 0
    ? value.meta.capability_need
    : null
  if (capabilityNeed !== null) {
    lines.push(`能力需求: ${needSummary(capabilityNeed)}（advisory：仅标注与推荐落点，不阻断、不改 routes 排序）`)
  }
  // M2 advisory 口径（任务书 §4.6）：quota 区块只在数据可用时展示（缺席无噪音，§6.1）；
  // 措辞明确「仅供参考」，无阻断语义。
  const quotaMeta = value.meta?.quota
  if (quotaMeta?.available === true) {
    const staleMark = quotaMeta.degraded === true ? '，暂不可达——以下为最近一次成功快照' : ''
    lines.push(`自动余额经 quota 插件读取（截至 ${quotaMeta.as_of || '未知时间'}${staleMark}），仅供参考`)
  }
  if (value.current) {
    lines.push(`当前会话路由: ${value.current.provider}/${value.current.model}`)
  }
  // M4.8：need 匹配行的括号展示需要「渠道 × 渠道模型」→ 档位，从 models_index 反查（同源视图）。
  const ratingsByModel = new Map()
  for (const group of Array.isArray(value.models_index) ? value.models_index : []) {
    const ratings = group && typeof group.ratings === 'object' && !Array.isArray(group.ratings) ? group.ratings : {}
    for (const entry of Array.isArray(group?.channels) ? group.channels : []) {
      if (typeof entry?.channel_id === 'string' && typeof entry?.channel_model === 'string') {
        ratingsByModel.set(`${entry.channel_id}\u0000${entry.channel_model}`, ratings)
      }
    }
  }
  if (value.routes.length === 0) {
    lines.push('无可用渠道。' + value.meta.inherit_fallback)
  } else {
    for (const route of value.routes) {
      const models = route.models.length > 0 ? ` models=[${route.models.join(', ')}]` : ''
      const flagged = route.warning || (Array.isArray(route.review_alerts) && route.review_alerts.length > 0)
      lines.push(`${route.rank}. ${flagged ? '⚠ ' : ''}${route.channel_id} → provider=${route.provider}${models} | ${route.channel_type}/${route.tier}/priority ${route.priority} | balance=${balanceDisplayText(route)}${route.livecheck === 'unknown' ? ' | livecheck=unknown(降权)' : ''}`)
      lines.push(`   理由: ${route.reason}`)
      // M4.8：只在传了 need 时出现 matching_models（无匹配也出现空数组）；括号为 need 维度最低评级。
      if (Array.isArray(route.matching_models)) {
        if (route.matching_models.length === 0) {
          lines.push('   匹配模型: 无（本渠道没有满足该能力需求的模型）')
        } else {
          const shown = route.matching_models.slice(0, 4).map((model) => {
            const ratings = ratingsByModel.get(`${route.channel_id}\u0000${model}`)
            const lowest = capabilityNeed !== null && ratings ? minRatingInNeed(ratings, capabilityNeed) : null
            return lowest === null ? model : `${model}(${ratingTextOf(lowest)})`
          })
          const rest = route.matching_models.length - shown.length
          lines.push(`   匹配模型: ${shown.join(', ')}${rest > 0 ? ` 等 ${rest} 个` : ''}`)
        }
      }
      if (Array.isArray(route.model_capability) && route.model_capability.length > 0) {
        lines.push(`   模型档位: ${modelCapabilityText(route.model_capability)}（advisory 标注，不参与排序）`)
      }
      if (route.warning) {
        lines.push(`   ⚠ warning=${route.warning.reason}（标注不阻断）｜替代建议: ${route.warning.suggestion || '（无备选登记，见排序表其余项）'}`)
      }
      if (Array.isArray(route.review_alerts) && route.review_alerts.length > 0) {
        lines.push(`   ⚠ ${route.review_alerts.join('；')}`)
      }
      // M4.5 动态标注：tight 沉底行用 ⚠（不阻断），hint 用 · 轻量前缀（只提示不沉底）。
      const dynamicReasons = Array.isArray(route.dynamic?.reasons) ? route.dynamic.reasons : []
      if (route.dynamic?.state === 'tight') {
        lines.push(`   ⚠ 动态沉底: ${dynamicReasons.length > 0 ? dynamicReasons.join('；') : '动态数据紧张'}（不阻断）`)
      } else if (route.dynamic?.state === 'hint') {
        lines.push(`   · 提示: ${dynamicReasons.length > 0 ? dynamicReasons.join('；') : '5h 窗口偏高（不沉底）'}`)
      }
      if (route.note) lines.push(`   备注: ${route.note}`)
    }
  }
  // M4.6 模型归并视图：只列跨 ≥2 渠道的规范名（单渠道组对「选渠道」无决策价值，降噪不打印）；
  // 只给排位与渠道/模型 id，不透出余额数值，标 advisory 口径。
  const mergedGroups = Array.isArray(value.models_index)
    ? value.models_index.filter((group) => Array.isArray(group?.channels) && group.channels.length > 1)
    : []
  if (mergedGroups.length > 0) {
    lines.push('模型归并视图（按规范名分组；只改视图不改排序，不阻断）:')
    for (const group of mergedGroups) {
      const list = group.channels.map((entry) => `${entry.channel_id}→${entry.channel_model}(#${entry.rank})`).join(', ')
      // M4.8：档位无条件补在规范名后（'none' → 无）；无档位组保持原行形。
      const dims = ratingsDimsText(group.ratings)
      lines.push(`- ${group.canonical}${dims ? ` [${dims}]` : ''}: ${list}`)
    }
  }
  // M4.8：能力匹配推荐（仅传 need 时出现）。fit/min 由档位 + 需求现算，便于人工复核排序依据。
  if (Array.isArray(value.model_picks) && value.model_picks.length > 0) {
    lines.push('能力匹配推荐（先按能力匹配质量，再按渠道排序；advisory，不阻断）:')
    value.model_picks.forEach((pick, index) => {
      const ratings = pick?.ratings && typeof pick.ratings === 'object' && !Array.isArray(pick.ratings) ? pick.ratings : {}
      const fit = capabilityNeed !== null ? fitScore(ratings, capabilityNeed) : null
      const minMargin = capabilityNeed !== null ? minMarginInNeed(ratings, capabilityNeed) : null
      const dims = ratingsDimsText(ratings)
      const score = fit === null || minMargin === null ? '' : ` | fit=${fit} min=${minMargin}`
      lines.push(`${index + 1}. ${pick.canonical} @ ${pick.channel_id} (#${pick.rank})${dims ? ` | ${dims}` : ''}${score}`)
    })
  }
  if (capabilityNeed !== null && typeof value.meta?.unrated_models === 'number') {
    lines.push(`档位未登记模型: ${value.meta.unrated_models} 个（不计入匹配）`)
  }
  if (value.excluded.length > 0) {
    lines.push(`已过滤: ${value.excluded.map((e) => `${e.channel_id}(${e.why})`).join(', ')}`)
  }
  lines.push(`registry_version=${value.meta.registry_version} reviewed_at=${value.meta.reviewed_at || '未登记'} 生成于 ${value.meta.generated_at}`)
  return lines.join('\n')
}

/**
 * 余额状态枚举（M4.6 models_index 专用；**只给状态、不透出任何数值/文本余额**）：
 * machine / machine_tight / machine_hint = quota 机读采信（含动态紧/提示档）；
 * manual = 人工登记路径（未机读核实）；unknown = 无余额登记。
 */
export function balanceStateOf(route) {
  if (route?.balance_source === 'machine') {
    if (route?.dynamic?.state === 'tight') return 'machine_tight'
    if (route?.dynamic?.state === 'hint') return 'machine_hint'
    return 'machine'
  }
  if (route?.balance_source === 'manual') return 'manual'
  return 'unknown'
}

/**
 * 模型优先视图（M4.6 / 07 §4）：把 routes[] 的「渠道 × 渠道模型 id」归并到规范名。
 *
 * - 分组键 = canonicalOf(registry.model_aliases, 渠道, 模型)——未登记自反，绝不抛；
 * - 每组 ratings 取该组**排序最前且有数据**渠道的完整解析结果（ratingsForModel：渠道模型 id
 *   精确 → 规范名 → 渠道级 capability → 无数据），四维只输出有值的键；不从多个渠道拼维度。
 * - channels 按 routes 既有 rank 升序（同 rank 按渠道 id / 模型 id 兜底），只带排位与状态，
 *   不透出余额数值；groups 按组内最优 rank 升序；
 * - 不读余额缓存、不改 routes[]、不参与排序判定：纯视图，advisory-only。
 *
 * @param {{channels?:Array<object>, model_aliases?:object}} registry readRegistry() 结果
 * @param {Array<object>} routes createRouteQueryTool 已排序的渠道行
 * @returns {Array<{canonical:string, ratings:object, channels:Array<object>}>}
 */
export function buildModelsIndex(registry, routes) {
  const aliases = registry?.model_aliases !== null && typeof registry?.model_aliases === 'object' && !Array.isArray(registry.model_aliases)
    ? registry.model_aliases
    : {}
  const ratingTable = registry?.model_ratings !== null && typeof registry?.model_ratings === 'object' && !Array.isArray(registry.model_ratings)
    ? registry.model_ratings
    : null
  const channelById = new Map()
  for (const channel of Array.isArray(registry?.channels) ? registry.channels : []) {
    if (channel !== null && typeof channel === 'object' && typeof channel.id === 'string') channelById.set(channel.id, channel)
  }
  const byCanonical = new Map()
  for (const route of Array.isArray(routes) ? routes : []) {
    if (route === null || typeof route !== 'object') continue
    const channelId = typeof route.channel_id === 'string' ? route.channel_id : ''
    if (channelId === '') continue
    for (const model of Array.isArray(route.models) ? route.models : []) {
      if (typeof model !== 'string' || model === '') continue
      const canonical = canonicalOf(aliases, channelId, model)
      let group = byCanonical.get(canonical)
      if (group === undefined) {
        group = { canonical, ratings: {}, channels: [] }
        byCanonical.set(canonical, group)
      }
      const ratings = ratingsForModel(channelById.get(channelId), canonical, model, ratingTable)
      if (ratings !== null && Object.keys(group.ratings).length === 0) {
        for (const key of CAPABILITY_KEYS) {
          if (CAPABILITY_RATINGS.includes(ratings[key]) || ratings[key] === 'none') group.ratings[key] = ratings[key]
        }
      }
      group.channels.push({
        channel_id: channelId,
        channel_model: model,
        channel_type: route.channel_type,
        tier: route.tier,
        priority: route.priority,
        rank: route.rank,
        balance_state: balanceStateOf(route),
      })
    }
  }
  const list = [...byCanonical.values()]
  for (const group of list) {
    group.channels.sort((a, b) => a.rank - b.rank
      || (a.channel_id < b.channel_id ? -1 : a.channel_id > b.channel_id ? 1 : 0)
      || (a.channel_model < b.channel_model ? -1 : a.channel_model > b.channel_model ? 1 : 0))
  }
  list.sort((a, b) => (a.channels[0]?.rank ?? 0) - (b.channels[0]?.rank ?? 0)
    || (a.canonical < b.canonical ? -1 : a.canonical > b.canonical ? 1 : 0))
  return list
}

/** 从评级对象取四维闭集值（含 'none'；未登记维度不出现）。 */
function ratingsOfDims(ratings) {
  const out = {}
  if (ratings === null || typeof ratings !== 'object') return out
  for (const dim of CAPABILITY_KEYS) {
    const value = ratings[dim]
    if (CAPABILITY_RATINGS.includes(value) || value === 'none') out[dim] = value
  }
  return out
}

/**
 * need 匹配（M4.8）：返回该渠道 models[] 中满足全部需求的模型，以及 need 维度缺档的模型。
 * 排序：fit 降序（need 各维序值和）→ 最小裕度降序 → models[] 原序（suggested_model 取首位）。
 * 纯计算，不改 channel/registry；'none' 走 matchesNeed 自然不满足，未登记单独进 unrated。
 */
function matchingModelsOf(channel, need, aliases, ratingTable) {
  const matches = []
  const unrated = []
  const needDims = CAPABILITY_KEYS.filter((dim) => typeof need?.[dim] === 'string')
  const models = Array.isArray(channel?.models) ? channel.models : []
  models.forEach((model, index) => {
    if (typeof model !== 'string' || model === '') return
    const canonical = canonicalOf(aliases, channel.id, model)
    const ratings = ratingsForModel(channel, canonical, model, ratingTable)
    const missing = needDims.some((dim) => ratingValueOf(ratings, dim) === null)
    if (missing) {
      unrated.push(model)
      return
    }
    if (!matchesNeed(ratings, need)) return
    const fit = fitScore(ratings, need)
    const minMargin = minMarginInNeed(ratings, need)
    if (fit === null || minMargin === null) return
    matches.push({ model, canonical, ratings: ratingsOfDims(ratings), fit, minMargin, index })
  })
  matches.sort((a, b) => b.fit - a.fit || b.minMargin - a.minMargin || a.index - b.index)
  return { matches, unrated }
}

export async function assembleRouteTable({
  getRegistry, livecheck, logger, getQuota, readConfigValue,
  tierMin = null, excludeDegraded = false, capabilityKey = null, need = null,
}) {
  const registry = getRegistry()
  const { channels } = registry
  const liveById = await livecheckAll(livecheck, channels, logger)

  // M2：quota 快照（懒获取；缺席/失败/熔断 → getQuota 返回 null → 全量回落 manual，§6.1）。
  // getQuota 缺席（未装配）与返回 null 同义——老装配面兼容。
  const quotaState = typeof getQuota === 'function' ? await getQuota() : null
  const quotaView = quotaState && typeof quotaState === 'object' ? quotaState.view : null
  const quotaDegraded = quotaState?.degraded === true
  const quotaBreaker = quotaState?.breaker ?? 'unavailable'
  const quotaAvailable = quotaView !== null

  // M2：低余额阈值（Config low_balance_threshold_cny，volatile 双面读；缺省 10 兼容 M1 常量）。
  const rawThreshold = typeof readConfigValue === 'function' ? readConfigValue('low_balance_threshold_cny') : undefined
  const thresholdCny = typeof rawThreshold === 'number' && Number.isFinite(rawThreshold) && rawThreshold >= 0
    ? rawThreshold
    : LOW_BALANCE_THRESHOLD_CNY

  // M4.5：动态阈值（同源 Config volatile 双面读；非法/缺省由 dynamicThresholdsOf 回落 98/95/10，
  // 与 schema 缺省一致）。阈值只影响标注与沉底，不剔除、不阻断。
  const rawWeekTight = typeof readConfigValue === 'function' ? readConfigValue('window_week_tight_pct') : undefined
  const raw5hHint = typeof readConfigValue === 'function' ? readConfigValue('window_5h_hint_pct') : undefined
  const dynamicThresholds = dynamicThresholdsOf({
    window_week_tight_pct: rawWeekTight,
    window_5h_hint_pct: raw5hHint,
    low_balance_cny: thresholdCny,
  })

  // 过滤（tier_min；exclude_degraded——MVP 健康状态机未上线，渠道无 degraded 字段时视为 false，
  // 未来字段就位后此过滤自动生效，不留死代码）
  const excluded = []
  const pool = channels.filter((channel) => {
    // m-8：枚举查表统一走 rankOf（hasOwnProperty 口径，与 ranking.js 一致）
    if (typeof tierMin === 'string' && rankOf(TIER_RANK, channel.tier) > rankOf(TIER_RANK, tierMin)) {
      excluded.push({ channel_id: channel.id, why: `tier 低于 tier_min=${tierMin}` })
      return false
    }
    if (excludeDegraded && channel.degraded === true) {
      excluded.push({ channel_id: channel.id, why: 'degraded excluded' })
      return false
    }
    return true
  })

  // M4.5：动态状态先算（排序要消费 tight），machine 采信结果复用给 routes 标注（避免重复判定）。
  // dynamicStateOf 是纯函数：无 machine 数据/未核实渠道 → ok（无噪音）。
  const machineById = new Map()
  const dynamicById = new Map()
  for (const channel of pool) {
    const machine = machineBalanceOf(channel, quotaView, { degraded: quotaDegraded })
    machineById.set(channel.id, machine)
    dynamicById.set(channel.id, dynamicStateOf(channel, machine, dynamicThresholds))
  }

  const { ranked, reasonFor } = rankChannels(pool, liveById, dynamicById)
  // 排序先于标注：suggestion「排序下一项」需要全序确定后再计算
  const rankedIds = ranked.map((entry) => entry.channel.id)
  // M4.8：need 匹配只读 registry（aliases + 归一化档位表），产物只增视图、不参与上面的排序。
  const aliases = registry?.model_aliases !== null && typeof registry?.model_aliases === 'object' && !Array.isArray(registry.model_aliases)
    ? registry.model_aliases
    : {}
  const ratingTable = registry?.model_ratings !== null && typeof registry?.model_ratings === 'object' && !Array.isArray(registry.model_ratings)
    ? registry.model_ratings
    : null
  const picks = []
  const unratedModels = new Set()
  const routes = ranked.map((entry, index) => {
    const { channel, live } = entry
    // M2 machine 采信判定（上面已按渠道算好，复用；先于 warning：low_balance 优先消费 machine 数值）
    const machine = machineById.get(channel.id)
    const dynamic = dynamicById.get(channel.id)
    // CNY 低余额阈值只对 amount 生效（窗口用量是百分比、状态文本无数值，均不臆测）
    const machineInfo = machine.use === 'machine' && machine.view.mode === 'amount'
      ? { balance: machine.view.balance, currency: machine.view.currency, as_of: machine.view.as_of }
      : null
    const warning = warningOf(channel, { thresholdCny, machine: machineInfo })
    const alerts = [...reviewAlertsOf(channel), ...catalogAlertsOf(channel, live)]
    // M2 note 增量：machine 采信 → as_of/source 标注（+stale 降级说明）；回落 → 原因标注；
    // quota 缺席（machine.why=null 且非 machine）→ 无标注（§6.1 无感回落零噪音）。
    // M4：window/status 模式换用对应文案（不写「截至」避免把用量读数误读成余额时点）。
    let quotaNote = null
    if (machine.use === 'machine') {
      if (machine.view.mode === 'window') {
        quotaNote = `余额经 quota 插件自动读取（mode=window，窗口用量 ${machine.view.display}，最高 ${machine.view.worst_used_pct}%，仅供参考）`
      } else if (machine.view.mode === 'status') {
        quotaNote = `余额经 quota 插件自动读取（mode=status：${machine.view.display ?? '在线'}，仅供参考）`
      } else {
        quotaNote = `余额经 quota 插件自动读取（balance_source=machine，截至 ${machine.view.as_of}，仅供参考）`
      }
      if (quotaDegraded) quotaNote += '；quota 暂不可达，此为最近一次成功快照（stale）'
      if (machine.multiUnpicked === true) quotaNote += '；多账号行，未按 keyRef 精选（首个前缀命中）'
      if (machine.view.mode === 'amount' && machine.view.currency !== null && machine.view.currency !== 'CNY') {
        quotaNote += `；币种 ${machine.view.currency}，CNY 低余额阈值不适用`
      }
    } else if (machine.why) {
      quotaNote = `未采信 quota 数值（${machine.why}），回落人工登记`
    }
    // M4.8：need 匹配（每渠道一次；排序不消费，只产出建议与统计）。
    const material = need === null ? null : matchingModelsOf(channel, need, aliases, ratingTable)
    if (material !== null) {
      for (const model of material.unrated) unratedModels.add(model)
      if (material.matches.length > 0) {
        const best = material.matches[0]
        picks.push({
          canonical: best.canonical,
          channel_id: channel.id,
          channel_model: best.model,
          rank: index + 1,
          ratings: best.ratings,
          fit: best.fit,
          minMargin: best.minMargin,
        })
      }
    }
    return {
      rank: index + 1,
      channel_id: channel.id,
      provider: channel.routeProvider,
      models: Array.isArray(channel.models) ? [...channel.models] : [],
      channel_type: channel.channel_type,
      tier: channel.tier,
      priority: Number(channel.priority) || 0,
      balance_source: machine.use === 'machine' ? 'machine' : balanceSourceOf(channel),
      // balance（M2/M4 可选键）：仅 machine 条目携带；stale 降级期 degraded=true。
      // amount 保持 M2 形状（remaining/currency/display）；window 改带 windows[]/worst_used_pct；
      // status 只带 display 原文。
      ...(machine.use === 'machine'
        ? {
            balance: {
              mode: machine.view.mode,
              ...(machine.view.mode === 'amount'
                ? {
                    remaining: machine.view.balance,
                    ...(machine.view.currency !== null ? { currency: machine.view.currency } : {}),
                    ...(machine.view.display !== null ? { display: machine.view.display } : {}),
                  }
                : machine.view.mode === 'window'
                  ? {
                      ...(machine.view.display !== null ? { display: machine.view.display } : {}),
                      windows: machine.view.windows.map((row) => ({ ...row })),
                      worst_used_pct: machine.view.worst_used_pct,
                    }
                  : { ...(machine.view.display !== null ? { display: machine.view.display } : {}) }),
              as_of: machine.view.as_of,
              source: 'quota-plugin',
              degraded: quotaDegraded,
            },
          }
        : {}),
      livecheck: live?.status === 'unknown' ? 'unknown' : 'ok',
      degraded: false, // MVP 占位：健康状态机 M2 上线（任务书明确 degraded:false 占位）
      // dynamic（M4.5，恒在）：tight 沉底 / hint 只提示 / ok 无噪音；advisory-only 不阻断。
      dynamic: {
        state: dynamic.state,
        reasons: [...dynamic.reasons],
        metrics: { ...dynamic.metrics },
      },
      reason: reasonFor(entry) + capabilityNoteOf(channel, capabilityKey),
      note: noteOf(channel, live, quotaNote),
      // advisory-only：warning 条目保留在表中——不沉底、不出列、不阻断（rank 按原序不变）
      ...(warning ? { warning: { reason: warning.reason, suggestion: suggestionFor(channel, rankedIds) } } : {}),
      review_alert: alerts.length > 0,
      review_alerts: alerts,
      // model_capability（M3.1 可选键）：advisory 标注，不参与排序/过滤；空数组不出现。
      ...(Array.isArray(channel.model_capability) && channel.model_capability.length > 0
        ? { model_capability: channel.model_capability.map((row) => ({ ...row })) }
        : {}),
      // M4.8：need 专属键——不传 need 时完全不出现（不是 undefined），routes[] 其它键原样。
      // 无匹配时只发 matching_models: []，**不发 suggested_model**（schema 为 string，宿主拒绝 type 数组）。
      ...(material !== null
        ? {
            matching_models: material.matches.map((match) => match.model),
            ...(material.matches.length > 0 ? { suggested_model: material.matches[0].model } : {}),
          }
        : {}),
    }
  })

  // M4.8：model_picks 排序（lead m00133 裁决，确定性可手算）：fit 降序 → 最小裕度降序 →
  // 渠道 rank 升序 → canonical 字典序；fit/minMargin 仅内部排序用，不写进输出（文本现算展示）。
  picks.sort((a, b) => b.fit - a.fit || b.minMargin - a.minMargin || a.rank - b.rank
    || (a.canonical < b.canonical ? -1 : a.canonical > b.canonical ? 1 : 0))
  const modelPicks = picks.map(({ fit, minMargin, ...pick }) => pick)

  return {
    registry,
    aliases,
    ratingTable,
    quotaView,
    quotaDegraded,
    quotaBreaker,
    quotaAvailable,
    dynamicThresholds,
    excluded,
    routes,
    modelPicks,
    unratedCount: unratedModels.size,
  }
}

/**
 * M4.11 共享装配说明：本函数从 createRouteQueryTool.execute 原样抽出（构建 routes[] +
 * 余额 + 动态状态 + need 匹配），model_route_query 与 mroute_dispatch_plan 两处调用同一份
 * 实现，避免口径漂移（任务书 m4.11 §3.1「复用而非复制」红线）。query 特有的
 * dynamic_snapshot 写回与 DecisionRecord 留在 execute 内，不在共享面。
 */
export function createRouteQueryTool({ ctx, getRegistry, livecheck, logger, decisionsBaseDir, getQuota, readConfigValue }) {
  return {
    name: TOOL_NAME,
    description:
      '查询按财务优先级排序的模型渠道推荐表，供派遣子会话前选择 assignee 的 provider/model 使用。' +
      '排序：channel_type 一级键（monthly > voucher > prepaid）→ tier 能力分层 → priority 降序 → id 兜底；' +
      'provider 活校验失败的渠道沉底并标注。已核实渠道的余额经 quota 插件自动读取（仅供参考）；' +
      '周窗口/余额高水位（tight）只把渠道沉底并标注、5h 偏高只提示——都不剔除不阻断；' +
      '⚠ 标注（禁用/低余额/复核超期）只是提醒，全部保留在表中且不阻断——' +
      'advisory-only：最终选择权在会话与用户。只读参考，不改写任何请求；被宿主策略门拒绝时按列表顺序换下一项。' +
      'models_index 提供按归并规范名的模型优先视图（同 id 跨渠道自动并，其余需人工归并），只影响视图不改排序。' +
      '可选 need（{coding|tools|long_context|vision}: fair|good|excellent，多键 AND）给出任务能力需求：' +
      '只增 routes[].matching_models/suggested_model 与 model_picks 建议，不改 routes 排序、不阻断（advisory-only）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        capability: {
          type: 'string',
          description: '能力需求关键词（如 coding）。按注册表 capability 评级匹配：excellent/good 命中、fair 未满足——均不过滤，仅在 reason 标注供自主权衡；无评级数据的渠道注明 M2 接入。',
        },
        need: {
          type: 'object',
          additionalProperties: false,
          description: '能力需求（M4.8，advisory）：每维给最低评级，多键 AND；省略或空对象 = 不做匹配。只增匹配模型与推荐落点，不改排序、不阻断。',
          properties: {
            coding: { type: 'string', enum: NEED_VALUES, description: '最低编码评级' },
            tools: { type: 'string', enum: NEED_VALUES, description: '最低工具调用评级' },
            long_context: { type: 'string', enum: NEED_VALUES, description: '最低长上下文评级' },
            vision: { type: 'string', enum: NEED_VALUES, description: '最低视觉评级' },
            // M4.9：能力维度 4→6（world_knowledge / orchestration，任务书 §3.1；与注册表同键集）。
            world_knowledge: { type: 'string', enum: NEED_VALUES, description: '最低世界知识评级' },
            orchestration: { type: 'string', enum: NEED_VALUES, description: '最低策划调度评级' },
          },
        },
        tier_min: {
          type: 'string',
          enum: TIER_MIN_VALUES,
          description: '最低能力档位；只返回该档位及以上的渠道（overseas_sota > domestic_sota > bulk）。缺省返回全部。',
        },
        exclude_degraded: {
          type: 'boolean',
          description: 'true 时剔除 degraded 渠道。MVP 恒无 degraded（健康占位），缺省 false 只降权标注不剔除。',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          current: {
            type: 'object',
            additionalProperties: false,
            properties: {
              provider: { type: 'string' },
              model: { type: 'string' },
            },
            required: ['provider', 'model'],
          },
          routes: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                rank: { type: 'integer' },
                channel_id: { type: 'string' },
                provider: { type: 'string' },
                models: { type: 'array', items: { type: 'string' } },
                channel_type: { type: 'string', enum: ['monthly', 'voucher', 'prepaid'] },
                tier: { type: 'string', enum: ['overseas_sota', 'domestic_sota', 'bulk'] },
                priority: { type: 'integer' },
                balance_source: { type: 'string', enum: ['manual', 'machine', 'unknown'] },
                // balance（M2/M4）：仅 balance_source='machine' 条目携带的可选键（可选字段省略先例
                // 同 warning：vendors/r600a-code--dsh-swarm-router/index.js:223-230）。
                // mode=amount 时 remaining 必在；mode=window 时 remaining 缺省、改带 windows[]；
                // mode=status 时只有 display 原文。stale 降级期 degraded=true（cache 失败携带最近一次成功快照）。
                balance: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    mode: { type: 'string', enum: ['amount', 'window', 'status'] },
                    remaining: { type: 'number' },
                    currency: { type: 'string', enum: ['CNY', 'USD'] },
                    display: { type: 'string' },
                    as_of: { type: 'string' },
                    source: { type: 'string', enum: ['quota-plugin'] },
                    degraded: { type: 'boolean' },
                    windows: {
                      type: 'array',
                      items: {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                          label: { type: 'string' },
                          used_pct: { type: 'number' },
                          text: { type: 'string' },
                        },
                        required: ['label', 'used_pct', 'text'],
                      },
                    },
                    worst_used_pct: { type: 'number' },
                  },
                  required: ['mode', 'as_of', 'source', 'degraded'],
                },
                livecheck: { type: 'string', enum: ['ok', 'unknown'] },
                degraded: { type: 'boolean' },
                reason: { type: 'string' },
                note: { type: 'string' },
                // warning（FR-A6-1/2）：仅告警条目携带（可选键不在 required；可选字段省略先例
                // vendors/r600a-code--dsh-swarm-router/index.js:223-230 输出 schema）。
                warning: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    reason: { type: 'string', enum: ['disabled', 'exhausted', 'low_balance'] },
                    suggestion: { type: 'string' },
                  },
                  required: ['reason', 'suggestion'],
                },
                review_alert: { type: 'boolean' },
                review_alerts: { type: 'array', items: { type: 'string' } },
                // dynamic（M4.5）：动态状态恒在（ok 也带 state:'ok' + 空 reasons，消费方分支简单）。
                // tight=周窗口/金额型低余额沉底；hint=5h 偏高只提示；metrics 只记录读到的数字。
                dynamic: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    state: { type: 'string', enum: ['tight', 'hint', 'ok'] },
                    reasons: { type: 'array', items: { type: 'string' } },
                    metrics: {
                      type: 'object',
                      additionalProperties: false,
                      properties: {
                        week_pct: { type: 'number' },
                        h5_pct: { type: 'number' },
                        balance: { type: 'number' },
                      },
                    },
                  },
                  required: ['state', 'reasons', 'metrics'],
                },
                // model_capability（M3.1 可选键）：每模型能力档位（advisory 标注，不参与排序）。
                // 渠道未登记/归一化后为空时该键不出现；行内四维只输出有值的维度。
                model_capability: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      model: { type: 'string' },
                      coding: { type: 'string', enum: ['excellent', 'good', 'fair'] },
                      tools: { type: 'string', enum: ['excellent', 'good', 'fair'] },
                      long_context: { type: 'string', enum: ['excellent', 'good', 'fair'] },
                      vision: { type: 'string', enum: ['excellent', 'good', 'fair'] },
                    },
                    required: ['model'],
                  },
                },
                // matching_models/suggested_model（M4.8 可选键）：仅传 need 时出现。匹配 = need 各维
                // 全部有档位且 ≥ 需求（'none' 不满足、未登记不算满足）；suggested_model 取匹配质量
                // 最高者（fit 降序 → 最小裕度降序 → models[] 原序）。
                // ⚠ 宿主工具 schema 只接受**单一 type 字符串**（`type: ['string','null']` 会让整套工具
                // 注册被拒：`unsupported JSON schema: … must be a single type string (type arrays are
                // not supported)`）——故这里声明 string，且**无匹配时不发该键**（不用 null）。
                matching_models: { type: 'array', items: { type: 'string' } },
                suggested_model: { type: 'string' },
              },
              required: ['rank', 'channel_id', 'provider', 'models', 'channel_type', 'tier', 'priority', 'balance_source', 'livecheck', 'degraded', 'reason', 'note', 'review_alert', 'review_alerts', 'dynamic'],
            },
          },
          excluded: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                channel_id: { type: 'string' },
                why: { type: 'string' },
              },
              required: ['channel_id', 'why'],
            },
          },
          // models_index（M4.6，可选增补）：模型优先视图——按归并规范名分组，组内 channels
          // 按既有 rank 升序；balance_state 只给状态枚举，**不透出余额数值**；不改 routes[] 顺序。
          models_index: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                canonical: { type: 'string' },
                ratings: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    coding: { type: 'string', enum: ['excellent', 'good', 'fair', 'none'] },
                    tools: { type: 'string', enum: ['excellent', 'good', 'fair', 'none'] },
                    long_context: { type: 'string', enum: ['excellent', 'good', 'fair', 'none'] },
                    vision: { type: 'string', enum: ['excellent', 'good', 'fair', 'none'] },
                    world_knowledge: { type: 'string', enum: ['excellent', 'good', 'fair', 'none'] },
                    orchestration: { type: 'string', enum: ['excellent', 'good', 'fair', 'none'] },
                  },
                },
                channels: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      channel_id: { type: 'string' },
                      channel_model: { type: 'string' },
                      channel_type: { type: 'string', enum: ['monthly', 'voucher', 'prepaid'] },
                      tier: { type: 'string', enum: ['overseas_sota', 'domestic_sota', 'bulk'] },
                      priority: { type: 'integer' },
                      rank: { type: 'integer' },
                      balance_state: { type: 'string', enum: ['machine', 'machine_tight', 'machine_hint', 'manual', 'unknown'] },
                    },
                    required: ['channel_id', 'channel_model', 'channel_type', 'tier', 'priority', 'rank', 'balance_state'],
                  },
                },
              },
              required: ['canonical', 'ratings', 'channels'],
            },
          },
          // model_picks（M4.8 可选增补）：仅传 need 时出现。每个「有匹配模型」的渠道取建议模型一条；
          // 排序 = fit 降序（need 各维序值和）→ 最小裕度降序 → 渠道 rank 升序 → canonical 字典序。
          // ratings 为 need 相关全量四维档位（含 'none'），不参与 routes[] 排序。
          model_picks: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                canonical: { type: 'string' },
                channel_id: { type: 'string' },
                channel_model: { type: 'string' },
                rank: { type: 'integer' },
                ratings: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    coding: { type: 'string', enum: ['excellent', 'good', 'fair', 'none'] },
                    tools: { type: 'string', enum: ['excellent', 'good', 'fair', 'none'] },
                    long_context: { type: 'string', enum: ['excellent', 'good', 'fair', 'none'] },
                    vision: { type: 'string', enum: ['excellent', 'good', 'fair', 'none'] },
                    world_knowledge: { type: 'string', enum: ['excellent', 'good', 'fair', 'none'] },
                    orchestration: { type: 'string', enum: ['excellent', 'good', 'fair', 'none'] },
                  },
                },
              },
              required: ['canonical', 'channel_id', 'channel_model', 'rank', 'ratings'],
            },
          },
          meta: {
            type: 'object',
            additionalProperties: false,
            properties: {
              registry_version: { type: 'integer' },
              reviewed_at: { type: 'string' },
              generated_at: { type: 'string' },
              inherit_fallback: { type: 'string' },
              // quota 区块（M2）：available=false 时 as_of 空串、breaker='unavailable'（§6.1
              // 缺席形态）；advisory note 常驻（表头同口径，仅供参考）。
              quota: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  available: { type: 'boolean' },
                  degraded: { type: 'boolean' },
                  breaker: { type: 'string', enum: ['ok', 'degraded', 'cooling', 'half-open', 'unavailable'] },
                  as_of: { type: 'string' },
                  note: { type: 'string' },
                },
                required: ['available', 'degraded', 'breaker', 'as_of', 'note'],
              },
              // dynamic_thresholds（M4.5）：本次生效阈值（Config 缺省/非法回落内置缺省后的实际值），
              // 便于复盘某条沉底是哪个阈值触发的（advisory 观察面，不是控制面）。
              dynamic_thresholds: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  window_week_tight_pct: { type: 'number' },
                  window_5h_hint_pct: { type: 'number' },
                  low_balance_cny: { type: 'number' },
                },
                required: ['window_week_tight_pct', 'window_5h_hint_pct', 'low_balance_cny'],
              },
              // capability_need / unrated_models（M4.8 可选键）：仅传 need 时出现。capability_need 回显
              // 归一化后的需求（键闭集、值 fair|good|excellent）；unrated_models = 参与匹配的渠道模型
              // 中 need 所涉维度至少一维未登记的个数（'none' 是已登记值，不计入）。
              capability_need: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  coding: { type: 'string', enum: NEED_VALUES },
                  tools: { type: 'string', enum: NEED_VALUES },
                  long_context: { type: 'string', enum: NEED_VALUES },
                  vision: { type: 'string', enum: NEED_VALUES },
                  world_knowledge: { type: 'string', enum: NEED_VALUES },
                  orchestration: { type: 'string', enum: NEED_VALUES },
                },
              },
              unrated_models: { type: 'integer' },
              // dynamic_snapshot_error（M4.9 可选键）：快照写回失败时出现的一句人读原因。
              // 快照是纯附加行为（任务书 §4.2 红线）：成败都不改 routes[]/meta 其余键。
              dynamic_snapshot_error: { type: 'string' },
            },
            required: ['registry_version', 'reviewed_at', 'generated_at', 'inherit_fallback', 'quota', 'dynamic_thresholds'],
          },
        },
        required: ['routes', 'excluded', 'meta'],
      },
      render: (_args, value) => [{ type: 'text', text: renderRouteResult(value) }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      if (args !== undefined && (typeof args !== 'object' || Array.isArray(args))) {
        throw new Error(`${TOOL_NAME}: arguments must be an object`)
      }
      const tierMin = args?.tier_min
      const excludeDegraded = args?.exclude_degraded === true
      const capabilityKey = typeof args?.capability === 'string' && args.capability.trim().length > 0 ? args.capability.trim() : null

      // M4.8：need 入参校验先于任何 IO（非法值明确报哪个键/值，大小写敏感）；空对象 = 不做匹配。
      const needResult = normalizeNeed(args?.need)
      if (needResult.invalid) {
        throw new Error(`${TOOL_NAME}: need 参数非法：${needResult.invalid.message}`)
      }
      const need = needResult.need !== null && Object.keys(needResult.need).length > 0 ? needResult.need : null

      // M4.11：装配体上移 assembleRouteTable（与 mroute_dispatch_plan 共享同一份实现，避免口径漂移）。
      const assembly = await assembleRouteTable({
        getRegistry, livecheck, logger, getQuota, readConfigValue,
        tierMin, excludeDegraded, capabilityKey, need,
      })
      const registry = assembly.registry
      const {
        routes, excluded, modelPicks, dynamicThresholds,
        quotaView, quotaDegraded, quotaBreaker, quotaAvailable,
        unratedCount,
      } = assembly

      const currentProvider = exec?.agent?.options?.provider
      const currentModel = exec?.agent?.options?.model
      const generatedAt = new Date().toISOString()
      const result = {
        routes,
        excluded,
        models_index: buildModelsIndex(registry, routes),
        // M4.8：仅传 need 时出现（无匹配也出现空数组）；不改 routes[] 语义与顺序。
        ...(need !== null ? { model_picks: modelPicks } : {}),
        meta: {
          registry_version: Number(registry.registry_version) || 1,
          reviewed_at: String(registry.reviewed_at ?? ''),
          generated_at: generatedAt,
          inherit_fallback: INHERIT_NOTE,
          // M2 quota 区块：advisory 口径常驻 note（表头同文案）；缺席形态 available=false
          // + breaker='unavailable' + as_of=''（§6.1 无噪降级，不阻断激活）。
          quota: {
            available: quotaAvailable,
            degraded: quotaAvailable ? quotaDegraded : false,
            breaker: quotaAvailable ? quotaBreaker : 'unavailable',
            as_of: quotaAvailable ? String(quotaView.as_of ?? '') : '',
            note: '自动余额经 quota 插件读取，仅供参考；quota 缺席/失败/未核实账户的渠道回落人工登记（advisory-only，无阻断）',
          },
          // M4.5：本次生效的动态阈值（复盘用：某条沉底由哪个阈值触发可回查）。
          dynamic_thresholds: {
            window_week_tight_pct: dynamicThresholds.window_week_tight_pct,
            window_5h_hint_pct: dynamicThresholds.window_5h_hint_pct,
            low_balance_cny: dynamicThresholds.low_balance_cny,
          },
          // M4.8：need 专属 meta——不传 need 时完全缺席；unrated_models 只数 need 所涉维度有缺档的
          // 渠道模型（'none' 是已登记值，不计入；与「未登记」严格区分）。
          ...(need !== null
            ? {
                capability_need: { ...need },
                unrated_models: unratedCount,
              }
            : {}),
        },
      }
      if (typeof currentProvider === 'string' && typeof currentModel === 'string') {
        result.current = { provider: currentProvider, model: currentModel }
      }

      // ── M4.9 动态层快照写回（纯附加，任务书 §4.2 红线）──────────────────────
      // 把本次 routes[] 的动态层折进 config.dynamic_snapshot（面板经 describe 读回渲染）。
      // 条件：rows 深比较不同，或现有 as_of 距今 >30s（TTL 内同内容不重复 bump revision）。
      // 写法同 tool-sync-models.js（ctx.fiber.entry + configEditor.edit）；失败静默，只在
      // meta.dynamic_snapshot_error 留一句——无论成败，返回体与 M4.8 逐行一致。
      let snapshotError = null
      try {
        const snapshot = buildDynamicSnapshot(routes, generatedAt)
        const existingRaw = typeof readConfigValue === 'function' ? readConfigValue('dynamic_snapshot') : undefined
        const existing = existingRaw && typeof existingRaw === 'object' && !Array.isArray(existingRaw) ? existingRaw : {}
        const rowsChanged = !snapshotRowsEqual(existing.rows, snapshot.rows)
        const prevAsOf = Date.parse(String(existing.as_of ?? ''))
        const ttlExpired = !Number.isFinite(prevAsOf) || (Date.now() - prevAsOf) > 30000
        if (rowsChanged || ttlExpired) {
          const entry = ctx?.fiber?.entry
          const editor = typeof ctx?.get === 'function' ? ctx.get('configEditor') : undefined
          if (entry && editor && typeof editor.edit === 'function') {
            await editor.edit(entry, (current) => ({ ...current, dynamic_snapshot: snapshot }))
          } else {
            // 宿主面缺席不算错误路径（面板照常显示旧快照），不占 meta 键。
            logger?.debug?.('[mroute] dynamic_snapshot 写回跳过：configEditor 不可用')
          }
        }
      } catch (error) {
        snapshotError = errorMessage(error)
        logger?.warn?.(`[mroute] dynamic_snapshot 写回失败（忽略）: ${snapshotError}`)
      }
      if (snapshotError) {
        result.meta.dynamic_snapshot_error = snapshotError
      }

      // DecisionRecord（FR-E2 最小版）：追加式本地审计账本；写失败静默降级（decision-log.js 内部兜底，
      // 不影响查询返回）。留痕是观察面不是控制面——不改写任何请求（advisory-only）。
      await appendDecisionRecord({
        ts: generatedAt,
        args: args ?? {},
        top3: routes.slice(0, 3).map((r) => ({ id: r.channel_id, rank: r.rank, reason_head: reasonHead(r.reason) })),
        excluded_count: excluded.length,
        generated_at: generatedAt,
      }, { baseDir: decisionsBaseDir, logger })

      return result
    },
  }
}
