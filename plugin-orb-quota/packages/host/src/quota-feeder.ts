/**
 * Multi-channel quota snapshot for the lasso satellite, fed by the installed
 * dsh-quota(-multi) plugin's HTTP status route.
 *
 * The quota plugin owns every credential and adapter; this module only reads the
 * already-rendered snapshot (`/plugins/dsh-quota/api/status`), which reports key
 * references without values. The credentialed URL this module fetches is never
 * written to the log or any output (the standing rule in open-main.ts).
 * @module dsh-orb/host/quota-feeder
 */

/** A settings change and the periodic poll may ask in the same breath; share that read. */
const MIN_REFRESH_GAP_MS = 15_000
/** The quota route answers on loopback; anything slower is treated as gone. */
const FETCH_TIMEOUT_MS = 5_000

/** Route prefix is frozen by the quota plugin's install id (`quota`), not its package name. */
export const QUOTA_STATUS_PATH = '/plugins/dsh-quota/api/status'

export type QuotaProviderState = 'ok' | 'error' | 'missing-key' | 'missing-mcp'
const PROVIDER_STATES: readonly QuotaProviderState[] = ['ok', 'error', 'missing-key', 'missing-mcp']

/** One item row as the quota panel renders it (subset this module consumes). */
export interface QuotaItem {
  readonly label: string
  /** Used-percent for window items; absent on balance-only items. */
  readonly percent?: number
  /** Rendered reading for balance items, e.g. "余额 ¥57.93". */
  readonly display?: string
}

/** One platform row as the quota panel renders it (subset this module consumes). */
export interface QuotaProvider {
  readonly id: string
  readonly label: string
  readonly status: QuotaProviderState
  readonly message?: string
  readonly items: readonly QuotaItem[]
}

/** Display tier of one row. Red follows the snapshot's own alertPercent (default 85). */
export type QuotaTier = 'red' | 'yellow' | 'plain'

/** What the satellite, the popover, and the panel card show for one platform. */
export interface QuotaRow {
  readonly id: string
  readonly label: string
  /** One-line reading for the popover and the card ("周额度 82%" / "余额 ¥57.93"). */
  readonly text: string
  /** Highest used-percent among the row's window items; null on balance-only rows. */
  readonly percent: number | null
  readonly tier: QuotaTier
  readonly state: QuotaProviderState
}

export interface QuotaSnapshot {
  readonly rows: readonly QuotaRow[]
  /** Platform id the current model maps to; '' when the snapshot names none. */
  readonly current: string
  readonly refreshedAt: string
  readonly state: 'ready' | 'unavailable'
}

export const EMPTY_QUOTA: QuotaSnapshot = { rows: [], current: '', refreshedAt: '', state: 'unavailable' }

type QuotaRead =
  | { readonly kind: 'ready'; readonly providers: readonly QuotaProvider[]; readonly current: string; readonly alertPercent: number; readonly refreshedAt: string }
  | { readonly kind: 'unavailable' }

type ReadyRead = Extract<QuotaRead, { kind: 'ready' }>

/** Minimal fetch face so tests inject a stub and the runtime uses global fetch. */
export interface QuotaFetch {
  (url: string, init: { readonly signal: AbortSignal }): Promise<{
    readonly ok: boolean
    readonly status: number
    json(): Promise<unknown>
  }>
}

function boundedString(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string' || value === '') return undefined
  return value.length <= max ? value : undefined
}

/**
 * Validate one `/status` body. A missing or empty `providers` array is the degraded
 * case (quota plugin absent, or no platform ever answered) — not an error.
 */
export function parseQuotaStatus(body: unknown): QuotaRead {
  if (typeof body !== 'object' || body === null) return { kind: 'unavailable' }
  const record = body as { providers?: unknown; currentModel?: unknown; alertPercent?: unknown; refreshedAt?: unknown }
  if (!Array.isArray(record.providers)) return { kind: 'unavailable' }
  const providers: QuotaProvider[] = []
  for (const raw of record.providers) {
    if (typeof raw !== 'object' || raw === null) continue
    const entry = raw as { id?: unknown; label?: unknown; status?: unknown; message?: unknown; items?: unknown }
    const id = boundedString(entry.id, 120)
    if (id === undefined) continue
    const status = typeof entry.status === 'string' && (PROVIDER_STATES as readonly string[]).includes(entry.status)
      ? entry.status as QuotaProviderState
      : 'error'
    const items: QuotaItem[] = []
    if (Array.isArray(entry.items)) {
      for (const rawItem of entry.items) {
        if (typeof rawItem !== 'object' || rawItem === null) continue
        const item = rawItem as { label?: unknown; percent?: unknown; display?: string }
        const label = boundedString(item.label, 120)
        if (label === undefined) continue
        const percent = typeof item.percent === 'number' && Number.isFinite(item.percent) && item.percent >= 0
          ? item.percent
          : undefined
        items.push({ label, percent, display: boundedString(item.display, 200) })
      }
    }
    providers.push({
      id,
      label: boundedString(entry.label, 120) ?? id,
      status,
      message: boundedString(entry.message, 300),
      items,
    })
  }
  if (providers.length === 0) return { kind: 'unavailable' }
  const currentModel = typeof record.currentModel === 'object' && record.currentModel !== null
    ? (record.currentModel as { platform?: unknown })
    : undefined
  const alertPercent = typeof record.alertPercent === 'number' && Number.isFinite(record.alertPercent)
    && record.alertPercent >= 1 && record.alertPercent <= 100
    ? record.alertPercent
    : 85
  return {
    kind: 'ready',
    providers,
    current: boundedString(currentModel?.platform, 120) ?? '',
    alertPercent,
    refreshedAt: boundedString(record.refreshedAt, 64) ?? '',
  }
}

/** The reading a row shows: up to two headline items joined by " · ". */
export function rowText(provider: QuotaProvider): string {
  const headline = (item: QuotaItem): string | undefined => {
    if (item.percent !== undefined) return `${Math.round(item.percent)}%`
    return item.display
  }
  const preferred = provider.items.filter((item) => /窗口|周|余额|额度|金额|消耗|月/.test(item.label))
  const parts = (preferred.length > 0 ? preferred : provider.items)
    .map(headline)
    .filter((value): value is string => value !== undefined)
    .slice(0, 2)
  if (parts.length > 0) return parts.join(' · ')
  return provider.message ?? ''
}

/** Highest used-percent among the row's items, or null on balance-only rows. */
export function rowPercent(provider: QuotaProvider): number | null {
  let highest: number | undefined
  for (const item of provider.items) {
    if (item.percent === undefined) continue
    if (highest === undefined || item.percent > highest) highest = item.percent
  }
  return highest ?? null
}

function tierOf(percent: number | null, yellowPercent: number, alertPercent: number): QuotaTier {
  if (percent === null) return 'plain'
  if (percent >= alertPercent) return 'red'
  if (percent >= yellowPercent) return 'yellow'
  return 'plain'
}

const TIER_ORDER: Record<QuotaTier, number> = { red: 0, yellow: 1, plain: 2 }

/**
 * Fold validated providers into display rows.
 * Hidden ids drop out entirely (satellite, popover, and card agree); the rest sort by
 * tier, then used-percent descending, then id ascending, so the list is deterministic.
 */
export function toQuotaRows(
  providers: readonly QuotaProvider[],
  options: { readonly yellowPercent: number; readonly alertPercent: number; readonly hidden: readonly string[] },
): readonly QuotaRow[] {
  const hidden = new Set(options.hidden)
  const rows: QuotaRow[] = []
  for (const provider of providers) {
    if (hidden.has(provider.id)) continue
    const percent = rowPercent(provider)
    rows.push({
      id: provider.id,
      label: provider.label,
      text: provider.status === 'ok' ? rowText(provider) : provider.message ?? '',
      percent,
      tier: provider.status === 'ok' ? tierOf(percent, options.yellowPercent, options.alertPercent) : 'plain',
      state: provider.status,
    })
  }
  return rows.toSorted((left, right) =>
    TIER_ORDER[left.tier] - TIER_ORDER[right.tier]
    || (right.percent ?? -1) - (left.percent ?? -1)
    || left.id.localeCompare(right.id))
}

/**
 * The row the 56px satellite names: the most urgent reading (used-percent at or past
 * the yellow threshold, ties broken by id), else the current model's platform, else
 * the first healthy row by id. Undefined when nothing healthy is left to show.
 */
export function pickUrgentRow(rows: readonly QuotaRow[], yellowPercent: number, current: string): QuotaRow | undefined {
  const healthy = rows.filter((row) => row.state === 'ok')
  if (healthy.length === 0) return undefined
  const urgent = healthy
    .filter((row) => row.percent !== null && row.percent >= yellowPercent)
    .toSorted((left, right) =>
      (right.percent ?? -1) - (left.percent ?? -1)
      || left.id.localeCompare(right.id))
  if (urgent.length > 0) return urgent[0]
  const byCurrent = current !== '' ? healthy.find((row) => row.id === current) : undefined
  if (byCurrent !== undefined) return byCurrent
  return [...healthy].sort((left, right) => left.id.localeCompare(right.id))[0]
}

/**
 * Short, readable platform name for the satellite chip: the leading CJK run of a
 * Chinese label ("智谱 Coding Plan · max" → "智谱"), or the CamelCase initials
 * of an ASCII one ("OpenCode Go" → "OC", "DeepSeek" → "DS"). A short whole word
 * with no usable initials keeps itself ("Kimi", "Moonshot").
 */
function shortPlatformLabel(label: string): string {
  const cjk = /^[\u4e00-\u9fa5]+/.exec(label)
  if (cjk !== null) return cjk[0].slice(0, 4)
  const first = (label.split(/[\s·]+/)[0] ?? label).trim()
  const initials = first.replace(/[^A-Z]/g, '')
  if (initials.length >= 2 && initials.length <= 4) return initials
  return first.slice(0, 4)
}

/**
 * Compact chip text for the satellite: a short platform name and a rounded
 * headline value, sized to stay fully readable inside the 72px pill
 * ("智谱·40%" / "小米·¥58" / "OC·66%").
 */
export function compactQuotaText(row: QuotaRow): string {
  const label = shortPlatformLabel(row.label)
  if (row.percent !== null) return `${label}·${Math.round(row.percent)}%`
  // A balance reading carries its own descriptor ("余额 ¥57.93"); keep just the
  // leading amount, rounded to whole units, so the chip stays short.
  const amount = /([¥￥$€£])\s*([\d,]+(?:\.\d+)?)/.exec(row.text)
  if (amount !== null) {
    const rounded = Math.round(parseFloat(amount[2].replace(/,/g, '')))
    return `${label}·${amount[1]}${rounded}`
  }
  return `${label}·${row.text.replaceAll(' ', '').slice(0, 8)}`
}

/**
 * Cache one quota read and expose it as rows. The raw read is stored; rows are derived
 * on demand so a preference change (yellow threshold, hidden channels) re-shapes the
 * display without another request. Any failed or degraded read becomes `unavailable`
 * (rows cleared): the account balance is the fallback display, so there is nothing
 * worth keeping stale here — unlike the account monitor, which keeps its last amount
 * across one failed poll.
 */
export class QuotaFeeder {
  private cached: ReadyRead | undefined
  private inflight: Promise<QuotaSnapshot> | undefined
  private lastAt = Number.NEGATIVE_INFINITY
  private error: string | null = null

  constructor(
    private readonly deps: {
      /** Full credentialed status URL, or undefined when the web services are missing. Never logged. */
      readonly endpoint: () => string | undefined
      readonly fetch?: QuotaFetch
      readonly prefs: () => { readonly yellowPercent: number; readonly hidden: readonly string[] }
      readonly now?: () => number
      readonly log?: (message: string) => void
    },
  ) {}

  /** Rows with the hidden channels filtered out — what the satellite and the card show. */
  current(): QuotaSnapshot {
    return this.derive()
  }

  /** Every row, hidden ones included — the settings page's channel list. */
  allRows(): readonly QuotaRow[] {
    const read = this.cached
    if (read === undefined) return []
    const { yellowPercent } = this.deps.prefs()
    return toQuotaRows(read.providers, { yellowPercent, alertPercent: read.alertPercent, hidden: [] })
  }

  /** Diagnostic detail for the settings card; never rendered on the ball. */
  lastError(): string | null {
    return this.error
  }

  /**
   * Read the status route once and fold the outcome into {@link current}.
   * @param force - skip the short coalescing window (a settings toggle, not a poll).
   * @returns the snapshot now current.
   */
  refresh(force = false): Promise<QuotaSnapshot> {
    if (this.inflight !== undefined) return this.inflight
    const now = this.deps.now ?? Date.now
    if (!force && now() - this.lastAt < MIN_REFRESH_GAP_MS) return Promise.resolve(this.derive())
    this.lastAt = now()
    this.inflight = this.read().finally(() => {
      this.inflight = undefined
    })
    return this.inflight
  }

  /** Stop showing rows that no longer belong to a live quota plugin. */
  clear(): void {
    this.cached = undefined
    this.lastAt = Number.NEGATIVE_INFINITY
    this.error = null
  }

  private derive(): QuotaSnapshot {
    const read = this.cached
    if (read === undefined) return EMPTY_QUOTA
    const { yellowPercent, hidden } = this.deps.prefs()
    return {
      rows: toQuotaRows(read.providers, { yellowPercent, alertPercent: read.alertPercent, hidden }),
      current: read.current,
      refreshedAt: read.refreshedAt,
      state: 'ready',
    }
  }

  private async read(): Promise<QuotaSnapshot> {
    const url = this.deps.endpoint()
    if (url === undefined) {
      this.cached = undefined
      this.error = 'web services missing'
      return this.derive()
    }
    const controller = new AbortController()
    const timer = setTimeout(() => { controller.abort() }, FETCH_TIMEOUT_MS)
    try {
      const run = this.deps.fetch ?? fetch as unknown as QuotaFetch
      const response = await run(url, { signal: controller.signal })
      if (!response.ok) {
        // 404 is the quota plugin absent or inactive; every other status is just as gone.
        this.cached = undefined
        this.error = `status ${response.status}`
        return this.derive()
      }
      const parsed = parseQuotaStatus(await response.json())
      if (parsed.kind === 'unavailable') {
        this.cached = undefined
        this.error = 'no providers'
        return this.derive()
      }
      // A snapshot whose every provider is failing is the degraded case too: the
      // satellite would have nothing healthy to name, and the account takes over.
      if (!parsed.providers.some((provider) => provider.status === 'ok')) {
        this.cached = undefined
        this.error = 'no healthy provider'
        return this.derive()
      }
      this.cached = parsed
      this.error = null
      return this.derive()
    } catch (error) {
      this.cached = undefined
      this.error = error instanceof Error ? error.message : String(error)
      this.deps.log?.(`quota read failed: ${this.error}`)
      return this.derive()
    } finally {
      clearTimeout(timer)
    }
  }
}
