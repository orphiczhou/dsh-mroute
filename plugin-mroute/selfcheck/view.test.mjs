/**
 * selfcheck/view.test.mjs — quota-view 归一化：label 语义映射表命中 / remaining 优先 /
 * display 兜底守卫 / 畸形行隔离 / 上游原始行不透出。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  BALANCE_LABELS,
  isBalanceLabel,
  parseDisplayNumber,
  parseWindowUsedPct,
  shortWindowLabel,
  windowItemsOf,
  compactWindowDisplay,
  currencyOf,
  platformViewOf,
  normalizeQuotaSnapshot,
  pickPlatformView,
} from '../lib/quota-view.js'
import { SNAPSHOT_OK, SNAPSHOT_MALFORMED, SNAPSHOT_MULTI_ACCOUNT } from './fixtures.mjs'

test('label 语义映射表：闭集 + 「总余额」后缀命中；usage 型不命中', () => {
  assert.equal(isBalanceLabel('总可用余额'), true)
  assert.equal(isBalanceLabel('余额'), true)
  assert.equal(isBalanceLabel('账户余额'), true)
  assert.equal(isBalanceLabel('钱包余额'), true)
  assert.equal(isBalanceLabel('预付余额'), true)
  assert.equal(isBalanceLabel('USD 余额'), true)
  assert.equal(isBalanceLabel('额度 (USD)'), true)
  assert.equal(isBalanceLabel('CNY 总余额'), true) // deepseek-balance `${currency} 总余额`（direct.ts:278）
  assert.equal(isBalanceLabel('USD 总余额'), true)
  // usage 型不命中（不伪造余额）
  assert.equal(isBalanceLabel('5h 窗口'), false)
  assert.equal(isBalanceLabel('周额度'), false)
  assert.equal(isBalanceLabel('今日消耗'), false)
  assert.equal(isBalanceLabel('Token Plan 积分'), false)
  assert.equal(isBalanceLabel('近 7 天消耗'), false)
  assert.equal(BALANCE_LABELS.length >= 8, true)
})

test('display 兜底解析：币符/数字开头才解析；已用量串守卫为 null（不把已用当余额）', () => {
  assert.equal(parseDisplayNumber('¥57.93'), 57.93)
  assert.equal(parseDisplayNumber('  $1,234.5 '), 1234.5)
  assert.equal(parseDisplayNumber('57.93'), 57.93)
  // 已用量守卫：openai-billing unlimited 行 display '已用 $0.5 · 无限额度'（direct.ts:1106）
  assert.equal(parseDisplayNumber('已用 $0.5 · 无限额度'), null)
  assert.equal(parseDisplayNumber('已用 1,234 / 5,678 credits'), null)
  assert.equal(parseDisplayNumber(''), null)
  assert.equal(parseDisplayNumber('在线'), null)
  assert.equal(parseDisplayNumber(undefined), null)
})

test('currencyOf：display 币符优先，label 前缀兜底', () => {
  assert.equal(currencyOf('¥57.93', ''), 'CNY')
  assert.equal(currencyOf('$12.00', ''), 'USD')
  assert.equal(currencyOf('42.50', 'CNY 总余额'), 'CNY')
  assert.equal(currencyOf('42.50', 'USD 总余额'), 'USD')
  assert.equal(currencyOf('42.50', '余额'), null)
})

test('platformViewOf：remaining 优先 + as_of/source/balance_source 标注齐全', () => {
  const row = SNAPSHOT_OK.providers[0] // xiaomi
  const view = platformViewOf(row, '2026-11-15T03:00:00.000Z')
  assert.equal(view.balance_source, 'machine')
  assert.equal(view.source, 'quota-plugin')
  assert.equal(view.as_of, '2026-11-15T03:00:00.000Z')
  assert.equal(view.status, 'ok')
  assert.equal(view.balance, 57.93)
  assert.equal(view.currency, 'CNY')
  assert.equal(view.display, '¥57.93')
})

test('platformViewOf：display 兜底解析（无 remaining 的账户余额行，magpie 形态）→ display 标明来源 label', () => {
  const row = SNAPSHOT_OK.providers.find((p) => p.id === 'magpie')
  const view = platformViewOf(row, 't')
  assert.equal(view.mode, 'amount')
  assert.equal(view.balance, 284.73)
  assert.equal(view.currency, 'CNY')
  assert.equal(view.display, '账户余额 ¥284.73', '¥ 项必须带来源 label（交付 A 红线）')
})

test('无窗口项的 zhipu 行（只剩账户余额 ¥0.94）→ 才允许 amount，且 display 标明 label', () => {
  const view = platformViewOf({
    id: 'zhipu',
    status: 'ok',
    items: [{ label: '账户余额', display: '¥0.94' }, { label: '累计消费', display: '¥140' }],
  }, 't')
  assert.equal(view.mode, 'amount')
  assert.equal(view.balance, 0.94)
  assert.equal(view.display, '账户余额 ¥0.94')
})

test('platformViewOf：usage 型行 → balance null（不伪造 0）', () => {
  const row = SNAPSHOT_OK.providers.find((p) => p.id === 'opencode-go')
  const view = platformViewOf(row, 't')
  assert.equal(view.balance, null)
  assert.equal(view.status, 'ok')
})

test('platformViewOf：error/missing-key 行 → 状态与 message 透出（截断 120）、balance null', () => {
  const errRow = SNAPSHOT_OK.providers.find((p) => p.id === 'broken-platform')
  const view = platformViewOf(errRow, 't')
  assert.equal(view.status, 'error')
  assert.equal(view.balance, null)
  assert.ok(view.message.includes('boom'))
  const long = { id: 'x', status: 'error', message: '啊'.repeat(300), items: [] }
  assert.equal(platformViewOf(long, 't').message.length, 120)
})

test('normalizeQuotaSnapshot：畸形行跳过不炸（渠道间错误隔离，红线 §5.5）', () => {
  const view = normalizeQuotaSnapshot(SNAPSHOT_MALFORMED)
  assert.ok(view)
  assert.equal(view.by_platform.size, 1) // 只有合法的 xiaomi 行存活
  const xiaomi = view.by_platform.get('xiaomi')
  assert.equal(xiaomi.balance, 9.9)
  // 上游原始行不透出：Map 值是归一化视图形状
  assert.deepEqual(Object.keys(xiaomi).sort(), ['as_of', 'balance', 'balance_source', 'currency', 'display', 'message', 'mode', 'source', 'status'])
})

test('normalizeQuotaSnapshot：形状守卫 + current_model/provider_key_refs 透出', () => {
  assert.equal(normalizeQuotaSnapshot(null), null)
  assert.equal(normalizeQuotaSnapshot([]), null)
  assert.equal(normalizeQuotaSnapshot('x'), null)
  const view = normalizeQuotaSnapshot(SNAPSHOT_OK)
  assert.equal(view.source, 'quota-plugin')
  assert.equal(view.balance_source, 'machine')
  assert.equal(view.as_of, SNAPSHOT_OK.refreshedAt)
  assert.equal(view.current_model.provider, 'zai-coding-cn')
  assert.equal(view.provider_key_refs['xiaomi'], 'XIAOMI_API_KEY')
  assert.ok(view.by_platform instanceof Map)
})

// ── pickPlatformView（M2 补修：多账号行 `平台id#keyRef` 前缀认领 + keyRef 精选）──

const multiView = () => normalizeQuotaSnapshot(SNAPSHOT_MULTI_ACCOUNT)

test('pickPlatformView: 裸 id 精确命中（单账号平台不受补修影响）', () => {
  const pick = pickPlatformView(multiView(), 'xiaomi', 'xiaomi')
  assert.equal(pick.view.balance, 57.93)
  assert.equal(pick.prefixMatched, false)
  assert.equal(pick.pickedByRef, false)
  assert.equal(pick.multiUnpicked, false)
})

test('pickPlatformView: 前缀命中 + provider_key_refs 精选（多行取渠道自己的 keyRef 行）', () => {
  const pick = pickPlatformView(multiView(), 'opencode-go', 'opencode-go')
  assert.ok(pick.prefixMatched, '前缀命中')
  assert.equal(pick.pickedByRef, true, '按 keyRef 精选')
  assert.equal(pick.multiUnpicked, false)
  assert.equal(pick.view.balance, 20, '选中 OPENCODEGOSOTA 行（providerKeyRefs 指向）')
})

test('pickPlatformView: 前缀命中但 ref 未登记 → 首行 + multiUnpicked（note 标注依据）', () => {
  const view = multiView()
  view.provider_key_refs = {} // 渠道 ref 反查落空
  const pick = pickPlatformView(view, 'opencode-go', 'opencode-go')
  assert.ok(pick.prefixMatched)
  assert.equal(pick.pickedByRef, false)
  assert.equal(pick.multiUnpicked, true)
  assert.equal(pick.view.balance, 10, '取首个前缀命中行（OPENCODE_GO 行）')
})

test('pickPlatformView: ref 已登记但无对应行 → 首行 + multiUnpicked', () => {
  const view = multiView()
  view.provider_key_refs = { 'opencode-go': 'OPENCODE_GO_MISSING_REF' }
  const pick = pickPlatformView(view, 'opencode-go', 'opencode-go')
  assert.equal(pick.pickedByRef, false)
  assert.equal(pick.multiUnpicked, true)
  assert.equal(pick.view.balance, 10)
})

test('pickPlatformView: 无精确无前缀命中 → view undefined（回落 manual 判据）', () => {
  const pick = pickPlatformView(multiView(), 'deepseek', 'deepseek-official')
  assert.equal(pick.view, undefined)
  assert.equal(pick.multiUnpicked, false)
})

test('pickPlatformView: quota 视图畸形（无 by_platform Map）→ 安全空选取', () => {
  assert.equal(pickPlatformView(null, 'xiaomi', 'xiaomi').view, undefined)
  assert.equal(pickPlatformView({}, 'xiaomi', 'xiaomi').view, undefined)
})

// ── M4 窗口型余额语义（交付 A：window → amount → status 判定顺序 + 红线守卫）──

test('窗口解析纯函数：只认 display 的「已用 N%」，percent 字段非窗口用途不采信', () => {
  assert.equal(parseWindowUsedPct('已用 4%'), 4)
  assert.equal(parseWindowUsedPct('已用 12.5%'), 12.5)
  assert.equal(parseWindowUsedPct('¥0.94'), null)
  assert.equal(parseWindowUsedPct('在线'), null)
  assert.equal(parseWindowUsedPct(undefined), null)
  assert.equal(shortWindowLabel('5 小时窗口'), '5h')
  assert.equal(shortWindowLabel('5h 窗口'), '5h')
  assert.equal(shortWindowLabel('本周窗口'), '本周')
  assert.equal(shortWindowLabel('本月窗口'), '本月')
  assert.equal(shortWindowLabel('周额度'), '本周')
  assert.equal(shortWindowLabel('模型服务窗口'), '模型服务')
  const windows = windowItemsOf([
    { label: '5 小时窗口', percent: 1, display: '已用 1%' },
    { label: '搜索/工具额度', remaining: 3512, percent: 12.2 }, // percent 非窗口语义：无 display → 跳过
    { label: '账户余额', display: '¥0.94' },
  ])
  assert.deepEqual(windows, [{ label: '5 小时窗口', used_pct: 1, text: '已用 1%' }])
  assert.equal(compactWindowDisplay(windows), '5h 1%')
})

test('platformViewOf：zhipu 窗口形状 → mode=window，worst=3，display 紧凑串（不取同卡 ¥0.94/¥140）', () => {
  const row = {
    id: 'zhipu',
    label: '智谱 Coding Plan · max',
    status: 'ok',
    items: [
      { label: '5 小时窗口', percent: 1, display: '已用 1%' },
      { label: '本周窗口', percent: 3, display: '已用 3%' },
      { label: '搜索/工具额度', used: 488, limit: 4000, remaining: 3512, percent: 12.2 },
      { label: '账户余额', display: '¥0.94' },
      { label: '累计消费', display: '¥140' },
    ],
  }
  const view = platformViewOf(row, 't')
  assert.equal(view.mode, 'window')
  assert.equal(view.status, 'ok')
  assert.equal(view.balance, null, '窗口模式不采信同行账户余额')
  assert.equal(view.currency, null)
  assert.equal(view.worst_used_pct, 3)
  assert.equal(view.display, '5h 1% · 本周 3%')
  assert.deepEqual(view.windows.map((w) => w.label), ['5 小时窗口', '本周窗口'], '快照 items 原序')
  assert.equal(view.windows[1].text, '已用 3%')
})

test('platformViewOf：opencode-go 窗口形状 → 5h/本周/本月 紧凑串与 worst=8', () => {
  const view = platformViewOf({
    id: 'opencode-go#KEY',
    status: 'ok',
    items: [
      { label: '5h 窗口', percent: 4, display: '已用 4%' },
      { label: '本周窗口', percent: 8, display: '已用 8%', burnRatePerHour: 0.07 },
      { label: '本月窗口', percent: 4, display: '已用 4%' },
    ],
  }, 't')
  assert.equal(view.mode, 'window')
  assert.equal(view.display, '5h 4% · 本周 8% · 本月 4%')
  assert.equal(view.worst_used_pct, 8)
  assert.equal(view.windows.length, 3)
})

test('金额型不回归：deepseek/xiaomi 形状仍 mode=amount（remaining 优先）', () => {
  const ds = platformViewOf({ id: 'deepseek', status: 'ok', items: [{ label: 'CNY 总余额', display: '¥37.24', remaining: 37.24 }] }, 't')
  assert.equal(ds.mode, 'amount')
  assert.equal(ds.balance, 37.24)
  assert.equal(ds.currency, 'CNY')
  assert.equal(ds.windows, undefined)
  assert.equal(ds.worst_used_pct, undefined)
  const xiaomi = platformViewOf({ id: 'xiaomi', status: 'ok', items: [{ label: '总可用余额', display: '¥57.93', remaining: 57.93 }] }, 't')
  assert.equal(xiaomi.mode, 'amount')
  assert.equal(xiaomi.balance, 57.93)
})

test('状态型：无金额无窗口 → mode=status + display 原文（在线）', () => {
  const view = platformViewOf({ id: 'probe#x', status: 'ok', items: [{ label: '模型服务', display: '在线' }] }, 't')
  assert.equal(view.mode, 'status')
  assert.equal(view.display, '在线')
  assert.equal(view.balance, null)
  // 全无 → mode=null（回落 manual 判据）
  const empty = platformViewOf({ id: 'x', status: 'ok', items: [] }, 't')
  assert.equal(empty.mode, null)
  assert.equal(empty.display, null)
})

test('平台id#keyRef 精选 + 窗口模式组合：选中自己的 ref 行并按窗口读数', () => {
  const snap = {
    refreshedAt: '2026-11-20T00:00:00Z',
    providers: [
      { id: 'opencode-go#OPENCODE_GO_API_KEY', status: 'ok', items: [{ label: '5h 窗口', display: '已用 4%' }] },
      {
        id: 'opencode-go#OPENCODEGOSOTA_API_KEY',
        status: 'ok',
        items: [
          { label: '5h 窗口', display: '已用 9%' },
          { label: '本周窗口', display: '已用 11%' },
        ],
      },
    ],
    providerKeyRefs: { 'opencode-go': 'OPENCODEGOSOTA_API_KEY' },
  }
  const view = normalizeQuotaSnapshot(snap)
  const pick = pickPlatformView(view, 'opencode-go', 'opencode-go')
  assert.equal(pick.pickedByRef, true, '按 provider_key_refs 精选')
  assert.equal(pick.multiUnpicked, false)
  assert.equal(pick.view.mode, 'window')
  assert.equal(pick.view.display, '5h 9% · 本周 11%')
  assert.equal(pick.view.worst_used_pct, 11)
})
