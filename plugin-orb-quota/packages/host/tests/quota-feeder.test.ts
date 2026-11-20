import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  compactQuotaText,
  parseQuotaStatus,
  pickUrgentRow,
  QuotaFeeder,
  toQuotaRows,
  type QuotaFetch,
  type QuotaProvider,
} from '../src/quota-feeder.ts'

function provider(overrides: Partial<QuotaProvider> & { id: string }): QuotaProvider {
  return {
    label: overrides.id,
    status: 'ok',
    items: [],
    ...overrides,
  }
}

const sample = {
  refreshedAt: '2026-11-15T03:00:00.000Z',
  alertPercent: 85,
  currentModel: { provider: 'deepseek-official', model: 'deepseek-chat', platform: 'deepseek', summary: '总余额 ¥284.73' },
  providers: [
    provider({
      id: 'zhipu',
      label: '智谱',
      items: [
        { label: '周额度', percent: 82 },
        { label: '余额', display: '¥284.73' },
      ],
    }),
    provider({
      id: 'xiaomi',
      label: '小米',
      items: [{ label: '余额', display: '余额 ¥57.93' }],
    }),
    provider({ id: 'opencode', label: 'OpenCode Go', status: 'error', message: 'missing key' }),
  ],
}

describe('quota status parsing', () => {
  it('validates the snapshot and keeps the reference fields', () => {
    const read = parseQuotaStatus(sample)
    assert.equal(read.kind, 'ready')
    if (read.kind !== 'ready') return
    assert.equal(read.current, 'deepseek')
    assert.equal(read.alertPercent, 85)
    assert.equal(read.providers.length, 3)
    assert.deepEqual(read.providers[0], {
      id: 'zhipu',
      label: '智谱',
      status: 'ok',
      message: undefined,
      items: [
        { label: '周额度', percent: 82, display: undefined },
        { label: '余额', percent: undefined, display: '¥284.73' },
      ],
    })
  })

  it('treats missing, empty, or malformed provider lists as unavailable', () => {
    assert.equal(parseQuotaStatus(null).kind, 'unavailable')
    assert.equal(parseQuotaStatus({ providers: 'x' }).kind, 'unavailable')
    assert.equal(parseQuotaStatus({ providers: [] }).kind, 'unavailable')
    assert.equal(parseQuotaStatus({ providers: [{ id: '' }] }).kind, 'unavailable')
    // Every entry malformed is as good as no entry at all.
    assert.equal(parseQuotaStatus({ providers: [{ label: 'x' }, 7] }).kind, 'unavailable')
  })

  it('falls back to the default alert threshold and drops malformed items', () => {
    const read = parseQuotaStatus({ providers: [provider({ id: 'a', items: [{ label: 'ok', percent: 40 }, { percent: 5 }, 'junk'] as never })] })
    assert.equal(read.kind, 'ready')
    if (read.kind !== 'ready') return
    assert.equal(read.alertPercent, 85)
    assert.equal(read.providers[0].items.length, 1)
  })
})

describe('quota display rows', () => {
  const read = parseQuotaStatus(sample)
  if (read.kind !== 'ready') throw new Error('fixture must parse')
  const all = toQuotaRows(read.providers, { yellowPercent: 60, alertPercent: 85, hidden: [] })

  it('derives the reading, percent, and tier of each row', () => {
    const zhipu = all.find((row) => row.id === 'zhipu')
    assert.ok(zhipu)
    assert.equal(zhipu.text, '82% · ¥284.73')
    assert.equal(zhipu.percent, 82)
    assert.equal(zhipu.tier, 'yellow')
    assert.equal(all.find((row) => row.id === 'xiaomi')?.tier, 'plain')
    assert.equal(all.find((row) => row.id === 'opencode')?.text, 'missing key')
  })

  it('filters hidden ids and sorts by tier, percent, then id', () => {
    const hidden = toQuotaRows(read.providers, { yellowPercent: 60, alertPercent: 85, hidden: ['zhipu'] })
    // xiaomi and opencode share the plain tier with no percent, so id order decides.
    assert.deepEqual(hidden.map((row) => row.id), ['opencode', 'xiaomi'])
    const red = toQuotaRows([
      provider({ id: 'b', items: [{ label: '窗口', percent: 90 }] }),
      provider({ id: 'a', items: [{ label: '窗口', percent: 90 }] }),
      provider({ id: 'c', items: [{ label: '窗口', percent: 70 }] }),
    ], { yellowPercent: 60, alertPercent: 85, hidden: [] })
    assert.deepEqual(red.map((row) => row.id), ['a', 'b', 'c'])
  })

  it('picks the urgent row deterministically and falls back through current and id', () => {
    assert.equal(pickUrgentRow(all, 60, 'deepseek')?.id, 'zhipu', 'the only over-threshold row leads')
    // No row over 95 and no 'deepseek' row exists: id order decides among healthy rows.
    assert.equal(pickUrgentRow(all, 95, 'deepseek')?.id, 'xiaomi')
    assert.equal(pickUrgentRow(all, 95, '')?.id, 'xiaomi')
    // A current-platform match wins over plain id order.
    assert.equal(pickUrgentRow(all, 95, 'xiaomi')?.id, 'xiaomi')
    // A tie on percent breaks by id.
    const tie = toQuotaRows([
      provider({ id: 'b', items: [{ label: '窗口', percent: 70 }] }),
      provider({ id: 'a', items: [{ label: '窗口', percent: 70 }] }),
    ], { yellowPercent: 60, alertPercent: 85, hidden: [] })
    assert.equal(pickUrgentRow(tie, 60, '')?.id, 'a')
    // Nothing healthy to show.
    assert.equal(pickUrgentRow(all.filter((row) => row.state !== 'ok'), 60, ''), undefined)
  })
})

describe('quota feeder', () => {
  const okBody = sample

  function fetchWith(handler: (url: string) => { status: number; body?: unknown } | { status: number; body?: unknown }): QuotaFetch {
    return (async (url: string) => {
      const outcome = handler(url)
      return {
        ok: outcome.status === 200,
        status: outcome.status,
        json: async () => {
          if (outcome.body === undefined) throw new Error('no body')
          return outcome.body
        },
      }
    }) as QuotaFetch
  }

  it('reads a ready snapshot, hides channels, and re-derives rows after a prefs change', async () => {
    let calls = 0
    let prefs = { yellowPercent: 60, hidden: [] as string[] }
    const feeder = new QuotaFeeder({
      endpoint: () => 'http://127.0.0.1:1/plugins/dsh-quota/api/status',
      fetch: fetchWith(() => { calls += 1; return { status: 200, body: okBody } }),
      prefs: () => prefs,
    })
    const first = await feeder.refresh(true)
    assert.equal(first.state, 'ready')
    // zhipu is the yellow tier; the two plain rows tie on percent and break by id.
    assert.deepEqual(first.rows.map((row) => row.id), ['zhipu', 'opencode', 'xiaomi'])
    // The settings page sees hidden channels too.
    assert.deepEqual(feeder.allRows().map((row) => row.id), ['zhipu', 'opencode', 'xiaomi'])
    prefs = { yellowPercent: 60, hidden: ['zhipu'] }
    const derived = feeder.current()
    assert.deepEqual(derived.rows.map((row) => row.id), ['opencode', 'xiaomi'], 'rows re-derive from the cached read')
    assert.deepEqual(feeder.allRows().map((row) => row.id), ['zhipu', 'opencode', 'xiaomi'])
    assert.equal(calls, 1, 'no second request for a preference change')
  })

  it('degrades on 404, broken bodies, missing services, and all-failing providers', async () => {
    const cases: Array<{ name: string; feeder: QuotaFeeder; error: string }> = [
      {
        name: 'route 404',
        feeder: new QuotaFeeder({
          endpoint: () => 'http://127.0.0.1:1/plugins/dsh-quota/api/status',
          fetch: fetchWith(() => ({ status: 404 })),
          prefs: () => ({ yellowPercent: 60, hidden: [] }),
        }),
        error: 'status 404',
      },
      {
        name: 'broken json',
        feeder: new QuotaFeeder({
          endpoint: () => 'http://127.0.0.1:1/plugins/dsh-quota/api/status',
          fetch: fetchWith(() => ({ status: 200 })),
          prefs: () => ({ yellowPercent: 60, hidden: [] }),
        }),
        error: 'no body',
      },
      {
        name: 'empty providers',
        feeder: new QuotaFeeder({
          endpoint: () => 'http://127.0.0.1:1/plugins/dsh-quota/api/status',
          fetch: fetchWith(() => ({ status: 200, body: { providers: [] } })),
          prefs: () => ({ yellowPercent: 60, hidden: [] }),
        }),
        error: 'no providers',
      },
      {
        name: 'every provider failing',
        feeder: new QuotaFeeder({
          endpoint: () => 'http://127.0.0.1:1/plugins/dsh-quota/api/status',
          fetch: fetchWith(() => ({ status: 200, body: { providers: [provider({ id: 'x', status: 'missing-key' })] } })),
          prefs: () => ({ yellowPercent: 60, hidden: [] }),
        }),
        error: 'no healthy provider',
      },
      {
        name: 'web services missing',
        feeder: new QuotaFeeder({
          endpoint: () => undefined,
          prefs: () => ({ yellowPercent: 60, hidden: [] }),
        }),
        error: 'web services missing',
      },
    ]
    for (const item of cases) {
      const snapshot = await item.feeder.refresh(true)
      assert.deepEqual(snapshot, { rows: [], current: '', refreshedAt: '', state: 'unavailable' }, item.name)
      assert.equal(item.feeder.lastError(), item.error, item.name)
    }
  })

  it('coalesces simultaneous reads and keeps a healthy row beside failing ones', async () => {
    let calls = 0
    let prefs = { yellowPercent: 60, hidden: [] as string[] }
    const feeder = new QuotaFeeder({
      endpoint: () => 'http://127.0.0.1:1/plugins/dsh-quota/api/status',
      fetch: fetchWith(() => { calls += 1; return { status: 200, body: okBody } }),
      prefs: () => prefs,
      now: () => 1_000,
    })
    const [left, right] = await Promise.all([feeder.refresh(true), feeder.refresh(true)])
    assert.equal(calls, 1, 'one request serves both callers')
    assert.equal(left.state, 'ready')
    assert.equal(right.state, 'ready')
    prefs = { yellowPercent: 60, hidden: ['zhipu', 'xiaomi', 'opencode'] }
    assert.equal(feeder.current().state, 'ready', 'hiding every row still keeps the read live')
    assert.deepEqual(feeder.current().rows, [])
    feeder.clear()
    assert.deepEqual(feeder.current(), { rows: [], current: '', refreshedAt: '', state: 'unavailable' })
  })
})

describe('chip text', () => {
  it('compresses one row into a short label and value', () => {
    const read = parseQuotaStatus(sample)
    if (read.kind !== 'ready') throw new Error('fixture must parse')
    const rows = toQuotaRows(read.providers, { yellowPercent: 60, alertPercent: 85, hidden: [] })
    assert.equal(compactQuotaText(rows.find((row) => row.id === 'zhipu')!), '智谱·82%')
    // A balance-only row keeps just the leading amount, rounded to whole units,
    // so the chip stays short enough to read inside the pill ("小米·¥58").
    assert.equal(compactQuotaText(rows.find((row) => row.id === 'xiaomi')!), '小米·¥58')
    // An ASCII label collapses to CamelCase initials; a failing row's message
    // becomes the value, spaces stripped and bounded.
    assert.equal(compactQuotaText(rows.find((row) => row.id === 'opencode')!), 'OC·missingk')
  })

  it('shortens long platform labels to a readable name', () => {
    const read = parseQuotaStatus({
      ...sample,
      providers: [
        provider({ id: 'zhipu', label: '智谱 Coding Plan · max', items: [{ label: '周额度', percent: 40 }] }),
        provider({ id: 'deepseek', label: 'DeepSeek', items: [{ label: '余额', display: '余额 ¥48.74' }] }),
      ],
    })
    if (read.kind !== 'ready') throw new Error('fixture must parse')
    const rows = toQuotaRows(read.providers, { yellowPercent: 60, alertPercent: 85, hidden: [] })
    assert.equal(compactQuotaText(rows.find((row) => row.id === 'zhipu')!), '智谱·40%')
    assert.equal(compactQuotaText(rows.find((row) => row.id === 'deepseek')!), 'DS·¥49')
  })
})
