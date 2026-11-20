/**
 * selfcheck/alias.test.mjs — M4.6 交付：跨渠道模型归并。
 * 覆盖：Config.model_aliases 的 schemastery 形状（两层 dict roundtrip / 缺省 {} / 非字符串解析期拒）、
 * aliasTableOf/canonicalOf 防御口径、ratingsForModel 三级解析、planAliasSuggest 的 same-id 与
 * low-confidence/prefix-match 候选（不猜同一性）、dry-run 不写、apply 只写同 id 自反映射 + reviewed_at
 * 且幂等、无 editor 的可读原因、buildModelsIndex 分组/排序/余额状态、models_index 不改 routes。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { Config } from '../lib/config-schema.js'
import { readRegistry, aliasTableOf, canonicalOf, ratingsForModel, ratingTableOf, ratingsOfCanonical } from '../lib/registry.js'
import { readVolatile } from '../lib/volatile.js'
import { planAliasSuggest, createAliasSuggestTool, renderAliasResult } from '../lib/tool-alias-suggest.js'
import { buildModelsIndex, balanceStateOf, createRouteQueryTool } from '../lib/tool-query.js'
import os from 'node:os'

const logger = { info() {}, warn() {}, error() {} }

/** 2026-11-20 真机生效配置 channels[].models（cordis.patch.yml:354-460 摘录）。 */
const CHANNEL_MODELS = {
  'zai-coding-cn': ['glm-5.3', 'glm-5.3-flash', 'glm-5.3-highspeed'],
  'opencode-go': ['qwen3.8-flash', 'deepseek-v4.1-flash', 'glm-5.3-flash', 'longcat-2.0', 'longcat-2.5-preview-free', 'mimo-v2.6-flash'],
  'deepseek-official': ['deepseek-flash', 'deepseek-v4-pro'],
  'deepseek-account': ['deepseek-flash', 'deepseek-v4-pro'],
  'xiaomi': ['mimo-v2.6-flash', 'mimo-v2.6-pro'],
}

function channelsOf() {
  return Object.entries(CHANNEL_MODELS).map(([id, models]) => ({ id, routeProvider: id, models: [...models] }))
}

function registryOf({ aliases, mutate } = {}) {
  const channels = channelsOf()
  if (mutate) mutate(channels)
  const config = { channels }
  if (aliases !== undefined) config.model_aliases = aliases
  return readRegistry(config, logger)
}

const TMP = os.tmpdir() + '/mroute-m46-alias-selfcheck'

test('§1 Config.model_aliases：两层 dict roundtrip、缺省 {}、空渠道行、非字符串解析期拒', () => {
  assert.deepEqual(readVolatile(Config({}).model_aliases), {}, '缺省 {}')

  const raw = {
    'zai-coding-cn': { 'glm-5.3-flash': 'glm-5.3-flash' },
    'opencode-go': { 'deepseek-v4.1-flash': 'deepseek-flash', 'org/model:tag': 'my model' },
    'empty-channel': {},
  }
  const first = Config({ model_aliases: raw })
  assert.deepEqual(readVolatile(first.model_aliases), raw, '两层键与带斜线/冒号/空格的 id 原样保留')

  const second = Config({ model_aliases: JSON.parse(JSON.stringify(readVolatile(first.model_aliases))) })
  assert.deepEqual(readVolatile(second.model_aliases), raw, '二次读回 byte-identical')

  assert.throws(() => Config({ model_aliases: { zai: { 'glm-5.3-flash': 123 } } }), /expected string/, '非字符串值解析期即拒')
})

test('§2 aliasTableOf/canonicalOf：行级归一化与「未登记自反、绝不抛」防御口径', () => {
  const table = aliasTableOf({
    zai: { 'glm-5.3-flash': '  glm-5.3-flash ', '': 'x', bad: 123, 'keep': 'x' },
    empty: {},
    notObject: 'x',
    arr: [],
  })
  assert.deepEqual(table, { zai: { 'glm-5.3-flash': 'glm-5.3-flash', keep: 'x' } })
  assert.deepEqual(aliasTableOf(null), {})
  assert.deepEqual(aliasTableOf([['a', {}]]), {})

  const aliases = { zai: { 'glm-5.3-flash': 'glm-5.3-flash' }, blank: { m: '   ' } }
  assert.equal(canonicalOf(aliases, 'zai', 'glm-5.3-flash'), 'glm-5.3-flash')
  assert.equal(canonicalOf(aliases, 'zai', 'glm-5.3'), 'glm-5.3', '未登记自反')
  assert.equal(canonicalOf(aliases, 'blank', 'm'), 'm', '空白规范名按未登记处理')
  assert.equal(canonicalOf(aliases, 'other', 'm'), 'm')
  assert.equal(canonicalOf(null, 'zai', 'm'), 'm')
  assert.equal(canonicalOf(aliases, 'zai', ''), '')
  assert.equal(canonicalOf({}, 'toString', 'x'), 'x')
  assert.equal(canonicalOf({ zai: {} }, 'zai', 'toString'), 'toString', '原型链键不算登记')
  assert.equal(canonicalOf({ zai: { x: 'proto' } }, 'zai', 'hasOwnProperty'), 'hasOwnProperty')
})

test('§3 ratingsForModel：渠道模型 id 精确 → 规范名 → 渠道级 capability → null', () => {
  const channel = {
    model_capability: [
      { model: 'deepseek-flash', coding: 'good' },
      { model: 'deepseek-v4.1-flash', tools: 'excellent' },
    ],
    capability: { vision: 'fair', coding: 'fair' },
  }
  assert.deepEqual(ratingsForModel(channel, 'deepseek-flash', 'deepseek-v4.1-flash'), { tools: 'excellent' }, '渠道 id 精确优先')
  assert.deepEqual(ratingsForModel(channel, 'deepseek-flash', 'deepseek-v4.1-flash:free'), { coding: 'good' }, '回退规范名行')
  assert.deepEqual(ratingsForModel({ capability: { vision: 'fair' } }, 'x', 'y'), { vision: 'fair' }, '渠道级兜底')
  assert.equal(ratingsForModel({ model_capability: [], capability: { vision: 'nope' } }, 'x', 'y'), null)
  assert.equal(ratingsForModel(null, 'x', 'y'), null)
})

test('§3b model_ratings（M4.7 统一模型名）：规范名优先于渠道级旧数据，且支持 none', () => {
  const table = ratingTableOf({
    'glm-5.3-flash': { coding: 'excellent', vision: 'none' },
    'mimo-v2.6-flash': { tools: 'good' },
    '': { coding: 'fair' },
    bogus: { coding: 'nope', tools: 7 },
  })
  assert.deepEqual(table, {
    'glm-5.3-flash': { coding: 'excellent', vision: 'none' },
    'mimo-v2.6-flash': { tools: 'good' },
  }, '空名丢弃、闭集外维度丢弃、变成空对象的行整行丢弃')
  const channel = { model_capability: [{ model: 'glm-5.3-flash', coding: 'fair' }], capability: { coding: 'fair' } }
  assert.deepEqual(
    ratingsForModel(channel, 'glm-5.3-flash', 'some-id', table),
    { coding: 'excellent', vision: 'none' },
    '统一模型名表优先于渠道级旧数据，none 原样透出',
  )
  assert.deepEqual(ratingsForModel(channel, 'glm-5.3-flash', 'some-id'), { coding: 'fair' }, '无表时回落旧路径')
  assert.equal(ratingsOfCanonical(table, 'absent'), null, '未登记返回 null')
  assert.equal(ratingsOfCanonical(table, 'toString'), null, '原型链键不算登记')
})

test('§4 planAliasSuggest（真机五渠道）：同 id 成组 + deepseek 低置信簇需人工确认', () => {
  const plan = planAliasSuggest({ channels: registryOf().channels, aliases: {} })
  const group = (canonical) => plan.groups.find((item) => item.canonical === canonical)

  assert.deepEqual(group('glm-5.3-flash').members, [
    { channel: 'opencode-go', model: 'glm-5.3-flash' },
    { channel: 'zai-coding-cn', model: 'glm-5.3-flash' },
  ])
  assert.deepEqual(group('mimo-v2.6-flash').members, [
    { channel: 'opencode-go', model: 'mimo-v2.6-flash' },
    { channel: 'xiaomi', model: 'mimo-v2.6-flash' },
  ])
  assert.deepEqual(group('deepseek-flash').members, [
    { channel: 'deepseek-account', model: 'deepseek-flash' },
    { channel: 'deepseek-official', model: 'deepseek-flash' },
  ])
  assert.deepEqual(group('deepseek-v4-pro').members, [
    { channel: 'deepseek-account', model: 'deepseek-v4-pro' },
    { channel: 'deepseek-official', model: 'deepseek-v4-pro' },
  ])
  assert.equal(plan.groups.every((item) => item.members.length >= 2), true)

  const sameIds = plan.suggestions.filter((item) => item.reason === 'same-id').map((item) => item.model).sort()
  assert.deepEqual(sameIds, ['deepseek-flash', 'deepseek-v4-pro', 'glm-5.3-flash', 'mimo-v2.6-flash'])

  const low = plan.suggestions.filter((item) => item.reason === 'low-confidence')
  assert.equal(low.length, 1, '只有 deepseek 同族一簇进入低置信候选')
  assert.equal(low[0].model, 'deepseek-flash')
  assert.deepEqual(low[0].channels, ['deepseek-account', 'deepseek-official', 'opencode-go'])
  assert.equal(plan.suggestions.some((item) => item.reason === 'prefix-match'), false)

  const text = renderAliasResult({
    dry_run: true, applied: false, aliases_written: 0, apply_error: '',
    groups: plan.groups, suggestions: plan.suggestions,
  })
  assert.ok(text.includes('dry-run，未写配置'))
  assert.ok(text.includes('[low-confidence] deepseek-flash'))
  assert.ok(text.includes('同 id 跨渠道，可自动并'))
})

test('§5 planAliasSuggest（合成）：仅 provider 前缀/tag 不同 → prefix-match，不写建议', () => {
  const plan = planAliasSuggest({
    channels: [
      { id: 'a', models: ['glm-5.3-flash'] },
      { id: 'b', models: ['org/glm-5.3-flash:free'] },
    ],
    aliases: {},
  })
  assert.equal(plan.groups.length, 0, '未归并时各自自反，不成组')
  assert.equal(plan.suggestions.length, 1)
  assert.deepEqual(plan.suggestions[0], {
    model: 'glm-5.3-flash',
    channels: ['a', 'b'],
    reason: 'prefix-match',
  })
})

/** 假 ctx：fiber.entry + configEditor.edit 桩（与 sync.test.mjs 同形状）。 */
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
  return { ctx, state }
}

test('§6 alias_suggest dry-run 不写；apply 只写同 id 自反映射 + reviewed_at，幂等', async () => {
  const { ctx, state } = fakeCtx({})
  let registry = registryOf()
  const tool = createAliasSuggestTool({ ctx, getRegistry: () => registry, logger })

  const dry = await tool.execute({})
  assert.equal(dry.dry_run, true)
  assert.equal(dry.applied, false)
  assert.equal(dry.aliases_written, 0)
  assert.equal(state.writes.length, 0, 'dry-run 零写入')

  const applied = await tool.execute({ apply: true })
  assert.equal(applied.dry_run, false)
  assert.equal(applied.applied, true)
  assert.equal(applied.aliases_written, 8, '4 组同 id × 2 渠道')
  assert.deepEqual(Object.keys(state.writes[0]).sort(), ['model_aliases', 'reviewed_at'], '只改两顶层键')
  assert.match(state.writes[0].reviewed_at, /^\d{4}-\d{2}-\d{2}$/)
  assert.deepEqual(state.writes[0].model_aliases['zai-coding-cn'], { 'glm-5.3-flash': 'glm-5.3-flash' })
  assert.equal(state.writes[0].model_aliases['opencode-go']['deepseek-v4.1-flash'], undefined, '绝不自动并低置信候选')

  registry = registryOf({ aliases: state.writes[0].model_aliases })
  const again = await createAliasSuggestTool({ ctx, getRegistry: () => registry, logger }).execute({ apply: true })
  assert.equal(again.applied, false)
  assert.equal(again.aliases_written, 0, '重复 apply 幂等')
})

test('§7 alias_suggest apply：无 editor 返回可读原因，不抛出', async () => {
  const tool = createAliasSuggestTool({ ctx: {}, getRegistry: () => registryOf(), logger })
  const result = await tool.execute({ apply: true })
  assert.equal(result.applied, false)
  assert.equal(result.aliases_written, 0)
  assert.ok(result.apply_error.includes('无法保存配置'))
})

test('§8 buildModelsIndex：按规范名分组、channels 按 rank 升序、ratings 取首个有数据渠道', () => {
  const registry = registryOf({
    aliases: { 'opencode-go': { 'deepseek-v4.1-flash': 'deepseek-flash' } },
    mutate(channels) {
      channels.find((c) => c.id === 'zai-coding-cn').model_capability = [{ model: 'glm-5.3-flash', coding: 'excellent' }]
      channels.find((c) => c.id === 'opencode-go').model_capability = [{ model: 'deepseek-v4.1-flash', tools: 'good' }]
    },
  })
  const routes = [
    { rank: 1, channel_id: 'zai-coding-cn', models: ['glm-5.3-flash'], channel_type: 'monthly', tier: 'domestic_sota', priority: 90, balance_source: 'machine', dynamic: { state: 'tight' } },
    { rank: 2, channel_id: 'opencode-go', models: ['glm-5.3-flash', 'deepseek-v4.1-flash'], channel_type: 'monthly', tier: 'domestic_sota', priority: 80, balance_source: 'manual' },
    { rank: 3, channel_id: 'deepseek-official', models: ['deepseek-flash'], channel_type: 'prepaid', tier: 'overseas_sota', priority: 70 },
  ]
  const index = buildModelsIndex(registry, routes)
  const glm = index.find((group) => group.canonical === 'glm-5.3-flash')
  assert.deepEqual(glm.ratings, { coding: 'excellent' })
  assert.deepEqual(glm.channels.map((row) => [row.channel_id, row.rank, row.balance_state]), [
    ['zai-coding-cn', 1, 'machine_tight'],
    ['opencode-go', 2, 'manual'],
  ])

  const deepseek = index.find((group) => group.canonical === 'deepseek-flash')
  assert.deepEqual(deepseek.channels.map((row) => row.channel_id), ['opencode-go', 'deepseek-official'], '别名归入同组且按 rank 排')
  assert.deepEqual(deepseek.channels.map((row) => row.channel_model), ['deepseek-v4.1-flash', 'deepseek-flash'])
  assert.deepEqual(deepseek.channels.map((row) => row.balance_state), ['manual', 'unknown'])
  assert.deepEqual(deepseek.ratings, { tools: 'good' })

  assert.deepEqual(index.map((group) => group.canonical), ['glm-5.3-flash', 'deepseek-flash'], '组按最优 rank 升序（routes 只含这三个模型）')
  assert.equal(glm.channels.length, 2)
})

test('§9 balanceStateOf：machine/machine_tight/machine_hint/manual/unknown 枚举', () => {
  assert.equal(balanceStateOf({ balance_source: 'machine' }), 'machine')
  assert.equal(balanceStateOf({ balance_source: 'machine', dynamic: { state: 'tight' } }), 'machine_tight')
  assert.equal(balanceStateOf({ balance_source: 'machine', dynamic: { state: 'hint' } }), 'machine_hint')
  assert.equal(balanceStateOf({ balance_source: 'manual' }), 'manual')
  assert.equal(balanceStateOf({}), 'unknown')
  assert.equal(balanceStateOf(null), 'unknown')
})

function routeTool(registry) {
  const livecheck = { async check() { return { status: 'ok', detail: '', availableModels: [] } } }
  return createRouteQueryTool({
    ctx: {},
    getRegistry: () => registry,
    livecheck,
    logger,
    decisionsBaseDir: TMP,
    getQuota: async () => null,
  })
}

test('§10 models_index 只增视图：有/无归并映射时 routes[] 逐行一致', async () => {
  const exec = { agent: { options: { provider: 'zai-coding-cn', model: 'glm-5.3' } } }
  const plain = await routeTool(registryOf({ aliases: {} })).execute({}, exec)
  const merged = await routeTool(registryOf({ aliases: { 'opencode-go': { 'deepseek-v4.1-flash': 'deepseek-flash' } } })).execute({}, exec)

  assert.deepEqual(merged.routes, plain.routes, 'advisory-only：排序/字段零变化')
  assert.notDeepEqual(merged.models_index, plain.models_index, '模型优先视图确实变化')

  const deepseek = merged.models_index.find((group) => group.canonical === 'deepseek-flash')
  // 真实排序：deepseek 两个钱包渠道 rank 在 opencode-go 之前（models_index 组内按 rank 升序）。
  assert.deepEqual(deepseek.channels.map((row) => row.channel_id), ['deepseek-account', 'deepseek-official', 'opencode-go'])
  const opencodeGlm = merged.models_index.find((group) => group.canonical === 'glm-5.3-flash')
  assert.deepEqual(opencodeGlm.channels.map((row) => row.channel_id), ['opencode-go', 'zai-coding-cn'], '两个渠道都在，组内按 rank 升序')
  assert.ok(opencodeGlm.channels[0].rank <= opencodeGlm.channels[1].rank)
  assert.equal(merged.models_index[0].channels[0].rank, 1)
})
