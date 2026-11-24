/** Trusted-LAN auto-login gateway for DSH Web.
 *
 * DSH Web deliberately requires a per-process launch token or a signed API
 * cookie. This plugin does not change that authentication path. It captures the
 * launch token from this process's own startup line, exchanges it for the DSH
 * session cookie *server-side*, and hands the cookie to a browser that comes
 * from an allowlisted LAN address. The browser never sees the launch token.
 *
 * Anyone inside the allowlist obtains owner-level access. This is intended for a
 * trusted, non-routable LAN only; it must not be exposed to the public internet
 * or placed behind an untrusted reverse proxy.
 */
import { appendFileSync } from 'node:fs'
import { createLoginGateway } from './gateway.js'
import { getTokenCapture, installTokenCapture } from './token.js'
import { describeAllowlist, parseAllowlist } from './trust.js'

export const name = 'lan-trust'

function debug(message) {
  if (process.env.LAN_TRUST_DEBUG !== '1') return
  try {
    const dir = process.env.DSH_HOME || process.env.TEMP || '.'
    appendFileSync(`${dir}/lan-trust-debug.log`, `${new Date().toISOString()} ${message}\n`)
  } catch {}
}
debug('module loaded')

const DEFAULT_CIDRS = ['192.168.3.0/24', '127.0.0.1/32', '::1/128']
const DEFAULT_PORT = 3095

function parsePort(value) {
  const port = Number(value ?? DEFAULT_PORT)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`lan-trust: invalid gateway port ${JSON.stringify(value)}`)
  }
  return port
}

export async function apply(ctx, config = {}) {
  debug(`apply enabled=${String(config?.enabled)} port=${String(config?.port)} origin=${String(config?.origin)}`)
  if (config?.enabled === false) return

  // Capture must be installed while the profile is loading, before `dsh web`
  // prints its one-time start URL. Module evaluation happens that early.
  installTokenCapture()
  const capture = getTokenCapture()

  let entries
  let port
  let origin
  try {
    entries = parseAllowlist(config.allowedCidrs ?? DEFAULT_CIDRS)
    port = parsePort(config.port)
    origin = config.origin
    if (typeof origin !== 'string' || origin.length === 0) {
      throw new Error('lan-trust: config.origin is required, e.g. http://192.168.3.23:3081')
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    ctx.logger?.error?.(message)
    return
  }

  const host = config.host ?? '0.0.0.0'
  const gateway = createLoginGateway({
    getToken: () => capture?.get(),
    origin,
    entries,
    allowLoopback: config.allowLoopback !== false,
    logger: ctx.logger,
  })

  try {
    await gateway.listen(port, host)
    debug(`listening on ${host}:${port}`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    debug(`listen failed: ${message}`)
    ctx.logger?.error?.(`lan-trust: cannot listen on ${host}:${port}: ${message}`)
    return
  }

  ctx.logger?.info?.(
    `lan-trust: auto-login gateway on http://${host}:${port}/ -> ${origin}/ for ${describeAllowlist(entries)}`,
  )

  ctx.effect(() => () => gateway.close(), 'lan-trust: close auto-login gateway')
}
