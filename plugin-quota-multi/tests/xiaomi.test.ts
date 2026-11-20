// Xiaomi MiMo adapters (fork): balance / token-plan parsers, the optional
// 7-day usage rows, and the catalog shape (keyRefs / origins / ALL_DIRECT_REFS
// — the ref set that drives credential-change refreshes).
// Fixtures follow the official docs: mimo.mi.com/docs zh-CN
// api/asset/balance-get, credits-get, consumption-get (checked 2026-11-13).
import assert from 'node:assert/strict'
import test from 'node:test'
import { ALL_DIRECT_REFS, CATALOG_EXTRA, CUSTOM_FORMATS, xiaomiUtcDate, xiaomiUsageRows } from '../src/direct.ts'
import { XIAOMI_PLATFORM_ID, XIAOMI_TOKEN_PLAN_PLATFORM_ID } from '../src/platform-map.ts'

const originalFetch = globalThis.fetch

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}

test.after(() => {
  globalThis.fetch = originalFetch
})

const xiaomi = CATALOG_EXTRA.find((a) => a.id === XIAOMI_PLATFORM_ID)!
const xiaomiTp = CATALOG_EXTRA.find((a) => a.id === XIAOMI_TOKEN_PLAN_PLATFORM_ID)!

test('xiaomi catalog entry: keyRefs / envKeys / origins / ALL_DIRECT_REFS', () => {
  assert.deepEqual(xiaomi.keyRefs, ['XIAOMI_API_KEY', 'MIMO_API_KEY'])
  assert.deepEqual(xiaomi.envKeys, ['XIAOMI_API_KEY', 'MIMO_API_KEY'])
  // entry() derives origins from the endpoint — third-party gateways on other
  // origins must never be queried against the official balance endpoint.
  assert.deepEqual(xiaomi.origins, ['https://api.xiaomimimo.com'])
  assert.deepEqual(xiaomiTp.keyRefs, ['XIAOMI_TOKEN_PLAN_API_KEY', 'MIMO_TOKEN_PLAN_API_KEY'])
  assert.deepEqual(xiaomiTp.origins, ['https://token-plan-cn.xiaomimimo.com'])
  // KNOWN_REFS (src/index.ts) is built from ALL_DIRECT_REFS: without the
  // xiaomi refs there, a key added in DSH would not trigger a refresh.
  for (const ref of ['XIAOMI_API_KEY', 'MIMO_API_KEY', 'XIAOMI_TOKEN_PLAN_API_KEY', 'MIMO_TOKEN_PLAN_API_KEY']) {
    assert.ok(ALL_DIRECT_REFS.includes(ref), `ALL_DIRECT_REFS lacks ${ref}`)
  }
  assert.ok((CUSTOM_FORMATS as readonly string[]).includes('xiaomi-balance'))
})

test('xiaomi balance renders total + gift rows, keeps 2-decimal display strings', async () => {
  const calls: string[] = []
  globalThis.fetch = (async (input, init) => {
    const url = String(input)
    calls.push(`${url} ${String((init?.headers as Record<string, string> | undefined)?.Authorization)}`)
    if (url.includes('/v1/platform/balance')) {
      return jsonResponse({
        object: 'balance',
        is_available: true,
        balance_infos: [{
          currency: 'CNY',
          cash_balance: '10.00',
          gift_balance: '5.00',
          frozen_balance: '0.00',
          credit_limit: '0.00',
          credit_available: '0.00',
          total_available: '15.00',
        }],
      })
    }
    // usage rows are optional: an empty daily list adds nothing.
    return jsonResponse({ object: 'list', data: [] })
  }) as typeof fetch

  const snapshot = await xiaomi.fetch('sk-test')
  assert.equal(snapshot.id, 'xiaomi')
  assert.equal(snapshot.status, 'ok')
  assert.deepEqual(snapshot.items, [
    { label: '总可用余额', display: '¥15.00', remaining: 15 },
    { label: '其中赠金', display: '¥5.00' },
  ])
  assert.equal(calls.length, 2)
  assert.match(calls[0]!, /^https:\/\/api\.xiaomimimo\.com\/v1\/platform\/balance Bearer sk-test$/)
  assert.match(calls[1]!, /\/v1\/platform\/usage\/daily\?start_date=\d{4}-\d{2}-\d{2}&end_date=\d{4}-\d{2}-\d{2} Bearer sk-test$/)
})

test('xiaomi balance surfaces credit / frozen / unavailable states', async () => {
  globalThis.fetch = (async () => jsonResponse({
    object: 'balance',
    is_available: false,
    balance_infos: [{
      currency: 'CNY',
      cash_balance: '0.00',
      gift_balance: '0.00',
      frozen_balance: '3.00',
      credit_limit: '100.00',
      credit_available: '80.00',
      total_available: '80.00',
    }],
  })) as typeof fetch

  const snapshot = await xiaomi.fetch('sk-test')
  assert.deepEqual(snapshot.items, [
    { label: '总可用余额', display: '¥80.00', remaining: 80 },
    { label: '其中授信', display: '¥80.00' },
    { label: '冻结', display: '¥3.00' },
    { label: '账户状态', display: '余额不可用（冻结金额超过可用余额）' },
  ])
})

test('xiaomi balance rejects a shape without balance_infos[0]', async () => {
  globalThis.fetch = (async () => jsonResponse({ object: 'balance', balance_infos: [] })) as typeof fetch
  await assert.rejects(xiaomi.fetch('sk-test'), /missing balance_infos\[0\]/)
})

test('xiaomi token plan renders credit usage with the UTC period end and plan suffix', async () => {
  globalThis.fetch = (async () => jsonResponse({
    object: 'token_plan',
    plan_code: 'tp-pro-month',
    period: { start_at: '2026-11-01 00:00:00', end_at: '2026-11-30 23:59:59' },
    quota: { total_credits: 1000, used_credits: 250, remaining_credits: 750 },
    auto_renew: true,
    claw_enabled: false,
  })) as typeof fetch

  const snapshot = await xiaomiTp.fetch('tp-test')
  assert.equal(snapshot.label, '小米 MiMo Token Plan · tp-pro-month')
  assert.deepEqual(snapshot.items, [{
    label: 'Token Plan 积分',
    used: 250,
    limit: 1000,
    remaining: 750,
    percent: 25,
    display: '已用 250 / 1,000 credits',
    resetAt: '2026-11-30T23:59:59Z',
  }])
})

test('xiaomi token plan derives remaining when the upstream omits it', async () => {
  globalThis.fetch = (async () => jsonResponse({
    object: 'token_plan',
    quota: { total_credits: 800, used_credits: 650 },
  })) as typeof fetch
  const snapshot = await xiaomiTp.fetch('tp-test')
  const item = snapshot.items[0]!
  assert.equal(item.remaining, 150)
  assert.equal(item.percent, 81.3)
})

test('xiaomi token plan rejects a body without quota', async () => {
  globalThis.fetch = (async () => jsonResponse({ object: 'token_plan' })) as typeof fetch
  await assert.rejects(xiaomiTp.fetch('tp-test'), /missing quota/)
})

test('xiaomiUsageRows aggregates the 7-day UTC window across currencies', async () => {
  const calls: string[] = []
  globalThis.fetch = (async (input) => {
    calls.push(String(input))
    return jsonResponse({
      object: 'list',
      data: [
        { date: xiaomiUtcDate(-2), resource_type: 'model', name: 'mimo-v2.6-flash', currency: 'CNY', consumed_amount: '1.25', total_tokens: 1200, request_count: 8 },
        { date: xiaomiUtcDate(-1), resource_type: 'model', name: 'mimo-v2.6-pro', currency: 'CNY', consumed_amount: '2.75', total_tokens: 800, request_count: 4 },
        { date: xiaomiUtcDate(-1), resource_type: 'plugin', name: 'mimo-claw', currency: 'USD', consumed_amount: '0.50', total_tokens: 100, request_count: 1 },
      ],
    })
  }) as typeof fetch

  const items = await xiaomiUsageRows('sk-test')
  assert.equal(calls.length, 1)
  assert.match(calls[0]!, new RegExp(`start_date=${xiaomiUtcDate(-6)}&end_date=${xiaomiUtcDate(0)}`))
  assert.deepEqual(items, [
    { label: '近 7 天消耗', display: '¥4.00' },
    { label: '近 7 天 Tokens', display: '2,100' },
    { label: '近 7 天请求', display: '13' },
  ])
})

test('xiaomiUsageRows returns nothing for an empty window (no noise rows)', async () => {
  globalThis.fetch = (async () => jsonResponse({ object: 'list', data: [] })) as typeof fetch
  assert.deepEqual(await xiaomiUsageRows('sk-test'), [])
})

test('xiaomiUtcDate walks UTC calendar days', () => {
  for (const offset of [-6, -1, 0]) {
    assert.match(xiaomiUtcDate(offset), /^\d{4}-\d{2}-\d{2}$/)
    assert.equal(xiaomiUtcDate(offset), new Date(Date.now() + offset * 86400_000).toISOString().slice(0, 10))
  }
})
