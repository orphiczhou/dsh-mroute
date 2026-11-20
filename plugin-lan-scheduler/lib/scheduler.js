/**
 * LanScheduler — thin, durable task ledger + dispatcher for DSH instances
 * connected by dsh-interconnect.
 *
 * Design constraints:
 * - No queue server, no database, no third-party dependency.
 * - The append-only journal is the source of truth; state.json is a derived
 *   cache. Every mutation is journaled (and fsynced) before it is applied.
 * - Delivery is at-least-once: a dispatch is retried when the transport fails
 *   or the lease expires; the worker reply is the authoritative completion.
 * - No model calls and no shell execution happen here.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled'])
const ACTIVE = new Set(['dispatching', 'running'])
const STATUSES = new Set(['queued', 'dispatching', 'running', 'succeeded', 'failed', 'cancelled'])
const DEFAULT_LEASE_MS = 30 * 60 * 1000
const DEFAULT_MAX_ATTEMPTS = 3
const DEFAULT_DISPATCH_TIMEOUT_MS = 15_000
const MAX_PROMPT_BYTES = 256 * 1024
const MAX_REPLY_BYTES = 1024 * 1024
const MAX_SUMMARY_BYTES = 16 * 1024
const MAX_FILES = 100
const AUDIT_LIMIT = 300
const JOURNAL_VERSION = 1

function iso() {
  return new Date().toISOString()
}

function asString(value, fallback = '') {
  return typeof value === 'string' ? value : fallback
}

function asNumber(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function byteLength(value) {
  return Buffer.byteLength(String(value ?? ''), 'utf8')
}

function truncateUtf8(value, maxBytes) {
  const text = String(value ?? '')
  const buf = Buffer.from(text, 'utf8')
  if (buf.length <= maxBytes) return text
  return buf.subarray(0, maxBytes).toString('utf8').replace(/\uFFFD+$/u, '')
}

function normalizeFiles(value) {
  if (!Array.isArray(value)) return []
  return value.filter((item) => typeof item === 'string' && item.trim() !== '').slice(0, MAX_FILES)
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`
  const keys = Object.keys(value).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex')
}

function emptyState() {
  return { version: 2, seq: 0, workers: [], tasks: {}, audit: [] }
}

function normalizeState(parsed) {
  const state = {
    version: 2,
    seq: asNumber(parsed?.seq, 0),
    workers: Array.isArray(parsed?.workers) ? parsed.workers : [],
    tasks: parsed?.tasks && typeof parsed.tasks === 'object' && !Array.isArray(parsed.tasks) ? parsed.tasks : {},
    audit: Array.isArray(parsed?.audit) ? parsed.audit.slice(-AUDIT_LIMIT) : [],
  }
  for (const task of Object.values(state.tasks)) {
    if (!STATUSES.has(task.status)) task.status = 'queued'
    task.attempts = asNumber(task.attempts, 0)
    task.maxAttempts = asNumber(task.maxAttempts, DEFAULT_MAX_ATTEMPTS)
    task.leaseToken = typeof task.leaseToken === 'string' ? task.leaseToken : null
    task.files = normalizeFiles(task.files)
  }
  return state
}

/**
 * Extract the first balanced JSON object from arbitrary worker reply text.
 * Tolerates markdown fences and a short human preamble.
 */
export function extractJsonObject(text) {
  const source = String(text ?? '')
  let start = source.indexOf('{')
  while (start !== -1) {
    let depth = 0
    let inString = false
    let escaped = false
    for (let i = start; i < source.length; i += 1) {
      const ch = source[i]
      if (inString) {
        if (escaped) {
          escaped = false
        } else if (ch === '\\') {
          escaped = true
        } else if (ch === '"') {
          inString = false
        }
        continue
      }
      if (ch === '"') {
        inString = true
      } else if (ch === '{') {
        depth += 1
      } else if (ch === '}') {
        depth -= 1
        if (depth === 0) {
          try {
            const parsed = JSON.parse(source.slice(start, i + 1))
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
          } catch {
            // Try the next opening brace.
          }
          break
        }
      }
    }
    start = source.indexOf('{', start + 1)
  }
  return null
}

export function buildTaskMessage(task) {
  const meta = {
    task_id: task.id,
    title: task.title,
    priority: task.priority,
    attempt: task.attempts,
    lease_token: task.leaseToken,
    owner_instance: task.ownerInstanceId,
    owner_session: task.ownerSessionId,
  }
  return [
    '[LAN-SCHED TASK v1]',
    JSON.stringify(meta, null, 2),
    '',
    'You are a worker in a LAN DSH scheduler. Execute the task below with your own tools.',
    'When finished, call interconnect_reply EXACTLY ONCE with a single JSON object as the entire reply text:',
    '{"task_id":"' + task.id + '","attempt":' + task.attempts + ',"lease_token":"' + String(task.leaseToken ?? '') + '","status":"succeeded","summary":"what you did","files":[],"error":null}',
    'Use status "failed" and put the reason in "error" if you cannot complete it.',
    'Do not call wait_agent. Do not send multiple replies. Do not wrap the JSON in prose.',
    '',
    '--- TASK ---',
    task.prompt,
  ].join('\n')
}

function auditEntry(event) {
  const entry = { at: event.at, type: event.type }
  for (const key of ['taskId', 'workerId', 'instanceId', 'attempt', 'reason', 'delivery']) {
    if (event[key] !== undefined && event[key] !== null) entry[key] = event[key]
  }
  return entry
}

function pushAudit(state, event) {
  if (event.type === 'snapshot') return
  state.audit.push(auditEntry(event))
  if (state.audit.length > AUDIT_LIMIT) state.audit.splice(0, state.audit.length - AUDIT_LIMIT)
}

function activeTasksFor(state, workerId) {
  return Object.values(state.tasks).filter(
    (task) => task.workerId === workerId && (ACTIVE.has(task.status) || task.status === 'queued'),
  )
}

function freeWorkerIfIdle(state, workerId) {
  const worker = state.workers.find((w) => w.id === workerId)
  if (!worker) return
  const active = activeTasksFor(state, workerId).filter((task) => ACTIVE.has(task.status))
  if (active.length === 0) {
    worker.status = 'idle'
    worker.currentTaskId = null
  }
}

/**
 * Apply one journal event to a state object. This function is used both by
 * live commits and by replay, so replay cannot drift from live behavior.
 */
function applyEvent(state, event) {
  switch (event.type) {
    case 'snapshot': {
      const snapshot = normalizeState(event.state)
      state.version = snapshot.version
      state.seq = snapshot.seq
      state.workers = snapshot.workers
      state.tasks = snapshot.tasks
      state.audit = snapshot.audit
      return state
    }
    case 'worker-registered':
    case 'worker-updated': {
      const worker = event.worker
      if (!worker) break
      const existing = state.workers.find((w) => w.id === worker.id || (w.instanceId === worker.instanceId && w.sessionId === worker.sessionId))
      if (existing) Object.assign(existing, worker)
      else state.workers.push({ ...worker })
      break
    }
    case 'worker-removed': {
      state.workers = state.workers.filter((w) => w.id !== event.workerId)
      break
    }
    case 'task-submitted': {
      if (event.task?.id) state.tasks[event.task.id] = { ...event.task }
      break
    }
    case 'dispatch-started': {
      const task = state.tasks[event.taskId]
      if (!task) break
      task.status = 'dispatching'
      task.attempts = event.attempt
      task.leaseToken = typeof event.leaseToken === 'string' ? event.leaseToken : null
      task.workerId = event.workerId
      task.instanceId = event.instanceId
      task.sessionId = event.sessionId
      task.dispatchedAt = event.at
      task.updatedAt = event.at
      task.lastError = null
      const worker = state.workers.find((w) => w.id === event.workerId)
      if (worker) {
        worker.status = 'busy'
        worker.currentTaskId = task.id
        worker.lastDispatchedAt = event.at
        worker.lastSeen = event.at
      }
      break
    }
    case 'dispatch-delivered': {
      const task = state.tasks[event.taskId]
      if (!task) break
      task.status = 'running'
      task.delivery = event.delivery ?? 'followup'
      task.leaseUntil = event.leaseUntil ?? null
      task.nextAttemptAt = null
      task.updatedAt = event.at
      break
    }
    case 'dispatch-failed':
    case 'lease-expired': {
      const task = state.tasks[event.taskId]
      if (!task) break
      task.status = event.status
      task.lastError = event.reason ?? null
      task.leaseUntil = null
      task.leaseToken = null
      task.updatedAt = event.at
      if (event.status === 'queued') {
        task.nextAttemptAt = event.nextAttemptAt ?? null
      } else {
        task.finishedAt = event.at
        task.nextAttemptAt = null
        task.result = event.result ?? { summary: '', files: [], error: event.reason ?? 'failed' }
      }
      if (task.workerId) freeWorkerIfIdle(state, task.workerId)
      break
    }
    case 'task-succeeded':
    case 'task-failed': {
      const task = state.tasks[event.taskId]
      if (!task) break
      task.status = event.type === 'task-succeeded' ? 'succeeded' : 'failed'
      task.finishedAt = event.at
      task.updatedAt = event.at
      task.leaseUntil = null
      task.leaseToken = null
      task.nextAttemptAt = null
      task.result = event.result ?? { summary: '', files: [], error: null }
      task.files = normalizeFiles(task.result.files)
      if (task.workerId) freeWorkerIfIdle(state, task.workerId)
      break
    }
    case 'task-cancelled': {
      const task = state.tasks[event.taskId]
      if (!task) break
      task.status = 'cancelled'
      task.finishedAt = event.at
      task.updatedAt = event.at
      task.leaseUntil = null
      task.leaseToken = null
      task.nextAttemptAt = null
      task.result = { summary: '', files: [], error: event.reason ?? 'cancelled by coordinator' }
      if (task.workerId) freeWorkerIfIdle(state, task.workerId)
      break
    }
    default:
      break
  }
  state.seq = Math.max(state.seq, event.seq)
  pushAudit(state, event)
  return state
}

function replayEvents(events) {
  const state = emptyState()
  for (const event of events) applyEvent(state, event)
  return state
}

export class LanScheduler {
  constructor({
    stateFile,
    journalFile,
    interconnect,
    logger = console,
    leaseMs = DEFAULT_LEASE_MS,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    dispatchTimeoutMs = DEFAULT_DISPATCH_TIMEOUT_MS,
    now = () => Date.now(),
  }) {
    if (!stateFile) throw new Error('stateFile is required')
    if (!interconnect) throw new Error('interconnect is required')
    this.stateFile = path.resolve(stateFile)
    this.journalFile = path.resolve(journalFile || stateFile.replace(/\.json$/i, '.journal.jsonl'))
    if (this.stateFile === this.journalFile) {
      throw new Error('stateFile and journalFile must be different paths')
    }
    this.interconnect = interconnect
    this.logger = logger
    this.leaseMs = leaseMs
    this.defaultMaxAttempts = maxAttempts
    this.dispatchTimeoutMs = Math.max(1, asNumber(dispatchTimeoutMs, DEFAULT_DISPATCH_TIMEOUT_MS))
    this.now = now
    this.inFlight = new Set()
    this.tickPromise = null
    this.state = emptyState()
    this.prevHash = null
  }

  load() {
    fs.mkdirSync(path.dirname(this.stateFile), { recursive: true })
    fs.mkdirSync(path.dirname(this.journalFile), { recursive: true })
    const snapshot = this.readSnapshot()
    const journal = this.readJournal()

    if (journal.error) {
      const backup = `${this.journalFile}.corrupt-${Date.now()}`
      try {
        fs.copyFileSync(this.journalFile, backup)
      } catch {
        // Best effort; the original file is never modified below.
      }
      throw new Error(
        `[lan-scheduler] journal corruption: ${journal.error}; backup: ${backup}; refusing to truncate mid-file data`,
      )
    }
    if (journal.tailBytes > 0) {
      try {
        fs.truncateSync(this.journalFile, journal.goodBytes)
        this.logger.warn?.(`[lan-scheduler] truncated incomplete journal tail at ${journal.goodBytes}`)
      } catch (error) {
        this.logger.warn?.(`[lan-scheduler] could not truncate journal: ${error?.message ?? error}`)
      }
    }

    if (journal.events.length === 0) {
      this.state = snapshot ?? emptyState()
      this.prevHash = null
      this.appendEvent({ type: 'snapshot', seq: this.state.seq, at: iso(), state: this.state })
      this.save()
      this.recoverDispatching()
      return this.state
    }

    const replayed = replayEvents(journal.events)
    this.state = replayed
    const last = journal.events[journal.events.length - 1]
    this.prevHash = last.hash ?? null
    if (snapshot && snapshot.seq > this.state.seq) {
      this.logger.warn?.(`[lan-scheduler] state snapshot is ahead of journal (${snapshot.seq} > ${this.state.seq}); journal wins`)
    }
    this.save()
    this.recoverDispatching()
    return this.state
  }

  /**
   * A dispatch that was journaled as started but never delivered cannot be
   * distinguished from a send that was in flight when the process died.
   * Re-queue it; any late reply carries an old lease token and is rejected.
   */
  recoverDispatching() {
    for (const task of Object.values(this.state.tasks)) {
      if (task.status !== 'dispatching' || this.inFlight.has(task.id)) continue
      const outcome = this.retryOutcome(task, 'recovered-dispatch')
      this.commit('dispatch-failed', {
        taskId: task.id,
        workerId: task.workerId,
        reason: 'recovered-dispatch',
        ...outcome,
      })
      this.logger.warn?.(`[lan-scheduler] recovered in-flight dispatch for ${task.id}`)
    }
  }

  readSnapshot() {
    if (!fs.existsSync(this.stateFile)) return null
    try {
      const raw = fs.readFileSync(this.stateFile, 'utf8')
      const parsed = JSON.parse(raw)
      if (!parsed || typeof parsed !== 'object') throw new Error('not an object')
      return normalizeState(parsed)
    } catch (error) {
      const backup = `${this.stateFile}.corrupt-${Date.now()}`
      try {
        fs.copyFileSync(this.stateFile, backup)
      } catch {
        // Best effort only.
      }
      this.logger.warn?.(`[lan-scheduler] state unreadable, falling back to journal (backup: ${backup}): ${error?.message ?? error}`)
      return null
    }
  }

  readJournal() {
    if (!fs.existsSync(this.journalFile)) {
      return { events: [], goodBytes: 0, tailBytes: 0, error: null }
    }
    const raw = fs.readFileSync(this.journalFile, 'utf8')
    if (raw === '') return { events: [], goodBytes: 0, tailBytes: 0, error: null }
    const hasFinalNewline = raw.endsWith('\n')
    const lines = raw.split('\n')
    const events = []
    let expectedSeq = null
    let prevHash = null
    let goodBytes = 0
    let tailBytes = 0
    const fail = (lineNumber, message) => ({
      events,
      goodBytes,
      tailBytes: 0,
      error: `${message} at line ${lineNumber}`,
    })
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]
      const isLast = index === lines.length - 1
      if (isLast && !hasFinalNewline) {
        // A crash can leave an unterminated fragment. It is never applied; the
        // caller truncates exactly these tail bytes after preserving the file.
        tailBytes = Buffer.byteLength(line, 'utf8')
        break
      }
      const lineBytes = Buffer.byteLength(line, 'utf8') + 1
      if (line === '') {
        if (isLast) {
          goodBytes += 1
          continue
        }
        return fail(index + 1, 'blank journal line')
      }
      let event
      try {
        event = JSON.parse(line)
      } catch (error) {
        return fail(index + 1, `bad json: ${error?.message ?? error}`)
      }
      if (!event || typeof event !== 'object') {
        return fail(index + 1, 'bad event')
      }
      if (events.length === 0 && event.prev !== null) {
        return fail(index + 1, 'first event prev must be null')
      }
      if (expectedSeq !== null && event.seq !== expectedSeq) {
        return fail(index + 1, `seq gap: expected ${expectedSeq}, got ${event.seq}`)
      }
      if (prevHash !== null && event.prev !== prevHash) {
        return fail(index + 1, 'hash chain break')
      }
      const { hash, prev, ...body } = event
      const expectedHash = sha256(`${prevHash ?? ''}${stableStringify(body)}`)
      if (hash !== expectedHash) {
        return fail(index + 1, 'hash mismatch')
      }
      events.push(event)
      expectedSeq = event.seq + 1
      prevHash = hash
      goodBytes += lineBytes
    }
    return { events, goodBytes, tailBytes, error: null }
  }

  appendEvent(eventInput) {
    if (fs.existsSync(this.journalFile)) {
      const size = fs.statSync(this.journalFile).size
      if (size > 0) {
        const fd = fs.openSync(this.journalFile, 'r')
        const last = Buffer.alloc(1)
        try {
          fs.readSync(fd, last, 0, 1, size - 1)
        } finally {
          fs.closeSync(fd)
        }
        if (last[0] !== 0x0a) {
          throw new Error('journal tail is not newline-terminated; reload before appending')
        }
      }
    }
    const event = {
      v: JOURNAL_VERSION,
      seq: eventInput.seq,
      at: eventInput.at ?? iso(),
      type: eventInput.type,
    }
    for (const [key, value] of Object.entries(eventInput)) {
      if (!['v', 'seq', 'at', 'type'].includes(key)) event[key] = value
    }
    event.prev = this.prevHash
    event.hash = sha256(`${this.prevHash ?? ''}${stableStringify({ v: event.v, seq: event.seq, at: event.at, type: event.type, ...Object.fromEntries(Object.entries(event).filter(([key]) => !['v', 'seq', 'at', 'type', 'prev', 'hash'].includes(key))) })}`)
    const line = `${JSON.stringify(event)}\n`
    const fd = fs.openSync(this.journalFile, 'a', 0o600)
    try {
      fs.writeFileSync(fd, line, 'utf8')
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    this.prevHash = event.hash
    return event
  }

  commit(type, payload = {}) {
    const seq = this.state.seq + 1
    const event = this.appendEvent({ ...payload, type, seq })
    applyEvent(this.state, event)
    this.save()
    return event
  }

  save() {
    fs.mkdirSync(path.dirname(this.stateFile), { recursive: true })
    const tmp = `${this.stateFile}.tmp-${process.pid}-${Date.now()}`
    const fd = fs.openSync(tmp, 'w', 0o600)
    try {
      fs.writeFileSync(fd, JSON.stringify(this.state, null, 2), 'utf8')
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    fs.renameSync(tmp, this.stateFile)
    if (process.platform !== 'win32') {
      try {
        const dirFd = fs.openSync(path.dirname(this.stateFile), 'r')
        try {
          fs.fsyncSync(dirFd)
        } finally {
          fs.closeSync(dirFd)
        }
      } catch {
        // Directory fsync is best effort on filesystems that do not support it.
      }
    }
  }

  verify() {
    const journal = this.readJournal()
    if (journal.error) return { ok: false, error: journal.error, events: journal.events.length }
    const replayed = replayEvents(journal.events)
    const ok = stableStringify(replayed) === stableStringify(this.state)
    return {
      ok,
      events: journal.events.length,
      lastSeq: replayed.seq,
      error: ok ? null : 'replayed state differs from in-memory state',
      replayed,
    }
  }

  getTask(taskId) {
    return this.state.tasks[taskId] ?? null
  }

  activeTasksFor(workerId) {
    return activeTasksFor(this.state, workerId)
  }

  isWorkerAvailable(worker) {
    if (!worker || worker.status === 'offline') return false
    const active = activeTasksFor(this.state, worker.id).filter((task) => ACTIVE.has(task.status)).length
    return active < Math.max(1, asNumber(worker.maxConcurrent, 1))
  }

  registerWorker({ instanceId, sessionId, label, maxConcurrent = 1 }) {
    if (!instanceId || !sessionId) throw new Error('instanceId and sessionId are required')
    const existing = this.state.workers.find((w) => w.instanceId === instanceId && w.sessionId === sessionId)
    if (existing) {
      const updated = {
        ...existing,
        label: asString(label, existing.label),
        maxConcurrent: Math.max(1, asNumber(maxConcurrent, existing.maxConcurrent ?? 1)),
        lastSeen: iso(),
        status: existing.status === 'offline' ? 'idle' : existing.status,
      }
      this.commit('worker-registered', { worker: updated })
      return this.state.workers.find((w) => w.id === existing.id) ?? updated
    }
    const worker = {
      id: `w-${this.state.seq + 1}`,
      instanceId,
      sessionId,
      label: asString(label, `${instanceId}/${sessionId.slice(-8)}`),
      maxConcurrent: Math.max(1, asNumber(maxConcurrent, 1)),
      status: 'idle',
      currentTaskId: null,
      createdAt: iso(),
      lastSeen: iso(),
      lastDispatchedAt: null,
    }
    this.commit('worker-registered', { worker })
    return this.state.workers.find((w) => w.id === worker.id) ?? worker
  }

  listWorkers({ status } = {}) {
    return this.state.workers
      .filter((worker) => (status ? worker.status === status : true))
      .map((worker) => ({
        ...worker,
        activeTasks: activeTasksFor(this.state, worker.id).filter((task) => ACTIVE.has(task.status)).length,
      }))
  }

  removeWorker(workerId) {
    const worker = this.state.workers.find((w) => w.id === workerId)
    if (!worker) return { ok: false, reason: 'worker-not-found' }
    if (activeTasksFor(this.state, workerId).length > 0) {
      return { ok: false, reason: 'worker-has-tasks' }
    }
    this.commit('worker-removed', { workerId, instanceId: worker.instanceId })
    return { ok: true, workerId }
  }

  selectWorker(task) {
    if (task.targetWorkerId) {
      const worker = this.state.workers.find((w) => w.id === task.targetWorkerId)
      return this.isWorkerAvailable(worker) ? worker : null
    }
    if (task.targetInstanceId) {
      const candidates = this.state.workers
        .filter((w) => w.instanceId === task.targetInstanceId && this.isWorkerAvailable(w))
        .sort((a, b) => activeTasksFor(this.state, a.id).length - activeTasksFor(this.state, b.id).length)
      return candidates[0] ?? null
    }
    const candidates = this.state.workers
      .filter((w) => this.isWorkerAvailable(w))
      .sort((a, b) => {
        const activeDiff = activeTasksFor(this.state, a.id).length - activeTasksFor(this.state, b.id).length
        if (activeDiff !== 0) return activeDiff
        return String(a.lastDispatchedAt ?? '').localeCompare(String(b.lastDispatchedAt ?? ''))
      })
    return candidates[0] ?? null
  }

  submit({
    title,
    prompt,
    priority = 0,
    targetWorkerId,
    targetInstanceId,
    dedupeKey,
    ownerInstanceId,
    ownerSessionId,
    maxAttempts,
  }) {
    if (!prompt || String(prompt).trim() === '') throw new Error('prompt is required')
    if (byteLength(prompt) > MAX_PROMPT_BYTES) throw new Error(`prompt exceeds ${MAX_PROMPT_BYTES} bytes`)
    if (dedupeKey) {
      const duplicate = Object.values(this.state.tasks).find(
        (task) => task.dedupeKey === dedupeKey && !TERMINAL.has(task.status),
      )
      if (duplicate) return { ok: true, duplicate: true, task: duplicate }
    }
    const task = {
      id: `t-${Date.now().toString(36)}-${this.state.seq + 1}`,
      title: asString(title, String(prompt).split('\n')[0].slice(0, 80)),
      prompt: String(prompt),
      priority: asNumber(priority, 0),
      status: 'queued',
      attempts: 0,
      maxAttempts: Math.max(1, asNumber(maxAttempts, this.defaultMaxAttempts)),
      targetWorkerId: asString(targetWorkerId, '') || null,
      targetInstanceId: asString(targetInstanceId, '') || null,
      dedupeKey: asString(dedupeKey, '') || null,
      ownerInstanceId: asString(ownerInstanceId, '') || null,
      ownerSessionId: asString(ownerSessionId, '') || null,
      workerId: null,
      instanceId: null,
      sessionId: null,
      createdAt: iso(),
      updatedAt: iso(),
      dispatchedAt: null,
      leaseUntil: null,
      leaseToken: null,
      finishedAt: null,
      nextAttemptAt: null,
      lastError: null,
      delivery: null,
      result: null,
      files: [],
    }
    this.commit('task-submitted', { task })
    return { ok: true, duplicate: false, task: this.getTask(task.id) ?? task }
  }

  retryOutcome(task, reason) {
    if (task.attempts < task.maxAttempts) {
      return {
        status: 'queued',
        nextAttemptAt: new Date(this.now() + Math.min(30_000 * task.attempts, 300_000)).toISOString(),
        result: null,
      }
    }
    return {
      status: 'failed',
      nextAttemptAt: null,
      result: { summary: '', files: [], error: reason },
    }
  }

  async _sendWithTimeout(payload) {
    let timer = null
    const sendPromise = Promise.resolve(this.interconnect.send(payload))
    sendPromise.catch(() => {})
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error('send-timeout')
        error.code = 'send-timeout'
        reject(error)
      }, this.dispatchTimeoutMs)
      timer.unref?.()
    })
    try {
      return await Promise.race([sendPromise, timeoutPromise])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  async dispatch(taskId) {
    const task = this.getTask(taskId)
    if (!task) return { ok: false, reason: 'task-not-found' }
    if (task.status !== 'queued') return { ok: false, reason: `task-not-queued:${task.status}` }
    if (this.inFlight.has(taskId)) return { ok: false, reason: 'in-flight' }
    if (task.nextAttemptAt && Date.parse(task.nextAttemptAt) > this.now()) {
      return { ok: false, reason: 'retry-backoff' }
    }
    const worker = this.selectWorker(task)
    if (!worker) return { ok: false, reason: 'no-idle-worker' }

    this.inFlight.add(taskId)
    try {
      const attempt = task.attempts + 1
      const leaseToken = `lt-${crypto.randomUUID()}`
      this.commit('dispatch-started', {
        taskId,
        workerId: worker.id,
        instanceId: worker.instanceId,
        sessionId: worker.sessionId,
        attempt,
        leaseToken,
      })
      const current = this.getTask(taskId)
      try {
        const sender =
          current.ownerSessionId && typeof this.interconnect.selfSender === 'function'
            ? this.interconnect.selfSender(current.ownerSessionId)
            : undefined
        const response = await this._sendWithTimeout({
          instanceId: worker.instanceId,
          sessionId: worker.sessionId,
          text: buildTaskMessage(current),
          delivery: 'followup',
          resume: true,
          ...(sender ? { sender } : {}),
        })
         if (response?.delivered === true) {
          const latest = this.getTask(taskId)
          if (!latest || latest.status !== 'dispatching' || latest.leaseToken !== leaseToken) {
            return { ok: false, reason: 'superseded', task: latest }
          }
          const leaseUntil = new Date(this.now() + this.leaseMs).toISOString()
          this.commit('dispatch-delivered', {
            taskId,
            workerId: worker.id,
            delivery: response.delivery ?? 'followup',
            leaseUntil,
          })
          return { ok: true, task: this.getTask(taskId), worker }
        }
        const latest = this.getTask(taskId)
        if (!latest || latest.status !== 'dispatching' || latest.leaseToken !== leaseToken) {
          return { ok: false, reason: 'superseded', task: latest }
        }
        const reason = asString(response?.reason, 'not-delivered')
        const outcome = this.retryOutcome(latest, reason)
        this.commit('dispatch-failed', { taskId, workerId: worker.id, reason, ...outcome })
        return { ok: false, reason, task: this.getTask(taskId) }
      } catch (error) {
        const latest = this.getTask(taskId)
        if (!latest || latest.status !== 'dispatching' || latest.leaseToken !== leaseToken) {
          return { ok: false, reason: 'superseded', task: latest }
        }
        const reason = error?.code === 'send-timeout' ? 'send-timeout' : String(error?.message ?? error)
        const outcome = this.retryOutcome(latest, reason)
        this.commit('dispatch-failed', { taskId, workerId: worker.id, reason, ...outcome })
        return { ok: false, reason, task: this.getTask(taskId) }
      }
    } finally {
      this.inFlight.delete(taskId)
    }
  }

  ingest({ taskId, text, status, summary, files, error, attempt, leaseToken }) {
    if (text && byteLength(text) > MAX_REPLY_BYTES) {
      return { ok: false, reason: 'reply-too-large' }
    }
    let parsed = null
    if (text) parsed = extractJsonObject(text)
    const id = asString(taskId, '') || asString(parsed?.task_id ?? parsed?.taskId, '')
    if (!id) return { ok: false, reason: 'task-id-required' }
    const task = this.getTask(id)
    if (!task) return { ok: false, reason: 'task-not-found', taskId: id }
    if (TERMINAL.has(task.status)) return { ok: true, duplicate: true, task }

    const active = ACTIVE.has(task.status)
    if (!active || !task.leaseToken) {
      return { ok: false, reason: `task-not-active:${task.status}`, taskId: id, task }
    }
    const incomingAttempt = asNumber(attempt ?? parsed?.attempt, Number.NaN)
    const incomingToken = asString(leaseToken, '') || asString(parsed?.lease_token ?? parsed?.leaseToken, '')
    if (!Number.isFinite(incomingAttempt)) {
      return { ok: false, reason: 'attempt-required', taskId: id, task }
    }
    if (incomingAttempt !== task.attempts) {
      return { ok: false, reason: `attempt-mismatch:${incomingAttempt}!=${task.attempts}`, taskId: id, task }
    }
    if (!incomingToken) {
      return { ok: false, reason: 'lease-token-required', taskId: id, task }
    }
    if (incomingToken !== task.leaseToken) {
      return { ok: false, reason: 'stale-lease', taskId: id, task }
    }

    const rawStatus = asString(status, '') || asString(parsed?.status, '')
    if (!['succeeded', 'success', 'failed'].includes(rawStatus)) {
      return { ok: false, reason: 'invalid-status', taskId: id, task }
    }
    const finalStatus = rawStatus === 'succeeded' || rawStatus === 'success' ? 'succeeded' : 'failed'
    const finalSummary = truncateUtf8(summary ?? parsed?.summary ?? '', MAX_SUMMARY_BYTES)
    const finalError = truncateUtf8(error ?? parsed?.error ?? '', MAX_SUMMARY_BYTES)
    const finalFiles = normalizeFiles(files ?? parsed?.files)
    const result = {
      summary: finalSummary,
      files: finalFiles,
      error: finalStatus === 'succeeded' ? null : finalError || 'worker-reported-failure',
    }
    this.commit(finalStatus === 'succeeded' ? 'task-succeeded' : 'task-failed', {
      taskId: id,
      workerId: task.workerId,
      instanceId: task.instanceId,
      attempt: task.attempts,
      leaseToken: task.leaseToken,
      result,
    })
    return { ok: true, task: this.getTask(id) }
  }

  cancel(taskId, reason = 'cancelled by coordinator') {
    const task = this.getTask(taskId)
    if (!task) return { ok: false, reason: 'task-not-found' }
    if (TERMINAL.has(task.status)) return { ok: false, reason: `task-terminal:${task.status}` }
    this.commit('task-cancelled', { taskId, reason: String(reason) })
    return { ok: true, task: this.getTask(taskId) }
  }

  async tick() {
    if (this.tickPromise) return this.tickPromise
    this.tickPromise = this._tick().finally(() => {
      this.tickPromise = null
    })
    return this.tickPromise
  }

  async _tick() {
    const actions = []
    const now = this.now()
    this.recoverDispatching()
    for (const task of Object.values(this.state.tasks)) {
      if (task.status !== 'running') continue
      if (!task.leaseUntil) continue
      const lease = Date.parse(task.leaseUntil)
      if (!Number.isFinite(lease) || lease > now) continue
      const outcome = this.retryOutcome(task, 'lease-expired')
      this.commit('lease-expired', { taskId: task.id, reason: 'lease-expired', ...outcome })
      actions.push({ taskId: task.id, action: 'lease-expired', status: this.getTask(task.id).status })
    }
    const queued = Object.values(this.state.tasks)
      .filter((task) => task.status === 'queued')
      .sort((a, b) => b.priority - a.priority || String(a.createdAt).localeCompare(String(b.createdAt)))
    for (const task of queued) {
      if (task.nextAttemptAt && Date.parse(task.nextAttemptAt) > now) continue
      if (!this.selectWorker(task)) {
        actions.push({ taskId: task.id, action: 'not-dispatched', reason: 'no-idle-worker' })
        continue
      }
      const result = await this.dispatch(task.id)
      actions.push({ taskId: task.id, action: result.ok ? 'dispatched' : 'not-dispatched', reason: result.reason })
    }
    return { ok: true, actions, stats: this.stats() }
  }

  list({ status, limit = 50 } = {}) {
    const wanted = status ? new Set(String(status).split(',').map((s) => s.trim()).filter(Boolean)) : null
    return Object.values(this.state.tasks)
      .filter((task) => (wanted ? wanted.has(task.status) : true))
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
      .slice(0, Math.max(1, Math.min(500, asNumber(limit, 50))))
      .map((task) => ({
        id: task.id,
        title: task.title,
        status: task.status,
        priority: task.priority,
        attempts: task.attempts,
        maxAttempts: task.maxAttempts,
        instanceId: task.instanceId,
        workerId: task.workerId,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
        lastError: task.lastError,
        resultSummary: task.result?.summary?.slice(0, 500) ?? null,
      }))
  }

  stats() {
    const counts = {}
    for (const task of Object.values(this.state.tasks)) counts[task.status] = (counts[task.status] ?? 0) + 1
    return {
      tasks: Object.keys(this.state.tasks).length,
      counts,
      workers: this.state.workers.length,
      idleWorkers: this.state.workers.filter((w) => this.isWorkerAvailable(w)).length,
      stateFile: this.stateFile,
      journalFile: this.journalFile,
      seq: this.state.seq,
    }
  }
}
