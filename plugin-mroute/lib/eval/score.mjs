/**
 * M5 统计层 —— Wilson 95% 下界、六维聚合、provisional 与 suggest 决胜（计划 §6）。
 *
 * 纪律：
 * 1. **只聚合 graded 样本**：status='invalid'（超时/finish 不在白名单）与 'skipped'（vision）
 *    一律不进入分数与 composite；scores[dim] 保持 -1 表示「无有效样本」。
 * 2. **Wilson 95% 下界**：整数化二项样本（pass=1/fail=0），z=1.96；n=0 → -1（哨兵值，不是 0）。
 * 3. **sentinel 维只留证据**：标记 sentinel 的维度（world_knowledge）scores 仍写正确率，但
 *    dimension_status='sentinel'，**不计入 samples/successes/composite/wilson_lb**——校准题太容易
 *    （多数模型必答对），计入会系统性抬高 composite，进而污染 priority_delta（计划 §5）。
 * 4. **provisional 门槛**：samples < 12 一律 provisional=true，此时**只允许出 priority_delta**
 *    （±10，且 coding/tools 两维下界均 ≥0.55 才出），**永远不出 tier**。
 * 5. **tier 建议**：samples≥12 且总下界 ≥0.75 才给候选，且只给**相对上一档**（bulk→domestic_sota、
 *    domestic_sota→overseas_sota、overseas_sota 已顶格不提）——绝不硬编码某一档，避免对 bulk 模型
 *    「跳两级」、对 overseas 模型反而「降级」（MVP 单模型 5 题到不了，但代码路径与自检保留）。
 * 6. **advisory-only**：suggest 只是写进 model_eval 的建议值，**不改 channels[].tier/priority**，
 *    排序消费方（M4 既有链路）只读不使用。
 */
import { DIMENSIONS } from './suite-lite.mjs'

export const WILSON_Z = 1.96
/** provisional 样本门槛（计划 §6：<12 题只出 priority_delta）。 */
export const PROVISIONAL_SAMPLES = 12
/** tier 建议的总下界门槛（计划 §6）。 */
export const TIER_LB_THRESHOLD = 0.75
/** priority_delta 允许区间（计划 §6：±10 封顶）。 */
export const PRIORITY_DELTA_CAP = 10
/** provisional 阶段 coding/tools 下界门槛（计划 §6）。 */
export const PROVISIONAL_DIM_LB = 0.55

// ── M5.1 分级量表（任务书 m5.1-formal-eval.md §4，报告 §3 取档公式）──────────
/** excellent：Wilson 95% 下界与正确率双门槛。 */
export const RATING_EXCELLENT_LB = 0.75
export const RATING_EXCELLENT_P = 0.92
/** good：仅看下界。 */
export const RATING_GOOD_LB = 0.55
/** fair：仅看正确率（不满足 good 时）。 */
export const RATING_FAIR_P = 0.30
/** 单维最小有效样本：不足 → 无数据（不做档位判断）。 */
export const RATING_MIN_SAMPLES = 6

/**
 * M5.1 取档公式（原样实现，报告 §3 注明）：
 *   excellent ⇔ lb ≥ 0.75 且 p ≥ 0.92；good ⇔ lb ≥ 0.55；fair ⇔ p ≥ 0.30（且不满足 good）；
 *   none ⇔ p < 0.30；无数据 ⇔ n < 6 或 n ≤ 0（该维 null/skipped/样本不足）。
 * @param {number} passed 通过数
 * @param {number} n 样本数
 * @returns {'excellent'|'good'|'fair'|'none'|'no_data'}
 */
export function suggestRating(passed, n) {
  const total = Number(n)
  if (!Number.isFinite(total) || total < RATING_MIN_SAMPLES) return 'no_data'
  const p = Math.min(1, Math.max(0, Number(passed) / total))
  const lb = wilsonLowerBound(passed, total)
  if (lb >= RATING_EXCELLENT_LB && p >= RATING_EXCELLENT_P) return 'excellent'
  if (lb >= RATING_GOOD_LB) return 'good'
  if (p >= RATING_FAIR_P) return 'fair'
  return 'none'
}

/**
 * Wilson score interval 下界（95%，z=1.96）。
 * @param {number} successes 成功数（整数）
 * @param {number} n 样本数（整数）
 * @param {number} z 分位
 * @returns {number} 0..1；n<=0 → -1（哨兵值，避免把「无样本」当成 0 分）
 */
export function wilsonLowerBound(successes, n, z = WILSON_Z) {
  const total = Number(n)
  if (!Number.isFinite(total) || total <= 0) return -1
  const p = Math.min(1, Math.max(0, Number(successes) / total))
  const z2 = z * z
  const denominator = 1 + z2 / total
  const centre = p + z2 / (2 * total)
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * total)) / total)
  return Math.max(0, (centre - margin) / denominator)
}

const clampDelta = (value) => Math.max(-PRIORITY_DELTA_CAP, Math.min(PRIORITY_DELTA_CAP, Math.round(value)))

function callsOf(calls, dimension) {
  return calls.filter((call) => call?.dimension === dimension)
}

/** 单维：graded 样本的下界（无 graded 样本 → -1）。 */
export function dimensionLowerBound(calls, dimension) {
  const graded = callsOf(calls, dimension).filter((call) => call.status === 'graded')
  if (graded.length === 0) return -1
  return wilsonLowerBound(graded.filter((call) => call.pass === true).length, graded.length)
}

/** tier 相对建议的上一档（顶格/未知档 → ''，即不提）。 */
export const TIER_NEXT = { bulk: 'domestic_sota', domestic_sota: 'overseas_sota' }

/** 当前档位 → 建议的上一档；已顶格或档位未知 → ''（不提）。 */
export function nextTierOf(currentTier) {
  return typeof currentTier === 'string' && Object.prototype.hasOwnProperty.call(TIER_NEXT, currentTier)
    ? TIER_NEXT[currentTier]
    : ''
}

/**
 * 六维聚合。
 * @param {{ calls:Array<object>, applied_effort:string, instrument_healthy:boolean,
 *           run_id:string, evidence_refs:string[], dimensions?:string[],
 *           currentTier?:string, sentinel_dimensions?:string[] }} input
 *        currentTier = 该模型当前所在渠道的 tier（用于「相对上一档」建议）；
 *        sentinel_dimensions = 声明为校准哨兵的维度（call.sentinel 也能标记，二者取或）。
 * @returns {object} 形状与 Config.model_eval 单条目一致（计划 §3）
 */
export function aggregateModel({
  calls,
  applied_effort,
  instrument_healthy,
  run_id,
  evidence_refs,
  dimensions = DIMENSIONS,
  currentTier = '',
  sentinel_dimensions = [],
}) {
  const sentinelSet = new Set(Array.isArray(sentinel_dimensions) ? sentinel_dimensions : [])
  const scores = {}
  const dimension_status = {}
  let gradedSamples = 0
  let successes = 0
  let gradedDimensions = 0
  let compositeSum = 0
  let sentinelSamples = 0
  for (const dimension of dimensions) {
    const bucket = callsOf(calls, dimension)
    const graded = bucket.filter((call) => call.status === 'graded')
    if (graded.length > 0) {
      const passes = graded.filter((call) => call.pass === true).length
      scores[dimension] = passes / graded.length
      const isSentinel = sentinelSet.has(dimension) || graded.some((call) => call.sentinel === true)
      if (isSentinel) {
        // 校准哨兵：留证据（正确率）但不参与 composite/samples。
        dimension_status[dimension] = 'sentinel'
        sentinelSamples += graded.length
      } else {
        dimension_status[dimension] = 'graded'
        gradedSamples += graded.length
        successes += passes
        gradedDimensions += 1
        compositeSum += scores[dimension]
      }
    } else {
      scores[dimension] = -1
      const invalid = bucket.filter((call) => call.status === 'invalid')
      dimension_status[dimension] = invalid.length > 0 ? 'invalid' : 'null'
    }
  }
  const composite = gradedDimensions > 0 ? compositeSum / gradedDimensions : -1
  const wilson_lb = wilsonLowerBound(successes, gradedSamples)
  const provisional = gradedSamples < PROVISIONAL_SAMPLES
  const codingLb = dimensionLowerBound(calls, 'coding')
  const toolsLb = dimensionLowerBound(calls, 'tools')
  const dimGate = codingLb >= PROVISIONAL_DIM_LB && toolsLb >= PROVISIONAL_DIM_LB
  let tier = ''
  let priority_delta = 0
  let note
  if (instrument_healthy !== true) {
    note = 'instrument_healthy=false：判分器哨兵未通过，本轮不写分数、不提建议'
  } else if (provisional) {
    if (dimGate) {
      priority_delta = clampDelta((composite - 0.5) * 20)
      note = `provisional（samples=${gradedSamples}<${PROVISIONAL_SAMPLES}，另 ${sentinelSamples} 个判分哨兵样本不计入）：仅出 priority_delta（coding/tools 下界 ${codingLb.toFixed(2)}/${toolsLb.toFixed(2)} ≥ ${PROVISIONAL_DIM_LB}）`
    } else {
      note = `provisional（samples=${gradedSamples}<${PROVISIONAL_SAMPLES}）且 coding/tools 下界 ${codingLb.toFixed(2)}/${toolsLb.toFixed(2)} 未达 ${PROVISIONAL_DIM_LB}：不给 priority_delta`
    }
  } else if (wilson_lb >= TIER_LB_THRESHOLD) {
    const candidate = nextTierOf(currentTier)
    if (candidate !== '') {
      tier = candidate
      priority_delta = clampDelta((composite - 0.5) * 20)
      note = `samples=${gradedSamples}≥${PROVISIONAL_SAMPLES} 且总下界 ${wilson_lb.toFixed(2)}≥${TIER_LB_THRESHOLD}：建议相对当前档 ${currentTier} → ${candidate}（advisory，未应用）`
    } else {
      note = `samples=${gradedSamples}≥${PROVISIONAL_SAMPLES} 且总下界 ${wilson_lb.toFixed(2)}≥${TIER_LB_THRESHOLD}，但当前档 ${currentTier || '(未知)'} 已顶格或不可识别：不提 tier`
    }
  } else {
    note = `samples=${gradedSamples}≥${PROVISIONAL_SAMPLES} 但总下界 ${wilson_lb.toFixed(2)}<${TIER_LB_THRESHOLD}：不提 tier`
  }
  return {
    last_run: run_id,
    applied_effort: typeof applied_effort === 'string' ? applied_effort : '',
    instrument_healthy: instrument_healthy === true,
    scores,
    dimension_status,
    composite,
    samples: gradedSamples,
    wilson_lb,
    provisional,
    suggest: { tier, priority_delta, note },
    evidence_refs: Array.isArray(evidence_refs) ? evidence_refs.filter((ref) => typeof ref === 'string') : [],
    // 性能探针按计划 §7 明确不做（probe 全 -1；ttft/tps 只留 JSONL 证据面）。
    probe: { ttft_ms: -1, tps: -1, samples: 0 },
  }
}

/** finish 计数（报告用）。 */
export function finishCounts(calls) {
  const counts = { stop: 0, 'tool-calls': 0, 'max-tokens': 0, error: 0, aborted: 0, unknown: 0 }
  for (const call of calls) {
    const kind = typeof call?.finish_kind === 'string' ? call.finish_kind : ''
    if (Object.prototype.hasOwnProperty.call(counts, kind)) counts[kind] += 1
    else counts.unknown += 1
  }
  return counts
}

export default { wilsonLowerBound, aggregateModel, dimensionLowerBound, finishCounts, nextTierOf, TIER_NEXT }
