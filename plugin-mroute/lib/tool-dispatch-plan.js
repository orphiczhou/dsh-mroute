/**
 * mroute_dispatch_plan 工具（M4.11 派发预检 / 任务书 docs/briefs/m4.11-dispatch-preflight.md）。
 *
 * 定位：意图明确、输出**可直接粘贴进 assignee** 的预检清单——头部数据新鲜度 + 每行
 * provider/model 字面值 + 用法/降级脚注；完整诊断表仍是 model_route_query 的职责。
 *
 * 复用而非复制（任务书 §3.1 红线）：routes 装配走 tool-query.js 导出的 assembleRouteTable
 * （构建 routes + 余额 + 动态状态 + need 匹配的同一份实现），排序口径与 ranking.js 零漂移。
 *
 * 红线（§4）：advisory-only——不接 tools.guard、不阻断、不改写任何请求、不新增出站请求；
 * 输出 schema 全部单一 type 字符串（宿主禁 type 数组）；channels[] 为普通 JSON 输出 schema，
 * 不涉及 schemastery volatile。
 */
import { assembleRouteTable, balanceStateOf } from './tool-query.js'
import { normalizeNeed, needSummary, fitScore, minMarginInNeed, ratingValueOf, RATING_RANK } from './capability-need.js'
import { canonicalOf, ratingsForModel } from './registry.js'

export const TOOL_NAME = 'mroute_dispatch_plan'

/** 快照新鲜度阈值（秒）——≤300s 记「新鲜」，超时提示重查（任务书 §3.1）。 */
export const FRESH_SECONDS = 300

const CHANNEL_TYPE_VALUES = ['monthly', 'voucher', 'prepaid']
const RANK_LABEL = { 0: 'none', 1: 'fair', 2: 'good', 3: 'excellent' }

/**
 * need 无匹配时的行尾诊断（任务书示例 `⚠ 无匹配（vision:无）`）：对每个 need 维度看该渠道
 * 全部模型的档位——有任一模型满足则不列；全部未登记 → `维度:未登记`；已知最佳为 none →
 * `维度:无`；已知但低于需求 → `维度:不足（最高 fair 等）`。纯计算，不臆测。
 */
function missingDimsText(channel, need, aliases, ratingTable) {
  const dims = Object.keys(need)
  const parts = []
  for (const dim of dims) {
    const required = RATING_RANK[need[dim]]
    let best = null // 已知最佳序值；null = 全部未登记
    let satisfied = false
    for (const model of Array.isArray(channel?.models) ? channel.models : []) {
      if (typeof model !== 'string' || model === '') continue
      const ratings = ratingsForModel(channel, canonicalOf(aliases, channel.id, model), model, ratingTable)
      const value = ratingValueOf(ratings, dim)
      if (value === null) continue
      if (value >= required) { satisfied = true; break }
      best = best === null ? value : Math.max(best, value)
    }
    if (satisfied) continue
    if (best === null) parts.push(`${dim}:未登记`)
    else if (best === 0) parts.push(`${dim}:无`)
    else parts.push(`${dim}:不足（最高 ${RANK_LABEL[best]}）`)
  }
  return parts.length > 0 ? parts.join(', ') : '本渠道没有满足该能力需求的模型'
}

/** 余额/动态/静态告警 → 行级 warnings + 展示串（不伪造数值：manual/unknown 不编余额）。 */
function rowOf(route, index, need, registry, aliases, ratingTable) {
  const warnings = []
  let model = null
  let fit = null
  let min = null
  const channel = (Array.isArray(registry?.channels) ? registry.channels : []).find((row) => row?.id === route.channel_id) ?? null
  if (need !== null) {
    if (typeof route.suggested_model === 'string' && route.suggested_model !== '') {
      model = route.suggested_model
      const ratings = ratingsForModel(channel, canonicalOf(aliases, route.channel_id, model), model, ratingTable)
      fit = fitScore(ratings, need)
      min = minMarginInNeed(ratings, need)
    } else {
      model = '—'
      warnings.push(`无匹配（${missingDimsText(channel, need, aliases, ratingTable)}）`)
    }
  } else {
    model = Array.isArray(route.models) && route.models.length > 0 ? route.models[0] : '（模型未登记）'
    if (!Array.isArray(route.models) || route.models.length === 0) {
      warnings.push('该渠道 models 为空，assignee 需人工补 model 或先跑 model_route_sync_models')
    }
  }

  let display = ''
  let icon = ''
  if (route.balance_source === 'machine' && route.balance) {
    if (route.balance.mode === 'amount') {
      const currency = route.balance.currency === 'USD' ? '$' : '¥'
      display = `${currency}${route.balance.remaining}`
      icon = '💰'
    } else {
      display = route.balance.display ?? ''
      icon = route.dynamic?.state === 'tight' || route.dynamic?.state === 'hint' ? '🌓' : '🌕'
    }
    if (route.balance.degraded === true) warnings.push('stale（quota 降级期最近一次成功快照）')
  } else if (route.balance_source === 'manual') {
    warnings.push('未核实/数据非机读（manual）')
  } else {
    warnings.push('无余额登记（unknown）')
  }
  if (route.dynamic?.state === 'tight') warnings.push(`动态沉底：${(route.dynamic.reasons ?? []).join('；') || '动态数据紧张'}`)
  else if (route.dynamic?.state === 'hint') warnings.push(`提示：${(route.dynamic.reasons ?? []).join('；') || '5h 窗口偏高'}`)
  if (route.warning) warnings.push(`warning=${route.warning.reason}`)
  if (route.livecheck === 'unknown') warnings.push('livecheck=unknown（provider 活校验失败，已沉底）')

  return {
    rank: index + 1,
    provider: route.provider,
    model,
    channel_type: route.channel_type,
    tier: route.tier,
    priority: route.priority,
    display,
    state: balanceStateOf(route),
    ...(fit !== null && min !== null ? { fit, min } : {}),
    warnings,
  }
}

/** 渲染专用图标：按 state/display 重算（结构化 channels[] 不含图标键）。 */
function iconForRow(row) {
  if (row.state === 'manual' || row.state === 'unknown') return ''
  if (/^[¥$]/.test(row.display)) return '💰'
  if (row.state === 'machine_tight' || row.state === 'machine_hint') return '🌓'
  return '🌕'
}

/** 文本渲染：3 行头 + limit 行 + 2 行脚（任务书 §3.1 长度上限；完整诊断表归 model_route_query）。 */
export function renderDispatchPlan(value) {
  const lines = []
  lines.push(`派发预检 · dispatch preflight（${value.queried_at}）`)
  if (value.snapshot_at) {
    const fresh = typeof value.freshness_seconds === 'number' && value.freshness_seconds <= FRESH_SECONDS
    lines.push(
      `数据：quota 快照 ${value.snapshot_at} · ${fresh ? '新鲜（≤5 分钟）' : `偏旧（>5 分钟，建议重查；距今 ${typeof value.freshness_seconds === 'number' ? value.freshness_seconds : '?'}s）`}` +
      ` · ${value.machine_count}/${value.pool_count} 渠道机读可用`,
    )
  } else {
    lines.push(`数据：无 quota 快照（quota 插件未装/未启用或尚无成功快照）· ${value.machine_count}/${value.pool_count} 渠道机读可用`)
  }
  if (value.need) lines.push(`需求：${needSummary(value.need)}`)
  if (value.channels.length === 0) {
    lines.push('无匹配渠道（检查 channel_type 过滤或注册表 channels）。')
  } else {
    for (const row of value.channels) {
      const badge = `[${row.channel_type} · ${row.tier} · priority ${row.priority}]`
      const icon = iconForRow(row)
      const reading = [row.display ? `${icon} ${row.display}`.trim() : icon, row.fit !== undefined ? `fit=${row.fit} min=${row.min}` : '']
        .filter((part) => part !== '').join('  ')
      const tail = row.warnings.length > 0 ? `  ⚠ ${row.warnings.join('；')}` : ''
      lines.push(`${row.rank}. ${row.provider} / ${row.model}  ${badge}${reading ? `  ${reading}` : ''}${tail}`)
    }
  }
  lines.push('用法：按顺序把 provider/model 填进 subagent/tree_dispatch 的 assignee；被宿主策略门拒绝就换下一项；全被拒则省略 assignee 继承父路由。')
  lines.push('标记：🌕=运行态正常　🌓=有窗口告警（沉底/提示见理由）　💰=金额型　⚠=需注意（无匹配/未核实/数据非机读）')
  return lines.join('\n')
}

export function createDispatchPlanTool({ ctx, getRegistry, livecheck, logger, getQuota, readConfigValue }) {
  return {
    name: TOOL_NAME,
    description:
      '派发预检：返回可直接粘贴进 assignee 的 provider/model 优先清单（含余额读数与新鲜度），' +
      '派遣子会话前先调本工具；需要完整诊断表（routes/模型归并视图/告警明细）用 model_route_query。' +
      '排序与 model_route_query 同源（monthly > voucher > prepaid → tier → priority）；advisory-only：' +
      '只建议不阻断，被宿主策略门拒绝时按列表顺序换下一项，全被拒则省略 assignee 继承父路由。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        need: {
          type: 'object',
          additionalProperties: false,
          description: '能力需求（多键 AND）：每维给最低评级；省略或空对象 = 不做匹配（每行取渠道首个模型）。',
          properties: {
            coding: { type: 'string', enum: ['excellent', 'good', 'fair'], description: '最低编码评级' },
            tools: { type: 'string', enum: ['excellent', 'good', 'fair'], description: '最低工具调用评级' },
            long_context: { type: 'string', enum: ['excellent', 'good', 'fair'], description: '最低长上下文评级' },
            vision: { type: 'string', enum: ['excellent', 'good', 'fair'], description: '最低视觉评级' },
            world_knowledge: { type: 'string', enum: ['excellent', 'good', 'fair'], description: '最低世界知识评级' },
            orchestration: { type: 'string', enum: ['excellent', 'good', 'fair'], description: '最低策划调度评级' },
          },
        },
        limit: {
          type: 'integer',
          description: '返回行数，1..10（缺省 5）；超出范围按边界收敛。',
        },
        channel_type: {
          type: 'string',
          enum: CHANNEL_TYPE_VALUES,
          description: '只看该付费类型的渠道（monthly|voucher|prepaid）；缺省全给。',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          queried_at: { type: 'string' },
          snapshot_at: { type: 'string' },
          freshness_seconds: { type: 'integer' },
          machine_count: { type: 'integer' },
          pool_count: { type: 'integer' },
          need: {
            type: 'object',
            additionalProperties: false,
            properties: {
              coding: { type: 'string', enum: ['excellent', 'good', 'fair'] },
              tools: { type: 'string', enum: ['excellent', 'good', 'fair'] },
              long_context: { type: 'string', enum: ['excellent', 'good', 'fair'] },
              vision: { type: 'string', enum: ['excellent', 'good', 'fair'] },
              world_knowledge: { type: 'string', enum: ['excellent', 'good', 'fair'] },
              orchestration: { type: 'string', enum: ['excellent', 'good', 'fair'] },
            },
          },
          channels: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                rank: { type: 'integer' },
                provider: { type: 'string' },
                model: { type: 'string' },
                channel_type: { type: 'string', enum: ['monthly', 'voucher', 'prepaid'] },
                tier: { type: 'string', enum: ['overseas_sota', 'domestic_sota', 'bulk'] },
                priority: { type: 'integer' },
                display: { type: 'string' },
                state: { type: 'string', enum: ['machine', 'machine_tight', 'machine_hint', 'manual', 'unknown'] },
                reason: { type: 'string' },
                fit: { type: 'integer' },
                min: { type: 'integer' },
                warnings: { type: 'array', items: { type: 'string' } },
              },
              required: ['rank', 'provider', 'model', 'channel_type', 'tier', 'priority', 'display', 'state', 'warnings'],
            },
          },
          notes: { type: 'array', items: { type: 'string' } },
        },
        required: ['queried_at', 'snapshot_at', 'machine_count', 'pool_count', 'channels', 'notes'],
      },
      render: (_args, value) => [{ type: 'text', text: renderDispatchPlan(value) }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      if (args !== undefined && (typeof args !== 'object' || Array.isArray(args))) {
        throw new Error(`${TOOL_NAME}: arguments must be an object`)
      }
      // 入参校验全部先于任何 IO（任务书 §3.1：非法入参必须在 IO 之前报错）。
      const needResult = normalizeNeed(args?.need)
      if (needResult.invalid) {
        throw new Error(`${TOOL_NAME}: need 参数非法：${needResult.invalid.message}`)
      }
      const need = needResult.need !== null && Object.keys(needResult.need).length > 0 ? needResult.need : null
      const rawLimit = args?.limit
      if (rawLimit !== undefined && (typeof rawLimit !== 'number' || !Number.isFinite(rawLimit))) {
        throw new Error(`${TOOL_NAME}: limit 参数非法：必须是 1..10 的整数`)
      }
      const limit = rawLimit === undefined ? 5 : Math.min(10, Math.max(1, Math.floor(rawLimit)))
      const channelType = args?.channel_type
      if (channelType !== undefined && !CHANNEL_TYPE_VALUES.includes(channelType)) {
        throw new Error(`${TOOL_NAME}: channel_type 参数非法：${JSON.stringify(channelType ?? null)}（允许 ${CHANNEL_TYPE_VALUES.join('|')}，大小写敏感）`)
      }

      // 共享装配（M4.11 复用红线）：与 model_route_query 同一份 routes 构建/排序/余额/动态实现。
      const assembly = await assembleRouteTable({ getRegistry, livecheck, logger, getQuota, readConfigValue, need })
      const pool = channelType === undefined
        ? assembly.routes
        : assembly.routes.filter((route) => route.channel_type === channelType)
      const machineCount = pool.filter((route) => route.balance_source === 'machine').length
      const shown = pool.slice(0, limit)

      const queriedMs = Date.now()
      const queriedAt = new Date(queriedMs).toISOString()
      const snapshotAt = assembly.quotaAvailable ? String(assembly.quotaView.as_of ?? '') : ''
      const snapshotMs = snapshotAt !== '' ? Date.parse(snapshotAt) : NaN
      const freshnessSeconds = Number.isFinite(snapshotMs) ? Math.max(0, Math.round((queriedMs - snapshotMs) / 1000)) : null

      const rows = shown.map((route, index) => {
        const row = rowOf(route, index, need, assembly.registry, assembly.aliases, assembly.ratingTable)
        const reasonText = [
          route.dynamic?.state === 'tight' ? `动态沉底：${(route.dynamic.reasons ?? []).join('；')}` : '',
          route.warning ? `warning=${route.warning.reason}` : '',
        ].filter((part) => part !== '').join('；')
        return {
          ...row,
          ...(reasonText !== '' ? { reason: reasonText } : {}),
        }
      })

      const notes = []
      if (snapshotAt === '') notes.push('无 quota 快照：余额为人工登记/无登记，数值仅供参考')
      else if (freshnessSeconds > FRESH_SECONDS) notes.push(`quota 快照偏旧（距今 ${freshnessSeconds}s > ${FRESH_SECONDS}s），建议重查`)
      if (assembly.quotaDegraded) notes.push('quota 处于降级期：展示的是最近一次成功快照（stale）')
      if (need !== null) notes.push('need 匹配为 advisory：无匹配渠道仍在列（标 ⚠），最终选择权在会话与用户')

      return {
        queried_at: queriedAt,
        snapshot_at: snapshotAt,
        ...(freshnessSeconds !== null ? { freshness_seconds: freshnessSeconds } : {}),
        machine_count: machineCount,
        pool_count: pool.length,
        ...(need !== null ? { need: { ...need } } : {}),
        channels: rows,
        notes,
      }
      // 文本图标（🌕🌓💰）在 render 阶段按 state/display 重算，不进结构化输出（iconForRow）。
    },
  }
}
