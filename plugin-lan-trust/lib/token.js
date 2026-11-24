/** Capture the DSH Web launch token from this process's own stdout.
 *
 * `dsh web` prints its start URL once, after the profile has loaded. A plugin
 * cannot reach the in-memory BrowserAuth token directly, but it can observe the
 * same line the user would otherwise copy. The token is kept in memory only;
 * it is never written to disk or returned by the gateway.
 */

const CAPTURE_KEY = Symbol.for('dsh.lan-trust.launch-token')
const TOKEN_PATTERN = /[?&]token=([A-Za-z0-9_-]{16,})/u

/** Scan a rolling text window for a launch token. Exported for unit tests. */
export function createTokenScanner(limit = 8192) {
  let window = ''
  let token
  return {
    feed(chunk) {
      if (token !== undefined) return token
      const text = typeof chunk === 'string'
        ? chunk
        : Buffer.isBuffer(chunk)
          ? chunk.toString('utf8')
          : String(chunk ?? '')
      window = (window + text).slice(-limit)
      const match = window.match(TOKEN_PATTERN)
      if (match !== null) token = match[1]
      return token
    },
    get() {
      return token
    },
  }
}

/** Install one process-wide stdout tee. Idempotent across plugin reloads. */
export function installTokenCapture() {
  const existing = globalThis[CAPTURE_KEY]
  if (existing !== undefined) return existing

  const scanner = createTokenScanner()
  const original = process.stdout.write
  process.stdout.write = function lanTrustStdoutWrite(chunk, ...args) {
    try {
      scanner.feed(chunk)
    } catch {
      // Never break the host's own logging because of the tee.
    }
    return original.call(this, chunk, ...args)
  }
  globalThis[CAPTURE_KEY] = scanner
  return scanner
}

/** Read the already-installed capture, if any. */
export function getTokenCapture() {
  return globalThis[CAPTURE_KEY]
}
