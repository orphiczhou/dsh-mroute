/**
 * selfcheck/eval-formal.test.mjs — M5.1 交付：formal/1 题集 + suite 入参 + 取档公式。
 *
 * 覆盖任务书 m5.1-formal-eval.md §5.3 要求的用例：
 *  ① formal 题数与维度分布：39 题（38 可执行 + vision 恒 null），
 *     coding 10 / tools 10 / long_context 10 / orchestration 6 / world_knowledge 2 / vision 1；
 *  ② 每题 fixture_pass / fixture_fail 双向自证（sentinelCheck）；
 *  ③ 取档公式边界（0.75/0.55/0.30 与 n<6 → no_data）；
 *  ④ suite 缺省仍为 lite（dry_run 计划 5 题/模型）；suite:'formal' 计划 38 题/模型；
 *  ⑤ formal 实跑（oracle 假 llm 全对）：samples=36、provisional=false、哨兵不计入；
 *  ⑥ max_calls 截断对 formal 生效（38 题被 5 截断）；
 *  ⑦ 输出 schema 仍无 type 数组（宿主禁令回归）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readRegistry } from '../lib/registry.js'
import { createEvalRunTool } from '../lib/tool-eval-run.mjs'
import { wilsonLowerBound, suggestRating, RATING_MIN_SAMPLES } from '../lib/eval/score.mjs'
import { SUITE_VERSION, TASKS, EXECUTABLE_TASKS, sentinelCheck } from '../lib/eval/suite-formal.mjs'

const logger = { info() {}, warn() {}, error() {} }
const TMP_ROOT = path.join(os.tmpdir(), 'mroute-m51-formal-selfcheck')
const EXEC = {}

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

/** oracle 假 llm：按 prompt 反查 formal 题目，返回该题 fixture_pass（全对）。 */
function oracleLlm() {
  const calls = []
  const byPrompt = new Map(TASKS.map((task) => [task.prompt, task]))
  return {
    calls,
    async resolveModelInfo(provider, model) {
      return { provider, id: model, reasoning: { efforts: ['off', 'low', 'high', 'max'].map((id) => ({ id, name: id })), defaultEffort: 'high' } }
    },
    async prepareCall(config, _signal, configure) {
      const controls = typeof configure === 'function' ? configure({}, {}) : {}
      const merged = { ...config, ...controls }
      const preparedConfig = { ...merged, ...(merged.reasoningEffort === undefined ? { reasoningEffort: 'high' } : {}) }
      return {
        config: preparedConfig,
        async stream(options) {
          calls.push({ provider: preparedConfig.provider, model: preparedConfig.model, maxTokens: preparedConfig.maxTokens })
          const prompt = options.messages?.[0]?.content?.[0]?.text ?? ''
          const task = byPrompt.get(prompt)
          const fixture = task?.fixture_pass ?? { text: '(oracle 无此题)', toolCalls: [], finishKind: 'stop' }
          const hasToolCalls = Array.isArray(fixture.toolCalls) && fixture.toolCalls.length > 0
          return (async function* generate() {
            yield { type: 'block-start' }
            if (hasToolCalls) {
              for (const call of fixture.toolCalls) yield { type: 'tool-call-delta', index: 0, id: 'call_1', name: call.name, argumentsDelta: call.args }
            } else if (fixture.text !== '') {
              yield { type: 'text-delta', text: fixture.text }
            }
            yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } }
            yield { type: 'finish', reason: { kind: hasToolCalls ? 'tool-calls' : 'stop' } }
          })()
        },
      }
    },
  }
}

function freshDir(tag) {
  const dir = path.join(TMP_ROOT, `${tag}-${process.pid}-${Date.now()}`)
  fs.rmSync(dir, { recursive: true, force: true })
  return dir
}

function evalTool({ llm = oracleLlm(), historyDir = freshDir('hist') } = {}) {
  const written = []
  const ctx = {
    llm,
    fiber: { entry: { id: 'entry' } },
    get(name) {
      if (name !== 'configEditor') return undefined
      return {
        async edit(_entry, mutator) {
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

test('§F1 formal 题数与维度分布（39 题 = 38 可执行 + vision 恒 null）', () => {
  assert.equal(SUITE_VERSION, 'formal/1')
  assert.equal(TASKS.length, 39)
  assert.equal(EXECUTABLE_TASKS.length, 38)
  const dims = {}
  for (const task of TASKS) dims[task.dimension] = (dims[task.dimension] ?? 0) + 1
  assert.deepEqual(dims, { coding: 10, tools: 10, long_context: 10, orchestration: 6, world_knowledge: 2, vision: 1 })
  // graded/sentinel/skip 分层
  assert.equal(EXECUTABLE_TASKS.filter((task) => task.sentinel !== true).length, 36)
  assert.equal(EXECUTABLE_TASKS.filter((task) => task.sentinel === true).length, 2)
  const vision = TASKS.find((task) => task.dimension === 'vision')
  assert.equal(vision.skip, true)
  // 预算纪律：maxTokens ≤ 512（coding 允许 1024）；id 唯一
  for (const task of EXECUTABLE_TASKS) {
    assert.ok(task.maxTokens <= 512 || (task.dimension === 'coding' && task.maxTokens <= 1024), `${task.id} maxTokens=${task.maxTokens}`)
  }
  assert.equal(new Set(TASKS.map((task) => task.id)).size, TASKS.length)
})

test('§F2 每题 fixture 双向自证（38 道可执行题 sentinelCheck 全绿；破题可被抓）', () => {
  const ok = sentinelCheck(TASKS)
  assert.equal(ok.ok, true, JSON.stringify(ok.issues))
  const broken = sentinelCheck([{ id: 'broken', skip: false, grade: () => ({ pass: true, detail: '' }), fixture_pass: {}, fixture_fail: {} }])
  assert.equal(broken.ok, false)
})

test('§F3 取档公式边界：0.75/0.55/0.30 与 n<6 → no_data', () => {
  assert.equal(RATING_MIN_SAMPLES, 6)
  // 样本不足 → 无数据（即使全对）
  assert.equal(suggestRating(5, 5), 'no_data')
  assert.equal(suggestRating(0, 0), 'no_data')
  // excellent：lb≥0.75 且 p≥0.92
  assert.equal(suggestRating(12, 12), 'excellent')
  assert.ok(wilsonLowerBound(12, 12) >= 0.75)
  assert.equal(suggestRating(23, 25), 'excellent')
  assert.ok(wilsonLowerBound(23, 25) >= 0.75 && 23 / 25 >= 0.92)
  // p=0.9167 < 0.92：即便 lb≥0.55 也只到 good（p 门槛被卡）
  assert.equal(suggestRating(11, 12), 'good')
  // good：lb≥0.55（p 不够 0.92 或 lb 不够 0.75）
  const g = suggestRating(16, 20)
  assert.equal(g, 'good')
  assert.ok(wilsonLowerBound(16, 20) >= 0.55 && wilsonLowerBound(16, 20) < 0.75)
  // fair：lb<0.55 但 p≥0.30
  assert.equal(suggestRating(8, 10), 'fair')
  assert.ok(wilsonLowerBound(8, 10) < 0.55 && 8 / 10 >= 0.30)
  assert.equal(suggestRating(3, 10), 'fair')
  // none：p<0.30
  assert.equal(suggestRating(2, 10), 'none')
  assert.equal(suggestRating(0, 6), 'none')
  // 边界恰好 0.30：3/10=0.30 → fair（含等号）
  assert.ok(3 / 10 === 0.30)
})

test('§F4 suite 缺省 lite；formal 计划 38 题/模型（dry_run 零调用）', async () => {
  const { tool, llm } = evalTool()
  const lite = await tool.execute({ models: ['deepseek-flash'] }, EXEC)
  assert.equal(lite.suite_version, 'lite/1')
  assert.equal(lite.calls_planned, 5)
  assert.match(lite.text, /suite lite\/1/)
  const formal = await tool.execute({ models: ['deepseek-flash'], suite: 'formal' }, EXEC)
  assert.equal(formal.suite_version, 'formal/1')
  assert.equal(formal.calls_planned, 38)
  assert.match(formal.text, /36 道判分题 \+ 2 道校准哨兵/)
  assert.equal(llm.calls.length, 0)
  // 非法 suite 报错且文案含收到的值
  await assert.rejects(() => tool.execute({ suite: 'bogus' }, EXEC), /suite 参数非法/)
})

test('§F5 formal 实跑（oracle 全对）：samples=36、provisional=false、哨兵不计入', async () => {
  const dir = freshDir('run')
  const { tool, written } = evalTool({ historyDir: dir })
  const result = await tool.execute({ models: ['deepseek-flash'], suite: 'formal', max_calls: 40, dry_run: false }, EXEC)
  assert.equal(result.calls_executed, 38)
  assert.equal(result.skipped_count, 0)
  assert.equal(result.results.length, 1)
  const row = result.results[0]
  assert.equal(row.samples, 36)
  assert.equal(row.composite, 1)
  assert.equal(row.provisional, false)
  assert.equal(row.dimension_status.vision, 'null')
  assert.equal(row.dimension_status.world_knowledge, 'sentinel')
  assert.equal(row.scores.world_knowledge, 1)
  assert.equal(row.finish['tool-calls'], 10)
  assert.ok(row.wilson_lb > 0.85)
  const next = written.at(-1)
  assert.equal(next.eval_status.state, 'ok')
  assert.equal(next.model_eval['deepseek-flash'].samples, 36)
  assert.equal(next.model_eval['old-model'].samples, 1, '既有条目保留')
  assert.deepEqual(next.channels, [{ id: 'deepseek-official' }], '不得写 channels')
  assert.deepEqual(next.model_ratings, { keep: { coding: 'good' } }, '不得写 model_ratings')
  const lines = fs.readFileSync(result.jsonl_path, 'utf8').trim().split('\n')
  assert.equal(lines.length, 38)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('§F6 max_calls 截断对 formal 生效', async () => {
  const dir = freshDir('trunc')
  const { tool } = evalTool({ historyDir: dir })
  const result = await tool.execute({ models: ['deepseek-flash'], suite: 'formal', max_calls: 5, dry_run: false }, EXEC)
  assert.equal(result.calls_executed, 5)
  assert.equal(result.skipped_count, 33)
  assert.match(result.text, /max_calls=5/)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('§F7 输出 schema 无 type 数组（宿主禁令回归）；参数 schema 有 suite 枚举', () => {
  const { tool } = evalTool()
  const seen = []
  const walk = (node, at) => {
    if (node === null || typeof node !== 'object') return
    if (Array.isArray(node.type)) seen.push(`${at}: ${JSON.stringify(node.type)}`)
    for (const [key, value] of Object.entries(node)) walk(value, `${at}.${key}`)
  }
  walk(tool.output.schema, 'output')
  walk(tool.parameters, 'parameters')
  assert.deepEqual(seen, [])
  const suite = tool.parameters.properties.suite
  assert.equal(suite.type, 'string')
  assert.deepEqual(suite.enum, ['lite', 'formal'])
  fs.rmSync(TMP_ROOT, { recursive: true, force: true })
})
