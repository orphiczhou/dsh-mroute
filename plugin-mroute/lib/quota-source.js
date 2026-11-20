/**
 * quota-source.js — 经宿主 webServer getOrigin() 同进程 loopback 读取 quota 插件面板快照。
 *
 * 接缝证据（lead 2026-11-15 亲测/读源码，docs/briefs/m2-dev.md §3）：
 * - quota 插件（dsh-quota-multi）无宿主 Service（function-plugin 形态，controller 是 apply 内
 *   闭包局部变量），唯一干净机读面 = 面板 HTTP API：`GET /plugins/dsh-quota/api/status`
 *   （plugin-quota-multi/src/http.ts:35-37，GET 无需 CSRF header，POST 才要 `x-dsh-quota`）。
 * - 宿主 webServer 服务有 `getOrigin(): string`（inspect host Service catalog 实证）；
 *   mroute `inject=['webServer']` → 同进程 loopback fetch。
 * - 快照形状权威定义 = plugin-quota-multi/src/config.ts（Config/ProviderSnapshot/QuotaItem）；
 *   模块注释明证 "API keys never live here"（config.ts:4）——快照不含密钥值，keyRef 只是引用名。
 *
 * 失败纪律（任务书 §4.1）：
 * - 失败**绝不抛出**（对外 safe 层 `fetchQuotaStatus` 恒返回 `{ok:false, reason}` 降级标记）；
 * - AbortError/TimeoutError 在 raw 层（`fetchQuotaStatusRaw`）**原样重抛**保留身份（07a 宿主侧
 *   配套 4「AbortError 必须重抛」），由 safe 层 catch 归一为 reason:'timeout'——两纪律分两层同时成立；
 * - HTTP 面 loopback only：origin hostname 非 127.0.0.1/localhost/[::1] 直接拒绝且不发起 fetch；
 * - 传输纪律（07a 宿主侧配套 3）：原生 fetch + AbortSignal.timeout(15s)，禁 curl-subprocess；
 * - 响应先判 content-type/HTML 再 JSON.parse（07a 宿主侧配套 4：200+HTML 陷阱）。
 *
 * 上游原始 JSON 不出宿主（红线 §5.5）：本模块返回的 snapshot 只保留最小消费字段
 * （refreshedAt/refreshing/providers/currentModel/providerKeyRefs），keys/formats/loginFlows/
 * keyPlatforms 等其余字段在 parse 时即丢弃，绝不透传给模型/日志。
 */
import { errorMessage } from './errors.js'

/** quota 面板快照端点（plugin-quota-multi/src/http.ts:20 API_PREFIX + http.ts:35 /status）。 */
export const QUOTA_STATUS_PATH = '/plugins/dsh-quota/api/status'
/** 请求超时（任务书 §4.1 定值 15s；07a 宿主侧配套 3 同值）。 */
export const QUOTA_FETCH_TIMEOUT_MS = 15_000

/**
 * 解析宿主 webServer origin。webServer 缺席 / getOrigin 非函数 / 返回非空字符串失败 → null
 * （幂等激活纪律：webServer 缺席的 profile 下调用方必须按 machine 永远缺席处理，插件照常激活）。
 * @param {object|undefined} webServer ctx.webServer（可选注入面）
 * @returns {string|null}
 */
export function resolveOrigin(webServer) {
  if (!webServer || typeof webServer.getOrigin !== 'function') return null
  let origin
  try {
    origin = webServer.getOrigin()
  } catch {
    return null
  }
  return typeof origin === 'string' && origin !== '' ? origin : null
}

/**
 * loopback 围栏：仅放行 127.0.0.1 / localhost / [::1]（07a 宿主侧配套 6 loopback 围栏；
 * 本函数只用于 mroute 主动外呼的 loopback 通道，与 quota 插件自身围栏无关）。
 * @param {string} origin
 * @returns {boolean}
 */
export function isLoopbackOrigin(origin) {
  let url
  try {
    url = new URL(origin)
  } catch {
    return false
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  const host = url.hostname.toLowerCase()
  return host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1'
}

/** AbortError/TimeoutError 识别（Node undici：AbortSignal.timeout 抛 TimeoutError，
 *  手动 abort 抛 AbortError；两者同属超时语义，07a 纪律 4 的「AbortError」覆盖两者）。 */
function isAbortLike(error) {
  return error?.name === 'AbortError' || error?.name === 'TimeoutError'
}

/**
 * 快照形状最低校验 + 最小消费字段裁剪（上游原始 JSON 不出宿主）。
 * @returns {{ ok:true, snapshot:object } | { ok:false, reason:string }}
 */
export function parseQuotaStatusBody(text) {
  let body
  try {
    body = JSON.parse(text)
  } catch {
    return { ok: false, reason: 'bad-json' }
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, reason: 'bad-shape' }
  if (!Array.isArray(body.providers)) return { ok: false, reason: 'bad-shape' }
  if (typeof body.refreshedAt !== 'string') return { ok: false, reason: 'bad-shape' }
  // 最小消费裁剪：只保留 mroute 归一化需要的字段。providerKeyRefs 值是引用名非密钥值
  // （config.ts:143 注释「凭证引用」；§3.7 红线证据），允许透出；currentModel 无敏感面。
  const snapshot = {
    refreshedAt: body.refreshedAt,
    refreshing: body.refreshing === true,
    providers: body.providers,
    currentModel:
      body.currentModel && typeof body.currentModel === 'object' && !Array.isArray(body.currentModel)
        ? body.currentModel
        : null,
    providerKeyRefs:
      body.providerKeyRefs && typeof body.providerKeyRefs === 'object' && !Array.isArray(body.providerKeyRefs)
        ? body.providerKeyRefs
        : {},
  }
  return { ok: true, snapshot }
}

/**
 * raw 层：发起 loopback fetch 并解析。AbortError/TimeoutError **重抛**（保留身份，07a 纪律 4）；
 * 其余一切失败返回 `{ok:false, reason}`（确定性拒绝不是异常）。
 * @param {{ origin:string, fetchImpl?:Function, timeoutMs?:number, path?:string }} options
 * @returns {Promise<{ ok:true, snapshot:object, at:number } | { ok:false, reason:string }>}
 */
export async function fetchQuotaStatusRaw(options) {
  const { origin } = options
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const timeoutMs = options.timeoutMs ?? QUOTA_FETCH_TIMEOUT_MS
  const path = options.path ?? QUOTA_STATUS_PATH
  // loopback 围栏：非 loopback origin 直接拒绝，绝不发起网络请求（红线：mroute 无外呼面）。
  if (!isLoopbackOrigin(origin)) return { ok: false, reason: 'non-loopback-origin' }
  if (typeof fetchImpl !== 'function') return { ok: false, reason: 'fetch-unavailable' }

  let response
  try {
    response = await fetchImpl(origin + path, { signal: AbortSignal.timeout(timeoutMs) })
  } catch (error) {
    if (isAbortLike(error)) throw error // 超时身份原样重抛（safe 层归一为 'timeout'）
    return { ok: false, reason: 'network' }
  }
  if (!response || typeof response.ok !== 'boolean') return { ok: false, reason: 'bad-response' }
  // 非 2xx：http-404 由 quota-cache 判「确定性缺席」（quota 未装/停用的稳定信号，
  // 不进退避熔断）；其余状态码（5xx/其它 4xx）按瞬态走原退避熔断链。
  if (!response.ok) return { ok: false, reason: `http-${response.status}` }

  const contentType = typeof response.headers?.get === 'function' ? String(response.headers.get('content-type') ?? '') : ''
  let text = ''
  try {
    text = await response.text()
  } catch (error) {
    if (isAbortLike(error)) throw error
    return { ok: false, reason: 'network' }
  }
  // 200+HTML 陷阱（07a 纪律 4）：content-type 非 json 或正文以 '<' 开头一律按 HTML 处理。
  const looksHtml = contentType && !contentType.includes('json')
  if (looksHtml || text.trimStart().startsWith('<')) return { ok: false, reason: 'html-response' }
  const parsed = parseQuotaStatusBody(text)
  if (!parsed.ok) return parsed
  return { ok: true, snapshot: parsed.snapshot, at: Date.now() }
}

/**
 * safe 层（对外唯一入口）：绝不抛出。AbortError/TimeoutError → reason:'timeout'；
 * 其余异常 → reason:'network'。返回结果恒为 `{ok, ...}` 形态。
 * @param {{ origin:string, fetchImpl?:Function, timeoutMs?:number, path?:string }} options
 * @returns {Promise<{ ok:true, snapshot:object, at:number } | { ok:false, reason:string, at:number }>}
 */
export async function fetchQuotaStatus(options) {
  const at = Date.now()
  try {
    return await fetchQuotaStatusRaw(options)
  } catch (error) {
    return { ok: false, reason: isAbortLike(error) ? 'timeout' : `network: ${errorMessage(error)}`, at }
  }
}

/**
 * 组装 mroute 侧 quota 拉取器（index.js 装配用）。
 * webServer 缺席（resolveOrigin=null）→ fetch 恒返回 `{ok:false, reason:'webserver-missing'}`，
 * 不发起任何请求（machine 永远缺席，插件照常激活——任务书 §4.7 幂等激活纪律）。
 * @param {object|undefined} webServer ctx.webServer
 * @param {{ fetchImpl?:Function, timeoutMs?:number }} [options] 注入面（selfcheck 用）
 */
export function createQuotaSource(webServer, options = {}) {
  const origin = resolveOrigin(webServer)
  return {
    /** origin 可用性（诊断面）。 */
    available: origin !== null,
    origin,
    /** @returns {Promise<{ ok:true, snapshot:object, at:number } | { ok:false, reason:string, at:number }>} */
    async fetch() {
      if (origin === null) return { ok: false, reason: 'webserver-missing', at: Date.now() }
      return fetchQuotaStatus({ origin, fetchImpl: options.fetchImpl, timeoutMs: options.timeoutMs })
    },
  }
}
