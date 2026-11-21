/**
 * M5 存储层 —— 评测证据落盘（计划 §7）。
 *
 * `<DSH_HOME>/mroute/eval-history/<run_id>.jsonl`：
 *   - **一行 = 一次真实模型调用**（status=invalid 的失败调用也算一次；skipped 不写）。
 *   - 追加写（appendFile，单进程串行，行序即调用序）；写失败静默降级为 logger.warn，
 *     不阻断本轮已有结果的返回（与 lib/decision-log.js 同一纪律）。
 * `<run_id>.summary.json`：本轮聚合摘要（原子写：临时文件 + rename），供人工/后续面板读，
 *   不是权威面（权威面是 Config.model_eval + eval_status）。
 *
 * 目录约定：与 decision-log.js 一致走 `~/.dsh/mroute/...`；baseDir/homedir 可注入便于自检。
 * 纪律：只写本地盘、零网络、零凭据；run_id 由时间戳+随机尾巴构成，不接受外部路径拼接。
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { errorMessage } from '../errors.js'

/** 目录缺省值：~/.dsh/mroute/eval-history（DSH_HOME 缺省即 ~/.dsh，与 decision-log 同根）。 */
export function defaultEvalHistoryDir(home = os.homedir()) {
  return path.join(home, '.dsh', 'mroute', 'eval-history')
}

/** run_id：本地时间戳 + 4 位随机十六进制（排序友好、可读、无路径分隔符）。 */
export function makeRunId(date = new Date(), rand = Math.random) {
  const pad = (value) => String(value).padStart(2, '0')
  const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  const tail = Math.floor(rand() * 0x10000).toString(16).padStart(4, '0')
  return `eval-${stamp}-${tail}`
}

/** run_id 合法性（防路径穿越；只允许 [A-Za-z0-9._-]，且不接受 . / .. 段）。 */
export function isSafeRunId(runId) {
  if (typeof runId !== 'string' || runId.length === 0 || runId.length > 96) return false
  if (!/^[A-Za-z0-9._-]+$/.test(runId)) return false
  return runId !== '.' && runId !== '..' && !runId.includes('..')
}

export function evalJsonlPath(dir, runId) {
  if (!isSafeRunId(runId)) throw new Error(`run_id 非法：${String(runId)}`)
  return path.join(dir, `${runId}.jsonl`)
}

export function evalSummaryPath(dir, runId) {
  if (!isSafeRunId(runId)) throw new Error(`run_id 非法：${String(runId)}`)
  return path.join(dir, `${runId}.summary.json`)
}

/**
 * 创建一轮的追加器（懒创建目录：只有真的发生调用才落盘，dry_run 零痕迹）。
 * @param {{ dir?:string, runId:string, logger?:object }} options
 */
export function createEvalRecorder({ dir = defaultEvalHistoryDir(), runId, logger } = {}) {
  const file = evalJsonlPath(dir, runId)
  let prepared = false
  let failed = false
  return {
    file,
    /** 追加一行（record 已是 JSON 可序列化对象）。永不抛。 */
    async append(record) {
      if (failed) return false
      try {
        if (!prepared) {
          await fsp.mkdir(dir, { recursive: true })
          prepared = true
        }
        await fsp.appendFile(file, JSON.stringify(record) + '\n', 'utf8')
        return true
      } catch (error) {
        failed = true
        logger?.warn?.(`[mroute] eval JSONL 落盘失败（静默降级）: ${errorMessage(error)}`)
        return false
      }
    },
  }
}

/** 原子写摘要 JSON：临时文件 + rename（同目录，避免跨盘 rename 失败）。永不抛。 */
export async function writeRunSummary({ dir = defaultEvalHistoryDir(), runId, summary, logger } = {}) {
  let tmp = ''
  try {
    await fsp.mkdir(dir, { recursive: true })
    const target = evalSummaryPath(dir, runId)
    tmp = `${target}.tmp-${process.pid}-${Date.now()}`
    await fsp.writeFile(tmp, JSON.stringify(summary, null, 2) + '\n', 'utf8')
    await fsp.rename(tmp, target)
    return target
  } catch (error) {
    logger?.warn?.(`[mroute] eval 摘要写盘失败（静默降级）: ${errorMessage(error)}`)
    if (tmp !== '') await fsp.rm(tmp, { force: true }).catch(() => {})
    return ''
  }
}

/** 读回一轮 JSONL（坏行跳过并计数；供自检/复核，不在工具热路径上）。 */
export async function readEvalRecords(file) {
  const text = await fsp.readFile(file, 'utf8')
  const records = []
  const badLines = []
  for (const [index, line] of text.split('\n').entries()) {
    if (line.trim() === '') continue
    try {
      records.push(JSON.parse(line))
    } catch {
      badLines.push(index + 1)
    }
  }
  return { records, badLines }
}

/** 本地日期戳 YYYYMMDD（日预算按本地日切）。 */
export function dayStamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
}

/**
 * 当日已发生的调用数（预算由 tool-eval-run.DAILY_CALL_BUDGET 决定：常规 300，2026-11-21 一次性 400）。
 * 口径 = eval-history 下今天改动过的 *.jsonl 的非空行数之和（一行 = 一次真实调用）；
 * 读失败的文件跳过（宁可少算也不因历史坏文件拒绝本次评测——拒绝路径另有 dry_run 兜底）。
 * @returns {Promise<{ count:number, files:string[], day:string }>}
 */
export async function countCallsToday({ dir = defaultEvalHistoryDir(), now = new Date(), logger } = {}) {
  const day = dayStamp(now)
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const result = { count: 0, files: [], day }
  let entries = []
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch {
    return result // 目录还不存在 = 今天没有调用
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
    const file = path.join(dir, entry.name)
    try {
      const stat = await fsp.stat(file)
      if (stat.mtimeMs < start) continue
      const text = await fsp.readFile(file, 'utf8')
      let lines = 0
      for (const line of text.split('\n')) if (line.trim() !== '') lines += 1
      result.count += lines
      result.files.push(entry.name)
    } catch (error) {
      logger?.warn?.(`[mroute] eval 日预算统计跳过 ${entry.name}: ${errorMessage(error)}`)
    }
  }
  return result
}
