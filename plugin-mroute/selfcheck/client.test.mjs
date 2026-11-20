import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createContext, runInContext } from 'node:vm'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { rankChannels } from '../lib/ranking.js'
import { SEED_CHANNELS } from '../lib/config-schema.js'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const clientPath = join(root, 'client.js')

/**
 * mroute M3 客户端 selfcheck（node:vm 沙箱，仿 dsh-orb client-settings/section.test.mjs 模式）。
 * 覆盖：注册形状 / 镜像渲染 / 保存 ops 构造（channels 数组整替 + 顶层三参）/ SETTINGS_CONFLICT 重拉
 * 不覆盖 / 降级（settings 服务缺席不注册）/ locale 键集一致 / 纯函数（validate/buildSaveOps/normalize）。
 * 未自动化层（如实声明，见 devlog「未自动化」）：真实浏览器挂载、真机热更与持久化——lead 浏览器实测。
 */

const fixtureView = {
  ns: 'mroute',
  revision: 3,
  value: {
    channels: [
      {
        id: 'zai-coding-cn', routeProvider: 'zai-coding-cn', models: ['glm-4.6'],
        channel_type: 'monthly', tier: 'domestic_sota', priority: 90,
        fallbacks: ['deepseek-official'], capability: { coding: 'excellent' },
        quota_platform: 'zhipu', quota_account_verified: false,
        manual: { status: 'active', quota_total: '—', quota_used_est: '—', note: 'GLM Coding 包月' },
        reviewed_at: '2026-11-13',
      },
      {
        id: 'deepseek-official', routeProvider: 'deepseek-official', models: ['deepseek-chat', 'deepseek-reasoner'],
        channel_type: 'prepaid', tier: 'domestic_sota', priority: 70,
        fallbacks: ['deepseek-account', 'xiaomi'], capability: {},
        quota_platform: 'deepseek', quota_account_verified: true,
        manual: { status: 'active', quota_total: '—', quota_used_est: '—', note: '官方平台预充值' },
        reviewed_at: '2026-11-13',
      },
    ],
    enforce_gate: false,
    eval: {},
    low_balance_threshold_cny: 10,
    quota_cache_ttl_seconds: 60,
  },
}

function loadSection({ withRemote = true, namespaces = [fixtureView] } = {}) {
  // 极简 React 假件：按「组件实例（函数名 + label/channel.id 身份）+ hook 序号」分配 state 槽位，
  // 这样折叠/展开某张渠道卡不会移动其它卡片与 ListField 的槽位（真 React 也是每实例独立 hook 链）。
  const stateSlots = new Map()
  const effects = new Map()
  const ran = new Set()
  const frames = []
  const rootFrame = { key: 'root', index: 0 }
  const currentFrame = () => frames[frames.length - 1] ?? rootFrame
  const takeSlot = (initial) => {
    const frame = currentFrame()
    const key = `${frame.key}#${frame.index++}`
    if (!stateSlots.has(key)) stateSlots.set(key, { current: initial })
    return stateSlots.get(key)
  }
  const React = {
    createElement(type, props, ...children) {
      const flat = children.flat(Infinity).filter((child) => child != null && child !== false && child !== true)
      if (typeof type !== 'function') return { type, props: props ?? {}, children: flat }
      const identity = props?.label || props?.channel?.id || props?.id || ''
      frames.push({ key: `${type.name || 'anon'}/${identity}`, index: 0 })
      try {
        return type(props ?? {})
      } finally {
        frames.pop()
      }
    },
    useState(initial) {
      const slot = takeSlot(initial)
      return [slot.current, (next) => { slot.current = typeof next === 'function' ? next(slot.current) : next }]
    },
    useRef(initial) {
      return takeSlot(initial)
    },
    useEffect(effect) {
      const frame = currentFrame()
      const key = `${frame.key}#${frame.index++}`
      effects.set(key, effect)
    },
  }
  let registered
  let plugin
  const styleNodes = []
  const sandbox = {
    document: {
      documentElement: { lang: '' },
      getElementById: (id) => styleNodes.find((node) => node.id === id) ?? null,
      head: { append(node) { styleNodes.push(node) } },
      createElement: () => ({ id: '', textContent: '' }),
    },
    navigator: { language: 'zh-CN' },
    console,
  }
  sandbox.window = {
    __ModuleLoader__: {
      load(spec) {
        plugin = spec.factory((id) => {
          if (id === 'react') return React
          throw new Error(id)
        })
        return plugin
      },
    },
  }
  runInContext(readFileSync(clientPath, 'utf8'), createContext(sandbox))

  const describeCalls = { count: 0 }
  const mutateCalls = []
  let mutateError = null
  const settings = {
    async describe() {
      describeCalls.count += 1
      // 桌面端实测形状：远端方法解析出 {ok, value} 信封（见 devlog「信封」条）。
      return { ok: true, value: { writable: true, hasDocument: true, namespaces } }
    },
    async mutate(ns, ops, revision) {
      mutateCalls.push({ ns, ops, revision })
      if (mutateError) {
        const detail = typeof mutateError === 'string' ? { message: mutateError } : mutateError
        return { ok: false, error: { code: detail.code, name: detail.name, message: detail.message ?? String(detail.code ?? 'failed') } }
      }
      return { ok: true, value: { ...fixtureView, revision: revision + 1 } }
    },
  }
  const remote = {
    settings,
    credentials: { async describe() { return {} }, async set() {}, async unset() {} },
    $on: () => () => {},
  }
  const ctx = {
    remote: withRemote ? remote : undefined,
    slots: {
      inject(_name, register) { register() },
      register(spec, Component) { registered = { spec, Component } },
      entries() { return [] },
    },
    effect(run) { return run() },
  }
  plugin.apply(ctx)

  function render() {
    rootFrame.index = 0
    return registered ? registered.Component(registered.spec.inject()) : null
  }
  async function flush() {
    // 两趟：首轮 effect（如 load()）跑完后，置状态可能再注册新 effect（locale 订阅等）。
    for (let pass = 0; pass < 3; pass += 1) {
      let pending = false
      for (const [key, effect] of effects) {
        if (ran.has(key)) continue
        ran.add(key)
        pending = true
        await effect()
      }
      if (!pending) break
    }
    await settle()
  }
  async function settle() {
    for (let index = 0; index < 12; index += 1) await new Promise((resolve) => setTimeout(resolve, 0))
  }
  return {
    plugin,
    registered,
    settings,
    mutateCalls,
    describeCalls,
    render,
    flush,
    settle,
    setMutateError(next) { mutateError = next },
    setLang(next) { sandbox.document.documentElement.lang = next },
  }
}

function find(node, predicate, found = []) {
  if (!node || typeof node !== 'object') return found
  if (predicate(node)) found.push(node)
  for (const child of node.children ?? []) find(child, predicate, found)
  return found
}

function text(node) {
  if (typeof node === 'string') return node
  if (!node || typeof node !== 'object') return ''
  return (node.children ?? []).map(text).join('')
}

describe('mroute settings section', () => {
  it('registers the model-route section and exposes a locale-consistent test surface', async () => {
    const page = loadSection()
    assert.equal(page.registered.spec.name, 'settings.section')
    assert.equal(page.registered.spec.id, 'model-route')
    assert.equal(page.registered.spec.order, 18)
    assert.equal(page.registered.spec.label(), '模型路由')

    const surface = page.plugin.__mroute
    assert.deepEqual(Object.keys(surface.zh).sort(), Object.keys(surface.en).sort(), 'zh/en 词典键集一致')
    assert.equal(surface.NS, 'mroute')
    assert.equal(surface.SECTION_ID, 'model-route')

    page.setLang('en')
    assert.equal(page.registered.spec.label(), 'Model routing')
  })

  it('renders the channel cards and top-level parameters from the describe mirror', async () => {
    const page = loadSection()
    page.render()
    await page.flush()
    let view = page.render()

    assert.equal(find(view, (node) => node.type === 'h3' && String(node.children?.[0] ?? '').startsWith('顶层参数')).length, 1, '顶层参数分节标题（中英并列）')
    // 进入面板全部折叠：只渲染卡头 + 要点 chips，字段不在树里
    const ids = find(view, (node) => node.props?.className === 'mroute-card-id').map((node) => text(node))
    assert.ok(ids.includes('zai-coding-cn'))
    assert.ok(ids.includes('deepseek-official'))
    assert.equal(find(view, (node) => node.type === 'select').length, 0, '折叠态不含下拉')
    const toggles = find(view, (node) => node.type === 'button' && node.props?.className === 'mroute-card-toggle')
    assert.equal(toggles.length, 2, '两张渠道卡各一枚折叠按钮')
    assert.equal(toggles[0].props['aria-expanded'], 'false')
    // 折叠态要点：状态 / 付费类型 / 档位 / 优先级 / 平台 / 核实
    const firstCard = find(view, (node) => node.props?.className === 'mroute-card')[0]
    const chips = find(firstCard, (node) => typeof node.props?.className === 'string' && node.props.className.startsWith('mroute-chip'))
    const chipText = chips.map(text).join(' | ')
    assert.ok(chipText.includes('正常'), '状态 chip')
    assert.ok(chipText.includes('包月'), '付费类型 chip')
    assert.ok(chipText.includes('国内 SOTA'), '档位 chip')
    assert.ok(chipText.includes('priority 90'), '优先级 chip')
    assert.ok(chipText.includes('zhipu'), '余额平台 chip')
    assert.ok(chipText.includes('待核实'), '核实状态 chip')

    // 展开后字段可见
    for (const toggle of toggles) toggle.props.onClick()
    view = page.render()
    assert.equal(find(view, (node) => node.type === 'button' && node.props?.className === 'mroute-card-toggle')[0].props['aria-expanded'], 'true')
    assert.ok(find(view, (node) => text(node).includes('2026-11-20 用户确认额度卡与渠道账户同源')).length > 0, 'zai 依据提示')
    assert.ok(find(view, (node) => text(node).includes('DeepSeek 只有一个源')).length > 0, 'deepseek 依据提示')
    // 状态下拉闭集三值（字段名中英并列）
    const statusSelect = find(view, (node) => node.type === 'select' && node.props?.['aria-label'] === '手动状态 · manual.status')[0]
    assert.equal(statusSelect.props.value, 'active')
    // tier 下拉标签非空（含下划线闭集值不拼接，防 tierLabelKey 回归）
    const tierSelect = find(view, (node) => node.type === 'select' && node.props?.['aria-label'] === '能力档位 · tier')[0]
    assert.equal(tierSelect.props.value, 'domestic_sota')
    const tierOptions = find(tierSelect, (node) => node.type === 'option')
    assert.equal(tierOptions[0].children?.[0], 'overseas_sota（海外 SOTA）', 'tier 标签渲染（含下划线值）')
    assert.equal(tierOptions.length, 3)
  })

  it('saves with whole-array channel replace plus three top-level ops and bumps revision', async () => {
    const page = loadSection()
    page.render()
    await page.flush()
    let view = page.render()
    // 折叠 → 展开后再改字段（进入面板默认全折叠）
    for (const toggle of find(view, (node) => node.type === 'button' && typeof node.props?.className === 'string' && node.props.className.includes('mroute-card-toggle'))) toggle.props.onClick()
    view = page.render()

    // 改第一条渠道的 status → disabled（闭集）
    const statusSelect = find(view, (node) => node.type === 'select' && node.props?.['aria-label'] === '手动状态 · manual.status')[0]
    statusSelect.props.onChange({ target: { value: 'disabled' } })
    view = page.render()

    // 改顶层 enforce_gate 开关
    const gate = find(view, (node) => node.type === 'button' && node.props?.['aria-label'] === '阻断语义 · enforce_gate')[0]
    gate.props.onClick()
    view = page.render()

    const save = find(view, (node) => node.type === 'button' && node.children?.includes('保存'))[0]
    save.props.onClick()
    await page.settle()

    assert.equal(page.mutateCalls.length, 1)
    // 跨 realm（node:vm）归一化：JSON 往返后所有对象回到测试 realm，deepStrictEqual 才可比。
    const call = JSON.parse(JSON.stringify(page.mutateCalls[0]))
    assert.equal(call.ns, 'mroute')
    assert.equal(call.revision, 3, 'revision 来自 describe 镜像')
    const paths = call.ops.map((op) => op.path.join('.'))
    assert.deepEqual(paths, ['channels', 'low_balance_threshold_cny', 'window_week_tight_pct', 'window_5h_hint_pct', 'quota_cache_ttl_seconds', 'enforce_gate', 'model_aliases', 'model_ratings'])
    const channelsOp = call.ops.find((op) => op.path.join('.') === 'channels')
    assert.equal(channelsOp.value.length, 2, '数组整替：两条渠道全量回写')
    assert.equal(channelsOp.value[0].id, 'zai-coding-cn')
    assert.equal(channelsOp.value[0].manual.status, 'disabled')
    assert.equal(channelsOp.value[1].id, 'deepseek-official')
    assert.equal(channelsOp.value[1].quota_account_verified, true, '未编辑字段原样保留')
    const enforceOp = call.ops.find((op) => op.path.join('.') === 'enforce_gate')
    assert.equal(enforceOp.value, true)
    // 空 capability 省略（对齐种子形状）
    assert.equal(Object.hasOwn(channelsOp.value[1], 'capability'), false)
    assert.deepEqual(channelsOp.value[0].capability, { coding: 'excellent' })
  })

  it('blocks dirty drafts client-side before mutate', async () => {
    const page = loadSection()
    page.render()
    await page.flush()
    let view = page.render()
    for (const toggle of find(view, (node) => node.type === 'button' && typeof node.props?.className === 'string' && node.props.className.includes('mroute-card-toggle'))) toggle.props.onClick()
    view = page.render()

    const priority = find(view, (node) => node.type === 'input' && node.props?.['aria-label'] === '优先级（0–100） · priority (0–100)')[0]
    priority.props.onChange({ target: { value: 999 } })
    view = page.render()
    const save = find(view, (node) => node.type === 'button' && node.children?.includes('保存'))[0]
    save.props.onClick()
    await page.settle()

    assert.equal(page.mutateCalls.length, 0, '脏数据不触达 host')
    view = page.render()
    assert.ok(find(view, (node) => node.props?.className === 'mroute-error').length > 0, '校验错误可见')
  })

  it('on conflict re-reads the mirror and does not overwrite', async () => {
    const page = loadSection()
    page.render()
    await page.flush()
    let view = page.render()

    page.setMutateError({ code: 'settings/conflict' })
    const save = find(view, (node) => node.type === 'button' && node.children?.includes('保存'))[0]
    save.props.onClick()
    await page.settle()

    assert.equal(page.describeCalls.count, 2, '冲突后重拉镜像')
    view = page.render()
    assert.ok(find(view, (node) => text(node).includes('设置已在别处修改')).length > 0, '冲突提示可见')
  })

  it('previewRanking mirrors the host static-layer comparator (5 seed channels, empty livecheck)', () => {
    const { previewRanking } = loadSection().plugin.__mroute
    const channels = JSON.parse(JSON.stringify(SEED_CHANNELS))
    const preview = previewRanking(channels)
    const host = rankChannels(channels, new Map()) // 空活校验表：全部 unknown 沉底不影响静态层
    assert.deepEqual(preview.map((row) => row.channel.id), host.ranked.map((row) => row.channel.id))
    preview.forEach((row, index) => assert.equal(row.rank, index + 1, 'rank 从 1 递增'))
    // 同 type/tier：priority 降序，再 id 字典序（与 host 同口径）
    const tie = [
      { id: 'b', channel_type: 'prepaid', tier: 'bulk', priority: 5 },
      { id: 'a', channel_type: 'prepaid', tier: 'bulk', priority: 5 },
      { id: 'c', channel_type: 'prepaid', tier: 'bulk', priority: 9 },
    ]
    assert.deepEqual(previewRanking(tie).map((row) => row.channel.id), ['c', 'a', 'b'])
    assert.match(preview[0].reason, /channel_type=monthly（一级键 包月优先）/)
  })

  it('renders the read-only static-layer preview above the editable channel cards', async () => {
    const page = loadSection()
    page.render()
    await page.flush()
    const view = page.render()
    const preview = find(view, (node) => typeof node.props?.className === 'string' && node.props.className.includes('mroute-preview'))[0]
    assert.ok(preview, '预览卡存在')
    assert.ok(text(preview).includes('建议顺序（静态层）'), '标题')
    assert.ok(text(preview).includes('不含 provider 活校验'), '固定说明（完整链路以 host 工具为准）')
    const rows = find(preview, (node) => node.props?.className === 'mroute-preview-row')
    assert.equal(rows.length, 2, '两条渠道各一行')
    assert.match(text(rows[0]), /#1/)
    assert.match(text(rows[0]), /zai-coding-cn/)
    assert.match(text(rows[0]), /monthly · domestic_sota · priority 90/)
    assert.match(text(rows[1]), /deepseek-official/)
    // 渠道卡仍全折叠：预览不引入任何下拉（select 计数保持 0）
    assert.equal(find(view, (node) => node.type === 'select').length, 0)
  })

  it('edits canonical-model capability with six selects (incl. none) and saves as model_ratings', async () => {
    const page = loadSection()
    page.render()
    await page.flush()
    let view = page.render()
    for (const toggle of find(view, (node) => node.type === 'button' && typeof node.props?.className === 'string' && node.props.className.includes('mroute-card-toggle'))) toggle.props.onClick()
    view = page.render()

    const editor = find(view, (node) => node.props?.className === 'mroute-modelcaps')[0]
    assert.ok(editor, '统一模型名能力档位编辑器存在')
    assert.ok(text(editor).includes('统一模型名能力档位 · '), '双语标题（规范名维度）')
    const rows = find(view, (node) => node.props?.className === 'mroute-modelcap')
    assert.equal(rows.length, 3, '按规范名去重：glm-4.6 + deepseek 两个模型')
    // 渠道卡里不再有每模型档位编辑器：该编辑器只出现在「模型归并」卡内
    const aliasCard = find(view, (node) => typeof node.props?.className === 'string' && node.props.className.includes('mroute-alias'))[0]
    assert.ok(aliasCard, '模型归并卡存在')
    assert.equal(find(aliasCard, (node) => node.props?.className === 'mroute-modelcaps').length, 1, '档位编辑器挂在归并卡里')
    const zaiRow = rows.find((node) => text(node).includes('glm-4.6'))
    assert.ok(zaiRow, 'glm-4.6 行存在（行序按组大小/字典序，不假设首位）')
    const zaiSelects = find(zaiRow, (node) => node.type === 'select')
    assert.equal(zaiSelects.length, 6, '六维各一个下拉（M4.9 world_knowledge/orchestration）')
    const labels = zaiSelects.map((node) => node.props['aria-label']).join('|')
    for (const label of ['编码 · coding', '工具调用 · tools', '长上下文 · long context', '视觉 · vision', '世界知识 · world knowledge', '策划调度 · orchestration']) {
      assert.ok(labels.includes(label), `下拉标签 ${label}`)
    }
    const options = find(zaiSelects[0], (node) => node.type === 'option').map((node) => node.props.value)
    assert.deepEqual(options, ['', 'excellent', 'good', 'fair', 'none'], '未登记 + 三评级 + 「无」')

    zaiSelects[0].props.onChange({ target: { value: 'excellent' } })
    view = page.render()
    const zaiRow2 = find(view, (node) => node.props?.className === 'mroute-modelcap').find((node) => text(node).includes('glm-4.6'))
    const reread = find(zaiRow2, (node) => node.type === 'select')[0]
    assert.equal(reread.props.value, 'excellent', '重渲染后取值仍在')

    const save = find(view, (node) => node.type === 'button' && node.children?.includes('保存'))[0]
    save.props.onClick()
    await page.settle()
    assert.equal(page.mutateCalls.length, 1)
    const call = JSON.parse(JSON.stringify(page.mutateCalls[0]))
    assert.deepEqual(call.ops.map((op) => op.path.join('.')), ['channels', 'low_balance_threshold_cny', 'window_week_tight_pct', 'window_5h_hint_pct', 'quota_cache_ttl_seconds', 'enforce_gate', 'model_aliases', 'model_ratings'])
    const ratingsOp = call.ops.find((op) => op.path.join('.') === 'model_ratings')
    assert.deepEqual(ratingsOp.value, { 'glm-4.6': { coding: 'excellent' } }, '按规范名落 model_ratings')
    assert.equal(Object.hasOwn(call.ops[0].value[0], 'model_capability'), false, '渠道级旧字段不再由面板写入')
  })

  it('blocks saving duplicate per-model capability rows client-side', async () => {
    const dup = JSON.parse(JSON.stringify(fixtureView))
    dup.value.channels[0].model_capability = [
      { model: 'glm-4.6', coding: 'good' },
      { model: 'glm-4.6', tools: 'fair' },
    ]
    const page = loadSection({ namespaces: [dup] })
    page.render()
    await page.flush()
    let view = page.render()
    for (const toggle of find(view, (node) => node.type === 'button' && typeof node.props?.className === 'string' && node.props.className.includes('mroute-card-toggle'))) toggle.props.onClick()
    view = page.render()
    const save = find(view, (node) => node.type === 'button' && node.children?.includes('保存'))[0]
    save.props.onClick()
    await page.settle()
    assert.equal(page.mutateCalls.length, 0, '重复 model 不触达 host')
    view = page.render()
    assert.ok(find(view, (node) => node.props?.className === 'mroute-error').length > 0, '校验错误可见')
    assert.ok(text(view).includes('重复'))
  })

  it('normalizes and serializes per-model capability rows (closed set, empty rows dropped)', () => {
    const { normalizeChannel, normalizeModelCapability, channelToPlain, validateChannel } = loadSection().plugin.__mroute
    const normalized = normalizeModelCapability([
      { model: 'a', coding: 'excellent', tools: 'bogus' },
      { model: '', vision: 'good' },
      null,
      { model: 'b', coding: 'fair', tools: 'good' },
    ])
    assert.deepEqual(JSON.parse(JSON.stringify(normalized)), [
      { model: 'a', coding: 'excellent' },
      { model: '', vision: 'good' },
      { model: 'b', coding: 'fair', tools: 'good' },
    ], '闭集外维度丢弃、非对象行丢弃，其余保序')
    const channel = normalizeChannel({ id: 'x', routeProvider: 'x', models: ['a'], model_capability: normalized })
    const plain = channelToPlain(channel)
    assert.deepEqual(JSON.parse(JSON.stringify(plain.model_capability)), [
      { model: 'a', coding: 'excellent' },
      { model: 'b', coding: 'fair', tools: 'good' },
    ], '空 model 行与无评级行不落盘')
    const empty = channelToPlain(normalizeChannel({ id: 'y', routeProvider: 'y', models: [], model_capability: [{ model: 'q' }] }))
    assert.equal(Object.hasOwn(empty, 'model_capability'), false, '空数组省略键')
    const errors = validateChannel(normalizeChannel({
      id: 'z', routeProvider: 'z', models: ['m'],
      model_capability: [{ model: 'm', coding: 'fair' }, { model: 'm', tools: 'good' }],
    }))
    assert.ok(errors.some((message) => message.includes('重复')), '重复 model 校验拦截')
  })

  it('unwraps the remote {ok, value} envelope and maps failures to coded errors', () => {
    const { unwrapResult } = loadSection().plugin.__mroute
    assert.deepEqual(JSON.parse(JSON.stringify(unwrapResult({ ok: true, value: { writable: true } }))), { writable: true })
    const plain = { namespaces: [] }
    assert.equal(unwrapResult(plain), plain, '非信封形态原样返回（向前兼容）')
    assert.throws(
      () => unwrapResult({ ok: false, error: { code: 'settings/conflict', name: 'SettingsConflictError', message: 'conflict' } }),
      (error) => error.code === 'settings/conflict' && error.name === 'SettingsConflictError' && error.message === 'conflict',
      'ok:false → 抛带 code/name 的 Error（保留冲突分类）')
    assert.throws(() => unwrapResult({ ok: false, error: 'boom' }), /boom/)
  })

  it('shows the unavailable banner plus the visible ns list when the mirror lacks mroute', async () => {
    const page = loadSection({ namespaces: [{ ns: 'quota', revision: 0, value: {} }] })
    page.render()
    await page.flush()
    const view = page.render()
    assert.ok(find(view, (node) => text(node).includes('未启用')).length > 0, 'unavailable 横幅')
    assert.ok(find(view, (node) => text(node).includes('namespaces: quota')).length > 0, '极简诊断列出可见 ns')
  })

  it('stays inert when the settings remote is absent', () => {
    const page = loadSection({ withRemote: false })
    assert.equal(page.registered, undefined, 'settings 服务缺席不注册不报错')
  })

  it('renders the models[]-empty sync hint (no client button) when a channel has no models', async () => {
    const ns = JSON.parse(JSON.stringify(fixtureView))
    ns.value.channels = [
      ns.value.channels[0],
      { ...ns.value.channels[1], id: 'opencode-go', routeProvider: 'opencode-go', models: [] },
    ]
    const page = loadSection({ namespaces: [ns] })
    page.render()
    await page.flush()
    let view = page.render()
    for (const toggle of find(view, (node) => node.type === 'button' && typeof node.props?.className === 'string' && node.props.className.includes('mroute-card-toggle'))) toggle.props.onClick()
    view = page.render()
    assert.ok(find(view, (node) => text(node).includes('model_route_sync_models 从 DSH 目录同步')).length > 0, '空 models[] 提示文案')
    assert.equal(find(view, (node) => node.type === 'button' && text(node).includes('model_route_sync_models')).length, 0, '不新增面板按钮（client 不能直接调 host 工具）')
  })

  it('M4.6 模型归并：normalizeAliases/aliasGroups 纯函数 + 折叠卡标题', async () => {
    const page = loadSection()
    const { normalizeAliases, aliasGroups } = page.plugin.__mroute
    // 跨 realm（node:vm）：JSON 往返后回到测试 realm，deepStrictEqual 才可比。
    const plain = (value) => JSON.parse(JSON.stringify(value))

    assert.deepEqual(plain(normalizeAliases({ a: { m: '  x  ', bad: 123, '': 'y' }, b: {}, c: [], d: 'x' })), { a: { m: 'x' } })
    assert.deepEqual(plain(normalizeAliases(null)), {})

    const groups = plain(aliasGroups(
      [
        { id: 'zai-coding-cn', models: ['glm-5.3-flash', 'glm-5.3'] },
        { id: 'opencode-go', models: ['glm-5.3-flash'] },
        { id: 'xiaomi', models: ['mimo-v2.6-flash'] },
      ],
      { 'zai-coding-cn': { 'glm-5.3-flash': 'glm-5.3-flash' }, 'opencode-go': { 'glm-5.3-flash': 'glm-5.3-flash' } },
    ))
    const glm = groups.find((group) => group.canonical === 'glm-5.3-flash')
    assert.equal(glm.merged, true)
    assert.equal(glm.crossChannel, true)
    assert.deepEqual(glm.members.map((member) => [member.channel, member.explicit]), [
      ['opencode-go', true],
      ['zai-coding-cn', true],
    ])
    const single = groups.find((group) => group.canonical === 'mimo-v2.6-flash')
    assert.equal(single.merged, false)
    assert.equal(single.crossChannel, false)
    assert.deepEqual(groups.map((group) => group.canonical), ['glm-5.3-flash', 'glm-5.3', 'mimo-v2.6-flash'])

    page.render()
    await page.flush()
    const view = page.render()
    assert.ok(find(view, (node) => text(node).includes('模型归并')).length > 0, '归并折叠卡标题渲染（中英并列）')
    assert.ok(find(view, (node) => text(node).includes('归并组')).length > 0, '归并组 chip')
  })

  it('M4.9 动态层快照：摘要卡渲染 + 渠道卡 chip + 保存 ops 不含 dynamic_snapshot', async () => {
    const withSnapshot = JSON.parse(JSON.stringify(fixtureView))
    withSnapshot.value.dynamic_snapshot = {
      as_of: '2026-11-20T19:00:00.000Z',
      rows: [
        { id: 'zai-coding-cn', state: 'tight', reason: '本周窗口 98.5%（≥98% 沉底）', windows: '5h 2% · 本周 98.5%', worst_used_pct: 98.5, low_balance: false, display: 'zhipu · 5h 2% · 本周 98.5%' },
        { id: 'deepseek-official', state: 'hint', reason: '5h 窗口 96%（≥95%，不沉底）', windows: '5h 96%', worst_used_pct: 96, low_balance: false, display: 'deepseek' },
      ],
    }
    const page = loadSection({ namespaces: [withSnapshot] })
    page.render()
    await page.flush()
    let view = page.render()

    // 1) 摘要卡：标题 + as_of + 沉底/提示/正常计数（M4.10 追加「正常 K」）+ 逐行读数
    const card = find(view, (node) => typeof node.props?.className === 'string' && node.props.className.includes('mroute-dynamic'))[0]
    assert.ok(card, '动态层快照卡存在')
    const cardText = text(card)
    assert.ok(cardText.includes('动态层（最近一次查询）'), '标题')
    assert.ok(cardText.includes('快照时间 · snapshot time 2026-11-20T19:00:00.000Z'), 'as_of 展示（中英并列标签）')
    assert.ok(cardText.includes('沉底 1 · 提示 1 · 正常 0'), '摘要计数（M4.10 含正常数）')
    assert.ok(cardText.includes('⚠ zai-coding-cn — 本周窗口 98.5%'), 'tight 行原因（⚠ 前缀）')
    assert.ok(cardText.includes('5h 2% · 本周 98.5%'), 'tight 行读数（windows 优先）')
    assert.ok(cardText.includes('· deepseek-official — 5h 窗口 96%'), 'hint 行「·」前缀 + 原因')

    // 2) 渠道卡 chip：tight → ⚠ warn；hint → idle；ok/无行 = 无 dynamic chip
    for (const toggle of find(view, (node) => node.type === 'button' && typeof node.props?.className === 'string' && node.props.className.includes('mroute-card-toggle'))) toggle.props.onClick()
    view = page.render()
    const chips = find(view, (node) => typeof node.props?.className === 'string' && node.props.className.includes('mroute-chip'))
    const tightChip = chips.find((node) => text(node).includes('⚠ 本周窗口 98.5%'))
    assert.ok(tightChip, 'tight chip（⚠ reason）')
    assert.ok(tightChip.props.className.includes('is-warn'), 'tight chip warn 色')
    const hintChip = chips.find((node) => text(node).includes('5h 窗口 96%'))
    assert.ok(hintChip, 'hint chip（reason）')
    assert.ok(hintChip.props.className.includes('is-idle'), 'hint chip idle 色')

    // 3) 红线：保存 ops 不含 dynamic_snapshot（只读镜像）；保存后快照仍在 form
    const save = find(view, (node) => node.type === 'button' && node.children?.includes('保存'))[0]
    save.props.onClick()
    await page.settle()
    assert.equal(page.mutateCalls.length, 1)
    const call = JSON.parse(JSON.stringify(page.mutateCalls[0]))
    assert.equal(call.ops.some((op) => op.path.join('.').startsWith('dynamic_snapshot')), false, 'ops 不含 dynamic_snapshot')
    assert.equal(call.ops.length, 8, 'ops 仍为 8 条（M4.8 形状不变）')
    const after = page.plugin.__mroute.formFromView(withSnapshot)
    assert.equal(after.dynamic_snapshot.rows.length, 2, 'formFromView 仍读回快照（保存链不触碰该字段）')

    // 4) 空快照（as_of 也为空）：引导文案，无行无 chip 零噪音
    const emptyPage = loadSection()
    emptyPage.render()
    await emptyPage.flush()
    const emptyView = emptyPage.render()
    assert.ok(text(emptyView).includes('尚未收到任何查询快照：在会话里执行一次 model_route_query 后回到本页'), '空快照引导文案（M4.10 新口径）')
    assert.equal(find(emptyView, (node) => typeof node.props?.className === 'string' && node.props.className.includes('mroute-dynamic-row')).length, 0, '无动态行')

    // 5) 纯函数：normalizeDynamicSnapshot 坏形状回缺省、四态保留 unknown；dynamicChipOf ok/无行 = null
    const { normalizeDynamicSnapshot, dynamicChipOf } = emptyPage.plugin.__mroute
    const plain = (value) => JSON.parse(JSON.stringify(value))
    assert.deepEqual(plain(normalizeDynamicSnapshot(null)), { as_of: '', rows: [] })
    assert.deepEqual(plain(normalizeDynamicSnapshot({ as_of: 't', rows: [{ id: 'x', state: 'bogus' }, { id: '' }, 5] })), { as_of: 't', rows: [{ id: 'x', state: 'ok', reason: '', windows: '', worst_used_pct: -1, low_balance: false, display: '' }] })
    assert.equal(normalizeDynamicSnapshot({ as_of: 't', rows: [{ id: 'u', state: 'unknown' }] }).rows[0].state, 'unknown', 'M4.10 四态保留 unknown')
    assert.equal(dynamicChipOf(null, emptyPage.plugin.__mroute.zh), null, '无行 → null')
    assert.equal(dynamicChipOf({ id: 'x', state: 'ok' }, emptyPage.plugin.__mroute.zh), null, 'ok 行 → null')
    assert.deepEqual(plain(dynamicChipOf({ id: 'u', state: 'unknown' }, emptyPage.plugin.__mroute.zh)), { key: 'dynamic', tone: 'idle', label: '? 未知' })
  })

  it('M4.10 全渠道快照：全 ok 也显示摘要与读数；只有 as_of 为空才是空态', async () => {
    const allOk = JSON.parse(JSON.stringify(fixtureView))
    allOk.value.dynamic_snapshot = {
      as_of: '2026-11-20T20:00:00.000Z',
      rows: [
        { id: 'zai-coding-cn', state: 'ok', reason: '', windows: '5h 2% · 本周 3%', worst_used_pct: 3, low_balance: false, display: 'zhipu · 5h 2% · 本周 3%' },
        { id: 'deepseek-official', state: 'ok', reason: '', windows: '', worst_used_pct: -1, low_balance: false, display: '¥52.28' },
      ],
    }
    const page = loadSection({ namespaces: [allOk] })
    page.render()
    await page.flush()
    let view = page.render()

    // 1) 全 ok 行也必须显示摘要（旧实现 rows.length===0 判空 → 这里退回空态 = 用户报的缺陷）
    const card = find(view, (node) => typeof node.props?.className === 'string' && node.props.className.includes('mroute-dynamic'))[0]
    assert.ok(card, '动态层快照卡存在')
    const cardText = text(card)
    assert.ok(cardText.includes('快照时间 · snapshot time 2026-11-20T20:00:00.000Z'), 'as_of 展示')
    assert.ok(cardText.includes('沉底 0 · 提示 0 · 正常 2'), '全 ok 也有摘要（正常数 2）')
    assert.ok(cardText.includes('✓ zai-coding-cn — 正常 · 5h 2% · 本周 3%'), 'ok 行 ✓ + windows 读数')
    assert.ok(cardText.includes('✓ deepseek-official — 正常 · ¥52.28'), 'ok 行 ✓ + amount 读数（display 兜底）')
    assert.equal(find(view, (node) => typeof node.props?.className === 'string' && node.props.className.includes('mroute-dynamic-row')).length, 2, '全部渠道逐行渲染')
    assert.ok(!cardText.includes('尚未收到任何查询快照'), '有 as_of 就不显示空态')

    // 2) 全 ok 行 → 渠道卡不产动态 chip（ok = 零噪音）
    for (const toggle of find(view, (node) => node.type === 'button' && typeof node.props?.className === 'string' && node.props.className.includes('mroute-card-toggle'))) toggle.props.onClick()
    view = page.render()
    const chips = find(view, (node) => typeof node.props?.className === 'string' && node.props.className.includes('mroute-chip'))
    assert.equal(chips.filter((node) => text(node).includes('⚠')).length, 0, 'ok 行无 warn chip')
    assert.equal(chips.filter((node) => text(node).startsWith('?')).length, 0, 'ok 行无 unknown chip')

    // 3) as_of 有值但 rows 为空（历史快照/写入竞态）：仍显示摘要行，不退回空态
    const asOfOnly = JSON.parse(JSON.stringify(fixtureView))
    asOfOnly.value.dynamic_snapshot = { as_of: '2026-11-20T20:05:00.000Z', rows: [] }
    const asOfPage = loadSection({ namespaces: [asOfOnly] })
    asOfPage.render()
    await asOfPage.flush()
    const asOfText = text(asOfPage.render())
    assert.ok(asOfText.includes('沉底 0 · 提示 0 · 正常 0'), 'as_of 在 = 摘要行在')
    assert.ok(!asOfText.includes('尚未收到任何查询快照'), 'as_of 在不算空态')

    // 4) 只有 as_of 为空才是空态，且不显示摘要
    const neverPage = loadSection()
    neverPage.render()
    await neverPage.flush()
    const neverText = text(neverPage.render())
    assert.ok(neverText.includes('尚未收到任何查询快照：在会话里执行一次 model_route_query 后回到本页。'), '空态文案')
    assert.ok(!neverText.includes('沉底 0 · 提示 0'), '空态不显示摘要')
  })
})
