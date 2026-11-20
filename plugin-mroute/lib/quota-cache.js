/**
 * quota-cache.js — quota 快照 TTL 缓存 + 单飞去重 + 失败指数退避 + 熔断状态机（M2）。
 *
 * 设计意图（mroute/07-assembly-plan.md §3.2 quota-cache 注释 / 07a 宿主侧配套 2/5）：
 * - TTL 缓存（缺省 60s，Config 可调 quota_cache_ttl_seconds）：quota 插件自身每 5 分钟刷新
 *   （config.ts:135 refreshIntervalMinutes 默认 5），mroute 侧缓存只是去抖 loopback 调用。
 * - 单飞（inFlight 去重）：并发 get() 共享同一次请求。
 * - 失败指数退避：5s×2^n 封顶 30min；**失败结果也占缓存位**（退避窗口内不再发请求）。
 * - 熔断状态机 `ok → degraded → cooling → half-open → ok`：
 *     · 连续失败 1 次（<N）→ degraded（任务书 §6.2：一次失败先 degraded）；
 *     · 连续 N 次（缺省 3）失败 → cooling（熔断开，冷却期完全静默不发请求）；
 *     · 冷却到点 → half-open，试探一次；成功 → ok（清计数，TTL 恢复正常）；
 *       失败 → 回 cooling（重新冷却，§6.4 半开试探语义）。
 * - stale 保留旧值（07a 宿主侧配套 5）：最近一次成功快照保留为 staleSnapshot，
 *   失败结果携带它供上层降级标注（machine=degraded），不静默丢弃。
 *
 * 无定时器、无后台活动：纯懒获取（查询时才拉取），幂等激活无需 dispose（红线 §4.7：
 * 所有注册走 ctx.effect——本模块无注册行为，不占 effect 面）。
 */

/**
 * @param {object} options
 * @param {() => Promise<{ ok:true, snapshot:object, at:number } | { ok:false, reason:string, at:number }>} options.fetcher
 *        quota-source 的 safe 层 fetch（恒不抛出）。
 * @param {number} [options.ttlMs=60000] 成功结果缓存 TTL。
 * @param {number} [options.backoffBaseMs=5000] 退避基值（5s×2^n）。
 * @param {number} [options.backoffCapMs=1800000] 退避封顶（30min）。
 * @param {number} [options.failureThreshold=3] 连续失败开熔断阈值 N。
 * @param {number} [options.cooldownMs=300000] cooling 冷却时长（到点转 half-open）。
 * @param {() => number} [options.now] 时间注入（selfcheck 用）。
 */
export function createQuotaCache(options) {
  const fetcher = options.fetcher
  let ttlMs = options.ttlMs ?? 60_000 // let：setTtlMs 热更（Config volatile TTL 编辑即生效）
  const backoffBaseMs = options.backoffBaseMs ?? 5_000
  const backoffCapMs = options.backoffCapMs ?? 30 * 60_000
  const failureThreshold = Math.max(1, options.failureThreshold ?? 3)
  const cooldownMs = options.cooldownMs ?? 5 * 60_000
  const now = options.now ?? (() => Date.now())

  /** @type {'ok'|'degraded'|'cooling'|'half-open'} */
  let breaker = 'ok'
  let consecutiveFailures = 0
  let coolingUntil = 0
  /** 最近一次结果（成功或失败都占缓存位——失败占位语义见文件头注）。 */
  let last = null
  /** 最近一次成功快照（stale 保留旧值，07a 纪律 5）。 */
  let lastGood = null
  /** @type {Promise<any>|null} 单飞锁。 */
  let inFlight = null

  const backoffDelayMs = () =>
    Math.min(backoffCapMs, backoffBaseMs * 2 ** Math.max(0, consecutiveFailures - 1))

  async function requestOnce() {
    // 单飞：并发 get() 共享同一次在途请求（07a 纪律 2）。
    if (inFlight !== null) return inFlight
    inFlight = (async () => {
      const t = now()
      let result
      try {
        result = await fetcher()
      } catch (error) {
        // fetcher 契约恒不抛出；此 catch 是防御纵深（quota-source 违约时不拖垮查询链，
        // 与 ranking.js livecheckAll 同款隔离纪律）。
        result = { ok: false, reason: 'fetcher-crashed', at: t }
      }
      if (result && typeof result === 'object' && typeof result.at !== 'number') result.at = t
      if (result?.ok === true) {
        breaker = 'ok'
        consecutiveFailures = 0
        coolingUntil = 0
        last = { ok: true, snapshot: result.snapshot, at: result.at }
        lastGood = last
      } else {
        const reason = result?.reason ?? 'unknown'
        // 确定性缺席分类（M2 补修，lead 2026-11-15 降级实测反馈）：reason='http-404' 是
        // quota 插件未装/停用的稳定信号（非网络瞬态）——首次即判缺席，**不进退避熔断计数**
        // （任务书 §6.1「缺席态无感回落零噪音」），不携带 staleSnapshot（不产生 stale 标注）；
        // 缺席占位走普通 TTL（get()），过期自动重探测 → quota 重新激活后 machine 自动恢复。
        // 网络/超时/5xx 及其它 4xx 仍为瞬态，走原退避熔断链。
        const absent = reason === 'http-404'
        if (absent) {
          breaker = 'ok'
          consecutiveFailures = 0
          coolingUntil = 0
          last = { ok: false, reason, at: result?.at ?? now(), staleSnapshot: null, absent: true }
        } else {
          consecutiveFailures += 1
          last = { ok: false, reason, at: result?.at ?? now(), staleSnapshot: lastGood?.snapshot ?? null }
          if (breaker === 'half-open' || consecutiveFailures >= failureThreshold) {
            // 半开试探失败 → 回 cooling 重新冷却；正常路径连续 N 次失败 → 开熔断。
            breaker = 'cooling'
            coolingUntil = now() + cooldownMs
          } else {
            breaker = 'degraded'
          }
        }
      }
      return last
    })()
    try {
      return await inFlight
    } finally {
      inFlight = null
    }
  }

  return {
    /**
     * 取快照（带缓存/退避/熔断决策）。
     * @returns {Promise<{ ok:true, snapshot:object, at:number, cached:boolean, breaker:string,
     *                     stale:false }
     *                  |{ ok:false, reason:string, at:number, cached:boolean, breaker:string,
     *                     staleSnapshot:object|null, absent?:boolean }>}
     *   absent=true = 确定性缺席（reason='http-404'，quota 未装/停用）：不进退避熔断、
     *   无 staleSnapshot，调用方（index.js getQuota）按缺席降级返回 null。
     */
    async get() {
      const t = now()
      if (breaker === 'cooling' && t < coolingUntil) {
        // 冷却期完全静默：不发请求，返回最近结果（失败占位语义在熔断层的投影）。
        return { ...(last ?? { ok: false, reason: 'no-data', at: t, staleSnapshot: null }), cached: true, breaker }
      }
      if (breaker === 'cooling') breaker = 'half-open' // 冷却到点，本次 get 即试探

      if (last !== null) {
        if (last.ok && t - last.at < ttlMs) return { ...last, cached: true, breaker, stale: false }
        if (!last.ok && t - last.at < (last.absent === true ? ttlMs : backoffDelayMs())) {
          // 失败结果占缓存位：瞬态走退避窗口、确定性缺席（absent）走普通 TTL——60s 内信任
          // 缺席结论，过期自动重探测（quota 重新激活即自动恢复 machine）。
          return { ...last, cached: true, breaker }
        }
      }
      const result = await requestOnce()
      return { ...result, cached: false, breaker }
    },
    /** 熔断状态机当前态（诊断面/meta 用）。 */
    breakerState() {
      return breaker
    },
    /** TTL 热更（Config quota_cache_ttl_seconds 为 volatile 字段，编辑即生效；只影响后续 get 判定）。 */
    setTtlMs(ms) {
      if (typeof ms === 'number' && Number.isFinite(ms) && ms > 0) ttlMs = ms
    },
    /** 连续失败计数（诊断面）。 */
    failureCount() {
      return consecutiveFailures
    },
    /** 清空缓存与状态机（Config 热更 TTL 等场景；测试用）。 */
    invalidate() {
      last = null
      lastGood = null
      breaker = 'ok'
      consecutiveFailures = 0
      coolingUntil = 0
    },
  }
}
