/**
 * selfcheck/eval-formal.test.mjs — M5.2 交付：formal/2 题集 + max_tokens 覆盖参 + 硬顶/日预算调整。
 *
 * 覆盖任务书 docs/briefs/m5.2-expand-eval.md §2.4 要求的断言（§F1–§F13）：
 *  ① formal/2 题数与维度分布：55 题（54 可执行 + vision 恒 null），52 判分 + 2 哨兵，四维各 13；
 *  ② maxTokens 分档：coding/orchestration 8192、tools/long_context 2048、哨兵 1024、vision 0；
 *  ③ 题型加厚：coding ≥3 多步算法、tools ≥4 参数抽取（含 3 道多参数）、long_context ≥3 跨段（prompt ≤1500 tokens 量级）、
 *     orchestration 全部 JSON 数组计划（≥3 项）；
 *  ④ 每题 fixture_pass / fixture_fail 双向自证（sentinelCheck）；
 *  ⑤ 取档公式边界（0.75/0.55/0.30 与 n<6 → no_data）；
 *  ⑥ n=13 全对时 Wilson 下界跨过 0.75（excellent 门槛）；
 *  ⑦ suite 缺省仍为 lite（5 次/模型）；formal 计划 54 次/模型（dry_run 零调用）；
 *  ⑧ `max_tokens` 覆盖参 clamp（0→1、200001→200000、非整数收敛、非法类型报错）；
 *  ⑨ `max_calls` 硬顶 80、日预算 300（2026-11-21 M5.2 当日曾放宽到 400/500，2026-11-22 回落）；
 *  ⑩ formal 实跑（oracle 全对）：samples=52、tool-calls=13、哨兵不计入、不写 channels/model_ratings；
 *  ⑪ 实跑 JSONL 每题 max_tokens 与题面分档一致（54 行）；
 *  ⑫ `max_tokens` 覆盖实跑：54 行全部落到覆盖值；
 *  ⑬ 输出 schema 仍无 type 数组（宿主禁令回归）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readRegistry } from '../lib/registry.js'
import { createEvalRunTool, DAILY_CALL_BUDGET, MAX_TOKENS_MIN, MAX_TOKENS_MAX } from '../lib/tool-eval-run.mjs'
import { wilsonLowerBound, suggestRating, RATING_MIN_SAMPLES } from '../lib/eval/score.mjs'
import { HARD_MAX_CALLS, DEFAULT_MAX_CALLS } from '../lib/eval/runner.mjs'
import { SUITE_VERSION, TASKS, EXECUTABLE_TASKS, MAX_TOKENS, sentinelCheck } from '../lib/eval/suite-formal.mjs'

const logger = { info() {}, warn() {}, error() {} }
const TMP_ROOT = path.join(os.tmpdir(), 'mroute-m52-formal-selfcheck')
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
  const dir = path.join(TMP_ROOT, `${tag}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`)
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

function jsonlRows(file) {
  return fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
}

test('§F1 formal/2 题数与维度分布（55 题 = 54 可执行 + vision 恒 null；52 判分 + 2 哨兵）', () => {
  assert.equal(SUITE_VERSION, 'formal/2')
  assert.equal(TASKS.length, 55)
  assert.equal(EXECUTABLE_TASKS.length, 54)
  const dims = {}
  for (const task of TASKS) dims[task.dimension] = (dims[task.dimension] ?? 0) + 1
  assert.deepEqual(dims, { coding: 13, tools: 13, long_context: 13, orchestration: 13, world_knowledge: 2, vision: 1 })
  assert.equal(EXECUTABLE_TASKS.filter((task) => task.sentinel !== true).length, 52)
  assert.equal(EXECUTABLE_TASKS.filter((task) => task.sentinel === true).length, 2)
  assert.equal(TASKS.find((task) => task.dimension === 'vision').skip, true)
  assert.equal(new Set(TASKS.map((task) => task.id)).size, TASKS.length, 'id 唯一')
})

test('§F2 maxTokens 分档（8192 / 2048 / 1024 / 0，与 MAX_TOKENS 常量一致）', () => {
  assert.deepEqual(MAX_TOKENS, { coding: 8192, orchestration: 8192, tools: 2048, long_context: 2048, world_knowledge: 1024, vision: 0 })
  for (const task of TASKS) {
    assert.equal(task.maxTokens, MAX_TOKENS[task.dimension], `${task.id}（${task.dimension}）maxTokens 与分档不符`)
  }
  // 复杂题给足：coding 与 orchestration 必须 ≥ 8192（formal/1 的 1024/512 截断教训）
  assert.ok(EXECUTABLE_TASKS.filter((task) => task.dimension === 'coding').every((task) => task.maxTokens >= 8192))
  assert.ok(EXECUTABLE_TASKS.filter((task) => task.dimension === 'orchestration').every((task) => task.maxTokens >= 8192))
})

test('§F3 题型加厚：多步算法 ≥3、参数抽取 ≥4、跨段检索 ≥3、JSON 计划 ≥4', () => {
  const multiStep = EXECUTABLE_TASKS.filter((task) => task.multiStep === true)
  assert.ok(multiStep.length >= 3, `多步算法 ${multiStep.length}`)
  assert.ok(multiStep.every((task) => task.dimension === 'coding'))

  const tools = EXECUTABLE_TASKS.filter((task) => task.dimension === 'tools')
  const extraction = tools.filter((task) => Array.isArray(task.tools?.[0]?.parameters?.required) && task.tools[0].parameters.required.length >= 1)
  assert.ok(extraction.length >= 4, `参数抽取 ${extraction.length}`)
  const multiArg = tools.filter((task) => (task.tools?.[0]?.parameters?.required?.length ?? 0) >= 2)
  assert.ok(multiArg.length >= 3, `多参数抽取 ${multiArg.length}`)

  const cross = EXECUTABLE_TASKS.filter((task) => task.crossSection === true)
  assert.ok(cross.length >= 3, `跨段检索 ${cross.length}`)
  for (const task of cross) {
    // 中文约 1 字 ≈ 1 token 量级：422 字 ≈ 远低于 1500 tokens 上限；用字符数做保守代理
    assert.ok(task.prompt.length <= 4000, `${task.id} prompt 过长（${task.prompt.length} 字）`)
  }

  const orch = EXECUTABLE_TASKS.filter((task) => task.dimension === 'orchestration')
  assert.ok(orch.length >= 4)
  assert.ok(orch.every((task) => task.prompt.includes('JSON 数组')), 'orchestration 必须要求 JSON 数组计划')
  assert.ok(orch.every((task) => /拆成 \d+ 个子任务/.test(task.prompt)))
})

test('§F4 每题 fixture 双向自证（52 道可执行题 sentinelCheck 全绿；破题可被抓）', () => {
  const ok = sentinelCheck(TASKS)
  assert.equal(ok.ok, true, JSON.stringify(ok.issues))
  const broken = sentinelCheck([{ id: 'broken', skip: false, grade: () => ({ pass: true, detail: '' }), fixture_pass: {}, fixture_fail: {} }])
  assert.equal(broken.ok, false)
})

test('§F5 取档公式边界：0.75/0.55/0.30 与 n<6 → no_data', () => {
  assert.equal(RATING_MIN_SAMPLES, 6)
  assert.equal(suggestRating(5, 5), 'no_data')
  assert.equal(suggestRating(0, 0), 'no_data')
  assert.equal(suggestRating(12, 12), 'excellent')
  assert.ok(wilsonLowerBound(12, 12) >= 0.75)
  assert.equal(suggestRating(23, 25), 'excellent')
  assert.equal(suggestRating(11, 12), 'good')
  assert.equal(suggestRating(16, 20), 'good')
  assert.equal(suggestRating(8, 10), 'fair')
  assert.equal(suggestRating(3, 10), 'fair')
  assert.equal(suggestRating(2, 10), 'none')
  assert.equal(suggestRating(0, 6), 'none')
})

test('§F6 n=13 全对时 Wilson 下界跨过 excellent 门槛（13/13 记 excellent）', () => {
  const lb = wilsonLowerBound(13, 13)
  assert.ok(lb >= 0.75, `lb=${lb}`)
  assert.equal(suggestRating(13, 13), 'excellent')
  // formal/1 的 10/10 只能 good（lb=0.7225 < 0.75）——n=13 是 M5.2 扩题量的统计动因
  assert.equal(suggestRating(10, 10), 'good')
  assert.ok(wilsonLowerBound(10, 10) < 0.75)
})

test('§F7 suite 缺省 lite；formal 计划 54 次/模型（dry_run 零调用）', async () => {
  const { tool, llm } = evalTool()
  const lite = await tool.execute({ models: ['deepseek-flash'] }, EXEC)
  assert.equal(lite.suite_version, 'lite/1')
  assert.equal(lite.calls_planned, 5)
  assert.match(lite.text, /suite lite\/1/)

  const formal = await tool.execute({ models: ['deepseek-flash'], suite: 'formal' }, EXEC)
  assert.equal(formal.suite_version, 'formal/2')
  assert.equal(formal.calls_planned, 54)
  assert.match(formal.text, /52 道判分题 \+ 2 道校准哨兵/)
  assert.match(formal.text, /生效 maxTokens 分布/)
  for (const piece of ['coding=8192×13', 'tools=2048×13', 'long_context=2048×13', 'orchestration=8192×13', 'world_knowledge=1024×2']) {
    assert.ok(formal.text.includes(piece), `计划行缺 ${piece}`)
  }
  assert.equal(llm.calls.length, 0)
  await assert.rejects(() => tool.execute({ suite: 'bogus' }, EXEC), /suite 参数非法/)
})

test('§F8 max_tokens 覆盖参：0→1、200001→200000、2.9→2、非法类型报错', async () => {
  const { tool, llm } = evalTool()
  assert.equal(MAX_TOKENS_MIN, 1)
  assert.equal(MAX_TOKENS_MAX, 200000)

  const low = await tool.execute({ suite: 'formal', max_tokens: 0, dry_run: true }, EXEC)
  assert.equal(low.max_tokens, 1)
  assert.match(low.text, /max_tokens 已收敛为 1/)
  assert.match(low.text, /max_tokens=1 覆盖全部 54 道可执行题/)

  const high = await tool.execute({ suite: 'formal', max_tokens: 200001, dry_run: true }, EXEC)
  assert.equal(high.max_tokens, 200000)
  assert.match(high.text, /max_tokens 已收敛为 200000/)

  const frac = await tool.execute({ suite: 'formal', max_tokens: 2.9, dry_run: true }, EXEC)
  assert.equal(frac.max_tokens, 2)
  assert.match(frac.text, /max_tokens 已收敛为 2/)

  await assert.rejects(() => tool.execute({ suite: 'formal', max_tokens: '8192' }, EXEC), /max_tokens 参数非法/)
  await assert.rejects(() => tool.execute({ suite: 'formal', max_tokens: Number.NaN }, EXEC), /max_tokens 参数非法/)
  assert.equal(llm.calls.length, 0)
})

test('§F9 max_calls 硬顶 80 与日预算 300（2026-11-22 回落常规值）', async () => {
  assert.equal(DEFAULT_MAX_CALLS, 18)
  assert.equal(HARD_MAX_CALLS, 80)
  assert.equal(DAILY_CALL_BUDGET, 300)
  const { tool } = evalTool()
  const plan = await tool.execute({ suite: 'formal', max_calls: 100 }, EXEC)
  assert.equal(plan.max_calls, 80)
  assert.match(plan.text, /max_calls 已收敛为硬顶 80/)
  assert.match(plan.text, /日预算 300/)
})

test('§F10 formal 实跑（oracle 全对）：samples=52、tool-calls=13、哨兵不计入、不写 channels/model_ratings', async () => {
  const dir = freshDir('run')
  const { tool, written } = evalTool({ historyDir: dir })
  const result = await tool.execute({ models: ['deepseek-flash'], suite: 'formal', max_calls: 60, dry_run: false }, EXEC)
  assert.equal(result.calls_planned, 54)
  assert.equal(result.calls_executed, 54)
  assert.equal(result.skipped_count, 0)
  assert.equal(result.results.length, 1)
  const row = result.results[0]
  assert.equal(row.samples, 52)
  assert.equal(row.composite, 1)
  assert.equal(row.provisional, false)
  assert.equal(row.dimension_status.vision, 'null')
  assert.equal(row.dimension_status.world_knowledge, 'sentinel')
  assert.equal(row.scores.world_knowledge, 1)
  assert.equal(row.finish['tool-calls'], 13)
  assert.equal(row.finish.stop, 41)
  assert.ok(row.wilson_lb > 0.85)
  const next = written.at(-1)
  assert.equal(next.eval_status.state, 'ok')
  assert.equal(next.model_eval['deepseek-flash'].samples, 52)
  assert.equal(next.model_eval['old-model'].samples, 1, '既有条目保留')
  assert.deepEqual(next.channels, [{ id: 'deepseek-official' }], '不得写 channels')
  assert.deepEqual(next.model_ratings, { keep: { coding: 'good' } }, '不得写 model_ratings')
  assert.equal(fs.readFileSync(result.jsonl_path, 'utf8').trim().split('\n').length, 54)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('§F11 实跑 JSONL 每题 max_tokens 与题面分档一致（54 行）', async () => {
  const dir = freshDir('tokens')
  const { tool } = evalTool({ historyDir: dir })
  const result = await tool.execute({ models: ['deepseek-flash'], suite: 'formal', max_calls: 60, dry_run: false }, EXEC)
  const byId = new Map(TASKS.map((task) => [task.id, task.maxTokens]))
  const rows = jsonlRows(result.jsonl_path)
  assert.equal(rows.length, 54)
  for (const row of rows) {
    assert.equal(row.max_tokens, byId.get(row.task_id), `${row.task_id} max_tokens 与题面不符`)
    assert.equal(row.suite_version, 'formal/2')
  }
  const dims = {}
  for (const row of rows) dims[row.dimension] = (dims[row.dimension] ?? 0) + 1
  assert.deepEqual(dims, { coding: 13, tools: 13, long_context: 13, orchestration: 13, world_knowledge: 2 })
  fs.rmSync(dir, { recursive: true, force: true })
})

test('§F12 max_tokens 覆盖实跑：54 行全部落到覆盖值', async () => {
  const dir = freshDir('override')
  const { tool } = evalTool({ historyDir: dir })
  const result = await tool.execute({ models: ['deepseek-flash'], suite: 'formal', max_calls: 60, max_tokens: 4096, dry_run: false }, EXEC)
  assert.equal(result.calls_executed, 54)
  assert.equal(result.max_tokens, 4096)
  assert.match(result.text, /max_tokens=4096/)
  for (const row of jsonlRows(result.jsonl_path)) assert.equal(row.max_tokens, 4096)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('§F13 输出 schema 无 type 数组（宿主禁令回归）；参数含 suite 枚举与 max_tokens', () => {
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
  assert.deepEqual(tool.parameters.properties.suite.enum, ['lite', 'formal'])
  assert.equal(tool.parameters.properties.max_tokens.type, 'integer')
  assert.equal(tool.output.schema.properties.max_tokens.type, 'integer')
  fs.rmSync(TMP_ROOT, { recursive: true, force: true })
})
