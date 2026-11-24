import test from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../lib/index.js'

function fakeContext() {
  return {
    effects: [],
    effect(callback) {
      this.effects.push(callback())
    },
    logger: {
      info() {},
      warn() {},
      error() {},
    },
  }
}

test('disabled is a no-op', async () => {
  const ctx = fakeContext()
  await apply(ctx, { enabled: false })
  assert.equal(ctx.effects.length, 0)
})

test('missing origin fails closed without listening', async () => {
  const errors = []
  const ctx = fakeContext()
  ctx.logger.error = message => errors.push(String(message))
  await apply(ctx, { enabled: true, port: 3095 })
  assert.equal(ctx.effects.length, 0)
  assert.match(errors.join('\n'), /origin is required/u)
})
