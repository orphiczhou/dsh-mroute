/**
 * selfcheck/sync.test.mjs — M4 交付 B：model_route_sync_models。
 * 覆盖：纯差异函数（missing/stale/provider_known）、dry-run 不写配置、apply 经 configEditor
 * 只改 channels[].models + 顶层 reviewed_at（raw 无 channels 时整表 materialize）、
 * raw 缺渠道不追加（skipped）、无 editor 返回可读原因、无差异不写。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { SEED_CHANNELS } from '../lib/config-schema.js'
import { readRegistry } from '../lib/registry.js'
import { planModelSync, createSyncModelsTool, renderSyncResult } from '../lib/tool-sync-models.js'

const logger = { info() {}, warn() {}, error() {} }

/** 2026-11-20 真机 llm 目录形状（背景事实 3）。 */
const CATALOG = {
  'zai-coding-cn': ['glm-5.3', 'glm-5.3-flash', 'glm-5.3-highspeed'],
  'opencode-go': ['qwen3.8-flash', 'deepseek-v4.1-flash', 'glm-5.3-flash', 'mimo-v2.6-flash'],
  'xiaomi': ['mimo-v2.6-flash', 'mimo-v2.6-pro'],
  'deepseek-official': ['deepseek-flash', 'deepseek-v4-pro'],
  'deepseek-account': ['deepseek-flash', 'deepseek-v4-pro'],
}

const livecheck = {
  async check(provider) {
    if (!(provider in CATALOG)) {
      return { status: 'unknown', detail: `provider "${provider}" 未注册`, availableModels: [] }
    }
    return { status: 'ok', detail: '', availableModels: [...CATALOG[provider]] }
  },
}

function seedRegistry(mutate) {
  const channels = JSON.parse(JSON.stringify(SEED_CHANNELS))
  if (mutate) mutate(channels)
  return readRegistry({ channels }, logger)
}

/** 假 ctx：fiber.entry + configEditor.edit 桩（记录写入的候选，模拟 raw 配置整替）。 */
function fakeCtx(rawConfig) {
  const state = { writes: [] }
  const entry = { options: { config: JSON.parse(JSON.stringify(rawConfig ?? {})) } }
  const ctx = {
    fiber: { entry },
    get(name) {
      if (name !== 'configEditor') return undefined
      return {
        async edit(target, change) {
          const next = change(target.options.config)
          state.writes.push(next)
          target.options.config = next
        },
      }
    },
  }
  return { ctx, state, entry }
}

const byId = (rows, id) => rows.find((row) => row.channel_id === id)

test('planModelSync：missing=catalog 有而注册表无、stale=注册表有而目录无；未知 provider 不写', () => {
  const reg = seedRegistry((chans) => {
    chans.push({ id: 'future-x', routeProvider: 'future-provider', models: ['m1'] })
  })
  const plans = planModelSync({
    channels: reg.channels,
    catalogFor: (provider) => (provider in CATALOG
      ? { known: true, catalog: CATALOG[provider] }
      : { known: false, catalog: [], reason: `provider "${provider}" 未注册` }),
  })
  const zai = byId(plans, 'zai-coding-cn')
  assert.deepEqual(zai.current, ['glm-4.6'])
  assert.deepEqual(zai.catalog, CATALOG['zai-coding-cn'])
  assert.deepEqual(zai.missing, ['glm-5.3', 'glm-5.3-flash', 'glm-5.3-highspeed'])
  assert.deepEqual(zai.stale, ['glm-4.6'])
  assert.equal(zai.provider_known, true)
  assert.equal(zai.changed, true)
  const unknown = byId(plans, 'future-x')
  assert.equal(unknown.provider_known, false)
  assert.equal(unknown.changed, false, '未知 provider 永不写')
  assert.ok(unknown.reason.includes('目录不可用'))
})

test('dry-run（缺省）：返回差异与形状，不调用 configEditor', async () => {
  const reg = seedRegistry()
  const { ctx, state } = fakeCtx({})
  const tool = createSyncModelsTool({ ctx, getRegistry: () => reg, livecheck, logger })
  const result = await tool.execute({})
  assert.equal(result.dry_run, true)
  assert.equal(result.applied, false)
  assert.equal(result.synced_at, '')
  assert.equal(result.apply_error, '')
  assert.deepEqual(Object.keys(result).sort(),
    ['applied', 'apply_error', 'changed_channels', 'channels', 'dry_run', 'materialized', 'skipped', 'synced_at'])
  for (const id of ['zai-coding-cn', 'opencode-go', 'deepseek-official', 'deepseek-account', 'xiaomi']) {
    assert.ok(result.changed_channels.includes(id), `dry-run 也应列出待同步渠道 ${id}`)
  }
  const zai = byId(result.channels, 'zai-coding-cn')
  assert.deepEqual(zai.catalog, CATALOG['zai-coding-cn'])
  assert.deepEqual(zai.missing, CATALOG['zai-coding-cn'])
  assert.deepEqual(zai.stale, ['glm-4.6'])
  assert.equal(state.writes.length, 0, 'dry-run 绝不写配置')
  assert.ok(renderSyncResult(result).includes('dry-run'))
})

test('apply：raw 无 channels（真机形态）→ 以生效注册表 materialize，只改 models + 顶层 reviewed_at', async () => {
  const reg = seedRegistry()
  const before = JSON.parse(JSON.stringify(reg.channels))
  const { ctx, state } = fakeCtx({})
  const tool = createSyncModelsTool({ ctx, getRegistry: () => reg, livecheck, logger })
  const result = await tool.execute({ apply: true })
  assert.equal(result.dry_run, false)
  assert.equal(result.applied, true)
  assert.match(result.synced_at, /^\d{4}-\d{2}-\d{2}$/)
  assert.equal(result.apply_error, '')
  assert.equal(result.materialized, 5)
  assert.deepEqual(result.skipped, [])
  assert.equal(state.writes.length, 1)

  const written = state.writes[0]
  assert.deepEqual(Object.keys(written).sort(), ['channels', 'reviewed_at'], '不新增顶层键')
  assert.equal(written.reviewed_at, result.synced_at)
  assert.equal(written.channels.length, before.length, '整表写回，渠道不丢失')
  for (const row of written.channels) {
    const old = before.find((entry) => entry.id === row.id)
    assert.ok(old, `写回渠道 ${row.id} 存在于生效注册表`)
    assert.deepEqual(row.models, CATALOG[row.routeProvider], `${row.id} models 取目录`)
    // 除 models 外零改动（只改 models 红线的强断言）
    assert.deepEqual({ ...row, models: undefined }, { ...old, models: undefined }, `${row.id} 其余字段原样`)
  }
})

test('apply：raw 已有 channels 但缺某渠道 → 只更新存在的行，缺的记 skipped 不追加', async () => {
  const reg = seedRegistry()
  const raw = {
    channels: [{ id: 'zai-coding-cn', routeProvider: 'zai-coding-cn', channel_type: 'monthly', tier: 'domestic_sota', priority: 90, models: ['glm-4.6'] }],
  }
  const { ctx, state } = fakeCtx(raw)
  const tool = createSyncModelsTool({ ctx, getRegistry: () => reg, livecheck, logger })
  const result = await tool.execute({ apply: true })
  assert.equal(result.applied, true)
  assert.equal(result.materialized, 0, '已有 raw channels 不 materialize')
  assert.deepEqual(state.writes[0].channels.map((row) => row.id), ['zai-coding-cn'], '不追加用户未配置的渠道')
  assert.deepEqual(state.writes[0].channels[0].models, CATALOG['zai-coding-cn'])
  assert.equal(state.writes[0].channels[0].priority, 90, '其它字段原样')
  assert.equal(result.skipped.length, 4, '其余 4 个待同步渠道记 skipped')
  assert.ok(result.skipped.every((row) => row.reason.includes('不追加')))
})

test('apply：无差异 → 不写配置（editor 不被调用）', async () => {
  const reg = seedRegistry((chans) => {
    for (const channel of chans) channel.models = [...(CATALOG[channel.routeProvider] ?? [])]
  })
  const { ctx, state } = fakeCtx({})
  const tool = createSyncModelsTool({ ctx, getRegistry: () => reg, livecheck, logger })
  const result = await tool.execute({ apply: true })
  assert.equal(result.applied, false)
  assert.deepEqual(result.changed_channels, [])
  assert.equal(state.writes.length, 0)
})

test('apply：缺 configEditor / fiber.entry → 返回可读原因，不写不抛', async () => {
  const reg = seedRegistry()
  const tool = createSyncModelsTool({ ctx: {}, getRegistry: () => reg, livecheck, logger })
  const result = await tool.execute({ apply: true })
  assert.equal(result.applied, false)
  assert.ok(result.apply_error.includes('无法保存配置'))
  // 目录不可用（未知 provider）渠道的 reason 透出
  const plans = planModelSync({
    channels: [{ id: 'x', routeProvider: 'ghost', models: [] }],
    catalogFor: () => ({ known: false, reason: '未注册' }),
  })
  assert.equal(plans[0].provider_known, false)
  assert.ok(plans[0].reason.includes('未注册'))
})
