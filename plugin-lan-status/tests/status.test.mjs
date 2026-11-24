import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  buildAggregateStatus,
  buildSelfStatus,
  readSchedulerState,
  renderPanelHtml,
  sessionRows,
  taskRow,
  taskSection,
} from '../lib/status.js'

function tmpState(tasks = {}, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lan-status-test-'))
  const file = path.join(dir, 'state.json')
  fs.writeFileSync(file, JSON.stringify({ seq: 7, tasks, ...extra }))
  return file
}

function mockCtx() {
  return {
    agents: {
      list: () => [
        { id: 'session-b', status: 'running', session: { id: 'session-b', cwd: '/home/user/b' } },
        { id: 'session-a', status: 'idle', session: { id: 'session-a', cwd: '/home/user/a' } },
      ],
    },
    get(name) {
      if (name !== 'sessionProjections') return undefined
      return {
        snapshot(session) {
          if (session?.id === 'session-a') return { values: { title: 'Alpha' } }
          return { values: {} }
        },
      }
    },
  }
}

test('readSchedulerState tolerates missing and malformed files', () => {
  assert.equal(readSchedulerState(path.join(os.tmpdir(), 'does-not-exist-lan-status.json')), null)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lan-status-bad-'))
  const file = path.join(dir, 'bad.json')
  fs.writeFileSync(file, '{not json')
  assert.equal(readSchedulerState(file), null)
})

test('taskRow and taskSection normalize running/recent order', () => {
  const tasks = {
    a: { id: 'a', title: 'A', status: 'running', createdAt: '2026-01-01T00:00:02Z', attempts: 1 },
    b: { id: 'b', title: 'B', status: 'succeeded', createdAt: '2026-01-01T00:00:01Z', updatedAt: '2026-01-01T00:00:05Z', result: { summary: 'ok' } },
    c: { id: 'c', title: 'C', status: 'failed', createdAt: '2026-01-01T00:00:03Z', updatedAt: '2026-01-01T00:00:04Z', lastError: 'nope' },
  }
  const row = taskRow(tasks.a)
  assert.equal(row.id, 'a')
  assert.equal(row.attempts, 1)
  assert.equal(row.summary, null)
  const section = taskSection({ seq: 3, tasks })
  assert.equal(section.seq, 3)
  assert.deepEqual(section.running.map((x) => x.id), ['a'])
  assert.deepEqual(section.recent.map((x) => x.id), ['b', 'c'])
})

test('sessionRows sorts sessions and uses projection titles', () => {
  const rows = sessionRows(mockCtx())
  assert.deepEqual(rows.map((x) => x.sessionId), ['session-a', 'session-b'])
  assert.equal(rows[0].title, 'Alpha')
  assert.equal(rows[0].cwd, '/home/user/a')
})

test('buildSelfStatus coordinator includes tasks, agent omits them', () => {
  const file = tmpState({ t1: { id: 't1', title: 'T', status: 'running' } })
  const coordinator = buildSelfStatus({
    ctx: mockCtx(),
    config: { instanceId: 'dsh-a', role: 'coordinator', origin: 'http://a:3081', agentUrl: 'http://a:3091', schedulerStateFile: file, dshVersion: '0.2.2-rc.3' },
  })
  assert.equal(coordinator.ok, true)
  assert.equal(coordinator.node.instanceId, 'dsh-a')
  assert.equal(coordinator.node.role, 'coordinator')
  assert.equal(coordinator.node.dshVersion, '0.2.2-rc.3')
  assert.equal(coordinator.sessions.length, 2)
  assert.equal(coordinator.tasks.running.length, 1)

  const agent = buildSelfStatus({
    ctx: mockCtx(),
    config: { instanceId: 'dsh-b', role: 'agent' },
  })
  assert.equal(agent.node.role, 'agent')
  assert.equal(agent.tasks.total, 0)
})

test('buildAggregateStatus keeps self local and marks unreachable nodes offline', async () => {
  const self = buildSelfStatus({ ctx: mockCtx(), config: { instanceId: 'dsh-a', role: 'coordinator' } })
  const seen = []
  const aggregate = await buildAggregateStatus({
    ctx: mockCtx(),
    self,
    startedAt: '2026-01-01T00:00:00Z',
    config: {
      instanceId: 'dsh-a',
      role: 'coordinator',
      nodes: [
        { instanceId: 'dsh-a', label: 'A', role: 'coordinator', origin: 'http://a:3081', agentUrl: 'http://a:3091' },
        { instanceId: 'dsh-b', label: 'B', role: 'agent', origin: 'http://b:3082', agentUrl: 'http://b:3091' },
      ],
    },
    fetcher: async (node) => {
      seen.push(node.instanceId)
      return { ...node, online: false, error: 'timeout', sessions: [], tasks: { running: [], recent: [] } }
    },
  })
  assert.deepEqual(seen, ['dsh-b'])
  assert.equal(aggregate.summary.nodes, 2)
  assert.equal(aggregate.summary.online, 1)
  assert.equal(aggregate.summary.offline, 1)
  assert.equal(aggregate.nodes.find((x) => x.instanceId === 'dsh-a').online, true)
  assert.equal(aggregate.nodes.find((x) => x.instanceId === 'dsh-b').online, false)
})

test('renderPanelHtml returns a self-contained panel page', () => {
  const html = renderPanelHtml({ panelTitle: 'LAN Test · Nodes', coordinator: 'dsh-test' })
  assert.match(html, /LAN Test · Nodes/)
  assert.match(html, /fetch\('status'/)
  assert.match(html, /entryUrl/)
  assert.doesNotMatch(html, /entry-form|name="token"|launch token/)
  assert.doesNotMatch(html, /src="http/)
  assert.doesNotMatch(html, /\/open\//)
})
