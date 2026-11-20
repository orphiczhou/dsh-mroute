/**
 * M5 suite lite/1 —— 六维最小评测题集（写死，确定性判分）。
 *
 * 设计纪律（docs/10-m5-eval-plan.md §5 / 任务书 §3）：
 * 1. **确定性判分**：每题自带 grade(out) 纯函数，不调 LLM judge、不做语义相似度。
 *    out = { text, toolCalls:[{name,args}], finishKind }。
 * 2. **fixture 自证**：每题必须提供 fixture_pass / fixture_fail 两份 canned 输出，
 *    grader 对 pass 必须 true、对 fail 必须 false；任一破 → 整轮 instrument_healthy=false
 *    （这是「哨兵 must-pass/must-fail」的判分器侧实现：判分器坏了比模型坏了更危险，
 *    且自证不花模型调用）。
 * 3. **vision 不测**：本机无图像输入通道，vision 题 skip=true（status='null'、score=-1），
 *    绝不臆造视觉分数。
 * 4. **world_knowledge 只当校准哨兵**（计划 §5）：它仍真跑一次并留证据（scores 写正确率），
 *    但标记 sentinel=true，**不计入 composite / samples / wilson_lb**——「最高山峰」这类题
 *    多数模型必答对，计入会系统性抬高 composite（进而污染 priority_delta）。真正的可判分维度
 *    只有 coding/tools/long_context/orchestration 四维。
 * 5. **预算**：单题 maxTokens ≤ 512（coding 1024，任务书 L1）；可执行题 5 道（vision 跳过），
 *    其中 4 道判分 + 1 道校准哨兵；因此 max_calls 默认 18 覆盖 3 模型 × 5 题 = 15 次调用。
 * 5. 版本化：SUITE_VERSION 写入每条 evidence，跨版本不混算。
 *
 * 题面语言用中文（被评测模型与操作者同一语境）；判分对大小写/空白做归一化。
 */

export const SUITE_VERSION = 'lite/1'

/** 六维键集（与 CAPABILITY_KEYS 同序）。 */
export const DIMENSIONS = ['coding', 'tools', 'long_context', 'vision', 'world_knowledge', 'orchestration']

/** tools 维专用工具定义（与探针实证同一形状：{name,description,parameters}）。 */
export const TOOL_SPEC = [
  {
    name: 'get_weather',
    description: '查询指定城市的当前天气。',
    parameters: {
      type: 'object',
      properties: { city: { type: 'string', description: '城市名，例如 北京' } },
      required: ['city'],
      additionalProperties: false,
    },
  },
]

/** 归一化：小写、压缩空白、去 markdown 代码围栏（判分只看语义 token，不看重排格式）。 */
export function normalizeText(raw) {
  const text = typeof raw === 'string' ? raw : ''
  return text
    .replace(/```[a-zA-Z0-9_-]*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

/** 从任意文本里抽第一段 JSON 数组（取首个 '[' 到末个 ']'）。 */
export function extractJsonArray(raw) {
  const text = typeof raw === 'string' ? raw : ''
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start < 0 || end <= start) return { ok: false, value: undefined, reason: '未找到 JSON 数组' }
  try {
    return { ok: true, value: JSON.parse(text.slice(start, end + 1)), reason: '' }
  } catch (error) {
    return { ok: false, value: undefined, reason: `JSON 解析失败: ${String(error?.message ?? error).slice(0, 80)}` }
  }
}

function toolCallPass(out, { name, argKey, pattern }) {
  const calls = Array.isArray(out?.toolCalls) ? out.toolCalls : []
  for (const call of calls) {
    if (call?.name !== name) continue
    if (typeof argKey !== 'string') return { pass: true, detail: `命中工具调用 ${name}` }
    let parsed
    try {
      parsed = JSON.parse(typeof call.args === 'string' && call.args !== '' ? call.args : '{}')
    } catch {
      continue
    }
    const value = parsed?.[argKey]
    if (typeof value === 'string' && pattern.test(value)) return { pass: true, detail: `${name}.${argKey}=${value}` }
  }
  return { pass: false, detail: `未出现 ${name}(${argKey} 匹配 ${String(pattern)}) 的工具调用` }
}

const CODING_FIXTURE_PASS = [
  '```js',
  'function fib(n) {',
  '  if (n < 2) return n;',
  '  let a = 0, b = 1;',
  '  for (let i = 2; i <= n; i += 1) { const c = a + b; a = b; b = c; }',
  '  return b;',
  '}',
  '// 结果: 55',
  '```',
].join('\n')

const CODING_FIXTURE_FAIL = '抱歉，我不太会写这道题。'

const LONG_CONTEXT_PROMPT = [
  '下面是一份项目台账摘录，请仔细阅读后回答问题。',
  '',
  '| 项目 | 负责人 | 状态 | 校验码 |',
  '| --- | --- | --- | --- |',
  '| A 项目 | 张伟 | 进行中 | XQ-731 |',
  '| B 项目 | 李娜 | 已归档 | LM-208 |',
  '| C 项目 | 王强 | 进行中 | RT-447 |',
  '| D 项目 | 赵敏 | 已归档 | KZ-990 |',
  '',
  '补充说明（与问题无关）：台账每周一更新；归档项目只读；校验码由四位字母加三位数字组成；',
  '负责人按入职时间排序；状态只有「进行中」与「已归档」两种；A 项目的启动日期是三月九日；',
  'D 项目由赵敏负责；B 项目的归档日期是六月二日；所有项目必须每季度复核一次。',
  '',
  '问题：请找出 A 项目与 C 项目的校验码，严格按 `A=<码> C=<码>` 的格式只输出这一行，不要解释。',
].join('\n')

const ORCHESTRATION_FIXTURE_PASS = JSON.stringify([
  { id: 't1', name: '设计登录页视觉与交互', deps: [] },
  { id: 't2', name: '实现登录表单与校验', deps: ['t1'] },
  { id: 't3', name: '接入会话与联调评审', deps: ['t2'] },
])

/**
 * @typedef {{ id:string, dimension:string, maxTokens:number, prompt:string,
 *             tools:null|Array<object>, skip?:boolean, sentinel?:boolean,
 *             grade:(out:object)=>{pass:boolean,detail:string},
 *             fixture_pass:object, fixture_fail:object }} EvalTask
 */
/** @type {EvalTask[]} */
export const TASKS = [
  {
    id: 'coding-1',
    dimension: 'coding',
    maxTokens: 1024,
    tools: null,
    prompt: [
      '用 JavaScript 写一个函数 `fib(n)`，返回第 n 个斐波那契数（fib(0)=0，fib(1)=1）。',
      '只输出一个代码块，不要解释。代码块最后一行用注释标注 `fib(10)` 的实际计算结果，格式为 `// 结果: <值>`。',
    ].join('\n'),
    grade(out) {
      const text = normalizeText(out?.text)
      const hasFn = /\bfib\s*\(/.test(text) && /\breturn\b/.test(text)
      const has55 = /(^|[^\d])55([^\d]|$)/.test(text)
      return {
        pass: hasFn && has55,
        detail: `has_fib_fn=${hasFn} has_55=${has55}`,
      }
    },
    fixture_pass: { text: CODING_FIXTURE_PASS, toolCalls: [], finishKind: 'stop' },
    fixture_fail: { text: CODING_FIXTURE_FAIL, toolCalls: [], finishKind: 'stop' },
  },
  {
    id: 'tools-1',
    dimension: 'tools',
    maxTokens: 512,
    tools: TOOL_SPEC,
    prompt: '请调用 get_weather 工具查询北京的天气。只发起工具调用，不要输出任何解释文字。',
    grade(out) {
      return toolCallPass(out, { name: 'get_weather', argKey: 'city', pattern: /北京|beijing/i })
    },
    fixture_pass: { text: '', toolCalls: [{ name: 'get_weather', args: '{"city":"北京"}' }], finishKind: 'tool-calls' },
    fixture_fail: { text: '北京今天晴，20 度。', toolCalls: [], finishKind: 'stop' },
  },
  {
    id: 'long_context-1',
    dimension: 'long_context',
    maxTokens: 512,
    tools: null,
    prompt: LONG_CONTEXT_PROMPT,
    grade(out) {
      const text = normalizeText(out?.text)
      const hasA = text.includes('xq-731')
      const hasC = text.includes('rt-447')
      return { pass: hasA && hasC, detail: `A=${hasA} C=${hasC}` }
    },
    fixture_pass: { text: 'A=XQ-731 C=RT-447', toolCalls: [], finishKind: 'stop' },
    fixture_fail: { text: 'A=LM-208 C=RT-447', toolCalls: [], finishKind: 'stop' },
  },
  {
    id: 'vision-1',
    dimension: 'vision',
    maxTokens: 0,
    tools: null,
    skip: true,
    prompt: '（不执行：本机无图像输入通道，vision 维度固定 null。）',
    grade() {
      return { pass: false, detail: 'vision 维度不测，不参与判分' }
    },
    fixture_pass: { text: '', toolCalls: [], finishKind: 'stop' },
    fixture_fail: { text: '', toolCalls: [], finishKind: 'stop' },
  },
  {
    id: 'world_knowledge-1',
    dimension: 'world_knowledge',
    maxTokens: 256,
    tools: null,
    // 校准哨兵：真跑一次留证据，但不计入 composite/samples（见文件头第 4 条）。
    sentinel: true,
    prompt: '世界上最高的山峰是哪座？只回答山名，不要解释。',
    grade(out) {
      const text = normalizeText(out?.text)
      const hit = /珠穆朗玛|珠峰|everest|qomolangma/.test(text)
      return { pass: hit, detail: `hit=${hit}` }
    },
    fixture_pass: { text: '珠穆朗玛峰', toolCalls: [], finishKind: 'stop' },
    fixture_fail: { text: '乞力马扎罗山', toolCalls: [], finishKind: 'stop' },
  },
  {
    id: 'orchestration-1',
    dimension: 'orchestration',
    maxTokens: 512,
    tools: null,
    prompt: [
      '把目标「给一个网站加登录页」拆成 3 个子任务。',
      '只输出一个 JSON 数组，不要解释；每项形如 {"id":"t1","name":"...","deps":[]}，deps 只能引用数组内已出现的 id。',
    ].join('\n'),
    grade(out) {
      const parsed = extractJsonArray(out?.text)
      if (!parsed.ok) return { pass: false, detail: parsed.reason }
      if (!Array.isArray(parsed.value) || parsed.value.length < 3) return { pass: false, detail: `数组长度不足 3（${Array.isArray(parsed.value) ? parsed.value.length : 'n/a'}）` }
      const ids = []
      for (const item of parsed.value) {
        if (item === null || typeof item !== 'object') return { pass: false, detail: '存在非对象项' }
        if (typeof item.id !== 'string' || item.id === '') return { pass: false, detail: '存在缺 id 项' }
        if (typeof item.name !== 'string' || item.name.trim() === '') return { pass: false, detail: `项 ${item.id} 缺 name` }
        if (!Array.isArray(item.deps)) return { pass: false, detail: `项 ${item.id} 的 deps 不是数组` }
        ids.push(item.id)
      }
      const seen = new Set()
      for (const item of parsed.value) {
        for (const dep of item.deps) {
          if (typeof dep !== 'string' || !ids.includes(dep)) return { pass: false, detail: `项 ${item.id} 的 dep "${String(dep)}" 不在数组内` }
          if (dep === item.id) return { pass: false, detail: `项 ${item.id} 自引用` }
          seen.add(dep)
        }
      }
      return { pass: true, detail: `tasks=${ids.length} deps=${seen.size}` }
    },
    fixture_pass: { text: ORCHESTRATION_FIXTURE_PASS, toolCalls: [], finishKind: 'stop' },
    fixture_fail: { text: '[{"id":"t1"}]', toolCalls: [], finishKind: 'stop' },
  },
]

/** 可执行题（skip=true 的不产生调用）。 */
export const EXECUTABLE_TASKS = TASKS.filter((task) => task.skip !== true)

/**
 * 判分器哨兵自证：每道题对自己的 fixture 必须给出 pass=true / fail=false。
 * 纯函数、零模型调用；任一破即整轮 instrument_healthy=false（不写分数）。
 * @returns {{ ok:boolean, issues:string[] }}
 */
export function sentinelCheck(tasks = TASKS) {
  const issues = []
  for (const task of tasks) {
    if (task.skip === true) continue
    let pass
    let fail
    try {
      pass = task.grade(task.fixture_pass)
      fail = task.grade(task.fixture_fail)
    } catch (error) {
      issues.push(`${task.id}: grader 抛错 ${String(error?.message ?? error).slice(0, 120)}`)
      continue
    }
    if (pass?.pass !== true) issues.push(`${task.id}: must-pass fixture 判 false（${pass?.detail ?? ''}）`)
    if (fail?.pass !== false) issues.push(`${task.id}: must-fail fixture 判 true（${fail?.detail ?? ''}）`)
  }
  return { ok: issues.length === 0, issues }
}

/** 单题输出 → 判分结果（runner 与自检共用）。 */
export function gradeTask(task, out) {
  try {
    const result = task.grade(out)
    return { pass: result?.pass === true, detail: String(result?.detail ?? '') }
  } catch (error) {
    return { pass: false, detail: `grader 抛错: ${String(error?.message ?? error).slice(0, 120)}` }
  }
}

export default { SUITE_VERSION, DIMENSIONS, TASKS, EXECUTABLE_TASKS, TOOL_SPEC, sentinelCheck, gradeTask }
