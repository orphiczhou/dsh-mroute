/**
 * selfcheck/dispatch-plan.test.mjs — M4.11 交付：派发预检工具 mroute_dispatch_plan。
 * 覆盖任务书 §3.5 六类用例：
 *  ① 与 model_route_query 排序一致（同一 assembleRouteTable 装配）；
 *  ② need 命中（suggested_model + fit/min）与无匹配（'—' + ⚠ 无匹配诊断）；
 *  ③ limit clamp（0/999）与 channel_type 过滤；
 *  ④ 非法 need/limit/channel_type 在任何 IO 之前报错（getRegistry 抛错证明未被调用）；
 *  ⑤ 新鲜度三档（新鲜 / 偏旧+提示 / 无快照）与 quota 降级 stale 标注；
 *  ⑥ models 空渠道提示（'（模型未登记）' + ⚠ 建议 model_route_sync_models）。
 * 附加：文本渲染（头/行/脚）、schema 单一 type 抽查（禁 type 数组回归）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readRegistry } from '../lib/registry.js'
import { createRouteQueryTool } from '../lib/tool-query.js'
import { createDispatchPlanTool, renderDispatchPlan, TOOL_NAME } from '../lib/tool-dispatch-plan.js'
import { normalizeQuotaSnapshot } from '../lib/quota-view.js'
import os from 'node:os'

const logger = { info() {}, warn() {}, error() {} }
const TMP = os.tmpdir() + '/mroute-m411-dispatch-selfcheck'

/** 与 need.test.mjs 同源的真机生效 channels[].models / 档位 / 归并表。 */
const CHANNEL_MODELS = {
  'zai-coding-cn': ['glm-5.3', 'glm-5.3-flash', 'glm-5.3-highspeed'],
  'opencode-go': ['qwen3.8-flash', 'deepseek-v4.1-flash', 'glm-5.3-flash', 'longcat-2.0', 'longcat-2.5-preview-free', 'mimo-v2.6-flash'],
  'deepseek-official': ['deepseek-flash', 'deepseek-v4-pro'],
  'deepseek-account': ['deepseek-flash', 'deepseek-v4-pro'],
  xiaomi: ['mimo-v2.6-flash', 'mimo-v2.6-pro'],
}

const MODEL_RATINGS = {
  'deepseek-flash': { coding: 'excellent', tools: 'excellent', long_context: 'excellent', vision: 'good' },
  'deepseek-v4-pro': { coding: 'good', tools: 'good', long_context: 'excellent', vision: 'none' },
  'glm-5.3-flash': { coding: 'good', tools: 'excellent', long_context: 'good', vision: 'good' },
  'mimo-v2.6-flash': { coding: 'fair', tools: 'good', long_context: 'good', vision: 'good' },
  'glm-5.3': { coding: 'excellent', tools: 'excellent', long_context: 'excellent', vision: 'none' },
  'glm-5.3-highspeed': { coding: 'excellent', tools: 'excellent', long_context: 'excellent', vision: 'none' },
  'mimo-v2.6-pro': { coding: 'good', tools: 'excellent', long_context: 'excellent', vision: 'good' },
  'qwen3.8-flash': { coding: 'good', tools: 'excellent', long_context: 'excellent', vision: 'excellent' },
}

const MODEL_ALIASES = {
  'zai-coding-cn': { 'glm-5.3-flash': 'glm-5.3-flash' },
  'opencode-go': {
    'deepseek-v4.1-flash': 'deepseek-flash',
    'glm-5.3-flash': 'glm-5.3-flash',
    'mimo-v2.6-flash': 'mimo-v2.6-flash',
  },
  xiaomi: { 'mimo-v2.6-flash': 'mimo-v2.6-flash', 'mimo-v2.6-pro': 'mimo-v2.6-pro' },
}

const CHANNEL_META = {
  'zai-coding-cn': { channel_type: 'monthly', tier: 'domestic_sota', priority: 90 },
  'opencode-go': { channel_type: 'monthly', tier: 'domestic_sota', priority: 80 },
  'deepseek-official': { channel_type: 'prepaid', tier: 'domestic_sota', priority: 70 },
  'deepseek-account': { channel_type: 'prepaid', tier: 'domestic_sota', priority: 65 },
  xiaomi: { channel_type: 'prepaid', tier: 'bulk', priority: 50 },
}

/** machine 采信演示行：deepseek-official 声明 quota_platform=deepseek 且已核实。 */
const QUOTA_FIELDS = {
  'deepseek-official': { quota_platform: 'deepseek', quota_account_verified: true },
}

function channelsOf({ withModels = true } = {}) {
  return Object.entries(CHANNEL_MODELS).map(([id, models]) => ({
    id,
    routeProvider: id,
    models: withModels || id !== 'xiaomi' ? [...models] : [],
    ...CHANNEL_META[id],
    ...(QUOTA_FIELDS[id] ?? {}),
  }))
}

function registryOf(options) {
  return readRegistry({ channels: channelsOf(options), model_aliases: MODEL_ALIASES, model_ratings: MODEL_RATINGS }, logger)
}

const EXEC = {}

function quotaStateOf({ ageSeconds = 0, degraded = false } = {}) {
  const refreshedAt = new Date(Date.now() - ageSeconds * 1000).toISOString()
  const snapshot = {
    refreshedAt,
    providers: [
      { id: 'deepseek', status: 'ok', items: [{ label: '余额', remaining: 35.12, display: '¥35.12' }] },
    ],
  }
  return { view: normalizeQuotaSnapshot(snapshot), degraded, breaker: degraded ? 'cooling' : 'closed' }
}

function dispatchTool({ quota = null, registry = registryOf() } = {}) {
  const livecheck = { async check() { return { status: 'ok', detail: '', availableModels: [] } } }
  return createDispatchPlanTool({
    ctx: {},
    getRegistry: () => registry,
    livecheck,
    logger,
    getQuota: async () => quota,
    readConfigValue: () => undefined,
  })
}

test('§1 与 model_route_query 排序一致（共享 assembleRouteTable）', async () => {
  const query = createRouteQueryTool({ ctx: {}, getRegistry: () => registryOf(), livecheck: { async check() { return { status: 'ok', detail: '', availableModels: [] } } }, logger, decisionsBaseDir: TMP, getQuota: async () => null })
  const routes = (await query.execute({}, EXEC)).routes
  const plan = await dispatchTool().execute({}, EXEC)
  assert.deepEqual(plan.channels.map((row) => row.provider), routes.slice(0, 5).map((route) => route.provider))
  assert.deepEqual(plan.channels.map((row) => row.rank), [1, 2, 3, 4, 5])
  assert.equal(plan.pool_count, 5)
})

test('§2 need 命中与无匹配：suggested_model + fit/min / "—" + ⚠ 无匹配诊断', async () => {
  const plan = await dispatchTool().execute({ need: { coding: 'excellent' } }, EXEC)
  const zai = plan.channels.find((row) => row.provider === 'zai-coding-cn')
  assert.equal(zai.model, 'glm-5.3')
  assert.equal(zai.fit, 3)
  assert.equal(zai.min, 0)
  assert.ok(!zai.warnings.some((w) => w.includes('无匹配')), `zai warnings: ${JSON.stringify(zai.warnings)}`)

  const xiaomi = plan.channels.find((row) => row.provider === 'xiaomi')
  assert.equal(xiaomi.model, '—')
  assert.ok(xiaomi.warnings.some((w) => /无匹配（coding:(不足（最高 \w+）|未登记)）/.test(w)), `实际 warnings: ${JSON.stringify(xiaomi.warnings)}`)
  assert.deepEqual(plan.need, { coding: 'excellent' })
  assert.ok(plan.notes.some((n) => n.includes('advisory')))
})

test('§3 limit clamp 与 channel_type 过滤', async () => {
  const two = await dispatchTool().execute({ limit: 2 }, EXEC)
  assert.equal(two.channels.length, 2)
  assert.equal(two.pool_count, 5, 'pool_count 记全量，limit 只裁展示行')

  const low = await dispatchTool().execute({ limit: 0 }, EXEC)
  assert.equal(low.channels.length, 1, 'clamp 到下界 1')
  const high = await dispatchTool().execute({ limit: 999 }, EXEC)
  assert.equal(high.channels.length, 5, 'clamp 到上界 10（池只有 5）')

  const monthly = await dispatchTool().execute({ channel_type: 'monthly' }, EXEC)
  assert.deepEqual(monthly.channels.map((row) => row.provider), ['zai-coding-cn', 'opencode-go'])
  assert.equal(monthly.pool_count, 2)
  assert.equal(monthly.channels[0].rank, 1, '过滤后 rank 重编')

  const none = await dispatchTool().execute({ channel_type: 'voucher' }, EXEC)
  assert.equal(none.channels.length, 0)
  assert.equal(none.pool_count, 0)
})

test('§4 非法入参先于任何 IO：need/limit/channel_type', async () => {
  const ioTrap = dispatchTool({ registry: new Proxy({}, { get() { throw new Error('registry IO must not happen') } }) })
  await assert.rejects(ioTrap.execute({ need: { coding: 'best' } }, EXEC), /mroute_dispatch_plan: need 参数非法：键 "coding" 的值 "best" 非法/)
  await assert.rejects(ioTrap.execute({ need: { foo: 'good' } }, EXEC), /未知能力维度 "foo"/)
  await assert.rejects(ioTrap.execute({ limit: 'many' }, EXEC), /limit 参数非法/)
  await assert.rejects(ioTrap.execute({ channel_type: 'free' }, EXEC), /channel_type 参数非法：.*monthly\|voucher\|prepaid/)
})

test('§5 新鲜度三档 + quota 降级 stale 标注', async () => {
  // ① 新鲜（≤300s）：machine 余额行带 ¥ 读数，notes 无偏旧提示
  const fresh = await dispatchTool({ quota: quotaStateOf({ ageSeconds: 60 }) }).execute({}, EXEC)
  assert.ok(fresh.snapshot_at.endsWith('Z'))
  assert.ok(fresh.freshness_seconds <= 300)
  assert.equal(fresh.machine_count, 1, '只有 deepseek-official 采信 machine')
  const ds = fresh.channels.find((row) => row.provider === 'deepseek-official')
  assert.equal(ds.display, '¥35.12')
  assert.equal(ds.state, 'machine')
  assert.ok(!fresh.notes.some((n) => n.includes('偏旧')))

  // ② 偏旧（>300s）：文本提示 + notes 建议重查
  const stale = await dispatchTool({ quota: quotaStateOf({ ageSeconds: 400 }) }).execute({}, EXEC)
  assert.ok(stale.freshness_seconds > 300)
  assert.ok(stale.notes.some((n) => n.includes('偏旧')))

  // ③ 无快照：snapshot_at 空、freshness_seconds 键缺席、notes 说明
  const none = await dispatchTool({ quota: null }).execute({}, EXEC)
  assert.equal(none.snapshot_at, '')
  assert.equal('freshness_seconds' in none, false)
  assert.equal(none.machine_count, 0)
  assert.ok(none.notes.some((n) => n.includes('无 quota 快照')))

  // ④ 降级期：行级 stale ⚠ + notes 说明
  const degraded = await dispatchTool({ quota: quotaStateOf({ ageSeconds: 60, degraded: true }) }).execute({}, EXEC)
  const dsDegraded = degraded.channels.find((row) => row.provider === 'deepseek-official')
  assert.ok(dsDegraded.warnings.some((w) => w.includes('stale')), `实际 warnings: ${JSON.stringify(dsDegraded.warnings)}`)
  assert.ok(degraded.notes.some((n) => n.includes('降级期')))
})

test('§6 models 空渠道：提示补 model 或先跑 model_route_sync_models', async () => {
  const registry = readRegistry({ channels: channelsOf({ withModels: false }), model_aliases: MODEL_ALIASES, model_ratings: MODEL_RATINGS }, logger)
  const plan = await dispatchTool({ registry }).execute({}, EXEC)
  const xiaomi = plan.channels.find((row) => row.provider === 'xiaomi')
  assert.equal(xiaomi.model, '（模型未登记）')
  assert.ok(xiaomi.warnings.some((w) => w.includes('model_route_sync_models')), `实际 warnings: ${JSON.stringify(xiaomi.warnings)}`)
})

test('§7 文本渲染：3 头（数据行必在）+ limit 行 + 2 脚；图标按 state/display 重算', async () => {
  const plan = await dispatchTool({ quota: quotaStateOf({ ageSeconds: 60 }) }).execute({ need: { coding: 'excellent' }, limit: 3 }, EXEC)
  const text = renderDispatchPlan(plan)
  const lines = text.split('\n')
  assert.match(lines[0], /^派发预检 · dispatch preflight（.*Z）$/)
  assert.match(lines[1], /^数据：quota 快照 .* · 新鲜（≤5 分钟） · 1\/5 渠道机读可用$/)
  assert.match(lines[2], /^需求：coding≥excellent$/)
  assert.equal(lines.length, 8, '3 头 + 3 行 + 2 脚')
  assert.match(lines[3], /^1\. zai-coding-cn \/ glm-5\.3  \[monthly · domestic_sota · priority 90\]  fit=3 min=0/)
  assert.match(lines[4], /^2\. opencode-go \/ deepseek-v4\.1-flash  \[monthly · domestic_sota · priority 80\]  fit=3 min=0/)
  assert.match(lines[5], /^3\. deepseek-official \/ deepseek-flash  \[prepaid · domestic_sota · priority 70\]  💰 ¥35\.12  fit=3 min=0/)
  assert.match(lines[lines.length - 2], /用法：按顺序把 provider\/model 填进/)
  assert.match(lines[lines.length - 1], /标记：🌕=运行态正常/)
  // render 经 output.render 与 execute 返回值一致性
  const tool = dispatchTool({ quota: quotaStateOf({ ageSeconds: 60 }) })
  const rendered = tool.output.render({}, plan)
  assert.equal(rendered[0].type, 'text')
  assert.ok(rendered[0].text.includes('派发预检'))
})

test('§8 工具元信息：名称 / schema 单一 type（禁 type 数组回归）', () => {
  const tool = dispatchTool()
  assert.equal(tool.name, TOOL_NAME)
  const json = JSON.stringify(tool.output.schema)
  assert.equal(/"type":\s*\[/.test(json), false, '禁 type 数组（宿主 schema 校验红线，M4.8 实录）')
  assert.equal(tool.output.schema.properties.channels.items.properties.fit.type, 'integer')
  assert.equal(tool.output.schema.properties.channels.items.properties.reason.type, 'string')
  assert.equal(tool.output.schema.required.includes('freshness_seconds'), false, 'freshness_seconds 可省略（无快照时不发键）')
})
