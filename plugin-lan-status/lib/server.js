/**
 * Minimal read-only HTTP surface for the LAN status panel.
 *
 * Routes:
 *   GET /health  -> liveness + role
 *   GET /self    -> this node's status (agent and coordinator)
 *   GET /status  -> aggregate status (coordinator only)
 *   GET /        -> standalone HTML panel (coordinator only)
 *
 * The server deliberately has no auth and no write routes. It is meant for a
 * trusted LAN segment; the DSH entry URLs themselves still require each
 * node's launch token.
 */
import http from 'node:http'

import { buildAggregateStatus, buildSelfStatus, renderPanelHtml } from './status.js'

const SECURITY_HEADERS = {
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'permissions-policy': 'geolocation=(), microphone=(), camera=()',
  'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; form-action http: https:; base-uri 'self'; frame-ancestors 'none'",
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    ...SECURITY_HEADERS,
  })
  res.end(body)
}

function sendText(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, {
    'content-type': type,
    'content-length': Buffer.byteLength(body),
    ...SECURITY_HEADERS,
  })
  res.end(body)
}

function sendEmpty(res, status) {
  res.writeHead(status, {
    ...SECURITY_HEADERS,
  })
  res.end()
}

function normalizeConfig(config = {}) {
  const role = config.role === 'coordinator' ? 'coordinator' : 'agent'
  return {
    instanceId: typeof config.instanceId === 'string' && config.instanceId !== '' ? config.instanceId : 'dsh',
    label: typeof config.label === 'string' && config.label !== '' ? config.label : undefined,
    role,
    host: typeof config.host === 'string' && config.host !== '' ? config.host : '0.0.0.0',
    port: Number.isInteger(config.port) ? config.port : 3091,
    origin: typeof config.origin === 'string' ? config.origin : '',
    agentUrl: typeof config.agentUrl === 'string' ? config.agentUrl : '',
    dshVersion: typeof config.dshVersion === 'string' ? config.dshVersion : '',
    schedulerStateFile: typeof config.schedulerStateFile === 'string' ? config.schedulerStateFile : '',
    requestTimeoutMs: Number.isFinite(config.requestTimeoutMs) ? config.requestTimeoutMs : 2500,
    cacheTtlMs: Number.isFinite(config.cacheTtlMs) ? config.cacheTtlMs : 2000,
    nodes: Array.isArray(config.nodes) ? config.nodes : undefined,
    panelTitle: typeof config.panelTitle === 'string' ? config.panelTitle : '',
  }
}

/**
 * Create (but do not start) the status HTTP server.
 * @param {{ctx: object, config?: object, logger?: object, startedAt?: string}} options
 */
export function createStatusServer({ ctx, config = {}, logger, startedAt = null } = {}) {
  const cfg = normalizeConfig(config)
  const selfStartedAt = startedAt || new Date().toISOString()
  let aggregateCache = null
  let closed = false

  async function selfPayload() {
    return buildSelfStatus({ ctx, config: cfg, logger, startedAt: selfStartedAt })
  }

  async function aggregatePayload() {
    const now = Date.now()
    if (aggregateCache && now - aggregateCache.at < cfg.cacheTtlMs) return aggregateCache.value
    const self = await selfPayload()
    const value = await buildAggregateStatus({ ctx, config: cfg, self, logger, startedAt: selfStartedAt })
    aggregateCache = { at: now, value }
    return value
  }

  const server = http.createServer(async (req, res) => {
    try {
      const method = req.method || 'GET'
      if (method !== 'GET' && method !== 'HEAD') {
        res.setHeader('allow', 'GET, HEAD')
        sendJson(res, 405, { ok: false, error: 'method-not-allowed' })
        return
      }
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
      const path = url.pathname
      const head = method === 'HEAD'

      if (path === '/health') {
        if (head) return sendEmpty(res, 200)
        sendJson(res, 200, {
          ok: true,
          instanceId: cfg.instanceId,
          label: cfg.label || cfg.instanceId,
          role: cfg.role,
          pid: process.pid,
          uptimeSec: Math.round(process.uptime()),
        })
        return
      }

      if (path === '/self') {
        const value = await selfPayload()
        if (head) return sendEmpty(res, 200)
        sendJson(res, 200, value)
        return
      }

      if (path === '/status') {
        if (cfg.role !== 'coordinator') {
          sendJson(res, 404, { ok: false, error: 'not-coordinator' })
          return
        }
        const value = url.searchParams.get('refresh') === '1' ? await (async () => {
          aggregateCache = null
          return aggregatePayload()
        })() : await aggregatePayload()
        if (head) return sendEmpty(res, 200)
        sendJson(res, 200, value)
        return
      }

      if (path === '/') {
        if (head) return sendEmpty(res, 200)
        if (cfg.role === 'coordinator') {
          sendText(res, 200, renderPanelHtml({ panelTitle: cfg.panelTitle, coordinator: cfg.instanceId }), 'text/html; charset=utf-8')
        } else {
          sendText(
            res,
            200,
            `LAN status agent: ${cfg.instanceId}\nThis node serves /self and /health. Open the coordinator panel instead.\n`,
          )
        }
        return
      }

      sendJson(res, 404, { ok: false, error: 'not-found' })
    } catch (error) {
      logger?.error?.(`[lan-status] request failed: ${error?.stack || error}`)
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: 'internal-error' })
      else res.end()
    }
  })

  return {
    config: cfg,
    server,
    /** Start listening; resolves with the actual bound port. */
    async start() {
      if (closed) throw new Error('server already closed')
      await new Promise((resolve, reject) => {
        const onError = (error) => {
          server.off('listening', onListening)
          reject(error)
        }
        const onListening = () => {
          server.off('error', onError)
          resolve()
        }
        server.once('error', onError)
        server.once('listening', onListening)
        server.listen(cfg.port, cfg.host)
      })
      const address = server.address()
      logger?.info?.(`[lan-status] ${cfg.instanceId} (${cfg.role}) listening on ${cfg.host}:${address?.port}`)
      return address?.port ?? cfg.port
    },
    /** Stop listening and drop keep-alive sockets. */
    async close() {
      if (closed) return
      closed = true
      aggregateCache = null
      await new Promise((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections?.()
      })
    },
    address() {
      return server.address()
    },
  }
}

export { buildAggregateStatus, buildSelfStatus, renderPanelHtml }
