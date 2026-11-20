import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { LanScheduler } from '../lib/scheduler.js'

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lan-sched-journal-'))
}

function fakeInterconnect() {
  return {
    selfSender(sessionId) {
      return { instanceId: 'dsh-a', sessionId }
    },
    async send(message) {
      return { delivered: true, instance: message.instanceId, delivery: 'followup' }
    },
  }
}

function makeScheduler(dir) {
  const scheduler = new LanScheduler({
    stateFile: path.join(dir, 'state.json'),
    journalFile: path.join(dir, 'journal.jsonl'),
    interconnect: fakeInterconnect(),
    now: () => Date.parse('2026-11-20T11:00:00.000Z'),
    logger: { info() {}, warn() {} },
  })
  scheduler.load()
  return scheduler
}

test('journal replay equals live state after a full round trip', async () => {
  const dir = tempDir()
  const scheduler = makeScheduler(dir)
  scheduler.registerWorker({ instanceId: 'dsh-b', sessionId: 'session-b' })
  const created = scheduler.submit({ prompt: 'journal me', ownerSessionId: 'session-a' })
  await scheduler.dispatch(created.task.id)
  const leased = scheduler.getTask(created.task.id)
  scheduler.ingest({
    taskId: created.task.id,
    attempt: leased.attempts,
    leaseToken: leased.leaseToken,
    status: 'succeeded',
    summary: 'ok',
  })

  const verified = scheduler.verify()
  assert.equal(verified.ok, true, verified.error)
  assert.equal(verified.events > 0, true)

  const reloaded = makeScheduler(dir)
  const task = reloaded.getTask(created.task.id)
  assert.equal(task.status, 'succeeded')
  assert.equal(task.result.summary, 'ok')
  assert.equal(reloaded.verify().ok, true)
})

test('journal recovers when state.json is corrupt', async () => {
  const dir = tempDir()
  const scheduler = makeScheduler(dir)
  scheduler.registerWorker({ instanceId: 'dsh-b', sessionId: 'session-b' })
  const created = scheduler.submit({ prompt: 'recover me', ownerSessionId: 'session-a' })

  fs.writeFileSync(path.join(dir, 'state.json'), '{not json', 'utf8')
  const reloaded = makeScheduler(dir)
  assert.equal(reloaded.getTask(created.task.id).prompt, 'recover me')
  assert.equal(reloaded.listWorkers().length, 1)
  assert.equal(reloaded.verify().ok, true)
})

test('journal truncates an incomplete final line and still replays', async () => {
  const dir = tempDir()
  const scheduler = makeScheduler(dir)
  scheduler.registerWorker({ instanceId: 'dsh-b', sessionId: 'session-b' })
  const created = scheduler.submit({ prompt: 'truncated tail', ownerSessionId: 'session-a' })

  fs.appendFileSync(path.join(dir, 'journal.jsonl'), '{"v":1,"seq":999', 'utf8')
  const reloaded = makeScheduler(dir)
  assert.equal(reloaded.getTask(created.task.id).prompt, 'truncated tail')
  assert.equal(reloaded.verify().ok, true)
  const raw = fs.readFileSync(path.join(dir, 'journal.jsonl'), 'utf8')
  assert.equal(raw.endsWith('\n'), true)
})

test('journal hash tamper is detected by verify', async () => {
  const dir = tempDir()
  const scheduler = makeScheduler(dir)
  scheduler.registerWorker({ instanceId: 'dsh-b', sessionId: 'session-b' })
  scheduler.submit({ prompt: 'tamper me', ownerSessionId: 'session-a' })

  const journalPath = path.join(dir, 'journal.jsonl')
  const lines = fs.readFileSync(journalPath, 'utf8').split('\n').filter(Boolean)
  lines[lines.length - 1] = lines[lines.length - 1].replace('tamper me', 'tampered!')
  fs.writeFileSync(journalPath, `${lines.join('\n')}\n`, 'utf8')

  assert.equal(scheduler.verify().ok, false)
})

test('mid-file corruption refuses load, keeps the file and writes a backup', () => {
  const dir = tempDir()
  const scheduler = makeScheduler(dir)
  scheduler.registerWorker({ instanceId: 'dsh-b', sessionId: 'session-b' })
  scheduler.submit({ prompt: 'keep me', ownerSessionId: 'session-a' })

  const journalPath = path.join(dir, 'journal.jsonl')
  const lines = fs.readFileSync(journalPath, 'utf8').split('\n').filter(Boolean)
  assert.ok(lines.length >= 3)
  lines[1] = '{"v":1,"seq":1,"type":"broken"'
  fs.writeFileSync(journalPath, `${lines.join('\n')}\n`, 'utf8')
  const corrupt = fs.readFileSync(journalPath, 'utf8')

  assert.throws(() => makeScheduler(dir), /journal corruption/)
  assert.equal(fs.readFileSync(journalPath, 'utf8'), corrupt)
  assert.ok(fs.readdirSync(dir).some((name) => name.includes('.corrupt-')))
})
