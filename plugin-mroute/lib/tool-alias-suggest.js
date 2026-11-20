/**
 * model_route_alias_suggest —— 跨渠道模型归并建议工具（M4.6 / 07 §4）。
 *
 * 背景：同一模型在不同渠道常以不同 id 出现（deepseek-flash / deepseek-v4.1-flash），
 * mroute 的渠道排序按渠道（不按模型）给出建议，消费方需要一张「模型优先」的视图才能判断
 * 某模型在各渠道的可得性与推荐位次。归并映射存于顶层 model_aliases。
 *
 * 纪律（任务书 §3.2 / 07 §4）：
 *  - 默认 dry-run：只读注册表，返回分组与建议，不写配置；apply:true 才落盘。
 *  - **不猜模型同一性**：只有「同 id 跨渠道」是 high-confidence 的自动并（写自反映射）；
 *    其余按规范化启发式只标 low-confidence（reason=prefix-match/low-confidence），
 *    需人工在设置面板把两个 id 改成同一规范名——工具永不自动写非自反映射。
 *  - 写链唯一合法面 = `ctx.fiber.entry` + `ctx.get('configEditor').edit`（同 tool-sync-models）。
 *    只写顶层 `model_aliases` + 顶层 `reviewed_at`（记 apply 日）；渠道级 reviewed_at 不动，
 *    避免把 reviewAlertsOf 的超期告警误消。
 *  - advisory-only：不参与排序、不剔除、不阻断、不改写任何请求；归并只是视图组织方式。
 *  - 归并映射只影响 models_index 分组与 model_capability 解析顺序；channels[].models 形状不变。
 */
import { aliasTableOf } from './registry.js'
import { errorMessage } from './errors.js'

export const ALIAS_TOOL_NAME = 'model_route_alias_suggest'

/** 纯版本 token（v4.1 / 2.0 / 53 …）：用于启发式「同族」判定，不参与精确匹配。 */
const VERSION_TOKEN = /^v?\d+(?:\.\d+)*$/

/** apply 日期（YYYY-MM-DD，UTC）——与注册表种子 reviewed_at 口径一致。 */
function todayIso() {
  return new Date().toISOString().slice(0, 10)
}

/** 规范化模型 id：小写、去 provider 前缀（`org/`）、去 tag（`:free`）。只用于启发式，不改写数据。 */
function normalizeId(modelId) {
  let id = String(modelId).trim().toLowerCase()
  const slash = id.lastIndexOf('/')
  if (slash >= 0) id = id.slice(slash + 1)
  const colon = id.indexOf(':')
  if (colon >= 0) id = id.slice(0, colon)
  return id
}

/** 同族 stem：规范化后去掉纯版本 token（deepseek-v4.1-flash 与 deepseek-flash → deepseek-flash）。 */
function stemOf(modelId) {
  const tokens = normalizeId(modelId).split(/[-_.]/).filter((token) => token !== '')
  return tokens.filter((token) => !VERSION_TOKEN.test(token)).join('-')
}

function unique(values) {
  return [...new Set(values)]
}

function sameId(label, value) {
  return label === value
}

/** 建议理由强度（排序用：同 id 最前，启发式候选在后）。 */
const REASON_RANK = { 'same-id': 0, 'prefix-match': 1, 'low-confidence': 2 }

/**
 * 纯函数：构建归并分组与建议（不读写配置，便于单测）。
 *
 * groups：按「生效规范名」（显式映射优先，未登记自反）聚合后成员数 ≥2 的分组；
 *   成员格式 {channel, model}，按渠道 id/模型 id 升序。已归并组与同 id 跨渠道组天然同形。
 * suggestions：
 *   - reason='same-id'：组内所有成员模型 id 相同、跨 ≥2 渠道 → apply 可写自反映射；
 *   - reason='prefix-match'：仅 provider 前缀/tag 不同（规范化后相同）→ 需人工确认；
 *   - reason='low-confidence'：去掉版本 token 后同族（如 deepseek-flash / deepseek-v4.1-flash）
 *     → 需人工确认。**两者都不会被 apply 写入**。
 *
 * @param {object} input
 * @param {Array<object>} input.channels 生效注册表渠道（readRegistry().channels）
 * @param {object} [input.aliases] 生效归并映射（readRegistry().model_aliases 或原始 Config 值）
 * @returns {{groups:Array<{canonical:string,members:Array<{channel:string,model:string}>}>,
 *            suggestions:Array<{model:string,channels:string[],reason:'same-id'|'prefix-match'|'low-confidence'}>}}
 */
export function planAliasSuggest({ channels, aliases }) {
  const table = aliasTableOf(aliases)
  const entries = []
  const seen = new Set()
  for (const channel of Array.isArray(channels) ? channels : []) {
    const channelId = typeof channel?.id === 'string' ? channel.id : ''
    if (channelId === '') continue
    for (const model of Array.isArray(channel?.models) ? channel.models : []) {
      if (typeof model !== 'string' || model === '') continue
      const key = `${channelId}\u0000${model}`
      if (seen.has(key)) continue
      seen.add(key)
      const row = table[channelId]
      const mapped = row !== undefined && Object.prototype.hasOwnProperty.call(row, model) ? row[model] : undefined
      entries.push({ channel: channelId, model, canonical: typeof mapped === 'string' && mapped !== '' ? mapped : model })
    }
  }

  // 生效规范名分组（成员 ≥2 才输出：跨渠道，或同一渠道内重复登记——后者仅破坏数据才会出现）。
  const byCanonical = new Map()
  for (const entry of entries) {
    const group = byCanonical.get(entry.canonical) ?? { canonical: entry.canonical, members: [] }
    group.members.push({ channel: entry.channel, model: entry.model })
    byCanonical.set(entry.canonical, group)
  }
  const groups = [...byCanonical.values()]
    .filter((group) => group.members.length >= 2)
    .map((group) => ({
      canonical: group.canonical,
      members: group.members
        .slice()
        .sort((a, b) => (a.channel < b.channel ? -1 : a.channel > b.channel ? 1 : a.model < b.model ? -1 : a.model > b.model ? 1 : 0)),
    }))
    .sort((a, b) => b.members.length - a.members.length || (a.canonical < b.canonical ? -1 : a.canonical > b.canonical ? 1 : 0))

  const suggestions = []

  // ① 同 id 跨渠道：唯一 high-confidence、可自动并的类别（只写自反映射）。
  for (const group of groups) {
    if (group.members.every((member) => sameId(member.model, group.canonical))) {
      suggestions.push({
        model: group.canonical,
        channels: unique(group.members.map((member) => member.channel)).sort(),
        reason: 'same-id',
      })
    }
  }

  // ② 启发式候选：只标注不自动并。并查集把同一候选族的成员聚成一条建议。
  const parent = entries.map((_, index) => index)
  const find = (index) => {
    let root = index
    while (parent[root] !== root) root = parent[root]
    let cursor = index
    while (parent[cursor] !== root) {
      const next = parent[cursor]
      parent[cursor] = root
      cursor = next
    }
    return root
  }
  const union = (a, b) => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent[rb] = ra
  }
  let hasPair = false
  for (let i = 0; i < entries.length; i += 1) {
    for (let j = i + 1; j < entries.length; j += 1) {
      const a = entries[i]
      const b = entries[j]
      if (a.channel === b.channel || a.model === b.model) continue
      let reason = null
      if (normalizeId(a.model) === normalizeId(b.model)) reason = 'prefix-match'
      else if (stemOf(a.model) !== '' && stemOf(a.model) === stemOf(b.model)) reason = 'low-confidence'
      if (reason === null) continue
      union(i, j)
      hasPair = true
    }
  }
  if (hasPair) {
    const clusters = new Map()
    for (let index = 0; index < entries.length; index += 1) {
      const root = find(index)
      const members = clusters.get(root) ?? []
      members.push(entries[index])
      clusters.set(root, members)
    }
    for (const members of clusters.values()) {
      const channelIds = unique(members.map((member) => member.channel))
      if (channelIds.length < 2) continue
      // 簇内所有条目同 id 时已由 ① 覆盖（避免重复建议）。
      if (unique(members.map((member) => member.model)).length === 1) continue
      const counts = new Map()
      for (const member of members) {
        const set = counts.get(member.model) ?? new Set()
        set.add(member.channel)
        counts.set(member.model, set)
      }
      const canonical = [...counts.entries()]
        .sort((a, b) => b[1].size - a[1].size || (a[0].includes(':') ? 1 : 0) - (b[0].includes(':') ? 1 : 0) || a[0].length - b[0].length || (a[0] < b[0] ? -1 : 1))[0][0]
      // 簇内最强理由：只要有一对 prefix-match 就标 prefix-match，否则 low-confidence。
      let reason = 'low-confidence'
      for (let i = 0; i < members.length; i += 1) {
        for (let j = i + 1; j < members.length; j += 1) {
          if (members[i].channel === members[j].channel || members[i].model === members[j].model) continue
          if (normalizeId(members[i].model) === normalizeId(members[j].model)) reason = 'prefix-match'
        }
      }
      suggestions.push({ model: canonical, channels: channelIds.sort(), reason })
    }
  }

  const deduped = []
  const suggestionSeen = new Set()
  for (const suggestion of suggestions) {
    const key = `${suggestion.reason}\u0000${suggestion.model}\u0000${suggestion.channels.join(',')}`
    if (suggestionSeen.has(key)) continue
    suggestionSeen.add(key)
    deduped.push(suggestion)
  }
  deduped.sort((a, b) => REASON_RANK[a.reason] - REASON_RANK[b.reason]
    || b.channels.length - a.channels.length
    || (a.model < b.model ? -1 : a.model > b.model ? 1 : 0))

  return { groups, suggestions: deduped }
}

/**
 * 创建宿主工具定义（与 model_route_sync_models 同风格：parameters/output/title/execute）。
 *
 * @param {object} input
 * @param {object} input.ctx cordis Context（取 fiber.entry / configEditor）
 * @param {() => {channels:object[], model_aliases?:object}} input.getRegistry
 * @param {object} input.logger
 */
export function createAliasSuggestTool({ ctx, getRegistry, logger }) {
  return {
    name: ALIAS_TOOL_NAME,
    description:
      '跨渠道模型归并建议：按生效规范名分组，列出同 id 跨渠道（可自动并）与可能的同族候选（需人工确认）。' +
      '默认 dry-run 不写配置；apply:true 只写「同 id 跨渠道」的自反映射到顶层 model_aliases（并记 reviewed_at），' +
      '绝不自动猜测不同 id 是同一模型。advisory-only：不影响排序/过滤/派遣，只影响模型优先视图。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        apply: {
          type: 'boolean',
          description: 'true 时把「同 id 跨渠道」自反映射写入 model_aliases；缺省 false = dry-run（只读建议，不落盘）。',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          dry_run: { type: 'boolean' },
          applied: { type: 'boolean' },
          aliases_written: { type: 'integer' },
          apply_error: { type: 'string' },
          groups: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                canonical: { type: 'string' },
                members: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      channel: { type: 'string' },
                      model: { type: 'string' },
                    },
                    required: ['channel', 'model'],
                  },
                },
              },
              required: ['canonical', 'members'],
            },
          },
          suggestions: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                model: { type: 'string' },
                channels: { type: 'array', items: { type: 'string' } },
                reason: { type: 'string', enum: ['same-id', 'prefix-match', 'low-confidence'] },
              },
              required: ['model', 'channels', 'reason'],
            },
          },
        },
        required: ['dry_run', 'applied', 'aliases_written', 'apply_error', 'groups', 'suggestions'],
      },
      render: (_args, value) => [{ type: 'text', text: renderAliasResult(value) }],
    },
    isConcurrencySafe: () => false,
    async execute(args) {
      if (args !== undefined && (typeof args !== 'object' || Array.isArray(args))) {
        throw new Error(`${ALIAS_TOOL_NAME}: arguments must be an object`)
      }
      const apply = args?.apply === true
      const registry = getRegistry()
      const channels = Array.isArray(registry?.channels) ? registry.channels : []
      const aliases = registry?.model_aliases && typeof registry.model_aliases === 'object' ? registry.model_aliases : {}
      const plan = planAliasSuggest({ channels, aliases })
      const result = {
        dry_run: !apply,
        applied: false,
        aliases_written: 0,
        apply_error: '',
        groups: plan.groups,
        suggestions: plan.suggestions,
      }
      if (!apply) return result

      const sameId = plan.suggestions.filter((suggestion) => suggestion.reason === 'same-id')
      if (sameId.length === 0) return result

      // ── apply：唯一写链（configEditor.edit；entry 失效/无 editor 都返回可读原因，不抛出）──
      const entry = ctx?.fiber?.entry
      const editor = typeof ctx?.get === 'function' ? ctx.get('configEditor') : undefined
      if (entry === undefined || editor === undefined || typeof editor.edit !== 'function') {
        result.apply_error = '当前 profile 无法保存配置（缺少 ctx.fiber.entry 或 configEditor）'
        return result
      }

      const today = todayIso()
      let written = 0
      try {
        await editor.edit(entry, (current) => {
          written = 0 // configEditor 可能重试回调：每次以本次实际新增计数，避免重试放大 aliases_written
          const next = { ...(current !== null && typeof current === 'object' ? current : {}) }
          const raw = next.model_aliases
          const base = aliasTableOf(raw === undefined || raw === null ? aliases : raw)
          for (const suggestion of sameId) {
            for (const channelId of suggestion.channels) {
              const row = base[channelId] ?? {}
              // 已有显式映射（无论指向何处）一律不覆盖：人工判断优先。
              if (Object.prototype.hasOwnProperty.call(row, suggestion.model)) continue
              row[suggestion.model] = suggestion.model
              base[channelId] = row
              written += 1
            }
          }
          if (written > 0) {
            next.model_aliases = base
            next.reviewed_at = today
          }
          return next
        })
      } catch (error) {
        result.apply_error = errorMessage(error)
        logger?.warn?.(`[mroute] model_route_alias_suggest apply 失败: ${errorMessage(error)}`)
        return result
      }

      result.applied = written > 0
      result.aliases_written = written
      if (written > 0) logger?.info?.(`[mroute] model_route_alias_suggest 已写入 ${written} 条同 id 自反映射`)
      return result
    },
  }
}

/** 文本渲染（工具卡）：dry-run / applied / 分组 / 建议逐行。 */
export function renderAliasResult(value) {
  const lines = []
  lines.push(value.dry_run
    ? 'model_route_alias_suggest（dry-run，未写配置）'
    : value.applied
      ? 'model_route_alias_suggest（已写入配置）'
      : 'model_route_alias_suggest（无可写变更）')
  if (value.apply_error) lines.push(`写入失败: ${value.apply_error}`)
  if (value.aliases_written > 0) lines.push(`新增自反映射: ${value.aliases_written} 条（只写「同 id 跨渠道」）`)
  if (value.groups.length > 0) {
    lines.push('归并分组（规范名 → 渠道·渠道模型 id）:')
    for (const group of value.groups) {
      lines.push(`- ${group.canonical}: ${group.members.map((member) => `${member.channel}·${member.model}`).join(', ')}`)
    }
  } else {
    lines.push('归并分组: 无（没有跨渠道重复的模型 id）')
  }
  if (value.suggestions.length === 0) {
    lines.push('归并建议: 无')
  } else {
    lines.push('归并建议（advisory；apply:true 仅写同 id 自反映射，其余需人工改规范名）:')
    for (const suggestion of value.suggestions) {
      const hint = suggestion.reason === 'same-id' ? '同 id 跨渠道，可自动并' : '需人工确认同一性（工具不猜）'
      lines.push(`- [${suggestion.reason}] ${suggestion.model} ← ${suggestion.channels.join(', ')}（${hint}）`)
    }
  }
  return lines.join('\n')
}
