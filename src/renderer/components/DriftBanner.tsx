/**
 * "Your copy is out of date" — and the one mirror run the whole window shares.
 *
 * BIC's archive is published at a DNSLink address, so its root changes every
 * time Rex adds to it. A member who mirrored in May and never looked again is
 * quietly serving last month's archive, and — exactly like the failure this app
 * was built to end — nothing tells them. This is the thing that tells them.
 *
 * The four verdicts are drawn deliberately differently, and the distinction
 * that matters most is between `behind` and `unknown`:
 *
 *   behind       a real problem with a real fix, so a red alert with one button.
 *   not-mirrored not a problem with their copy — they have not made one yet.
 *                That is what the big button on the welcome screen is for, and
 *                repeating it here as an alarm would train people to ignore the
 *                colour red.
 *   unknown      an admission, not an accusation: the published address could
 *                not be looked up, usually because the computer is offline. A
 *                member on a train must never be told their archive is stale, so
 *                this is one quiet grey line and nothing more.
 *   in-sync      a small green tick. Nothing else; the point of a background
 *                check is that most of the time it says nothing.
 *
 * ---------------------------------------------------------------------------
 * Why the mirror run lives in this file
 *
 * Two places can start a mirror: this banner's "Update my copy", and the big
 * button on the welcome screen. Both must be the *same* run — 1.8 GB downloaded
 * twice at once into one folder is the kind of bug a member pays for in disk and
 * bandwidth — and Stop has to work from either. So the run is a module-level
 * store, shared by every component that asks for it, and it lives here because
 * `Welcome.tsx` already imports this file; putting it there and importing it
 * back would be a circular import.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode
} from 'react'

import type { MirrorProgress, MirrorResult } from '../../shared/community'
import type { DriftStatus } from '../../shared/node'
import { getApi } from '../hooks'
import { Banner, Pill, ProgressBar, formatBytes, formatWhen } from './Layout'

/* ========================================================================== */
/* The one mirror run                                                         */
/* ========================================================================== */

/**
 * Which screen started the run.
 *
 * The run is shared, so without this both the banner and the welcome screen's
 * big card would draw a progress bar for the same 1.8 GB copy and a member would
 * be watching one job in two places. It survives the end of the run so a failure
 * is reported by whoever asked for it, and is cleared only when that report is
 * dismissed.
 */
export type MirrorOrigin = 'welcome' | 'drift'

export interface MirrorRunState {
  /** True from the moment the run starts until the engine answers. */
  busy: boolean
  /** Who asked for this run — null when none has been started. */
  origin: MirrorOrigin | null
  /** Which part of the job the engine last reported. */
  phase: MirrorProgress['phase'] | null
  /** The latest plain-English line from the engine. */
  message: string
  /** 0–1 when the engine knows, null while it does not. */
  progress: number | null
  bytesDone: number | null
  bytesTotal: number | null
  /** The last finished run. `result.ok === false` is a run that failed. */
  result: MirrorResult | null
  /** A finished plain-English sentence, or null. May be a cancellation. */
  error: string | null
  /**
   * Bumped every time a run ends, however it ended. Anything that needs to
   * re-read the world afterwards — this banner, the welcome screen's status —
   * watches this rather than trying to observe the run itself.
   */
  finishedAt: number
}

const IDLE: MirrorRunState = {
  busy: false,
  origin: null,
  phase: null,
  message: '',
  progress: null,
  bytesDone: null,
  bytesTotal: null,
  result: null,
  error: null,
  finishedAt: 0
}

let runState: MirrorRunState = IDLE
const runListeners = new Set<() => void>()

/** The operation id of the run in flight, which is what Stop needs. */
let currentOpId: string | null = null
let listening = false

function publish(next: MirrorRunState): void {
  runState = next
  // Copied first: a listener may unsubscribe while we are walking the set.
  for (const listener of [...runListeners]) listener()
}

/**
 * Attach to `mirror-progress` once and stay attached for the life of the
 * window. Detaching when the last component unmounts would mean a run started
 * from the welcome screen goes silent the moment a member navigates, and the
 * stream is a single quiet channel — there is nothing to save by letting go.
 */
function listenOnce(): void {
  if (listening) return
  listening = true
  getApi().onMirrorProgress((progress: MirrorProgress) => {
    // A late event from a run that has already finished must not restart the
    // bar behind a result the member is reading.
    if (!runState.busy) return

    // Byte counts belong to the phase that reported them. Carrying "812 MB of
    // 1.8 GB" from the download into the pinning phase would leave a bar that
    // says nothing true, so a phase change clears anything the new phase has
    // not told us.
    const samePhase = progress.phase === runState.phase

    publish({
      ...runState,
      phase: progress.phase,
      message: progress.message !== '' ? progress.message : runState.message,
      progress:
        typeof progress.progress === 'number'
          ? progress.progress
          : samePhase
            ? runState.progress
            : null,
      bytesDone:
        typeof progress.bytesDone === 'number'
          ? progress.bytesDone
          : samePhase
            ? runState.bytesDone
            : null,
      bytesTotal:
        typeof progress.bytesTotal === 'number'
          ? progress.bytesTotal
          : samePhase
            ? runState.bytesTotal
            : null
    })
  })
}

function subscribeToRun(listener: () => void): () => void {
  listenOnce()
  runListeners.add(listener)
  return () => {
    runListeners.delete(listener)
  }
}

function readRun(): MirrorRunState {
  return runState
}

function finishRun(opId: string, outcome: { result?: MirrorResult; error?: string }): void {
  // A result from a run that was already superseded is not the current story.
  if (currentOpId !== opId) return
  currentOpId = null
  publish({
    ...IDLE,
    // Kept past the end of the run: whoever started it is the screen that should
    // report how it went.
    origin: runState.origin,
    finishedAt: Date.now(),
    progress: outcome.result !== undefined ? 1 : null,
    result: outcome.result ?? null,
    error: outcome.error ?? null
  })
}

/**
 * Start copying the BIC archive, or do nothing if a copy is already running.
 *
 * No destination is passed: the engine puts the copy in a "BIC Archive Mirror"
 * folder in Downloads, which is one fewer question for a member who has been
 * promised a single click.
 */
export function startMirrorRun(origin: MirrorOrigin = 'welcome'): void {
  if (runState.busy) return
  listenOnce()

  const api = getApi()
  const opId = api.newOperationId()
  currentOpId = opId

  publish({
    ...IDLE,
    busy: true,
    origin,
    finishedAt: runState.finishedAt,
    message: 'Getting ready to copy the BIC archive…'
  })

  void api.runMirror(undefined, opId).then(
    (result) => {
      finishRun(opId, result.ok ? { result: result.value } : { error: result.error })
    },
    () => {
      // `window.api` is contracted never to reject. If that contract is ever
      // broken the bar must still stop moving.
      finishRun(opId, { error: 'Something went wrong inside the app. Please try that again.' })
    }
  )
}

/** Ask the engine to stop the run. What has downloaded already is kept. */
export function cancelMirrorRun(): void {
  const opId = currentOpId
  if (opId === null) return
  publish({ ...runState, message: 'Stopping…' })
  void getApi().cancel(opId)
}

/** Clear the last result so its banner goes away. */
export function dismissMirrorRun(): void {
  if (runState.busy) return
  publish({ ...IDLE, finishedAt: runState.finishedAt })
}

export interface MirrorRun extends MirrorRunState {
  start: (origin?: MirrorOrigin) => void
  cancel: () => void
  dismiss: () => void
}

/** The shared mirror run: same object, same progress, wherever it is read. */
export function useMirrorRun(): MirrorRun {
  const state = useSyncExternalStore(subscribeToRun, readRun, readRun)
  return useMemo(
    () => ({
      ...state,
      start: startMirrorRun,
      cancel: cancelMirrorRun,
      dismiss: dismissMirrorRun
    }),
    [state]
  )
}

/* ========================================================================== */
/* The read-out for a long job                                                */
/* ========================================================================== */

/**
 * What is happening, how far along it is, and a Stop that works.
 *
 * Shared with the welcome screen deliberately: setting a node up and copying the
 * archive are the two longest things this app does, they run back to back from
 * one button, and a member should not have to work out that two different-
 * looking panels are the same kind of wait.
 */
export function RunReadout({
  message,
  progress,
  bytesDone,
  bytesTotal,
  stopLabel = 'Stop',
  onStop
}: {
  message: string
  progress: number | null
  bytesDone: number | null
  bytesTotal: number | null
  stopLabel?: string
  onStop: () => void
}): ReactNode {
  const line = message === '' ? 'Working…' : message

  /*
   * Bytes are shown only when they say something. "0 bytes of 0 bytes" during a
   * phase that does not count bytes is worse than no line at all.
   */
  let bytes: string | null = null
  if (bytesTotal !== null && bytesTotal > 0 && bytesDone !== null) {
    bytes = `${formatBytes(bytesDone)} of ${formatBytes(bytesTotal)}`
  } else if (bytesDone !== null && bytesDone > 0) {
    bytes = `${formatBytes(bytesDone)} so far`
  }

  return (
    <div className="stack stack-sm" aria-live="polite">
      <div className="row">
        <span className="spinner" aria-hidden="true" />
        <span className="grow">{line}</span>
        <button type="button" className="btn btn-sm" onClick={onStop}>
          {stopLabel}
        </button>
      </div>
      <ProgressBar value={progress} label={line} />
      {bytes !== null && <div className="small faint tabular">{bytes}</div>}
    </div>
  )
}

/* ========================================================================== */
/* The banner                                                                 */
/* ========================================================================== */

export interface DriftBannerProps {
  /**
   * Told the verdict every time a check finishes, and `null` when the check
   * itself could not run. The welcome screen listens so its big button and this
   * banner never both offer to copy 1.8 GB.
   */
  onVerdict?: (status: DriftStatus | null) => void
}

/**
 * Checks on mount, and again after any mirror run anywhere in the window
 * finishes — including one this banner did not start, because that run is
 * exactly what changes the answer.
 */
export default function DriftBanner({ onVerdict }: DriftBannerProps): ReactNode {
  const mirror = useMirrorRun()
  const [status, setStatus] = useState<DriftStatus | null>(null)

  // Held in a ref so a parent passing an inline arrow function does not make
  // this re-check on every render.
  const onVerdictRef = useRef(onVerdict)
  onVerdictRef.current = onVerdict

  const { finishedAt } = mirror

  useEffect(() => {
    let alive = true
    void getApi()
      .checkDrift()
      .then((result) => {
        if (!alive) return
        const next = result.ok ? result.value : null
        setStatus(next)
        onVerdictRef.current?.(next)
      })
    return () => {
      alive = false
    }
  }, [finishedAt])

  const update = useCallback(() => {
    mirror.start('drift')
  }, [mirror])

  const dismiss = useCallback(() => {
    mirror.dismiss()
  }, [mirror])

  const verdict = status?.verdict ?? null
  /* Only ever this banner's own run: the welcome screen draws its own. */
  const mine = mirror.origin === 'drift'
  const running = mine && mirror.busy
  const failed = mine && !mirror.busy && mirror.error !== null

  /* ---- the red case, and the only red case ----------------------------- */
  if (verdict === 'behind') {
    return (
      <Banner tone="danger" title="Your copy is out of date">
        <div className="stack stack-sm">
          <p>{status?.detail}</p>
          {status?.lastMirroredAt !== undefined && (
            <p className="small">You last copied it on {formatWhen(status.lastMirroredAt)}.</p>
          )}

          {running ? (
            <RunReadout
              message={mirror.message}
              progress={mirror.progress}
              bytesDone={mirror.bytesDone}
              bytesTotal={mirror.bytesTotal}
              onStop={mirror.cancel}
              stopLabel="Stop"
            />
          ) : (
            <>
              {failed && <p className="small">{mirror.error}</p>}
              <div className="row">
                <button type="button" className="btn btn-primary" onClick={update}>
                  {failed ? 'Try again' : 'Update my copy'}
                </button>
                {failed && (
                  <button type="button" className="btn btn-sm" onClick={dismiss}>
                    Dismiss
                  </button>
                )}
              </div>
              <p className="small">
                Your IPFS node fetches only the parts it does not already have, so this is usually
                far quicker than the first copy.
              </p>
            </>
          )}
        </div>
      </Banner>
    )
  }

  /* ---- a run this banner started, whose verdict has since moved on ------ */
  if (running) {
    return (
      <Banner tone="info" title="Updating your copy">
        <RunReadout
          message={mirror.message}
          progress={mirror.progress}
          bytesDone={mirror.bytesDone}
          bytesTotal={mirror.bytesTotal}
          onStop={mirror.cancel}
          stopLabel="Stop"
        />
      </Banner>
    )
  }

  if (failed) {
    // Never red. An update that did not finish leaves the member exactly where
    // they were — with the copy they already had.
    return (
      <Banner
        tone="warn"
        title="That update did not finish"
        actions={
          <>
            <button type="button" className="btn btn-sm" onClick={update}>
              Try again
            </button>
            <button type="button" className="btn btn-sm" onClick={dismiss}>
              Dismiss
            </button>
          </>
        }
      >
        {mirror.error}
      </Banner>
    )
  }

  /* ---- everything else: quiet, or silent ------------------------------- */
  if (verdict === 'in-sync') {
    return (
      <div className="row">
        <Pill tone="ok">Your copy of BIC&rsquo;s archive is up to date</Pill>
        {status?.lastMirroredAt !== undefined && (
          <span className="small faint">Copied {formatWhen(status.lastMirroredAt)}</span>
        )}
      </div>
    )
  }

  if (verdict === 'unknown') {
    // One grey line. Being offline is not drift, and must never look like it.
    return <p className="small muted">{status?.detail}</p>
  }

  // 'not-mirrored', or a check that could not run at all: say nothing. Making a
  // first copy is the big button's job, not an alarm's.
  return null
}
