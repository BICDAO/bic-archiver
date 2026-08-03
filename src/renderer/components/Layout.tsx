/**
 * The design system: the small set of visual primitives every screen is built
 * from, the words this app uses for technical things, and the hook that drives
 * a long-running job.
 *
 * Every component here pairs with a class in `styles.css`, and both halves of
 * the window use them — which is what stops "at risk" being amber on one screen
 * and orange on another.
 *
 * Nothing in here talks to the archive engine except `useOperation`, which is
 * the one place that knows how a job is started, watched and stopped. Keeping
 * that in a single hook lets each view say "run this and tell the member what
 * happened" in three lines instead of thirty, and guarantees that pressing Stop
 * looks and behaves identically everywhere.
 */

import {
  Component,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react'

import type { AssetSource, ProgressEvent } from '../../shared/types'
import type { IpcResult } from '../../preload'

/* ========================================================================== */
/* Formatting                                                                 */
/* ========================================================================== */

export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1024) return `${bytes} bytes`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit] ?? 'TB'}`
}

export function formatCount(value: number): string {
  return value.toLocaleString('en-US')
}

/** "3 Aug 2026, 14:05" — never a bare ISO string in front of a member. */
export function formatWhen(iso: string | undefined): string {
  if (iso === undefined || iso === '') return 'unknown'
  const when = new Date(iso)
  if (Number.isNaN(when.getTime())) return 'unknown'
  return when.toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
}

/** `https://trustless-gateway.link` → `trustless-gateway.link`. */
export function gatewayHost(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url.replace(/^https?:\/\//, '').replace(/\/+$/, '')
  }
}

/** Where a file came from, said in words rather than protocol names. */
export function describeSource(source: AssetSource): string {
  switch (source) {
    case 'ipfs':
      return 'IPFS'
    case 'arweave':
      return 'Arweave'
    case 'http':
      return 'A website'
    case 'onchain':
      return 'The blockchain itself'
    case 'local':
      return 'This computer'
    default:
      return 'Unknown'
  }
}

/**
 * Metadata field names as a member would say them. Anything unrecognised is
 * tidied rather than hidden — a collection can invent its own field, and
 * "Background music" is still better than dropping the row.
 */
const ROLE_LABELS: Record<string, string> = {
  metadata: 'Description file',
  image: 'Picture',
  image_url: 'Picture',
  image_original: 'Picture (original)',
  image_data: 'Picture (drawn on the blockchain)',
  animation: 'Animation or video',
  animation_url: 'Animation or video',
  external_url: 'Linked page',
  audio: 'Audio',
  audio_url: 'Audio',
  media: 'Media file',
  youtube_url: 'Video link'
}

export function roleLabel(role: string): string {
  const known = ROLE_LABELS[role]
  if (known !== undefined) return known
  const words = role.replace(/[_-]+/g, ' ').trim()
  if (words === '') return 'File'
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/* ========================================================================== */
/* Small visual primitives                                                    */
/* ========================================================================== */

export type Tone = 'ok' | 'warn' | 'danger' | 'info' | 'neutral'

export function Pill({ tone, children }: { tone: Tone; children: ReactNode }): ReactNode {
  return (
    <span className={`pill pill-${tone}`}>
      <span className="pill-dot" aria-hidden="true" />
      {children}
    </span>
  )
}

const BANNER_ICONS: Record<Tone, string> = {
  ok: '✓',
  warn: '!',
  danger: '✕',
  info: 'i',
  neutral: '·'
}

export function Banner({
  tone,
  title,
  children,
  big = false,
  actions
}: {
  tone: Tone
  title?: string
  children?: ReactNode
  big?: boolean
  actions?: ReactNode
}): ReactNode {
  return (
    <div className={`banner banner-${tone}${big ? ' banner-big' : ''}`} role={tone === 'danger' ? 'alert' : 'status'}>
      <span className="banner-icon" aria-hidden="true">
        {BANNER_ICONS[tone]}
      </span>
      <div className="grow">
        {title !== undefined && <div className="banner-title">{title}</div>}
        {children !== undefined && <div className="banner-body">{children}</div>}
        {actions !== undefined && <div className="row" style={{ marginTop: 10 }}>{actions}</div>}
      </div>
    </div>
  )
}

export function ViewHeader({
  title,
  lead,
  actions
}: {
  title: string
  lead?: ReactNode
  actions?: ReactNode
}): ReactNode {
  return (
    <header className="view-header">
      <div className="grow">
        <h1 className="view-title">{title}</h1>
        {lead !== undefined && <p className="view-lead">{lead}</p>}
      </div>
      {actions !== undefined && <div className="view-actions">{actions}</div>}
    </header>
  )
}

export function Card({
  title,
  lead,
  actions,
  children
}: {
  title?: string
  lead?: ReactNode
  actions?: ReactNode
  children?: ReactNode
}): ReactNode {
  return (
    <section className="card stack">
      {(title !== undefined || actions !== undefined) && (
        <div className="row row-between">
          <div className="grow">
            {title !== undefined && <h2 className="card-title">{title}</h2>}
            {lead !== undefined && <p className="card-lead">{lead}</p>}
          </div>
          {actions !== undefined && <div className="row">{actions}</div>}
        </div>
      )}
      {title === undefined && lead !== undefined && <p className="card-lead">{lead}</p>}
      {children}
    </section>
  )
}

export function EmptyState({
  title,
  children,
  action
}: {
  title: string
  children?: ReactNode
  action?: ReactNode
}): ReactNode {
  return (
    <div className="empty">
      <p className="empty-title">{title}</p>
      {children !== undefined && <p className="empty-body">{children}</p>}
      {action}
    </div>
  )
}

export function ProgressBar({ value, label }: { value: number | null; label: string }): ReactNode {
  const known = value !== null && Number.isFinite(value)
  const percent = known ? Math.round(Math.min(1, Math.max(0, value)) * 100) : 0
  return (
    <div
      className={`progress${known ? '' : ' progress-indeterminate'}`}
      role="progressbar"
      aria-label={label}
      {...(known ? { 'aria-valuenow': percent, 'aria-valuemin': 0, 'aria-valuemax': 100 } : {})}
    >
      <div className="progress-fill" style={known ? { width: `${percent}%` } : undefined} />
    </div>
  )
}

/* ========================================================================== */
/* Running a job                                                              */
/* ========================================================================== */

/** The exact wording the main process uses when a member presses Stop. */
const CANCELLED_PREFIX = 'Stopped at your request.'

export function isCancellation(message: string | null): boolean {
  return message !== null && message.startsWith(CANCELLED_PREFIX)
}

export interface OperationState {
  /** True from the moment the job starts until it resolves. */
  busy: boolean
  /** The latest plain-English line the engine sent. */
  message: string
  /** Supporting text — a path, a content ID, a piece count. */
  detail: string
  /** 0–1 when the engine knows, null while it does not. */
  progress: number | null
  /** A finished sentence, safe to show as-is. Null when nothing has failed. */
  error: string | null
  /** A finished sentence describing what succeeded. */
  success: string | null
}

export interface RunRequest<T> {
  /** What to say the instant the button is pressed, before the engine replies. */
  start: string
  /** The `window.api` call. The operation id must be passed straight through. */
  body: (opId: string) => Promise<IpcResult<T>>
  /** Turns the result into the sentence shown on success. */
  success?: (value: T) => string
}

export interface Operation extends OperationState {
  /** Resolves to the value on success, or null when it failed or was stopped. */
  run: <T>(request: RunRequest<T>) => Promise<T | null>
  /** Ask the engine to stop this job — and only this job. */
  cancel: () => void
  /** Clear the last result so the banner goes away. */
  reset: () => void
  /** Report a problem this view found before it called the engine. */
  fail: (message: string) => void
}

const IDLE: OperationState = {
  busy: false,
  message: '',
  detail: '',
  progress: null,
  error: null,
  success: null
}

/**
 * One long-running job, from the button press to the banner.
 *
 * Every job gets its own operation id, which does three things: the engine
 * streams progress tagged with it, Stop can name exactly which job to end, and
 * two views running at once never show each other's messages.
 */
export function useOperation(): Operation {
  const [state, setState] = useState<OperationState>(IDLE)
  const opIdRef = useRef<string | null>(null)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  useEffect(
    () =>
      window.api.onProgress((event: ProgressEvent) => {
        if (opIdRef.current === null || event.id !== opIdRef.current) return
        setState((previous) => {
          if (!previous.busy) return previous
          return {
            ...previous,
            message: event.message !== '' ? event.message : previous.message,
            detail: event.detail ?? '',
            progress: typeof event.progress === 'number' ? event.progress : previous.progress
          }
        })
      }),
    []
  )

  const run = useCallback(async <T,>(request: RunRequest<T>): Promise<T | null> => {
    // Two clicks on the same button must not start two jobs — the engine would
    // refuse the second one anyway, and the member would see an error for
    // something they did not do wrong.
    if (opIdRef.current !== null) return null

    const opId = window.api.newOperationId()
    opIdRef.current = opId
    setState({ ...IDLE, busy: true, message: request.start })

    try {
      const result = await request.body(opId)
      if (!mountedRef.current) return result.ok ? result.value : null

      if (result.ok) {
        setState({
          ...IDLE,
          progress: 1,
          success: request.success !== undefined ? request.success(result.value) : 'Done.'
        })
        return result.value
      }

      setState({ ...IDLE, error: result.error })
      return null
    } catch {
      // `window.api` is contracted never to reject, but a view should not go
      // blank if that contract is ever broken.
      if (mountedRef.current) {
        setState({
          ...IDLE,
          error: 'Something went wrong inside the app. Please try that again.'
        })
      }
      return null
    } finally {
      opIdRef.current = null
    }
  }, [])

  const cancel = useCallback(() => {
    const opId = opIdRef.current
    if (opId === null) return
    setState((previous) => ({ ...previous, message: 'Stopping…' }))
    void window.api.cancel(opId)
  }, [])

  const reset = useCallback(() => {
    setState((previous) => (previous.busy ? previous : IDLE))
  }, [])

  const fail = useCallback((message: string) => {
    setState({ ...IDLE, error: message })
  }, [])

  return useMemo(
    () => ({ ...state, run, cancel, reset, fail }),
    [state, run, cancel, reset, fail]
  )
}

/**
 * The standard read-out for a job: what is happening now, or what happened.
 * `children` are extra actions shown alongside a success — "Show in folder",
 * typically.
 */
export function OperationStatus({
  op,
  stopLabel = 'Stop',
  children
}: {
  op: Operation
  stopLabel?: string
  children?: ReactNode
}): ReactNode {
  if (op.busy) {
    return (
      <div className="stack stack-sm" aria-live="polite">
        <div className="row">
          <span className="spinner" aria-hidden="true" />
          <span className="grow">{op.message}</span>
          <button type="button" className="btn btn-sm" onClick={op.cancel}>
            {stopLabel}
          </button>
        </div>
        <ProgressBar value={op.progress} label={op.message} />
        {op.detail !== '' && <div className="activity-detail">{op.detail}</div>}
      </div>
    )
  }

  if (op.error !== null) {
    const stopped = isCancellation(op.error)
    return (
      <Banner
        tone={stopped ? 'warn' : 'danger'}
        title={stopped ? 'Stopped' : 'That did not work'}
        actions={
          <button type="button" className="btn btn-sm" onClick={op.reset}>
            Dismiss
          </button>
        }
      >
        {op.error}
      </Banner>
    )
  }

  if (op.success !== null) {
    return (
      <Banner
        tone="ok"
        title="Done"
        actions={
          <>
            {children}
            <button type="button" className="btn btn-sm" onClick={op.reset}>
              Dismiss
            </button>
          </>
        }
      >
        {op.success}
      </Banner>
    )
  }

  return null
}

/* ========================================================================== */
/* Last line of defence                                                       */
/* ========================================================================== */

interface BoundaryProps {
  children: ReactNode
}

interface BoundaryState {
  failed: boolean
}

/**
 * If a component throws, React unmounts the whole tree — a member would be left
 * with a white rectangle and no idea what to do. This catches that and says
 * something useful instead. The actual error goes to the console, where a
 * developer can find it; it is never put on screen.
 */
export class ErrorBoundary extends Component<BoundaryProps, BoundaryState> {
  override state: BoundaryState = { failed: false }

  static getDerivedStateFromError(): BoundaryState {
    return { failed: true }
  }

  override componentDidCatch(error: unknown): void {
    console.error('[bic-archiver] the window hit an unexpected problem', error)
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children
    return (
      <div className="main-scroll">
        <div className="welcome">
          <div>
            <h1 className="welcome-title">The app hit an unexpected problem</h1>
            <p className="welcome-lead">
              Nothing in your archive has been lost — everything already archived is saved to disk as
              it is downloaded. Reloading the window will pick it back up.
            </p>
          </div>
          <div className="row">
            <button
              type="button"
              className="btn btn-primary btn-lg"
              onClick={() => window.location.reload()}
            >
              Reload the window
            </button>
          </div>
        </div>
      </div>
    )
  }
}
