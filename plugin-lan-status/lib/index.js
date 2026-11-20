/**
 * LAN status panel — host half.
 *
 * Each DSH web node loads this plugin with the same package name but a
 * deployment-specific config. The coordinator exposes the aggregate panel;
 * every node exposes `/self` for the coordinator to poll.
 *
 * This plugin intentionally has no DSH client half: a standalone HTTP page is
 * enough for a read-only status view and avoids coupling to the DSH client
 * graph. See README.md for the profile patch example.
 */
import { createStatusServer } from './server.js'

export const name = 'lan-status'
export const inject = ['agents']

export function apply(ctx, config = {}) {
  const startedAt = new Date().toISOString()
  const logger = ctx?.logger
  const instance = createStatusServer({ ctx, config, logger, startedAt })

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

  return {
    server: instance,
    close: () => instance.close(),
  }
}
