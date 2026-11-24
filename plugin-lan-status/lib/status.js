/**
 * Pure status builders for the LAN status panel.
 *
 * A node either acts as an agent (`role: agent`, serves `/self`) or as the
 * coordinator (`role: coordinator`, serves `/status` by polling every agent).
 * No DSH internals are mutated here: sessions come from `ctx.agents.list()`,
 * task rows are read from the coordinator's scheduler ledger, and every other
 * node property is local `node:os` data or static deployment config.
 */
import fs from 'node:fs'
import os from 'node:os'

import { collectSystem } from './system.js'

export const RUNNING_STATES = new Set(['queued', 'dispatching', 'running'])
export const TERMINAL_STATES = new Set(['succeeded', 'failed', 'cancelled'])

export const DEFAULT_NODES = [
  { instanceId: 'dsh-a', label: 'dsh-a', role: 'coordinator', origin: 'http://192.168.3.23:3081', entryUrl: 'http://192.168.3.23:3095', agentUrl: 'http://192.168.3.23:3091' },
  { instanceId: 'dsh-b', label: 'dsh-b', role: 'agent', origin: 'http://192.168.3.23:3082', entryUrl: 'http://192.168.3.23:3096', agentUrl: 'http://192.168.3.23:3092' },
  { instanceId: 'dsh-c', label: 'dsh-c', role: 'agent', origin: 'http://192.168.3.21:3081', entryUrl: 'http://192.168.3.21:3095', agentUrl: 'http://192.168.3.21:3091' },
  { instanceId: 'dsh-d', label: 'dsh-d', role: 'agent', origin: 'http://192.168.3.24:3081', entryUrl: 'http://192.168.3.24:3095', agentUrl: 'http://192.168.3.24:3091' },
]

function collator(a, b) {
  return String(a ?? '').localeCompare(String(b ?? ''), 'en')
}

function isoTime(value) {
  if (typeof value !== 'string' || value === '') return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null
}

function truncate(value, max) {
  const text = typeof value === 'string' ? value : value == null ? '' : String(value)
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text
}

/**
 * Read the coordinator's scheduler ledger. A missing or malformed ledger is a
 * normal degraded state for the panel, never a reason to fail the HTTP route.
 * @param {string} file - absolute state.json path.
 * @param {{warn?: (message: string) => void}} [logger]
 * @returns {object|null}
 */
export function readSchedulerState(file, logger) {
  if (typeof file !== 'string' || file.trim() === '') return null
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch (error) {
    if (error?.code !== 'ENOENT') logger?.warn?.(`[lan-status] scheduler ledger unreadable: ${error.message}`)
    return null
  }
}

/**
 * Normalize one scheduler task into the small, read-only panel row.
 * @param {object} task
 */
export function taskRow(task) {
  const result = task?.result && typeof task.result === 'object' ? task.result : {}
  return {
    id: String(task?.id ?? ''),
    title: truncate(task?.title ?? '(untitled)', 120),
    status: String(task?.status ?? 'unknown'),
    workerId: task?.workerId ?? null,
    instanceId: task?.instanceId ?? task?.targetInstanceId ?? null,
    attempts: Number.isFinite(task?.attempts) ? task.attempts : 0,
    maxAttempts: Number.isFinite(task?.maxAttempts) ? task.maxAttempts : null,
    createdAt: isoTime(task?.createdAt),
    updatedAt: isoTime(task?.updatedAt),
    finishedAt: isoTime(task?.finishedAt),
    lastError: task?.lastError ? truncate(task.lastError, 240) : null,
    summary: result.summary ? truncate(result.summary, 240) : null,
  }
}

/**
 * Build the task section of a self status.
 * @param {object|null} state
 */
export function taskSection(state) {
  const all = state && state.tasks && typeof state.tasks === 'object' ? Object.values(state.tasks) : []
  const rows = all.filter((task) => task && typeof task === 'object').map(taskRow)
  const running = rows
    .filter((row) => RUNNING_STATES.has(row.status))
    .sort((a, b) => collator(b.createdAt, a.createdAt))
  const recent = rows
    .filter((row) => TERMINAL_STATES.has(row.status))
    .sort((a, b) => collator(b.updatedAt ?? b.createdAt, a.updatedAt ?? a.createdAt))
    .slice(0, 12)
  const counts = {}
  for (const row of rows) counts[row.status] = (counts[row.status] || 0) + 1
  return {
    stateFile: typeof state?.stateFile === 'string' ? state.stateFile : undefined,
    seq: Number.isFinite(state?.seq) ? state.seq : 0,
    total: rows.length,
    counts,
    running,
    recent,
  }
}

/**
 * Best-effort title for a live DSH agent. The projection is optional; a
 * missing projection only loses the display title, never the row.
 * @param {object} ctx
 * @param {object} agent
 */
export function sessionTitle(ctx, agent) {
  try {
    const snapshot = ctx?.get?.('sessionProjections')?.snapshot?.(agent?.session)
    const title = snapshot?.values?.title
    return typeof title === 'string' && title !== '' ? truncate(title, 160) : null
  } catch {
    return null
  }
}

/**
 * Summarize the live sessions owned by this DSH host.
 * @param {object} ctx
 */
export function sessionRows(ctx) {
  let agents = []
  try {
    agents = typeof ctx?.agents?.list === 'function' ? ctx.agents.list() : []
  } catch {
    agents = []
  }
  return agents
    .filter((agent) => agent && typeof agent === 'object')
    .map((agent) => {
      const session = agent.session && typeof agent.session === 'object' ? agent.session : {}
      return {
        sessionId: String(agent.id ?? session.id ?? ''),
        title: sessionTitle(ctx, agent),
        status: typeof agent.status === 'string' ? agent.status : 'unknown',
        cwd: typeof session.cwd === 'string' ? session.cwd : null,
      }
    })
    .filter((row) => row.sessionId !== '')
    .sort((a, b) => collator(a.sessionId, b.sessionId))
}

/**
 * Build this node's `/self` payload.
 * @param {object} options
 */
export function buildSelfStatus({ ctx, config = {}, logger, startedAt = null } = {}) {
  const system = collectSystem({ diskPath: config.diskPath })
  const stateFile = config.schedulerStateFile || config.stateFile || ''
  const state = readSchedulerState(stateFile, logger)
  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    node: {
      instanceId: String(config.instanceId || 'dsh'),
      label: String(config.label || config.instanceId || 'dsh'),
      role: config.role === 'coordinator' ? 'coordinator' : 'agent',
      origin: typeof config.origin === 'string' ? config.origin : null,
      entryUrl: typeof config.entryUrl === 'string' ? config.entryUrl : null,
      agentUrl: typeof config.agentUrl === 'string' ? config.agentUrl : null,
      hostname: system.hostname,
      platform: system.platform,
      arch: system.arch,
      osRelease: system.osRelease,
      nodeVersion: system.nodeVersion,
      dshVersion: typeof config.dshVersion === 'string' ? config.dshVersion : '',
      pid: system.pid,
      uptimeSec: system.processUptimeSec,
      hostUptimeSec: system.uptimeSec,
      startedAt: startedAt || null,
    },
    system,
    sessions: sessionRows(ctx),
    tasks: taskSection(state),
  }
}

/**
 * The configured node list, with safe defaults. Exported for the `/open/:id`
 * redirect route so it only ever redirects to a configured DSH origin.
 * @param {object} config
 */
export function configuredNodes(config = {}) {
  if (Array.isArray(config.nodes) && config.nodes.length > 0) {
    return config.nodes
      .filter((row) => row && typeof row.instanceId === 'string' && row.instanceId !== '')
      .map((row) => ({
        instanceId: row.instanceId,
        label: typeof row.label === 'string' ? row.label : row.instanceId,
        role: row.role === 'coordinator' ? 'coordinator' : 'agent',
        origin: typeof row.origin === 'string' ? row.origin : null,
        entryUrl: typeof row.entryUrl === 'string' ? row.entryUrl : null,
        agentUrl: typeof row.agentUrl === 'string' ? row.agentUrl : null,
      }))
  }
  return DEFAULT_NODES
}

function sourceNodes(config) {
  return configuredNodes(config)
}

async function fetchSelf(node, timeoutMs) {
  const started = Date.now()
  if (!node.agentUrl) {
    return { ...node, online: false, latencyMs: null, error: 'agentUrl missing' }
  }
  const url = `${node.agentUrl.replace(/\/$/, '')}/self`
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: 'application/json' },
    })
    const latencyMs = Date.now() - started
    if (!response.ok) {
      return { ...node, agentUrl: node.agentUrl, online: false, latencyMs, error: `HTTP ${response.status}` }
    }
    const body = await response.json()
    const data = body && typeof body === 'object' ? body : {}
    const live = data.node && typeof data.node === 'object' ? data.node : {}
    return {
      ...node,
      ...live,
      instanceId: node.instanceId,
      label: node.label,
      role: node.role,
      origin: node.origin || live.origin || null,
      entryUrl: node.entryUrl || live.entryUrl || null,
      agentUrl: node.agentUrl,
      online: true,
      latencyMs,
      generatedAt: data.generatedAt ?? null,
      system: data.system && typeof data.system === 'object' ? data.system : null,
      sessions: Array.isArray(data.sessions) ? data.sessions : [],
      tasks: data.tasks && typeof data.tasks === 'object' ? data.tasks : taskSection(null),
    }
  } catch (error) {
    const latencyMs = Date.now() - started
    return {
      ...node,
      online: false,
      latencyMs,
      error: error?.name === 'TimeoutError' ? 'timeout' : String(error?.message || error),
    }
  }
}

/**
 * Build the coordinator's aggregate payload. The local node is answered from
 * `self` so the coordinator never recursively polls its own `/status` route.
 * @param {object} options
 */
export async function buildAggregateStatus({ ctx, config = {}, self, logger, startedAt = null, fetcher = fetchSelf } = {}) {
  const timeoutMs = Number(config.requestTimeoutMs) > 0 ? Number(config.requestTimeoutMs) : 2500
  const nodes = sourceNodes(config)
  const rows = await Promise.all(
    nodes.map(async (node) => {
      if (node.instanceId === self?.node?.instanceId) {
        return {
          ...node,
          ...self.node,
          instanceId: node.instanceId,
          label: node.label,
          role: node.role,
          origin: node.origin || self.node.origin || null,
          entryUrl: node.entryUrl || self.node.entryUrl || null,
          agentUrl: node.agentUrl || self.node.agentUrl || null,
          online: true,
          latencyMs: 0,
          generatedAt: self.generatedAt,
          system: self.system && typeof self.system === 'object' ? self.system : null,
          sessions: self.sessions,
          tasks: self.tasks,
        }
      }
      return fetcher(node, timeoutMs)
    }),
  )
  const online = rows.filter((row) => row.online)
  const sessions = rows.flatMap((row) => (row.online ? row.sessions || [] : []).map((session) => ({ ...session, instanceId: row.instanceId })))
  const running = rows
    .flatMap((row) => (row.online ? (row.tasks?.running || []) : []).map((task) => ({ ...task, coordinator: row.instanceId })))
    .sort((a, b) => collator(b.createdAt, a.createdAt))
  const recent = rows
    .flatMap((row) => (row.online ? (row.tasks?.recent || []) : []).map((task) => ({ ...task, coordinator: row.instanceId })))
    .sort((a, b) => collator(b.updatedAt ?? b.createdAt, a.updatedAt ?? a.createdAt))
    .slice(0, 20)
  const totalTasks = rows.reduce((sum, row) => sum + (Number.isFinite(row.tasks?.total) ? row.tasks.total : 0), 0)
  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    startedAt: startedAt || self?.node?.startedAt || null,
    coordinator: self?.node?.instanceId ?? null,
    panelTitle: typeof config.panelTitle === 'string' && config.panelTitle !== '' ? config.panelTitle : null,
    summary: {
      nodes: rows.length,
      online: online.length,
      offline: rows.length - online.length,
      sessions: sessions.length,
      runningTasks: running.length,
      totalTasks,
    },
    nodes: rows.sort((a, b) => collator(a.instanceId, b.instanceId)),
    sessions: sessions.sort((a, b) => collator(a.instanceId, b.instanceId) || collator(a.sessionId, b.sessionId)),
    tasks: { running, recent },
  }
}

function esc(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

const PANEL_UI_PATH = new URL('./ui.html', import.meta.url)
let panelUiCache = null

/**
 * Read the standalone panel template. The template is static; per-request
 * values are injected as escaped text placeholders, never as raw HTML.
 * @param {{panelTitle?: string, coordinator?: string}} [options]
 */
export function renderPanelHtml({ panelTitle = 'LAN DSH · 节点状态', coordinator = 'dsh-a' } = {}) {
  if (panelUiCache == null) panelUiCache = fs.readFileSync(PANEL_UI_PATH, 'utf8')
  return panelUiCache
    .replaceAll('__PANEL_TITLE__', esc(panelTitle || 'LAN DSH · 节点状态'))
    .replaceAll('__COORDINATOR__', esc(coordinator || 'dsh-a'))
}

/**
 * Standalone panel. It intentionally uses only inline CSS/JS so the page has
 * no build step and no dependency on the DSH client graph.
 */
export function renderHtml() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>LAN DSH · 节点状态</title>
<style>
:root { color-scheme: light dark; --bg:#f6f7f9; --card:#fff; --ink:#17202a; --muted:#667085; --line:#e4e7ec; --ok:#12805c; --warn:#b54708; --err:#b42318; --accent:#2f6fed; }
@media (prefers-color-scheme: dark) { :root { --bg:#11151c; --card:#171d26; --ink:#e7ecf3; --muted:#98a2b3; --line:#2a3342; --ok:#32d583; --warn:#fdb022; --err:#f97066; --accent:#84adff; } }
* { box-sizing:border-box; }
body { margin:0; padding:24px; background:var(--bg); color:var(--ink); font:14px/1.45 ui-sans-serif,system-ui,"Segoe UI",Roboto,"Noto Sans SC",sans-serif; }
header { display:flex; flex-wrap:wrap; align-items:flex-end; gap:12px 20px; margin-bottom:18px; }
h1 { margin:0; font-size:22px; letter-spacing:.2px; }
h2 { margin:0 0 10px; font-size:15px; }
.sub { color:var(--muted); font-size:12px; }
button { border:1px solid var(--line); background:var(--card); color:var(--ink); border-radius:8px; padding:7px 12px; cursor:pointer; font:inherit; }
button:hover { border-color:var(--accent); }
.summary { display:flex; flex-wrap:wrap; gap:8px; margin:0 0 18px; }
.chip { background:var(--card); border:1px solid var(--line); border-radius:999px; padding:5px 10px; color:var(--muted); }
.chip b { color:var(--ink); }
.card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:14px; margin-bottom:16px; overflow:auto; }
table { width:100%; border-collapse:collapse; min-width:760px; }
th, td { text-align:left; padding:8px 10px; border-bottom:1px solid var(--line); vertical-align:top; white-space:nowrap; }
th { color:var(--muted); font-weight:600; font-size:12px; text-transform:uppercase; letter-spacing:.04em; }
td.wrap, th.wrap { white-space:normal; min-width:220px; }
tr:last-child td { border-bottom:0; }
.dot { display:inline-block; width:8px; height:8px; border-radius:50%; margin-right:7px; background:var(--muted); }
.dot.ok { background:var(--ok); } .dot.bad { background:var(--err); } .dot.warn { background:var(--warn); }
.pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:1px 8px; font-size:12px; }
.pill.running { color:var(--warn); } .pill.succeeded { color:var(--ok); } .pill.failed, .pill.cancelled { color:var(--err); }
.mono { font-family:ui-monospace,SFMono-Regular,Consolas,monospace; font-size:12px; }
a { color:var(--accent); text-decoration:none; } a:hover { text-decoration:underline; }
.muted { color:var(--muted); }
.error { border:1px solid var(--err); color:var(--err); background:transparent; border-radius:10px; padding:10px 12px; margin-bottom:14px; }
.empty { color:var(--muted); padding:10px 0; }
</style>
</head>
<body>
<header>
  <div style="flex:1 1 320px">
    <h1>LAN DSH · 节点状态</h1>
    <div class="sub" id="stamp">加载中…</div>
  </div>
  <div style="display:flex;gap:8px;align-items:center">
    <span class="sub" id="coordinator"></span>
    <button id="refresh" type="button">刷新</button>
  </div>
</header>
<div id="error"></div>
<div class="summary" id="summary"></div>
<section class="card"><h2>节点</h2><div id="nodes"></div></section>
<section class="card"><h2>运行中的任务</h2><div id="running"></div></section>
<section class="card"><h2>最近的完成/失败</h2><div id="recent"></div></section>
<section class="card"><h2>会话</h2><div id="sessions"></div></section>
<script>
const $ = (id) => document.getElementById(id)
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'class') node.className = value
    else if (key === 'text') node.textContent = value
    else if (key === 'href') node.setAttribute('href', value)
    else if (key === 'title') node.setAttribute('title', value)
  }
  for (const child of children) if (child != null) node.append(child)
  return node
}
function pill(status) { return el('span', { class: 'pill ' + (status || ''), text: status || 'unknown' }) }
function table(headers, rows) {
  if (!rows.length) return el('div', { class: 'empty', text: '暂无数据' })
  const thead = el('thead', {}, el('tr', {}, ...headers.map(h => el('th', { class: h.wrap ? 'wrap' : '', text: h.label }))))
  const tbody = el('tbody', {})
  for (const row of rows) {
    const tr = el('tr', {})
    for (const h of headers) {
      const td = el('td', { class: h.wrap ? 'wrap' : '' })
      const value = h.render ? h.render(row) : row[h.key]
      if (value instanceof Node) td.append(value)
      else td.textContent = value == null ? '—' : String(value)
      tr.append(td)
    }
    tbody.append(tr)
  }
  return el('table', {}, thead, tbody)
}
function nodeCell(n) {
  const dot = el('span', { class: 'dot ' + (n.online ? 'ok' : 'bad') })
  return el('span', {}, dot, el('b', { text: n.label || n.instanceId }), el('span', { class: 'muted', text: '  ' + n.instanceId }))
}
function originCell(n) {
  if (!n.origin) return '—'
  return el('a', { href: n.origin, title: '入口地址；打开需要该节点的 launch token', text: n.origin, target: '_blank', rel: 'noreferrer' })
}
function nodeStatus(n) {
  if (n.online) return n.role === 'coordinator' ? 'coordinator' : 'online'
  return n.error ? 'offline · ' + n.error : 'offline'
}
function render(data) {
  $('error').replaceChildren()
  const s = data.summary || {}
  $('stamp').textContent = '最后刷新 ' + new Date(data.generatedAt).toLocaleString() + ' · 数据源只读'
  $('coordinator').textContent = data.coordinator ? '协调者 ' + data.coordinator : ''
  $('summary').replaceChildren(
    el('span', { class: 'chip' }, '节点 ', el('b', { text: s.online + '/' + s.nodes })),
    el('span', { class: 'chip' }, '会话 ', el('b', { text: s.sessions })),
    el('span', { class: 'chip' }, '运行任务 ', el('b', { text: s.runningTasks })),
    el('span', { class: 'chip' }, '离线 ', el('b', { text: s.offline })),
  )
  $('nodes').replaceChildren(table([
    { label: '状态', render: nodeCell },
    { label: '角色', render: n => n.role || '—' },
    { label: '主机', render: n => [n.hostname, n.osRelease, n.arch].filter(Boolean).join(' · ') || '—', wrap: true },
    { label: 'DSH', render: n => n.dshVersion || '—' },
    { label: '入口地址', render: originCell, wrap: true },
    { label: '延迟', render: n => n.latencyMs == null ? '—' : n.latencyMs + ' ms' },
    { label: '会话', render: n => String((n.sessions || []).length) },
    { label: '运行任务', render: n => String((n.tasks && n.tasks.running || []).length) },
    { label: '链路', render: n => n.online ? 'up' : (n.error || 'down') },
  ], data.nodes || []))
  $('running').replaceChildren(table([
    { label: '任务', render: t => el('span', { class: 'mono', text: t.id }) },
    { label: '标题', key: 'title', wrap: true },
    { label: '状态', render: t => pill(t.status) },
    { label: 'worker', render: t => t.workerId || '—' },
    { label: '节点', key: 'instanceId' },
    { label: '尝试', key: 'attempts' },
    { label: '开始', render: t => t.createdAt ? new Date(t.createdAt).toLocaleString() : '—' },
  ], data.tasks && data.tasks.running || []))
  $('recent').replaceChildren(table([
    { label: '任务', render: t => el('span', { class: 'mono', text: t.id }) },
    { label: '标题', key: 'title', wrap: true },
    { label: '状态', render: t => pill(t.status) },
    { label: '结果', render: t => t.summary || t.lastError || '—', wrap: true },
    { label: '完成', render: t => t.finishedAt ? new Date(t.finishedAt).toLocaleString() : '—' },
  ], data.tasks && data.tasks.recent || []))
  $('sessions').replaceChildren(table([
    { label: '节点', key: 'instanceId' },
    { label: '会话', render: s => el('span', { class: 'mono', text: s.sessionId }) },
    { label: '标题', key: 'title', wrap: true },
    { label: '状态', render: s => pill(s.status) },
    { label: 'cwd', render: s => s.cwd || '—', wrap: true },
  ], data.sessions || []))
}
async function load() {
  const button = $('refresh'); button.disabled = true
  try {
    const response = await fetch('/status', { cache: 'no-store', headers: { accept: 'application/json' } })
    if (!response.ok) throw new Error('HTTP ' + response.status)
    render(await response.json())
  } catch (error) {
    $('stamp').textContent = '刷新失败'
    $('error').replaceChildren(el('div', { class: 'error', text: '无法读取 /status：' + (error && error.message || error) }))
  } finally { button.disabled = false }
}
$('refresh').addEventListener('click', load)
load()
setInterval(() => { if (!document.hidden) load() }, 5000)
</script>
</body>
</html>`
}
