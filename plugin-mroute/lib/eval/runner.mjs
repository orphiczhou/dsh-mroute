/**
 * M5 执行层 —— 串行跑题：prepareCall/stream 调用纪律（计划 §4）+ 三成本闸（§9 L1/L2）。
 *
 * 硬纪律（逐条对应计划 §4 / 任务书 §2）：
 * 1. `ctx.llm.prepareCall(config, signal, configure)` 是 **async**（宿主源码为准，计划片段漏 await）；
 *    configure(controls, modelInfo) 返回值与 {provider,model} 合并 → 用它钉死 reasoningEffort。
 * 2. `prepared.stream({ ...prepared.config, messages, tools?, signal })`：**必须 spread prepared.config**
 *    （宿主按 callConfigEquals 校验，否则 LlmError INVALID_PREPARED_CALL）；句柄一次性、不缓存、不重试。
 * 3. chunk 末两块固定为 usage（倒数第二）与 finish（最后）；finish.kind ∈ stop|tool-calls|max-tokens|
 *    error|aborted。白名单：tools 维允许 stop|tool-calls，其余维只允许 stop；其余一律 invalid（不写分）。
 * 4. maxTokens 必须显式（缺省可达 256000）——本 runner 从题面取 maxTokens，绝不省略。
 * 5. 超时自行 AbortController + setTimeout(...).unref()，不用宿主缺省；超时记 invalid/aborted。
 * 6. 串行：一个模型全部题跑完再下一个模型（避免并行打爆窗口/额度）；max_calls 到顶即停止新调用。
 * 7. 不发任何出站 HTTP、不读密钥：流量全走宿主 ctx.llm（adapter 自带凭据）。
 */
import { normalizeText } from './suite-lite.mjs'

export const DEFAULT_TIMEOUT_MS = 60_000
export const DEFAULT_MAX_CALLS = 18
export const HARD_MAX_CALLS = 40

/** finish 白名单：tools 维允许工具调用收尾，其余维只认纯文本收尾。 */
export const FINISH_WHITELIST = {
  tools: ['stop', 'tool-calls'],
  default: ['stop'],
}

/** 档位偏好：优先 high（deepseek 系与 mimo 系的共同档），再 max/xhigh/medium/low/minimal。 */
export const EFFORT_PREFERENCE = ['high', 'max', 'xhigh', 'medium', 'low', 'minimal']

/** 工具/文本增量累积（与探针实测的 chunk 形状一致）。 */
function createAccumulator() {
  return { text: '', reasoning: '', toolCalls: [], usage: null, finish: null, chunkCount: 0, ttftMs: -1, types: [] }
}

function pushChunk(acc, chunk, startedAt) {
  acc.chunkCount += 1
  if (acc.ttftMs < 0) acc.ttftMs = Date.now() - startedAt
  const type = chunk?.type
  acc.types.push(type)
  if (type === 'text-delta' && typeof chunk.text === 'string') acc.text += chunk.text
  if (type === 'reasoning-delta' && typeof chunk.text === 'string') acc.reasoning += chunk.text
  if (type === 'tool-call-delta') {
    let call = acc.toolCalls.find((entry) => entry.index === chunk.index)
    if (call === undefined) {
      call = { index: chunk.index, id: '', name: '', args: '' }
      acc.toolCalls.push(call)
    }
    if (typeof chunk.id === 'string' && chunk.id !== '') call.id = chunk.id
    if (typeof chunk.name === 'string' && chunk.name !== '') call.name = chunk.name
    if (typeof chunk.argumentsDelta === 'string') call.args += chunk.argumentsDelta
  }
  if (type === 'usage' && chunk.usage && typeof chunk.usage === 'object') acc.usage = chunk.usage
  if (type === 'finish' && chunk.reason && typeof chunk.reason === 'object') acc.finish = chunk.reason
}

/**
 * 共同档位裁决：优先取所有参与模型 efforts 交集里的最高偏好档（跨模型可比）；
 * 无共同档 → 各模型取自身最高偏好档并标注（mode='per-model'）；模型无 reasoning 面 → ''。
 * @param {Array<{ key:string, efforts:string[] }>} entries
 */
export function choosePinnedEfforts(entries) {
  const list = Array.isArray(entries) ? entries.filter((entry) => entry && Array.isArray(entry.efforts)) : []
  const withReasoning = list.filter((entry) => entry.efforts.length > 0)
  const effortByKey = {}
  if (withReasoning.length === 0) {
    for (const entry of list) effortByKey[entry.key] = ''
    return { effortByKey, mode: 'none', note: '模型无 reasoning 档位面，不传 effort（adapter 缺省行为）' }
  }
  let common = withReasoning[0].efforts.slice()
  for (const entry of withReasoning.slice(1)) common = common.filter((id) => entry.efforts.includes(id))
  const shared = EFFORT_PREFERENCE.find((id) => common.includes(id)) ?? ''
  if (shared !== '') {
    for (const entry of list) effortByKey[entry.key] = entry.efforts.length > 0 ? shared : ''
    return { effortByKey, mode: 'common', note: `共同档 ${shared}(钉死，跨模型可比)` }
  }
  for (const entry of list) {
    if (entry.efforts.length === 0) {
      effortByKey[entry.key] = ''
      continue
    }
    effortByKey[entry.key] = EFFORT_PREFERENCE.find((id) => entry.efforts.includes(id)) ?? entry.efforts[entry.efforts.length - 1]
  }
  return { effortByKey, mode: 'per-model', note: '参与模型无共同档位，各取自身最高偏好档（跨模型比较需注意档位差异）' }
}

/** 单题一次调用。返回的 record 同时是 JSONL 的一行（一行 = 一次真实调用）。 */
export async function runTask({
  llm,
  canonical,
  provider,
  model,
  task,
  effort,
  runId,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  suiteVersion,
}) {
  const startedAt = Date.now()
  const base = {
    run_id: runId,
    ts: new Date().toISOString(),
    suite_version: suiteVersion,
    canonical,
    provider,
    model,
    task_id: task.id,
    dimension: task.dimension,
    sentinel: task.sentinel === true,
    max_tokens: task.maxTokens,
    finish_kind: '',
    applied_effort: typeof effort === 'string' ? effort : '',
    effort_mismatch: false,
    status: 'invalid',
    pass: false,
    detail: '',
    error: '',
    usage: null,
    ttft_ms: -1,
    elapsed_ms: 0,
    tps: -1,
    chunk_count: 0,
    text_preview: '',
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  timer.unref?.()
  const acc = createAccumulator()
  try {
    const prepared = await llm.prepareCall(
      { provider, model, maxTokens: task.maxTokens, temperature: 0 },
      controller.signal,
      (controls) => ({ ...controls, ...(typeof effort === 'string' && effort !== '' ? { reasoningEffort: effort } : {}) }),
    )
    const applied = typeof prepared?.config?.reasoningEffort === 'string' ? prepared.config.reasoningEffort : ''
    // effort='' 表示「不做钉死」（模型无 reasoning 面或目录不可读）：此时以 adapter materialize
    // 的档位回填 applied_effort，不算不一致；只有显式钉死却跑偏才是 invalid。
    const pinned = typeof effort === 'string' ? effort : ''
    base.effort_mismatch = pinned !== '' && applied !== pinned
    base.applied_effort = pinned !== '' ? pinned : applied
    const messages = [{ role: 'user', content: [{ type: 'text', text: task.prompt }] }]
    const options = {
      ...prepared.config,
      messages,
      ...(Array.isArray(task.tools) && task.tools.length > 0 ? { tools: task.tools } : {}),
      signal: controller.signal,
    }
    const stream = await prepared.stream(options)
    for await (const chunk of stream) pushChunk(acc, chunk, startedAt)
    base.finish_kind = typeof acc.finish?.kind === 'string' ? acc.finish.kind : ''
    base.usage = acc.usage
    base.ttft_ms = acc.ttftMs
    base.chunk_count = acc.chunkCount
    base.text_preview = normalizeText(acc.text).slice(0, 160)
    const whitelist = FINISH_WHITELIST[task.dimension] ?? FINISH_WHITELIST.default
    if (base.effort_mismatch) {
      base.status = 'invalid'
      base.detail = `effort 不一致：钉死 ${base.applied_effort || '(空)'}，实际 ${applied || '(空)'}`
    } else if (!whitelist.includes(base.finish_kind)) {
      base.status = 'invalid'
      base.detail = `finish.kind=${base.finish_kind || '(无)'} 不在白名单 [${whitelist.join(', ')}]`
    } else {
      const graded = task.grade({
        text: acc.text,
        toolCalls: acc.toolCalls.map((call) => ({ name: call.name, args: call.args })),
        finishKind: base.finish_kind,
      })
      base.status = 'graded'
      base.pass = graded.pass === true
      base.detail = String(graded.detail ?? '')
    }
  } catch (error) {
    const aborted = controller.signal.aborted
    base.status = 'invalid'
    base.finish_kind = aborted ? 'aborted' : base.finish_kind
    base.error = `${aborted ? 'timeout' : String(error?.code ?? error?.name ?? 'error')}: ${String(error?.message ?? error).slice(0, 200)}`
    base.detail = base.error
  } finally {
    clearTimeout(timer)
  }
  base.elapsed_ms = Date.now() - startedAt
  if (base.usage && base.usage.outputTokens > 0 && base.elapsed_ms > base.ttft_ms && base.ttft_ms >= 0) {
    base.tps = Math.round((base.usage.outputTokens / Math.max(1, base.elapsed_ms - base.ttft_ms)) * 1000)
  }
  return base
}

/**
 * 串行跑一轮。
 * @param {{ llm:object, targets:Array<{canonical:string,provider:string,model:string,effort:string}>,
 *           tasks:Array<object>, maxCalls:number, timeoutMs:number, runId:string, suiteVersion:string,
 *           logger?:object, onCall?:(record:object)=>void }} input
 * @returns {Promise<{ calls:Array<object>, skipped:Array<object>, stoppedReason:string }>}
 */
export async function runSuite({ llm, targets, tasks, maxCalls, timeoutMs = DEFAULT_TIMEOUT_MS, runId, suiteVersion, logger, onCall }) {
  const calls = []
  const skipped = []
  let stoppedReason = ''
  for (const target of targets) {
    for (const task of tasks) {
      if (calls.length >= maxCalls) {
        skipped.push({ canonical: target.canonical, task_id: task.id, reason: 'max_calls' })
        stoppedReason = `max_calls=${maxCalls}`
        continue
      }
      logger?.info?.(`[mroute] eval ${runId}: ${target.canonical} ${task.id} (${target.provider}/${target.model}, effort=${target.effort || 'n/a'})`)
      const record = await runTask({
        llm,
        canonical: target.canonical,
        provider: target.provider,
        model: target.model,
        task,
        effort: target.effort,
        runId,
        timeoutMs,
        suiteVersion,
      })
      calls.push(record)
      if (typeof onCall === 'function') {
        try {
          // 必须 await：JSONL 行数与真实调用数一致（落盘失败也不中断本轮，recorder 内部兜底）。
          await onCall(record)
        } catch (error) {
          logger?.warn?.(`[mroute] eval onCall 失败（忽略）: ${String(error?.message ?? error)}`)
        }
      }
    }
  }
  return { calls, skipped, stoppedReason }
}

export default { runTask, runSuite, choosePinnedEfforts, FINISH_WHITELIST, DEFAULT_TIMEOUT_MS }
