/**
 * 活校验：注册表 routeProvider 与 llm.listProviders()/listModels() 的交集核对（MVP 单 TTL 60s，
 * 任务书允许的简化；route-pin 双 TTL（vendors/tkaiz0406--dsh-subagent-route-pin/index.js:871-903）
 * 的核心纪律保留——「catalog 读不到 ≠ 校验通过」，读不到不写缓存，不当成校验通过）。
 * 模型级差异只标注不降权：DSH catalog 是建议性，未列出 ≠ 不可用（route-pin L867-869 同判）。
 */
import { errorMessage } from './errors.js'

const LIVECHECK_TTL_MS = 60_000

export function createLivecheck(ctx) {
  const cache = new Map() // routeProvider -> { at, status, detail, availableModels }
  return {
    /**
     * @param {string} providerId
     * @returns {Promise<{ status:'ok'|'unknown', detail:string, availableModels:string[],
     *                    cached:boolean, catalogError:boolean }>}
     */
    async check(providerId) {
      const now = Date.now()
      const cached = cache.get(providerId)
      if (cached !== undefined && now - cached.at < LIVECHECK_TTL_MS) {
        return { ...cached, cached: true, catalogError: false }
      }
      let result
      try {
        const providers = ctx.llm.listProviders()
        const known = providers.some((provider) => provider.id === providerId)
        if (!known) {
          result = {
            status: 'unknown',
            detail: `provider "${providerId}" 未注册（可用: ${providers.map((p) => p.id).join(', ') || '无'}）`,
            availableModels: [],
          }
        } else {
          const models = await ctx.llm.listModels(providerId)
          result = { status: 'ok', detail: '', availableModels: models.map((m) => m.id) }
        }
      } catch (error) {
        // 目录读不到 ≠ 校验通过：不写缓存，本次按 unknown 处理（TTL 内下次重读）
        return {
          status: 'unknown',
          detail: `目录读取失败（未缓存，不当成校验通过）: ${errorMessage(error)}`,
          availableModels: [],
          cached: false,
          catalogError: true,
        }
      }
      cache.set(providerId, { at: now, status: result.status, detail: result.detail, availableModels: result.availableModels })
      return { ...result, cached: false, catalogError: false }
    },
    /** 仅供诊断/测试观察缓存条数。 */
    size() {
      return cache.size
    },
  }
}
