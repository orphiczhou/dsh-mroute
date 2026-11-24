import test from 'node:test'
import assert from 'node:assert/strict'
import { createTokenScanner } from '../lib/token.js'

test('scans a launch URL and keeps only the token', () => {
  const scanner = createTokenScanner()
  assert.equal(scanner.feed('dsh web: http://192.168.3.23:3081/?token='), undefined)
  assert.equal(scanner.feed('abc_DEF-1234567890\n'), 'abc_DEF-1234567890')
  assert.equal(scanner.get(), 'abc_DEF-1234567890')
})

test('ignores short or unrelated tokens', () => {
  const scanner = createTokenScanner()
  assert.equal(scanner.feed('?token=short'), undefined)
  assert.equal(scanner.feed('token=abcdefghijklmnop'), undefined)
  assert.equal(scanner.get(), undefined)
})

test('keeps a rolling window for split writes', () => {
  const scanner = createTokenScanner(128)
  for (const chunk of ['x'.repeat(60), '?token=', 'abcdefghijklmnop']) scanner.feed(chunk)
  assert.equal(scanner.get(), 'abcdefghijklmnop')
})
