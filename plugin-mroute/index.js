/**
 * mroute — M2 技术切片（宿主半唯一入口）。
 *
 * 四导出（样板形态，asar skills/dsh-doc/references/host-plugin.md）：name / inject / Config / apply。
 * inject 名均已对照 checkout 核实（subagent-setup / autotier 同款）：tools / llm / systemPrompt；
 * M2 增 'webServer'（宿主 webServer 服务 getOrigin(): string，inspect host Service catalog 实证；
 * 缺席 profile 下按可选注入面处理——machine 通道永远缺席，插件照常激活，任务书 §4.7 幂等激活）。
 *
 * 职责：注册 model_route_query 工具 + model_route_sync_models 工具（M4，models[] ↔ DSH 目录）
 * + systemPrompt 一句提示 + M2 quota 数据源装配
 * （webServer getOrigin loopback → quota-cache TTL/单飞/退避/熔断 → quota-view 归一化 →
 * model_route_query machine 行）。advisory-only：quota 数据只是建议参考，无任何阻断语义。
 * 红线自查锚：本文件与 lib/ 均无 llm/stream、agent/request、system-prompt/assemble 监听；
 * 唯一 HTTP 面 = 同进程 loopback（isLoopbackOrigin 围栏，无外呼）；无凭据读写、无 UI、无写回
 * （DecisionRecord JSONL 本地追加除外，M1 已收口）。
 */
import { Config } from './lib/config-schema.js'
import { readRegistry, readVolatile } from './lib/registry.js'
import { createLivecheck } from './lib/livecheck.js'
import { createRouteQueryTool } from './lib/tool-query.js'
import { createSyncModelsTool } from './lib/tool-sync-models.js'
import { createAliasSuggestTool } from './lib/tool-alias-suggest.js'
import { createDispatchPlanTool, TOOL_NAME as DISPATCH_PLAN_TOOL_NAME } from './lib/tool-dispatch-plan.js'
import { createEvalRunTool, TOOL_NAME as EVAL_RUN_TOOL_NAME } from './lib/tool-eval-run.mjs'
import { registerPromptSection } from './lib/prompt-section.js'
import { createQuotaSource } from './lib/quota-source.js'
import { createQuotaCache } from './lib/quota-cache.js'
import { normalizeQuotaSnapshot } from './lib/quota-view.js'
import { errorMessage } from './lib/errors.js'

export const name = 'mroute'
export const inject = ['tools', 'llm', 'systemPrompt', 'webServer']
export { Config }

/** 缺省 TTL（秒）——与 config-schema.js quota_cache_ttl_seconds 缺省一致。 */
const DEFAULT_QUOTA_TTL_SECONDS = 60

/**
 * @param {object} ctx cordis Context（tools / llm / systemPrompt / webServer 已按 inject 注入；
 *   webServer 在无该服务的 profile 下为 undefined——可选面纪律，照常激活）
 * @param {object} config 行配置；channels 等字段按 schema 声明为 volatile（Volatile 访问器，
 *   读取统一走 lib/registry.js readVolatile 双面兼容），volatile 热更在每次工具调用时经
 *   getRegistry() 重新读取；普通字段编辑重启插件重建状态（configuration.md 语义）。
 */
export function apply(ctx, config) {
  const logger = ctx.logger ?? { info() {}, warn() {}, error() {} }
  const getRegistry = () => readRegistry(config, logger)
  const livecheck = createLivecheck(ctx)
  // Config 值双面读取（volatile 热更；供 tool-query low_balance_threshold_cny 等）
  const readConfigValue = (key) => readVolatile(config?.[key])

  // ── M2 quota 数据源装配 ──────────────────────────────────────────
  // webServer 缺席（resolveOrigin=null）→ 不建 cache，getQuota 恒 null → machine 永远缺席、
  // 查询全量回落 manual（M1 行为不变），插件照常激活（任务书 §4.7 幂等激活）。
  const quotaSource = createQuotaSource(ctx.webServer)
  let quotaTtlMs = (Number(readConfigValue('quota_cache_ttl_seconds')) || DEFAULT_QUOTA_TTL_SECONDS) * 1000
  const quotaCache = quotaSource.available
    ? createQuotaCache({ fetcher: quotaSource.fetch, ttlMs: quotaTtlMs })
    : null
  // TTL 热更：volatile 字段编辑即时生效（setTtlMs 只影响后续 get 判定，不清缓存状态）。
  const getQuota = async () => {
    if (quotaCache === null) return null
    const nextTtlMs = (Number(readConfigValue('quota_cache_ttl_seconds')) || DEFAULT_QUOTA_TTL_SECONDS) * 1000
    if (nextTtlMs !== quotaTtlMs) {
      quotaTtlMs = nextTtlMs
      quotaCache.setTtlMs(nextTtlMs)
    }
    let result
    try {
      result = await quotaCache.get()
    } catch (error) {
      // cache.get 契约不抛出；防御纵深：任何意外只降级为「quota 缺席」，不拖垮查询（§6.1）。
      logger.warn?.(`[mroute] quota 缓存意外失败（按缺席降级）: ${errorMessage(error)}`)
      return null
    }
    if (result?.ok === true) {
      return { view: normalizeQuotaSnapshot(result.snapshot), degraded: false, breaker: result.breaker }
    }
    // 失败占位 + stale 保留旧值：降级期 machine 仍可参考最近一次成功快照（degraded:true 标注；
    // staleSnapshot 为空（从未成功过）→ null → 全量回落 manual。
    if (result?.staleSnapshot) {
      return { view: normalizeQuotaSnapshot(result.staleSnapshot), degraded: true, breaker: result.breaker }
    }
    return null
  }

  // 工具注册：服务缺席则告警降级，不阻断插件激活（practices.md 可选服务纪律）。
  // 注册即 effect（审计 M-2 修复；先例 dsh-subagent-setup plugin/index.js:345-352）：
  // dispose 挂 ctx.effect 归宿主 fiber 管理，停用/卸载由宿主精确回收，不自制 disposers 数组、
  // 不依赖「apply 返回 dispose」的无文档语义。
  if (typeof ctx.tools?.register === 'function') {
    try {
      const disposeTool = ctx.tools.register(
        createRouteQueryTool({ ctx, getRegistry, livecheck, logger, getQuota, readConfigValue }),
      )
      ctx.effect(() => disposeTool, 'mroute: model_route_query tool')
      // M4 交付 B：注册表 models[] ↔ DSH llm 目录同步（默认 dry-run；apply 经 configEditor 写 profile patch）。
      try {
        const disposeSync = ctx.tools.register(createSyncModelsTool({ ctx, getRegistry, livecheck, logger }))
        ctx.effect(() => disposeSync, 'mroute: model_route_sync_models tool')
      } catch (error) {
        logger.error?.(`[mroute] model_route_sync_models 注册失败: ${errorMessage(error)}`)
      }
      // M4.6：跨渠道模型归并建议（默认 dry-run；apply 只写 model_aliases 同 id 自反映射 + reviewed_at）。
      try {
        const disposeAlias = ctx.tools.register(createAliasSuggestTool({ ctx, getRegistry, logger }))
        ctx.effect(() => disposeAlias, 'mroute: model_route_alias_suggest tool')
      } catch (error) {
        logger.error?.(`[mroute] model_route_alias_suggest 注册失败: ${errorMessage(error)}`)
      }
    } catch (error) {
      logger.error?.(`[mroute] model_route_query 注册失败: ${errorMessage(error)}`)
    }
  } else {
    logger.warn?.('[mroute] ctx.tools.register 不可用，model_route_query / model_route_sync_models / model_route_alias_suggest 未注册')
  }

  // M4.11 派发预检：独立平级 try（不嵌套在 model_route_query 的 try 里——若后者注册失败，
  // 本工具仍应尝试注册，且自身注册失败要独立暴露，不能被兄弟的 catch 吞掉）。
  if (typeof ctx.tools?.register === 'function') {
    try {
      const disposeDispatch = ctx.tools.register(
        createDispatchPlanTool({ ctx, getRegistry, livecheck, logger, getQuota, readConfigValue }),
      )
      ctx.effect(() => disposeDispatch, `mroute: ${DISPATCH_PLAN_TOOL_NAME} tool`)
    } catch (error) {
      logger.error?.(`[mroute] ${DISPATCH_PLAN_TOOL_NAME} 注册失败: ${errorMessage(error)}`)
    }
  }

  // M5 自动评测：独立平级 try（理由同 M4.11——兄弟工具注册失败不应连坐，本工具失败也要独立暴露）。
  // dry_run:true 缺省零调用零写盘；实跑只写 model_eval/eval_status 两个顶层字段（不碰 channels/ratings）。
  if (typeof ctx.tools?.register === 'function') {
    try {
      const disposeEval = ctx.tools.register(
        createEvalRunTool({ ctx, getRegistry, livecheck, logger, readConfigValue }),
      )
      ctx.effect(() => disposeEval, `mroute: ${EVAL_RUN_TOOL_NAME} tool`)
    } catch (error) {
      logger.error?.(`[mroute] ${EVAL_RUN_TOOL_NAME} 注册失败: ${errorMessage(error)}`)
    }
  }

  // systemPrompt 一句提示；注册失败不阻断（prompt-section.js 内部已兜底），dispose 同挂 ctx.effect。
  const disposeSection = registerPromptSection(ctx)
  if (typeof disposeSection === 'function') {
    ctx.effect(() => disposeSection, 'mroute: systemPrompt route-hint section')
  }
}
