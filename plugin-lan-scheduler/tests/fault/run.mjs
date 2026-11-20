/**
 * Deterministic fault injection at the scheduler/transport boundary.
 *
 * This is not a replacement for a four-node chaos test. It exercises the
 * failure modes that the live cluster cannot reliably reproduce on demand:
 * crash after journal + before send, lost delivery response, partition,
 * stale fenced reply, malformed reply, oversized reply, concurrent tick and
 * journal corruption. Every scenario writes raw journal/state artifacts.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { LanScheduler } from '../../lib/scheduler.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const outDir = path.join(here, 'artifacts', stamp)
fs.mkdirSync(outDir, { recursive: true })

class FakeInterconnect {
  constructor(mode = 'ok') {
    this.mode = mode
    this.sent = []
    this.failuresLeft = 0
  }

  async send(message) {
    this.sent.push(message)
    if (this.mode === 'throw') throw new Error('ECONNREFUSED (injected partition)')
    if (this.failuresLeft > 0) {
      this.failuresLeft -= 1
      throw new Error('ECONNREFUSED (injected transient partition)')
    }
    return { delivered: true, instance: message.instanceId, delivery: 'followup' }
  }
}

function snapshot(scheduler, name, extra = {}) {
  const taskValues = Object.values(scheduler.state.tasks)
  const journalPath = scheduler.journalFile
  const statePath = scheduler.stateFile
  if (fs.existsSync(journalPath)) fs.copyFileSync(journalPath, path.join(outDir, `${name}.journal.jsonl`))
  if (fs.existsSync(statePath)) fs.copyFileSync(statePath, path.join(outDir, `${name}.state.json`))
  return {
    scenario: name,
    pass: extra.pass === true,
    observed: extra.observed ?? {},
    notes: extra.notes ?? [],
    tasks: taskValues.map((task) => ({
      id: task.id,
      status: task.status,
      attempts: task.attempts,
      leaseToken: task.leaseToken,
      workerId: task.workerId,
      lastError: task.lastError,
      result: task.result,
    })),
    workers: scheduler.state.workers,
    verify: scheduler.verify(),
    journalFile: journalPath,
    stateFile: statePath,
  }
}

function newScheduler(dir, interconnect, { leaseMs = 5_000, now = () => Date.now() } = {}) {
  const stateFile = path.join(dir, 'state.json')
  const scheduler = new LanScheduler({ stateFile, interconnect, leaseMs, now })
  scheduler.load()
  return scheduler
}

function makeDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `lan-sched-fault-${label}-`))
}

const results = []

function record(name, scheduler, extra) {
  results.push(snapshot(scheduler, name, extra))
}

// F1: crash after dispatch-started is journaled, before send.
{
  const dir = makeDir('crash-before-send')
  const interconnect = new FakeInterconnect('throw')
  const scheduler = newScheduler(dir, interconnect)
  const worker = scheduler.registerWorker({ instanceId: 'dsh-b', sessionId: 'session-b' })
  const created = scheduler.submit({ prompt: 'crash window', ownerSessionId: 'session-a' })
  scheduler.commit('dispatch-started', {
    taskId: created.task.id,
    workerId: worker.id,
    instanceId: worker.instanceId,
    sessionId: worker.sessionId,
    attempt: 1,
    leaseToken: 'lt-crash-before-send',
  })
  const restarted = newScheduler(dir, new FakeInterconnect('ok'))
  const task = restarted.getTask(created.task.id)
  record('F1-crash-before-send', restarted, {
    pass: task.status === 'queued' && task.lastError === 'recovered-dispatch' && restarted.verify().ok,
    observed: { status: task.status, lastError: task.lastError, attempts: task.attempts },
    notes: ['dispatch-started journaled, then process restarted before send'],
  })
}

// F2: delivery reached the worker, but the response was lost.
{
  const dir = makeDir('delivery-response-lost')
  let now = Date.now()
  const interconnect = new FakeInterconnect('throw')
  const scheduler = newScheduler(dir, interconnect, { now: () => now })
  const worker = scheduler.registerWorker({ instanceId: 'dsh-b', sessionId: 'session-b' })
  const created = scheduler.submit({ prompt: 'lost ack', ownerSessionId: 'session-a' })
  const first = await scheduler.dispatch(created.task.id)
  const afterFailure = scheduler.getTask(created.task.id)
  const statusAfterFailure = afterFailure.status
  const tokenAfterFailure = afterFailure.leaseToken
  interconnect.mode = 'ok'
  now += 60_000
  const second = await scheduler.dispatch(created.task.id)
  const afterRetry = scheduler.getTask(created.task.id)
  record('F2-delivery-response-lost', scheduler, {
    pass:
      first.ok === false &&
      String(first.reason).includes('ECONNREFUSED') &&
      statusAfterFailure === 'queued' &&
      second.ok === true &&
      afterRetry.status === 'running' &&
      afterRetry.leaseToken !== tokenAfterFailure &&
      scheduler.verify().ok,
    observed: {
      firstReason: first.reason,
      statusAfterFailure,
      statusAfterRetry: afterRetry.status,
      tokensDiffer: afterRetry.leaseToken !== tokenAfterFailure,
    },
    notes: ['send threw after the worker may have received it; retry uses a new lease token'],
  })
}

// F3: transient partition, then recovery.
{
  const dir = makeDir('partition-retry')
  let now = Date.now()
  const interconnect = new FakeInterconnect('ok')
  interconnect.failuresLeft = 2
  const scheduler = newScheduler(dir, interconnect, { now: () => now })
  scheduler.registerWorker({ instanceId: 'dsh-b', sessionId: 'session-b' })
  const created = scheduler.submit({ prompt: 'partition', ownerSessionId: 'session-a' })
  const first = await scheduler.dispatch(created.task.id)
  const afterFirst = scheduler.getTask(created.task.id)
  const status1 = afterFirst.status
  const attempts1 = afterFirst.attempts
  now += 60_000
  const second = await scheduler.dispatch(created.task.id)
  const afterSecond = scheduler.getTask(created.task.id)
  const status2 = afterSecond.status
  const attempts2 = afterSecond.attempts
  now += 60_000
  const third = await scheduler.dispatch(created.task.id)
  const afterThird = scheduler.getTask(created.task.id)
  record('F3-partition-retry', scheduler, {
    pass:
      first.ok === false &&
      String(first.reason).includes('ECONNREFUSED') &&
      status1 === 'queued' &&
      second.ok === false &&
      String(second.reason).includes('ECONNREFUSED') &&
      status2 === 'queued' &&
      third.ok === true &&
      afterThird.status === 'running' &&
      scheduler.verify().ok,
    observed: {
      attempts: [attempts1, attempts2, afterThird.attempts],
      statuses: [status1, status2, afterThird.status],
      lastError: afterThird.lastError,
    },
    notes: ['two injected ECONNREFUSED, then success; retry budget consumed'],
  })
}

// F4: lease expiry, stale reply rejected, new reply accepted.
{
  const dir = makeDir('stale-reply')
  let now = Date.now()
  const interconnect = new FakeInterconnect('ok')
  const scheduler = newScheduler(dir, interconnect, { leaseMs: 1_000, now: () => now })
  scheduler.registerWorker({ instanceId: 'dsh-b', sessionId: 'session-b' })
  const created = scheduler.submit({ prompt: 'fenced', ownerSessionId: 'session-a' })
  await scheduler.dispatch(created.task.id)
  const firstToken = scheduler.getTask(created.task.id).leaseToken
  now += 2_000
  const tick = await scheduler.tick()
  const requeued = scheduler.getTask(created.task.id)
  const requeuedStatus = requeued.status
  now += 60_000
  const dispatchAgain = await scheduler.dispatch(created.task.id)
  const second = scheduler.getTask(created.task.id)
  const secondToken = second.leaseToken
  const stale = scheduler.ingest({
    taskId: created.task.id,
    attempt: second.attempts,
    leaseToken: firstToken,
    status: 'succeeded',
    summary: 'stale should lose',
  })
  const accepted = scheduler.ingest({
    taskId: created.task.id,
    attempt: second.attempts,
    leaseToken: secondToken,
    status: 'succeeded',
    summary: 'new lease wins',
  })
  record('F4-stale-reply', scheduler, {
    pass:
      tick.ok === true &&
      requeuedStatus === 'queued' &&
      dispatchAgain.ok === true &&
      stale.reason === 'stale-lease' &&
      accepted.ok === true &&
      scheduler.getTask(created.task.id).result?.summary === 'new lease wins' &&
      scheduler.verify().ok,
    observed: {
      firstToken,
      secondToken,
      staleReason: stale.reason,
      accepted: accepted.ok,
      finalStatus: scheduler.getTask(created.task.id).status,
    },
    notes: ['lease expired; old token rejected; current token accepted'],
  })
}

// F5: malformed reply is rejected without mutating the task (fail closed).
{
  const dir = makeDir('malformed')
  const interconnect = new FakeInterconnect('ok')
  const scheduler = newScheduler(dir, interconnect)
  scheduler.registerWorker({ instanceId: 'dsh-b', sessionId: 'session-b' })
  const created = scheduler.submit({ prompt: 'malformed', ownerSessionId: 'session-a' })
  await scheduler.dispatch(created.task.id)
  const task = scheduler.getTask(created.task.id)
  const result = scheduler.ingest({
    taskId: created.task.id,
    attempt: task.attempts,
    leaseToken: task.leaseToken,
    text: 'not-json at all',
  })
  record('F5-malformed-reply', scheduler, {
    pass:
      result.ok === false &&
      result.reason === 'invalid-status' &&
      scheduler.getTask(created.task.id).status === 'running' &&
      scheduler.verify().ok,
    observed: { reason: result.reason, status: scheduler.getTask(created.task.id).status },
    notes: ['non-JSON reply is rejected by invalid-status; the task is unchanged'],
  })
}

// F6: oversized reply rejected before parsing.
{
  const dir = makeDir('oversized')
  const interconnect = new FakeInterconnect('ok')
  const scheduler = newScheduler(dir, interconnect)
  scheduler.registerWorker({ instanceId: 'dsh-b', sessionId: 'session-b' })
  const created = scheduler.submit({ prompt: 'oversized', ownerSessionId: 'session-a' })
  await scheduler.dispatch(created.task.id)
  const task = scheduler.getTask(created.task.id)
  const result = scheduler.ingest({
    taskId: created.task.id,
    attempt: task.attempts,
    leaseToken: task.leaseToken,
    text: 'x'.repeat(1024 * 1024 + 1),
  })
  record('F6-oversized-reply', scheduler, {
    pass: result.reason === 'reply-too-large' && scheduler.getTask(created.task.id).status === 'running' && scheduler.verify().ok,
    observed: { reason: result.reason, status: scheduler.getTask(created.task.id).status },
    notes: ['1 MiB + 1 byte reply is rejected before JSON parsing'],
  })
}

// F7: concurrent ticks dispatch one task once.
{
  const dir = makeDir('concurrent-tick')
  const interconnect = new FakeInterconnect('ok')
  const scheduler = newScheduler(dir, interconnect)
  scheduler.registerWorker({ instanceId: 'dsh-b', sessionId: 'session-b' })
  const created = scheduler.submit({ prompt: 'tick race', ownerSessionId: 'session-a' })
  const [a, b] = await Promise.all([scheduler.tick(), scheduler.tick()])
  record('F7-concurrent-tick', scheduler, {
    pass: a === b && interconnect.sent.length === 1 && scheduler.getTask(created.task.id).status === 'running' && scheduler.verify().ok,
    observed: { samePromise: a === b, sends: interconnect.sent.length, status: scheduler.getTask(created.task.id).status },
    notes: ['tick() must be single-flight'],
  })
}

// F8: hard journal truncation + state.json corruption.
{
  const dir = makeDir('journal-corruption')
  const interconnect = new FakeInterconnect('ok')
  const scheduler = newScheduler(dir, interconnect)
  scheduler.registerWorker({ instanceId: 'dsh-b', sessionId: 'session-b' })
  scheduler.submit({ prompt: 'durable', ownerSessionId: 'session-a' })
  fs.writeFileSync(scheduler.stateFile, '{broken', 'utf8')
  fs.appendFileSync(scheduler.journalFile, '{"seq":999,"type":"bogus"', 'utf8')
  const restarted = newScheduler(dir, new FakeInterconnect('ok'))
  record('F8-journal-corruption', restarted, {
    pass: restarted.verify().ok && Object.keys(restarted.state.tasks).length === 1,
    observed: { tasks: Object.keys(restarted.state.tasks).length, verify: restarted.verify() },
    notes: ['state.json corrupt + incomplete journal tail; replay survives'],
  })
}

const report = {
  generatedAt: new Date().toISOString(),
  artifactDir: outDir,
  scenarios: results.length,
  passed: results.filter((r) => r.pass).length,
  failed: results.filter((r) => !r.pass).length,
  results,
}
fs.writeFileSync(path.join(outDir, 'fault-report.json'), JSON.stringify(report, null, 2))
fs.writeFileSync(
  path.join(here, 'fault-report.json'),
  JSON.stringify({ generatedAt: report.generatedAt, artifactDir: outDir, scenarios: report.scenarios, passed: report.passed, failed: report.failed }, null, 2),
)
console.log(JSON.stringify({ artifactDir: outDir, scenarios: report.scenarios, passed: report.passed, failed: report.failed }, null, 2))
if (report.failed > 0) {
  for (const result of results.filter((r) => !r.pass)) console.error('FAIL', result.scenario, JSON.stringify(result.observed))
  process.exitCode = 1
}
