/**
 * selfcheck/source.test.mjs — quota-source：origin 解析 / loopback 围栏 / 响应分类 /
 * AbortError 重抛（raw 层）与绝不抛出（safe 层）。
 * 运行：node --test selfcheck/（或 node selfcheck/source.test.mjs）
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  resolveOrigin,
  isLoopbackOrigin,
  parseQuotaStatusBody,
  fetchQuotaStatusRaw,
  fetchQuotaStatus,
  createQuotaSource,
  QUOTA_STATUS_PATH,
} from '../lib/quota-source.js'
import { SNAPSHOT_OK, HTML_BODY, BAD_JSON_BODY } from './fixtures.mjs'

const LOOPBACK_ORIGIN = 'http://127.0.0.1:53961'

/** 假 Response 工厂。 */
function jsonResponse(body, { status = 200, contentType = 'application/json; charset=utf-8' } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => (String(k).toLowerCase() === 'content-type' ? contentType : null) },
    text: async () => body,
  }
}

test('resolveOrigin: webServer 缺席/畸形 → null（幂等激活，machine 永远缺席）', () => {
  assert.equal(resolveOrigin(undefined), null)
  assert.equal(resolveOrigin(null), null)
  assert.equal(resolveOrigin({}), null)
  assert.equal(resolveOrigin({ getOrigin: 'not-a-function' }), null)
  assert.equal(resolveOrigin({ getOrigin: () => { throw new Error('boom') } }), null)
  assert.equal(resolveOrigin({ getOrigin: () => '' }), null)
  assert.equal(resolveOrigin({ getOrigin: () => 42 }), null)
})

test('resolveOrigin: 正常 webServer → origin 字符串', () => {
  assert.equal(resolveOrigin({ getOrigin: () => LOOPBACK_ORIGIN }), LOOPBACK_ORIGIN)
})

test('isLoopbackOrigin: 仅放行 loopback（围栏纪律）', () => {
  assert.equal(isLoopbackOrigin('http://127.0.0.1:53961'), true)
  assert.equal(isLoopbackOrigin('http://localhost:1'), true)
  assert.equal(isLoopbackOrigin('https://[::1]:9'), true)
  assert.equal(isLoopbackOrigin('http://example.com'), false)
  assert.equal(isLoopbackOrigin('http://127.0.0.1.evil.com'), false)
  assert.equal(isLoopbackOrigin('not-a-url'), false)
  assert.equal(isLoopbackOrigin('ftp://127.0.0.1'), false)
  assert.equal(isLoopbackOrigin(''), false)
})

test('parseQuotaStatusBody: 正常快照 → ok + 最小消费裁剪（上游原始 JSON 不出宿主）', () => {
  const body = JSON.stringify({ ...SNAPSHOT_OK, keys: { xiaomi: { present: true } }, formats: ['f'], loginFlows: [], keyPlatforms: [] })
  const parsed = parseQuotaStatusBody(body)
  assert.equal(parsed.ok, true)
  // 裁剪：keys/formats/loginFlows/keyPlatforms 不透出（最小消费面）
  assert.equal('keys' in parsed.snapshot, false)
  assert.equal('formats' in parsed.snapshot, false)
  assert.equal('loginFlows' in parsed.snapshot, false)
  assert.equal('keyPlatforms' in parsed.snapshot, false)
  assert.equal(parsed.snapshot.refreshedAt, SNAPSHOT_OK.refreshedAt)
  assert.equal(parsed.snapshot.providers.length, SNAPSHOT_OK.providers.length)
  assert.equal(parsed.snapshot.currentModel.provider, 'zai-coding-cn')
  assert.deepEqual(parsed.snapshot.providerKeyRefs, SNAPSHOT_OK.providerKeyRefs)
})

test('parseQuotaStatusBody: 形状守卫（bad-json / bad-shape）', () => {
  assert.equal(parseQuotaStatusBody(BAD_JSON_BODY).reason, 'bad-json')
  assert.equal(parseQuotaStatusBody(HTML_BODY).reason, 'bad-json')
  assert.equal(parseQuotaStatusBody('[]').reason, 'bad-shape')
  assert.equal(parseQuotaStatusBody('null').reason, 'bad-shape')
  assert.equal(parseQuotaStatusBody('{"refreshedAt":"x"}').reason, 'bad-shape')
  assert.equal(parseQuotaStatusBody('{"providers":[]}').reason, 'bad-shape')
})

test('fetchQuotaStatusRaw: 正常路径 + 端点常量', async () => {
  assert.equal(QUOTA_STATUS_PATH, '/plugins/dsh-quota/api/status')
  let calledUrl = ''
  const fetchImpl = async (url) => {
    calledUrl = url
    return jsonResponse(JSON.stringify(SNAPSHOT_OK))
  }
  const result = await fetchQuotaStatusRaw({ origin: LOOPBACK_ORIGIN, fetchImpl })
  assert.equal(result.ok, true)
  assert.equal(calledUrl, LOOPBACK_ORIGIN + QUOTA_STATUS_PATH)
  assert.equal(typeof result.at, 'number')
})

test('fetchQuotaStatusRaw: 响应分类（HTML / json-content+html-body / 非 200）', async () => {
  const html = await fetchQuotaStatusRaw({ origin: LOOPBACK_ORIGIN, fetchImpl: async () => jsonResponse(HTML_BODY, { contentType: 'text/html' }) })
  assert.equal(html.reason, 'html-response')
  // content-type 是 json 但正文是 HTML（双判纵深）
  const disguised = await fetchQuotaStatusRaw({ origin: LOOPBACK_ORIGIN, fetchImpl: async () => jsonResponse(HTML_BODY) })
  assert.equal(disguised.reason, 'html-response')
  const err500 = await fetchQuotaStatusRaw({ origin: LOOPBACK_ORIGIN, fetchImpl: async () => jsonResponse('nope', { status: 500 }) })
  assert.equal(err500.reason, 'http-500')
  // 404（quota 未装/停用）→ 'http-404'：quota-cache 据此判确定性缺席（不进退避熔断）
  const err404 = await fetchQuotaStatusRaw({ origin: LOOPBACK_ORIGIN, fetchImpl: async () => jsonResponse('not found', { status: 404 }) })
  assert.equal(err404.reason, 'http-404')
})

test('fetchQuotaStatusRaw: 非 loopback origin 直接拒绝且不发起 fetch', async () => {
  let called = false
  const result = await fetchQuotaStatusRaw({ origin: 'http://example.com', fetchImpl: async () => { called = true; return jsonResponse('{}') } })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'non-loopback-origin')
  assert.equal(called, false)
})

test('fetchQuotaStatusRaw: AbortError/TimeoutError 原样重抛（07a 纪律 4，身份保留）', async () => {
  const timeoutLike = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })
  await assert.rejects(
    fetchQuotaStatusRaw({ origin: LOOPBACK_ORIGIN, fetchImpl: async () => { throw timeoutLike } }),
    (error) => error.name === 'TimeoutError',
  )
  const abortLike = Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })
  await assert.rejects(
    fetchQuotaStatusRaw({ origin: LOOPBACK_ORIGIN, fetchImpl: async () => { throw abortLike } }),
    (error) => error.name === 'AbortError',
  )
})

test('fetchQuotaStatusRaw: 普通网络错误 → 降级标记不抛出', async () => {
  const result = await fetchQuotaStatusRaw({ origin: LOOPBACK_ORIGIN, fetchImpl: async () => { throw new Error('ECONNREFUSED') } })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'network')
})

test('fetchQuotaStatus（safe 层）: 绝不抛出——超时归一 reason=timeout（任务书 §4.1）', async () => {
  const timeoutLike = Object.assign(new Error('timeout'), { name: 'TimeoutError' })
  const result = await fetchQuotaStatus({ origin: LOOPBACK_ORIGIN, fetchImpl: async () => { throw timeoutLike } })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'timeout')
  assert.equal(typeof result.at, 'number')
  const crashed = await fetchQuotaStatus({ origin: LOOPBACK_ORIGIN, fetchImpl: async () => { throw new Error('weird') } })
  assert.equal(crashed.ok, false)
  assert.ok(crashed.reason.startsWith('network'))
})

test('createQuotaSource: webServer 缺席 → available:false + fetch 恒 webserver-missing（§6.1）', async () => {
  const source = createQuotaSource(undefined)
  assert.equal(source.available, false)
  assert.equal(source.origin, null)
  const result = await source.fetch()
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'webserver-missing')
})

test('createQuotaSource: 正常 webServer → available:true + fetch 走 loopback', async () => {
  const source = createQuotaSource({ getOrigin: () => LOOPBACK_ORIGIN }, { fetchImpl: async () => jsonResponse(JSON.stringify(SNAPSHOT_OK)) })
  assert.equal(source.available, true)
  const result = await source.fetch()
  assert.equal(result.ok, true)
  assert.equal(result.snapshot.providers.length, SNAPSHOT_OK.providers.length)
})
