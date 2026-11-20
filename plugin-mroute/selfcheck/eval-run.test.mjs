/**
 * selfcheck/eval-run.test.mjs — M5-MVP 交付：model_eval_run（suite lite/1）。
 *
 * 覆盖任务书 §4 要求的用例（≥10 组）：
 *  ① 判分器哨兵：5 道可执行题 fixture must-pass/must-fail 全绿；故意破的 grader 能被抓住；
 *  ② finish 白名单四态：stop 成功、tool-calls 仅 tools 维成功、max-tokens/error 失败；
 *  ③ 超时 → aborted/invalid（AbortController 自主超时，不依赖宿主缺省）；
 *  ④ vision 维恒 null / scores=-1（无调用、无判分）；
 *  ⑤ provisional 恒 true（samples<12）且 suggest.tier=''、priority_delta ∈ [-10,10]；
 *  ⑥ dry_run 不写盘、零模型调用（JSONL 目录不创建）；
 *  ⑦ allow_monthly=false 排除 monthly（无名匹配即报错）、true 才纳入；
 *  ⑧ 跨渠道同一 canonical 去重（只测最高序渠道）；
 *  ⑨ max_calls 截断：调用数=上限、skipped 记剩余；JSONL 行数=真实调用数；
 *  ⑩ 配置写回：只写 model_eval/eval_status，合并保留既有条目；不写 channels/ratings；
 *  ⑪ Wilson 下界数值与哨兵 -1；run_id 安全校验；
 *  ⑫ 输出 schema 无 type 数组（宿主宿主工具 schema 禁令回归）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readRegistry } from '../lib/registry.js'
import { createEvalRunTool, TOOL_NAME } from '../lib/tool-eval-run.mjs'
import { runTask, choosePinnedEfforts, FINISH_WHITELIST } from '../lib/eval/runner.mjs'
import { wilsonLowerBound, aggregateModel } from '../lib/eval/score.mjs'
import { TASKS, EXECUTABLE_TASKS, sentinelCheck, SUITE_VERSION } from '../lib/eval/suite-lite.mjs'
import { isSafeRunId, makeRunId, createEvalRecorder, readEvalRecords } from '../lib/eval/store.mjs'

const logger = { info() {}, warn() {}, error() {} }
const TMP_ROOT = path.join(os.tmpdir(), 'mroute-m5-eval-selfcheck')
const EXEC = {}

/** 与真机生效渠道一致的 5 渠道（prepaid 3 + monthly 2）。 */
const CHANNEL_MODELS = {
  'deepseek-official': ['deepseek-flash', 'deepseek-v4-pro'],
  'deepseek-account': ['deepseek-flash', 'deepseek-v4-pro'],
  xiaomi: ['mimo-v2.6-flash', 'mimo-v2.6-pro'],
  'zai-coding-cn': ['glm-5.3', 'glm-5.3-flash'],
  'opencode-go': ['deepseek-v4.1-flash', 'qwen3.8-flash'],
}
const CHANNEL_META = {
  'deepseek-official': { channel_type: 'prepaid', tier: 'domestic_sota', priority: 70 },
  'deepseek-account': { channel_type: 'prepaid', tier: 'domestic_sota', priority: 65 },
  xiaomi: { channel_type: 'prepaid', tier: 'bulk', priority: 50 },
  'zai-coding-cn': { channel_type: 'monthly', tier: 'domestic_sota', priority: 90 },
  'opencode-go': { channel_type: 'monthly', tier: 'domestic_sota', priority: 80 },
}
const MODEL_ALIASES = { 'opencode-go': { 'deepseek-v4.1-flash': 'deepseek-flash' } }

function registryOf() {
  const channels = Object.entries(CHANNEL_MODELS).map(([id, models]) => ({ id, routeProvider: id, models: [...models], ...CHANNEL_META[id] }))
  return readRegistry({ channels, model_aliases: MODEL_ALIASES }, logger)
}

function livecheckOf() {
  return {
    async check(providerId) {
      return { status: 'ok', detail: '', availableModels: [...(CHANNEL_MODELS[providerId] ?? [])] }
    },
  }
}

/** 全部题目都能判 pass 的文本（编码/长上下文/世界知识/计划结构共用）。 */
const GOOD_TEXT = [
  'function fib(n) { return n < 2 ? n : fib(n - 1) + fib(n - 2) }',
  '// 结果: 55',
  'A=XQ-731 C=RT-447',
  '珠穆朗玛峰',
  '```json',
  '[{"id":"t1","name":"设计","deps":[]},{"id":"t2","name":"实现","deps":["t1"]},{"id":"t3","name":"联调","deps":["t2"]}]',
  '```',
].join('\n')

/**
 * 假 llm：prepareCall 形状对齐宿主（config + configure 合并 + reasoningEffort 缺省 high），
 * stream 按 options.tools 决定产出工具调用还是文本。
 */
function fakeLlm({ finishFor = () => null, latencyMs = 0, hangOnSignal = false } = {}) {
  const calls = []
  return {
    calls,
    async resolveModelInfo(provider, model) {
      return {
        provider,
        id: model,
        name: model,
        reasoning: { efforts: ['off', 'low', 'high', 'max'].map((id) => ({ id, name: id })), defaultEffort: 'high' },
      }
    },
    async prepareCall(config, _signal, configure) {
      const controls = typeof configure === 'function' ? configure({}, {}) : {}
      const merged = { ...config, ...controls }
      const preparedConfig = { ...merged, ...(merged.reasoningEffort === undefined ? { reasoningEffort: 'high' } : {}) }
      return {
        config: preparedConfig,
        async stream(options) {
          calls.push({ provider: preparedConfig.provider, model: preparedConfig.model, maxTokens: preparedConfig.maxTokens, effort: preparedConfig.reasoningEffort, hasTools: Array.isArray(options.tools) && options.tools.length > 0 })
          const forced = finishFor({ provider: preparedConfig.provider, model: preparedConfig.model, options })
          const hasTools = Array.isArray(options.tools) && options.tools.length > 0
          return (async function* generate() {
            yield { type: 'block-start' }
            if (hasTools && forced === null) {
              yield { type: 'tool-call-delta', index: 0, id: 'call_1', name: 'get_weather', argumentsDelta: '{"city":"北京"}' }
            } else {
              yield { type: 'text-delta', text: GOOD_TEXT }
            }
            yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } }
            if (forced !== null) {
              yield { type: 'finish', reason: { kind: forced } }
              return
            }
            if (hangOnSignal === true) {
              await new Promise((_resolve, reject) => {
                const signal = options.signal
                if (signal?.aborted) reject(Object.assign(new Error('aborted'), { code: 'ABORTED' }))
                else signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { code: 'ABORTED' })))
              })
            }
            if (latencyMs > 0) await new Promise((resolve) => setTimeout(resolve, latencyMs))
            yield { type: 'finish', reason: { kind: hasTools ? 'tool-calls' : 'stop' } }
          })()
        },
      }
    },
  }
}

/** 工具工厂：ctx 带 llm + fiber.entry + configEditor（edit 捕获写回结果）；historyDir 隔离到 tmp。 */
function evalTool({ llm = fakeLlm(), historyDir = freshDir('hist') } = {}) {
  const written = []
  const ctx = {
    llm,
    fiber: { entry: { id: 'entry' } },
    get(name) {
      if (name !== 'configEditor') return undefined
      return {
        async edit(entry, mutator) {
          const base = { channels: [{ id: 'deepseek-official' }], model_ratings: { keep: { coding: 'good' } }, model_eval: { 'old-model': { samples: 1 } }, eval_status: {} }
          const next = mutator(base)
          written.push(next)
          return next
        },
      }
    },
  }
  const tool = createEvalRunTool({ ctx, getRegistry: registryOf, livecheck: livecheckOf(), logger, readConfigValue: () => undefined, historyDir })
  return { tool, written, llm }
}

function freshDir(tag) {
  const dir = path.join(TMP_ROOT, `${tag}-${process.pid}-${Date.now()}`)
  fs.rmSync(dir, { recursive: true, force: true })
  return dir
}

test('§1 判分器哨兵：5 道可执行题 fixture 全绿；破 fixture 被抓', () => {
  const ok = sentinelCheck(TASKS)
  assert.equal(ok.ok, true, JSON.stringify(ok.issues))
  assert.equal(EXECUTABLE_TASKS.length, 5)
  assert.equal(TASKS.length, 6)
  const broken = sentinelCheck([
    { id: 'broken', skip: false, grade: () => ({ pass: true, detail: '' }), fixture_pass: {}, fixture_fail: {} },
  ])
  assert.equal(broken.ok, false)
  assert.match(broken.issues.join('|'), /must-fail/)
})

test('§2 finish 白名单：stop 成功 / tool-calls 仅 tools 维 / max-tokens 失败', async () => {
  assert.deepEqual(FINISH_WHITELIST.tools, ['stop', 'tool-calls'])
  assert.deepEqual(FINISH_WHITELIST.default, ['stop'])
  const coding = TASKS.find((task) => task.id === 'coding-1')
  const tools = TASKS.find((task) => task.id === 'tools-1')
  const slow = fakeLlm({ finishFor: () => 'max-tokens' })
  const codingRecord = await runTask({ llm: slow, canonical: 'm', provider: 'deepseek-official', model: 'deepseek-flash', task: coding, effort: 'high', runId: 'r1', timeoutMs: 2000, suiteVersion: SUITE_VERSION })
  assert.equal(codingRecord.finish_kind, 'max-tokens')
  assert.equal(codingRecord.status, 'invalid')

  const ok = fakeLlm()
  const toolsRecord = await runTask({ llm: ok, canonical: 'm', provider: 'deepseek-official', model: 'deepseek-flash', task: tools, effort: 'high', runId: 'r1', timeoutMs: 2000, suiteVersion: SUITE_VERSION })
  assert.equal(toolsRecord.finish_kind, 'tool-calls')
  assert.equal(toolsRecord.status, 'graded')
  assert.equal(toolsRecord.pass, true)
})

test('§3 超时：signal 挂起 → aborted/invalid（错误前缀 timeout）', async () => {
  const task = TASKS.find((entry) => entry.id === 'world_knowledge-1')
  const record = await runTask({ llm: fakeLlm({ hangOnSignal: true }), canonical: 'm', provider: 'deepseek-official', model: 'deepseek-flash', task, effort: 'high', runId: 'r2', timeoutMs: 30, suiteVersion: SUITE_VERSION })
  assert.equal(record.status, 'invalid')
  assert.equal(record.finish_kind, 'aborted')
  assert.match(record.error, /^timeout:/)
})

test('§4 vision 维恒 null / scores=-1（无调用）', async () => {
  const summary = aggregateModel({ calls: [], applied_effort: 'high', instrument_healthy: true, run_id: 'r3', evidence_refs: [], dimensions: TASKS.map((task) => task.dimension) })
  assert.equal(summary.scores.vision, -1)
  assert.equal(summary.dimension_status.vision, 'null')
  assert.equal(summary.samples, 0)
})

test('§5 provisional 与 suggest 上限：samples<12 → tier=""，delta ∈ [-10,10]；哨兵不计入 samples', () => {
  const calls = EXECUTABLE_TASKS.map((task) => ({
    canonical: 'm',
    dimension: task.dimension,
    sentinel: task.sentinel === true,
    status: 'graded',
    pass: true,
  }))
  const summary = aggregateModel({
    calls,
    applied_effort: 'high',
    instrument_healthy: true,
    run_id: 'r4',
    evidence_refs: ['x.jsonl'],
    dimensions: EXECUTABLE_TASKS.map((task) => task.dimension),
    currentTier: 'bulk',
  })
  assert.equal(summary.provisional, true)
  assert.equal(summary.suggest.tier, '')
  assert.ok(summary.suggest.priority_delta >= -10 && summary.suggest.priority_delta <= 10)
  // 5 题中 world_knowledge 是校准哨兵：samples 只数 4 判分维，composite 也只由它们决定。
  assert.equal(summary.samples, 4)
  assert.equal(summary.dimension_status.world_knowledge, 'sentinel')
  assert.equal(summary.scores.world_knowledge, 1)
  assert.equal(summary.composite, 1)
  assert.ok(summary.wilson_lb >= 0 && summary.wilson_lb <= 1)
})

test('§6 dry_run：零模型调用、零写盘（JSONL 目录不创建）', async () => {
  const dir = freshDir('dry')
  const { tool, llm, written } = evalTool({ historyDir: dir })
  const result = await tool.execute({}, EXEC)
  assert.equal(result.dry_run, true)
  assert.equal(result.calls_executed, 0)
  assert.equal(llm.calls.length, 0)
  assert.equal(written.length, 0)
  assert.match(result.text, /评测预检/)
  assert.match(result.text, /dry_run：未写盘/)
  assert.ok(result.targets.length >= 1)
  assert.ok(result.targets.every((target) => target.channel_type === 'prepaid'), JSON.stringify(result.targets.map((t) => t.channel_type)))
  assert.equal(fs.existsSync(dir), false, 'dry_run 不得创建证据目录')
})

test('§7 allow_monthly：false 时 monthly 不可选；true 才纳入', async () => {
  const { tool } = evalTool()
  await assert.rejects(() => tool.execute({ models: ['glm-5.3'] }, EXEC), /models 参数无匹配候选/)
  const result = await tool.execute({ models: ['glm-5.3'], allow_monthly: true }, EXEC)
  assert.equal(result.targets.length, 1)
  assert.equal(result.targets[0].provider, 'zai-coding-cn')
  assert.equal(result.targets[0].channel_type, 'monthly')
})

test('§8 跨渠道 canonical 去重：只留最高序渠道', async () => {
  const { tool } = evalTool()
  const result = await tool.execute({ models: ['deepseek-flash'] }, EXEC)
  assert.equal(result.targets.length, 1)
  assert.equal(result.targets[0].provider, 'deepseek-official')
  assert.equal(result.targets[0].model, 'deepseek-flash')
})

test('§9 max_calls 截断 + JSONL 行数=真实调用数 + 配置写回合并', async () => {
  const dir = freshDir('run')
  const { tool, written } = evalTool({ historyDir: dir })
  const result = await tool.execute({ models: ['deepseek-flash', 'deepseek-v4-pro'], max_calls: 5, dry_run: false }, EXEC)
  assert.equal(result.calls_executed, 5)
  assert.equal(result.skipped_count, 5)
  assert.equal(path.dirname(result.jsonl_path), dir)
  const records = await readEvalRecords(result.jsonl_path)
  assert.equal(records.records.length, 5)
  assert.equal(records.badLines.length, 0)
  for (const record of records.records) {
    assert.equal(record.run_id, result.run_id)
    assert.equal(record.suite_version, SUITE_VERSION)
  }
  assert.equal(written.length, 2, '实跑必须先写 running、结束写 ok（两次写回）')
  assert.equal(written[0].eval_status.state, 'running')
  assert.equal(written[0].eval_status.run_id, result.run_id)
  assert.equal(written[0].model_eval['old-model'].samples, 1, 'running 阶段不得覆盖既有 model_eval')
  const next = written[1]
  assert.equal(next.eval_status.state, 'ok')
  assert.equal(next.eval_status.run_id, result.run_id)
  assert.ok(next.model_eval['old-model'], '既有 model_eval 条目必须保留')
  assert.ok(next.model_eval['deepseek-flash'])
  assert.ok(next.model_eval['deepseek-v4-pro'])
  assert.deepEqual(next.channels, [{ id: 'deepseek-official' }], '不得写 channels')
  assert.deepEqual(next.model_ratings, { keep: { coding: 'good' } }, '不得写 model_ratings')
  const vision = next.model_eval['deepseek-flash']
  assert.equal(vision.scores.vision, -1)
  assert.equal(vision.dimension_status.vision, 'null')
  assert.equal(vision.samples, 4, 'samples 只数 4 个判分维（world_knowledge 是哨兵）')
  assert.equal(vision.dimension_status.world_knowledge, 'sentinel')
  assert.equal(vision.scores.world_knowledge, 1)
  assert.equal(vision.suggest.tier, '')
  assert.ok(vision.suggest.priority_delta >= -10 && vision.suggest.priority_delta <= 10)
  assert.ok(fs.existsSync(`${result.jsonl_path}`))
  fs.rmSync(dir, { recursive: true, force: true })
})

test('§10 写回失败不抛：只报 eval_status_error', async () => {
  const dir = freshDir('writefail')
  const llm = fakeLlm()
  const ctx = {
    llm,
    fiber: { entry: {} },
    get() { return { async edit() { throw new Error('revision conflict') } } },
  }
  const tool = createEvalRunTool({ ctx, getRegistry: registryOf, livecheck: livecheckOf(), logger, readConfigValue: () => undefined, historyDir: dir })
  const result = await tool.execute({ models: ['deepseek-flash'], max_calls: 2, dry_run: false }, EXEC)
  assert.equal(result.calls_executed, 2)
  assert.equal(result.config_write.ok, false)
  assert.match(result.config_write.error, /revision conflict/)
  assert.ok(result.notes.some((note) => note.includes('eval_status_error')))
  fs.rmSync(dir, { recursive: true, force: true })
})

test('§11 Wilson 下界：n<=0 → -1；全中随 n 单调上升；0/n=0', () => {
  assert.equal(wilsonLowerBound(0, 0), -1)
  assert.equal(wilsonLowerBound(0, 5), 0)
  const small = wilsonLowerBound(5, 5)
  const big = wilsonLowerBound(12, 12)
  assert.ok(small > 0.5 && small < 0.65, String(small))
  assert.ok(big > small)
  assert.ok(wilsonLowerBound(5, 10) < small)
})

test('§12 run_id 安全 + 记录器懒创建/坏行容错', async () => {
  assert.equal(isSafeRunId('eval-20261120-120000-abcd'), true)
  assert.equal(isSafeRunId('../etc/passwd'), false)
  assert.equal(isSafeRunId('a/b'), false)
  assert.equal(isSafeRunId(''), false)
  assert.equal(isSafeRunId('..'), false)
  assert.match(makeRunId(new Date('2026-11-20T12:00:00Z')), /^eval-\d{8}-\d{6}-[0-9a-f]{4}$/)
  const dir = freshDir('store')
  const recorder = createEvalRecorder({ dir, runId: 'eval-test-0001', logger })
  assert.equal(await recorder.append({ n: 1 }), true)
  assert.equal(await recorder.append({ n: 2 }), true)
  const { records, badLines } = await readEvalRecords(recorder.file)
  assert.deepEqual(records.map((row) => row.n), [1, 2])
  assert.deepEqual(badLines, [])
  fs.rmSync(dir, { recursive: true, force: true })
})

test('§13 输出 schema 无 type 数组（宿主工具 schema 禁令回归）', () => {
  const { tool } = evalTool()
  const seen = []
  const walk = (node, at) => {
    if (node === null || typeof node !== 'object') return
    if (Array.isArray(node.type)) seen.push(`${at}: ${JSON.stringify(node.type)}`)
    for (const [key, value] of Object.entries(node)) walk(value, `${at}.${key}`)
  }
  walk(tool.output.schema, 'output')
  assert.deepEqual(seen, [])
  assert.equal(tool.name, TOOL_NAME)
  assert.equal(typeof tool.execute, 'function')
})

test('§14 choosePinnedEfforts：共同档 high 优先；无交集 per-model；无 reasoning → none', () => {
  const common = choosePinnedEfforts([
    { key: 'a', efforts: ['off', 'low', 'high', 'max'] },
    { key: 'b', efforts: ['low', 'high'] },
  ])
  assert.equal(common.mode, 'common')
  assert.equal(common.effortByKey.a, 'high')
  assert.equal(common.effortByKey.b, 'high')
  const perModel = choosePinnedEfforts([
    { key: 'a', efforts: ['max'] },
    { key: 'b', efforts: ['low'] },
  ])
  assert.equal(perModel.mode, 'per-model')
  assert.equal(perModel.effortByKey.a, 'max')
  assert.equal(perModel.effortByKey.b, 'low')
  const none = choosePinnedEfforts([{ key: 'a', efforts: [] }])
  assert.equal(none.mode, 'none')
  assert.equal(none.effortByKey.a, '')
  fs.rmSync(TMP_ROOT, { recursive: true, force: true })
})

test('§15 校准哨兵不参与 composite：答错/答对不改变 samples/composite/delta', () => {
  const graded = ['coding', 'tools', 'long_context', 'orchestration'].map((dimension) => ({ dimension, status: 'graded', pass: true }))
  const input = { applied_effort: 'high', instrument_healthy: true, run_id: 'r5', evidence_refs: [] }
  const plain = aggregateModel({ ...input, calls: graded.map((call) => ({ ...call })) })
  const wrongSentinel = aggregateModel({
    ...input,
    calls: [...graded.map((call) => ({ ...call })), { dimension: 'world_knowledge', status: 'graded', pass: false, sentinel: true }],
  })
  assert.equal(plain.samples, 4)
  assert.equal(wrongSentinel.samples, 4, '哨兵样本不得计入 samples')
  assert.equal(wrongSentinel.composite, plain.composite, '哨兵答错不得改变 composite')
  assert.equal(wrongSentinel.wilson_lb, plain.wilson_lb)
  assert.equal(wrongSentinel.suggest.priority_delta, plain.suggest.priority_delta)
  assert.equal(wrongSentinel.scores.world_knowledge, 0, '哨兵分数仍要留证据（正确率）')
  assert.equal(wrongSentinel.dimension_status.world_knowledge, 'sentinel')
  // 也支持调用方显式声明哨兵维（不依赖 call.sentinel 标记）。
  const declared = aggregateModel({
    ...input,
    calls: [...graded.map((call) => ({ ...call })), { dimension: 'world_knowledge', status: 'graded', pass: true }],
    sentinel_dimensions: ['world_knowledge'],
  })
  assert.equal(declared.dimension_status.world_knowledge, 'sentinel')
  assert.equal(declared.samples, 4)
})

test('§16 tier 只给相对上一档：bulk→domestic_sota、domestic_sota→overseas_sota、顶格不提', () => {
  const calls = []
  for (const dimension of ['coding', 'tools', 'long_context', 'orchestration']) {
    for (let index = 0; index < 3; index += 1) calls.push({ dimension, status: 'graded', pass: true })
  }
  const input = { calls, applied_effort: 'high', instrument_healthy: true, run_id: 'r6', evidence_refs: [] }
  const bulk = aggregateModel({ ...input, currentTier: 'bulk' })
  assert.equal(bulk.samples, 12)
  assert.equal(bulk.provisional, false)
  assert.ok(bulk.wilson_lb >= 0.75, String(bulk.wilson_lb))
  assert.equal(bulk.suggest.tier, 'domestic_sota')
  assert.match(bulk.suggest.note, /相对当前档 bulk → domestic_sota/)
  assert.equal(aggregateModel({ ...input, currentTier: 'domestic_sota' }).suggest.tier, 'overseas_sota')
  const top = aggregateModel({ ...input, currentTier: 'overseas_sota' })
  assert.equal(top.suggest.tier, '', '顶格不提 tier（不得从 overseas 降级到 domestic）')
  assert.match(top.suggest.note, /顶格/)
  assert.equal(aggregateModel({ ...input, currentTier: '' }).suggest.tier, '', '档位未知不提')
})
