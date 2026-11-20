/**
 * M4.5 动态沉底自检（node:test）：判定边界 / 阈值可配 / tight 优先 hint / 无数据不臆造 /
 * ranking 新全序键（含缺省第三参回归）/ 文本渲染（tight 有、hint 有 · 提示、ok 无）。
 * 纯函数直测，不发请求、不写磁盘。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  dynamicStateOf,
  dynamicThresholdsOf,
  DEFAULT_WINDOW_WEEK_TIGHT_PCT,
  DEFAULT_WINDOW_5H_HINT_PCT,
  DEFAULT_LOW_BALANCE_CNY,
} from '../lib/dynamic-state.js'
import { rankChannels } from '../lib/ranking.js'
import { createRouteQueryTool, renderRouteResult } from '../lib/tool-query.js'

const CHANNEL = (id, overrides = {}) => ({
  id,
  routeProvider: `provider-${id}`,
  models: [],
  channel_type: 'prepaid',
  tier: 'bulk',
  priority: 50,
  ...overrides,
})

/** machineBalanceOf 结果的等价形状（dynamic-state 只消费 use/view）。 */
const machineOf = (view) => (view === null ? null : { use: 'machine', view })

const windowView = (rows) => ({
  status: 'ok',
  mode: 'window',
  balance: null,
  currency: null,
  display: rows.map((row) => `${row.label} ${row.used_pct}%`).join(' · '),
  windows: rows.map((row) => ({ label: row.label, used_pct: row.used_pct, text: `${row.label} 已用 ${row.used_pct}%` })),
  worst_used_pct: Math.max(...rows.map((row) => row.used_pct)),
})

const amountView = (balance, currency) => ({
  status: 'ok',
  mode: 'amount',
  balance,
  currency,
  display: `${currency === 'USD' ? '$' : '¥'}${balance}`,
})

// ── 1. 判定边界 ──────────────────────────────────────────────────────────

test('week window boundary: 98 sinks (tight), 97.9 stays ok', () => {
  const at = dynamicStateOf(CHANNEL('w98'), machineOf(windowView([{ label: '本周', used_pct: 98 }])))
  assert.equal(at.state, 'tight')
  assert.deepEqual(at.metrics, { week_pct: 98 })
  assert.deepEqual(at.reasons, ['本周窗口 98%（≥98% 沉底）'])

  const below = dynamicStateOf(CHANNEL('w97.9'), machineOf(windowView([{ label: '本周', used_pct: 97.9 }])))
  assert.equal(below.state, 'ok')
  assert.deepEqual(below.reasons, [])
  assert.deepEqual(below.metrics, { week_pct: 97.9 })
})

test('5h window boundary: 95 hints (never sinks), 94.9 stays ok', () => {
  const at = dynamicStateOf(CHANNEL('h95'), machineOf(windowView([{ label: '5 小时窗口', used_pct: 95 }])))
  assert.equal(at.state, 'hint')
  assert.deepEqual(at.reasons, ['5h 窗口 95%（≥95%，不沉底）'])
  assert.deepEqual(at.metrics, { h5_pct: 95 })

  const below = dynamicStateOf(CHANNEL('h94.9'), machineOf(windowView([{ label: '5h', used_pct: 94.9 }])))
  assert.equal(below.state, 'ok')
  assert.deepEqual(below.reasons, [])
  assert.deepEqual(below.metrics, { h5_pct: 94.9 })
})

// ── 2. 金额阈值三态（CNY / USD / null）────────────────────────────────────

test('amount balance: CNY below threshold sinks; USD never compared; null treated as CNY', () => {
  const cnyTight = dynamicStateOf(CHANNEL('cny'), machineOf(amountView(9.99, 'CNY')))
  assert.equal(cnyTight.state, 'tight')
  assert.deepEqual(cnyTight.reasons, ['余额 ¥9.99 低于阈值 ¥10'])
  assert.deepEqual(cnyTight.metrics, { balance: 9.99 })

  const cnyOk = dynamicStateOf(CHANNEL('cny10'), machineOf(amountView(10, 'CNY')))
  assert.equal(cnyOk.state, 'ok')
  assert.equal(cnyOk.metrics.balance, 10)

  const usd = dynamicStateOf(CHANNEL('usd'), machineOf(amountView(1, 'USD')))
  assert.equal(usd.state, 'ok')
  assert.deepEqual(usd.reasons, [])

  const unknownCurrency = dynamicStateOf(CHANNEL('null'), machineOf(amountView(5, null)))
  assert.equal(unknownCurrency.state, 'tight')
  assert.deepEqual(unknownCurrency.reasons, ['余额 5 低于阈值 ¥10'])
})

// ── 3. tight 优先于 hint ─────────────────────────────────────────────────

test('tight wins over hint when both fire; reasons list tight causes only', () => {
  const view = windowView([
    { label: '5 小时窗口', used_pct: 96 },
    { label: '本周窗口', used_pct: 98.5 },
    { label: '本月窗口', used_pct: 40 },
  ])
  const result = dynamicStateOf(CHANNEL('both'), machineOf(view))
  assert.equal(result.state, 'tight')
  assert.deepEqual(result.reasons, ['本周窗口 98.5%（≥98% 沉底）'])
  assert.ok(!result.reasons.some((reason) => reason.includes('5h 窗口')), 'hint 原因不混入沉底理由')
  assert.deepEqual(result.metrics, { week_pct: 98.5, h5_pct: 96 })
})

// ── 4. 无 machine 数据 / 无窗口项：ok 且 reasons 空（不臆造）──────────────

test('no machine data, status mode, or missing windows leaves state ok with empty reasons', () => {
  for (const machine of [
    null,
    undefined,
    { use: 'manual', why: '未核实' },
    machineOf({ status: 'ok', mode: 'status', balance: null, currency: null, display: '在线' }),
    machineOf({ status: 'ok', mode: 'window', balance: null, currency: null, display: '', windows: [], worst_used_pct: 0 }),
    machineOf({ status: 'ok', mode: 'window', balance: null, currency: null, display: '无限额度', windows: [{ label: '其余窗口', used_pct: 99 }], worst_used_pct: 99 }),
  ]) {
    const result = dynamicStateOf(CHANNEL('none'), machine)
    assert.deepEqual(result, { state: 'ok', reasons: [], metrics: {} })
  }
})

test('quota row not ok (missing-key / error) is never judged', () => {
  const result = dynamicStateOf(CHANNEL('bad'), machineOf({
    status: 'missing-key',
    mode: 'window',
    balance: null,
    currency: null,
    display: '已用 100%',
    windows: [{ label: '本周', used_pct: 100, text: '已用 100%' }],
    worst_used_pct: 100,
  }))
  assert.deepEqual(result, { state: 'ok', reasons: [], metrics: {} })
})

// ── 5. 阈值可配 + 非法值回落缺省 ─────────────────────────────────────────

test('thresholds are configurable; invalid values fall back to defaults', () => {
  assert.deepEqual(dynamicThresholdsOf({}), {
    window_week_tight_pct: DEFAULT_WINDOW_WEEK_TIGHT_PCT,
    window_5h_hint_pct: DEFAULT_WINDOW_5H_HINT_PCT,
    low_balance_cny: DEFAULT_LOW_BALANCE_CNY,
  })
  assert.deepEqual(dynamicThresholdsOf({ window_week_tight_pct: 0, window_5h_hint_pct: 101, low_balance_cny: -1 }), {
    window_week_tight_pct: DEFAULT_WINDOW_WEEK_TIGHT_PCT,
    window_5h_hint_pct: DEFAULT_WINDOW_5H_HINT_PCT,
    low_balance_cny: DEFAULT_LOW_BALANCE_CNY,
  })
  assert.deepEqual(dynamicThresholdsOf({ window_week_tight_pct: '99', window_5h_hint_pct: 80.5, low_balance_cny: 0 }), {
    window_week_tight_pct: 99,
    window_5h_hint_pct: 80.5,
    low_balance_cny: 0,
  })

  const custom = dynamicStateOf(
    CHANNEL('custom'),
    machineOf(windowView([{ label: '本周', used_pct: 96 }])),
    { window_week_tight_pct: 95 },
  )
  assert.equal(custom.state, 'tight')
  assert.deepEqual(custom.reasons, ['本周窗口 96%（≥95% 沉底）'])
})

// ── 6. rankChannels：dynamicTight 插在 unknown 与 channel_type 之间 ──────

const FIXTURE_CHANNELS = [
  CHANNEL('unknown-one', { channel_type: 'monthly', priority: 100 }),
  CHANNEL('tight-one', { channel_type: 'monthly', priority: 90 }),
  CHANNEL('ok-one', { channel_type: 'prepaid', priority: 1 }),
]

test('rankChannels: dynamic tight sinks below ok even across channel_type; unknown still last', () => {
  const live = new Map([['unknown-one', { status: 'unknown', detail: 'mock-down', availableModels: [] }]])
  const dynamic = new Map([
    ['tight-one', { state: 'tight', reasons: ['本周窗口 98.5%（≥98% 沉底）'] }],
    ['ok-one', { state: 'hint', reasons: ['5h 窗口 96%（≥95%，不沉底）'] }],
  ])
  const { ranked, reasonFor } = rankChannels(FIXTURE_CHANNELS, live, dynamic)
  // ok-one（prepaid）排在 tight-one（monthly）之前 → dynamicTight 键在 channel_type 之前生效；
  // unknown-one 排最后 → unknown 键仍先于 dynamicTight（插入位置正确）。
  assert.deepEqual(ranked.map((entry) => entry.channel.id), ['ok-one', 'tight-one', 'unknown-one'])
  assert.equal(ranked.length, 3, 'tight 不剔除：仍留在排序表里')
  const tightReason = reasonFor(ranked[1])
  assert.ok(tightReason.includes('动态紧张 → 沉底（本周窗口 98.5%（≥98% 沉底））'), tightReason)
  const hintReason = reasonFor(ranked[0])
  assert.ok(!hintReason.includes('动态紧张'), 'hint 不写进排序理由（避免噪音）')
  assert.equal(ranked[2].dynamic, undefined, '无动态数据条目不注入假状态')
})

test('rankChannels regression: two-arg / undefined third arg keeps the legacy static order', () => {
  const legacy = rankChannels(FIXTURE_CHANNELS, new Map())
  const explicitUndefined = rankChannels(FIXTURE_CHANNELS, new Map(), undefined)
  assert.deepEqual(
    legacy.ranked.map((entry) => entry.channel.id),
    ['unknown-one', 'tight-one', 'ok-one'],
    '缺省第三参 = 全部按 ok：unknown → channel_type → priority',
  )
  assert.deepEqual(explicitUndefined.ranked.map((entry) => entry.channel.id), legacy.ranked.map((entry) => entry.channel.id))
  for (const entry of legacy.ranked) {
    assert.ok(!legacy.reasonFor(entry).includes('动态紧张'), '旧调用理由文本不变')
  }
})

// ── 7. renderRouteResult 文本（tight 有 / hint 有 · 提示 / ok 都没有）─────

const routeOf = (id, dynamic, note = '') => ({
  rank: 1,
  channel_id: id,
  provider: `provider-${id}`,
  models: [],
  channel_type: 'prepaid',
  tier: 'bulk',
  priority: 50,
  balance_source: 'manual',
  livecheck: 'ok',
  degraded: false,
  reason: 'channel_type=prepaid（一级键 预充值兜底）；tier=bulk；priority=50；id 兜底',
  note,
  review_alert: false,
  review_alerts: [],
  dynamic,
})

const valueOf = (routes) => ({
  routes,
  excluded: [],
  meta: {
    registry_version: 1,
    reviewed_at: '2026-11-20',
    generated_at: '2026-11-20T00:00:00.000Z',
    inherit_fallback: '无可用渠道时继承父路由',
    quota: { available: false },
    dynamic_thresholds: { window_week_tight_pct: 98, window_5h_hint_pct: 95, low_balance_cny: 10 },
  },
})

test('renderRouteResult renders the tight line before 备注 and never as a block', () => {
  const text = renderRouteResult(valueOf([
    routeOf('tight', { state: 'tight', reasons: ['本周窗口 98.5%（≥98% 沉底）', '余额 ¥6.20 低于阈值 ¥10'], metrics: { week_pct: 98.5, balance: 6.2 } }, '人工登记余额为占位"—"'),
  ]))
  assert.ok(text.includes('   ⚠ 动态沉底: 本周窗口 98.5%（≥98% 沉底）；余额 ¥6.20 低于阈值 ¥10（不阻断）'), text)
  const dynamicAt = text.indexOf('动态沉底')
  const noteAt = text.indexOf('备注:')
  assert.ok(dynamicAt > 0 && noteAt > dynamicAt, '动态行在备注之前')
})

test('renderRouteResult renders hint with the light prefix and ok with neither line', () => {
  const hint = renderRouteResult(valueOf([
    routeOf('hint', { state: 'hint', reasons: ['5h 窗口 96%（≥95%，不沉底）'], metrics: { h5_pct: 96 } }),
  ]))
  assert.ok(hint.includes('   · 提示: 5h 窗口 96%（≥95%，不沉底）'), hint)
  assert.ok(!hint.includes('动态沉底'), 'hint 不出现沉底行')

  const ok = renderRouteResult(valueOf([routeOf('ok', { state: 'ok', reasons: [], metrics: {} })]))
  assert.ok(!ok.includes('动态沉底'), ok)
  assert.ok(!ok.includes('· 提示'), 'ok 无任何动态噪音')
})

// ── 8. output.schema 同步（dynamic 恒在 + meta.dynamic_thresholds）──────

test('output schema declares the dynamic route key and meta.dynamic_thresholds', () => {
  const tool = createRouteQueryTool({
    ctx: {},
    getRegistry: () => ({ channels: [], registry_version: 1 }),
    livecheck: { check: async () => ({ status: 'ok', detail: '', availableModels: [] }) },
    logger: null,
  })
  const item = tool.output.schema.properties.routes.items
  assert.equal(item.properties.dynamic.additionalProperties, false)
  assert.deepEqual(item.properties.dynamic.required, ['state', 'reasons', 'metrics'])
  assert.ok(item.required.includes('dynamic'), 'dynamic 是恒在键')
  const meta = tool.output.schema.properties.meta
  assert.ok(meta.required.includes('dynamic_thresholds'))
  assert.deepEqual(meta.properties.dynamic_thresholds.required, ['window_week_tight_pct', 'window_5h_hint_pct', 'low_balance_cny'])
})

// ── 9. M4.9 buildDynamicSnapshot / snapshotRowsEqual ────────────────────

test('buildDynamicSnapshot keeps every route (ok rows included, M4.10) with flat balance shape', async () => {
  const { buildDynamicSnapshot, snapshotRowsEqual } = await import('../lib/dynamic-state.js')
  // fixture 用 routes[].balance 的**真实扁平形状**（tool-query.js:969-994 组装：mode/display/worst_used_pct/windows 全在顶层）。
  const tightRoute = {
    channel_id: 'zai-coding-cn',
    dynamic: { state: 'tight', reasons: ['本周窗口 98.5%（≥98% 沉底）'], metrics: { week_pct: 98.5 } },
    balance: { mode: 'window', display: '5h 2% · 本周 98.5%', windows: [{ label: '5h', used_pct: 2 }, { label: '本周', used_pct: 98.5 }], worst_used_pct: 98.5, as_of: '2026-11-20T10:00:00.000Z', source: 'quota-plugin', degraded: false },
  }
  const lowRoute = {
    channel_id: 'xiaomi',
    dynamic: { state: 'tight', reasons: ['余额 ¥5 低于阈值 ¥10'], metrics: { balance: 5.2 } },
    balance: { mode: 'amount', remaining: 5.2, currency: 'CNY', display: '¥5.2', as_of: '2026-11-20T10:00:00.000Z', source: 'quota-plugin', degraded: false },
  }
  const hintRoute = {
    channel_id: 'deepseek-official',
    dynamic: { state: 'hint', reasons: ['5h 窗口 96%（≥95%，不沉底）'], metrics: { h5_pct: 96 } },
    balance: { mode: 'window', display: '5h 96%', windows: [{ label: '5h', used_pct: 96 }], worst_used_pct: 96, as_of: '2026-11-20T10:00:00.000Z', source: 'quota-plugin', degraded: false },
  }
  const okRoute = { channel_id: 'opencode-go', dynamic: { state: 'ok', reasons: [], metrics: {} }, balance: { mode: 'status', display: '在线' } }
  const snap = buildDynamicSnapshot([okRoute, tightRoute, hintRoute, lowRoute], '2026-11-20T19:00:00.000Z')
  assert.equal(snap.as_of, '2026-11-20T19:00:00.000Z')
  assert.equal(snap.rows.length, 4, '全部 routes 保留，含 ok 行（M4.10：面板可见性）')
  assert.deepEqual(snap.rows[0], {
    id: 'opencode-go', state: 'ok', reason: '', windows: '', worst_used_pct: -1, low_balance: false, display: '在线',
  })
  assert.deepEqual(snap.rows[1], {
    id: 'zai-coding-cn', state: 'tight', reason: '本周窗口 98.5%（≥98% 沉底）',
    windows: '5h 2% · 本周 98.5%', worst_used_pct: 98.5, low_balance: false, display: '5h 2% · 本周 98.5%',
  })
  assert.equal(snap.rows[2].worst_used_pct, 96, 'window 模式取顶层 worst_used_pct')
  assert.equal(snap.rows[2].windows, '5h 96%', 'windows = 顶层 display 紧凑串')
  assert.equal(snap.rows[3].low_balance, true, '金额型 tight = low_balance')
  assert.equal(snap.rows[3].display, '¥5.2', 'amount 模式取顶层 display')
  assert.equal(snap.rows[3].windows, '', 'amount 模式无窗口串')
  assert.equal(snap.rows[3].worst_used_pct, -1, '非 window 模式 worst = -1')
  // 纯函数：输入 routes 不被改动
  assert.equal(okRoute.dynamic.state, 'ok')
  // 空输入 / 非法输入 / 无 channel_id 的行（不可归位，不入快照）
  assert.deepEqual(buildDynamicSnapshot(null, 't'), { as_of: 't', rows: [] })
  assert.deepEqual(buildDynamicSnapshot([undefined, null, 'x'], ''), { as_of: '', rows: [] })
  assert.deepEqual(buildDynamicSnapshot([{ dynamic: { state: 'tight', reasons: ['r'] } }], 't').rows, [])
  // 深比较
  assert.equal(snapshotRowsEqual(snap.rows, snap.rows), true)
  assert.equal(snapshotRowsEqual(snap.rows, []), false)
  assert.equal(snapshotRowsEqual(undefined, []), true, 'undefined 与 [] 视为等价（缺省形态）')
})

test('M4.10 四态归一：ok/hint/tight/unknown 原样保留，非法值按 ok 且 ok 行 reason 恒为空', async () => {
  const { buildDynamicSnapshot, DYNAMIC_STATES } = await import('../lib/dynamic-state.js')
  assert.deepEqual(DYNAMIC_STATES, ['ok', 'hint', 'tight', 'unknown'])
  const rows = buildDynamicSnapshot([
    { channel_id: 'a', dynamic: { state: 'unknown', reasons: ['数据精度不明'] }, balance: { mode: 'amount', display: '¥52.28' } },
    { channel_id: 'b', dynamic: { state: 'bogus', reasons: ['不该显示'] } },
    { channel_id: 'c', dynamic: { state: 'ok', reasons: ['不应保留'] } },
  ], 't').rows
  assert.deepEqual(rows.map((r) => r.state), ['unknown', 'ok', 'ok'], '合法四值保留，其余按 ok')
  assert.equal(rows[0].reason, '数据精度不明', 'unknown 保留原因')
  assert.equal(rows[0].display, '¥52.28', 'unknown 仍带读数')
  assert.equal(rows[1].reason, '', '非法 state 归一为 ok，原因丢弃')
  assert.equal(rows[2].reason, '', 'ok 行 reason 恒为空')
})

test('M4.9.1 形状回归：扁平 balance 取值；display 缺失时按 windows[] 拼串；嵌套键读法已删除', async () => {
  const { buildDynamicSnapshot } = await import('../lib/dynamic-state.js')
  // 回归锚点：若实现退回 balance.window/amount/status 嵌套读法，以下全部落空（只查函数体，避开注释）。
  const src = await import('node:fs').then((fs) => fs.readFileSync(new URL('../lib/dynamic-state.js', import.meta.url), 'utf8'))
  const body = src.slice(src.indexOf('export function buildDynamicSnapshot')).split(/\r?\n/).filter((l) => !l.trim().startsWith('//')).join('\n')
  assert.doesNotMatch(body, /balance\.window\b/, '不得再读 balance.window 嵌套键')
  assert.doesNotMatch(body, /balance\.amount\b/, '不得再读 balance.amount 嵌套键')
  assert.doesNotMatch(body, /balance\.status\b/, '不得再读 balance.status 嵌套键')

  // window 模式、display 缺失 → 按 windows[] 拼「label used_pct%」紧凑串
  const noDisplay = buildDynamicSnapshot(
    [{ channel_id: 'ch-w', dynamic: { state: 'hint', reasons: [], metrics: {} }, balance: { mode: 'window', windows: [{ label: '5h', used_pct: 96 }, { label: '本周', used_pct: 21 }], worst_used_pct: 96 } }],
    't',
  )
  assert.equal(noDisplay.rows[0].windows, '5h 96% · 本周 21%')
  assert.equal(noDisplay.rows[0].worst_used_pct, 96)
  assert.equal(noDisplay.rows[0].display, '')

  // amount 模式：windows=''、worst=-1、display=顶层 display、low_balance=true
  const amount = buildDynamicSnapshot(
    [{ channel_id: 'ch-a', dynamic: { state: 'tight', reasons: ['r'], metrics: { balance: 5.2 } }, balance: { mode: 'amount', remaining: 5.2, currency: 'CNY', display: '¥5.2' } }],
    't',
  )
  assert.deepEqual({ windows: amount.rows[0].windows, worst: amount.rows[0].worst_used_pct, display: amount.rows[0].display, low: amount.rows[0].low_balance }, { windows: '', worst: -1, display: '¥5.2', low: true })

  // status 模式 / 无 balance：display 取顶层 display（无则空）
  const statusRow = buildDynamicSnapshot([{ channel_id: 'ch-s', dynamic: { state: 'hint', reasons: [], metrics: {} }, balance: { mode: 'status', display: '在线' } }], 't')
  assert.equal(statusRow.rows[0].display, '在线')
  assert.equal(statusRow.rows[0].windows, '')
  const bare = buildDynamicSnapshot([{ channel_id: 'ch-b', dynamic: { state: 'hint', reasons: [], metrics: {} } }], 't')
  assert.deepEqual(bare.rows[0], { id: 'ch-b', state: 'hint', reason: '', windows: '', worst_used_pct: -1, low_balance: false, display: '' })
})

test('M4.9 output schema declares meta.dynamic_snapshot_error and parameters accept 6 need dims', () => {
  const tool = createRouteQueryTool({
    ctx: {},
    getRegistry: () => ({ channels: [], registry_version: 1 }),
    livecheck: { check: async () => ({ status: 'ok', detail: '', availableModels: [] }) },
    logger: null,
  })
  const meta = tool.output.schema.properties.meta
  assert.equal(meta.properties.dynamic_snapshot_error.type, 'string', '可选键已声明（additionalProperties:false')
  assert.equal(meta.required.includes('dynamic_snapshot_error'), false, '可选键不进 required')
  const needProps = tool.parameters.properties.need.properties
  for (const key of ['coding', 'tools', 'long_context', 'vision', 'world_knowledge', 'orchestration']) {
    assert.ok(needProps[key], `need 维度 ${key}`)
    assert.deepEqual(needProps[key].enum, ['excellent', 'good', 'fair'])
  }
  const ratings = tool.output.schema.properties.models_index.items.properties.ratings.properties
  for (const key of ['world_knowledge', 'orchestration']) {
    assert.ok(ratings[key], `models_index ratings 维度 ${key}`)
  }
  const capabilityNeed = meta.properties.capability_need.properties
  assert.ok(capabilityNeed.world_knowledge && capabilityNeed.orchestration, 'meta.capability_need 六维')
})
