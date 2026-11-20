/**
 * DecisionRecord JSONL 留痕（FR-E2 最小版，M1）。
 *
 * 每次模型路由查询追加一行到 `~/.dsh/mroute/decisions/decisions-YYYYMM.jsonl`：
 *   { ts, args, top3:[{id, rank, reason_head}], excluded_count, generated_at }
 *
 * 设计纪律：
 * - 追加用 fs/promises appendFile（一行一记录，O_APPEND 原子性对单进程审计够用；
 *   先例 vendors/puppy-bai--dsh-quota-takeover journal.jsonl 追加式审计）。
 * - 目录不存在则 recursive 创建；**写失败静默降级**——console 级日志（logger.warn），
 *   不抛出、不影响查询返回（FR-E2-3 精神；完整 meta 留痕标注属后续里程碑）。
 * - baseDir 可注入（测试用 tmp 目录）；缺省 os.homedir()——本地盘审计账本，
 *   零网络、零凭据内容（args 仅 capability/tier_min 等查询入参）。
 * - 冻结快照语义：记录的是「本次查询的决策输入与 top3 摘要」，不回写注册表、不改写任何请求
 *   （advisory-only：留痕是观察面，不是控制面）。
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { errorMessage } from './errors.js'

/** 生产缺省目录：~/.dsh/mroute/decisions */
export function defaultDecisionsDir() {
  return path.join(os.homedir(), '.dsh', 'mroute', 'decisions')
}

/** 月度文件名戳：本地时区 YYYYMM（如 202611）。 */
export function monthStamp(date = new Date()) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  return `${y}${m}`
}

/** reason_head：reason 头部截断（80 字符上限，超长补省略号），供 JSONL 行保持单行可读。 */
export function reasonHead(reason, max = 80) {
  const s = String(reason ?? '')
  return s.length > max ? s.slice(0, max) + '…' : s
}

/**
 * 追加一条 DecisionRecord。永不抛出：任何失败（mkdir/append）降级为 logger.warn 并返回 false。
 * @param {object} record { ts, args, top3, excluded_count, generated_at }
 * @param {{ baseDir?:string, logger?:object }} [options] baseDir 注入供冒烟测试
 * @returns {Promise<boolean>} 是否成功落盘
 */
export async function appendDecisionRecord(record, options = {}) {
  try {
    const dir = options.baseDir ?? defaultDecisionsDir()
    await fsp.mkdir(dir, { recursive: true })
    const file = path.join(dir, `decisions-${monthStamp()}.jsonl`)
    await fsp.appendFile(file, JSON.stringify(record) + '\n', 'utf8')
    return true
  } catch (error) {
    options.logger?.warn?.(`[mroute] DecisionRecord 落盘失败（静默降级，不影响查询返回）: ${errorMessage(error)}`)
    return false
  }
}
