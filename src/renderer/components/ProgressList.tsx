/**
 * Live progress, one row per token.
 *
 * The manual process gave a member no idea whether anything was happening until
 * it either worked or didn't. This says, in plain English, what is being done
 * right now, how far along it is, and — when something fails — what failed and
 * what they can do about it.
 *
 * Three things worth knowing:
 *
 *  • **It stays smooth with hundreds of rows.** A run of a few hundred tokens
 *    produces thousands of events. Rows are keyed by `ProgressEvent.id` and each
 *    subscribes to *only its own* updates (`useProgressRow`), so one tick
 *    re-renders one `<li>`. The panel around them re-renders only when a row
 *    appears, disappears or changes phase — never on a plain progress tick.
 *
 *  • **It hides itself when there is nothing to report**, so the strip it sits
 *    in at the foot of the window collapses with it rather than leaving an empty
 *    bar across the screen.
 *
 *  • **It is built from the shared primitives** — `Card`, `Pill`, `ProgressBar`
 *    and the layout utilities — so it looks like the rest of the window rather
 *    than a component that wandered in from somewhere else.
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react'
import type { ArchivedToken, ProgressEvent } from '../../shared/types'
import {
  failUnfinishedProgress,
  getApi,
  parseProgressId,
  progressIdFor,
  setArchiveSnapshot,
  useArchive,
  useLatestJobProgress,
  useProgress,
  useProgressRow,
  type ProgressRow,
  type TokenProgressId
} from '../hooks'
import { Pill, ProgressBar, type Tone } from './Layout'

/** The exact wording the main process uses when a member presses Stop. */
const STOPPED_MESSAGE = 'Stopped at your request.'

/**
 * How long to wait after Stop before closing rows out ourselves. A cancelled
 * token never gets a closing event of its own — the engine unwinds it without a
 * word — and a spinner that turns forever is worse than a clear "this stopped".
 */
const STOP_SETTLE_MS = 1500

/** Rows drawn before "show the rest" appears. */
const DEFAULT_MAX_VISIBLE = 300

/**
 * The compact shape is for a caller that is already showing a headline of its
 * own, so it shows the few most recent tokens and no more.
 */
const COMPACT_MAX_VISIBLE = 4

/* -------------------------------------------------------------------------- */
/* Panel                                                                      */
/* -------------------------------------------------------------------------- */

export interface ProgressListProps {
  /** Heading. Default "Progress". */
  title?: string
  /**
   * The operation Stop should halt. Left out, Stop halts everything this window
   * started — which is what a member means by it anyway.
   */
  opId?: string | null
  /**
   * Something is running. Progress events say so on their own; a caller that
   * knows a call is in flight can say so before the first event arrives.
   * `busy` is accepted as an alias.
   */
  running?: boolean
  busy?: boolean
  /** Replaces the built-in Stop behaviour. */
  onCancel?: () => void
  /** Replaces the built-in Try again, which re-archives that one token. */
  onRetry?: (token: TokenProgressId) => void
  /** Render nothing at all when there is nothing to show. Default true. */
  hideWhenEmpty?: boolean
  /** Rows drawn at once before "show the rest" appears. */
  maxVisible?: number
  /**
   * Render these events instead of subscribing, as a bare list with no heading
   * or Stop button — for a caller that already shows those itself.
   */
  events?: readonly ProgressEvent[]
  className?: string
}

export function ProgressList(props: ProgressListProps): JSX.Element | null {
  const {
    title = 'Progress',
    opId = null,
    running,
    busy: busyProp,
    onCancel,
    onRetry,
    hideWhenEmpty = true,
    maxVisible,
    events,
    className
  } = props

  const progress = useProgress()
  const job = useLatestJobProgress()
  const { tokens } = useArchive()

  const [showAll, setShowAll] = useState(false)
  const [stopping, setStopping] = useState(false)
  const stopTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const busy = (running ?? false) || (busyProp ?? false) || progress.busy

  useEffect(
    () => () => {
      if (stopTimer.current !== null) clearTimeout(stopTimer.current)
    },
    []
  )

  useEffect(() => {
    if (!busy) setStopping(false)
  }, [busy])

  /** What the archive already knows about each token, keyed by progress id. */
  const archived = useMemo(() => indexTokens(tokens), [tokens])

  const onRetryRef = useRef(onRetry)
  onRetryRef.current = onRetry

  /**
   * Re-archive one token. Resolves to a plain-English problem, or null when the
   * run started — from then on that row's own progress events take over.
   */
  const retryToken = useCallback(async (token: TokenProgressId): Promise<string | null> => {
    const custom = onRetryRef.current
    if (custom !== undefined) {
      custom(token)
      return null
    }
    const api = getApi()
    const result = await api.addTokens(
      [{ chainId: token.chainId, contract: token.contract, tokenIds: [token.tokenId] }],
      api.newOperationId()
    )
    if (result.ok) {
      setArchiveSnapshot(result.value.snapshot)
      return null
    }
    return result.error
  }, [])

  const cancel = useCallback(() => {
    if (onCancel !== undefined) {
      onCancel()
      return
    }
    setStopping(true)
    void getApi()
      .cancel(opId ?? undefined)
      .then(() => {
        if (stopTimer.current !== null) clearTimeout(stopTimer.current)
        stopTimer.current = setTimeout(() => {
          stopTimer.current = null
          failUnfinishedProgress(STOPPED_MESSAGE)
        }, STOP_SETTLE_MS)
      })
  }, [onCancel, opId])

  /** The compact shape renders exactly what it was handed, and nothing more. */
  const providedRows = useMemo(() => {
    if (events === undefined) return null
    const rows: ProgressRow[] = []
    for (const event of events) {
      const row = rowFromEvent(event)
      if (row.token !== null) rows.push(row)
    }
    return rows
  }, [events])

  if (providedRows !== null) {
    const limit = maxVisible ?? COMPACT_MAX_VISIBLE
    const shown = providedRows.length > limit ? providedRows.slice(-limit) : providedRows
    if (shown.length === 0) return null
    return (
      <ul className={classes('stack stack-sm', className)}>
        {shown.map((row) => (
          <StaticRow
            key={row.id}
            row={row}
            archived={archived.get(row.id)}
            onRetry={retryToken}
            compact
          />
        ))}
      </ul>
    )
  }

  const limit = maxVisible ?? DEFAULT_MAX_VISIBLE
  const visibleIds = chooseVisible(
    progress.tokenIds,
    [progress.activeIds, progress.failedIds],
    limit,
    showAll
  )
  const hiddenCount = progress.tokenIds.length - visibleIds.length
  const headline = job !== null && (busy || progress.tokenIds.length === 0) ? job : null

  if (hideWhenEmpty && progress.ids.length === 0 && !busy) return null

  return (
    <section className={classes('card stack', className)} aria-busy={busy}>
      <div className="row row-between">
        <div className="grow row">
          {busy ? <span className="spinner" aria-hidden="true" /> : null}
          <h2 className="card-title">{title}</h2>
          {progress.doneCount > 0 ? (
            <Pill tone="ok">{count(progress.doneCount, 'saved')}</Pill>
          ) : null}
          {progress.failedCount > 0 ? (
            <Pill tone="danger">{count(progress.failedCount, 'could not be archived')}</Pill>
          ) : null}
          {progress.activeCount > 0 ? (
            <Pill tone="info">{count(progress.activeCount, 'still going')}</Pill>
          ) : null}
        </div>

        {busy ? (
          <button type="button" className="btn btn-sm" onClick={cancel} disabled={stopping}>
            {stopping ? 'Stopping…' : 'Stop'}
          </button>
        ) : (
          <button
            type="button"
            className="btn btn-sm"
            onClick={progress.clearFinished}
            disabled={progress.ids.length === 0}
          >
            Clear finished
          </button>
        )}
      </div>

      {headline !== null ? (
        <div className="stack stack-sm" aria-live="polite">
          <span>{headline.message}</span>
          <ProgressBar value={headline.progress} label={headline.message} />
        </div>
      ) : null}

      {stopping ? (
        <p className="small muted">
          Stopping. Everything already archived is kept — nothing you have waited for is lost.
        </p>
      ) : null}

      {progress.tokenIds.length === 0 ? (
        busy ? null : <p className="small faint">Nothing has been archived in this session yet.</p>
      ) : (
        <ul className="stack stack-sm">
          {visibleIds.map((id) => (
            <LiveRow key={id} id={id} archived={archived.get(id)} onRetry={retryToken} />
          ))}
        </ul>
      )}

      {hiddenCount > 0 ? (
        <div className="row">
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => {
              setShowAll(true)
            }}
          >
            Show the other {hiddenCount.toLocaleString('en-US')}
          </button>
        </div>
      ) : null}
    </section>
  )
}

/* -------------------------------------------------------------------------- */
/* Rows                                                                       */
/* -------------------------------------------------------------------------- */

interface RowProps {
  /** What the archive knows about this token, once it has been saved. */
  archived: ArchivedToken | undefined
  onRetry: (token: TokenProgressId) => Promise<string | null>
  compact?: boolean
}

/**
 * Memoised on purpose: the panel re-renders whenever any row changes phase, and
 * without this every other row would re-render with it. Each row listens to its
 * own progress instead.
 */
const LiveRow = memo(function LiveRow(props: RowProps & { id: string }): JSX.Element | null {
  const row = useProgressRow(props.id)
  if (row === null) return null
  return (
    <StaticRow row={row} archived={props.archived} onRetry={props.onRetry} compact={props.compact} />
  )
})

const StaticRow = memo(function StaticRow(props: RowProps & { row: ProgressRow }): JSX.Element {
  const { row, archived, onRetry, compact = false } = props
  const [retrying, setRetrying] = useState(false)
  const [retryError, setRetryError] = useState<string | null>(null)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const token = row.token

  const retry = useCallback(() => {
    if (token === null) return
    setRetrying(true)
    setRetryError(null)
    void onRetry(token).then((problem) => {
      if (!mounted.current) return
      setRetrying(false)
      setRetryError(problem)
    })
  }, [onRetry, token])

  const status = statusOf(row, archived)
  const problems =
    status === 'failed' || status === 'saved-with-problems' ? (archived?.errors ?? []) : []
  const showRetry =
    !compact && token !== null && (status === 'failed' || status === 'saved-with-problems')

  return (
    <li className="card card-quiet stack stack-sm progress-row" data-phase={row.phase}>
      <div className="row row-between">
        <span className="grow nowrap">
          <strong title={titleOf(row, archived)}>{nameOf(row, archived)}</strong>
          {token !== null && archived !== undefined ? (
            <span className="small faint tabular"> #{token.tokenId}</span>
          ) : null}
        </span>
        <Pill tone={TONES[status]}>{PILL_TEXT[status]}</Pill>
      </div>

      <p className="small muted">{row.message}</p>

      {row.detail !== null && !row.finished && !compact ? (
        <p className="activity-detail" title={row.detail}>
          {row.detail}
        </p>
      ) : null}

      {!row.finished ? <ProgressBar value={row.progress} label={row.message} /> : null}

      {problems.length > 0 && !compact ? (
        <ul className="bullets small">
          {problems.map((problem, index) => (
            <li key={`${row.id}-problem-${String(index)}`}>{problem}</li>
          ))}
        </ul>
      ) : null}

      {retryError !== null ? <p className="small">{retryError}</p> : null}

      {showRetry ? (
        <div className="row">
          <button type="button" className="btn btn-sm" onClick={retry} disabled={retrying}>
            {retrying ? 'Trying again…' : 'Try again'}
          </button>
        </div>
      ) : null}
    </li>
  )
})

/* -------------------------------------------------------------------------- */
/* Bits                                                                       */
/* -------------------------------------------------------------------------- */

type RowStatus = 'working' | 'saved' | 'saved-with-problems' | 'failed'

const TONES: Record<RowStatus, Tone> = {
  working: 'info',
  saved: 'ok',
  'saved-with-problems': 'warn',
  failed: 'danger'
}

const PILL_TEXT: Record<RowStatus, string> = {
  working: 'Working',
  saved: 'Saved',
  'saved-with-problems': 'Saved, with problems',
  failed: 'Could not archive'
}

function statusOf(row: ProgressRow, archived: ArchivedToken | undefined): RowStatus {
  if (row.phase === 'error') return 'failed'
  if (row.phase !== 'done') return 'working'
  if (archived?.status === 'partial') return 'saved-with-problems'
  if (archived?.status === 'failed') return 'failed'
  return 'saved'
}

function nameOf(row: ProgressRow, archived: ArchivedToken | undefined): string {
  const name = archived?.name.trim()
  if (name !== undefined && name !== '') return name
  if (row.token !== null) return `Token #${row.token.tokenId}`
  return row.message
}

function titleOf(row: ProgressRow, archived: ArchivedToken | undefined): string {
  if (row.token === null) return row.message
  const parts = [`Token ${row.token.tokenId}`, `Contract ${row.token.contract}`]
  if (archived !== undefined) parts.push(`Saved as "${archived.folderName}"`)
  return parts.join('\n')
}

function rowFromEvent(event: ProgressEvent): ProgressRow {
  const id = typeof event.id === 'string' && event.id !== '' ? event.id : 'unknown'
  const finished = event.phase === 'done' || event.phase === 'error'
  return {
    id,
    token: parseProgressId(id),
    phase: event.phase,
    message: typeof event.message === 'string' ? event.message : '',
    progress:
      typeof event.progress === 'number' && Number.isFinite(event.progress)
        ? Math.min(1, Math.max(0, event.progress))
        : event.phase === 'done'
          ? 1
          : null,
    detail: typeof event.detail === 'string' && event.detail !== '' ? event.detail : null,
    startedAt: 0,
    updatedAt: 0,
    finished,
    failed: event.phase === 'error'
  }
}

function count(value: number, what: string): string {
  return `${value.toLocaleString('en-US')} ${what}`
}

/** Index the manifest by the progress id the engine uses for each token. */
function indexTokens(tokens: readonly ArchivedToken[]): Map<string, ArchivedToken> {
  const index = new Map<string, ArchivedToken>()
  for (const token of tokens) {
    if (token.ref === undefined) continue
    index.set(progressIdFor(token.ref), token)
  }
  return index
}

/**
 * Which rows to draw. Everything, until there are more than `limit` — then the
 * most recent `limit`, plus every row still working or in trouble, because
 * those are the ones a member needs to see.
 */
function chooseVisible(
  ids: readonly string[],
  always: ReadonlyArray<readonly string[]>,
  limit: number,
  showAll: boolean
): string[] {
  if (showAll || ids.length <= limit) return [...ids]
  const keep = new Set(ids.slice(-limit))
  for (const group of always) for (const id of group) keep.add(id)
  return ids.filter((id) => keep.has(id))
}

function classes(...parts: Array<string | undefined>): string {
  return parts.filter((part): part is string => part !== undefined && part !== '').join(' ')
}

export default ProgressList
