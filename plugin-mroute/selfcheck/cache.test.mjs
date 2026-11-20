/**
 * selfcheck/cache.test.mjs — quota-cache：TTL / 单飞 / 失败退避占位 / 熔断状态机
 * `ok → degraded → cooling → half-open → ok`（可变时钟注入，无真实等待）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createQuotaCache } from '../lib/quota-cache.js'
import { SNAPSHOT_OK } from './fixtures.mjs'

/** 可变时钟 + 计数 fetcher 工厂。 */
function harness({ failReasons = [], snapshot = SNAPSHOT_OK } = {}) {
  let t = 1_000_000
  let calls = 0
  const fetcher = async () => {
    const idx = calls
    calls += 1
    if (idx < failReasons.length) return { ok: false, reason: failReasons[idx], at: t }
    return { ok: true, snapshot, at: t }
  }
  return {
    now: () => t,
    advance: (ms) => { t += ms },
    calls: () => calls,
    fetcher,
    snapshot,
  }
}

test('TTL 缓存：TTL 内命中不重发（缺省 60s）', async () => {
  const h = harness()
  const cache = createQuotaCache({ fetcher: h.fetcher, now: h.now })
  const first = await cache.get()
  assert.equal(first.ok, true)
  assert.equal(first.cached, false)
  h.advance(59_999)
  const second = await cache.get()
  assert.equal(second.ok, true)
  assert.equal(second.cached, true)
  assert.equal(h.calls(), 1)
  h.advance(2) // 过 TTL（60s 整）→ 重发
  const third = await cache.get()
  assert.equal(third.cached, false)
  assert.equal(h.calls(), 2)
})

test('单飞：并发 get 共享同一次请求', async () => {
  const h = harness()
  const cache = createQuotaCache({ fetcher: h.fetcher, now: h.now })
  const [a, b, c] = await Promise.all([cache.get(), cache.get(), cache.get()])
  assert.equal(a.ok, true)
  assert.equal(b.ok, true)
  assert.equal(c.ok, true)
  assert.equal(h.calls(), 1)
})

test('失败结果占缓存位 + 指数退避（5s×2^n）：一次失败 → degraded，退避窗口内不重发', async () => {
  const h = harness({ failReasons: ['http-500'] })
  const cache = createQuotaCache({ fetcher: h.fetcher, now: h.now, failureThreshold: 3 })
  const fail1 = await cache.get()
  assert.equal(fail1.ok, false)
  assert.equal(fail1.reason, 'http-500')
  assert.equal(fail1.breaker, 'degraded') // 一次失败先 degraded（§6.2）
  assert.equal(fail1.cached, false)
  assert.equal(cache.breakerState(), 'degraded')
  assert.equal(cache.failureCount(), 1)
  // 退避窗口（base 5s×2^0=5s）内：占位，不重发
  h.advance(4_999)
  const 占位 = await cache.get()
  assert.equal(占位.cached, true)
  assert.equal(h.calls(), 1)
  // 过窗口 → 重发
  h.advance(2)
  const retry = await cache.get()
  assert.equal(retry.ok, true) // 第二次 fetch 成功
  assert.equal(cache.breakerState(), 'ok') // 成功恢复
  assert.equal(cache.failureCount(), 0)
})

test('连续 N 次失败 → cooling：冷却期完全静默，到点 half-open 试探，成功 → ok 且 TTL 正常', async () => {
  const h = harness({ failReasons: ['http-500', 'timeout', 'network'] })
  const cache = createQuotaCache({ fetcher: h.fetcher, now: h.now, failureThreshold: 3, cooldownMs: 300_000 })
  // fail1（degraded，退避 5s）
  await cache.get()
  h.advance(5_001)
  // fail2（degraded，退避 10s）
  const fail2 = await cache.get()
  assert.equal(fail2.breaker, 'degraded')
  h.advance(10_001)
  // fail3 → cooling
  const fail3 = await cache.get()
  assert.equal(fail3.breaker, 'cooling')
  assert.equal(cache.breakerState(), 'cooling')
  // 冷却期完全静默：不重发（失败占位在熔断层的投影）
  h.advance(299_999)
  const silent = await cache.get()
  assert.equal(silent.cached, true)
  assert.equal(silent.breaker, 'cooling')
  assert.equal(h.calls(), 3)
  // 冷却到点 → half-open 试探 → 成功 → ok
  h.advance(2)
  const probe = await cache.get()
  assert.equal(probe.ok, true)
  assert.equal(h.calls(), 4)
  assert.equal(cache.breakerState(), 'ok')
  assert.equal(cache.failureCount(), 0)
  // 恢复后 TTL 正常：试探成功后 TTL 内命中（§6.4）
  h.advance(59_999)
  const cached = await cache.get()
  assert.equal(cached.cached, true)
  assert.equal(h.calls(), 4)
})

test('half-open 试探失败 → 回 cooling 重新冷却（§6.4 半开语义）', async () => {
  const h = harness({ failReasons: ['http-500', 'http-500', 'http-500', 'http-503'] })
  const cache = createQuotaCache({ fetcher: h.fetcher, now: h.now, failureThreshold: 3, cooldownMs: 60_000 })
  await cache.get(); h.advance(5_001)
  await cache.get(); h.advance(10_001)
  await cache.get() // cooling
  h.advance(60_001) // 到点
  const probe = await cache.get() // half-open 试探 → fail4
  assert.equal(probe.ok, false)
  assert.equal(probe.breaker, 'cooling') // 回冷却
  assert.equal(h.calls(), 4)
  // 新冷却期内静默
  h.advance(59_999)
  const silent = await cache.get()
  assert.equal(silent.cached, true)
  assert.equal(h.calls(), 4)
})

test('失败携带 staleSnapshot（07a 纪律 5：stale 保留旧值）', async () => {
  // 先成功 1 次，然后后续全失败
  let t = 1_000_000
  let calls = 0
  const fetcher = async () => {
    calls += 1
    if (calls === 1) return { ok: true, snapshot: SNAPSHOT_OK, at: t }
    return { ok: false, reason: 'http-500', at: t }
  }
  const cache = createQuotaCache({ fetcher, now: () => t, failureThreshold: 99 })
  const good = await cache.get()
  assert.equal(good.ok, true)
  t += 61_000 // 过 TTL
  const fail = await cache.get()
  assert.equal(fail.ok, false)
  assert.equal(fail.reason, 'http-500')
  assert.deepEqual(fail.staleSnapshot, SNAPSHOT_OK) // stale 快照供上层 degraded 展示
})

test('invalidate 清空缓存与状态机；setTtlMs 热更 TTL', async () => {
  const h = harness()
  const cache = createQuotaCache({ fetcher: h.fetcher, now: h.now, ttlMs: 60_000 })
  await cache.get()
  cache.setTtlMs(5_000)
  h.advance(6_000) // 原 TTL 60s 内、新 TTL 5s 外 → 重发（热更生效）
  await cache.get()
  assert.equal(h.calls(), 2)
  cache.invalidate()
  assert.equal(cache.breakerState(), 'ok')
  assert.equal(cache.failureCount(), 0)
})

test('fetcher 违约抛出（防御纵深）→ 归一 fetcher-crashed，不拖垮 get', async () => {
  const cache = createQuotaCache({ fetcher: async () => { throw new Error('contract violation') }, now: () => 1_000_000 })
  const result = await cache.get()
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'fetcher-crashed')
})

// ── 404 确定性缺席（M2 补修，lead 降级实测反馈）：http-404 首次即缺席，不进退避熔断 ──

test('404 缺席：首次即判缺席——breaker 保持 ok、失败计数不增、无 staleSnapshot、absent 标记', async () => {
  const h = harness({ failReasons: ['http-404'] })
  const cache = createQuotaCache({ fetcher: h.fetcher, now: h.now, failureThreshold: 3 })
  const result = await cache.get()
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'http-404')
  assert.equal(result.absent, true)
  assert.equal(cache.breakerState(), 'ok', '缺席不进 degraded/cooling')
  assert.equal(cache.failureCount(), 0)
  assert.equal(result.staleSnapshot, null, '缺席无 stale 标注')
})

test('404 缺席：连续 404 不升级退避/熔断；占位窗口用普通 TTL（59s 内静默，60s 后重探测自动恢复）', async () => {
  let t = 1_000_000
  let calls = 0
  const fetcher = async () => {
    calls += 1
    if (calls <= 2) return { ok: false, reason: 'http-404', at: t } // 停用期两次探测均 404
    return { ok: true, snapshot: SNAPSHOT_OK, at: t } // quota 重新激活 → 自动恢复
  }
  const cache = createQuotaCache({ fetcher, now: () => t, failureThreshold: 3 })
  await cache.get() // 探测1 → 404 absent
  t += 5_000 // 瞬态退避窗口（5s）已过——缺席不走退避，60s TTL 内仍占位
  const within = await cache.get()
  assert.equal(within.cached, true)
  assert.equal(calls, 1, '缺席占位窗口 = TTL（60s），非 5s 退避')
  assert.equal(cache.breakerState(), 'ok')
  t += 56_000 // 累计 61s > TTL → 重探测（探测2）→ 仍 404：缺席不熔断
  const stillAbsent = await cache.get()
  assert.equal(stillAbsent.ok, false)
  assert.equal(stillAbsent.absent, true)
  assert.equal(cache.breakerState(), 'ok', '连续 404 也不熔断（两次探测）')
  assert.equal(cache.failureCount(), 0)
  t += 61_000 // 再过 TTL → 重探测（探测3）→ quota 已激活 → 自动恢复
  const recovered = await cache.get()
  assert.equal(recovered.ok, true)
  assert.equal(recovered.cached, false)
  assert.equal(cache.breakerState(), 'ok')
})

test('404 缺席 vs 瞬态区分：http-500 仍走退避链（5s 窗口 + degraded），404 不携带 stale 旧值', async () => {
  // 瞬态对照：500 → degraded + 5s 占位（现有行为回归）
  const h500 = harness({ failReasons: ['http-500'] })
  const c500 = createQuotaCache({ fetcher: h500.fetcher, now: h500.now, failureThreshold: 3 })
  const r500 = await c500.get()
  assert.equal(r500.breaker, 'degraded')
  assert.equal(r500.absent, undefined)

  // 先成功后 404：有 lastGood 也不附 staleSnapshot（无 stale 标注）
  let t = 1_000_000
  let calls = 0
  const fetcher = async () => {
    calls += 1
    if (calls === 1) return { ok: true, snapshot: SNAPSHOT_OK, at: t }
    return { ok: false, reason: 'http-404', at: t }
  }
  const cache = createQuotaCache({ fetcher, now: () => t, failureThreshold: 99 })
  await cache.get()
  t += 61_000
  const absent = await cache.get()
  assert.equal(absent.ok, false)
  assert.equal(absent.absent, true)
  assert.equal(absent.staleSnapshot, null, '缺席态不产生 stale 标注（任务书 §6.1 无感回落）')
})
