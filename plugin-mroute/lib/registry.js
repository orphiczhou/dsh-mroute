/**
 * 读侧：volatile 双面读取 + 读时语义校验。
 *
 * 校验分层（07 方案 §3.2-5，借鉴 B12 director 形状）：schemastery 只管逐字段形状；
 * 跨字段语义（悬空 fallbacks、重复 id）在读取时告警并降级，**不拒写**——避免把设置面板锁死。
 */
import { readVolatile } from './volatile.js'
import { MANUAL_STATUSES, CAPABILITY_KEYS, CAPABILITY_RATINGS } from './config-schema.js'
import { platformForProvider } from './platform-map.js'

/** 统一模型名能力表的四维（M4.7，与 CAPABILITY_KEYS 同集，单独命名以免被误用为渠道级）。 */
export const MODEL_RATING_KEYS = CAPABILITY_KEYS
/** 模型级评级闭集 = 渠道级三档 + 'none'（用户裁决：视觉能力要有「无」选项）。 */
export const MODEL_RATINGS = [...CAPABILITY_RATINGS, 'none']

export { readVolatile }

/**
 * manual.status 读侧三值解析（FR-B1-4 前半）：缺字段 = active 不报错（旧版注册表兼容，
 * NFR-4 读侧兼容纪律）；非法值同样按 active 降级并告警（不拒写，避免把设置面板锁死）。
 * @returns {'active'|'disabled'|'exhausted'}
 */
export function manualStatusOf(channel) {
  const raw = channel?.manual?.status
  if (MANUAL_STATUSES.includes(raw)) return raw
  return 'active'
}

/**
 * capability 评级解析（FR-A3-3 v1.2 评级口径，供过滤标注与展示）：
 * 键缺省/非法值/字面 'null' 串一律视为「无数据」返回 null——评级字符串闭集外的输入不参与命中判定。
 * @returns {'excellent'|'good'|'fair'|null}
 */
export function capabilityRatingOf(channel, key) {
  if (!CAPABILITY_KEYS.includes(key)) return null
  const raw = channel?.capability?.[key]
  return CAPABILITY_RATINGS.includes(raw) ? raw : null
}

/**
 * 每模型能力档位读取（M3.1 / 任务书 §3.2，advisory 标注专用，**不参与排序**）：
 * 返回渠道 channel 下引用 model 的四维评级对象（只含闭集内键），无该行/无有效键 → undefined。
 * 读侧归一化（registry.js 读时完成）：非对象行丢弃、空 model 丢弃、重复模型首个生效、
 * 闭集外评级丢弃该维度、未知模型引用保留但告警。
 * @returns {{coding?:string, tools?:string, long_context?:string, vision?:string}|undefined}
 */
export function modelCapabilityOf(channel, model) {
  if (!channel || typeof model !== 'string' || model === '') return undefined
  const rows = Array.isArray(channel.model_capability) ? channel.model_capability : []
  const row = rows.find((item) => item !== null && typeof item === 'object' && item.model === model)
  if (!row) return undefined
  const entry = {}
  for (const key of CAPABILITY_KEYS) {
    if (CAPABILITY_RATINGS.includes(row[key])) entry[key] = row[key]
  }
  return Object.keys(entry).length > 0 ? entry : undefined
}

/**
 * 归并映射读侧归一化（M4.6 / 07 §3）：返回只含「非空字符串渠道 id → 非空字符串模型 id →
 * 去空白后的非空规范名」的新两层对象。非对象表/行、数组、空键、空规范名一律丢弃——读侧
 * 宽容是既有纪律（schema 管写入面，旧配置/手改 YAML 不锁死面板）。
 * @returns {Record<string, Record<string, string>>}
 */
export function aliasTableOf(aliases) {
  const out = {}
  if (aliases === null || typeof aliases !== 'object' || Array.isArray(aliases)) return out
  for (const [channelId, models] of Object.entries(aliases)) {
    if (typeof channelId !== 'string' || channelId === '') continue
    if (models === null || typeof models !== 'object' || Array.isArray(models)) continue
    const row = {}
    for (const [modelId, canonical] of Object.entries(models)) {
      if (typeof modelId !== 'string' || modelId === '') continue
      if (typeof canonical !== 'string') continue
      const name = canonical.trim()
      if (name === '') continue
      row[modelId] = name
    }
    if (Object.keys(row).length > 0) out[channelId] = row
  }
  return out
}

/**
 * 渠道模型 id → 规范名（M4.6，纯函数；未登记/非法入参一律自反，**绝不抛**）。
 * 防御口径：别名表非对象、渠道行非对象、原型链键（__proto__/toString 等）都按未登记处理；
 * 规范名空白串同样视为未登记——避免把空名写进分组键。
 */
export function canonicalOf(aliases, channelId, modelId) {
  if (typeof channelId !== 'string' || channelId === '') return modelId
  if (typeof modelId !== 'string' || modelId === '') return modelId
  if (aliases === null || typeof aliases !== 'object' || Array.isArray(aliases)) return modelId
  if (!Object.prototype.hasOwnProperty.call(aliases, channelId)) return modelId
  const row = aliases[channelId]
  if (row === null || typeof row !== 'object' || Array.isArray(row)) return modelId
  if (!Object.prototype.hasOwnProperty.call(row, modelId)) return modelId
  const canonical = row[modelId]
  if (typeof canonical !== 'string') return modelId
  const name = canonical.trim()
  return name === '' ? modelId : name
}

/**
 * 统一模型名能力表归一化（M4.7）：{ [规范名]: { coding?: 评级|'none', … } } → 只保留
 * 非空规范名 + 闭集评级（含 'none' = 明确无此能力）。非对象表/行、数组、非法值一律丢弃（读侧宽容）。
 * @returns {Record<string, Record<string, string>>}
 */
export function ratingTableOf(ratings) {
  const out = {}
  if (ratings === null || typeof ratings !== 'object' || Array.isArray(ratings)) return out
  for (const [name, row] of Object.entries(ratings)) {
    if (typeof name !== 'string') continue
    const key = name.trim()
    if (key === '') continue
    if (row === null || typeof row !== 'object' || Array.isArray(row)) continue
    const entry = {}
    for (const dim of MODEL_RATING_KEYS) {
      const value = row[dim]
      if (typeof value === 'string' && MODEL_RATINGS.includes(value)) entry[dim] = value
    }
    if (Object.keys(entry).length > 0) out[key] = entry
  }
  return out
}

/**
 * 按统一模型名取能力档位（M4.7，纯函数；未登记/非法入参返回 null，绝不抛）。
 * @returns {{coding?:string, tools?:string, long_context?:string, vision?:string}|null}
 */
export function ratingsOfCanonical(table, canonical) {
  if (table === null || typeof table !== 'object') return null
  if (typeof canonical !== 'string' || canonical === '') return null
  if (!Object.prototype.hasOwnProperty.call(table, canonical)) return null
  const row = table[canonical]
  if (row === null || typeof row !== 'object') return null
  return Object.keys(row).length > 0 ? row : null
}

/**
 * 每模型能力档位解析（M4.7；advisory 标注，不参与排序）。
 * 解析顺序（用户 2026-11-20 裁决：以统一模型名为准）：顶层 model_ratings[规范名] →
 * 顶层 model_ratings[渠道模型 id] → 渠道级 model_capability 精确行/规范名行（兼容旧数据）→
 * 渠道级 capability 回退 → null。'none' 视为有效值（明确无此能力），调用方不得当成缺省。
 * @returns {{coding?:string, tools?:string, long_context?:string, vision?:string}|null}
 */
export function ratingsForModel(channel, canonical, modelId, ratingTable) {
  const table = ratingTable && typeof ratingTable === 'object' ? ratingTable : null
  if (table) {
    const byCanonical = ratingsOfCanonical(table, canonical)
    if (byCanonical) return byCanonical
    const byModel = ratingsOfCanonical(table, modelId)
    if (byModel) return byModel
  }
  const candidates = []
  if (typeof modelId === 'string' && modelId !== '') candidates.push(modelId)
  if (typeof canonical === 'string' && canonical !== '' && canonical !== modelId) candidates.push(canonical)
  for (const key of candidates) {
    const found = modelCapabilityOf(channel, key)
    if (found) return found
  }
  const fallback = {}
  for (const key of CAPABILITY_KEYS) {
    if (CAPABILITY_RATINGS.includes(channel?.capability?.[key])) fallback[key] = channel.capability[key]
  }
  return Object.keys(fallback).length > 0 ? fallback : null
}

/**
 * 读侧归一化 model_capability（M3.1）：返回可直接消费的新数组（元素仅含闭集键）。
 * 语义校验全部"告警不拒写"（与上方 readRegistry 同纪律）：
 *  - 非对象行 / model 非字符串或空串 → 丢弃；
 *  - 同一渠道内重复模型 → 首个生效；
 *  - 评级闭集外 → 丢弃该维度并告警；
 *  - 四维全无有效值 → 丢弃该行（无信息空行）；
 *  - 引用不在 channel.models[] 的模型 → 保留 + 告警（advisory，不阻断保存）。
 */
function normalizeModelCapability(channel, warnings) {
  const raw = Array.isArray(channel?.model_capability) ? channel.model_capability : []
  const models = Array.isArray(channel?.models) ? channel.models.filter((m) => typeof m === 'string' && m !== '') : []
  const out = []
  const seen = new Set()
  const unknown = new Set()
  for (const row of raw) {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) continue
    const model = typeof row.model === 'string' ? row.model.trim() : ''
    if (model === '') continue
    if (seen.has(model)) {
      warnings.push(`channel "${channel.id}" 的 model_capability 重复模型 "${model}"（读时去重，仅首个生效）`)
      continue
    }
    seen.add(model)
    if (!models.includes(model)) unknown.add(model)
    const entry = { model }
    for (const key of CAPABILITY_KEYS) {
      const rating = row[key]
      if (rating === undefined) continue
      if (CAPABILITY_RATINGS.includes(rating)) entry[key] = rating
      else warnings.push(`channel "${channel.id}" 模型 "${model}" 的 ${key}="${String(rating)}" 非法（值域 excellent|good|fair），读时丢弃该维度`)
    }
    if (Object.keys(entry).length === 1) {
      warnings.push(`channel "${channel.id}" 的 model_capability 中模型 "${model}" 无任何有效档位（读时丢弃该行）`)
      continue
    }
    out.push(entry)
  }
  if (unknown.size > 0) {
    warnings.push(
      `channel "${channel.id}" 的 model_capability 引用了未登记模型 ${[...unknown].map((m) => `"${m}"`).join(', ')}（读时保留；advisory 标注，不参与排序/过滤）`,
    )
  }
  return out
}

/**
 * 读取并校验注册表。config 是 Loader 传入的行配置（volatile 字段为 Volatile 访问器，
 * 见 lib/config-schema.js 头注 C4/C5）。
 * @returns {{ registry_version:number, reviewed_at:string, reviewed_against:string,
 *             channels:Array<object>, warnings:string[], model_aliases:object,
 *             enforce_gate:boolean, eval:object }}
 */
export function readRegistry(config, logger) {
  const registry_version = readVolatile(config?.registry_version) ?? 1
  const reviewed_at = readVolatile(config?.reviewed_at) ?? ''
  const reviewed_against = readVolatile(config?.reviewed_against) ?? ''
  const rawChannels = readVolatile(config?.channels)
  // m-9 防御纵深：元素级 null/非对象过滤（激活期 schema 兜底在前，此处二次防御；数组元素不收）
  const channels = Array.isArray(rawChannels)
    ? rawChannels.filter((ch) => ch !== null && typeof ch === 'object' && !Array.isArray(ch))
    : []

  const warnings = []
  const danglingSeen = new Set()
  const seenIds = new Set()
  // m-2 真去重：重复 id 读时去重、仅首个生效（与告警文案一致；排序层只见去重后的清单）
  const deduped = []
  for (const ch of channels) {
    if (typeof ch.id === 'string' && seenIds.has(ch.id)) {
      warnings.push(`channel id "${ch.id}" 重复定义（读时去重，仅首个生效）`)
      continue
    }
    if (typeof ch.id === 'string') seenIds.add(ch.id)
    deduped.push(ch)
  }

  const ids = new Set(deduped.map((ch) => ch.id).filter(Boolean))
  // M3.1：读时归一化每模型能力档位（告警不拒写；排序层不消费该字段）
  const normalized = []
  for (const ch of deduped) {
    normalized.push({ ...ch, model_capability: normalizeModelCapability(ch, warnings) })
    // manual.status 非法值：读时告警并按 active 降级（缺字段静默=active，不告警——FR-B1-4 旧表兼容）
    const rawStatus = ch?.manual?.status
    if (rawStatus !== undefined && !MANUAL_STATUSES.includes(rawStatus)) {
      warnings.push(`channel "${ch.id}" 的 manual.status="${String(rawStatus)}" 非法（值域 active|disabled|exhausted），读时按 active 降级`)
    }
    // 悬空 fallbacks 引用：读时告警，排序层对悬空引用忽略（不拒写）
    for (const fb of Array.isArray(ch.fallbacks) ? ch.fallbacks : []) {
      if (!ids.has(fb)) {
        const key = `${ch.id}->${fb}`
        if (!danglingSeen.has(key)) {
          danglingSeen.add(key)
          warnings.push(`channel "${ch.id}" 的 fallbacks 引用了不存在的 id "${fb}"（读时告警，不拒写）`)
        }
      }
    }
    // M2 quota 映射交叉核对（platform-map.js 移植件的读侧用途）：显式声明与 includes 推导
    // 不一致时告警提示人工复核——不自动改写、不拒写（quota_platform 仍是采信的唯一依据）。
    // 推导为空串（无对应平台）且显式声明非空 → 同样提示（可能是 quota 插件不认识的平台 id）。
    const declaredPlatform = typeof ch.quota_platform === 'string' ? ch.quota_platform : ''
    if (declaredPlatform !== '') {
      const derived = platformForProvider(ch.routeProvider)
      if (derived !== declaredPlatform) {
        warnings.push(
          `channel "${ch.id}" 的 quota_platform="${declaredPlatform}" 与映射推导 "${derived || '（无）'}" 不一致（映射命中 ≠ 账户体系一致，请人工核对显式声明；不拒写）`,
        )
      }
    }
  }
  if (warnings.length > 0) {
    for (const line of warnings) logger?.warn?.(`[mroute] ${line}`)
  }
  // enforce_gate 读侧缺省 false（NFR-0a schema+读侧双断言；M1 不消费，M6 opt-in 边界才接线 tools.guard）
  const enforceGate = readVolatile(config?.enforce_gate)
  // eval 预留位透传（M1 只保证占位存在；M5 填充清单见 07 §3.2-4）
  const evalSection = readVolatile(config?.eval)
  // model_aliases（M4.6）：volatile 热更双面读；归一化后供 query/models_index 与 alias_suggest 消费。
  const modelAliases = aliasTableOf(readVolatile(config?.model_aliases))
  // model_ratings（M4.8 读侧补齐，M4.7 遗留）：volatile 热更双面读；归一化后供
  // models_index.ratings 与 need 能力匹配消费（闭集过滤 + 空行丢弃 + 原型链防御全在 ratingTableOf）。
  const modelRatings = ratingTableOf(readVolatile(config?.model_ratings))
  return {
    registry_version,
    reviewed_at,
    reviewed_against,
    channels: normalized,
    warnings,
    model_aliases: modelAliases,
    // 只含登记键、值为闭集字符串（'none' 是有效值；未登记 = 键缺席，两者读后仍可区分）。
    model_ratings: modelRatings,
    enforce_gate: enforceGate === true, // 非 true 一律 false：缺省路径零拦截（NFR-0）
    eval: evalSection !== null && typeof evalSection === 'object' && !Array.isArray(evalSection) ? evalSection : {},
  }
}
