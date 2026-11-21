/**
 * model_eval_run 工具（M5-MVP / M5.1 / M5.2；计划 docs/10-m5-eval-plan.md，任务书 docs/briefs/m5.2-expand-eval.md）。
 *
 * 定位：在**对话内**跑一轮自动评测，把证据写成 JSONL（<DSH_HOME>/mroute/eval-history/<run_id>.jsonl），
 * 把摘要写进配置 `model_eval[canonical]` 与 `eval_status`。
 * 题集两档：lite/1（6 题，5 次调用）与 formal/2（55 题，54 次调用）。
 *
 * 默认 **dry_run:true**：只做预算/白名单/档位预检并渲染计划，**零调用、零写盘**。
 *
 * 红线（任务书 §2 / 计划 §9）：
 * 1. 只写 `model_eval`（按统一模型名）与 `eval_status` 两个顶层字段；**永不写** channels[].tier /
 *    channels[].priority / model_ratings（suggest 只是面板展示的建议值，排序链不消费）。
 * 2. 不改 ranking.js / assembleRouteTable / 既有工具任何字节（本文件只读引用 rankChannels）。
 * 3. 成本闸：单题 maxTokens 来自题面分档（coding/orchestration 8192、tools/long_context 2048、
 *    哨兵 1024、vision 0），`max_tokens` 入参提供则覆盖全部可执行题（clamp 1..200000）；
 *    max_calls 默认 18 硬顶 80（与 runner.mjs HARD_MAX_CALLS 同源）、
 *    渠道白名单默认 prepaid（allow_monthly:true 才纳入包月；voucher 在 MVP 一律排除）、
 *    日预算 500 次（2026-11-21 两次一次性放宽：368+108=476；常规按 300，M5.3 起回落）。
 * 4. 不发任何出站 HTTP、不读密钥：所有模型流量经宿主 `ctx.llm.prepareCall/stream`（adapter 自带凭据）。
 * 5. effort 钉死：dry_run 阶段用 `ctx.llm.resolveModelInfo`（宿主本地能力查询）取各模型 efforts，
 *    取共同最高偏好档（优先 high）；取不到时不钉死，报告中显式标注（跨模型比较需谨慎）。
 * 6. 宿主工具 JSON schema 只用单一 type 字符串（禁 type 数组）；可空字段发单一 type、无值不发键。
 */
import * as SUITE_LITE from './eval/suite-lite.mjs'
import * as SUITE_FORMAL from './eval/suite-formal.mjs'
import { aggregateModel, finishCounts } from './eval/score.mjs'
import {
  choosePinnedEfforts,
  runSuite,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_CALLS,
  HARD_MAX_CALLS,
} from './eval/runner.mjs'
import {
  createEvalRecorder,
  writeRunSummary,
  makeRunId,
  countCallsToday,
  defaultEvalHistoryDir,
} from './eval/store.mjs'
import { rankChannels, livecheckAll } from './ranking.js'
import { canonicalOf } from './registry.js'
import { errorMessage } from './errors.js'

export const TOOL_NAME = 'model_eval_run'
/**
 * 日调用预算（任务书 §2：200 → 300，M5.2 起）。
 * 2026-11-21 当日 M5.1（4 run × 38 = 152 次）与本轮 formal/2（4 × 54 = 216 次）同日执行，
 * 合计 368 次 > 300；经 lead 裁决**仅本轮一次性放宽到 400**（证据不归档、计数不绕过），
 * 下一里程碑回落 300。见 devlog §24 与报告 §1 的披露。
 * 2026-11-21 晚追加：用户要求补测包月渠道 GLM（glm-5.3 + glm-5.3-flash，各 54 次 = 108 次），
 * 当日累计将达 368 + 108 = 476；经用户裁决再次一次性放宽到 500（同样不归档、不绕过计数）。
 * 常规值仍应按 300 执行，M5.3 起回落。
 */
export const DAILY_CALL_BUDGET = 500
/** `max_tokens` 覆盖参边界（任务书 §2.2）。 */
export const MAX_TOKENS_MIN = 1
export const MAX_TOKENS_MAX = 200000
const MAX_MODELS_ARG = 10
const CHANNEL_TYPE_VALUES = ['monthly', 'voucher', 'prepaid']
const DIMENSION_STATUS_VALUES = ['graded', 'sentinel', 'invalid', 'null']
const SUITE_KEYS = ['lite', 'formal']
const DIMENSIONS = SUITE_LITE.DIMENSIONS

/**
 * 题集注册表（M5.1：suite 入参缺省 'lite' 向后兼容）。
 * 每项预计算：graded / sentinels / nulls / sentinelDimensions（报告与 composite 口径一致：哨兵不计分）。
 */
const SUITES = {
  lite: { key: 'lite', version: SUITE_LITE.SUITE_VERSION, tasks: SUITE_LITE.TASKS, executable: SUITE_LITE.EXECUTABLE_TASKS, sentinelCheck: SUITE_LITE.sentinelCheck },
  formal: { key: 'formal', version: SUITE_FORMAL.SUITE_VERSION, tasks: SUITE_FORMAL.TASKS, executable: SUITE_FORMAL.EXECUTABLE_TASKS, sentinelCheck: SUITE_FORMAL.sentinelCheck },
}
for (const suite of Object.values(SUITES)) {
  suite.graded = suite.executable.filter((task) => task.sentinel !== true)
  suite.sentinels = suite.executable.filter((task) => task.sentinel === true)
  suite.nulls = suite.tasks.filter((task) => task.skip === true)
  suite.sentinelDimensions = [...new Set(suite.sentinels.map((task) => task.dimension))]
}

/** 轻量类型断言：所有入参校验必须先于任何 IO（任务书 §3）。 */
function validateArgs(args) {
  if (args !== undefined && (args !== null) && (typeof args !== 'object' || Array.isArray(args))) {
    throw new Error(`${TOOL_NAME}: arguments must be an object`)
  }
  const input = args ?? {}
  const notes = []

  let models = null
  if (input.models !== undefined && input.models !== null) {
    if (!Array.isArray(input.models)) throw new Error(`${TOOL_NAME}: models 参数非法：必须是字符串数组`)
    if (input.models.length > MAX_MODELS_ARG) throw new Error(`${TOOL_NAME}: models 参数非法：最多 ${MAX_MODELS_ARG} 项`)
    models = input.models.map((entry) => {
      if (typeof entry !== 'string' || entry.trim() === '') {
        throw new Error(`${TOOL_NAME}: models 参数非法：每项必须是非空字符串（收到 ${JSON.stringify(entry ?? null)}）`)
      }
      return entry.trim()
    })
  }

  let limit = 3
  if (input.limit !== undefined && input.limit !== null) {
    if (typeof input.limit !== 'number' || !Number.isFinite(input.limit)) {
      throw new Error(`${TOOL_NAME}: limit 参数非法：必须是 1..10 的整数`)
    }
    limit = Math.min(10, Math.max(1, Math.floor(input.limit)))
    if (limit !== input.limit) notes.push(`limit 已收敛为 ${limit}（允许 1..10）`)
  }

  let suite = 'lite'
  if (input.suite !== undefined && input.suite !== null) {
    if (typeof input.suite !== 'string' || !SUITE_KEYS.includes(input.suite)) {
      throw new Error(`${TOOL_NAME}: suite 参数非法：必须是 "lite" 或 "formal"（收到 ${JSON.stringify(input.suite)}）`)
    }
    suite = input.suite
  }

  let dryRun = true
  if (input.dry_run !== undefined && input.dry_run !== null) {
    if (typeof input.dry_run !== 'boolean') throw new Error(`${TOOL_NAME}: dry_run 参数非法：必须是布尔值（缺省 true）`)
    dryRun = input.dry_run
  }

  let allowMonthly = false
  if (input.allow_monthly !== undefined && input.allow_monthly !== null) {
    if (typeof input.allow_monthly !== 'boolean') throw new Error(`${TOOL_NAME}: allow_monthly 参数非法：必须是布尔值（缺省 false）`)
    allowMonthly = input.allow_monthly
  }

  let maxCalls = DEFAULT_MAX_CALLS
  if (input.max_calls !== undefined && input.max_calls !== null) {
    if (typeof input.max_calls !== 'number' || !Number.isInteger(input.max_calls) || input.max_calls < 1) {
      throw new Error(`${TOOL_NAME}: max_calls 参数非法：必须是 ≥1 的整数（缺省 ${DEFAULT_MAX_CALLS}，硬顶 ${HARD_MAX_CALLS}）`)
    }
    maxCalls = Math.min(HARD_MAX_CALLS, input.max_calls)
    if (maxCalls !== input.max_calls) notes.push(`max_calls 已收敛为硬顶 ${HARD_MAX_CALLS}`)
  }

  // `max_tokens`：M5.2 覆盖参。语义 = **提供了就覆盖所有可执行题**（题面分档让位于显式入参），
  // clamp 到 [1, 200000]；非法类型直接报错（校验先于任何 IO）。
  let maxTokens = null
  if (input.max_tokens !== undefined && input.max_tokens !== null) {
    if (typeof input.max_tokens !== 'number' || !Number.isFinite(input.max_tokens)) {
      throw new Error(`${TOOL_NAME}: max_tokens 参数非法：必须是 ${MAX_TOKENS_MIN}..${MAX_TOKENS_MAX} 的整数（收到 ${JSON.stringify(input.max_tokens)}）`)
    }
    const floored = Math.floor(input.max_tokens)
    maxTokens = Math.min(MAX_TOKENS_MAX, Math.max(MAX_TOKENS_MIN, floored))
    if (maxTokens !== input.max_tokens) notes.push(`max_tokens 已收敛为 ${maxTokens}（允许 ${MAX_TOKENS_MIN}..${MAX_TOKENS_MAX}）`)
    notes.push(`max_tokens=${maxTokens} 覆盖全部可执行题（忽略题面分档）`)
  }
  return { models, limit, suite, dryRun, allowMonthly, maxCalls, maxTokens, notes }
}

/** 当前动态层（只读配置快照，供排序复现 M4.5 的 tight 沉底；不触发任何 quota 请求）。 */
function dynamicByIdOf(readConfigValue) {
  const snapshot = typeof readConfigValue === 'function' ? readConfigValue('dynamic_snapshot') : undefined
  const rows = Array.isArray(snapshot?.rows) ? snapshot.rows : []
  const map = new Map()
  for (const row of rows) {
    if (typeof row?.id !== 'string') continue
    map.set(row.id, {
      state: typeof row.state === 'string' ? row.state : 'ok',
      reasons: typeof row.reason === 'string' && row.reason !== '' ? [row.reason] : [],
    })
  }
  return map
}

/**
 * 候选装配：按既有排序链（livecheck 沉底 → 动态 tight 沉底 → channel_type → tier → priority → id）
 * 逐渠道取模型，按统一模型名去重（同一模型跨渠道只测最高序渠道），再按 models 入参过滤、limit 截断。
 * @returns {{ targets:Array<object>, excluded:string[], notes:string[] }}
 */
function buildCandidates({ registry, liveById, dynamicById, models, limit, allowMonthly }) {
  const excluded = []
  const notes = []
  const { ranked } = rankChannels(registry.channels, liveById, dynamicById)
  const targets = []
  const seen = new Set()
  const wanted = models === null ? null : new Set(models)
  const filters = models === null ? null : models.slice()
  for (const entry of ranked) {
    const channel = entry.channel
    if (channel.channel_type === 'voucher') {
      excluded.push(`${channel.id}: 券渠道（MVP 白名单只 prepaid，voucher 不参与）`)
      continue
    }
    if (channel.channel_type === 'monthly' && allowMonthly !== true) {
      excluded.push(`${channel.id}: 包月渠道（需 allow_monthly:true）`)
      continue
    }
    if (entry.live?.status !== 'ok') {
      excluded.push(`${channel.id}: provider 活校验 ${entry.live?.status ?? 'unknown'}（${entry.live?.detail || '目录不可用'}）`)
      continue
    }
    const available = Array.isArray(entry.live.availableModels) ? entry.live.availableModels : []
    for (const modelId of Array.isArray(channel.models) ? channel.models : []) {
      if (typeof modelId !== 'string' || modelId === '') continue
      const canonical = canonicalOf(registry.model_aliases, channel.id, modelId)
      if (available.length > 0 && !available.includes(modelId)) {
        excluded.push(`${channel.id}/${modelId}: 不在渠道目录（catalog 未列出，跳过）`)
        continue
      }
      if (filters !== null) {
        const hit = filters.some((token) => token === canonical || token === modelId || token === `${channel.routeProvider}/${modelId}` || token === channel.id)
        if (!hit) continue
      }
      if (seen.has(canonical)) {
        excluded.push(`${channel.id}/${modelId}: 统一模型名 "${canonical}" 已在更高序渠道入选（跨渠道去重）`)
        continue
      }
      seen.add(canonical)
      targets.push({
        canonical,
        provider: channel.routeProvider,
        model: modelId,
        channel_id: channel.id,
        channel_type: channel.channel_type,
        tier: channel.tier,
        priority: channel.priority,
        effort: '',
      })
    }
  }
  if (models !== null) {
    for (const token of filters) {
      const matched = targets.some((target) => token === target.canonical || token === target.model || token === `${target.provider}/${target.model}` || token === target.channel_id)
      if (!matched) {
        notes.push(`models 中的 "${token}" 未匹配到任何候选（可用: ${targets.map((t) => t.canonical).join(', ') || '空'}）`)
      }
    }
  }
  if (wanted !== null && targets.length === 0) {
    throw new Error(`${TOOL_NAME}: models 参数无匹配候选（${filters.join(', ')}）；先 dry_run 看可用清单（不传 models）`)
  }
  const limited = targets.slice(0, limit)
  if (targets.length > limited.length) notes.push(`候选 ${targets.length} 个，按 limit=${limit} 只评测前 ${limited.length} 个`)
  return { targets: limited, excluded, notes }
}

/** 逐模型读宿主目录里的 reasoning 档位（本地能力查询，失败不阻断，只标注）。 */
async function resolveEfforts(llm, targets) {
  const entries = []
  const problems = []
  for (const target of targets) {
    let efforts = []
    try {
      if (typeof llm?.resolveModelInfo !== 'function') throw new Error('ctx.llm.resolveModelInfo 不可用')
      const info = await llm.resolveModelInfo(target.provider, target.model)
      const list = Array.isArray(info?.reasoning?.efforts) ? info.reasoning.efforts : []
      efforts = list.map((effort) => (typeof effort === 'string' ? effort : effort?.id)).filter((id) => typeof id === 'string' && id !== '')
    } catch (error) {
      problems.push(`${target.canonical}: 档位目录读取失败（${errorMessage(error)}），本轮不钉死 effort`)
    }
    entries.push({ key: `${target.provider}/${target.model}`, efforts })
  }
  const chosen = choosePinnedEfforts(entries)
  for (const target of targets) target.effort = chosen.effortByKey[`${target.provider}/${target.model}`] ?? ''
  return { pinned: chosen, problems }
}

/** 写回两个顶层字段（失败静默：返回文本里给 eval_status_error，不抛）。 */
async function persistEval(ctx, { summaries, evalStatus, logger }) {
  try {
    const entry = ctx?.fiber?.entry
    const editor = typeof ctx?.get === 'function' ? ctx.get('configEditor') : undefined
    if (!entry || !editor || typeof editor.edit !== 'function') {
      return { written: false, ok: false, error: 'configEditor 不可用（宿主面缺席）' }
    }
    await editor.edit(entry, (current) => {
      const table = current?.model_eval !== null && typeof current?.model_eval === 'object' && !Array.isArray(current.model_eval)
        ? current.model_eval
        : {}
      return {
        ...current,
        ...(summaries === null ? {} : { model_eval: { ...table, ...summaries } }),
        eval_status: evalStatus,
      }
    })
    return { written: true, ok: true }
  } catch (error) {
    const message = errorMessage(error)
    logger?.warn?.(`[mroute] eval 配置写回失败（忽略）: ${message}`)
    return { written: false, ok: false, error: message }
  }
}

function formatPct(value, digits = 2) {
  return Number.isFinite(value) && value >= 0 ? value.toFixed(digits) : '—'
}

function describeTarget(target) {
  return `${target.canonical}（${target.provider}/${target.model}, ${target.channel_type}${target.effort ? `, effort=${target.effort}` : ''}）`
}

/** 生效 maxTokens 分布文本：按维汇总（覆盖参生效时压成一条）。 */
function describeMaxTokens(effectiveTasks, maxTokensOverride) {
  if (maxTokensOverride !== null) return `max_tokens=${maxTokensOverride} 覆盖全部 ${effectiveTasks.length} 道可执行题`
  const byDimension = new Map()
  for (const task of effectiveTasks) {
    const entry = byDimension.get(task.dimension) ?? { tokens: task.maxTokens, count: 0 }
    entry.count += 1
    byDimension.set(task.dimension, entry)
  }
  const order = [...DIMENSIONS, ...byDimension.keys()].filter((dim, index, list) => byDimension.has(dim) && list.indexOf(dim) === index)
  return order.map((dim) => `${dim}=${byDimension.get(dim).tokens}×${byDimension.get(dim).count}`).join(' · ')
}

/** dry_run 文本：预算 + 白名单 + 将评测清单（可直接读，不写盘）。 */
function renderPlan({ suite, runId, targets, excluded, effortNote, effortProblems, maxCalls, allowMonthly, daily, plannedCalls, effectiveTasks, maxTokensOverride, notes }) {
  const lines = []
  lines.push(`评测预检 · model eval / suite ${suite.version} · ${suite.graded.length} 道判分题 + ${suite.sentinels.length} 道校准哨兵（不计入 composite） + ${suite.nulls.length} 道恒 null · effort=${effortNote}`)
  lines.push(`渠道白名单：${allowMonthly ? 'prepaid + monthly(allow_monthly=true)' : 'prepaid（allow_monthly=false）'}；voucher 在 MVP 不参与`)
  lines.push(`将评测（${targets.length} 个统一模型名，跨渠道已去重）：`)
  for (const [index, target] of targets.entries()) lines.push(`  ${index + 1}. ${describeTarget(target)}`)
  lines.push(`预算：计划 ${plannedCalls} 次调用（上限 max_calls=${maxCalls}）· 生效 maxTokens 分布：${describeMaxTokens(effectiveTasks, maxTokensOverride)} · 单题超时 ${Math.round(DEFAULT_TIMEOUT_MS / 1000)}s · 串行`)
  const projected = daily.count + plannedCalls
  lines.push(`今日已调用 ${daily.count} 次（日预算 ${DAILY_CALL_BUDGET}）· 本轮预计再调 ${plannedCalls} 次 → 当日累计 ${projected} 次${projected > DAILY_CALL_BUDGET ? '，超出日预算 → 实跑会被拒绝' : ''}`)
  if (excluded.length > 0) {
    lines.push(`排除：`)
    for (const line of excluded.slice(0, 8)) lines.push(`  - ${line}`)
    if (excluded.length > 8) lines.push(`  - …另有 ${excluded.length - 8} 条`)
  }
  for (const problem of effortProblems) lines.push(`⚠ ${problem}`)
  for (const note of notes) lines.push(`注：${note}`)
  lines.push('（dry_run：未写盘、零模型调用。加 dry_run:false 才会真正执行）')
  return lines.join('\n')
}

/** 实跑文本：每模型分数/维度状态/finish 计数/suggest + 写回结论。 */
function renderRun({ suite, runId, jsonlPath, summaryPath, instrumentHealthy, sentinel, callsExecuted, skipped, maxCalls, maxTokensOverride, results, configWrite }) {
  const lines = []
  lines.push(`评测完成 · run ${runId} · suite ${suite.version} · 实调 ${callsExecuted} 次${skipped.length > 0 ? `（达到 max_calls=${maxCalls}，跳过 ${skipped.length} 题）` : ''}${maxTokensOverride === null ? '' : ` · max_tokens=${maxTokensOverride}（覆盖全部可执行题）`}`)
  lines.push(`instrument_healthy=${instrumentHealthy}（判分器哨兵：${sentinel.ok ? `${suite.executable.length}/${suite.executable.length} 通过` : `破 → ${sentinel.issues.join('；')}`}）`)
  lines.push(`题集：${suite.graded.length} 道判分（计入 composite）+ ${suite.sentinels.length} 道校准哨兵（scores 留证据，不计入 composite/samples）+ ${suite.nulls.length} 道 vision 恒 null`)
  for (const result of results) {
    lines.push('')
    lines.push(`${result.canonical}（${result.provider}/${result.model}, ${result.channel_type}）samples=${result.samples} composite=${formatPct(result.composite)} wilson_lb=${formatPct(result.wilson_lb)} provisional=${result.provisional}${result.effort ? ` effort=${result.effort}` : ''}`)
    lines.push(`  维度：${DIMENSIONS.map((dim) => `${dim}=${result.dimension_status[dim]}${result.scores[dim] >= 0 ? `(${result.scores[dim].toFixed(2)})` : '(-1)'}`).join(' · ')}`)
    lines.push(`  finish：stop=${result.finish.stop} tool-calls=${result.finish['tool-calls']} max-tokens=${result.finish['max-tokens']} error=${result.finish.error} aborted=${result.finish.aborted}${result.finish.unknown > 0 ? ` unknown=${result.finish.unknown}` : ''}`)
    lines.push(`  suggest：tier=${result.suggest.tier === '' ? "''" : result.suggest.tier} priority_delta=${result.suggest.priority_delta >= 0 ? '+' : ''}${result.suggest.priority_delta} · ${result.suggest.note}`)
  }
  lines.push('')
  lines.push(`证据：${jsonlPath}`)
  if (summaryPath !== '') lines.push(`摘要：${summaryPath}`)
  lines.push(
    configWrite.ok
      ? `写回：${results.map((result) => `model_eval["${result.canonical}"]`).join(' + ')} + eval_status(state=${instrumentHealthy ? 'ok' : 'failed'})`
      : `写回失败（不影响证据）：${configWrite.error ?? '未知错误'}`,
  )
  return lines.join('\n')
}

/** 单个模型的结果行（结构化输出用；scores/dimension_status 固定六键）。 */
function resultRowOf(target, calls, { instrumentHealthy, runId, refs, suite }) {
  const summary = aggregateModel({
    calls,
    applied_effort: target.effort,
    instrument_healthy: instrumentHealthy,
    run_id: runId,
    evidence_refs: refs,
    currentTier: target.tier,
    sentinel_dimensions: suite.sentinelDimensions,
  })
  return {
    canonical: target.canonical,
    provider: target.provider,
    model: target.model,
    channel_id: target.channel_id,
    channel_type: target.channel_type,
    effort: target.effort,
    samples: summary.samples,
    composite: summary.composite,
    wilson_lb: summary.wilson_lb,
    provisional: summary.provisional,
    scores: { ...summary.scores },
    dimension_status: { ...summary.dimension_status },
    suggest: { ...summary.suggest },
    finish: finishCounts(calls),
    summary,
  }
}

const DIMENSION_ENUM = { type: 'string', enum: DIMENSION_STATUS_VALUES }
const TARGET_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    canonical: { type: 'string' },
    provider: { type: 'string' },
    model: { type: 'string' },
    channel_id: { type: 'string' },
    channel_type: { type: 'string', enum: CHANNEL_TYPE_VALUES },
    tier: { type: 'string', enum: ['overseas_sota', 'domestic_sota', 'bulk'] },
    priority: { type: 'integer' },
    effort: { type: 'string' },
  },
  required: ['canonical', 'provider', 'model', 'channel_id', 'channel_type', 'effort'],
}
const RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    canonical: { type: 'string' },
    provider: { type: 'string' },
    model: { type: 'string' },
    channel_id: { type: 'string' },
    channel_type: { type: 'string', enum: CHANNEL_TYPE_VALUES },
    effort: { type: 'string' },
    samples: { type: 'integer' },
    composite: { type: 'number' },
    wilson_lb: { type: 'number' },
    provisional: { type: 'boolean' },
    scores: {
      type: 'object',
      additionalProperties: false,
      properties: Object.fromEntries(DIMENSIONS.map((dim) => [dim, { type: 'number' }])),
      required: [...DIMENSIONS],
    },
    dimension_status: {
      type: 'object',
      additionalProperties: false,
      properties: Object.fromEntries(DIMENSIONS.map((dim) => [dim, DIMENSION_ENUM])),
      required: [...DIMENSIONS],
    },
    suggest: {
      type: 'object',
      additionalProperties: false,
      properties: {
        tier: { type: 'string' },
        priority_delta: { type: 'integer' },
        note: { type: 'string' },
      },
      required: ['tier', 'priority_delta', 'note'],
    },
    finish: {
      type: 'object',
      additionalProperties: false,
      properties: {
        stop: { type: 'integer' },
        'tool-calls': { type: 'integer' },
        'max-tokens': { type: 'integer' },
        error: { type: 'integer' },
        aborted: { type: 'integer' },
        unknown: { type: 'integer' },
      },
      required: ['stop', 'tool-calls', 'max-tokens', 'error', 'aborted', 'unknown'],
    },
  },
  required: ['canonical', 'provider', 'model', 'channel_id', 'channel_type', 'effort', 'samples', 'composite', 'wilson_lb', 'provisional', 'scores', 'dimension_status', 'suggest', 'finish'],
}

/**
 * @param {{ ctx:object, getRegistry:Function, livecheck:object, logger?:object, readConfigValue?:Function,
 *           historyDir?:string }} deps historyDir 仅自检注入（缺省 ~/.dsh/mroute/eval-history）
 */
export function createEvalRunTool({ ctx, getRegistry, livecheck, logger, readConfigValue, historyDir }) {
  const evalDir = typeof historyDir === 'string' && historyDir !== '' ? historyDir : defaultEvalHistoryDir()
  return {
    name: TOOL_NAME,
    description:
      '跑一轮模型自动评测（suite 缺省 lite/1：4 道判分题 + 1 道校准哨兵 + 1 道 vision 恒 null；'
      + 'suite:"formal" 为 M5.2 正式卷 formal/2：coding 13 / tools 13 / long_context 13 / orchestration 13 判分题 + 2 道校准哨兵 + 1 道 vision 恒 null，共 54 次/模型）。'
      + '默认 dry_run:true 只预检不调用不写盘；dry_run:false 才真正串行调用宿主 llm 并写 '
      + '<DSH_HOME>/mroute/eval-history/<run_id>.jsonl 与配置 model_eval/eval_status。'
      + '成本闸：单题 maxTokens 按维分档（coding/orchestration 8192、tools/long_context 2048、哨兵 1024），'
      + 'max_tokens 入参提供则覆盖全部可执行题（clamp 1..200000）；max_calls 默认 18 硬顶 80、'
      + `默认只测 prepaid 渠道、日预算 ${DAILY_CALL_BUDGET} 次（2026-11-21 M5.2 一次性放宽，常规 300）。`
      + '结果只作 advisory 建议值（suggest），不修改渠道排序字段。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        suite: {
          type: 'string',
          enum: ['lite', 'formal'],
          description: '题集版本：缺省 "lite"（M5-MVP 6 题）；"formal"（M5.2 正式卷 formal/2，54 次/模型，需 max_calls≥54 才能单轮跑完单模型）。',
        },
        models: {
          type: 'array',
          items: { type: 'string' },
          description: '要评测的模型（统一模型名 / 模型 id / provider/model / 渠道 id 均可，最多 10 项）；缺省按排序链取前 limit 个。',
        },
        limit: {
          type: 'integer',
          description: '候选模型数上限 1..10（缺省 3）；超出按边界收敛。',
        },
        dry_run: {
          type: 'boolean',
          description: '缺省 true：只预检不调用不写盘；false 才真正执行（产生真实模型调用与写盘）。',
        },
        allow_monthly: {
          type: 'boolean',
          description: '缺省 false：只评测 prepaid 渠道；true 才纳入包月（monthly）渠道。',
        },
        max_calls: {
          type: 'integer',
          description: `本轮真实调用上限（缺省 ${DEFAULT_MAX_CALLS}，硬顶 ${HARD_MAX_CALLS}）。`,
        },
        max_tokens: {
          type: 'integer',
          description: `覆盖全部可执行题的单题输出上限 ${MAX_TOKENS_MIN}..${MAX_TOKENS_MAX}（缺省用题面分档）；超出按边界收敛。`,
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string' },
          run_id: { type: 'string' },
          suite_version: { type: 'string' },
          dry_run: { type: 'boolean' },
          allow_monthly: { type: 'boolean' },
          instrument_healthy: { type: 'boolean' },
          max_calls: { type: 'integer' },
          max_tokens: { type: 'integer' },
          calls_planned: { type: 'integer' },
          calls_executed: { type: 'integer' },
          skipped_count: { type: 'integer' },
          daily_calls_before: { type: 'integer' },
          effort_mode: { type: 'string', enum: ['common', 'per-model', 'none'] },
          effort_note: { type: 'string' },
          sentinel: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean' },
              issues: { type: 'array', items: { type: 'string' } },
            },
            required: ['ok', 'issues'],
          },
          targets: { type: 'array', items: TARGET_SCHEMA },
          results: { type: 'array', items: RESULT_SCHEMA },
          jsonl_path: { type: 'string' },
          summary_path: { type: 'string' },
          config_write: {
            type: 'object',
            additionalProperties: false,
            properties: {
              written: { type: 'boolean' },
              ok: { type: 'boolean' },
              error: { type: 'string' },
            },
            required: ['written', 'ok'],
          },
          notes: { type: 'array', items: { type: 'string' } },
        },
        required: [
          'text', 'run_id', 'suite_version', 'dry_run', 'allow_monthly', 'instrument_healthy',
          'max_calls', 'calls_planned', 'calls_executed', 'skipped_count',
          'sentinel', 'targets', 'config_write', 'notes',
        ],
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    isConcurrencySafe: () => false,
    async execute(args, _exec) {
      // ── 1) 入参校验（先于任何 IO）───────────────────────────────────
      const parsed = validateArgs(args)
      const suite = SUITES[parsed.suite]
      const notes = [...parsed.notes]
      // M5.2：max_tokens 覆盖参——提供则替换全部可执行题的 maxTokens；
      // 只改副本，不改题面对象本身（同一进程内 lite/formal 共用同一份 TASKS）。
      const effectiveTasks = parsed.maxTokens === null
        ? suite.executable
        : suite.executable.map((task) => ({ ...task, maxTokens: parsed.maxTokens }))

      // ── 2) 注册表 + 活校验 + 动态层（本地配置/目录读取，零出站 HTTP）──────
      const registry = getRegistry()
      const liveById = await livecheckAll(livecheck, registry.channels, logger)
      const dynamicById = dynamicByIdOf(readConfigValue)
      const built = buildCandidates({
        registry,
        liveById,
        dynamicById,
        models: parsed.models,
        limit: parsed.limit,
        allowMonthly: parsed.allowMonthly,
      })
      notes.push(...built.notes)
      const targets = built.targets
      if (targets.length === 0) {
        throw new Error(`${TOOL_NAME}: 没有可评测的候选（检查渠道类型白名单/活校验/渠道 models[]；可先 model_route_sync_models）`)
      }

      // ── 3) effort 钉死（宿主目录能力查询；失败不阻断）────────────────────
      const effortResult = await resolveEfforts(ctx?.llm, targets)
      for (const problem of effortResult.problems) notes.push(problem)

      const plannedCalls = targets.length * effectiveTasks.length
      const sentinel = suite.sentinelCheck(suite.tasks)
      const daily = await countCallsToday({ dir: evalDir, logger })
      const runId = makeRunId()
      const common = {
        run_id: runId,
        suite_version: suite.version,
        allow_monthly: parsed.allowMonthly,
        instrument_healthy: sentinel.ok,
        max_calls: parsed.maxCalls,
        ...(parsed.maxTokens === null ? {} : { max_tokens: parsed.maxTokens }),
        calls_planned: plannedCalls,
        effort_mode: effortResult.pinned.mode,
        effort_note: effortResult.pinned.note,
        sentinel: { ok: sentinel.ok, issues: sentinel.issues },
        targets: targets.map((target) => ({ ...target })),
        notes,
      }

      // ── 4) dry_run：零调用、零写盘 ─────────────────────────────────────
      if (parsed.dryRun) {
        const text = renderPlan({
          suite,
          runId,
          targets,
          excluded: built.excluded,
          effortNote: effortResult.pinned.note,
          effortProblems: effortResult.problems,
          maxCalls: parsed.maxCalls,
          allowMonthly: parsed.allowMonthly,
          daily,
          plannedCalls,
          effectiveTasks,
          maxTokensOverride: parsed.maxTokens,
          notes,
        })
        return {
          ...common,
          text,
          dry_run: true,
          calls_executed: 0,
          skipped_count: 0,
          daily_calls_before: daily.count,
          config_write: { written: false, ok: true },
        }
      }

      // ── 5) 成本闸：日预算 + 哨兵（任一不满足即拒跑，零调用）──────────────
      if (daily.count >= DAILY_CALL_BUDGET) {
        throw new Error(`${TOOL_NAME}: 今日已调用 ${daily.count} 次，达到日预算 ${DAILY_CALL_BUDGET}，拒跑（明日再试或先用 dry_run 看计划）`)
      }
      if (!sentinel.ok) {
        const evalStatus = {
          as_of: new Date().toISOString(),
          state: 'failed',
          run_id: runId,
          note: `判分器哨兵未通过：${sentinel.issues.join('；')}`,
        }
        const configWrite = await persistEval(ctx, { summaries: null, evalStatus, logger })
        const text = [
          `评测中止 · run ${runId} · 判分器哨兵未通过，本轮不调用模型、不写分数`,
          `原因：${sentinel.issues.join('；')}`,
          configWrite.ok ? 'eval_status 已写为 failed' : `eval_status 写回失败：${configWrite.error ?? '未知错误'}`,
        ].join('\n')
        return {
          ...common,
          text,
          dry_run: false,
          calls_executed: 0,
          skipped_count: 0,
          daily_calls_before: daily.count,
          results: [],
          config_write: configWrite,
        }
      }

      // ── 6) 运行态先行：先写 running，否则「跑了很久」与「从未跑过」在面板上同形（M4.10 教训）──
      const runningStatus = {
        as_of: new Date().toISOString(),
        state: 'running',
        run_id: runId,
        note: `suite ${suite.version} · ${targets.length} 模型 × ${suite.executable.length} 题 · 串行进行中（预计 ≤${plannedCalls} 次调用）`,
      }
      const runningWrite = await persistEval(ctx, { summaries: null, evalStatus: runningStatus, logger })
      if (runningWrite.ok !== true) notes.push(`eval_status(running) 写回失败（不影响本轮）：${runningWrite.error ?? '未知错误'}`)

      // ── 7) 实跑：串行 + 每次调用追加一行 JSONL ──────────────────────────
      const recorder = createEvalRecorder({ dir: evalDir, runId, logger })
      const run = await runSuite({
        llm: ctx.llm,
        targets,
        tasks: effectiveTasks,
        maxCalls: parsed.maxCalls,
        timeoutMs: DEFAULT_TIMEOUT_MS,
        runId,
        suiteVersion: suite.version,
        logger,
        onCall: (record) => recorder.append(record),
      })
      const refs = [recorder.file]
      const rows = targets.map((target) => {
        const calls = run.calls.filter((call) => call.canonical === target.canonical)
        return resultRowOf(target, calls, { instrumentHealthy: sentinel.ok, runId, refs, suite })
      })
      const summaries = {}
      for (const row of rows) summaries[row.canonical] = row.summary
      const evalStatus = {
        as_of: new Date().toISOString(),
        state: 'ok',
        run_id: runId,
        note: `suite ${suite.version} · ${rows.map((row) => `${row.canonical}:samples=${row.samples}`).join(', ')}${run.stoppedReason ? ` · ${run.stoppedReason}` : ''}`,
      }
      const configWrite = await persistEval(ctx, { summaries, evalStatus, logger })
      const summaryPath = await writeRunSummary({
        dir: evalDir,
        runId,
        summary: {
          run_id: runId,
          suite_version: suite.version,
          as_of: evalStatus.as_of,
          instrument_healthy: sentinel.ok,
          allow_monthly: parsed.allowMonthly,
          effort: effortResult.pinned,
          targets,
          skipped: run.skipped,
          calls_executed: run.calls.length,
          results: rows.map((row) => ({ ...row.summary })),
          jsonl: recorder.file,
        },
        logger,
      })
      if (summaryPath === '') notes.push('摘要 JSON 写盘失败（JSONL 证据仍在）')
      const text = renderRun({
        suite,
        runId,
        jsonlPath: recorder.file,
        summaryPath,
        instrumentHealthy: sentinel.ok,
        sentinel,
        callsExecuted: run.calls.length,
        skipped: run.skipped,
        maxCalls: parsed.maxCalls,
        maxTokensOverride: parsed.maxTokens,
        results: rows,
        configWrite,
      })
      if (configWrite.ok !== true) notes.push(`eval_status_error: ${configWrite.error ?? '未知错误'}`)
      return {
        ...common,
        text,
        dry_run: false,
        calls_executed: run.calls.length,
        skipped_count: run.skipped.length,
        daily_calls_before: daily.count,
        results: rows.map((row) => {
          const { summary: _summary, ...rest } = row
          return rest
        }),
        jsonl_path: recorder.file,
        ...(summaryPath !== '' ? { summary_path: summaryPath } : {}),
        config_write: configWrite,
        notes,
      }
    },
  }
}

export default { createEvalRunTool, TOOL_NAME, DAILY_CALL_BUDGET }
