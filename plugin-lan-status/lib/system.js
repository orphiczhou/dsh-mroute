/**
 * Lightweight, dependency-free host metrics for the status panel.
 *
 * The panel is intentionally a snapshot service: CPU usage needs two samples,
 * so the first `/self` call returns `null` and subsequent calls return the
 * delta since the previous call. All other values are cheap synchronous reads.
 */
import fs from 'node:fs'
import os from 'node:os'

let lastCpu = null

function cpuTimes() {
  let idle = 0
  let total = 0
  for (const cpu of os.cpus()) {
    for (const value of Object.values(cpu.times || {})) total += Number(value) || 0
    idle += Number(cpu.times?.idle) || 0
  }
  return { idle, total }
}

/** CPU busy percentage since the previous call, or null on the first call. */
export function cpuPercent() {
  const now = cpuTimes()
  let value = null
  if (lastCpu && now.total > lastCpu.total) {
    const total = now.total - lastCpu.total
    const idle = now.idle - lastCpu.idle
    value = Math.max(0, Math.min(100, Math.round(((total - idle) / total) * 1000) / 10))
  }
  lastCpu = now
  return value
}

function statfs(path) {
  try {
    const stats = fs.statfsSync(path)
    const blockSize = Number(stats.bsize) || 0
    const total = blockSize * (Number(stats.blocks) || 0)
    const free = blockSize * (Number(stats.bavail ?? stats.bfree) || 0)
    if (!Number.isFinite(total) || total <= 0) return null
    return {
      path,
      total,
      free,
      usedPct: Math.round(((total - free) / total) * 1000) / 10,
    }
  } catch {
    return null
  }
}

function defaultDiskPath() {
  return process.platform === 'win32' ? 'C:\\' : '/'
}

/**
 * Collect one node's host metrics.
 * @param {{diskPath?: string}} [options]
 */
export function collectSystem({ diskPath } = {}) {
  const cpus = os.cpus()
  const totalMem = os.totalmem()
  const freeMem = os.freemem()
  const load = os.loadavg()
  const disk = statfs(diskPath || defaultDiskPath())
  return {
    sampledAt: new Date().toISOString(),
    hostname: os.hostname(),
    platform: os.platform(),
    arch: os.arch(),
    osRelease: os.version?.() || os.release(),
    cpuModel: cpus[0]?.model ? String(cpus[0].model).replace(/\s+/g, ' ').trim() : null,
    cores: cpus.length,
    cpuPct: cpuPercent(),
    load1: Number.isFinite(load[0]) ? Math.round(load[0] * 100) / 100 : null,
    load5: Number.isFinite(load[1]) ? Math.round(load[1] * 100) / 100 : null,
    load15: Number.isFinite(load[2]) ? Math.round(load[2] * 100) / 100 : null,
    memTotal: totalMem,
    memFree: freeMem,
    memUsedPct: totalMem > 0 ? Math.round(((totalMem - freeMem) / totalMem) * 1000) / 10 : null,
    disk,
    uptimeSec: Math.round(os.uptime()),
    processUptimeSec: Math.round(process.uptime()),
    nodeVersion: process.version,
    pid: process.pid,
  }
}
