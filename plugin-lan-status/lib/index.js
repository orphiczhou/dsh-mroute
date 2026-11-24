/**
 * LAN status panel — host half.
 *
 * Each DSH web node loads this plugin with the same package name but a
 * deployment-specific config. The coordinator exposes the aggregate panel;
 * every node exposes `/self` for the coordinator to poll.
 *
 * The optional client half embeds `/lan-status/` from the DSH origin. This
 * host half registers that same-origin prefix and proxies it to the standalone
 * panel server, so the client needs neither CORS nor a second frame origin.
 */
import { createStatusServer } from './server.js'
import { createPanelProxy } from './panel-proxy.js'

export const name = 'lan-status'
export const inject = ['agents']

export function apply(ctx, config = {}) {
  const startedAt = new Date().toISOString()
  const logger = ctx?.logger
  const serve = config.serve !== false
  const panelUrl = typeof config.panelUrl === 'string' ? config.panelUrl : ''
  let instance = null

  if (serve) {
    instance = createStatusServer({ ctx, config, logger, startedAt })
    ctx.effect(() => {
      let stopped = false
      instance.start().catch((error) => {
        if (stopped) return
        logger?.error?.(`[lan-status] failed to start on ${instance.config.host}:${instance.config.port}: ${error?.stack || error}`)
      })
      return () => {
        stopped = true
        void instance.close()
      }
    }, 'lan-status-http')
  }

  // The DSH web server is optional: headless nodes still run the standalone
  // panel server, while web nodes also get a same-origin route for the client.
  if (panelUrl) {
    ctx.inject(['webServer'], (wctx) => {
      wctx.effect(
        () => wctx.webServer.register({ kind: 'prefix', path: '/lan-status', handler: createPanelProxy(panelUrl) }),
        'lan-status-panel-route',
      )
      logger?.info?.(`[lan-status] client panel mounted at /lan-status -> ${panelUrl}`)
    })
  }

  return {
    server: instance,
    close: () => instance?.close(),
  }
}
