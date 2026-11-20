/**
 * dsh-lan-scheduler — host plugin.
 *
 * Exposes a small set of agent-facing tools over one durable JSON ledger:
 * worker registration, task submit/status/list/cancel, reply ingestion and tick.
 * Delivery uses the dsh-interconnect Service directly (ctx.interconnect.send),
 * so no WebSocket server or extra port is opened here.
 */
import os from 'node:os'
import path from 'node:path'
import { LanScheduler } from './scheduler.js'

export const name = 'lan-scheduler'
export const inject = ['tools', 'interconnect']

const OUTPUT = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => [
    { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) },
  ],
}

function resultText(value) {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2)
}

function registerTool(ctx, tool) {
  const dispose = ctx.tools.register(tool)
  if (typeof dispose === 'function' && typeof ctx.effect === 'function') {
    ctx.effect(() => dispose, `lan-scheduler:${tool.name}`)
  }
  return dispose
}

function ownerSessionId(exec) {
  return exec?.agent?.session?.id ?? exec?.session?.id ?? null
}

export function apply(ctx, config = {}) {
  const logger = ctx.logger ?? { info() {}, warn() {}, error() {} }
  const stateFile =
    (typeof config.stateFile === 'string' && config.stateFile.trim()) ||
    process.env.DSH_LAN_SCHEDULER_STATE ||
    path.join(os.homedir(), '.dsh-lan-scheduler', 'state.json')
  const instanceId = typeof config.instanceId === 'string' && config.instanceId.trim() ? config.instanceId.trim() : null
  const scheduler = new LanScheduler({
    stateFile,
    interconnect: ctx.interconnect,
    logger,
    leaseMs: Number(config.leaseMs) > 0 ? Number(config.leaseMs) : undefined,
    maxAttempts: Number(config.maxAttempts) > 0 ? Number(config.maxAttempts) : undefined,
    dispatchTimeoutMs: Number(config.dispatchTimeoutMs) > 0 ? Number(config.dispatchTimeoutMs) : undefined,
  })
  scheduler.load()
  logger.info?.(`[lan-scheduler] state: ${stateFile}`)

  registerTool(ctx, {
    name: 'sched_worker_register',
    description:
      'Register a live DSH session as a scheduler worker. The worker must be reachable through dsh-interconnect and able to call interconnect_reply. ' +
      'Use sched_worker_list to inspect registrations. Idempotent for the same instanceId+sessionId.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        instanceId: { type: 'string', description: 'Interconnect instance id, e.g. dsh-b' },
        sessionId: { type: 'string', description: 'Live DSH session id on that instance' },
        label: { type: 'string', description: 'Human label, e.g. .23 build worker' },
        maxConcurrent: { type: 'number', description: 'Maximum simultaneous tasks (default 1)' },
      },
      required: ['instanceId', 'sessionId'],
    },
    output: OUTPUT,
    async execute(args) {
      const worker = scheduler.registerWorker(args)
      return { ok: true, worker }
    },
  })

  registerTool(ctx, {
    name: 'sched_worker_list',
    description: 'List scheduler workers with their active task counts. Filter by status if needed.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { status: { type: 'string', description: 'idle | busy | offline' } },
    },
    output: OUTPUT,
    async execute(args) {
      return { ok: true, workers: scheduler.listWorkers(args) }
    },
  })

  registerTool(ctx, {
    name: 'sched_submit',
    description:
      'Submit a task to the LAN scheduler. It is delivered to an idle worker through dsh-interconnect (followup delivery, resume enabled). ' +
      'The worker must reply once with a JSON object; then call sched_ingest with that reply text. Returns immediately if no worker is free: the task stays durable and queued.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        title: { type: 'string', description: 'Short task title' },
        prompt: { type: 'string', description: 'Full self-contained task instructions for the worker' },
        priority: { type: 'number', description: 'Higher dispatches first (default 0)' },
        targetWorkerId: { type: 'string', description: 'Optional explicit worker id' },
        targetInstanceId: { type: 'string', description: 'Optional target instance id' },
        dedupeKey: { type: 'string', description: 'Optional idempotency key; an active duplicate is reused' },
        maxAttempts: { type: 'number', description: 'Retry budget for transport failures (default 3)' },
      },
      required: ['prompt'],
    },
    output: OUTPUT,
    async execute(args, exec) {
      const owner = ownerSessionId(exec)
      if (!owner) throw new Error('sched_submit requires an agent session')
      const created = scheduler.submit({ ...args, ownerInstanceId: instanceId, ownerSessionId: owner })
      if (created.duplicate) return { ok: true, duplicate: true, task: created.task, dispatch: null }
      const dispatch = await scheduler.dispatch(created.task.id)
      return { ok: true, duplicate: false, task: scheduler.getTask(created.task.id), dispatch }
    },
  })

  registerTool(ctx, {
    name: 'sched_status',
    description: 'Read one task, including its prompt, attempts, worker, timestamps and result.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { taskId: { type: 'string' } },
      required: ['taskId'],
    },
    output: OUTPUT,
    async execute(args) {
      const task = scheduler.getTask(args.taskId)
      if (!task) return { ok: false, reason: 'task-not-found', taskId: args.taskId }
      return { ok: true, task }
    },
  })

  registerTool(ctx, {
    name: 'sched_list',
    description: 'List recent tasks (compact view), newest first. Filter by comma-separated status.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        status: { type: 'string', description: 'e.g. queued,running' },
        limit: { type: 'number', description: 'Default 50, max 500' },
      },
    },
    output: OUTPUT,
    async execute(args) {
      return { ok: true, tasks: scheduler.list(args), stats: scheduler.stats() }
    },
  })

  registerTool(ctx, {
    name: 'sched_ingest',
    description:
      'Record a worker completion. Pass the worker reply text (the tool extracts the first balanced JSON object) or explicit taskId+status. ' +
      'A live task requires the attempt and lease_token from the dispatched task envelope; stale or missing tokens are rejected. ' +
      'Idempotent for terminal tasks. This is how the last hop of a remote worker reply enters the ledger.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        taskId: { type: 'string', description: 'Optional if text contains task_id' },
        text: { type: 'string', description: 'Raw worker reply text containing the JSON object' },
        status: { type: 'string', enum: ['succeeded', 'failed'], description: 'Optional explicit status' },
        attempt: { type: 'number', description: 'Attempt number from the task envelope' },
        lease_token: { type: 'string', description: 'Lease token from the task envelope' },
        summary: { type: 'string' },
        files: { type: 'array', items: { type: 'string' } },
        error: { type: 'string' },
      },
    },
    output: OUTPUT,
    async execute(args) {
      return scheduler.ingest({ ...args, leaseToken: args.lease_token })
    },
  })

  registerTool(ctx, {
    name: 'sched_tick',
    description:
      'Run one scheduler tick manually: expire leases, retry due tasks and dispatch queued tasks to free workers. ' +
      'The plugin also ticks automatically every 15 seconds while active.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: OUTPUT,
    async execute() {
      return scheduler.tick()
    },
  })

  registerTool(ctx, {
    name: 'sched_cancel',
    description: 'Cancel a queued or running task. A remote worker already executing it is not forcibly stopped; its later reply is ignored.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        taskId: { type: 'string' },
        reason: { type: 'string' },
      },
      required: ['taskId'],
    },
    output: OUTPUT,
    async execute(args) {
      return scheduler.cancel(args.taskId, args.reason)
    },
  })

  registerTool(ctx, {
    name: 'sched_stats',
    description: 'Show scheduler ledger counts, worker availability and the state file path.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: OUTPUT,
    async execute() {
      return { ok: true, ...scheduler.stats() }
    },
  })

  const timer = setInterval(() => {
    scheduler.tick().catch((error) => logger.warn?.(`[lan-scheduler] tick failed: ${error?.message ?? error}`))
  }, 15_000)
  if (typeof timer.unref === 'function') timer.unref()
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => clearInterval(timer), 'lan-scheduler:timer')
  }

  logger.info?.('[lan-scheduler] ready (tools: sched_*)')
  return { scheduler, dispose: () => clearInterval(timer) }
}
