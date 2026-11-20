/**
 * 能力匹配推荐纯函数（M4.8 / 任务书 §2.1-§2.2）：need 入参校验 + 评级比较/匹配/评分。
 *
 * 语义：
 * - need = { [coding|tools|long_context|vision]: 'fair'|'good'|'excellent' }，多键 = 全部满足（AND）；
 *   空对象或缺省 = 不做匹配（调用方应转成 null，不产生任何匹配输出）。
 * - 评级序 fair(1) < good(2) < excellent(3)；'none' = 明确无此能力（0，**不满足任何需求**）；
 *   未登记（键缺失/非闭集值）= null（未知，**不算满足**，由调用方单独统计 unrated）。
 * - 纯函数：无 IO、无时钟、无随机；advisory-only，不参与 routes[] 排序。
 */
import { CAPABILITY_KEYS, CAPABILITY_RATINGS } from './config-schema.js'

/** 评级序值（'none' 显式 0 = 明确无能力；未登记不在表中 = null，由 ratingValueOf 区分）。 */
export const RATING_RANK = { none: 0, fair: 1, good: 2, excellent: 3 }

/** need 允许的维度键（闭集，与渠道/模型能力四维同源）。 */
export const NEED_KEYS = [...CAPABILITY_KEYS]

/** need 允许的评级值（闭集；需求侧不表达「无能力」，故不含 'none'）。 */
export const NEED_VALUES = [...CAPABILITY_RATINGS]

/** 文本展示：'none' 打印为「无」（任务书 §2.3.4 / §2.4）。 */
export const RATING_NONE_LABEL = '无'

/** 序值 → 评级名（minRatingInNeed 回显用）。 */
const RANK_LABEL = { 0: 'none', 1: 'fair', 2: 'good', 3: 'excellent' }

/** need 的维度键（保持 CAPABILITY_KEYS 顺序，只取合法字符串值）。 */
function needDimsOf(need) {
  if (need === null || typeof need !== 'object' || Array.isArray(need)) return []
  return CAPABILITY_KEYS.filter((dim) => typeof need[dim] === 'string')
}

/**
 * need 入参校验（任务书 §2.1：键闭集 + 值闭集、大小写敏感；非法值明确报哪个键/值）。
 * @param {unknown} input
 * @returns {{need: Record<string,string>|null, invalid: {message: string}|null}}
 *   - 省略/null → {need:null, invalid:null}（不做匹配）
 *   - 空对象 → {need:{}, invalid:null}（同样不做匹配，调用方归一为 null）
 *   - 非法 → {need:null, invalid:{message}}（`message` 可直接拼进工具错误，指明键/值与允许值）
 */
export function normalizeNeed(input) {
  if (input === undefined || input === null) return { need: null, invalid: null }
  if (typeof input !== 'object' || Array.isArray(input)) {
    return {
      need: null,
      invalid: { message: `need 必须是对象（键 ${CAPABILITY_KEYS.join('|')}，值 ${CAPABILITY_RATINGS.join('|')}）` },
    }
  }
  const need = {}
  for (const [key, value] of Object.entries(input)) {
    if (!CAPABILITY_KEYS.includes(key)) {
      return {
        need: null,
        invalid: { message: `未知能力维度 "${key}"（允许的键 ${CAPABILITY_KEYS.join('|')}）` },
      }
    }
    if (!CAPABILITY_RATINGS.includes(value)) {
      return {
        need: null,
        invalid: {
          message: `键 "${key}" 的值 ${JSON.stringify(value)} 非法（允许 ${CAPABILITY_RATINGS.join('|')}，大小写敏感）`,
        },
      }
    }
    need[key] = value
  }
  return { need, invalid: null }
}

/**
 * 单维评级序值：'none' → 0；fair/good/excellent → 1/2/3；未登记/非法/非对象 → null。
 * **'none' 与未登记严格区分**：前者是明确值 0，后者是未知 null（红线 4）。
 */
export function ratingValueOf(ratings, dim) {
  if (ratings === null || typeof ratings !== 'object' || Array.isArray(ratings)) return null
  if (typeof dim !== 'string') return null
  const value = ratings[dim]
  if (value === 'none') return 0
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(RATING_RANK, value) ? RATING_RANK[value] : null
}

/**
 * 是否满足全部需求（AND）：每个 need 维都必须有档位（非 null）且 ≥ 需求序值。
 * 'none'（0）与未登记（null）都不满足任何 need（需求值最小 fair=1）。
 * 空 need 返回 true（集合语义；调用方不应对空 need 调用匹配）。
 */
export function matchesNeed(ratings, need) {
  const dims = needDimsOf(need)
  if (dims.length === 0) return true
  for (const dim of dims) {
    const required = RATING_RANK[need[dim]]
    const value = ratingValueOf(ratings, dim)
    if (required === undefined || value === null || value < required) return false
  }
  return true
}

/**
 * 匹配质量主键（任务书 §2.3 + lead m00133 裁决）：need 各维度评级序值之和（降序用）。
 * 任一 need 维未登记 → null（不可评分，不参与匹配）。
 */
export function fitScore(ratings, need) {
  const dims = needDimsOf(need)
  if (dims.length === 0) return null
  let total = 0
  for (const dim of dims) {
    const value = ratingValueOf(ratings, dim)
    if (value === null) return null
    total += value
  }
  return total
}

/**
 * 匹配质量次键（降序用）：need 各维「模型序值 − 需求序值」的最小值（最小裕度）。
 * 任一 need 维未登记 → null。
 */
export function minMarginInNeed(ratings, need) {
  const dims = needDimsOf(need)
  if (dims.length === 0) return null
  let margin = null
  for (const dim of dims) {
    const required = RATING_RANK[need[dim]]
    const value = ratingValueOf(ratings, dim)
    if (required === undefined || value === null) return null
    const next = value - required
    margin = margin === null ? next : Math.min(margin, next)
  }
  return margin
}

/**
 * need 涉及维度上的最低评级名（文本「匹配模型: model(最低评级)」用；'none' 返回 'none'）。
 * 任一 need 维未登记 → null（文本省略括号）。
 */
export function minRatingInNeed(ratings, need) {
  const dims = needDimsOf(need)
  if (dims.length === 0) return null
  let lowest = null
  for (const dim of dims) {
    const value = ratingValueOf(ratings, dim)
    if (value === null) return null
    lowest = lowest === null ? value : Math.min(lowest, value)
  }
  return lowest === null ? null : RANK_LABEL[lowest]
}

/** need 文本摘要（任务书 §2.4 表头）：`coding≥good, vision≥good`（CAPABILITY_KEYS 顺序）。 */
export function needSummary(need) {
  const dims = needDimsOf(need)
  if (dims.length === 0) return ''
  return dims.map((dim) => `${dim}≥${need[dim]}`).join(', ')
}
