import test from 'node:test'
import assert from 'node:assert/strict'
import {
  describeAllowlist,
  isTrustedRequest,
  matchesAddress,
  normalizeAddress,
  parseAllowlist,
  parseEntry,
} from '../lib/trust.js'

test('normalizes IPv4-mapped and zoned addresses', () => {
  assert.equal(normalizeAddress('::ffff:192.168.3.5'), '192.168.3.5')
  assert.equal(normalizeAddress('fe80::1%eth0'), 'fe80::1')
  assert.equal(normalizeAddress(''), undefined)
})

test('matches IPv4 CIDRs and loopback', () => {
  const entries = parseAllowlist(['192.168.3.0/24', '127.0.0.1/32', '::1/128'])
  assert.equal(matchesAddress('192.168.3.125', entries), true)
  assert.equal(matchesAddress('::ffff:192.168.3.5', entries), true)
  assert.equal(matchesAddress('192.168.4.1', entries), false)
  assert.equal(matchesAddress('127.0.0.1', entries), true)
  assert.equal(matchesAddress('::1', entries), true)
  assert.equal(matchesAddress('10.0.0.1', entries), false)
})

test('allowLoopback=false does not bypass loopback', () => {
  const entries = parseAllowlist(['192.168.3.0/24'])
  assert.equal(matchesAddress('127.0.0.1', entries, false), false)
  assert.equal(matchesAddress('192.168.3.2', entries, false), true)
})

test('rejects malformed or unsupported entries', () => {
  assert.throws(() => parseEntry('192.168.3.0/33'), /prefix length/u)
  assert.throws(() => parseEntry('192.168.3.999/24'), /invalid/u)
  assert.throws(() => parseEntry('fd00::/8'), /only ::1\/128/u)
  assert.throws(() => parseAllowlist([]), /at least one/u)
})

test('reads only the direct socket address', () => {
  const entries = parseAllowlist(['192.168.3.0/24'])
  const request = {
    socket: { remoteAddress: '192.168.3.125' },
    headers: { 'x-forwarded-for': '10.0.0.9' },
  }
  assert.equal(isTrustedRequest(request, entries), true)
  assert.equal(isTrustedRequest({ socket: { remoteAddress: '10.0.0.9' }, headers: { 'x-forwarded-for': '192.168.3.125' } }, entries), false)
})

test('describes configured entries', () => {
  const entries = parseAllowlist(['192.168.3.0/24', '127.0.0.1/32'])
  assert.equal(describeAllowlist(entries), '192.168.3.0/24, 127.0.0.1/32')
})
