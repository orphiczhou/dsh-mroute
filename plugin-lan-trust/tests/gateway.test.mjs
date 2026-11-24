import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { createLoginGateway } from '../lib/gateway.js'
import { parseAllowlist } from '../lib/trust.js'

const ORIGIN = 'http://127.0.0.1:3081'

function get(port, path = '/', method = 'GET') {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, path, method }, (response) => {
      const chunks = []
      response.on('data', chunk => chunks.push(chunk))
      response.on('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }))
    })
    request.on('error', reject)
    request.end()
  })
}

async function withGateway(options, run) {
  const gateway = createLoginGateway({
    origin: ORIGIN,
    entries: parseAllowlist(['127.0.0.1/32']),
    allowLoopback: true,
    ...options,
  })
  const address = await gateway.listen(0, '127.0.0.1')
  try {
    await run(address.port, gateway)
  } finally {
    await gateway.close()
  }
}

test('health reports whether the token has been captured', async () => {
  let token
  await withGateway({ getToken: () => token }, async (port) => {
    let response = await get(port, '/health')
    assert.equal(response.status, 503)
    assert.match(response.body, /tokenCaptured":false/u)
    token = 'abcdefghijklmnop'
    response = await get(port, '/health')
    assert.equal(response.status, 200)
    assert.match(response.body, /tokenCaptured":true/u)
  })
})

test('exchanges the token server-side and relays the session cookie', async () => {
  const seen = []
  const fetchImpl = async (url, init) => {
    seen.push({ url: String(url), init })
    return new Response(null, {
      status: 303,
      headers: { 'set-cookie': 'dsh-auth-test=v1.test; Path=/; HttpOnly' },
    })
  }
  await withGateway({ getToken: () => 'abcdefghijklmnop', fetchImpl }, async (port) => {
    const response = await get(port, '/')
    assert.equal(response.status, 302)
    assert.equal(response.headers.location, `${ORIGIN}/`)
    assert.match(response.headers['set-cookie']?.[0] ?? '', /dsh-auth-test=v1\.test/u)
    assert.equal(seen.length, 1)
    assert.equal(new URL(seen[0].url).searchParams.get('token'), 'abcdefghijklmnop')
    assert.equal(seen[0].init.redirect, 'manual')
  })
})

test('does not exchange without a token', async () => {
  let called = 0
  await withGateway({
    getToken: () => undefined,
    fetchImpl: async () => {
      called += 1
      return new Response(null, { status: 303 })
    },
  }, async (port) => {
    const response = await get(port, '/')
    assert.equal(response.status, 503)
    assert.equal(called, 0)
  })
})

test('rejects non-trusted sources when loopback bypass is off', async () => {
  const gateway = createLoginGateway({
    getToken: () => 'abcdefghijklmnop',
    origin: ORIGIN,
    entries: parseAllowlist(['192.168.3.0/24']),
    allowLoopback: false,
  })
  const address = await gateway.listen(0, '127.0.0.1')
  try {
    const response = await get(address.port, '/')
    assert.equal(response.status, 403)
  } finally {
    await gateway.close()
  }
})

test('rejects non-GET methods and failed exchanges', async () => {
  await withGateway({
    getToken: () => 'abcdefghijklmnop',
    fetchImpl: async () => new Response('nope', { status: 401 }),
  }, async (port) => {
    const post = await get(port, '/', 'POST')
    assert.equal(post.status, 405)
    const failed = await get(port, '/')
    assert.equal(failed.status, 502)
  })
})
