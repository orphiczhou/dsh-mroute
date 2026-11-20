import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { LanScheduler, buildTaskMessage, extractJsonObject } from '../lib/scheduler.js'

function tempStateFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lan-sched-'))
  return path.join(dir, 'state.json')
}

function fakeInterconnect({ send } = {}) {
  return {
    sent: [],
    selfSender(sessionId) {
      return { instanceId: 'dsh-a', sessionId }
    },
    async send(message) {
      this.sent.push(message)
      if (send) return send(message, this.sent.length)
      return { delivered: true, instance: message.instanceId, delivery: 'followup' }
    },
  }
}

function makeScheduler(options = {}) {
  const stateFile = options.stateFile ?? tempStateFile()
  const interconnect = options.interconnect ?? fakeInterconnect()
  let clock = options.clock ?? Date.now()
  const scheduler = new LanScheduler({
    stateFile,
    interconnect,
    now: () => clock,
    leaseMs: options.leaseMs,
    maxAttempts: options.maxAttempts,
    dispatchTimeoutMs: options.dispatchTimeoutMs,
    logger: { info() {}, warn() {} },
  })
  scheduler.load()
  return {
    scheduler,
    stateFile,
    interconnect,
    advance(ms) {
      clock += ms
    },
  }
}

function leasedIngest(scheduler, taskId, extra = {}) {
  const task = scheduler.getTask(taskId)
  return scheduler.ingest({
    taskId,
    attempt: task.attempts,
    leaseToken: task.leaseToken,
    ...extra,
  })
}

test('submit dispatches to a registered worker and ingest completes it', async () => {
  const { scheduler, interconnect } = makeScheduler()
  const worker = scheduler.registerWorker({ instanceId: 'dsh-b', sessionId: 'session-b' })
  const created = scheduler.submit({
    title: 'smoke',
    prompt: 'Return the word OK',
    ownerSessionId: 'session-a',
  })
  assert.equal(created.ok, true)
  assert.equal(created.task.status, 'queued')

  const dispatch = await scheduler.dispatch(created.task.id)
  assert.equal(dispatch.ok, true)
  assert.equal(interconnect.sent.length, 1)
  assert.equal(interconnect.sent[0].instanceId, 'dsh-b')
  assert.equal(interconnect.sent[0].sessionId, 'session-b')
  assert.equal(interconnect.sent[0].sender.sessionId, 'session-a')
  assert.match(interconnect.sent[0].text, /\[LAN-SCHED TASK v1\]/)
  assert.equal(scheduler.getTask(created.task.id).status, 'running')
  assert.equal(scheduler.getTask(created.task.id).workerId, worker.id)

  const ingested = leasedIngest(scheduler, created.task.id, {
    text: 'done\n```json\n{"task_id":"' + created.task.id + '","status":"succeeded","summary":"OK","files":[]}\n```',
  })
  assert.equal(ingested.ok, true)
  assert.equal(scheduler.getTask(created.task.id).status, 'succeeded')
  assert.equal(scheduler.getTask(created.task.id).result.summary, 'OK')
  assert.equal(scheduler.listWorkers()[0].status, 'idle')
})

test('two workers absorb two tasks, the third waits, then is dispatched after completion', async () => {
  const { scheduler, interconnect } = makeScheduler()
  const w1 = scheduler.registerWorker({ instanceId: 'dsh-b', sessionId: 'session-b1' })
  const w2 = scheduler.registerWorker({ instanceId: 'dsh-c', sessionId: 'session-c1' })

  const t1 = scheduler.submit({ prompt: 'one', ownerSessionId: 'session-a' })
  const t2 = scheduler.submit({ prompt: 'two', ownerSessionId: 'session-a' })
  const t3 = scheduler.submit({ prompt: 'three', ownerSessionId: 'session-a' })
  assert.equal((await scheduler.dispatch(t1.task.id)).ok, true)
  assert.equal((await scheduler.dispatch(t2.task.id)).ok, true)
  const thirdDispatch = await scheduler.dispatch(t3.task.id)
  assert.equal(thirdDispatch.ok, false)
  assert.equal(thirdDispatch.reason, 'no-idle-worker')

  const workerIds = [scheduler.getTask(t1.task.id).workerId, scheduler.getTask(t2.task.id).workerId]
  assert.deepEqual(new Set(workerIds), new Set([w1.id, w2.id]))

  leasedIngest(scheduler, t1.task.id, { status: 'succeeded', summary: 'one done' })
  const tick = await scheduler.tick()
  assert.equal(tick.ok, true)
  assert.equal(scheduler.getTask(t3.task.id).status, 'running')
  assert.equal(interconnect.sent.length, 3)
})

test('transport failure retries with backoff, then succeeds', async () => {
  let attempt = 0
  const interconnect = fakeInterconnect({
    send(message) {
      attempt += 1
      if (attempt === 1) return { delivered: false, instance: message.instanceId, reason: 'unreachable' }
      return { delivered: true, instance: message.instanceId, delivery: 'followup' }
    },
  })
  const { scheduler, advance } = makeScheduler({ interconnect, maxAttempts: 2 })
  scheduler.registerWorker({ instanceId: 'dsh-b', sessionId: 'session-b' })
  const created = scheduler.submit({ prompt: 'retry me', ownerSessionId: 'session-a' })

  const first = await scheduler.dispatch(created.task.id)
  assert.equal(first.ok, false)
  assert.equal(scheduler.getTask(created.task.id).status, 'queued')
  assert.equal(scheduler.getTask(created.task.id).attempts, 1)

  const tooEarly = await scheduler.dispatch(created.task.id)
  assert.equal(tooEarly.reason, 'retry-backoff')

  advance(31_000)
  const second = await scheduler.dispatch(created.task.id)
  assert.equal(second.ok, true)
  assert.equal(scheduler.getTask(created.task.id).status, 'running')
  assert.equal(scheduler.getTask(created.task.id).attempts, 2)
})

test('expired lease requeues and eventually fails at maxAttempts', async () => {
  const { scheduler, advance } = makeScheduler({ leaseMs: 1_000, maxAttempts: 2 })
  scheduler.registerWorker({ instanceId: 'dsh-b', sessionId: 'session-b' })
  const created = scheduler.submit({ prompt: 'lease', ownerSessionId: 'session-a' })
  await scheduler.dispatch(created.task.id)
  assert.equal(scheduler.getTask(created.task.id).status, 'running')

  advance(2_000)
  await scheduler.tick()
  assert.equal(scheduler.getTask(created.task.id).status, 'queued')
  assert.equal(scheduler.getTask(created.task.id).attempts, 1)

  advance(31_000)
  await scheduler.tick()
  assert.equal(scheduler.getTask(created.task.id).status, 'running')
  assert.equal(scheduler.getTask(created.task.id).attempts, 2)

  advance(2_000)
  await scheduler.tick()
  assert.equal(scheduler.getTask(created.task.id).status, 'failed')
  assert.match(scheduler.getTask(created.task.id).result.error, /lease-expired/)
})

test('dedupeKey reuses an active task', () => {
  const { scheduler } = makeScheduler()
  scheduler.registerWorker({ instanceId: 'dsh-b', sessionId: 'session-b' })
  const a = scheduler.submit({ prompt: 'same', dedupeKey: 'k1', ownerSessionId: 'session-a' })
  const b = scheduler.submit({ prompt: 'same', dedupeKey: 'k1', ownerSessionId: 'session-a' })
  assert.equal(a.duplicate, false)
  assert.equal(b.duplicate, true)
  assert.equal(a.task.id, b.task.id)
})

test('stale attempt or lease token is rejected', async () => {
  const { scheduler } = makeScheduler()
  scheduler.registerWorker({ instanceId: 'dsh-b', sessionId: 'session-b' })
  const created = scheduler.submit({ prompt: 'fence me', ownerSessionId: 'session-a' })
  const first = await scheduler.dispatch(created.task.id)
  assert.equal(first.ok, true)
  const firstToken = scheduler.getTask(created.task.id).leaseToken
  assert.match(firstToken, /^lt-/)

  const noAttempt = scheduler.ingest({ taskId: created.task.id, status: 'succeeded' })
  assert.equal(noAttempt.reason, 'attempt-required')
  const noToken = scheduler.ingest({ taskId: created.task.id, attempt: 1, status: 'succeeded' })
  assert.equal(noToken.reason, 'lease-token-required')
  const wrongToken = scheduler.ingest({
    taskId: created.task.id,
    attempt: 1,
    leaseToken: 'lt-not-the-one',
    status: 'succeeded',
  })
  assert.equal(wrongToken.reason, 'stale-lease')

  const task = scheduler.getTask(created.task.id)
  task.leaseUntil = new Date(0).toISOString()
  await scheduler.tick()
  assert.equal(scheduler.getTask(created.task.id).status, 'queued')
  scheduler.getTask(created.task.id).nextAttemptAt = null
  const second = await scheduler.dispatch(created.task.id)
  assert.equal(second.ok, true)
  const secondToken = scheduler.getTask(created.task.id).leaseToken
  assert.notEqual(firstToken, secondToken)

  const old = scheduler.ingest({
    taskId: created.task.id,
    attempt: 2,
    leaseToken: firstToken,
    status: 'succeeded',
  })
  assert.equal(old.reason, 'stale-lease')
  const accepted = scheduler.ingest({
    taskId: created.task.id,
    attempt: 2,
    leaseToken: secondToken,
    status: 'succeeded',
    summary: 'fenced ok',
  })
  assert.equal(accepted.ok, true)
  const duplicate = scheduler.ingest({
    taskId: created.task.id,
    attempt: 2,
    leaseToken: secondToken,
    status: 'succeeded',
  })
  assert.equal(duplicate.duplicate, true)
})

test('oversized reply is rejected before parsing and leaves the task unchanged', async () => {
  const { scheduler } = makeScheduler()
  scheduler.registerWorker({ instanceId: 'dsh-b', sessionId: 'session-b' })
  const created = scheduler.submit({ prompt: 'big reply', ownerSessionId: 'session-a' })
  await scheduler.dispatch(created.task.id)
  const before = scheduler.getTask(created.task.id)
  const result = scheduler.ingest({
    taskId: created.task.id,
    attempt: before.attempts,
    leaseToken: before.leaseToken,
    text: 'x'.repeat(1024 * 1024 + 1),
  })
  assert.equal(result.reason, 'reply-too-large')
  assert.equal(scheduler.getTask(created.task.id).status, 'running')
})

test('a dispatch journaled but never delivered is requeued on restart', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lan-sched-recover-'))
  const stateFile = path.join(dir, 'state.json')
  const first = makeScheduler({ stateFile })
  const worker = first.scheduler.registerWorker({ instanceId: 'dsh-b', sessionId: 'session-b' })
  const created = first.scheduler.submit({ prompt: 'crash window', ownerSessionId: 'session-a' })
  first.scheduler.commit('dispatch-started', {
    taskId: created.task.id,
    workerId: worker.id,
    instanceId: worker.instanceId,
    sessionId: worker.sessionId,
    attempt: 1,
    leaseToken: 'lt-crash-window',
  })

  const second = makeScheduler({ stateFile })
  const task = second.scheduler.getTask(created.task.id)
  assert.equal(task.status, 'queued')
  assert.equal(task.attempts, 1)
  assert.equal(task.leaseToken, null)
  assert.equal(task.lastError, 'recovered-dispatch')
  assert.equal(second.scheduler.listWorkers()[0].status, 'idle')
  assert.equal(second.scheduler.verify().ok, true)
})

test('two concurrent ticks do not double-dispatch a queued task', async () => {
  const { scheduler, interconnect } = makeScheduler()
  scheduler.registerWorker({ instanceId: 'dsh-b', sessionId: 'session-b' })
  const created = scheduler.submit({ prompt: 'one dispatch only', ownerSessionId: 'session-a' })

  const [a, b] = await Promise.all([scheduler.tick(), scheduler.tick()])
  assert.equal(a.ok, true)
  assert.equal(b.ok, true)
  assert.equal(interconnect.sent.length, 1)
  assert.equal(scheduler.getTask(created.task.id).status, 'running')
})

test('a completion that lands before the send returns wins over delivery', async () => {
  let release
  const interconnect = fakeInterconnect({
    send() {
      return new Promise((resolve) => {
        release = resolve
      })
    },
  })
  const { scheduler } = makeScheduler({ interconnect })
  scheduler.registerWorker({ instanceId: 'dsh-b', sessionId: 'session-b' })
  const created = scheduler.submit({ prompt: 'race me', ownerSessionId: 'session-a' })

  const dispatchPromise = scheduler.dispatch(created.task.id)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(scheduler.getTask(created.task.id).status, 'dispatching')
  const accepted = leasedIngest(scheduler, created.task.id, { status: 'succeeded', summary: 'won the race' })
  assert.equal(accepted.ok, true)

  release({ delivered: true, instance: 'dsh-b', delivery: 'followup' })
  const result = await dispatchPromise
  assert.equal(result.reason, 'superseded')
  assert.equal(scheduler.getTask(created.task.id).status, 'succeeded')
  assert.equal(scheduler.getTask(created.task.id).result.summary, 'won the race')
})

test('extractJsonObject tolerates prose and fences', () => {
  const parsed = extractJsonObject('worker says:\n```json\n{"task_id":"t-1","status":"succeeded","summary":"ok"}\n```\nthanks')
  assert.equal(parsed.task_id, 't-1')
  assert.equal(parsed.status, 'succeeded')
  assert.equal(extractJsonObject('no json here'), null)
})

test('buildTaskMessage contains task id, reply contract and prompt', () => {
  const text = buildTaskMessage({
    id: 't-abc',
    title: 'demo',
    prompt: 'do the thing',
    priority: 1,
    attempts: 1,
    leaseToken: 'lt-demo',
    ownerInstanceId: 'dsh-a',
    ownerSessionId: 'session-a',
  })
  assert.match(text, /t-abc/)
  assert.match(text, /"lease_token":"lt-demo"/)
  assert.match(text, /"attempt":1/)
  assert.match(text, /interconnect_reply/)
  assert.match(text, /do the thing/)
  assert.match(text, /"status":"succeeded"/)
})

test('tick skips an unsatisfiable head task instead of starving later tasks', async () => {
  const { scheduler } = makeScheduler()
  scheduler.registerWorker({ instanceId: 'dsh-b', sessionId: 'session-b' })
  const blocked = scheduler.submit({ prompt: 'no such instance', targetInstanceId: 'dsh-x', ownerSessionId: 'session-a' })
  const runnable = scheduler.submit({ prompt: 'runnable', targetInstanceId: 'dsh-b', ownerSessionId: 'session-a' })
  const result = await scheduler.tick()
  assert.equal(scheduler.getTask(blocked.task.id).status, 'queued')
  assert.equal(scheduler.getTask(runnable.task.id).status, 'running')
  assert.ok(result.actions.some((a) => a.taskId === blocked.task.id && a.reason === 'no-idle-worker'))
})

test('dispatch times out when interconnect.send never settles', async () => {
  const interconnect = fakeInterconnect({ send() { return new Promise(() => {}) } })
  const { scheduler } = makeScheduler({ interconnect, dispatchTimeoutMs: 20 })
  scheduler.registerWorker({ instanceId: 'dsh-b', sessionId: 'session-b' })
  const created = scheduler.submit({ prompt: 'hang', ownerSessionId: 'session-a' })
  const result = await scheduler.dispatch(created.task.id)
  assert.equal(result.reason, 'send-timeout')
  assert.equal(scheduler.getTask(created.task.id).status, 'queued')
  assert.equal(scheduler.getTask(created.task.id).lastError, 'send-timeout')
  assert.equal(scheduler.inFlight.has(created.task.id), false)
})

test('a malformed reply is rejected without mutating the task', async () => {
  const { scheduler } = makeScheduler()
  scheduler.registerWorker({ instanceId: 'dsh-b', sessionId: 'session-b' })
  const created = scheduler.submit({ prompt: 'malformed', ownerSessionId: 'session-a' })
  await scheduler.dispatch(created.task.id)
  const before = scheduler.getTask(created.task.id)
  const result = scheduler.ingest({
    taskId: created.task.id,
    attempt: before.attempts,
    leaseToken: before.leaseToken,
    text: 'not-json at all',
  })
  assert.equal(result.reason, 'invalid-status')
  assert.equal(scheduler.getTask(created.task.id).status, 'running')
  assert.equal(scheduler.getTask(created.task.id).result, null)
})

test('constructor rejects stateFile and journalFile collision', () => {
  const stateFile = tempStateFile()
  assert.throws(
    () => new LanScheduler({ stateFile, journalFile: stateFile, interconnect: fakeInterconnect() }),
    /must be different paths/,
  )
})

test('state survives reload', () => {
  const stateFile = tempStateFile()
  const first = makeScheduler({ stateFile })
  const worker = first.scheduler.registerWorker({ instanceId: 'dsh-b', sessionId: 'session-b' })
  const created = first.scheduler.submit({ prompt: 'persist', ownerSessionId: 'session-a' })
  const second = makeScheduler({ stateFile })
  assert.equal(second.scheduler.getTask(created.task.id).prompt, 'persist')
  assert.equal(second.scheduler.listWorkers()[0].id, worker.id)
})
