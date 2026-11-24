/**
 * Same-origin bridge from the DSH web server to the standalone status panel.
 *
 * The client half embeds `/lan-status/` in an iframe. Serving that path from
 * the DSH origin avoids a second origin, CORS, and frame-ancestors changes on
 * the panel server. The bridge is deliberately read-only and strips the
 * `/lan-status` prefix before forwarding to the panel's origin.
 */
import http from 'node:http'
import https from 'node:https'

const PREFIX = '/lan-status'

function upstreamPath(rawUrl) {
  const url = new URL(rawUrl || '/', 'http://lan-status.local')
  const rest = url.pathname === PREFIX ? '/' : url.pathname.slice(PREFIX.length) || '/'
  return rest + url.search
}

/**
 * Create a WebServer route handler that proxies /lan-status/* to `panelUrl`.
 * @param {string} panelUrl origin of the standalone panel, e.g. http://192.168.3.23:3091
 */
export function createPanelProxy(panelUrl) {
  const target = new URL(panelUrl)
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    throw new Error(`panelUrl must be http(s): ${panelUrl}`)
  }
  const transport = target.protocol === 'https:' ? https : http
  const port = target.port ? Number(target.port) : undefined

  return function panelProxy(req, res) {
    const path = upstreamPath(req.url)
    const headers = { ...req.headers, host: target.host }
    // Do not let an upstream compression negotiation make the bridge's own
    // response headers disagree with the body.
    delete headers['accept-encoding']

    const upstream = transport.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port,
        method: req.method,
        path,
        headers,
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers)
        upstreamRes.pipe(res)
      },
    )

    upstream.on('error', (error) => {
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
      }
      res.end(`lan-status panel upstream unavailable: ${error.message}`)
    })
    req.on('aborted', () => upstream.destroy())
    req.pipe(upstream)
  }
}

export { PREFIX }
