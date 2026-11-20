/**
 * model_route_sync_models —— 注册表 models[] 与 DSH llm 目录的同步工具（M4 交付 B）。
 *
 * 背景（用户 2026-11-20 反馈「模型列表获取不到或者不正确」）：注册表种子里的 models[] 是人工
 * 维护的建议性清单，宿主 `ctx.llm.listProviders()/listModels()` 才是目录正源；两者会漂移
 * （zai-coding-cn 种子 glm-4.6 vs 目录 glm-5.3 等）。本工具把差异显式化，并按需写回。
 *
 * 纪律：
 *  - 默认 dry-run：只读目录与注册表，返回差异，不写任何配置；apply:true 才落盘。
 *  - 写链唯一合法面 = `ctx.fiber.entry` + `configEditor.edit`（dsh-doc configuration.md；
 *    editor 负责校验候选、原子写 profile patch、热更 volatile 字段）。
 *  - 只改 `channels[].models`；顶层 `reviewed_at` 作为「本次同步时间」一并更新（任务书允许复用现有
 *    字段、不新增顶层键）。理由：顶层 reviewed_at 是注册表复核元信息（查询表尾展示），写同步日即
 *    「该注册表的 models[] 已于本日对照宿主目录复核」；渠道级 reviewed_at 保持不动，避免把
 *    reviewAlertsOf 的 tier/priority/capability 超期告警误消（models 同步 ≠ 全量复核）。
 *  - 目录里查不到的 provider → 不写、`reason` 标注原因（不猜测、不删除现有 models）。
 *  - advisory-only：不改排序、不阻断、不改写任何请求；同步结果只是配置维护。
 */
import { errorMessage } from './errors.js'

export const SYNC_TOOL_NAME = 'model_route_sync_models'

/** 同步日（YYYY-MM-DD，UTC）——reviewed_at 口径与注册表种子一致（日期字符串）。 */
function todayIso() {
  return new Date().toISOString().slice(0, 10)
}

function stringsOf(value) {
  return Array.isArray(value) ? value.map(String) : []
}

/**
 * 纯函数：计算每个渠道的目录差异（不读 llm、不写配置，便于单测）。
 *
 * @param {object} input
 * @param {Array<object>} input.channels 生效注册表渠道（readRegistry().channels）
 * @param {(provider:string) => {known:boolean, catalog?:string[], reason?:string}} input.catalogFor
 * @returns {Array<{channel_id:string,provider:string,current:string[],catalog:string[],
 *   missing:string[],stale:string[],provider_known:boolean,changed:boolean,reason:string}>}
 *   missing = 目录有而注册表缺（应补）；stale = 注册表有而目录未列（可能已下线，仅标注不删）。
 *   provider_known=false 时 changed 恒 false，reason 为不可写原因。
 */
export function planModelSync({ channels, catalogFor }) {
  const rows = []
  for (const channel of Array.isArray(channels) ? channels : []) {
    const provider = typeof channel?.routeProvider === 'string' ? channel.routeProvider : ''
    const current = stringsOf(channel?.models)
    if (provider === '') {
      rows.push({
        channel_id: String(channel?.id ?? ''),
        provider: '',
        current,
        catalog: [],
        missing: [],
        stale: [],
        provider_known: false,
        changed: false,
        reason: '渠道未声明 routeProvider（不写）',
      })
      continue
    }
    const info = catalogFor(provider)
    const providerKnown = info?.known === true
    const catalog = providerKnown ? stringsOf(info.catalog) : []
    if (!providerKnown) {
      rows.push({
        channel_id: String(channel?.id ?? ''),
        provider,
        current,
        catalog: [],
        missing: [],
        stale: [],
        provider_known: false,
        changed: false,
        reason: typeof info?.reason === 'string' && info.reason !== ''
          ? `目录不可用，不写：${info.reason}`
          : '目录不可用，不写',
      })
      continue
    }
    if (catalog.length === 0) {
      rows.push({
        channel_id: String(channel?.id ?? ''),
        provider,
        current,
        catalog,
        missing: [],
        stale: [...current],
        provider_known: true,
        changed: false,
        reason: '宿主目录返回空列表（可能未配置凭据/未登录），不写',
      })
      continue
    }
    const missing = catalog.filter((model) => !current.includes(model))
    const stale = current.filter((model) => !catalog.includes(model))
    const changed = missing.length > 0 || stale.length > 0
    rows.push({
      channel_id: String(channel?.id ?? ''),
      provider,
      current,
      catalog,
      missing,
      stale,
      provider_known: true,
      changed,
      reason: changed ? 'models 与宿主目录不一致' : '一致',
    })
  }
  return rows
}

/**
 * 创建宿主工具定义（与 model_route_query 同风格：parameters/output/title/execute）。
 *
 * @param {object} input
 * @param {object} input.ctx cordis Context（取 fiber.entry / configEditor）
 * @param {() => {channels: object[]}} input.getRegistry
 * @param {{check:(provider:string)=>{status:string,detail?:string,availableModels?:string[]}}} input.livecheck
 * @param {object} input.logger
 */
export function createSyncModelsTool({ ctx, getRegistry, livecheck, logger }) {
  const catalogForFromLive = (live) => ({
    known: live?.status === 'ok',
    catalog: Array.isArray(live?.availableModels) ? live.availableModels : [],
    reason: typeof live?.detail === 'string' ? live.detail : undefined,
  })

  return {
    name: SYNC_TOOL_NAME,
    description:
      '把注册表渠道的 models[] 与宿主 DSH llm 目录（listProviders/listModels）对齐，供人工维护模型清单。' +
      '默认 dry-run：只返回每渠道 {current,catalog,missing,stale,provider_known} 与差异，不写配置；' +
      'apply:true 才经宿主 configEditor 写 profile patch（只改 channels[].models，reviewed_at 记为同步日）。' +
      '目录里查不到的 provider 不写并标注原因。advisory-only：不影响排序/过滤/派遣。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        apply: {
          type: 'boolean',
          description: 'true 时把目录列表写入配置；缺省 false = dry-run（只读差异，不落盘）。',
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
          synced_at: { type: 'string' },
          apply_error: { type: 'string' },
          materialized: { type: 'integer' },
          changed_channels: { type: 'array', items: { type: 'string' } },
          skipped: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                channel_id: { type: 'string' },
                reason: { type: 'string' },
              },
              required: ['channel_id', 'reason'],
            },
          },
          channels: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                channel_id: { type: 'string' },
                provider: { type: 'string' },
                current: { type: 'array', items: { type: 'string' } },
                catalog: { type: 'array', items: { type: 'string' } },
                missing: { type: 'array', items: { type: 'string' } },
                stale: { type: 'array', items: { type: 'string' } },
                provider_known: { type: 'boolean' },
                changed: { type: 'boolean' },
                reason: { type: 'string' },
              },
              required: [
                'channel_id',
                'provider',
                'current',
                'catalog',
                'missing',
                'stale',
                'provider_known',
                'changed',
                'reason',
              ],
            },
          },
        },
        required: ['dry_run', 'applied', 'synced_at', 'apply_error', 'materialized', 'changed_channels', 'skipped', 'channels'],
      },
      render: (_args, value) => [{ type: 'text', text: renderSyncResult(value) }],
    },
    isConcurrencySafe: () => false,
    async execute(args) {
      if (args !== undefined && (typeof args !== 'object' || Array.isArray(args))) {
        throw new Error(`${SYNC_TOOL_NAME}: arguments must be an object`)
      }
      const apply = args?.apply === true
      const registry = getRegistry()
      const channels = Array.isArray(registry?.channels) ? registry.channels : []

      // 目录读取：每个 provider 一次（livecheck 自带 60s 缓存 +「读不到 ≠ 校验通过」纪律）。
      const catalogByProvider = new Map()
      for (const channel of channels) {
        const provider = typeof channel?.routeProvider === 'string' ? channel.routeProvider : ''
        if (provider === '' || catalogByProvider.has(provider)) continue
        try {
          catalogByProvider.set(provider, catalogForFromLive(await livecheck.check(provider)))
        } catch (error) {
          catalogByProvider.set(provider, { known: false, catalog: [], reason: errorMessage(error) })
        }
      }

      const plans = planModelSync({
        channels,
        catalogFor: (provider) => catalogByProvider.get(provider) ?? { known: false, catalog: [], reason: '目录未读取' },
      })
      const changedPlans = plans.filter((row) => row.changed && row.provider_known)
      const changedChannels = changedPlans.map((row) => row.channel_id)
      const result = {
        dry_run: !apply,
        applied: false,
        synced_at: '',
        apply_error: '',
        materialized: 0,
        changed_channels: changedChannels,
        skipped: [],
        channels: plans,
      }

      if (!apply || changedPlans.length === 0) return result

      // ── apply：唯一写链（configEditor.edit；entry 失效/无 editor 都返回可读原因，不抛出）──
      const entry = ctx?.fiber?.entry
      const editor = typeof ctx?.get === 'function' ? ctx.get('configEditor') : undefined
      if (entry === undefined || editor === undefined || typeof editor.edit !== 'function') {
        result.apply_error = '当前 profile 无法保存配置（缺少 ctx.fiber.entry 或 configEditor）'
        return result
      }

      const today = todayIso()
      // 写前按当前 raw 配置判断 materialize / skipped：raw 无 channels（本机 link 安装的实际形态，
      // 5 条渠道全部来自 schema default）→ 必须以生效注册表为基座整表写回，否则只写部分渠道会让
      // 其余渠道从配置里消失（volatile 数组整替语义）。
      let materialized = 0
      let written = 0
      let skipped = []
      try {
        await editor.edit(entry, (current) => {
          const next = { ...(current !== null && typeof current === 'object' ? current : {}) }
          const rawChannels = Array.isArray(next.channels) ? next.channels : []
          const useSeedBase = rawChannels.length === 0
          const base = useSeedBase
            ? channels.map((channel) => ({
                ...channel,
                models: Array.isArray(channel.models) ? [...channel.models] : [],
              }))
            : rawChannels.map((channel) => ({ ...channel }))
          const baseIds = new Set(base.map((channel) => channel?.id))
          // raw 有渠道但缺某个待同步渠道 → 不追加（避免把用户删掉的渠道复活），记录 skipped。
          skipped = useSeedBase
            ? []
            : changedPlans
                .filter((plan) => !baseIds.has(plan.channel_id))
                .map((plan) => ({ channel_id: plan.channel_id, reason: '配置中不存在该渠道（未 materialize，不追加）' }))
          const byId = new Map(changedPlans.map((plan) => [plan.channel_id, plan]))
          next.channels = base.map((channel) => {
            const plan = byId.get(channel?.id)
            return plan === undefined ? channel : { ...channel, models: [...plan.catalog] }
          })
          written = changedPlans.filter((plan) => useSeedBase || baseIds.has(plan.channel_id)).length
          materialized = useSeedBase ? base.length : 0
          if (written > 0) next.reviewed_at = today
          return next
        })
      } catch (error) {
        result.apply_error = errorMessage(error)
        logger?.warn?.(`[mroute] model_route_sync_models apply 失败: ${errorMessage(error)}`)
        return result
      }

      result.applied = written > 0
      result.synced_at = written > 0 ? today : ''
      result.materialized = materialized
      result.skipped = skipped
      logger?.info?.(`[mroute] model_route_sync_models 已同步 ${written} 个渠道（materialized=${materialized}）`)
      return result
    },
  }
}

/** 文本渲染（工具卡）：dry-run / applied / 差异逐行。 */
export function renderSyncResult(value) {
  const lines = []
  lines.push(value.dry_run ? 'model_route_sync_models（dry-run，未写配置）' : value.applied ? 'model_route_sync_models（已写入配置）' : 'model_route_sync_models（无可写变更）')
  if (value.apply_error) lines.push(`写入失败: ${value.apply_error}`)
  if (value.synced_at) lines.push(`同步日: ${value.synced_at}  materialized=${value.materialized}`)
  for (const row of value.channels) {
    if (!row.provider_known) {
      lines.push(`- ${row.channel_id}(${row.provider || '无 provider'}): ${row.reason}`)
      continue
    }
    if (!row.changed) {
      lines.push(`- ${row.channel_id}(${row.provider}): 一致`)
      continue
    }
    const parts = []
    if (row.missing.length > 0) parts.push(`缺 [${row.missing.join(', ')}]`)
    if (row.stale.length > 0) parts.push(`多余 [${row.stale.join(', ')}]`)
    lines.push(`- ${row.channel_id}(${row.provider}): ${parts.join('；')}${value.dry_run ? '（apply:true 可写回）' : ''}`)
  }
  for (const row of value.skipped) lines.push(`- 跳过 ${row.channel_id}: ${row.reason}`)
  return lines.join('\n')
}
