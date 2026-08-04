/**
 * What do we have, and is any of it about to be lost?
 *
 * The Health screen answers "is this still out there?". This one answers the
 * question that follows: *who is keeping it?* — and it is the screen that turns
 * an answer into an action.
 *
 * The distinction the whole view is built around is that a backup file keeps the
 * bytes, while a pin keeps the content *reachable*. The DAO's May-2026 archive
 * had 10,762 content IDs in it and 428 of them were already gone: not corrupted,
 * not deleted, simply nobody's responsibility any more. They were not a random
 * 4% either. Of the assets BIC had rescued from Arweave, 96.5% were dead; of the
 * ones rescued from old websites, 88.6%. Of the content other people also pin,
 * 0.7%. The pattern is the point, and the table below marks the rescued rows so a
 * member can see it for themselves.
 *
 * Three things shape the implementation:
 *
 *  • **It renders ~20,000 rows.** The table is virtualised — only the rows in
 *    the scroll window exist in the document — and the geometry that makes that
 *    correct (row height, fixed table layout, column widths) is set inline
 *    rather than left to a stylesheet, because a missing rule would otherwise
 *    mean twenty thousand live rows and a frozen window.
 *
 *  • **One pin state changing must not re-render the table.** Live progress goes
 *    into a small store keyed by content ID, and each row subscribes to its own
 *    ID through `useSyncExternalStore`. A row that is not on screen has no
 *    subscription at all.
 *
 *  • **`unknown` is never drawn as "not pinned".** A dash means we did not ask —
 *    a node that was switched off, a service with no key saved. Treating that as
 *    "not pinned" would send a member re-pinning ten thousand files that were
 *    never at risk; treating it as "pinned" would hide the ones that are. Both
 *    are worse than admitting we do not know.
 *
 * Classes owned by this file are listed at the bottom, for the stylesheet.
 */

import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
  type UIEvent
} from 'react'

/*
 * `../../preload` resolves to the preload implementation, which declares the
 * IPC shapes; the pinning contracts are re-exported from there for other
 * callers but come from `shared/pinning`, so they are taken from the source.
 */
import type { ArchiveSnapshot, ArchiverApi, IpcResult } from '../../preload'
import type {
  AssetRow,
  PinProgress,
  PinResult,
  PinRunSummary,
  PinState,
  PinTargetId,
  PinTargetStatus
} from '../../shared/pinning'

import { Cid } from './Cid'
import {
  Banner,
  Card,
  EmptyState,
  OperationStatus,
  ViewHeader,
  formatBytes,
  formatCount,
  roleLabel,
  useOperation,
  type Tone
} from './Layout'

/* ========================================================================== */
/* Reaching the bridge                                                        */
/* ========================================================================== */

/**
 * `window.api` is reached directly, and defensively.
 *
 * Every call in this file is checked for at the moment of use rather than taken
 * on trust, so a preload that failed to load produces one plain sentence instead
 * of "undefined is not a function" thrown out of a click handler.
 */
function bridge(): ArchiverApi | null {
  const candidate: unknown = (globalThis as unknown as Record<string, unknown>)['api']
  if (typeof candidate !== 'object' || candidate === null) return null
  const record = candidate as Record<string, unknown>
  if (typeof record['pinAssets'] !== 'function') return null
  if (typeof record['onPinProgress'] !== 'function') return null
  return candidate as ArchiverApi
}

const BRIDGE_MISSING =
  'This window could not reach the archiver. Please quit BIC Archiver and open it again.'

const UNEXPECTED = 'Something went wrong inside the app. Please try that again.'

/** Run one bridge call, turning both failure modes into the usual result shape. */
async function withBridge<T>(
  call: (api: ArchiverApi) => Promise<IpcResult<T>>
): Promise<IpcResult<T>> {
  const api = bridge()
  if (api === null) return { ok: false, error: BRIDGE_MISSING }
  try {
    return await call(api)
  } catch {
    return { ok: false, error: UNEXPECTED }
  }
}

/* ========================================================================== */
/* Live pin progress                                                          */
/* ========================================================================== */

/** What one target is doing to one content ID right now. */
interface LivePin {
  state: PinState
  message: string
}

type LivePins = Readonly<Partial<Record<PinTargetId, LivePin>>>

/** Shared so `getSnapshot` returns a stable reference for the common case. */
const NO_LIVE: LivePins = {}

const PHASE_STATE: Readonly<Record<PinProgress['phase'], PinState>> = {
  importing: 'pinning',
  requesting: 'pinning',
  waiting: 'pinning',
  verifying: 'pinning',
  done: 'pinned',
  error: 'failed'
}

/**
 * Where live pinning progress lands.
 *
 * Deliberately *not* React state. A run over the real archive emits tens of
 * thousands of events; putting them in component state would re-render a
 * twenty-thousand-row table on each one. Instead every event updates one entry
 * and wakes only the listeners for that content ID — and the only listeners that
 * exist belong to rows currently on screen, because a row unsubscribes the
 * moment it scrolls out of the window.
 *
 * Messages whose `cid` is empty are the run talking about itself ("Packing the
 * archive into a file your IPFS node can read…"). They belong to no row, so they
 * are kept separately and shown above the table.
 */
class PinLiveStore {
  private readonly byCid = new Map<string, LivePins>()
  private readonly cidListeners = new Map<string, Set<() => void>>()
  private readonly noteListeners = new Set<() => void>()
  private note: PinProgress | null = null
  /** Job-level problems worth keeping after the run — "Kubo is not running". */
  private notices: readonly string[] = []
  private attached = false

  /**
   * Attach once and stay attached. Detaching when the last row unmounts would
   * drop the events that arrive while a member is scrolling, and an idle
   * listener costs nothing.
   */
  readonly attach = (): void => {
    if (this.attached) return
    const api = bridge()
    if (api === null) return
    this.attached = true
    api.onPinProgress(this.handle)
  }

  readonly handle = (progress: PinProgress): void => {
    if (typeof progress !== 'object' || progress === null) return

    const target: PinTargetId = progress.target === 'pinata' ? 'pinata' : 'kubo'
    const cid = typeof progress.cid === 'string' ? progress.cid.trim() : ''
    const message = typeof progress.message === 'string' ? progress.message : ''
    const state = PHASE_STATE[progress.phase] ?? 'pinning'

    if (cid === '') {
      this.note = { ...progress, cid: '', target, message }
      if (progress.phase === 'error' && message !== '' && !this.notices.includes(message)) {
        this.notices = [...this.notices, message].slice(-MAX_NOTICES)
      }
      for (const listener of [...this.noteListeners]) listener()
      return
    }

    const previous = this.byCid.get(cid) ?? NO_LIVE
    const existing = previous[target]
    if (existing !== undefined && existing.state === state && existing.message === message) return

    this.byCid.set(cid, { ...previous, [target]: { state, message } })
    const listeners = this.cidListeners.get(cid)
    if (listeners !== undefined) for (const listener of [...listeners]) listener()
  }

  readonly get = (cid: string): LivePins => this.byCid.get(cid) ?? NO_LIVE

  readonly subscribeCid = (cid: string, listener: () => void): (() => void) => {
    this.attach()
    let set = this.cidListeners.get(cid)
    if (set === undefined) {
      set = new Set()
      this.cidListeners.set(cid, set)
    }
    set.add(listener)
    return () => {
      const current = this.cidListeners.get(cid)
      if (current === undefined) return
      current.delete(listener)
      if (current.size === 0) this.cidListeners.delete(cid)
    }
  }

  readonly getNote = (): PinProgress | null => this.note

  readonly getNotices = (): readonly string[] => this.notices

  readonly subscribeNote = (listener: () => void): (() => void) => {
    this.attach()
    this.noteListeners.add(listener)
    return () => {
      this.noteListeners.delete(listener)
    }
  }

  /** Forget everything — called once the freshly-read rows carry the truth. */
  readonly clear = (): void => {
    this.byCid.clear()
    this.note = null
    this.notices = []
    // Only mounted rows hold a listener, so this wakes tens of components, not
    // tens of thousands.
    for (const listeners of [...this.cidListeners.values()]) {
      for (const listener of [...listeners]) listener()
    }
    for (const listener of [...this.noteListeners]) listener()
  }
}

const MAX_NOTICES = 6

const pinLive = new PinLiveStore()

/** Live pin states for one content ID. Re-renders only that row. */
function useLivePins(cid: string): LivePins {
  const subscribe = useCallback(
    (listener: () => void): (() => void) => pinLive.subscribeCid(cid, listener),
    [cid]
  )
  const snapshot = useCallback((): LivePins => pinLive.get(cid), [cid])
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}

/** The run's own commentary — the lines that belong to no single row. */
function useLiveNote(): PinProgress | null {
  return useSyncExternalStore(pinLive.subscribeNote, pinLive.getNote, pinLive.getNote)
}

/** Job-level problems collected during the run, kept after it ends. */
function useLiveNotices(): readonly string[] {
  return useSyncExternalStore(pinLive.subscribeNote, pinLive.getNotices, pinLive.getNotices)
}

/* ========================================================================== */
/* Reading a row                                                              */
/* ========================================================================== */

/** Is any target we asked about keeping this? */
function pinnedSomewhere(row: AssetRow): boolean {
  return row.pins.kubo === 'pinned' || row.pins.pinata === 'pinned'
}

/** Did any target we asked about say it is *not* keeping this? */
function knownUnpinned(row: AssetRow): boolean {
  return row.pins.kubo === 'not-pinned' || row.pins.pinata === 'not-pinned'
}

function anyFailed(row: AssetRow): boolean {
  return row.pins.kubo === 'failed' || row.pins.pinata === 'failed'
}

/**
 * The number in red at the top: nothing is keeping this, and the network is not
 * confirming that anyone is serving it either.
 *
 * `'unchecked'` counts. Before a health run there is no evidence anyone serves
 * it and none that anyone keeps it — which is precisely the state those 428
 * content IDs sat in for two years while everybody assumed the backup was fine.
 */
function pinnedNowhereServedByNobody(row: AssetRow): boolean {
  return !pinnedSomewhere(row) && row.network !== 'healthy'
}

/**
 * What "Pin only what is at risk" acts on, and what the rescue toggle shows.
 *
 * Two ways in: nothing is keeping it, or the network has already started losing
 * it. The second half matters because a file pinned only on this laptop, which
 * gateways can no longer serve, is one hard drive away from gone.
 */
function needsRescue(row: AssetRow): boolean {
  if (!pinnedSomewhere(row)) return true
  return row.network === 'unreachable' || row.network === 'at-risk'
}

/**
 * Is this one of the files BIC rescued?
 *
 * The archiver files anything it saves from Arweave or an ordinary website under
 * `arweave image/`, `web metadata/` and the like, and `assets.ts` turns those
 * folder names straight into the role. So the role *is* the provenance — and
 * these are the rows where 96.5% and 88.6% of the deaths happened, because BIC
 * is the only party that ever pinned them.
 */
function isRescued(role: string): boolean {
  return /^(web|arweave) \S/.test(role)
}

const NETWORK_LOOK: Readonly<
  Record<AssetRow['network'], { tone: Tone; label: string; rank: number; explain: string }>
> = {
  unreachable: {
    tone: 'danger',
    label: 'Unreachable',
    rank: 3,
    explain: 'Nobody is offering this and no gateway would serve it. Every copy has gone offline.'
  },
  'at-risk': {
    tone: 'warn',
    label: 'At risk',
    rank: 2,
    explain:
      'A gateway still serves this, but nobody is announcing that they hold it — usually a cache that will clear.'
  },
  unchecked: {
    tone: 'neutral',
    label: 'Not checked',
    rank: 1,
    explain: 'Nobody has asked the network about this yet. Run a check on the Health screen.'
  },
  healthy: {
    tone: 'ok',
    label: 'Online',
    rank: 0,
    explain: 'Computers on the network hold this and a public gateway handed it over.'
  }
}

/**
 * `rank` orders the column when a member sorts by it — worst first, so one click
 * on "Your node" brings the failures to the top.
 *
 * `tone` is the shared status colour, so a green pill means the same thing here
 * as on the Health screen. `unknown` has no tone at all: it is drawn as a dash,
 * because "we did not ask" is not a status and must not look like one.
 */
const PIN_LOOK: Readonly<
  Record<PinState, { tone: Tone | null; label: string; rank: number; explain: string }>
> = {
  failed: {
    tone: 'danger',
    label: 'Failed',
    rank: 4,
    explain: 'The last attempt to pin this did not work.'
  },
  'not-pinned': {
    tone: 'neutral',
    label: 'Not pinned',
    rank: 3,
    explain: 'This service is not keeping a copy. If nothing else is, this content can disappear.'
  },
  unknown: {
    tone: null,
    label: '—',
    rank: 2,
    explain: 'Not asked. This service is switched off or could not be reached, so we do not know.'
  },
  pinning: {
    tone: 'warn',
    label: 'Pinning…',
    rank: 1,
    explain: 'Being pinned right now.'
  },
  pinned: {
    tone: 'ok',
    label: 'Pinned',
    rank: 0,
    explain: 'This service is keeping a copy and will serve it to anyone who asks.'
  }
}

/** Roles as a member would say them, with the archiver's own folders named. */
function describeRole(role: string): string {
  switch (role) {
    case 'archive root':
      return 'The whole archive'
    case 'folder':
      return 'Folder'
    case 'provenance':
      return 'Record of where it came from'
    case 'missing':
      return 'Missing from this archive'
    case 'damaged':
      return 'Damaged'
    case 'file':
      return 'File'
    default:
      break
  }
  if (isRescued(role)) {
    // 'arweave image' → 'Arweave image', 'web metadata' → 'Web description file'.
    const cut = role.indexOf(' ')
    const where = role.slice(0, cut)
    const what = role.slice(cut + 1)
    const source = where === 'web' ? 'Website' : 'Arweave'
    return `${source} — ${roleLabel(what).toLowerCase()}`
  }
  return roleLabel(role)
}

/* ========================================================================== */
/* Keys, filters and sorting                                                  */
/* ========================================================================== */

/**
 * One table row. The key is stable across reloads — it is built from the path
 * and the content ID — so React reuses DOM nodes and a member's selection is not
 * silently rearranged under them.
 */
interface KeyedRow {
  key: string
  row: AssetRow
}

function keyRows(rows: readonly AssetRow[]): KeyedRow[] {
  const used = new Set<string>()
  const keyed: KeyedRow[] = []
  for (const row of rows) {
    const base = `${row.path}\u0000${row.cid}`
    let key = base
    let attempt = 1
    while (used.has(key)) {
      key = `${base}\u0000${String(attempt)}`
      attempt += 1
    }
    used.add(key)
    keyed.push({ key, row })
  }
  return keyed
}

type NetworkFilter = 'any' | AssetRow['network']
type PinFilter = 'any' | 'pinned' | 'unpinned' | 'failed' | 'unknown'

/** The role filter's two synthetic entries, alongside the real role names. */
const ROLE_ANY = '__any'
const ROLE_RESCUED = '__rescued'

interface Filters {
  nft: string
  role: string
  network: NetworkFilter
  pin: PinFilter
  text: string
  rescueOnly: boolean
}

const NO_FILTERS: Filters = {
  nft: '',
  role: ROLE_ANY,
  network: 'any',
  pin: 'any',
  text: '',
  rescueOnly: false
}

function matches(row: AssetRow, filters: Filters, needle: string): boolean {
  if (filters.nft !== '' && row.nft !== filters.nft) return false

  if (filters.role === ROLE_RESCUED) {
    if (!isRescued(row.role)) return false
  } else if (filters.role !== ROLE_ANY && row.role !== filters.role) {
    return false
  }

  if (filters.network !== 'any' && row.network !== filters.network) return false

  switch (filters.pin) {
    case 'pinned':
      if (!pinnedSomewhere(row)) return false
      break
    case 'unpinned':
      if (pinnedSomewhere(row) || !knownUnpinned(row)) return false
      break
    case 'failed':
      if (!anyFailed(row)) return false
      break
    case 'unknown':
      if (row.pins.kubo !== undefined || row.pins.pinata !== undefined) return false
      break
    default:
      break
  }

  if (filters.rescueOnly && !needsRescue(row)) return false

  if (needle !== '') {
    const inPath = row.path.toLowerCase().includes(needle)
    if (!inPath && !row.cid.toLowerCase().includes(needle)) return false
  }

  return true
}

type SortColumn = 'nft' | 'path' | 'role' | 'size' | 'network' | 'kubo' | 'pinata'
type SortDirection = 'asc' | 'desc'

interface Sort {
  column: SortColumn
  direction: SortDirection
}

/**
 * Worst news first, which is the whole reason this screen exists. A member who
 * opens it and reads the top three rows should already know what is wrong.
 */
const DEFAULT_SORT: Sort = { column: 'network', direction: 'desc' }

function pinRank(row: AssetRow, target: PinTargetId): number {
  return PIN_LOOK[row.pins[target] ?? 'unknown'].rank
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

function compareBy(column: SortColumn, a: AssetRow, b: AssetRow): number {
  switch (column) {
    case 'nft':
      return collator.compare(a.nft, b.nft)
    case 'path':
      return collator.compare(a.path, b.path)
    case 'role':
      return collator.compare(describeRole(a.role), describeRole(b.role))
    case 'size':
      return a.size - b.size
    case 'network':
      return NETWORK_LOOK[a.network].rank - NETWORK_LOOK[b.network].rank
    case 'kubo':
      return pinRank(a, 'kubo') - pinRank(b, 'kubo')
    case 'pinata':
      return pinRank(a, 'pinata') - pinRank(b, 'pinata')
    default:
      return 0
  }
}

function sortRows(rows: KeyedRow[], sort: Sort): KeyedRow[] {
  const factor = sort.direction === 'asc' ? 1 : -1
  const sorted = [...rows]
  sorted.sort((left, right) => {
    const primary = compareBy(sort.column, left.row, right.row) * factor
    if (primary !== 0) return primary
    // Everything ties eventually; path keeps the order stable and readable.
    return collator.compare(left.row.path, right.row.path)
  })
  return sorted
}

/* ========================================================================== */
/* The numbers at the top                                                     */
/* ========================================================================== */

interface Stats {
  total: number
  files: number
  folders: number
  bytes: number
  healthy: number
  atRisk: number
  unreachable: number
  unchecked: number
  /** Pinned nowhere *and* not confirmed healthy. The headline. */
  dark: number
  /** What the rescue toggle and "Pin only what is at risk" act on. */
  atRiskToPin: number
  /** Rows BIC rescued from Arweave or an old website. */
  rescued: number
  /** …of which nothing is keeping. */
  rescuedDark: number
}

const NO_STATS: Stats = {
  total: 0,
  files: 0,
  folders: 0,
  bytes: 0,
  healthy: 0,
  atRisk: 0,
  unreachable: 0,
  unchecked: 0,
  dark: 0,
  atRiskToPin: 0,
  rescued: 0,
  rescuedDark: 0
}

function summarise(rows: readonly AssetRow[]): Stats {
  const stats: Stats = { ...NO_STATS, total: rows.length }

  for (const row of rows) {
    if (row.isDirectory) {
      stats.folders += 1
    } else {
      stats.files += 1
      // A folder's recorded size already contains its children; counting both
      // would report the archive at several times its real weight.
      if (Number.isFinite(row.size) && row.size > 0) stats.bytes += row.size
    }

    switch (row.network) {
      case 'healthy':
        stats.healthy += 1
        break
      case 'at-risk':
        stats.atRisk += 1
        break
      case 'unreachable':
        stats.unreachable += 1
        break
      default:
        stats.unchecked += 1
        break
    }

    const dark = pinnedNowhereServedByNobody(row)
    if (dark) stats.dark += 1
    if (needsRescue(row)) stats.atRiskToPin += 1
    if (isRescued(row.role)) {
      stats.rescued += 1
      if (dark) stats.rescuedDark += 1
    }
  }

  return stats
}

/* ========================================================================== */
/* Virtual table geometry                                                     */
/* ========================================================================== */

/**
 * Set here rather than in the stylesheet on purpose. The scroll maths depends on
 * every row being exactly this tall, and on the table not resizing its own
 * columns around the content — a stylesheet that forgot either would not look
 * slightly wrong, it would put twenty thousand rows in the document and stop the
 * window responding.
 */
const ROW_HEIGHT = 40
const OVERSCAN = 8
const COLUMN_COUNT = 9

const TABLE_STYLE: CSSProperties = { tableLayout: 'fixed', width: '100%' }

const SCROLL_STYLE: CSSProperties = {
  height: 'min(58vh, 720px)',
  minHeight: 260,
  overflow: 'auto'
}

const CELL_STYLE: CSSProperties = {
  height: ROW_HEIGHT,
  padding: '0 12px',
  verticalAlign: 'middle',
  overflow: 'hidden',
  whiteSpace: 'nowrap',
  textOverflow: 'ellipsis'
}

const NUMBER_CELL_STYLE: CSSProperties = { ...CELL_STYLE, textAlign: 'right' }

const SPACER_CELL_STYLE: CSSProperties = { padding: 0, border: 0, height: 'inherit' }

/**
 * Column widths. Percentages add to 100 beside the fixed checkbox column.
 *
 * The last three are wider than they look like they need to be, and
 * deliberately: they carry the status pills, and "Unreachable" or "Not pinned"
 * clipped to "Unreachab" is the one kind of truncation this screen cannot
 * afford. Size is held wide enough for "1011 bytes" for the same reason — a
 * number cut to "1011 …" is not a shortened number, it is a different one.
 *
 * Paths and file kinds are what give way instead. Both keep the whole string in
 * a tooltip, and neither is a verdict.
 */
const COLUMN_WIDTHS = ['44px', '13%', '17%', '12%', '9%', '9%', '15%', '12.5%', '12.5%'] as const

/* ========================================================================== */
/* The view                                                                   */
/* ========================================================================== */

export interface AssetsViewProps {
  /** The archive that is open. Switching archive reloads the table. */
  snapshot: ArchiveSnapshot
  /**
   * Take the member to the pinning settings. Without it the view still explains
   * what is missing in words — it just does not offer a button that goes there.
   */
  onOpenSettings?: () => void
  /** Take the member to the Add NFTs screen, for the empty state. */
  onAddTokens?: () => void
  /** Publish a snapshot this view produced, so the rest of the window agrees. */
  onSnapshot?: (snapshot: ArchiveSnapshot) => void
}

export function AssetsView({
  snapshot,
  onOpenSettings,
  onAddTokens,
  onSnapshot
}: AssetsViewProps): ReactNode {
  const [rows, setRows] = useState<readonly AssetRow[]>([])
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [targets, setTargets] = useState<readonly PinTargetStatus[]>([])
  const [summary, setSummary] = useState<PinRunSummary | null>(null)

  const [filters, setFilters] = useState<Filters>(NO_FILTERS)
  const [sort, setSort] = useState<Sort>(DEFAULT_SORT)
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set())

  const pinOp = useOperation()
  const notices = useLiveNotices()

  const archiveDir = snapshot.dir
  const rootCid = snapshot.manifest.rootCid ?? ''
  const tokenCount = snapshot.manifest.tokens.length

  /* --- loading ---------------------------------------------------------- */

  const loadTargets = useCallback(async (): Promise<void> => {
    const result = await withBridge((api) => api.pinTargets())
    if (result.ok) setTargets(result.value)
  }, [])

  const loadRows = useCallback(async (): Promise<void> => {
    setLoading(true)
    const result = await withBridge((api) => api.pinAssets())
    setLoading(false)
    setLoaded(true)
    if (result.ok) {
      setRows(result.value)
      setLoadError(null)
      // The rows that just arrived carry the settled truth, so the live overlay
      // from the run that produced them is no longer needed — and leaving it
      // would keep spinners turning over rows that have finished.
      pinLive.clear()
    } else {
      setLoadError(result.error)
    }
  }, [])

  /*
   * Load on mount, and again whenever the member opens a different archive or
   * assembles this one for the first time. Both change what there is to list.
   */
  const lastLoadKey = useRef<string | null>(null)
  useEffect(() => {
    const key = `${archiveDir}\u0000${rootCid}`
    if (lastLoadKey.current === key) return
    lastLoadKey.current = key
    setRows([])
    setLoaded(false)
    setLoadError(null)
    setSelected(new Set())
    setSummary(null)
    void loadTargets()
    if (rootCid !== '') void loadRows()
    else setLoaded(true)
  }, [archiveDir, rootCid, loadRows, loadTargets])

  /* --- derived ---------------------------------------------------------- */

  const keyed = useMemo(() => keyRows(rows), [rows])
  const stats = useMemo(() => summarise(rows), [rows])

  const nftNames = useMemo(() => {
    const names = new Set<string>()
    for (const row of rows) if (row.nft !== '') names.add(row.nft)
    return [...names].sort((a, b) => collator.compare(a, b))
  }, [rows])

  const roles = useMemo(() => {
    const found = new Set<string>()
    for (const row of rows) found.add(row.role)
    return [...found].sort((a, b) => collator.compare(describeRole(a), describeRole(b)))
  }, [rows])

  const needle = useDebounced(filters.text.trim().toLowerCase(), 180)

  const visible = useMemo(() => {
    const kept = keyed.filter((item) => matches(item.row, filters, needle))
    return sortRows(kept, sort)
  }, [keyed, filters, needle, sort])

  const kubo = targets.find((target) => target.target === 'kubo')
  const pinata = targets.find((target) => target.target === 'pinata')
  const canPin = (kubo?.available ?? false) || (pinata?.available ?? false)

  /* --- actions ---------------------------------------------------------- */

  const toggleSort = useCallback((column: SortColumn) => {
    setSort((previous) => {
      if (previous.column !== column) {
        // First click on a status column shows the worst first; on a text or
        // size column, the ordinary A–Z / smallest-first.
        const worstFirst = column === 'network' || column === 'kubo' || column === 'pinata'
        return { column, direction: worstFirst ? 'desc' : 'asc' }
      }
      return { column, direction: previous.direction === 'asc' ? 'desc' : 'asc' }
    })
  }, [])

  const toggleRow = useCallback((key: string, on: boolean) => {
    setSelected((previous) => {
      const next = new Set(previous)
      if (on) next.add(key)
      else next.delete(key)
      return next
    })
  }, [])

  const setAllVisible = useCallback(
    (on: boolean) => {
      setSelected((previous) => {
        const next = new Set(previous)
        for (const item of visible) {
          if (on) next.add(item.key)
          else next.delete(item.key)
        }
        return next
      })
    },
    [visible]
  )

  const selectedCids = useMemo(() => {
    if (selected.size === 0) return []
    const cids: string[] = []
    const seen = new Set<string>()
    for (const item of keyed) {
      if (!selected.has(item.key)) continue
      if (seen.has(item.row.cid)) continue
      seen.add(item.row.cid)
      cids.push(item.row.cid)
    }
    return cids
  }, [keyed, selected])

  const atRiskCids = useMemo(() => {
    const cids: string[] = []
    const seen = new Set<string>()
    for (const row of rows) {
      if (!needsRescue(row)) continue
      if (seen.has(row.cid)) continue
      seen.add(row.cid)
      cids.push(row.cid)
    }
    return cids
  }, [rows])

  /**
   * Every pin run goes through here: clear the last result, clear the overlay,
   * run, then re-read the rows so the table shows what is *actually* pinned
   * rather than what the run said. Verification over trust is the same rule the
   * engine follows, and it is why a member can believe this screen.
   */
  const runPin = useCallback(
    async (start: string, body: (api: ArchiverApi, opId: string) => Promise<IpcResult<PinRunSummary>>) => {
      setSummary(null)
      pinLive.clear()
      pinLive.attach()
      const value = await pinOp.run<PinRunSummary>({
        start,
        body: (opId) => withBridge((api) => body(api, opId)),
        success: describeRun
      })
      if (value !== null) setSummary(value)
      await Promise.all([loadRows(), loadTargets()])
    },
    [pinOp, loadRows, loadTargets]
  )

  const pinEverything = useCallback(() => {
    void runPin('Making sure everything in this archive is kept…', (api, opId) =>
      api.pinArchive(undefined, opId)
    )
  }, [runPin])

  const pinAtRisk = useCallback(() => {
    const cids = atRiskCids
    if (cids.length === 0) return
    void runPin(
      `Rescuing ${formatCount(cids.length)} ${cids.length === 1 ? 'item' : 'items'}…`,
      (api, opId) => api.pinAll(cids, undefined, opId)
    )
  }, [atRiskCids, runPin])

  const pinSelected = useCallback(() => {
    const cids = selectedCids
    if (cids.length === 0) return
    void runPin(
      `Pinning ${formatCount(cids.length)} selected ${cids.length === 1 ? 'item' : 'items'}…`,
      (api, opId) => api.pinAll(cids, undefined, opId)
    )
  }, [selectedCids, runPin])

  const assemble = useCallback(() => {
    void (async () => {
      const result = await withBridge((api) => api.buildRoot())
      if (!result.ok) {
        setLoadError(result.error)
        return
      }
      onSnapshot?.(result.value.snapshot)
      await loadRows()
    })()
  }, [loadRows, onSnapshot])

  /* --- render ----------------------------------------------------------- */

  const busy = pinOp.busy

  return (
    <div className="view">
      <ViewHeader
        title="What we have"
        lead={
          <>
            Content that nobody pins disappears — and the files BIC rescued from Arweave and old
            websites are exactly the ones nobody else is keeping.{' '}
            <strong>
              In the DAO's real May 2026 backup, 428 content IDs had already gone that way.
            </strong>{' '}
            This screen shows everything in the archive and who, if anyone, is holding on to it.
          </>
        }
        actions={
          <div className="assets-actions">
            <button
              type="button"
              className="btn btn-primary btn-lg"
              onClick={pinEverything}
              disabled={busy || !canPin || rootCid === ''}
              title={
                canPin
                  ? 'Pin every content ID in this archive, the archive folder itself first.'
                  : 'Set up an IPFS node or a Pinata key first.'
              }
            >
              Pin everything
            </button>
            <button
              type="button"
              className="btn btn-lg"
              onClick={pinAtRisk}
              disabled={busy || !canPin || atRiskCids.length === 0}
              title="Only the content nothing is keeping, plus anything the network has started losing."
            >
              {atRiskCids.length === 0
                ? 'Pin only what is at risk'
                : `Pin only what is at risk (${formatCount(atRiskCids.length)})`}
            </button>
          </div>
        }
      />

      <TargetStrip
        kubo={kubo}
        pinata={pinata}
        unreachable={stats.unreachable}
        onOpenSettings={onOpenSettings}
      />

      {/* ---------------------------------------------------------------- */}
      {/* The state of things                                               */}
      {/* ---------------------------------------------------------------- */}

      {loaded && rows.length > 0 && (
        <SummaryBand
          stats={stats}
          onFilter={(next) => {
            setFilters({ ...NO_FILTERS, ...next })
          }}
        />
      )}

      {loaded && stats.rescuedDark > 0 && (
        <Banner
          tone="danger"
          title={`${formatCount(stats.rescuedDark)} of the files BIC rescued ${stats.rescuedDark === 1 ? 'is' : 'are'} being kept by nobody`}
          actions={
            <button
              type="button"
              className="btn btn-sm btn-primary"
              onClick={pinAtRisk}
              disabled={busy || !canPin}
            >
              Pin what is at risk
            </button>
          }
        >
          These came from Arweave or from websites that have since changed, so BIC is the only party
          that ever pinned them. That is not a theory: in the May 2026 sweep, 96.5% of the
          Arweave-sourced files and 88.6% of the web-sourced ones were already unreachable, against
          0.7% of the content other people also pin.
        </Banner>
      )}

      <div aria-live="polite">
        <OperationStatus op={pinOp} stopLabel="Stop pinning">
          <button type="button" className="btn btn-sm" onClick={() => void loadRows()}>
            Check again
          </button>
        </OperationStatus>
      </div>

      {busy && <LiveNote />}

      {summary !== null && !busy && <RunSummary summary={summary} notices={notices} />}

      {loadError !== null && (
        <Banner tone="danger" title="This archive could not be listed">
          {loadError}
        </Banner>
      )}

      {/* ---------------------------------------------------------------- */}
      {/* The table, or the reason there is not one                         */}
      {/* ---------------------------------------------------------------- */}

      {loading && rows.length === 0 ? (
        <div className="card row" aria-live="polite">
          <span className="spinner" aria-hidden="true" />
          <span className="grow">
            Reading the archive and asking each service what it is keeping…
          </span>
        </div>
      ) : rootCid === '' ? (
        <EmptyState
          title="This archive has not been put together yet"
          action={
            tokenCount > 0 ? (
              <button type="button" className="btn btn-primary btn-lg" onClick={assemble}>
                Put the archive together
              </button>
            ) : onAddTokens !== undefined ? (
              <button type="button" className="btn btn-primary btn-lg" onClick={onAddTokens}>
                Add NFTs
              </button>
            ) : undefined
          }
        >
          {tokenCount > 0
            ? 'Everything downloaded so far is on disk, but it has not been assembled into one backup folder yet — and that folder is what gives the whole archive a single address to pin.'
            : 'There is nothing in this archive so far. Add some NFTs on the Add NFTs screen — the first one in the sidebar — and everything they point at will be downloaded and listed here.'}
        </EmptyState>
      ) : loaded && rows.length === 0 ? (
        <EmptyState
          title="Nothing in this archive yet"
          action={
            onAddTokens !== undefined ? (
              <button type="button" className="btn btn-primary btn-lg" onClick={onAddTokens}>
                Add NFTs
              </button>
            ) : undefined
          }
        >
          Add some NFTs on the Add NFTs screen — the first one in the sidebar — and every description
          file, picture and animation they point at will be downloaded, listed here, and, if you have
          somewhere to pin them, kept.
        </EmptyState>
      ) : rows.length > 0 ? (
        <>
          <FilterBar
            filters={filters}
            onChange={setFilters}
            nftNames={nftNames}
            roles={roles}
            shown={visible.length}
            total={rows.length}
            atRisk={stats.atRiskToPin}
          />

          <div className="assets-selection row">
            <span className="grow small faint">
              {selected.size === 0
                ? 'Tick rows to pin just those.'
                : `${formatCount(selected.size)} ${selected.size === 1 ? 'row' : 'rows'} ticked — ${formatCount(selectedCids.length)} ${selectedCids.length === 1 ? 'content ID' : 'content IDs'}.`}
            </span>
            {selected.size > 0 && (
              <button type="button" className="btn btn-sm" onClick={() => setSelected(new Set())}>
                Clear selection
              </button>
            )}
            <button
              type="button"
              className="btn btn-sm btn-primary"
              onClick={pinSelected}
              disabled={busy || !canPin || selectedCids.length === 0}
            >
              Pin selected
            </button>
          </div>

          <AssetTable
            items={visible}
            selected={selected}
            sort={sort}
            onSort={toggleSort}
            onToggleRow={toggleRow}
            onToggleAll={setAllVisible}
          />
        </>
      ) : null}

      <Card title="What the columns mean">
        <dl className="kv">
          <dt>
            <span className="pill pill-ok assets-pin">
              <span className="pill-dot" aria-hidden="true" />
              Pinned
            </span>
          </dt>
          <dd>That service is keeping a copy and will hand it to anyone who asks.</dd>

          <dt>
            <span className="pill pill-neutral assets-pin">
              <span className="pill-dot" aria-hidden="true" />
              Not pinned
            </span>
          </dt>
          <dd>
            That service is not keeping it. If nothing else is, this content is one dead hard drive
            away from gone.
          </dd>

          <dt>
            <span className="assets-pin-unknown">—</span>
          </dt>
          <dd>
            <strong>Not asked.</strong> The service is switched off, or could not be reached, so we
            genuinely do not know. This is not the same as "not pinned", and the difference is what
            decides whether something needs rescuing.
          </dd>

          <dt>Your IPFS node</dt>
          <dd>
            The load-bearing one. A pinning service can only fetch content that somebody is still
            offering — so for content that has already gone, the only way back is to run a node
            here, load the backup into it, and let the service fetch it from you.
          </dd>
        </dl>
      </Card>
    </div>
  )
}

export default AssetsView

/* ========================================================================== */
/* Where things can be pinned                                                 */
/* ========================================================================== */

function TargetStrip({
  kubo,
  pinata,
  unreachable,
  onOpenSettings
}: {
  kubo: PinTargetStatus | undefined
  pinata: PinTargetStatus | undefined
  unreachable: number
  onOpenSettings?: () => void
}): ReactNode {
  const kuboReady = kubo?.available ?? false
  const pinataReady = pinata?.available ?? false

  const settingsButton =
    onOpenSettings !== undefined ? (
      <button type="button" className="btn btn-sm btn-primary" onClick={onOpenSettings}>
        Open Settings
      </button>
    ) : undefined

  if (!kuboReady && !pinataReady) {
    return (
      <Banner
        tone="warn"
        big
        title="Nothing is set up to keep this content yet"
        {...(settingsButton !== undefined ? { actions: settingsButton } : {})}
      >
        Pinning needs one of two things: an IPFS node running on this computer, or a Pinata key.{' '}
        {/* When the window has not handed this view a way to get to Settings,
            say where it is instead. A member left with "go to Settings" and no
            Settings is a member who gives up. */}
        {settingsButton !== undefined
          ? 'Settings explains both and checks them for you.'
          : 'Settings — at the foot of the sidebar on the left — explains both and checks them for you.'}{' '}
        {kubo?.detail !== undefined && kubo.detail !== '' ? <em>{kubo.detail}</em> : null}{' '}
        {pinata?.detail !== undefined && pinata.detail !== '' ? <em>{pinata.detail}</em> : null}
      </Banner>
    )
  }

  return (
    <div className="assets-targets row">
      <span className={`pill ${kuboReady ? 'pill-ok' : 'pill-neutral'}`}>
        <span className="pill-dot" aria-hidden="true" />
        {kuboReady ? 'Your IPFS node is ready' : 'No IPFS node on this computer'}
      </span>
      <span className={`pill ${pinataReady ? 'pill-ok' : 'pill-neutral'}`}>
        <span className="pill-dot" aria-hidden="true" />
        {pinataReady ? 'Pinata is ready' : 'Pinata is not set up'}
      </span>
      <span className="grow small faint">
        {kuboReady && kubo?.detail !== undefined && kubo.detail !== ''
          ? kubo.detail
          : !kuboReady && unreachable > 0
            ? `Pinata can only fetch content somebody is still offering, so it cannot bring back the ${formatCount(unreachable)} ${unreachable === 1 ? 'item' : 'items'} nobody is serving. That needs an IPFS node on this computer, holding the backup and offering it.`
            : ''}
      </span>
      {onOpenSettings !== undefined && (
        <button type="button" className="btn btn-sm" onClick={onOpenSettings}>
          Settings
        </button>
      )}
    </div>
  )
}

/* ========================================================================== */
/* The summary band                                                           */
/* ========================================================================== */

/**
 * Most alarming first, and every figure is a button that filters the table to
 * exactly those rows — a number a member cannot act on is decoration.
 */
function SummaryBand({
  stats,
  onFilter
}: {
  stats: Stats
  onFilter: (filters: Partial<Filters>) => void
}): ReactNode {
  return (
    <div className="assets-summary">
      <button
        type="button"
        className="assets-stat assets-stat-danger"
        onClick={() => onFilter({ rescueOnly: true, pin: 'any' })}
        title="Nothing we asked is keeping these, and the network is not confirming that anyone is serving them either."
      >
        <span className="assets-stat-value">{formatCount(stats.dark)}</span>
        <span className="assets-stat-label">pinned nowhere and served by nobody</span>
      </button>

      <button
        type="button"
        className="assets-stat assets-stat-danger"
        onClick={() => onFilter({ network: 'unreachable' })}
        title="A health check found nobody offering these and no gateway willing to serve them."
      >
        <span className="assets-stat-value">{formatCount(stats.unreachable)}</span>
        <span className="assets-stat-label">unreachable on the network</span>
      </button>

      <button
        type="button"
        className="assets-stat assets-stat-warn"
        onClick={() => onFilter({ network: 'at-risk' })}
        title="A gateway still serves these, but nobody is announcing that they hold a copy."
      >
        <span className="assets-stat-value">{formatCount(stats.atRisk)}</span>
        <span className="assets-stat-label">at risk</span>
      </button>

      <button
        type="button"
        className="assets-stat assets-stat-ok"
        onClick={() => onFilter({ network: 'healthy' })}
        title="Computers on the network hold these and a public gateway handed them over."
      >
        <span className="assets-stat-value">{formatCount(stats.healthy)}</span>
        <span className="assets-stat-label">online</span>
      </button>

      <div className="assets-stat assets-stat-quiet">
        <span className="assets-stat-value">{formatBytes(stats.bytes)}</span>
        <span className="assets-stat-label">
          across {formatCount(stats.files)} {stats.files === 1 ? 'file' : 'files'} in{' '}
          {formatCount(stats.folders)} {stats.folders === 1 ? 'folder' : 'folders'}
          {stats.unchecked > 0
            ? ` · ${formatCount(stats.unchecked)} never checked against the network`
            : ''}
        </span>
      </div>
    </div>
  )
}

/* ========================================================================== */
/* Filters                                                                    */
/* ========================================================================== */

function FilterBar({
  filters,
  onChange,
  nftNames,
  roles,
  shown,
  total,
  atRisk
}: {
  filters: Filters
  onChange: (filters: Filters) => void
  nftNames: readonly string[]
  roles: readonly string[]
  shown: number
  total: number
  atRisk: number
}): ReactNode {
  const set = <K extends keyof Filters>(key: K, value: Filters[K]): void => {
    onChange({ ...filters, [key]: value })
  }

  const filtering =
    filters.nft !== '' ||
    filters.role !== ROLE_ANY ||
    filters.network !== 'any' ||
    filters.pin !== 'any' ||
    filters.text !== '' ||
    filters.rescueOnly

  return (
    <section className="card assets-filters" aria-label="Filter the list">
      <div className="assets-filter-row">
        <label className="field assets-filter">
          <span className="field-label" id="assets-filter-text-label">
            Search paths and content IDs
          </span>
          <input
            className="input"
            type="search"
            value={filters.text}
            placeholder="ape.png, bafybei…"
            aria-labelledby="assets-filter-text-label"
            onChange={(event) => set('text', event.target.value)}
          />
        </label>

        <label className="field assets-filter">
          <span className="field-label">NFT</span>
          <select
            className="input assets-select"
            value={filters.nft}
            onChange={(event) => set('nft', event.target.value)}
          >
            <option value="">Every NFT</option>
            {nftNames.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>

        <label className="field assets-filter">
          <span className="field-label">Kind of file</span>
          <select
            className="input assets-select"
            value={filters.role}
            onChange={(event) => set('role', event.target.value)}
          >
            <option value={ROLE_ANY}>Anything</option>
            <option value={ROLE_RESCUED}>Anything BIC rescued</option>
            {roles.map((role) => (
              <option key={role} value={role}>
                {describeRole(role)}
              </option>
            ))}
          </select>
        </label>

        <label className="field assets-filter">
          <span className="field-label">On the network</span>
          <select
            className="input assets-select"
            value={filters.network}
            onChange={(event) => set('network', event.target.value as NetworkFilter)}
          >
            <option value="any">Any state</option>
            <option value="unreachable">Unreachable</option>
            <option value="at-risk">At risk</option>
            <option value="healthy">Online</option>
            <option value="unchecked">Not checked</option>
          </select>
        </label>

        <label className="field assets-filter">
          <span className="field-label">Pinned</span>
          <select
            className="input assets-select"
            value={filters.pin}
            onChange={(event) => set('pin', event.target.value as PinFilter)}
          >
            <option value="any">Anywhere or nowhere</option>
            <option value="pinned">Pinned somewhere</option>
            <option value="unpinned">Pinned nowhere</option>
            <option value="failed">Last attempt failed</option>
            <option value="unknown">Nobody asked</option>
          </select>
        </label>
      </div>

      <div className="row assets-filter-foot">
        <label className="assets-toggle">
          <input
            type="checkbox"
            checked={filters.rescueOnly}
            onChange={(event) => set('rescueOnly', event.target.checked)}
          />
          <span>
            Show only what needs rescuing{atRisk > 0 ? ` (${formatCount(atRisk)})` : ''}
          </span>
        </label>

        <span className="grow small faint">
          Showing {formatCount(shown)} of {formatCount(total)}.
        </span>

        {filtering && (
          <button type="button" className="btn btn-sm" onClick={() => onChange(NO_FILTERS)}>
            Clear filters
          </button>
        )}
      </div>
    </section>
  )
}

/* ========================================================================== */
/* The table                                                                  */
/* ========================================================================== */

interface AssetTableProps {
  items: readonly KeyedRow[]
  selected: ReadonlySet<string>
  sort: Sort
  onSort: (column: SortColumn) => void
  onToggleRow: (key: string, on: boolean) => void
  onToggleAll: (on: boolean) => void
}

/**
 * A real `<table>` with real `<th scope="col">`, virtualised.
 *
 * Only the rows in the scroll window are in the document; the space above and
 * below them is held open by two empty rows. That keeps the scrollbar honest,
 * keeps the header, the column semantics and keyboard navigation intact, and
 * means twenty thousand rows cost the same as forty.
 */
function AssetTable({
  items,
  selected,
  sort,
  onSort,
  onToggleRow,
  onToggleAll
}: AssetTableProps): ReactNode {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const [startIndex, setStartIndex] = useState(0)
  const [viewport, setViewport] = useState(560)

  /* The window height decides how many rows exist; measure it rather than
     assume, because a member's window is whatever size they made it. */
  useEffect(() => {
    const node = scrollRef.current
    if (node === null) return undefined
    const measure = (): void => {
      setViewport(node.clientHeight > 0 ? node.clientHeight : 560)
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => {
      observer.disconnect()
    }
  }, [])

  /* A new filter or sort means the row under the scrollbar is not the row a
     member was looking at, so go back to the top rather than leave them
     somewhere arbitrary — or, worse, scrolled past the end of a shorter list. */
  useEffect(() => {
    setStartIndex(0)
    if (scrollRef.current !== null) scrollRef.current.scrollTop = 0
  }, [items])

  const onScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    const next = Math.max(0, Math.floor(event.currentTarget.scrollTop / ROW_HEIGHT))
    // Only crossing a row boundary changes what is on screen, so this re-renders
    // once per row scrolled rather than once per pixel.
    setStartIndex((previous) => (previous === next ? previous : next))
  }, [])

  const perScreen = Math.max(1, Math.ceil(viewport / ROW_HEIGHT))
  const first = Math.max(0, Math.min(startIndex, Math.max(0, items.length - 1)) - OVERSCAN)
  const last = Math.min(items.length, first + perScreen + OVERSCAN * 2)
  // Not named `window`: this file reaches the bridge through the real one, and a
  // local of that name would shadow it silently.
  const onScreen = items.slice(first, last)

  const topPad = first * ROW_HEIGHT
  const bottomPad = Math.max(0, (items.length - last) * ROW_HEIGHT)

  const allTicked = items.length > 0 && items.every((item) => selected.has(item.key))
  const someTicked = !allTicked && items.some((item) => selected.has(item.key))

  const selectAllRef = useRef<HTMLInputElement | null>(null)
  useEffect(() => {
    if (selectAllRef.current !== null) selectAllRef.current.indeterminate = someTicked
  }, [someTicked])

  if (items.length === 0) {
    return (
      <EmptyState title="Nothing matches those filters">
        Widen the search, or clear the filters to see the whole archive again.
      </EmptyState>
    )
  }

  return (
    <div className="table-wrap assets-scroll" ref={scrollRef} style={SCROLL_STYLE} onScroll={onScroll}>
      <table className="table assets-table" style={TABLE_STYLE}>
        <caption className="sr-only">
          Everything in this archive: what it is, whether the network still serves it, and which
          services are keeping a copy.
        </caption>

        <colgroup>
          {COLUMN_WIDTHS.map((width, index) => (
            <col key={width + String(index)} style={{ width }} />
          ))}
        </colgroup>

        <thead>
          <tr>
            <th scope="col" style={CELL_STYLE}>
              <input
                ref={selectAllRef}
                type="checkbox"
                checked={allTicked}
                aria-label="Select every row shown"
                onChange={(event) => onToggleAll(event.target.checked)}
              />
            </th>
            <SortHeader column="nft" label="NFT" sort={sort} onSort={onSort} />
            <SortHeader column="path" label="Where it is" sort={sort} onSort={onSort} />
            <th scope="col" style={CELL_STYLE}>
              Content ID
            </th>
            <SortHeader column="role" label="What it is" sort={sort} onSort={onSort} />
            <SortHeader column="size" label="Size" sort={sort} onSort={onSort} align="right" />
            <SortHeader column="network" label="Network" sort={sort} onSort={onSort} />
            <SortHeader column="kubo" label="Your node" sort={sort} onSort={onSort} />
            <SortHeader column="pinata" label="Pinata" sort={sort} onSort={onSort} />
          </tr>
        </thead>

        <tbody>
          {topPad > 0 && (
            <tr aria-hidden="true" style={{ height: topPad }}>
              <td colSpan={COLUMN_COUNT} style={SPACER_CELL_STYLE} />
            </tr>
          )}

          {onScreen.map((item) => (
            <AssetTableRow
              key={item.key}
              item={item}
              selected={selected.has(item.key)}
              onToggle={onToggleRow}
            />
          ))}

          {bottomPad > 0 && (
            <tr aria-hidden="true" style={{ height: bottomPad }}>
              <td colSpan={COLUMN_COUNT} style={SPACER_CELL_STYLE} />
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}

function SortHeader({
  column,
  label,
  sort,
  onSort,
  align
}: {
  column: SortColumn
  label: string
  sort: Sort
  onSort: (column: SortColumn) => void
  align?: 'right'
}): ReactNode {
  const active = sort.column === column
  return (
    <th
      scope="col"
      aria-sort={active ? (sort.direction === 'asc' ? 'ascending' : 'descending') : 'none'}
      style={align === 'right' ? { ...CELL_STYLE, textAlign: 'right' } : CELL_STYLE}
    >
      <button
        type="button"
        className={`assets-sort${active ? ' is-active' : ''}`}
        onClick={() => onSort(column)}
      >
        {label}
        <span className="assets-sort-arrow" aria-hidden="true">
          {active ? (sort.direction === 'asc' ? '▲' : '▼') : '↕'}
        </span>
      </button>
    </th>
  )
}

/* ========================================================================== */
/* One row                                                                    */
/* ========================================================================== */

interface AssetTableRowProps {
  item: KeyedRow
  selected: boolean
  onToggle: (key: string, on: boolean) => void
}

/**
 * Memoised, and subscribed to its own content ID.
 *
 * `item` and `onToggle` keep their identity between renders, so a row only
 * re-renders when its own tick box changes or when its own pin state moves. A
 * run over ten thousand content IDs therefore touches the handful of rows a
 * member can actually see.
 */
const AssetTableRow = memo(function AssetTableRow({
  item,
  selected,
  onToggle
}: AssetTableRowProps): ReactNode {
  const row = item.row
  const live = useLivePins(row.cid)
  const network = NETWORK_LOOK[row.network]
  const rescued = isRescued(row.role)
  const isRoot = row.path === ''
  const label = isRoot ? 'The archive folder itself' : row.path

  return (
    <tr style={{ height: ROW_HEIGHT }} data-rescued={rescued ? 'yes' : undefined}>
      <td style={CELL_STYLE}>
        <input
          type="checkbox"
          checked={selected}
          aria-label={`Select ${label}`}
          onChange={(event) => onToggle(item.key, event.target.checked)}
        />
      </td>

      <td style={CELL_STYLE} title={row.nft === '' ? 'The whole archive' : row.nft}>
        {row.nft === '' ? <span className="faint">Whole archive</span> : row.nft}
      </td>

      <td style={CELL_STYLE} title={label}>
        {isRoot ? <span className="faint">{label}</span> : label}
      </td>

      <td style={CELL_STYLE}>
        <Cid cid={row.cid} label="content ID" head={8} tail={4} />
      </td>

      <td
        style={CELL_STYLE}
        title={rescued ? 'BIC rescued this file. Nobody else pins it.' : undefined}
      >
        {describeRole(row.role)}
        {rescued && (
          <>
            {' '}
            <span className="assets-rescued" title="BIC rescued this. Nobody else pins it.">
              rescued
            </span>
          </>
        )}
      </td>

      <td className="tabular" style={NUMBER_CELL_STYLE}>
        {row.isDirectory ? <span className="faint">—</span> : formatBytes(row.size)}
      </td>

      <td style={CELL_STYLE}>
        <span className={`pill pill-${network.tone}`} title={network.explain}>
          <span className="pill-dot" aria-hidden="true" />
          {network.label}
        </span>
      </td>

      <td style={CELL_STYLE}>
        <PinCell base={row.pins.kubo} live={live.kubo} target="your IPFS node" />
      </td>

      <td style={CELL_STYLE}>
        <PinCell base={row.pins.pinata} live={live.pinata} target="Pinata" />
      </td>
    </tr>
  )
})

/**
 * One pin state.
 *
 * A live update outranks the stored one, because during a run the stored value
 * is by definition out of date. An absent state is `unknown` and is drawn as a
 * dash — never as "not pinned", which would be a claim we have not earned.
 */
function PinCell({
  base,
  live,
  target
}: {
  base: PinState | undefined
  live: LivePin | undefined
  target: string
}): ReactNode {
  const state: PinState = live?.state ?? base ?? 'unknown'
  const look = PIN_LOOK[state]
  const title = live?.message !== undefined && live.message !== '' ? live.message : look.explain

  if (state === 'unknown') {
    return (
      <span className="assets-pin-unknown" title={`${look.explain} (${target})`}>
        <span aria-hidden="true">—</span>
        {/* A dash reads as nothing at all to a screen reader, and "nothing" is
            exactly the reading this cell must not have. */}
        <span className="sr-only">Not asked</span>
      </span>
    )
  }

  return (
    <span className={`pill pill-${look.tone ?? 'neutral'} assets-pin`} title={title}>
      {state === 'pinning' ? (
        <span className="spinner spinner-xs" aria-hidden="true" />
      ) : (
        <span className="pill-dot" aria-hidden="true" />
      )}
      {look.label}
    </span>
  )
}

/* ========================================================================== */
/* Live commentary and the result                                             */
/* ========================================================================== */

/** The run talking about itself — the messages that belong to no single row. */
function LiveNote(): ReactNode {
  const note = useLiveNote()
  if (note === null || note.message === '') return null
  return (
    <p className="small faint assets-note" aria-live="polite">
      {note.target === 'pinata' ? 'Pinata: ' : 'Your IPFS node: '}
      {note.message}
    </p>
  )
}

function describeRun(summary: PinRunSummary): string {
  const parts: string[] = []
  if (summary.pinned > 0) parts.push(`${formatCount(summary.pinned)} now kept safely`)
  if (summary.skipped > 0) parts.push(`${formatCount(summary.skipped)} already kept`)
  if (summary.queued > 0) parts.push(`${formatCount(summary.queued)} still being fetched`)
  if (summary.failed > 0) parts.push(`${formatCount(summary.failed)} could not be pinned`)
  if (parts.length === 0) return 'There was nothing to pin.'
  if (parts.length === 1) return `${parts[0] ?? ''}.`
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1] ?? ''}.`
}

/** How many failures to list before it stops being a list and becomes noise. */
const MAX_SHOWN_FAILURES = 25

function RunSummary({
  summary,
  notices
}: {
  summary: PinRunSummary
  notices: readonly string[]
}): ReactNode {
  const failures = summary.failures.slice(0, MAX_SHOWN_FAILURES)
  const hidden = Math.max(0, summary.failed - failures.length)

  if (summary.failed === 0 && notices.length === 0) return null

  return (
    <Card title={summary.failed > 0 ? 'What could not be pinned' : 'Worth knowing'}>
      {notices.length > 0 && (
        <ul className="bullets">
          {notices.map((notice) => (
            <li key={notice}>{notice}</li>
          ))}
        </ul>
      )}

      {failures.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Content ID</th>
                <th scope="col">Where</th>
                <th scope="col">Why not</th>
              </tr>
            </thead>
            <tbody>
              {failures.map((failure: PinResult, index) => (
                <tr key={`${failure.cid}-${failure.target}-${String(index)}`}>
                  <td>
                    <Cid cid={failure.cid} label="content ID" head={10} tail={6} />
                  </td>
                  <td className="nowrap">
                    {failure.target === 'pinata' ? 'Pinata' : 'Your IPFS node'}
                  </td>
                  <td>{failure.error ?? 'No reason was given.'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {hidden > 0 && (
        <p className="small faint">
          …and {formatCount(hidden)} more. Fix the reasons above and press Pin everything again —
          anything already pinned is skipped, so a second run is cheap.
        </p>
      )}
    </Card>
  )
}

/* ========================================================================== */
/* Small helpers                                                              */
/* ========================================================================== */

/**
 * `value`, but only once it has stopped changing.
 *
 * The free-text filter runs over twenty thousand rows; doing that on every
 * keystroke would make typing feel like wading.
 */
function useDebounced<T>(value: T, delayMs: number): T {
  const [settled, setSettled] = useState(value)

  useEffect(() => {
    if (Object.is(value, settled)) return undefined
    const timer = setTimeout(() => {
      setSettled(value)
    }, Math.max(0, delayMs))
    return () => {
      clearTimeout(timer)
    }
  }, [value, delayMs, settled])

  return settled
}

/* ==========================================================================
 * Class names this file introduces, for the stylesheet:
 *
 *   .assets-actions        the two buttons in the header, side by side
 *   .assets-targets        the row of "ready / not set up" pills
 *   .assets-summary        the band of figures; wraps, most alarming first
 *   .assets-stat           one figure; a button, so it needs a resting state
 *   .assets-stat-value     the number, large
 *   .assets-stat-label     the words under it, small and muted
 *   .assets-stat-danger    red · .assets-stat-warn amber · .assets-stat-ok green
 *   .assets-stat-quiet     the size figure; not interactive
 *   .assets-filters        the filter card
 *   .assets-filter-row     the filter controls; a wrapping grid
 *   .assets-filter         one labelled control inside it
 *   .assets-select         a <select> styled like .input (needs `font: inherit`)
 *   .assets-filter-foot    the toggle + count + clear row
 *   .assets-toggle         the "show only what needs rescuing" checkbox + label
 *   .assets-selection      the "N ticked / Pin selected" strip
 *   .assets-scroll         the scroll box (height and overflow are set inline —
 *                          the virtual list depends on them, so please do not
 *                          override them)
 *   .assets-table          the table itself (fixed layout, set inline). Row
 *                          separators here must add no height: the shared
 *                          `.table` draws them with `border-bottom`, which does,
 *                          and 1px on each of 10,762 rows walks the list ten
 *                          thousand pixels out of step with its own scrollbar.
 *                          styles.css uses an inset shadow instead.
 *   .assets-sort           the button inside a sortable <th>
 *   .assets-sort-arrow     its little indicator; .is-active on the sorted one
 *   .assets-pin            a pin-state pill (sits on .pill)
 *   .assets-pin-unknown    the dash for "we did not ask" — muted, not red
 *   .assets-rescued        the small "rescued" badge on Arweave/web files
 *   .assets-note           the live one-line commentary during a run
 *   .spinner-xs            a 10px .spinner, for inside a pill
 *
 * `tr[data-rescued="yes"]` is also set, if the rescued rows deserve a tint.
 * ========================================================================== */
