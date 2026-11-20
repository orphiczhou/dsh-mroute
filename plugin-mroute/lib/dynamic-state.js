/**
 * 动态状态判定（M4.5，任务书 §3.1）：把 quota 机读读数折算成一档**建议状态**，
 * 供 ranking.js 沉底与 tool-query.js 标注。纯函数：同输入同输出（无 Date/随机/网络），可复盘。
 *
 * 用户裁决（2026-11-20 原文）：
 * - 「5h提示95%即可，周的98%之前都不太会影响任务执行」→ 周窗口只在高水位沉底，5h 只提示；
 * - 「有的渠道都快没有额度了，再派长程任务，会执行到中间断开的」→ 金额型低余额沉底。
 *
 * 规则表（不要自己加码）：
 * | 条件 | 状态 | 行为 |
 * |---|---|---|
 * | 周窗口已用% ≥ window_week_tight_pct（默认 98） | tight | 沉底（仅建议顺序） |
 * | 金额型余额（CNY/未标注币种）< low_balance_cny（默认 10） | tight | 沉底 |
 * | 5h 窗口已用% ≥ window_5h_hint_pct（默认 95） | hint | 只标注不沉底 |
 * | 其余 / 无 machine 数据 | ok | 无噪音 |
 *
 * 纪律：
 * - **绝不臆造**：无 machine 视图、mode=status、窗口项缺失 → 对应规则不触发，reasons 不写；
 *   metrics 只记录「确实读到的数字」。
 * - tight 优先于 hint：tight 时 reasons 只列 tight 原因（hint 原因不混进「动态沉底」行，
 *   避免沉底理由里出现「不沉底」自相矛盾）；hint 时 reasons 列 hint 原因。
 * - 金额只在 currency === 'CNY' 或 currency == null 时比较阈值（USD 不臆测汇率，口径同
 *   tool-query.js:145 既有 low_balance 判定）。
 * - advisory-only：本模块只产出状态与理由，不剔除、不阻断、不改写任何请求。
 */

/** 周窗口沉底阈值缺省（用户裁决 98）。 */
export const DEFAULT_WINDOW_WEEK_TIGHT_PCT = 98
/** 5h 窗口提示阈值缺省（用户裁决 95）。 */
export const DEFAULT_WINDOW_5H_HINT_PCT = 95
/** 金额型低余额阈值缺省（沿用 M1/M2 的 10 CNY）。 */
export const DEFAULT_LOW_BALANCE_CNY = 10

/** 5 小时窗口 label 识别（`5h` / `5 小时`，与 quota-view.shortWindowLabel 同口径）。 */
const WINDOW_5H_RE = /5\s*(?:h|小时)/i
/** 周窗口 label 识别（`本周` / `周`）。 */
const WINDOW_WEEK_RE = /周/

function pctOf(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) && n >= 1 && n <= 100 ? n : fallback
}

function moneyOf(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

/**
 * 阈值归一化（缺省/非法值回落内置缺省；Config 侧已校验，此处第二道防线——保证纯函数
 * 对任意入参都有确定输出）。
 * @param {{ window_week_tight_pct?:number, window_5h_hint_pct?:number, low_balance_cny?:number }} [thresholds]
 * @returns {{ window_week_tight_pct:number, window_5h_hint_pct:number, low_balance_cny:number }}
 */
export function dynamicThresholdsOf(thresholds = {}) {
  const src = thresholds && typeof thresholds === 'object' ? thresholds : {}
  return {
    window_week_tight_pct: pctOf(src.window_week_tight_pct, DEFAULT_WINDOW_WEEK_TIGHT_PCT),
    window_5h_hint_pct: pctOf(src.window_5h_hint_pct, DEFAULT_WINDOW_5H_HINT_PCT),
    low_balance_cny: moneyOf(src.low_balance_cny, DEFAULT_LOW_BALANCE_CNY),
  }
}

/** 金额紧凑格式：整数原样，小数两位（¥6.2 → 6.20，¥10 → 10）。 */
function formatMoney(value) {
  return Number.isInteger(value) ? String(value) : Number(value).toFixed(2)
}

/** 从 windows[] 取首个 label 满足 predicate 者（快照原序；找不到 → null，规则不触发）。 */
function windowOf(view, predicate) {
  const rows = Array.isArray(view?.windows) ? view.windows : []
  return rows.find((row) => row && typeof row.label === 'string' && predicate(row.label)) ?? null
}

/**
 * 动态状态判定。
 * @param {object} channel 注册表渠道（接口按任务书形状保留；M4.5 规则不读渠道字段）
 * @param {{ use:'machine'|'manual', view?:object }|null} machine machineBalanceOf 结果
 * @param {{ window_week_tight_pct?:number, window_5h_hint_pct?:number, low_balance_cny?:number }} [thresholds]
 * @returns {{ state:'tight'|'hint'|'ok', reasons:string[], metrics:{ week_pct?:number, h5_pct?:number, balance?:number } }}
 */
export function dynamicStateOf(channel, machine, thresholds = {}) {
  void channel
  const t = dynamicThresholdsOf(thresholds)
  const reasons = []
  const metrics = {}
  const view = machine && machine.use === 'machine' ? machine.view : null
  if (!view || view.status !== 'ok') return { state: 'ok', reasons, metrics }

  const tightReasons = []
  const hintReasons = []

  if (view.mode === 'window') {
    const week = windowOf(view, (label) => WINDOW_WEEK_RE.test(label) && !WINDOW_5H_RE.test(label))
    if (week && typeof week.used_pct === 'number' && Number.isFinite(week.used_pct)) {
      metrics.week_pct = week.used_pct
      if (week.used_pct >= t.window_week_tight_pct) {
        tightReasons.push(`本周窗口 ${week.used_pct}%（≥${t.window_week_tight_pct}% 沉底）`)
      }
    }
    const h5 = windowOf(view, (label) => WINDOW_5H_RE.test(label))
    if (h5 && typeof h5.used_pct === 'number' && Number.isFinite(h5.used_pct)) {
      metrics.h5_pct = h5.used_pct
      if (h5.used_pct >= t.window_5h_hint_pct) {
        hintReasons.push(`5h 窗口 ${h5.used_pct}%（≥${t.window_5h_hint_pct}%，不沉底）`)
      }
    }
  } else if (view.mode === 'amount' && typeof view.balance === 'number' && Number.isFinite(view.balance)) {
    metrics.balance = view.balance
    if ((view.currency === null || view.currency === 'CNY') && view.balance < t.low_balance_cny) {
      const symbol = view.currency === 'CNY' ? '¥' : ''
      tightReasons.push(`余额 ${symbol}${formatMoney(view.balance)} 低于阈值 ¥${formatMoney(t.low_balance_cny)}`)
    }
  }

  if (tightReasons.length > 0) {
    return { state: 'tight', reasons: tightReasons, metrics }
  }
  if (hintReasons.length > 0) {
    return { state: 'hint', reasons: hintReasons, metrics }
  }
  return { state: 'ok', reasons, metrics }
}

/** dynamic_snapshot.rows[].state 的合法值（dynamicStateOf 的三值 + 精度不明的 'unknown'）。 */
export const DYNAMIC_STATES = ['ok', 'hint', 'tight', 'unknown']

/**
 * buildDynamicSnapshot（M4.9 / M4.10）：把 model_route_query 组装出的 routes[] 折叠成
 * config.dynamic_snapshot 可存的扁平行。纯函数、无 IO；不改动 routes 本身。
 * 每行字段语义见 config-schema.js dynamic_snapshot 注释；worst_used_pct 未知 = -1。
 *
 * M4.10 起**保留全部 routes**（顺序 = routes 顺序 = 当前排序），不再丢弃 state='ok' 行：
 * 面板需要展示每个渠道的当前动态读数（窗口百分比 / 金额余额），只存非 ok 行会让
 * 「刚查过且全部正常」与「从没查过」在界面上无法区分（用户实测反馈的可见性缺陷）。
 * state 四值：'ok'（无规则触发，面板 ✓）|'hint'（5h 高水位，只标注 ·）|'tight'（沉底 ⚠）|
 * 'unknown'（精度不明，预留态，面板 ?）；缺省/非法值按 'ok'（不伪造异常）。
 * 无渠道 id 的行（非 routes 产物）不入快照——面板无法归位。
 */
export function buildDynamicSnapshot(routes, asOf) {
  const rows = []
  for (const route of Array.isArray(routes) ? routes : []) {
    if (!route || typeof route !== 'object') continue
    const id = typeof route.channel_id === 'string' ? route.channel_id : String(route.channel_id || '')
    if (id === '') continue
    const dyn = route.dynamic && typeof route.dynamic === 'object' ? route.dynamic : {}
    const rawState = typeof dyn.state === 'string' ? dyn.state : ''
    const state = DYNAMIC_STATES.includes(rawState) ? rawState : 'ok'
    const balance = route.balance && typeof route.balance === 'object' ? route.balance : {}
    // routes[].balance 是扁平形状（tool-query.js 组装）：mode='amount'|'window'|'status'，
    // display/worst_used_pct/windows 均在顶层——不读 balance.window/amount/status 嵌套键。
    const mode = typeof balance.mode === 'string' ? balance.mode : ''
    const metrics = dyn.metrics && typeof dyn.metrics === 'object' ? dyn.metrics : {}
    const worst = mode === 'window' && Number.isFinite(balance.worst_used_pct) ? balance.worst_used_pct : -1
    let windows = ''
    if (mode === 'window' && typeof balance.display === 'string' && balance.display) {
      windows = balance.display
    } else if (mode === 'window' && Array.isArray(balance.windows)) {
      // display 缺失时按 windows[] 拼「label used_pct%」紧凑串（quota-view 同款口径）。
      windows = balance.windows
        .filter((w) => w && typeof w === 'object' && (w.label || w.used_pct !== undefined))
        .map((w) => ((typeof w.label === 'string' ? w.label : '') + ' ' + (typeof w.used_pct === 'number' ? w.used_pct + '%' : '')).trim())
        .filter(Boolean)
        .join(' · ')
    }
    rows.push({
      id,
      state,
      // ok 行不带原因（面板显示「正常」）；非 ok 行原因合并为单行（面板行/渠道卡芯片同读）。
      reason: state === 'ok' ? '' : (Array.isArray(dyn.reasons) ? dyn.reasons.filter((s) => typeof s === 'string').join('；') : ''),
      windows,
      worst_used_pct: worst,
      low_balance: state === 'tight' && typeof metrics.balance === 'number',
      display: typeof balance.display === 'string' ? balance.display : '',
    })
  }
  return { as_of: typeof asOf === 'string' ? asOf : '', rows }
}

/**
 * snapshotRowsEqual：dynamic_snapshot.rows 深比较（写回条件之一）。
 * 只比较语义字段，顺序不同视为不同（rows 顺序 = routes 顺序 = 排序结果，变化本身有信息量）。
 */
export function snapshotRowsEqual(a, b) {
  const norm = (rows) => JSON.stringify(Array.isArray(rows) ? rows : [])
  return norm(a) === norm(b)
}
