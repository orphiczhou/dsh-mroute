/** Trusted-LAN auto-login gateway for a DSH Web server.
 *
 * The gateway is a tiny, separate HTTP listener. A browser inside the configured
 * CIDRs opens the gateway; the gateway exchanges the process launch token for
 * the target DSH's signed HttpOnly API cookie *server-side*, relays that cookie
 * to the browser, and redirects to the clean DSH URL. The launch token never
 * appears in the browser URL, page, or JS.
 *
 * This grants owner-level access to anyone inside the allowlist. It is meant for
 * a trusted, non-routable LAN only and deliberately does not implement a second
 * authentication factor.
 */
import http from 'node:http'
import { isTrustedRequest } from './trust.js'

function send(res, status, body, headers = {}) {
  const text = body ?? ''
  res.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'text/plain; charset=utf-8',
    ...headers,
  })
  res.end(text)
}

function parseOrigin(origin) {
  let url
  try {
    url = new URL(origin)
  } catch {
    throw new Error('lan-trust: origin must be an absolute http(s) URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('lan-trust: origin must use http or https')
  }
  return url
}

/**
 * @param {object} options
 * @param {() => string | undefined} options.getToken
 * @param {string} options.origin - target DSH Web origin, e.g. http://192.168.3.23:3081
 * @param {ReturnType<import('./trust.js').parseAllowlist>} options.entries
 * @param {boolean} [options.allowLoopback]
 * @param {typeof fetch} [options.fetchImpl] - injectable for tests
 * @param {{info?:Function,warn?:Function,error?:Function}} [options.logger]
 */
export function createLoginGateway({ getToken, origin, entries, allowLoopback = true, fetchImpl = fetch, logger } = {}) {
  const target = parseOrigin(origin)
  const targetIndex = new URL(target.href)
  targetIndex.pathname = '/'

  const server = http.createServer(async (req, res) => {
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        send(res, 405, 'method not allowed', { allow: 'GET, HEAD' })
        return
      }
      const url = new URL(req.url ?? '/', 'http://gateway.invalid')
      if (url.pathname === '/health') {
        const token = getToken()
        send(res, token ? 200 : 503, JSON.stringify({ ok: token !== undefined, tokenCaptured: token !== undefined }), {
          'content-type': 'application/json; charset=utf-8',
        })
        return
      }
      if (url.pathname !== '/' && url.pathname !== '/login') {
        send(res, 404, 'not found')
        return
      }
      if (!isTrustedRequest(req, entries, allowLoopback)) {
        send(res, 403, 'this source is not in the trusted LAN allowlist')
        return
      }
      const token = getToken()
      if (token === undefined) {
        send(res, 503, 'launch token is not captured yet; retry shortly')
        return
      }

      targetIndex.search = ''
      targetIndex.searchParams.set('token', token)
      const upstream = await fetchImpl(targetIndex, {
        method: 'GET',
        redirect: 'manual',
        headers: { accept: 'text/html' },
      })
      const cookies = typeof upstream.headers.getSetCookie === 'function'
        ? upstream.headers.getSetCookie()
        : []
      if (upstream.status !== 303 && upstream.status !== 302) {
        logger?.warn?.(`lan-trust: token exchange returned HTTP ${upstream.status}`)
        send(res, 502, 'the DSH token exchange did not return a session cookie')
        return
      }
      if (cookies.length === 0) {
        logger?.warn?.('lan-trust: token exchange returned no Set-Cookie')
        send(res, 502, 'the DSH token exchange returned no session cookie')
        return
      }
      const headers = {
        location: `${target.origin}/`,
        'set-cookie': cookies,
      }
      res.writeHead(302, {
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
        ...headers,
      })
      res.end()
    } catch (error) {
      logger?.error?.(`lan-trust: gateway error: ${error instanceof Error ? error.message : String(error)}`)
      if (!res.headersSent) send(res, 502, 'gateway error')
      else res.destroy()
    }
  })

  return {
    server,
    start(host = '0.0.0.0') {
      return new Promise((resolve, reject) => {
        const onError = (error) => {
          server.off('listening', onListening)
          reject(error)
        }
        const onListening = () => {
          server.off('error', onError)
          resolve(server.address())
        }
        server.once('error', onError)
        server.once('listening', onListening)
        server.listen(0, host)
      })
    },
    listen(port, host = '0.0.0.0') {
      return new Promise((resolve, reject) => {
        const onError = (error) => {
          server.off('listening', onListening)
          reject(error)
        }
        const onListening = () => {
          server.off('error', onError)
          resolve(server.address())
        }
        server.once('error', onError)
        server.once('listening', onListening)
        server.listen(port, host)
      })
    },
    close() {
      return new Promise((resolve) => {
        server.closeAllConnections?.()
        server.close(() => resolve())
      })
    },
  }
}
