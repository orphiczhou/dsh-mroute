/**
 * M5.1 正式评测题集 formal/1（任务书 docs/briefs/m5.1-formal-eval.md §2.4 定稿版）。
 *
 * 题量（单模型 38 次调用）：
 *   coding 10 / tools 10 / long_context 10 / orchestration 6（均 graded，per-dim n=10/10/10/6）
 *   world_knowledge 2（校准哨兵，不计 composite）/ vision 1（恒 null、零调用）。
 *
 * 纪律（与 suite-lite 同源，逐条沿用）：
 * 1. 确定性判分：grade(text/toolCalls/finishKind) 纯函数，禁 LLM judge、禁语义相似度。
 * 2. fixture 自证：每题 fixture_pass / fixture_fail 双向；任一破 → instrument_healthy=false（零模型调用）。
 * 3. vision 不测（skip=true）；world_knowledge 只作哨兵（sentinel=true，scores 留证据不计分）。
 * 4. 预算：单题 maxTokens ≤ 512（coding 1024）；prompt 内嵌长文本控制在 ~1500 tokens 内。
 * 5. 题面不依赖外网、不依赖长上下文文件；长文题 = 内嵌唯一 token 双点检索。
 *
 * 工厂复用 suite-lite 的 normalizeText / extractJsonArray；sentinelCheck / gradeTask 按
 * lite 同形状自实现（二者是通用 task 形状函数，复制以保持模块自包含）。
 */
import { normalizeText, extractJsonArray, DIMENSIONS } from './suite-lite.mjs'

export const SUITE_VERSION = 'formal/1'

// ── 通用判分助手（与 suite-lite 同语义，模块自包含）──────────────────────────

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

/** 数值边界匹配：避免 24 命中 240 的子串（normalizeText 已小写化）。 */
function numberToken(value) {
  return new RegExp(`(^|[^0-9])${value}([^0-9]|$)`)
}

// ── coding × 10：函数名在场 + `// 结果: <值>` 数值/取值正确 ───────────────────

function codingValueTask({ n, fn, problem, call, value, valuePattern }) {
  const pattern = valuePattern ?? numberToken(String(value).toLowerCase())
  return {
    id: `coding-${n}`,
    dimension: 'coding',
    maxTokens: 1024,
    tools: null,
    prompt: [
      `用 JavaScript 写一个函数 \`${fn}\`。${problem}`,
      `只输出一个代码块，不要解释。代码块最后一行用注释标注 ${call} 的实际计算结果，格式为 \`// 结果: <值>\`。`,
    ].join('\n'),
    grade(out) {
      const text = normalizeText(out?.text)
      const hasFn = new RegExp(`\\b${fn}\\s*\\(`, 'i').test(text)
      const hasValue = pattern.test(text)
      return { pass: hasFn && hasValue, detail: `has_${fn}=${hasFn} has_value=${hasValue}` }
    },
    fixture_pass: { text: `function ${fn}(input) { /* 正确实现 */ return input; }\n// 结果: ${value}`, toolCalls: [], finishKind: 'stop' },
    fixture_fail: { text: '抱歉，这道题我不太确定怎么写。', toolCalls: [], finishKind: 'stop' },
  }
}

const CODING_TASKS = [
  codingValueTask({ n: 1, fn: 'fib', problem: '返回第 n 个斐波那契数（fib(0)=0，fib(1)=1）。', call: 'fib(10)', value: 55 }),
  codingValueTask({ n: 2, fn: 'factorial', problem: '返回 n 的阶乘（非负整数）。', call: 'factorial(6)', value: 720 }),
  codingValueTask({ n: 3, fn: 'sumList', problem: '返回数组的元素总和。', call: 'sumList([3,7,1,9,4])', value: 24 }),
  codingValueTask({ n: 4, fn: 'countVowels', problem: '统计字符串里的小写元音字母（a/e/i/o/u）个数。', call: 'countVowels("beautiful")', value: 5 }),
  codingValueTask({ n: 5, fn: 'reverseString', problem: '返回字符串的反转。', call: 'reverseString("hello")', value: 'olleh', valuePattern: /olleh/ }),
  codingValueTask({ n: 6, fn: 'findMax', problem: '返回数组中的最大值。', call: 'findMax([12,5,8,20,3])', value: 20 }),
  codingValueTask({ n: 7, fn: 'isPrime', problem: '判断 n 是否为质数，返回布尔值。', call: 'isPrime(29)', value: 'true', valuePattern: /(^|[^a-z])true([^a-z]|$)/ }),
  codingValueTask({ n: 8, fn: 'gcd', problem: '用辗转相除法返回两个正整数的最大公约数。', call: 'gcd(48,18)', value: 6 }),
  codingValueTask({ n: 9, fn: 'toBinary', problem: '把非负整数转换成二进制字符串（不用前缀）。', call: 'toBinary(13)', value: '1101', valuePattern: /(^|[^01])1101([^01]|$)/ }),
  codingValueTask({ n: 10, fn: 'secondLargest', problem: '返回数组中第二大的**不同**元素。', call: 'secondLargest([4,9,2,7,9,5])', value: 7 }),
]

// ── tools × 10：单工具声明 + 单轮工具调用（name + 关键参数匹配）───────────────

function toolsCallTask({ n, tool, toolDesc, argKey, argDesc, query, pattern, argValue }) {
  const spec = [
    {
      name: tool,
      description: toolDesc,
      parameters: {
        type: 'object',
        properties: { [argKey]: { type: 'string', description: argDesc } },
        required: [argKey],
        additionalProperties: false,
      },
    },
  ]
  return {
    id: `tools-${n}`,
    dimension: 'tools',
    maxTokens: 512,
    tools: spec,
    prompt: `请调用 ${tool} 工具${query}。只发起工具调用，不要输出任何解释文字。`,
    grade(out) {
      return toolCallPass(out, { name: tool, argKey, pattern })
    },
    fixture_pass: { text: '', toolCalls: [{ name: tool, args: JSON.stringify({ [argKey]: argValue }) }], finishKind: 'tool-calls' },
    fixture_fail: { text: `好的，已为你查询（但没有发起工具调用）。`, toolCalls: [], finishKind: 'stop' },
  }
}

const TOOLS_TASKS = [
  toolsCallTask({ n: 1, tool: 'get_weather', toolDesc: '查询指定城市的当前天气。', argKey: 'city', argDesc: '城市名，例如 北京', query: '查询北京的天气', argValue: '北京', pattern: /北京|beijing/i }),
  toolsCallTask({ n: 2, tool: 'lookup_capital', toolDesc: '查询指定国家的首都。', argKey: 'country', argDesc: '国家名，例如 法国', query: '查询法国的首都', argValue: '法国', pattern: /法国|france/i }),
  toolsCallTask({ n: 3, tool: 'get_stock_price', toolDesc: '查询股票的当前价格。', argKey: 'symbol', argDesc: '股票代码，例如 AAPL', query: '查询 AAPL 的股价', argValue: 'AAPL', pattern: /aapl/i }),
  toolsCallTask({ n: 4, tool: 'currency_rate', toolDesc: '查询货币的当前汇率。', argKey: 'base', argDesc: '基准货币代码，例如 USD', query: '查询以 USD 为基准的汇率', argValue: 'USD', pattern: /usd|美元/i }),
  toolsCallTask({ n: 5, tool: 'get_timezone', toolDesc: '查询城市所在的时区。', argKey: 'city', argDesc: '城市名，例如 东京', query: '查询东京的时区', argValue: '东京', pattern: /东京|tokyo/i }),
  toolsCallTask({ n: 6, tool: 'translate_word', toolDesc: '把词语翻译成英文。', argKey: 'text', argDesc: '要翻译的词语，例如 你好', query: '翻译「你好」', argValue: '你好', pattern: /你好|hello/i }),
  toolsCallTask({ n: 7, tool: 'lookup_word', toolDesc: '查询英文单词的释义。', argKey: 'word', argDesc: '单词，例如 serendipity', query: '查 serendipity 的释义', argValue: 'serendipity', pattern: /serendipity/i }),
  toolsCallTask({ n: 8, tool: 'flight_status', toolDesc: '查询航班状态。', argKey: 'flight', argDesc: '航班号，例如 CA1234', query: '查询 CA1234 航班', argValue: 'CA1234', pattern: /ca[\s-]*1234/i }),
  toolsCallTask({ n: 9, tool: 'search_movie', toolDesc: '按片名搜索电影信息。', argKey: 'title', argDesc: '电影片名，例如 盗梦空间', query: '搜索电影「盗梦空间」', argValue: '盗梦空间', pattern: /盗梦空间|inception/i }),
  toolsCallTask({ n: 10, tool: 'sports_score', toolDesc: '查询球队最近比分。', argKey: 'team', argDesc: '球队名，例如 湖人', query: '查询湖人队最近比分', argValue: '湖人', pattern: /湖人|lakers/i }),
]

// ── long_context × 10：内嵌台账 + 双点唯一 token 检索 ─────────────────────────

function lcCodeTask({ n, theme, header, rows, qA, qB, filler }) {
  const table = [header, '| --- | --- | --- |', ...rows.map((row) => `| ${row[0]} | ${row[1]} | ${row[2]} |`)].join('\n')
  const [aName, , aCode] = rows[qA]
  const [bName, , bCode] = rows[qB]
  return {
    id: `long_context-${n}`,
    dimension: 'long_context',
    maxTokens: 512,
    tools: null,
    prompt: [
      `下面是一份${theme}台账摘录，请仔细阅读后回答问题。`,
      '',
      table,
      '',
      `补充说明（与问题无关）：${filler}`,
      '',
      `问题：请找出 ${aName} 与 ${bName} 的校验码，严格按 \`${aName}=<码> ${bName}=<码>\` 的格式只输出这一行，不要解释。`,
    ].join('\n'),
    grade(out) {
      const text = normalizeText(out?.text)
      const hasA = text.includes(aCode.toLowerCase())
      const hasB = text.includes(bCode.toLowerCase())
      return { pass: hasA && hasB, detail: `${aName}=${hasA} ${bName}=${hasB}` }
    },
    fixture_pass: { text: `${aName}=${aCode} ${bName}=${bCode}`, toolCalls: [], finishKind: 'stop' },
    fixture_fail: { text: `${aName}=${rows[(qA + 3) % rows.length][2]} ${bName}=${bCode}`, toolCalls: [], finishKind: 'stop' },
  }
}

const LC_DATASETS = [
  {
    theme: '仓库盘点', header: '| 货位 | 负责人 | 校验码 |',
    rows: [
      ['A-01 货位', '张伟', 'QZ-417'], ['A-02 货位', '李娜', 'WT-263'], ['A-03 货位', '王强', 'EV-851'],
      ['B-01 货位', '赵敏', 'LU-094'], ['B-02 货位', '陈晨', 'HP-628'], ['B-03 货位', '刘洋', 'DK-372'],
      ['C-01 货位', '周杰', 'FM-749'], ['C-02 货位', '吴霞', 'GN-135'], ['C-03 货位', '郑凯', 'BX-580'],
      ['D-01 货位', '孙丽', 'TJ-206'],
    ],
    filler: '台账每周一更新；校验码由两位字母加三位数字组成；负责人按入职时间排序；盘点必须双人复核。',
  },
  {
    theme: '设备巡检', header: '| 设备 | 责任工程师 | 校验码 |',
    rows: [
      ['空压机-1', '马超', 'KX-341'], ['空压机-2', '黄忠', 'RB-876'], ['冷却塔-A', '徐庶', 'MW-129'],
      ['冷却塔-B', '庞统', 'ZC-653'], ['锅炉-East', '法正', 'YL-487'], ['锅炉-West', '姜维', 'SN-015'],
      ['电梯-客梯', '邓艾', 'VQ-792'], ['电梯-货梯', '钟会', 'AT-538'], ['配电柜-P1', '陆逊', 'EO-264'],
      ['配电柜-P2', '鲁肃', 'IJ-907'],
    ],
    filler: '巡检周期为两周；校验码贴在设备铭牌下方；责任工程师按区域划分；异常读数须当天上报。',
  },
  {
    theme: '图书编目', header: '| 书架 | 管理员 | 校验码 |',
    rows: [
      ['文史-01', '杜甫', 'SD-583'], ['文史-02', '李白', 'AN-246'], ['科技-11', '苏轼', 'KJ-970'],
      ['科技-12', '辛弃疾', 'UB-418'], ['少儿-21', '李清照', 'PM-635'], ['少儿-22', '欧阳修', 'CG-182'],
      ['外文-31', '王安石', 'XF-759'], ['外文-32', '柳宗元', 'TD-324'], ['期刊-41', '韩愈', 'BH-861'],
      ['期刊-42', '白居易', 'VR-507'],
    ],
    filler: '编目每月校对一次；校验码印在书架侧面标签；管理员按楼层值班；借阅异常需登记台账。',
  },
  {
    theme: '订单履约', header: '| 批次 | 跟单员 | 校验码 |',
    rows: [
      ['LOT-1101', '秦琼', 'XA-690'], ['LOT-1102', '尉迟恭', 'NE-257'], ['LOT-1103', '程咬金', 'UW-813'],
      ['LOT-1104', '单雄信', 'LO-462'], ['LOT-1105', '徐茂公', 'FD-078'], ['LOT-1106', '罗成', 'IQ-521'],
      ['LOT-1107', '王伯当', 'SV-386'], ['LOT-1108', '谢映登', 'GA-944'], ['LOT-1109', '柴绍', 'ZP-150'],
      ['LOT-1110', '长孙无忌', 'HC-703'],
    ],
    filler: '批次按下单日命名；校验码随发货单发出；跟单员按区域分线；超期未发须升级处理。',
  },
]

const LC_TASKS = [
  lcCodeTask({ n: 1, ...LC_DATASETS[0], qA: 0, qB: 5 }),
  lcCodeTask({ n: 2, ...LC_DATASETS[0], qA: 2, qB: 8 }),
  lcCodeTask({ n: 3, ...LC_DATASETS[0], qA: 4, qB: 9 }),
  lcCodeTask({ n: 4, ...LC_DATASETS[1], qA: 1, qB: 6 }),
  lcCodeTask({ n: 5, ...LC_DATASETS[1], qA: 3, qB: 8 }),
  lcCodeTask({ n: 6, ...LC_DATASETS[1], qA: 0, qB: 9 }),
  lcCodeTask({ n: 7, ...LC_DATASETS[2], qA: 2, qB: 7 }),
  lcCodeTask({ n: 8, ...LC_DATASETS[2], qA: 4, qB: 9 }),
  lcCodeTask({ n: 9, ...LC_DATASETS[3], qA: 1, qB: 5 }),
  lcCodeTask({ n: 10, ...LC_DATASETS[3], qA: 3, qB: 7 }),
]

// ── orchestration × 6：计划 JSON 结构校验（id/name/deps 引用合法）────────────

function orchPlanTask({ n, goal, count }) {
  const chain = Array.from({ length: count }, (_unused, index) => ({
    id: `t${index + 1}`,
    name: `子任务${index + 1}`,
    deps: index === 0 ? [] : [`t${index}`],
  }))
  return {
    id: `orchestration-${n}`,
    dimension: 'orchestration',
    maxTokens: 512,
    tools: null,
    prompt: [
      `把目标「${goal}」拆成 ${count} 个子任务。`,
      '只输出一个 JSON 数组，不要解释；每项形如 {"id":"t1","name":"...","deps":[]}，deps 只能引用数组内已出现的 id。',
    ].join('\n'),
    grade(out) {
      const parsed = extractJsonArray(out?.text)
      if (!parsed.ok) return { pass: false, detail: parsed.reason }
      if (!Array.isArray(parsed.value) || parsed.value.length < count) return { pass: false, detail: `数组长度不足 ${count}（${Array.isArray(parsed.value) ? parsed.value.length : 'n/a'}）` }
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
    fixture_pass: { text: JSON.stringify(chain), toolCalls: [], finishKind: 'stop' },
    fixture_fail: { text: '[{"id":"t1"}]', toolCalls: [], finishKind: 'stop' },
  }
}

const ORCH_TASKS = [
  orchPlanTask({ n: 1, goal: '给一个网站加登录页', count: 3 }),
  orchPlanTask({ n: 2, goal: '把单体应用的数据库迁移到新版本', count: 4 }),
  orchPlanTask({ n: 3, goal: '给现有网站做移动端适配', count: 3 }),
  orchPlanTask({ n: 4, goal: '搭建团队周报自动汇总系统', count: 4 }),
  orchPlanTask({ n: 5, goal: '给支付系统接入新的支付渠道', count: 4 }),
  orchPlanTask({ n: 6, goal: '建立用户反馈分类处理流程', count: 3 }),
]

// ── world_knowledge × 2（校准哨兵）+ vision × 1（恒 null）────────────────────

const SENTINEL_TASKS = [
  {
    id: 'world_knowledge-1',
    dimension: 'world_knowledge',
    maxTokens: 256,
    tools: null,
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
    id: 'world_knowledge-2',
    dimension: 'world_knowledge',
    maxTokens: 256,
    tools: null,
    sentinel: true,
    prompt: '中国的首都是哪座城市？只回答城市名，不要解释。',
    grade(out) {
      const text = normalizeText(out?.text)
      const hit = /北京|beijing|peking/.test(text)
      return { pass: hit, detail: `hit=${hit}` }
    },
    fixture_pass: { text: '北京', toolCalls: [], finishKind: 'stop' },
    fixture_fail: { text: '上海', toolCalls: [], finishKind: 'stop' },
  },
]

const VISION_TASK = {
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
}

// ── 汇总导出（与 suite-lite 同形状）─────────────────────────────────────────

/** @type {Array<object>} */
export const TASKS = [...CODING_TASKS, ...TOOLS_TASKS, ...LC_TASKS, ...ORCH_TASKS, ...SENTINEL_TASKS, VISION_TASK]

export const EXECUTABLE_TASKS = TASKS.filter((task) => task.skip !== true)

/**
 * 判分器哨兵自证（与 suite-lite.sentinelCheck 同语义）。
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

export default { SUITE_VERSION, DIMENSIONS, TASKS, EXECUTABLE_TASKS, sentinelCheck, gradeTask }
