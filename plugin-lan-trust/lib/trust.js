/** LAN trust matcher: IPv4 CIDRs, loopback, and exact IPv6 (::1). */

/** Normalize a Node socket address (strip IPv4-mapped prefix and zone). */
export function normalizeAddress(address) {
  if (typeof address !== 'string') return undefined
  let value = address.trim()
  if (value.startsWith('::ffff:')) value = value.slice('::ffff:'.length)
  const zone = value.indexOf('%')
  if (zone !== -1) value = value.slice(0, zone)
  return value.length > 0 ? value : undefined
}

/** Parse dotted-quad IPv4 into an unsigned 32-bit integer. */
export function parseIPv4(value) {
  if (typeof value !== 'string') return undefined
  const parts = value.split('.')
  if (parts.length !== 4) return undefined
  let result = 0
  for (const part of parts) {
    if (!/^(?:0|[1-9]\d{0,2})$/u.test(part)) return undefined
    const octet = Number(part)
    if (octet > 255) return undefined
    result = ((result * 256) + octet) >>> 0
  }
  return result
}

function maskFor(bits) {
  if (bits === 0) return 0
  return (0xffffffff << (32 - bits)) >>> 0
}

/**
 * Parse one allowlist entry.
 * Accepted: IPv4 CIDR, bare IPv4, `::1`, `::1/128`, or an exact IPv6 literal.
 * Other IPv6 CIDRs are rejected rather than silently treated as a host.
 */
export function parseEntry(entry) {
  if (typeof entry !== 'string' || entry.trim() === '') {
    throw new Error('lan-trust: allowlist entries must be non-empty strings')
  }
  const text = entry.trim()
  const slash = text.indexOf('/')
  const address = slash === -1 ? text : text.slice(0, slash)
  const prefixText = slash === -1 ? undefined : text.slice(slash + 1)
  const ipv4 = parseIPv4(address)
  if (ipv4 !== undefined) {
    const bits = prefixText === undefined ? 32 : Number(prefixText)
    if (!Number.isInteger(bits) || bits < 0 || bits > 32) {
      throw new Error(`lan-trust: invalid IPv4 prefix length in "${text}"`)
    }
    return { kind: 'ipv4', base: (ipv4 & maskFor(bits)) >>> 0, bits, text }
  }
  if (address === '::1' && (prefixText === undefined || prefixText === '128')) {
    return { kind: 'exact', address: '::1', text }
  }
  if (address.includes('.')) {
    throw new Error(`lan-trust: invalid IPv4 address in "${text}"`)
  }
  if (prefixText !== undefined) {
    throw new Error(`lan-trust: unsupported IPv6 CIDR "${text}" (only ::1/128 is supported)`)
  }
  if (address.includes(':')) return { kind: 'exact', address, text }
  throw new Error(`lan-trust: invalid or unsupported allowlist entry "${text}"`)
}

/** Parse and validate the whole list up front. */
export function parseAllowlist(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error('lan-trust: allowedCidrs must contain at least one entry')
  }
  return entries.map(parseEntry)
}

/** Match one normalized address against parsed entries. */
export function matchesAddress(address, parsed, allowLoopback = true) {
  const value = normalizeAddress(address)
  if (value === undefined) return false
  if (allowLoopback && (value === '127.0.0.1' || value === '::1')) return true
  const ipv4 = parseIPv4(value)
  for (const entry of parsed) {
    if (entry.kind === 'exact' && value === entry.address) return true
    if (entry.kind === 'ipv4' && ipv4 !== undefined
      && ((ipv4 & maskFor(entry.bits)) >>> 0) === entry.base) return true
  }
  return false
}

/** Extract the direct socket peer address; never trusts forwarding headers. */
export function remoteAddress(request) {
  return normalizeAddress(request?.socket?.remoteAddress)
}

/** True when the direct TCP peer is inside the configured allowlist. */
export function isTrustedRequest(request, parsed, allowLoopback = true) {
  return matchesAddress(remoteAddress(request), parsed, allowLoopback)
}

/** Human-readable summary for logs and diagnostics. */
export function describeAllowlist(entries) {
  return entries.map(entry => entry.text).join(', ')
}
