import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { apply } from '../lib/index.js'

function makeContext(stateFile) {
  const tools = new Map()
  const effects = []
  const sent = []
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    tools: {
      register(tool) {
        tools.set(tool.name, tool)
        return () => tools.delete(tool.name)
      },
    },
    interconnect: {
      selfSender(sessionId) {
        return { instanceId: 'dsh-a', sessionId }
      },
      async send(message) {
        sent.push(message)
        return { delivered: true, instance: message.instanceId, delivery: 'followup' }
      },
    },
    effect(fn, label) {
      effects.push({ fn, label })
    },
  }
  const handle = apply(ctx, { stateFile, instanceId: 'dsh-a' })
  return { ctx, tools, effects, sent, handle }
}

test('plugin registers all scheduler tools and a submit/ingest round trip works', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lan-sched-plugin-'))
  const stateFile = path.join(dir, 'state.json')
  const { tools, effects, sent, handle } = makeContext(stateFile)
  const names = [...tools.keys()].sort()
  assert.deepEqual(names, [
    'sched_cancel',
    'sched_ingest',
    'sched_list',
    'sched_stats',
    'sched_status',
    'sched_submit',
    'sched_tick',
    'sched_worker_list',
    'sched_worker_register',
  ])
  assert.equal(effects.length, names.length + 1)

  const exec = { agent: { session: { id: 'session-a' } } }
  const registered = await tools.get('sched_worker_register').execute(
    { instanceId: 'dsh-b', sessionId: 'session-b' },
    exec,
  )
  assert.equal(registered.ok, true)

  const submitted = await tools.get('sched_submit').execute(
    { title: 'smoke', prompt: 'say OK' },
    exec,
  )
  assert.equal(submitted.ok, true)
  assert.equal(submitted.dispatch.ok, true)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].sender.sessionId, 'session-a')

  const taskId = submitted.task.id
  const current = await tools.get('sched_status').execute({ taskId }, exec)
  assert.equal(current.ok, true)
  const ingested = await tools.get('sched_ingest').execute(
    {
      taskId,
      attempt: current.task.attempts,
      lease_token: current.task.leaseToken,
      text: JSON.stringify({ task_id: taskId, status: 'succeeded', summary: 'OK', files: [] }),
    },
    exec,
  )
  assert.equal(ingested.ok, true)

  const status = await tools.get('sched_status').execute({ taskId }, exec)
  assert.equal(status.task.status, 'succeeded')
  assert.equal(status.task.result.summary, 'OK')

  const stats = await tools.get('sched_stats').execute({}, exec)
  assert.equal(stats.ok, true)
  assert.equal(stats.tasks, 1)
  handle.dispose()
})
