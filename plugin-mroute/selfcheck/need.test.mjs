/**
 * selfcheck/need.test.mjs — M4.8 交付：能力匹配推荐。
 * 覆盖：need 校验闭集与错误文案、评级序/'none' vs 未登记、AND 匹配、fit/最小裕度/最低评级、
 * readRegistry 透出归一化 model_ratings（M4.7 遗留修复）、execute 的 matching_models/
 * suggested_model/model_picks/meta.capability_need/unrated_models、不传 need 的键缺席回归、
 * model_picks 同分按 rank 升序、文本渲染（档位/能力需求/匹配模型/推荐段 fit-min/未登记计数）、
 * alias_suggest 不透出 model_ratings。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readRegistry, ratingTableOf, ratingsForModel } from '../lib/registry.js'
import { buildModelsIndex, createRouteQueryTool, renderRouteResult } from '../lib/tool-query.js'
import { createAliasSuggestTool } from '../lib/tool-alias-suggest.js'
import {
  RATING_RANK,
  normalizeNeed,
  ratingValueOf,
  matchesNeed,
  fitScore,
  minMarginInNeed,
  minRatingInNeed,
  needSummary,
} from '../lib/capability-need.js'
import os from 'node:os'

const logger = { info() {}, warn() {}, error() {} }
const TMP = os.tmpdir() + '/mroute-m48-need-selfcheck'

/** 2026-11-20 真机生效 channels[].models（与 cordis.patch.yml 一致）。 */
const CHANNEL_MODELS = {
  'zai-coding-cn': ['glm-5.3', 'glm-5.3-flash', 'glm-5.3-highspeed'],
  'opencode-go': ['qwen3.8-flash', 'deepseek-v4.1-flash', 'glm-5.3-flash', 'longcat-2.0', 'longcat-2.5-preview-free', 'mimo-v2.6-flash'],
  'deepseek-official': ['deepseek-flash', 'deepseek-v4-pro'],
  'deepseek-account': ['deepseek-flash', 'deepseek-v4-pro'],
  xiaomi: ['mimo-v2.6-flash', 'mimo-v2.6-pro'],
}

/** 真机 cordis.patch.yml:476-516 的 8 条 model_ratings（用户 2026-11-20 登记）。 */
const MODEL_RATINGS = {
  'deepseek-flash': { coding: 'excellent', tools: 'excellent', long_context: 'excellent', vision: 'good' },
  'deepseek-v4-pro': { coding: 'good', tools: 'good', long_context: 'excellent', vision: 'none' },
  'glm-5.3-flash': { coding: 'good', tools: 'excellent', long_context: 'good', vision: 'good' },
  'mimo-v2.6-flash': { coding: 'fair', tools: 'good', long_context: 'good', vision: 'good' },
  'glm-5.3': { coding: 'excellent', tools: 'excellent', long_context: 'excellent', vision: 'none' },
  'glm-5.3-highspeed': { coding: 'excellent', tools: 'excellent', long_context: 'excellent', vision: 'none' },
  'mimo-v2.6-pro': { coding: 'good', tools: 'excellent', long_context: 'excellent', vision: 'good' },
  'qwen3.8-flash': { coding: 'good', tools: 'excellent', long_context: 'excellent', vision: 'excellent' },
}

const MODEL_ALIASES = {
  'zai-coding-cn': { 'glm-5.3-flash': 'glm-5.3-flash' },
  'opencode-go': {
    'deepseek-v4.1-flash': 'deepseek-flash',
    'glm-5.3-flash': 'glm-5.3-flash',
    'mimo-v2.6-flash': 'mimo-v2.6-flash',
  },
  xiaomi: { 'mimo-v2.6-flash': 'mimo-v2.6-flash', 'mimo-v2.6-pro': 'mimo-v2.6-pro' },
}

const CHANNEL_META = {
  'zai-coding-cn': { channel_type: 'monthly', tier: 'domestic_sota', priority: 90 },
  'opencode-go': { channel_type: 'monthly', tier: 'domestic_sota', priority: 80 },
  'deepseek-official': { channel_type: 'prepaid', tier: 'domestic_sota', priority: 70 },
  'deepseek-account': { channel_type: 'prepaid', tier: 'domestic_sota', priority: 65 },
  xiaomi: { channel_type: 'prepaid', tier: 'bulk', priority: 50 },
}

function channelsOf() {
  return Object.entries(CHANNEL_MODELS).map(([id, models]) => ({ id, routeProvider: id, models: [...models], ...CHANNEL_META[id] }))
}

function registryOf({ ratings = MODEL_RATINGS, aliases = MODEL_ALIASES } = {}) {
  return readRegistry({ channels: channelsOf(), model_aliases: aliases, model_ratings: ratings }, logger)
}

const EXEC = { agent: { options: { provider: 'zai-coding-cn', model: 'glm-5.3' } } }

function routeTool(registry) {
  const livecheck = { async check() { return { status: 'ok', detail: '', availableModels: [] } } }
  return createRouteQueryTool({
    ctx: {},
    getRegistry: () => registry,
    livecheck,
    logger,
    decisionsBaseDir: TMP,
    getQuota: async () => null,
  })
}

test('§1 normalizeNeed：省略/null/空对象/合法/未知维/非法值/非对象', () => {
  assert.deepEqual(normalizeNeed(undefined), { need: null, invalid: null })
  assert.deepEqual(normalizeNeed(null), { need: null, invalid: null })
  assert.deepEqual(normalizeNeed({}), { need: {}, invalid: null })
  assert.deepEqual(normalizeNeed({ coding: 'good', vision: 'fair' }), { need: { coding: 'good', vision: 'fair' }, invalid: null })

  assert.match(normalizeNeed({ foo: 'good' }).invalid.message, /未知能力维度 "foo"/)
  assert.match(normalizeNeed({ coding: 'best' }).invalid.message, /键 "coding" 的值 "best" 非法/)
  assert.match(normalizeNeed({ vision: 'none' }).invalid.message, /vision/, '需求侧不允许 none（none 是模型档位，不是需求）')
  assert.match(normalizeNeed({ coding: 'GOOD' }).invalid.message, /大小写敏感/)
  assert.match(normalizeNeed('coding').invalid.message, /need 必须是对象/)
  assert.match(normalizeNeed([{ coding: 'good' }]).invalid.message, /need 必须是对象/)
})

test('§2 评级序：fair<good<excellent；none=0 与未登记=null 严格区分', () => {
  assert.equal(RATING_RANK.fair, 1)
  assert.ok(RATING_RANK.fair < RATING_RANK.good && RATING_RANK.good < RATING_RANK.excellent)
  assert.equal(RATING_RANK.none, 0)
  assert.equal(ratingValueOf({ coding: 'none' }, 'coding'), 0)
  assert.equal(ratingValueOf({}, 'coding'), null)
  assert.equal(ratingValueOf(null, 'coding'), null)
  assert.equal(ratingValueOf({ coding: 'genius' }, 'coding'), null)
  assert.equal(ratingValueOf({ coding: 'excellent' }, 'vision'), null)
})

test('§3 matchesNeed：多键 AND、none 不满足、未登记不满足、空需求集合语义为真', () => {
  assert.equal(matchesNeed({ coding: 'excellent', vision: 'good' }, { coding: 'good', vision: 'fair' }), true)
  assert.equal(matchesNeed({ coding: 'good', vision: 'fair' }, { coding: 'good', vision: 'good' }), false, 'AND：vision 不足')
  assert.equal(matchesNeed({ coding: 'none' }, { coding: 'fair' }), false, 'none 明确不满足')
  assert.equal(matchesNeed({}, { coding: 'fair' }), false, '未登记不算满足')
  assert.equal(matchesNeed({ coding: 'excellent' }, {}), true, '空需求不做匹配（调用方归一为 null）')
})

test('§4 fit / 最小裕度 / 最低评级 / needSummary', () => {
  const ratings = { coding: 'excellent', tools: 'fair', long_context: 'good', vision: 'good' }
  const need = { coding: 'good', vision: 'fair' }
  assert.equal(fitScore(ratings, need), 5, 'excellent(3) + good(2)')
  assert.equal(minMarginInNeed(ratings, need), 1, 'min(3-2, 2-1)')
  assert.equal(minRatingInNeed(ratings, need), 'good')
  assert.equal(fitScore({ coding: 'excellent' }, need), null, '任一维未登记 → 不可评分')
  assert.equal(minMarginInNeed({ coding: 'none', vision: 'good' }, need), -2, "none(0)-good(2)")
  assert.equal(minRatingInNeed({ coding: 'none', vision: 'good' }, need), 'none')
  assert.equal(needSummary({ vision: 'good', coding: 'fair' }), 'coding≥fair, vision≥good')
  assert.equal(needSummary({}), '')
})

test('§5 readRegistry 透出归一化 model_ratings（M4.7 遗留修复）+ models_index 档位不再为空', async () => {
  const registry = registryOf()
  assert.deepEqual(registry.model_ratings['deepseek-v4-pro'], { coding: 'good', tools: 'good', long_context: 'excellent', vision: 'none' })
  assert.equal(registry.model_ratings['glm-5.3'].vision, 'none', "'none' 原样保留")

  const channel = registry.channels.find((row) => row.id === 'deepseek-official')
  assert.equal(ratingsForModel(channel, 'deepseek-v4-pro', 'deepseek-v4-pro', registry.model_ratings).vision, 'none')
  assert.equal(ratingsForModel(channel, 'longcat-2.0', 'longcat-2.0', registry.model_ratings), null, '未登记 → null')

  assert.deepEqual(
    ratingTableOf({ bad: { coding: 'genius' }, ok: { vision: 'none', coding: 'good' }, '': { coding: 'good' }, arr: [] }),
    { ok: { vision: 'none', coding: 'good' } },
    '闭集过滤 + 空行/空名丢弃',
  )

  const value = await routeTool(registry).execute({}, EXEC)
  const glm = value.models_index.find((group) => group.canonical === 'glm-5.3')
  assert.equal(glm.ratings.vision, 'none', 'models_index.ratings 现在能取到 model_ratings')
  const v4pro = value.models_index.find((group) => group.canonical === 'deepseek-v4-pro')
  assert.deepEqual(v4pro.ratings, { coding: 'good', tools: 'good', long_context: 'excellent', vision: 'none' })
})

test('§6 execute need={coding:excellent}：matching_models/suggested_model/model_picks', async () => {
  const value = await routeTool(registryOf()).execute({ need: { coding: 'excellent' } }, EXEC)
  assert.deepEqual(value.routes.map((route) => route.channel_id), ['zai-coding-cn', 'opencode-go', 'deepseek-official', 'deepseek-account', 'xiaomi'], 'routes[] 排序不变')

  const zai = value.routes[0]
  assert.deepEqual(zai.matching_models, ['glm-5.3', 'glm-5.3-highspeed'])
  assert.equal(zai.suggested_model, 'glm-5.3')

  const opencode = value.routes[1]
  assert.deepEqual(opencode.matching_models, ['deepseek-v4.1-flash'], '已归并到 deepseek-flash 的规范名档位（coding=excellent）按规范名优先命中')
  assert.equal(opencode.suggested_model, 'deepseek-v4.1-flash')
  assert.ok('matching_models' in opencode, '无匹配时键仍出现（空数组）')

  assert.deepEqual(value.routes[2].matching_models, ['deepseek-flash'])
  assert.deepEqual(value.routes[4].matching_models, [], 'xiaomi 无 coding excellent')

  assert.deepEqual(
    value.model_picks.map((pick) => `${pick.channel_id}/${pick.channel_model}`),
    ['zai-coding-cn/glm-5.3', 'opencode-go/deepseek-v4.1-flash', 'deepseek-official/deepseek-flash', 'deepseek-account/deepseek-flash'],
  )
  assert.deepEqual(value.meta.capability_need, { coding: 'excellent' })
  assert.equal(value.meta.unrated_models, 2, 'opencode-go 的 2 个未登记模型（longcat-2.0/longcat-2.5-preview-free；deepseek-v4.1-flash 已归并到规范名）')
  assert.equal(value.model_picks[0].ratings.vision, 'none')
})

test('§7 execute need={vision:good}：none 被排除、good/excellent 命中；文本出 vision:无', async () => {
  const value = await routeTool(registryOf()).execute({ need: { vision: 'good' } }, EXEC)
  assert.deepEqual(value.routes[0].matching_models, ['glm-5.3-flash'], 'glm-5.3/highspeed 的 vision=none 被排除')
  assert.deepEqual(value.routes[2].matching_models, ['deepseek-flash'], 'deepseek-v4-pro 的 vision=none 被排除')
  assert.deepEqual(value.routes[1].matching_models, ['qwen3.8-flash', 'deepseek-v4.1-flash', 'glm-5.3-flash', 'mimo-v2.6-flash'], 'fit 降序 → 最小裕度降序 → models[] 原序（deepseek-v4.1-flash 按规范名取 deepseek-flash 档位）')

  const text = renderRouteResult(value)
  assert.match(text, /能力需求: vision≥good（advisory：仅标注与推荐落点，不阻断、不改 routes 排序）/)
  assert.match(text, /匹配模型: glm-5.3-flash\(good\)/)
  assert.match(text, /- deepseek-v4-pro \[coding:good tools:good long_context:excellent vision:无\]: deepseek-official→deepseek-v4-pro\(#3\), deepseek-account→deepseek-v4-pro\(#4\)/)
  assert.doesNotMatch(text, /¥/)
})

test('§8 不传 need：need 专属键全部缺席、routes[] 逐元素与基线一致（只增视图回归）', async () => {
  const plain = await routeTool(registryOf()).execute({}, EXEC)
  const withNeed = await routeTool(registryOf()).execute({ need: { coding: 'excellent' } }, EXEC)

  const baseKeys = ['balance_source', 'channel_id', 'channel_type', 'degraded', 'dynamic', 'livecheck', 'models', 'note', 'priority', 'provider', 'rank', 'reason', 'review_alert', 'review_alerts', 'tier']
  for (const route of plain.routes) {
    assert.equal('matching_models' in route, false)
    assert.equal('suggested_model' in route, false)
    assert.deepEqual(Object.keys(route).sort(), baseKeys, 'M4.7 键集合逐元素不变')
  }
  assert.equal('model_picks' in plain, false)
  assert.equal('capability_need' in plain.meta, false)
  assert.equal('unrated_models' in plain.meta, false)

  const stripped = withNeed.routes.map(({ matching_models, suggested_model, ...rest }) => rest)
  assert.deepEqual(stripped, plain.routes, 'need 只增键，不改排序/内容')
})

test('§9 model_picks 同分按渠道 rank 升序、末键 canonical 字典序', async () => {
  const value = await routeTool(registryOf()).execute({ need: { coding: 'excellent' } }, EXEC)
  const flash = value.model_picks.filter((pick) => pick.canonical === 'deepseek-flash')
  assert.deepEqual(flash.map((pick) => pick.rank), [2, 3, 4], '同模型同分：opencode-go(#2) → deepseek-official(#3) → deepseek-account(#4) 按渠道 rank 升序')
  assert.ok(value.model_picks[0].rank < value.model_picks[1].rank)
})

test('§10 文本渲染：能力需求/匹配模型最低评级/推荐段 fit-min/未登记计数/模型归并档位', async () => {
  const value = await routeTool(registryOf()).execute({ need: { coding: 'excellent' } }, EXEC)
  const text = renderRouteResult(value)
  assert.match(text, /^模型路由排序表/)
  assert.match(text, /\n能力需求: coding≥excellent（advisory：仅标注与推荐落点，不阻断、不改 routes 排序）\n/)
  assert.match(text, /匹配模型: glm-5\.3\(excellent\), glm-5\.3-highspeed\(excellent\)/)
  assert.match(text, /匹配模型: 无（本渠道没有满足该能力需求的模型）/)
  assert.match(text, /能力匹配推荐（先按能力匹配质量，再按渠道排序；advisory，不阻断）:/)
  assert.match(text, /1\. glm-5\.3 @ zai-coding-cn \(#1\) \| coding:excellent tools:excellent long_context:excellent vision:无 \| fit=3 min=0/)
  assert.match(text, /档位未登记模型: 2 个（不计入匹配）/)
  assert.match(text, /- glm-5\.3-flash \[coding:good tools:excellent long_context:good vision:good\]: zai-coding-cn→glm-5\.3-flash\(#1\), opencode-go→glm-5\.3-flash\(#2\)/)
})

test('§11 非法 need 参数错误：指明键/值/允许值；校验先于任何 IO', async () => {
  const tool = routeTool(registryOf())
  await assert.rejects(tool.execute({ need: { coding: 'best' } }, EXEC), /need 参数非法：键 "coding" 的值 "best" 非法（允许 excellent\|good\|fair，大小写敏感）/)
  await assert.rejects(tool.execute({ need: { foo: 'good' } }, EXEC), /未知能力维度 "foo"/)

  const failFast = createRouteQueryTool({
    ctx: {},
    getRegistry: () => { throw new Error('getRegistry should not be called') },
    livecheck: { async check() { throw new Error('livecheck should not be called') } },
    logger,
    decisionsBaseDir: TMP,
    getQuota: async () => null,
  })
  await assert.rejects(failFast.execute({ need: { coding: 'best' } }, EXEC), /键 "coding" 的值 "best" 非法/)
})

test('§12 不传 need 的文本：除模型归并视图档位外，其余行与 M4.7 形制一致（无能力需求段）', async () => {
  const text = renderRouteResult(await routeTool(registryOf()).execute({}, EXEC))
  assert.doesNotMatch(text, /能力需求:/)
  assert.doesNotMatch(text, /能力匹配推荐/)
  assert.doesNotMatch(text, /匹配模型:/)
  assert.doesNotMatch(text, /档位未登记模型/)
  assert.match(text, /- deepseek-v4-pro \[coding:good tools:good long_context:excellent vision:无\]: /)
})

test('§13 model_route_alias_suggest 输出不透出 model_ratings（只读表不泄漏）', async () => {
  const tool = createAliasSuggestTool({ ctx: {}, getRegistry: () => registryOf(), logger })
  const result = await tool.execute({}, {})
  assert.equal('model_ratings' in result, false)
  assert.equal(result.dry_run, true)
})

test('§14 M4.9 六维：world_knowledge/orchestration 进 need 校验与匹配（AND 语义）', async () => {
  // 新维度合法 + 未登记模型不命中（不臆测）
  assert.deepEqual(normalizeNeed({ world_knowledge: 'good', orchestration: 'excellent' }), { need: { world_knowledge: 'good', orchestration: 'excellent' }, invalid: null })
  await assert.rejects(routeTool(registryOf()).execute({ need: { orchestration: 'bogus' } }, EXEC), /键 "orchestration" 的值 "bogus" 非法/)

  // 登记了新维度评级的模型可命中：给 deepseek-flash 补 world_knowledge/orchestration
  const ratings = JSON.parse(JSON.stringify(MODEL_RATINGS))
  ratings['deepseek-flash'].world_knowledge = 'excellent'
  ratings['deepseek-flash'].orchestration = 'good'
  const result = await routeTool(registryOf({ ratings })).execute({ need: { world_knowledge: 'good', orchestration: 'good' } }, EXEC)
  assert.ok(Array.isArray(result.model_picks), 'model_picks 出现')
  assert.ok(result.model_picks.some((pick) => pick.canonical === 'deepseek-flash'), '补登记后 deepseek-flash 命中')
  assert.ok(result.meta.capability_need.world_knowledge === 'good', 'meta.capability_need 回显新维度')

  // 未登记新维度的原表：所有模型都不命中（none/未登记均不满足 good）
  const bare = await routeTool(registryOf()).execute({ need: { world_knowledge: 'good' } }, EXEC)
  assert.deepEqual(bare.model_picks, [], '原四维登记表对新维度全未登记 → 空推荐')
})
