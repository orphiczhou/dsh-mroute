import assert from 'node:assert/strict'
import test from 'node:test'

import { createStatusServer } from '../lib/server.js'

function mockCtx() {
  return {
    agents: {
      list: () => [{ id: 'session-1', status: 'idle', session: { id: 'session-1', cwd: '/tmp' } }],
    },
    get() {
      return undefined
    },
  }
}

async function startServer(config) {
  const instance = createStatusServer({ ctx: mockCtx(), config, startedAt: '2026-01-01T00:00:00Z' })
  const port = await instance.start()
  const base = `http://127.0.0.1:${port}`
  return { instance, port, base }
}

test('coordinator server exposes health, self, status and HTML', async () => {
  const { instance, base } = await startServer({
    instanceId: 'test-a',
    label: 'Test A',
    role: 'coordinator',
    host: '127.0.0.1',
    port: 0,
    origin: 'http://127.0.0.1:3081',
    agentUrl: 'http://127.0.0.1:3091',
    dshVersion: '0.2.2-rc.3',
    nodes: [{ instanceId: 'test-a', label: 'Test A', role: 'coordinator', origin: 'http://127.0.0.1:3081', agentUrl: 'http://127.0.0.1:3091' }],
  })
  try {
    const health = await fetch(`${base}/health`)
    assert.equal(health.status, 200)
    const healthBody = await health.json()
    assert.equal(healthBody.instanceId, 'test-a')
    assert.equal(healthBody.role, 'coordinator')

    const self = await fetch(`${base}/self`)
    assert.equal(self.status, 200)
    const selfBody = await self.json()
    assert.equal(selfBody.node.role, 'coordinator')
    assert.equal(selfBody.sessions.length, 1)

    const status = await fetch(`${base}/status`)
    assert.equal(status.status, 200)
    const statusBody = await status.json()
    assert.equal(statusBody.summary.nodes, 1)
    assert.equal(statusBody.summary.online, 1)
    assert.equal(statusBody.nodes[0].instanceId, 'test-a')

    const html = await fetch(`${base}/`)
    assert.equal(html.status, 200)
    assert.match(html.headers.get('content-type') || '', /text\/html/)
    assert.match(html.headers.get('content-security-policy') || '', /frame-ancestors 'self'/)
    assert.equal(html.headers.get('access-control-allow-origin'), null)
    assert.match(await html.text(), /LAN DSH/)

    const legacyOpen = await fetch(`${base}/open/test-a`)
    assert.equal(legacyOpen.status, 404)

    const missing = await fetch(`${base}/nope`)
    assert.equal(missing.status, 404)

    const method = await fetch(`${base}/health`, { method: 'POST' })
    assert.equal(method.status, 405)
  } finally {
    await instance.close()
  }
})

test('agent server serves /self but not /status', async () => {
  const { instance, base } = await startServer({
    instanceId: 'test-b',
    label: 'Test B',
    role: 'agent',
    host: '127.0.0.1',
    port: 0,
    origin: 'http://127.0.0.1:3082',
    agentUrl: 'http://127.0.0.1:3091',
  })
  try {
    const self = await fetch(`${base}/self`)
    assert.equal(self.status, 200)
    const body = await self.json()
    assert.equal(body.node.role, 'agent')

    const status = await fetch(`${base}/status`)
    assert.equal(status.status, 404)
    assert.equal((await status.json()).error, 'not-coordinator')

    const root = await fetch(`${base}/`)
    assert.equal(root.status, 200)
    assert.match(await root.text(), /LAN status agent/)
  } finally {
    await instance.close()
  }
})

test('server start rejects an invalid port and close is idempotent', async () => {
  const instance = createStatusServer({
    ctx: mockCtx(),
    config: { instanceId: 'test-c', role: 'agent', host: '127.0.0.1', port: 0 },
  })
  await assert.rejects(() => instance.start().then(() => instance.start()))
  await instance.close()
  await instance.close()
})
