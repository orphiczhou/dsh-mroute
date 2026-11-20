#!/usr/bin/env node
/**
 * mroute-dispatch skill 自检（零依赖）。
 *
 * 校验项（任务书 §2.4）：
 *  1. SKILL.md 存在，YAML frontmatter 完整（首行 --- + 闭合 ---）
 *  2. name === 目录名（mroute-dispatch）
 *  3. description 长度 40..600，且覆盖必需触发词
 *  4. SKILL.md 行数 <= 160，无 tab
 *  5. references/tools.md 与 references/troubleshooting.md 存在且行数 >= 20
 *  6. 正文包含必需关键词：三步流程 / need / advisory-only / mroute_dispatch_plan
 *  7. 不出现用户目录或疑似密钥字样（sir_c / C:\\Users / sk- / Bearer ）
 *
 * 输出：成功打印 OK + 摘要；失败打印 FAIL 与逐条原因，退出码 1。
 */
import { readFileSync, existsSync } from 'node:fs'
import { dirname, basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const EXPECTED_NAME = 'mroute-dispatch'
const SKILL_MAX_LINES = 160
const DESC_MIN = 40
const DESC_MAX = 600
const REF_MIN_LINES = 20
const REQUIRED_BODY_KEYWORDS = ['三步流程', 'need', 'advisory-only', 'mroute_dispatch_plan']
const REQUIRED_SECTION_KEYWORDS = ['何时用', '怎么读返回', '常见坑', '面板']
const REQUIRED_TRIGGER_WORDS = [
  '派遣子会话', '选模型', '模型优先级', '余额/额度', '包月渠道', '策略门被拒',
  '能力档位', '模型归并', '动态沉底', 'mroute_dispatch_plan', 'model_route_query',
  'dispatch subagent model',
]
const LEAK_PATTERNS = ['sir_c', 'C:\\Users', 'sk-', 'Bearer ']

const root = dirname(fileURLToPath(import.meta.url))
const skillPath = join(root, 'SKILL.md')
const failures = []
const fail = (message) => failures.push(message)

/** 统一换行并去掉末尾换行后计行数（空文件计 0 行）。 */
function countLines(text) {
  const normalized = text.replace(/\r\n/g, '\n')
  if (normalized === '') return 0
  return normalized.replace(/\n$/, '').split('\n').length
}

function stripQuotes(value) {
  const trimmed = value.trim()
  if (trimmed.length >= 2) {
    const first = trimmed[0]
    const last = trimmed[trimmed.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1).trim()
    }
  }
  return trimmed
}

let skillRaw = null
if (!existsSync(skillPath)) {
  fail('SKILL.md 不存在')
} else {
  skillRaw = readFileSync(skillPath, 'utf8')
}

let frontmatter = null
let body = ''
if (skillRaw !== null) {
  const match = skillRaw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  if (!match) {
    fail('SKILL.md 缺少 YAML frontmatter（首行必须是 ---，并有闭合 ---）')
  } else {
    frontmatter = match[1]
    body = skillRaw.slice(match[0].length)
  }

  if (frontmatter !== null) {
    const nameMatch = frontmatter.match(/^name:\s*(.+?)\s*$/m)
    if (!nameMatch) {
      fail('frontmatter 缺少 name')
    } else {
      const name = stripQuotes(nameMatch[1])
      const dirName = basename(root)
      if (name !== dirName) fail(`frontmatter name "${name}" 与目录名 "${dirName}" 不一致`)
      if (name !== EXPECTED_NAME) fail(`frontmatter name 应为 "${EXPECTED_NAME}"，实际 "${name}"`)
    }

    const descMatch = frontmatter.match(/^description:\s*(.*)$/m)
    if (!descMatch) {
      fail('frontmatter 缺少 description')
    } else {
      const description = stripQuotes(descMatch[1])
      if (description.length < DESC_MIN || description.length > DESC_MAX) {
        fail(`description 长度 ${description.length}，要求 ${DESC_MIN}..${DESC_MAX}`)
      }
      const missingTriggers = REQUIRED_TRIGGER_WORDS.filter((word) => !description.includes(word))
      if (missingTriggers.length > 0) {
        fail(`description 缺少触发词: ${missingTriggers.join('、')}`)
      }
    }
  }

  const lineCount = countLines(skillRaw)
  if (lineCount > SKILL_MAX_LINES) fail(`SKILL.md 行数 ${lineCount} > ${SKILL_MAX_LINES}`)
  if (skillRaw.includes('\t')) fail('SKILL.md 含 tab（要求纯空格缩进）')

  for (const keyword of REQUIRED_BODY_KEYWORDS) {
    if (!body.includes(keyword)) fail(`正文缺少必需关键词: ${keyword}`)
  }
  for (const keyword of REQUIRED_SECTION_KEYWORDS) {
    if (!body.includes(keyword)) fail(`正文缺少必需小节关键词: ${keyword}`)
  }
  for (const pattern of LEAK_PATTERNS) {
    if (skillRaw.includes(pattern)) fail(`SKILL.md 含疑似敏感/用户路径字样: ${pattern}`)
  }
}

const references = [
  { label: 'references/tools.md', path: join(root, 'references', 'tools.md') },
  { label: 'references/troubleshooting.md', path: join(root, 'references', 'troubleshooting.md') },
]
const refLines = []
for (const reference of references) {
  if (!existsSync(reference.path)) {
    fail(`${reference.label} 不存在`)
    refLines.push(`${reference.label}: missing`)
    continue
  }
  const text = readFileSync(reference.path, 'utf8')
  const lines = countLines(text)
  refLines.push(`${reference.label}: ${lines} lines`)
  if (lines < REF_MIN_LINES) fail(`${reference.label} 行数 ${lines} < ${REF_MIN_LINES}`)
}

if (failures.length > 0) {
  console.log(`FAIL: ${failures.length} problem(s)`)
  for (const failure of failures) console.log(`- ${failure}`)
  process.exitCode = 1
} else {
  const descMatch = frontmatter.match(/^description:\s*(.*)$/m)
  const description = stripQuotes(descMatch[1])
  console.log('OK')
  console.log(`- SKILL.md: ${countLines(skillRaw)} lines, name=${EXPECTED_NAME}, description=${description.length} chars`)
  for (const line of refLines) console.log(`- ${line}`)
  console.log(`- required keywords / sections / trigger words: all present`)
}
