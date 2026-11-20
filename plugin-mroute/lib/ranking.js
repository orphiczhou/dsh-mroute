/**
 * 排序引擎（MVP = 07 方案 §3.5 三层组合的 L1 静态层 + livecheck 沉底惩罚；L2 账本 mask / L3 感知层不做）。
 * 纯函数：同输入同输出可重放（07 §3.6-S4 确定性验收口径）。
 *
 * 全序键（从主到次）：
 *   1. livecheck unknown 全局沉底（降权不剔除——任务书「标 unknown 降权」的落码）
 *   2. dynamicTight 动态紧张沉底（M4.5：周窗口/余额高水位；只改顺序不剔除不阻断）
 *   3. channel_type 财务一级键 monthly(0) < voucher(1) < prepaid(2)（governor credit_first 改造，07 R14）
 *   4. tier 能力分层 overseas_sota(0) < domestic_sota(1) < bulk(2)（方向为 MVP 落码裁决，见 docs/04-mvp-notes.md §2.1）
 *   5. priority 降序（大者前）
 *   6. id 字典序兜底（全序确定性）
 */
import { errorMessage } from './errors.js'

export const CHANNEL_TYPE_RANK = { monthly: 0, voucher: 1, prepaid: 2 }
export const TIER_RANK = { overseas_sota: 0, domestic_sota: 1, bulk: 2 }

/** 枚举查表统一口径：hasOwnProperty 防原型链键（审计 m-8；本模块唯一实现，tool-query.js 复用）。 */
export const rankOf = (table, value) => (Object.prototype.hasOwnProperty.call(table, value) ? table[value] : 9)

/**
 * @param {Array<object>} channels 已按 readRegistry 形状校验的渠道数组
 * @param {Map<string, { status:'ok'|'unknown', detail:string, availableModels:string[] }>} livecheckById
 * @param {Map<string, { state:'tight'|'hint'|'ok', reasons?:string[] }>} [dynamicById] 动态状态（M4.5；
 *   缺省 undefined → 全部按 ok 处理，既有调用/测试行为不变）
 * @returns {{ ranked:Array<{ channel:object, live:object, dynamic?:object }>, reasonFor:Function }}
 */
export function rankChannels(channels, livecheckById, dynamicById) {
  const entries = channels.map((channel) => ({
    channel,
    live: livecheckById.get(channel.id),
    dynamic: typeof dynamicById?.get === 'function' ? dynamicById.get(channel.id) : undefined,
  }))
  entries.sort((a, b) => {
    const ka = sortKey(a), kb = sortKey(b)
    return (
      ka.unknown - kb.unknown ||
      ka.dynamicTight - kb.dynamicTight ||
      ka.channelType - kb.channelType ||
      ka.tier - kb.tier ||
      ka.priority - kb.priority ||
      (ka.id < kb.id ? -1 : ka.id > kb.id ? 1 : 0)
    )
  })

  const reasonFor = (entry) => {
    const { channel, live, dynamic } = entry
    const unknown = live?.status === 'unknown'
    const parts = []
    if (unknown) {
      parts.push(`provider 活校验 unknown → 全局沉底降权${live.detail ? `（${live.detail}）` : ''}`)
    }
    if (dynamic?.state === 'tight') {
      const detail = Array.isArray(dynamic.reasons) && dynamic.reasons.length > 0
        ? dynamic.reasons.join('；')
        : '动态数据紧张'
      parts.push(`动态紧张 → 沉底（${detail}）`)
    }
    parts.push(`channel_type=${channel.channel_type}（一级键 ${channel.channel_type === 'monthly' ? '包月优先' : channel.channel_type === 'voucher' ? '券次优' : '预充值兜底'}）`)
    parts.push(`tier=${channel.tier}`)
    parts.push(`priority=${channel.priority}${unknown ? '' : '（同类内降序生效）'}`)
    parts.push('id 兜底')
    return parts.join('；')
  }

  return { ranked: entries, reasonFor }
}

function sortKey(entry) {
  const { channel, live, dynamic } = entry
  return {
    unknown: live?.status === 'unknown' ? 1 : 0,
    dynamicTight: dynamic?.state === 'tight' ? 1 : 0,
    channelType: rankOf(CHANNEL_TYPE_RANK, channel.channel_type),
    tier: rankOf(TIER_RANK, channel.tier),
    priority: -(Number(channel.priority) || 0),
    id: String(channel.id ?? ''),
  }
}

/** 活校验全部渠道（并发，单渠道失败只降级该渠道）。 */
export async function livecheckAll(livecheck, channels, logger) {
  const byId = new Map()
  await Promise.all(channels.map(async (channel) => {
    try {
      byId.set(channel.id, await livecheck.check(channel.routeProvider))
    } catch (error) {
      // check 内部已兜底；此层防御注册表读侧意外
      logger?.warn?.(`[mroute] 活校验意外失败 ${channel.id}: ${errorMessage(error)}`)
      byId.set(channel.id, { status: 'unknown', detail: `活校验意外失败: ${errorMessage(error)}`, availableModels: [] })
    }
  }))
  return byId
}
