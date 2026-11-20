/**
 * selfcheck/degrade.test.mjs — 降级链与采信判定（execute 全链路，mock ctx 同 M1 冒烟形态）：
 * quota 缺席 → manual 无噪（§6.1）；providers 空/全 missing-key → 渠道回落 manual（§6.2）；
 * 映射命中未核实 → 回落 manual + note 原因（§6.3）；machine 采信行形态；
 * machine 低余额阈值（可配 + CNY 币种守卫）；stale 降级；schema 缺省；registry 交叉核对告警。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import { createRouteQueryTool, renderRouteResult, LOW_BALANCE_THRESHOLD_CNY } from '../lib/tool-query.js'
import { readRegistry, modelCapabilityOf } from '../lib/registry.js'
import { createLivecheck } from '../lib/livecheck.js'
import { Config, SEED_CHANNELS } from '../lib/config-schema.js'
import { readVolatile } from '../lib/volatile.js'
import { normalizeQuotaSnapshot } from '../lib/quota-view.js'
import { platformForProvider } from '../lib/platform-map.js'
import { SNAPSHOT_OK, SNAPSHOT_EMPTY, SNAPSHOT_ALL_MISSING_KEY, SNAPSHOT_MULTI_ACCOUNT } from './fixtures.mjs'

const warnLog = []
const logger = { info() {}, warn(...a) { warnLog.push(a.join(' ')) }, error() {} }

function mockCtx() {
  return {
    logger,
    llm: {
      listProviders: () => SEED_CHANNELS.map((c) => ({ id: c.routeProvider, name: c.routeProvider })),
      listModels: async () => [],
    },
  }
}
const ctx = mockCtx()
const TMP = os.tmpdir() + '/mroute-m2-selfcheck'

/** 工具工厂：深拷贝种子注册表可改造；quotaState=null/undefined → getQuota 恒 null（缺席）；对象 → 固定返回。 */
function makeTool({ mutate, quotaState, configValues = {} } = {}) {
  const chans = JSON.parse(JSON.stringify(SEED_CHANNELS))
  if (mutate) mutate(chans)
  const reg = readRegistry({ channels: chans }, logger)
  return createRouteQueryTool({
    ctx,
    getRegistry: () => reg,
    livecheck: createLivecheck(ctx),
    logger,
    decisionsBaseDir: TMP,
    getQuota: quotaState == null ? async () => null : async () => quotaState,
    readConfigValue: (key) => configValues[key],
  })
}

const exec = { agent: { options: { provider: 'zai-coding-cn', model: 'glm-4.6' } } }
const byId = (result, id) => result.routes.find((r) => r.channel_id === id)
const okView = () => normalizeQuotaSnapshot(SNAPSHOT_OK)

test('§6.1 quota 缺席：全行回落 manual/unknown、meta.quota unavailable、无 quota 噪音、渲染无 quota 表头', async () => {
  const tool = makeTool({ quotaState: null })
  const result = await tool.execute({}, exec)
  assert.equal(result.meta.quota.available, false)
  assert.equal(result.meta.quota.breaker, 'unavailable')
  assert.equal(result.meta.quota.degraded, false)
  assert.equal(result.meta.quota.as_of, '')
  for (const route of result.routes) {
    assert.ok(['manual', 'unknown'].includes(route.balance_source), `缺席回落 ${route.channel_id}`)
    assert.equal(route.balance, undefined)
    assert.ok(!route.note.includes('未采信 quota 数值'), '无回落原因噪音')
    assert.ok(!route.note.includes('balance_source=machine'))
  }
  assert.equal(result.excluded.length, 0, '零拦截（advisory-only）')
  const text = renderRouteResult(result)
  assert.ok(!text.includes('自动余额经 quota 插件读取'), '缺席无表头噪音')
})

test('§6.2 providers 空 / 全 missing-key：对应渠道回落 manual（快照可达）', async () => {
  const emptyState = { view: normalizeQuotaSnapshot(SNAPSHOT_EMPTY), degraded: false, breaker: 'ok' }
  const result = await makeTool({ quotaState: emptyState }).execute({}, exec)
  assert.equal(result.meta.quota.available, true)
  const xiaomi = byId(result, 'xiaomi')
  assert.equal(xiaomi.balance_source, 'manual')
  assert.ok(xiaomi.note.includes('quota 快照无平台 "xiaomi" 行'))

  const missingState = { view: normalizeQuotaSnapshot(SNAPSHOT_ALL_MISSING_KEY), degraded: false, breaker: 'ok' }
  const result2 = await makeTool({ quotaState: missingState }).execute({}, exec)
  const xiaomi2 = byId(result2, 'xiaomi')
  assert.equal(xiaomi2.balance_source, 'manual')
  assert.ok(xiaomi2.note.includes('状态 missing-key'), 'missing-key 行状态标注进 note')
})

test('§6.3 映射命中但 verified=false：不采信回落 manual，note 标注原因（种子已开，测试内显式置 false）', async () => {
  const snap = JSON.parse(JSON.stringify(SNAPSHOT_OK))
  // 给 zhipu 行 ok + 余额数值——即便如此，未核实也绝不采信（红线：拿错账号余额当建议比不显示更糟）
  snap.providers = snap.providers.map((p) =>
    p.id === 'zhipu'
      ? { id: 'zhipu', label: '智谱', status: 'ok', items: [{ label: '总可用余额', display: '¥999.99', remaining: 999.99 }] }
      : p,
  )
  const state = { view: normalizeQuotaSnapshot(snap), degraded: false, breaker: 'ok' }
  const result = await makeTool({
    quotaState: state,
    mutate: (chans) => { chans.find((c) => c.id === 'zai-coding-cn').quota_account_verified = false },
  }).execute({}, exec)
  const zai = byId(result, 'zai-coding-cn')
  assert.equal(zai.balance_source, 'manual')
  assert.equal(zai.balance, undefined)
  assert.ok(zai.note.includes('账户未核实（quota_account_verified=false，不采信数值）'))
  assert.equal(result.excluded.length, 0)
})

test('M4 window：zhipu 窗口行 → machine(5h 1% · 本周 3%)，balance 带 windows/worst，不触发 CNY 阈值', async () => {
  const snap = JSON.parse(JSON.stringify(SNAPSHOT_OK))
  snap.providers = snap.providers.map((p) =>
    p.id === 'zhipu'
      ? {
          id: 'zhipu',
          label: '智谱 Coding Plan · max',
          status: 'ok',
          items: [
            { label: '5 小时窗口', percent: 1, display: '已用 1%' },
            { label: '本周窗口', percent: 3, display: '已用 3%' },
            { label: '账户余额', display: '¥0.94' },
            { label: '累计消费', display: '¥140' },
          ],
        }
      : p,
  )
  const state = { view: normalizeQuotaSnapshot(snap), degraded: false, breaker: 'ok' }
  const result = await makeTool({ quotaState: state }).execute({}, exec)
  const zai = byId(result, 'zai-coding-cn')
  assert.equal(zai.balance_source, 'machine', 'verified=true（用户 2026-11-20 确认）→ 采信窗口读数')
  assert.equal(zai.balance.mode, 'window')
  assert.equal(zai.balance.display, '5h 1% · 本周 3%')
  assert.equal(zai.balance.worst_used_pct, 3)
  assert.equal(zai.balance.remaining, undefined, '窗口模式无金额字段')
  assert.equal(zai.balance.currency, undefined)
  assert.deepEqual(zai.balance.windows.map((w) => w.label), ['5 小时窗口', '本周窗口'])
  assert.equal(zai.warning, undefined, '窗口百分比不参与 CNY 低余额阈值')
  assert.ok(zai.note.includes('mode=window'))
  assert.ok(!zai.note.includes('¥0.94'), '账户余额语义不进包月渠道（红线段言）')
  assert.ok(renderRouteResult(result).includes('balance=machine(5h 1% · 本周 3%)'))
})

test('machine 采信：xiaomi（verified 种子）→ machine 行 balance 形态 + as_of/source 标注 + 渲染', async () => {
  const state = { view: okView(), degraded: false, breaker: 'ok' }
  const result = await makeTool({ quotaState: state }).execute({}, exec)
  const xiaomi = byId(result, 'xiaomi')
  assert.equal(xiaomi.balance_source, 'machine')
  assert.equal(xiaomi.balance.remaining, 57.93)
  assert.equal(xiaomi.balance.currency, 'CNY')
  assert.equal(xiaomi.balance.as_of, SNAPSHOT_OK.refreshedAt)
  assert.equal(xiaomi.balance.source, 'quota-plugin')
  assert.equal(xiaomi.balance.degraded, false)
  assert.ok(xiaomi.note.includes('balance_source=machine'))
  assert.ok(xiaomi.note.includes('仅供参考'))
  assert.equal(result.meta.quota.available, true)
  assert.equal(result.meta.quota.as_of, SNAPSHOT_OK.refreshedAt)
  // deepseek-official verified:true（用户澄清 2026-11-15：DeepSeek 只有一个源）→ machine
  const ds = byId(result, 'deepseek-official')
  assert.equal(ds.balance_source, 'machine')
  assert.equal(ds.balance.remaining, 42.5)
  // 渲染：advisory 表头 + machine 余额串
  const text = renderRouteResult(result)
  assert.ok(text.includes('自动余额经 quota 插件读取'))
  assert.ok(text.includes('仅供参考'))
  assert.ok(text.includes('balance=machine(¥57.93)'))
  // rank 全序不变（advisory：标注不改变排序）
  assert.deepEqual(result.routes.map((r) => r.channel_id),
    ['zai-coding-cn', 'opencode-go', 'deepseek-official', 'deepseek-account', 'xiaomi'])
})

test('stale 降级：degraded 状态 → machine 行 degraded:true + note stale + meta.quota.degraded', async () => {
  const state = { view: okView(), degraded: true, breaker: 'cooling' }
  const result = await makeTool({ quotaState: state }).execute({}, exec)
  const xiaomi = byId(result, 'xiaomi')
  assert.equal(xiaomi.balance_source, 'machine')
  assert.equal(xiaomi.balance.degraded, true)
  assert.ok(xiaomi.note.includes('stale'))
  assert.equal(result.meta.quota.degraded, true)
  assert.equal(result.meta.quota.breaker, 'cooling')
  assert.ok(renderRouteResult(result).includes('最近一次成功快照'))
})

test('machine 低余额：CNY 余额 < 阈值触发 warning（rank 原位零拦截）；阈值可配；USD 不触发 CNY 阈值', async () => {
  const snap = JSON.parse(JSON.stringify(SNAPSHOT_OK))
  snap.providers = snap.providers.map((p) =>
    p.id === 'xiaomi'
      ? { ...p, items: [{ label: '总可用余额', display: '¥5.00', remaining: 5 }] }
      : p,
  )
  const result = await makeTool({ quotaState: { view: normalizeQuotaSnapshot(snap), degraded: false, breaker: 'ok' } }).execute({}, exec)
  const xiaomi = byId(result, 'xiaomi')
  assert.equal(xiaomi.balance.remaining, 5)
  assert.equal(xiaomi.warning?.reason, 'low_balance')
  assert.equal(xiaomi.rank, 5, 'rank 原位（标注不阻断）')
  assert.equal(result.excluded.length, 0)

  // 阈值可配（Config low_balance_threshold_cny=100）：57.93 < 100 → 触发
  const result2 = await makeTool({
    quotaState: { view: okView(), degraded: false, breaker: 'ok' },
    configValues: { low_balance_threshold_cny: 100 },
  }).execute({}, exec)
  assert.equal(byId(result2, 'xiaomi').warning?.reason, 'low_balance')

  // USD 余额 5 < 10：币种守卫 → 不触发（不臆测汇率）
  const usdSnap = JSON.parse(JSON.stringify(SNAPSHOT_OK))
  usdSnap.providers = usdSnap.providers.map((p) =>
    p.id === 'xiaomi'
      ? { ...p, items: [{ label: 'USD 余额', display: '$5.00', remaining: 5 }] }
      : p,
  )
  const result3 = await makeTool({ quotaState: { view: normalizeQuotaSnapshot(usdSnap), degraded: false, breaker: 'ok' } }).execute({}, exec)
  const xiaomi3 = byId(result3, 'xiaomi')
  assert.equal(xiaomi3.balance.currency, 'USD')
  assert.equal(xiaomi3.warning, undefined)
  assert.ok(xiaomi3.note.includes('币种 USD'))
})

test('M1 兼容：quota 缺席时 manual 数值路径不变（LOW_BALANCE_THRESHOLD_CNY=10 兜底 + manual warning）', async () => {
  const result = await makeTool({
    quotaState: null,
    mutate: (chans) => { chans.find((c) => c.id === 'xiaomi').manual.quota_total = '5' },
  }).execute({}, exec)
  const xiaomi = byId(result, 'xiaomi')
  assert.equal(xiaomi.balance_source, 'manual')
  assert.equal(xiaomi.warning?.reason, 'low_balance')
  assert.equal(LOW_BALANCE_THRESHOLD_CNY, 10, 'M1 常量保留为缺省')
})

test('schema 缺省：quota_platform/verified 种子映射 + 空表缺省 + 阈值/TTL volatile 字段', () => {
  const resolved = Config({})
  const channels = typeof resolved.channels?.get === 'function' ? resolved.channels.get() : resolved.channels
  const ch = (id) => channels.find((c) => c.id === id)
  assert.equal(ch('zai-coding-cn').quota_platform, 'zhipu')
  assert.equal(ch('zai-coding-cn').quota_account_verified, true) // 用户 2026-11-20 确认额度卡与渠道账户同源
  assert.equal(ch('opencode-go').quota_platform, 'opencode-go')
  assert.equal(ch('opencode-go').quota_account_verified, true) // 同上（窗口型额度卡）
  assert.equal(ch('deepseek-official').quota_platform, 'deepseek')
  assert.equal(ch('deepseek-account').quota_platform, 'deepseek')
  assert.equal(ch('deepseek-official').quota_account_verified, true) // 用户澄清 2026-11-15：DeepSeek 只有一个源
  assert.equal(ch('deepseek-account').quota_account_verified, true)
  assert.equal(ch('xiaomi').quota_platform, 'xiaomi')
  assert.equal(ch('xiaomi').quota_account_verified, true)
  // 空表扩展渠道缺省：不接 machine（空=不接红线）
  const blank = Config({ channels: [{ id: 'x', routeProvider: 'x' }] })
  const blankCh = (typeof blank.channels?.get === 'function' ? blank.channels.get() : blank.channels)[0]
  assert.equal(blankCh.quota_platform, '')
  assert.equal(blankCh.quota_account_verified, false)
  // 顶层可配字段
  assert.equal(readVolatile(resolved.low_balance_threshold_cny), 10)
  assert.equal(readVolatile(resolved.quota_cache_ttl_seconds), 60)
  const tuned = Config({ low_balance_threshold_cny: 100, quota_cache_ttl_seconds: 120 })
  assert.equal(readVolatile(tuned.low_balance_threshold_cny), 100)
  assert.equal(readVolatile(tuned.quota_cache_ttl_seconds), 120)
})

// ── M3.1 每模型能力档位（model_capability）──

test('M3.1 schema：model_capability 缺省 []、二次读回 byte-identical、旧数据补 []', () => {
  const cap = [
    { model: 'glm-4.6', coding: 'excellent', tools: 'good' },
    { model: 'glm-4.5', long_context: 'fair', vision: 'good' },
  ]
  const base = JSON.parse(JSON.stringify(SEED_CHANNELS[0]))
  const first = Config({ channels: [{ ...base, model_capability: cap }] })
  const chans1 = readVolatile(first.channels)
  assert.deepEqual(chans1[0].model_capability, cap, '首轮解析保留四维与行序')
  // schemastery 对象无 toJSON（volatile 字段序列化为 {}）：用 readVolatile 取 plain 再二次 Config。
  const second = Config({ channels: JSON.parse(JSON.stringify(chans1)) })
  const chans2 = readVolatile(second.channels)
  assert.deepEqual(chans2[0].model_capability, chans1[0].model_capability, '二次读回 byte-identical')
  // 旧数据（无该字段）→ 默认 []
  const legacy = Config({ channels: [{ id: 'x', routeProvider: 'x' }] })
  assert.deepEqual(readVolatile(legacy.channels)[0].model_capability, [])
  const seeds = Config({})
  assert.ok(readVolatile(seeds.channels).every((ch) => Array.isArray(ch.model_capability) && ch.model_capability.length === 0), '种子五渠道缺省 []')
})

test('M3.1 registry 归一化：未知模型告警保留、重复去重、闭集外丢弃、空行丢弃；modelCapabilityOf 命中', () => {
  const reg = readRegistry({
    channels: [{
      id: 'x',
      routeProvider: 'x',
      models: ['m1', 'm2'],
      model_capability: [
        { model: 'm1', coding: 'excellent', tools: 'bogus' },
        { model: 'm1', coding: 'fair' },
        { model: 'm3', vision: 'good' },
        { model: '', coding: 'fair' },
        { model: 'm2' },
      ],
    }],
  }, logger)
  const ch = reg.channels[0]
  assert.deepEqual(ch.model_capability, [
    { model: 'm1', coding: 'excellent' },
    { model: 'm3', vision: 'good' },
  ], '重复首个生效 + 非法维度丢弃 + 空行/空 model 丢弃；未知模型保留')
  assert.ok(reg.warnings.some((w) => w.includes('tools="bogus"') && w.includes('非法')), '闭集外维度告警')
  assert.ok(reg.warnings.some((w) => w.includes('重复模型 "m1"')), '重复模型告警')
  assert.ok(reg.warnings.some((w) => w.includes('未登记模型') && w.includes('m3')), '未知模型引用告警不拒写')
  assert.ok(reg.warnings.some((w) => w.includes('"m2"') && w.includes('无任何有效档位')), '无有效档位空行告警')
  assert.deepEqual(modelCapabilityOf(ch, 'm1'), { coding: 'excellent' })
  assert.equal(modelCapabilityOf(ch, 'm2'), undefined, '空行删除后不可命中')
  assert.equal(modelCapabilityOf(ch, 'nope'), undefined)
  assert.equal(modelCapabilityOf(ch, ''), undefined)
})

test('M3.1 工具输出：model_capability 可选键 + 文本档位行 + 排序全序不回归', async () => {
  const tool = makeTool({
    quotaState: null,
    mutate: (chans) => {
      chans.find((c) => c.id === 'zai-coding-cn').model_capability = [
        { model: 'glm-4.6', coding: 'excellent', long_context: 'good' },
      ]
    },
  })
  const result = await tool.execute({}, exec)
  const zai = byId(result, 'zai-coding-cn')
  assert.deepEqual(zai.model_capability, [{ model: 'glm-4.6', coding: 'excellent', long_context: 'good' }])
  assert.ok(result.routes.filter((r) => r.channel_id !== 'zai-coding-cn').every((r) => r.model_capability === undefined), '无登记渠道不出现该键')
  // 排序逻辑零改动：与 M2 全序完全一致（模型级评级不参与排序）
  assert.deepEqual(result.routes.map((r) => r.channel_id),
    ['zai-coding-cn', 'opencode-go', 'deepseek-official', 'deepseek-account', 'xiaomi'])
  const line = renderRouteResult(result)
  assert.ok(line.includes('模型档位: glm-4.6 coding=excellent long_context=good'), '文本追加档位行')
  assert.ok(line.includes('advisory 标注，不参与排序'))
  const withoutCaps = renderRouteResult({
    ...result,
    routes: result.routes
      .filter((r) => r.channel_id !== 'zai-coding-cn')
      .map((r) => ({ ...r, rank: r.rank })),
  })
  assert.ok(!withoutCaps.includes('模型档位:'), '无数据渠道不渲染档位行')
})

test('registry 交叉核对：显式 quota_platform 与映射推导不一致 → 告警（不拒写）；一致/为空 → 无告警', () => {
  const divergent = readRegistry({
    channels: [{ ...JSON.parse(JSON.stringify(SEED_CHANNELS[4])), quota_platform: 'kimi' }],
  }, logger)
  assert.ok(divergent.warnings.some((w) => w.includes('quota_platform') && w.includes('不一致')))
  const consistent = readRegistry({ channels: JSON.parse(JSON.stringify(SEED_CHANNELS)) }, logger)
  assert.equal(consistent.warnings.length, 0, '种子五渠道映射与推导全部一致')
  const unset = readRegistry({ channels: [{ id: 'x', routeProvider: 'x', quota_platform: '' }] }, logger)
  assert.ok(!unset.warnings.some((w) => w.includes('quota_platform')), '未声明（空=不接）不告警')
})

test('platformForProvider 移植件：种子五渠道推导与显式声明全对齐（含 xiaomi/tp/magpie 优先规则）', () => {
  assert.equal(platformForProvider('zai-coding-cn'), 'zhipu')
  assert.equal(platformForProvider('opencode-go'), 'opencode-go')
  assert.equal(platformForProvider('deepseek-official'), 'deepseek')
  assert.equal(platformForProvider('deepseek-account'), 'deepseek')
  assert.equal(platformForProvider('xiaomi'), 'xiaomi')
  assert.equal(platformForProvider('xiaomi-token-plan'), 'xiaomi-token-plan', 'tp 优先于通用 xiaomi')
  assert.equal(platformForProvider('magpie-anthropic'), 'magpie', 'magpie 前缀优先于 anthropic')
})

// ── 多账号行 `平台id#keyRef` 前缀认领（M2 补修，lead 实测反馈）──

test('多账号行：前缀命中 + keyRef 精选（verified 渠道选中自己 ref 的行，无标注）', async () => {
  const state = { view: normalizeQuotaSnapshot(SNAPSHOT_MULTI_ACCOUNT), degraded: false, breaker: 'ok' }
  const result = await makeTool({
    quotaState: state,
    // 种子 opencode-go verified=false → 改 true 以测 machine 采信路径
    mutate: (chans) => { chans.find((c) => c.id === 'opencode-go').quota_account_verified = true },
  }).execute({}, exec)
  const og = byId(result, 'opencode-go')
  assert.equal(og.balance_source, 'machine')
  assert.equal(og.balance.remaining, 20, '选中 OPENCODEGOSOTA 行（providerKeyRefs 指向）')
  assert.ok(!og.note.includes('多账号行'), 'keyRef 精选成功无标注')
  // xiaomi 裸 id 行回归：精确匹配不受补修影响
  const xiaomi = byId(result, 'xiaomi')
  assert.equal(xiaomi.balance_source, 'machine')
  assert.equal(xiaomi.balance.remaining, 57.93)
})

test('多账号行：providerKeyRefs 无该渠道 ref → 首个前缀命中行 + note 标注「未按 keyRef 精选」', async () => {
  const snap = JSON.parse(JSON.stringify(SNAPSHOT_MULTI_ACCOUNT))
  delete snap.providerKeyRefs['opencode-go'] // 反查落空
  const state = { view: normalizeQuotaSnapshot(snap), degraded: false, breaker: 'ok' }
  const result = await makeTool({
    quotaState: state,
    mutate: (chans) => { chans.find((c) => c.id === 'opencode-go').quota_account_verified = true },
  }).execute({}, exec)
  const og = byId(result, 'opencode-go')
  assert.equal(og.balance_source, 'machine')
  assert.equal(og.balance.remaining, 10, '取首个前缀命中行（OPENCODE_GO 行）')
  assert.ok(og.note.includes('多账号行，未按 keyRef 精选'), '标注依据')
  // advisory：标注不阻断
  assert.equal(result.excluded.length, 0)
})

test('多账号行：匹配先于 verified 门——verified=false 时前缀命中也回落「账户未核实」', async () => {
  const state = { view: normalizeQuotaSnapshot(SNAPSHOT_MULTI_ACCOUNT), degraded: false, breaker: 'ok' }
  const result = await makeTool({
    quotaState: state,
    mutate: (chans) => { chans.find((c) => c.id === 'opencode-go').quota_account_verified = false },
  }).execute({}, exec)
  const og = byId(result, 'opencode-go')
  assert.equal(og.balance_source, 'manual')
  assert.ok(og.note.includes('账户未核实'), 'verified 门拦截（行已匹配到）')
})

test('M4.8 回归：不传 need 时输出与 M4.7 等价（need 专属键缺席、routes 键集合与顺序不变、文本无能力匹配段）', async () => {
  const result = await makeTool({ quotaState: null }).execute({}, exec)
  // need 专属顶层/路由键一律缺席（用 in 判断，不看 undefined）
  assert.equal('model_picks' in result, false)
  assert.equal('capability_need' in result.meta, false)
  assert.equal('unrated_models' in result.meta, false)
  for (const route of result.routes) {
    assert.equal('matching_models' in route, false, `${route.channel_id} 无 matching_models`)
    assert.equal('suggested_model' in route, false, `${route.channel_id} 无 suggested_model`)
  }
  // routes[] 不出现 M4.8 专属键（其余键集合由 lead 用 M4.7 基线 deepEqual 验收）
  for (const route of result.routes) {
    for (const key of ['matching_models', 'suggested_model', 'need', 'fit', 'min_margin', 'rating_table']) {
      assert.equal(key in route, false, `不传 need 时 ${route.channel_id} 不应有 ${key}`)
    }
  }
  // 排序与 M4.7 基线一致
  assert.deepEqual(result.routes.map((r) => r.channel_id),
    ['zai-coding-cn', 'opencode-go', 'deepseek-official', 'deepseek-account', 'xiaomi'])
  // 文本：不要能力匹配段/匹配模型行；模型归并视图允许新增档位后缀（M4.8 允许差异）
  const text = renderRouteResult(result)
  assert.ok(!text.includes('能力需求:'))
  assert.ok(!text.includes('能力匹配推荐'))
  assert.ok(!text.includes('匹配模型:'))
  assert.ok(!text.includes('档位未登记模型'))
  assert.match(text, /模型归并视图（按规范名分组/, '归并视图仍在')
})
