/**
 * Where the archive gets pinned — and why that is a different question from
 * where it is backed up.
 *
 * A .car file keeps the *bytes*. It does not keep a content ID *resolvable*. The
 * DAO's May 2026 backup proved the difference the hard way: 95% of it was still
 * being served by other people, and 428 content IDs were not — almost all of
 * them files BIC had rescued from Arweave or an ordinary website, where BIC was
 * the only party that ever pinned them. Twelve NFTs are now completely dark.
 *
 * The shape of this screen is an argument, and the argument has been settled by
 * measurement rather than taste:
 *
 *  • **The member's own node is the whole screen.** A pinning service can only
 *    fetch content somebody is still serving, so for the 428 a node of your own
 *    is not the DIY alternative — it is the only thing that can put them back on
 *    the network at all. It used to be three shell commands printed on this page
 *    and a hope that a non-technical member would run them. Now it is a button.
 *
 *  • **Pinata is demoted, not deleted.** Pinning by CID turns out to be a *paid*
 *    Pinata feature (verified live: HTTP 403, `PAID_FEATURE_ONLY`), and the free
 *    tier holds 1 GB and 500 files against an archive of 1.9 GB and 20,808. Some
 *    DAOs will pay for it and an always-on copy is genuinely worth having, so it
 *    stays — collapsed, quiet, and honest about what it costs. Presenting it as
 *    the answer would send members to a dead end.
 *
 *  • **Automatic pinning defaults to on**, and the reason is stated rather than
 *    implied. Archiving without pinning is the exact sequence of events that
 *    lost the 428.
 *
 * SECURITY — the Pinata key.
 * The key is a bearer credential: anyone holding it can unpin the DAO's content
 * or spend its quota. It is typed into an uncontrolled input, read once on
 * submit, handed straight to the main process (which puts it in the operating
 * system's keychain) and the field is wiped immediately afterwards, success or
 * failure. It is never put in React state, never in a store, never in a URL,
 * never in `localStorage` or `sessionStorage`, and it is never read back — the
 * window only ever learns the boolean `hasToken`. If the computer has nowhere
 * safe to keep it, this screen says so plainly; there is deliberately no
 * "save it in a file anyway" option.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode
} from 'react'

import {
  DEFAULT_PINNING_SETTINGS,
  type PinTargetId,
  type PinTargetStatus,
  type PinningSettings as PinningSettingsValue
} from '../../shared/pinning'
import type { UpdateCheck as UpdateCheckResult } from '../../shared/update'
/*
 * Type-only, and from `src/shared/node.ts` rather than from the preload bridge:
 * `../../preload` resolves to the preload *implementation*, which imports
 * `electron`, and only the sibling `.d.ts` re-exports these names. A `import
 * type` is erased at build time, so nothing from that module reaches the window
 * bundle — and the values in it (the download URL, the login-item label) are
 * deliberately never named here.
 */
import type { ManagedNodeStatus, NodeInstallProgress } from '../../shared/node'
import { getApi, useAsyncAction } from '../hooks'
import { Cid } from './Cid'
import { Banner, Card, Pill, ProgressBar, ViewHeader, formatBytes, type Tone } from './Layout'

/* ========================================================================== */
/* Small helpers                                                              */
/* ========================================================================== */

/** The commands that get a node running by hand, for members who prefer to. */
const KUBO_INSTALL = ['brew install kubo', 'ipfs init', 'ipfs daemon'].join('\n')

const KUBO_DOWNLOAD_URL = 'https://docs.ipfs.tech/install/command-line/'
const PINATA_KEYS_URL = 'https://app.pinata.cloud/developers/api-keys'
const PINATA_PRICING_URL = 'https://pinata.cloud/pricing'

/**
 * Phrases the main process uses when this computer has nowhere safe to keep a
 * credential. Matching on them lets this screen answer in its own words rather
 * than repeating an explanation that mentions a "paste it each session" option
 * the window does not offer.
 */
const NO_SECURE_STORAGE_MARKERS = [
  'no secure place to keep the Pinata key',
  'not offering a real password store'
]

function isSecureStorageFailure(message: string | null | undefined): boolean {
  if (message === null || message === undefined) return false
  return NO_SECURE_STORAGE_MARKERS.some((marker) => message.includes(marker))
}

function findTarget(
  targets: PinTargetStatus[] | undefined,
  id: PinTargetId
): PinTargetStatus | null {
  if (targets === undefined) return null
  return targets.find((target) => target.target === id) ?? null
}

/**
 * Copy without assuming the async clipboard is there. Same belt-and-braces as
 * `Cid.tsx`: a dead copy button here would leave a member re-typing shell
 * commands by hand, which is how a typo becomes an hour of confusion.
 */
async function copyText(value: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard !== undefined) {
      await navigator.clipboard.writeText(value)
      return true
    }
  } catch {
    // Fall through to the old way.
  }
  try {
    const holder = document.createElement('textarea')
    holder.value = value
    holder.setAttribute('readonly', '')
    holder.className = 'cid__clipboard-holder'
    document.body.appendChild(holder)
    holder.select()
    const copied = document.execCommand('copy')
    document.body.removeChild(holder)
    return copied
  } catch {
    return false
  }
}

/* ========================================================================== */
/* Building blocks                                                            */
/* ========================================================================== */

/** An address the window hands to the member's own browser. */
function ExternalLink({ url, children }: { url: string; children: ReactNode }): ReactNode {
  return (
    <button
      type="button"
      className="btn-link"
      title={`Open ${url} in your web browser`}
      onClick={() => {
        void getApi().openExternal(url)
      }}
    >
      {children}
    </button>
  )
}

/**
 * "Is this the current version?" — asked, answered, and left at that.
 *
 * Reporting rather than installing is a deliberate limit, not an unfinished
 * feature: the app is not signed, so it has no safe way to replace itself, and a
 * program that downloads and runs a new binary unprompted is the exact shape
 * this project is careful about everywhere else. The member is told what is out
 * there and given a link.
 *
 * The check never blocks anything and never nags — nothing here runs on its own,
 * because a background call to GitHub on every launch is a fingerprint of every
 * member's machine that nobody asked to leave.
 */
function UpdateCheck(): ReactNode {
  const [checking, setChecking] = useState(false)
  const [result, setResult] = useState<UpdateCheckResult | null>(null)

  const check = useCallback(async () => {
    setChecking(true)
    const answer = await getApi().checkForUpdates()
    setChecking(false)
    setResult(
      answer.ok
        ? answer.value
        : {
            current: '',
            latest: null,
            newer: false,
            summary: answer.error,
            url: 'https://github.com/devanh/bic-archiver/releases/latest'
          }
    )
  }, [])

  return (
    <Card title="This app">
      <div className="stack stack-sm">
        <div className="row">
          <button
            type="button"
            className="btn"
            onClick={() => void check()}
            disabled={checking}
          >
            {checking ? 'Checking…' : 'Check for updates'}
          </button>
          {result !== null && result.newer && (
            <ExternalLink url={result.url}>Get version {result.latest}</ExternalLink>
          )}
        </div>

        {result !== null && (
          <p className={result.newer ? undefined : 'small muted'}>{result.summary}</p>
        )}

        <p className="small faint">
          Nothing is downloaded or installed by this check. It asks GitHub which version is newest
          and tells you; fetching it is your decision, and you do it in your browser.
        </p>
      </div>
    </Card>
  )
}

/** Commands to run in Terminal, with a button so nobody has to re-type them. */
function CommandBlock({ commands, label }: { commands: string; label: string }): ReactNode {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current)
    },
    []
  )

  const copy = useCallback(() => {
    void copyText(commands).then((ok) => {
      setState(ok ? 'copied' : 'failed')
      if (timer.current !== null) clearTimeout(timer.current)
      timer.current = setTimeout(() => {
        timer.current = null
        setState('idle')
      }, 1600)
    })
  }, [commands])

  return (
    <div className="codeblock">
      <pre className="codeblock__code" aria-label={label}>
        {commands}
      </pre>
      <div className="codeblock__foot">
        <button type="button" className="btn btn-sm" onClick={copy}>
          Copy these commands
        </button>
        <span className="small faint" role="status" aria-live="polite">
          {state === 'copied'
            ? 'Copied — paste them into Terminal.'
            : state === 'failed'
              ? 'Copying did not work. Select the text above and copy it.'
              : ''}
        </span>
      </div>
    </div>
  )
}

/** A labelled on/off switch. The whole row is the control. */
function Toggle({
  checked,
  onChange,
  label,
  hint,
  disabled = false
}: {
  checked: boolean
  onChange: (next: boolean) => void
  label: string
  hint?: ReactNode
  disabled?: boolean
}): ReactNode {
  return (
    <label className="switch">
      <input
        type="checkbox"
        className="switch__input"
        checked={checked}
        disabled={disabled}
        onChange={(event) => {
          onChange(event.target.checked)
        }}
      />
      <span className="switch__track" aria-hidden="true">
        <span className="switch__thumb" />
      </span>
      <span className="switch__text">
        <span className="switch__label">{label}</span>
        {hint !== undefined && <span className="switch__hint">{hint}</span>}
      </span>
    </label>
  )
}

/**
 * A section a member opens only if they want it. Native `<details>` so it works
 * with the keyboard, with a screen reader and with find-in-page for free —
 * find-in-page in particular, because a member searching for "Pinata" should
 * land on it even though it starts closed.
 */
function Disclosure({
  summary,
  note,
  children,
  quiet = false
}: {
  summary: string
  note?: ReactNode
  children: ReactNode
  quiet?: boolean
}): ReactNode {
  return (
    <details className={`disclosure${quiet ? ' disclosure--quiet' : ''}`}>
      <summary className="disclosure__summary">
        <span className="disclosure__caret" aria-hidden="true">
          ›
        </span>
        <span className="disclosure__text">
          <span className="disclosure__title">{summary}</span>
          {note !== undefined && <span className="disclosure__note">{note}</span>}
        </span>
      </summary>
      <div className="disclosure__body stack">{children}</div>
    </details>
  )
}

/* ========================================================================== */
/* Your IPFS node                                                             */
/* ========================================================================== */

/** What the member sees while the node is being set up, in their words. */
const PHASE_LABELS: Record<NodeInstallProgress['phase'], string> = {
  checking: 'Looking at what is already on this computer',
  downloading: 'Downloading the IPFS software',
  verifying: 'Checking the download is genuine',
  extracting: 'Unpacking it',
  initialising: 'Setting it up',
  configuring: 'Configuring it',
  starting: 'Starting it',
  autostart: 'Arranging for it to start when you log in',
  done: 'Finished',
  error: 'Something went wrong'
}

interface Headline {
  tone: Tone
  title: string
  body: string
}

/**
 * The one sentence at the top of the node card. Never a state name: `external`
 * and `installed-stopped` mean nothing to a member, but "you already have one"
 * and "it is installed but not running" tell them exactly where they stand.
 */
function describeNode(status: ManagedNodeStatus | null, checked: boolean): Headline {
  if (status === null) {
    return checked
      ? {
          tone: 'neutral',
          title: 'This computer could not be checked',
          body: 'The app could not find out whether you have an IPFS node. Nothing is broken by this — try the Check again button.'
        }
      : {
          tone: 'neutral',
          title: 'Looking at this computer…',
          body: 'Checking whether you already have an IPFS node running.'
        }
  }

  if (status.state === 'external') {
    return {
      tone: 'ok',
      title: 'You already have your own IPFS node',
      body: 'This app did not set it up, so it will never change, stop or remove it — it just uses it to keep the archive online. Everything below is read from it.'
    }
  }

  switch (status.state) {
    case 'running':
      return {
        tone: 'ok',
        title: 'Your node is running',
        body: 'It is offering everything you have pinned to anyone on the network who asks for it. This is the state you want to be in.'
      }
    case 'starting':
      return {
        tone: 'info',
        title: 'Your node is starting…',
        body: 'This usually takes a few seconds.'
      }
    case 'installing':
      return {
        tone: 'info',
        title: 'Setting your node up…',
        body: 'There is a download and a few minutes of set-up. You can keep using the rest of the app.'
      }
    case 'installed-stopped':
      return {
        tone: 'warn',
        title: 'Your node is installed, but it is not running',
        body: 'While it is stopped this computer is not offering anything to anyone. Anything you pinned is still safely on your disk.'
      }
    case 'error':
      return {
        tone: 'danger',
        title: 'Your node has a problem',
        body: status.detail ?? 'The app could not get the node working, and did not say why.'
      }
    case 'not-installed':
    default:
      return {
        tone: 'warn',
        title: 'You are not running a node yet',
        body: 'Nothing on this computer is offering the archive to other people. Setting one up takes one button and no typing — the app downloads the official IPFS software, checks it is genuine, and starts it for you.'
      }
  }
}

/**
 * The primary section: this member's own IPFS node.
 *
 * `children` is the advanced pin-target block, rendered at the foot of the same
 * card. It lives with the parent because it is a *settings* concern (which
 * address this app sends pins to) rather than a node-lifecycle one, but it
 * belongs on screen here, under the node it is about.
 */
function NodeSection({
  pinsEnabled,
  onEnablePins,
  onSettingsChanged,
  enablingPins,
  children
}: {
  /** Whether this app is currently configured to send pins to the node. */
  pinsEnabled: boolean
  onEnablePins: () => void
  /** Installing rewrites the saved node address — re-read the settings. */
  onSettingsChanged: () => void
  enablingPins: boolean
  children?: ReactNode
}): ReactNode {
  const [status, setStatus] = useState<ManagedNodeStatus | null>(null)
  const [checked, setChecked] = useState(false)
  const [statusError, setStatusError] = useState<string | null>(null)
  const [progress, setProgress] = useState<NodeInstallProgress | null>(null)
  const [confirmRemove, setConfirmRemove] = useState(false)

  const alive = useRef(true)
  const installOpId = useRef<string | null>(null)

  const install = useAsyncAction((opId: string) => getApi().installNode(opId))
  const start = useAsyncAction(() => getApi().startNode())
  const stop = useAsyncAction(() => getApi().stopNode())
  const remove = useAsyncAction(() => getApi().uninstallNode())
  const autostart = useAsyncAction((enabled: boolean) => getApi().setAutostart(enabled))

  const busy =
    install.pending || start.pending || stop.pending || remove.pending || autostart.pending

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  /* ---------------------------------------------------------------------- */
  /* Reading the node's state                                                */
  /* ---------------------------------------------------------------------- */

  const loadStatus = useCallback(async (): Promise<void> => {
    const result = await getApi().nodeStatus()
    if (!alive.current) return
    if (result.ok) {
      setStatus(result.value)
      setStatusError(null)
    } else {
      setStatusError(result.error)
    }
    setChecked(true)
  }, [])

  useEffect(() => {
    void loadStatus()
  }, [loadStatus])

  /*
   * Re-read every so often. `node:status` is cheap and read-only, and the things
   * it reports do move on their own: the disk figure grows while a mirror runs,
   * and a node that crashed is otherwise reported as running until the member
   * happens to reopen this screen. Skipped while the window is in the background
   * and while any node action is in flight, so a poll can never land on top of
   * the answer an action just gave us.
   */
  useEffect(() => {
    const timer = setInterval(() => {
      if (busy) return
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return
      void loadStatus()
    }, 20_000)
    return () => {
      clearInterval(timer)
    }
  }, [busy, loadStatus])

  /* ---------------------------------------------------------------------- */
  /* Setting one up                                                          */
  /* ---------------------------------------------------------------------- */

  useEffect(() => getApi().onNodeProgress(setProgress), [])

  const runInstall = useCallback(async (): Promise<void> => {
    const opId = getApi().newOperationId()
    installOpId.current = opId
    setConfirmRemove(false)
    setProgress({ phase: 'checking', message: 'Getting ready…' })
    remove.reset()
    stop.reset()

    const value = await install.run(opId)
    installOpId.current = null
    if (!alive.current) return
    setProgress(null)

    if (value === undefined) {
      // Failed or stopped. Ask the node itself where things stand rather than
      // guessing — a cancelled install leaves nothing running, but a failure
      // part-way through may have left a usable node behind.
      await loadStatus()
      return
    }
    setStatus(value)
    setChecked(true)
    // Installing writes the node's address into the settings file and switches
    // the node on as a pin target, so the form above is now stale.
    onSettingsChanged()
  }, [install, loadStatus, onSettingsChanged, remove, stop])

  const cancelInstall = useCallback(() => {
    const opId = installOpId.current
    if (opId === null) return
    void getApi().cancel(opId)
  }, [])

  /* ---------------------------------------------------------------------- */
  /* Start, stop, autostart, remove                                          */
  /* ---------------------------------------------------------------------- */

  const applyResult = useCallback(
    (value: ManagedNodeStatus | undefined): void => {
      if (!alive.current) return
      if (value === undefined) {
        void loadStatus()
        return
      }
      setStatus(value)
      setChecked(true)
      onSettingsChanged()
    },
    [loadStatus, onSettingsChanged]
  )

  const runStart = useCallback(async (): Promise<void> => {
    stop.reset()
    applyResult(await start.run())
  }, [applyResult, start, stop])

  const runStop = useCallback(async (): Promise<void> => {
    start.reset()
    applyResult(await stop.run())
  }, [applyResult, start, stop])

  const runAutostart = useCallback(
    async (enabled: boolean): Promise<void> => {
      applyResult(await autostart.run(enabled))
    },
    [applyResult, autostart]
  )

  const runRemove = useCallback(async (): Promise<void> => {
    setConfirmRemove(false)
    applyResult(await remove.run())
  }, [applyResult, remove])

  /* ---------------------------------------------------------------------- */
  /* Render                                                                  */
  /* ---------------------------------------------------------------------- */

  const headline = describeNode(status, checked)
  const managed = status !== null && status.managed
  const external = status !== null && status.state === 'external'
  const installed =
    status !== null && status.state !== 'not-installed' && status.state !== 'installing'
  const running = status !== null && (status.state === 'running' || status.state === 'external')
  const installing = install.pending || (status !== null && status.state === 'installing')
  const needsSetUp = status !== null && status.state === 'not-installed' && !installing

  const addresses = status?.multiaddrs ?? []
  const relayOnly = addresses.length > 0 && addresses.every((addr) => addr.includes('p2p-circuit'))

  const actionError = start.error ?? stop.error ?? remove.error ?? autostart.error

  return (
    <Card>
      <div className="node">
        <div className="row row-between node__head">
          <div className="grow">
            <h2 className="card-title">Your IPFS node</h2>
            <p className="card-lead">
              The one thing that actually keeps content alive: a small program on this computer that
              holds the files and hands them to anyone who asks. No account, no subscription, and
              nothing else can do its job.
            </p>
          </div>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => {
              void loadStatus()
            }}
            disabled={busy}
          >
            Check again
          </button>
        </div>

        <div className={`node__status node__status--${headline.tone}`} aria-live="polite">
          <p className="node__status-title">{headline.title}</p>
          <p className="node__status-body">{headline.body}</p>
          {status !== null &&
            status.detail !== undefined &&
            status.state !== 'error' &&
            status.state !== 'external' && <p className="node__status-detail">{status.detail}</p>}
        </div>

        {statusError !== null && (
          <Banner tone="warn" title="This computer could not be checked">
            {statusError}
          </Banner>
        )}

        {/* ---------------- setting one up ---------------- */}

        {needsSetUp && (
          <div className="node__cta">
            <button
              type="button"
              className="btn btn-primary btn-lg"
              onClick={() => {
                void runInstall()
              }}
              disabled={busy}
            >
              Set up my node
            </button>
            <p className="small muted node__cta-note">
              About 90 MB to download and a couple of minutes. The app only ever downloads from the
              official IPFS distribution over an encrypted connection, and checks the file&rsquo;s
              fingerprint before it runs any of it — if that check fails, the download is deleted
              and nothing is run. Roughly 2 GB of disk keeps the whole archive.
            </p>
          </div>
        )}

        {installing && (
          <div className="node__progress stack stack-sm" aria-live="polite">
            <div className="row">
              <span className="spinner" aria-hidden="true" />
              <span className="grow">
                {progress === null
                  ? 'Setting your node up…'
                  : (progress.message !== '' ? progress.message : PHASE_LABELS[progress.phase])}
              </span>
              <button type="button" className="btn btn-sm" onClick={cancelInstall}>
                Stop
              </button>
            </div>
            <ProgressBar
              value={
                progress !== null && typeof progress.progress === 'number' ? progress.progress : null
              }
              label="Setting up your IPFS node"
            />
            <p className="small faint">
              {progress === null
                ? 'Starting…'
                : progress.bytesTotal !== undefined && progress.bytesDone !== undefined
                  ? `${PHASE_LABELS[progress.phase]} — ${formatBytes(progress.bytesDone)} of ${formatBytes(progress.bytesTotal)}`
                  : PHASE_LABELS[progress.phase]}
            </p>
            <p className="small muted">
              Stopping is safe at any point. Nothing is left running, and setting it up again picks
              up where this left off.
            </p>
          </div>
        )}

        {install.error !== null && !installing && (
          <Banner
            tone="danger"
            title="Your node could not be set up"
            actions={
              <>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => {
                    void runInstall()
                  }}
                  disabled={busy}
                >
                  Try again
                </button>
                <button type="button" className="btn btn-sm" onClick={install.reset}>
                  Dismiss
                </button>
              </>
            }
          >
            {install.error} Nothing has been left running, and you can set it up by hand instead —
            the commands are at the foot of this section.
          </Banner>
        )}

        {/* ---------------- what the node is ---------------- */}

        {status !== null && installed && (
          <dl className="kv node__facts">
            <dt>Its name on the network</dt>
            <dd>
              {status.peerId === undefined || status.peerId === '' ? (
                <span className="faint">Not known yet — it appears once the node has started.</span>
              ) : (
                <Cid value={status.peerId} label="peer ID of your IPFS node" head={12} tail={6} />
              )}
            </dd>

            <dt>Disk used</dt>
            <dd>
              {status.repoSizeBytes === undefined ? (
                <span className="faint">Not known yet.</span>
              ) : (
                <>
                  <span className="tabular">{formatBytes(status.repoSizeBytes)}</span>
                  {status.storageMaxBytes !== undefined && (
                    <span className="muted">
                      {' '}
                      of {formatBytes(status.storageMaxBytes)} it is allowed
                    </span>
                  )}
                </>
              )}
              {status.repoPath !== undefined && (
                <div className="small faint node__path">{status.repoPath}</div>
              )}
            </dd>

            {status.version !== undefined && (
              <>
                <dt>Version</dt>
                <dd className="tabular">{status.version}</dd>
              </>
            )}

            <dt>Address this app uses</dt>
            <dd className="addr">{status.apiUrl}</dd>
          </dl>
        )}

        {relayOnly && (
          <p className="small muted node__relay">
            Every address your node has is a relay address, which means your home router has not let
            it accept connections directly. It still works and it still serves the archive — other
            people reach it through a relay computer in the middle — but that is slower than a
            direct connection, so sharing may feel sluggish. There is nothing you need to fix.
          </p>
        )}

        {/* ---------------- switched on as a pin target? ---------------- */}

        {running && !pinsEnabled && (
          <Banner
            tone="warn"
            title="Your node is running, but this app is not using it"
            actions={
              <button
                type="button"
                className="btn btn-sm btn-primary"
                onClick={onEnablePins}
                disabled={enablingPins}
              >
                {enablingPins ? 'Switching on…' : 'Send pins to my node'}
              </button>
            }
          >
            Content you archive will be saved to disk but not handed to the node, so this computer
            will not offer it to anyone.
          </Banner>
        )}

        {/* ---------------- controls ---------------- */}

        {managed && installed && (
          <div className="node__controls stack">
            <Toggle
              checked={status !== null && status.autostart}
              disabled={autostart.pending || busy}
              onChange={(next) => {
                void runAutostart(next)
              }}
              label="Keep running when I close the app"
              hint="Starts your node when you log in and keeps it going in the background. Worth leaving on: a node that only runs while this window is open stops serving the archive the first time you shut your laptop, and nothing tells you it has."
            />

            <div className="row">
              {status !== null && status.state === 'running' ? (
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    void runStop()
                  }}
                  disabled={busy}
                >
                  {stop.pending ? 'Stopping…' : 'Stop the node'}
                </button>
              ) : (
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => {
                    void runStart()
                  }}
                  disabled={busy}
                >
                  {start.pending ? 'Starting…' : 'Start the node'}
                </button>
              )}

              {!confirmRemove && (
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  onClick={() => {
                    setConfirmRemove(true)
                  }}
                  disabled={busy}
                >
                  Remove the node program
                </button>
              )}
            </div>

            {confirmRemove && (
              <Banner
                tone="warn"
                title="Remove the node program?"
                actions={
                  <>
                    <button
                      type="button"
                      className="btn btn-sm btn-danger"
                      onClick={() => {
                        void runRemove()
                      }}
                      disabled={busy}
                    >
                      {remove.pending ? 'Removing…' : 'Yes, remove it'}
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => {
                        setConfirmRemove(false)
                      }}
                    >
                      Keep it
                    </button>
                  </>
                }
              >
                This removes the IPFS program and stops this computer offering anything to other
                members. <strong>Your archive is not touched</strong> — the files stay exactly where
                they are, and you can set the node up again at any time.
              </Banner>
            )}
          </div>
        )}

        {external && (
          <p className="small muted">
            Because you set this node up yourself, the app offers no start, stop or remove buttons
            for it — those are yours to run, in whatever way you normally do. Nothing here will
            change its configuration.
          </p>
        )}

        {actionError !== null && (
          <Banner tone="danger" title="That did not work">
            {actionError}
          </Banner>
        )}

        {/* ---------------- the long way round ---------------- */}

        <Disclosure
          summary="Set a node up by hand instead"
          note="For members who would rather use Terminal, or when the button above will not work"
          quiet
        >
          <CommandBlock commands={KUBO_INSTALL} label="Commands to install and start an IPFS node" />
          <p className="small muted">
            Run them in Terminal, one at a time. The last one keeps running — leave that window open
            while you pin. On Windows or Linux, download Kubo from{' '}
            <ExternalLink url={KUBO_DOWNLOAD_URL}>the IPFS install guide</ExternalLink> and then run{' '}
            <code className="code-inline">ipfs init</code> and{' '}
            <code className="code-inline">ipfs daemon</code>. A node you install this way is yours:
            the app will find it and use it, and will never touch it.
          </p>
        </Disclosure>

        {children}
      </div>
    </Card>
  )
}

/* ========================================================================== */
/* The view                                                                   */
/* ========================================================================== */

/** The fields this screen can change. Everything is optional in a patch. */
interface Draft {
  kuboEnabled: boolean
  kuboUrl: string
  pinataEnabled: boolean
  gateway: string
  pinOnImport: boolean
}

export default function PinningSettings(): ReactNode {
  /*
   * The form is held as separate fields rather than one settings object so a
   * save that lands while somebody is still typing cannot overwrite the box
   * under their cursor. Only the booleans and `hasToken` are taken from the
   * engine's reply; the two address fields are seeded once, on load.
   */
  const [kuboEnabled, setKuboEnabled] = useState(DEFAULT_PINNING_SETTINGS.kubo.enabled)
  const [kuboUrl, setKuboUrl] = useState(DEFAULT_PINNING_SETTINGS.kubo.apiUrl)
  const [pinataEnabled, setPinataEnabled] = useState(DEFAULT_PINNING_SETTINGS.pinata.enabled)
  const [gateway, setGateway] = useState('')
  const [pinOnImport, setPinOnImport] = useState(DEFAULT_PINNING_SETTINGS.pinOnImport)
  const [hasToken, setHasToken] = useState(false)

  const [loaded, setLoaded] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [tokenNotice, setTokenNotice] = useState<string | null>(null)

  const save = useAsyncAction((next: PinningSettingsValue) => getApi().saveSettings(next))
  const kuboProbe = useAsyncAction(() => getApi().pinTargets())
  const pinataProbe = useAsyncAction(() => getApi().pinTargets())
  const tokenSave = useAsyncAction((token: string) => getApi().setPinataToken(token))
  const tokenClear = useAsyncAction(() => getApi().clearPinataToken())

  /*
   * Uncontrolled on purpose. A controlled input would put the Pinata key into
   * React state on every keystroke, where it would sit until the component
   * re-rendered it away — and into any snapshot a dev tool or crash reporter
   * took in the meantime. This way the only copy is the DOM node's own value,
   * which is wiped the moment the key has been handed over.
   */
  const tokenField = useRef<HTMLInputElement | null>(null)
  const [tokenEntered, setTokenEntered] = useState(false)

  /* ---------------------------------------------------------------------- */
  /* Reading and writing the settings                                        */
  /* ---------------------------------------------------------------------- */

  const apply = useCallback((value: PinningSettingsValue, seedFields: boolean): void => {
    setKuboEnabled(value.kubo.enabled)
    setPinataEnabled(value.pinata.enabled)
    setPinOnImport(value.pinOnImport)
    setHasToken(value.pinata.hasToken)
    if (seedFields) {
      setKuboUrl(value.kubo.apiUrl)
      setGateway(value.pinata.gateway ?? '')
    }
  }, [])

  const reloadSettings = useCallback((): void => {
    void getApi()
      .getSettings()
      .then((result) => {
        if (result.ok) apply(result.value, true)
      })
  }, [apply])

  useEffect(() => {
    let alive = true
    void getApi()
      .getSettings()
      .then((result) => {
        if (!alive) return
        if (result.ok) apply(result.value, true)
        else setLoadError(result.error)
        setLoaded(true)
      })
    return () => {
      alive = false
    }
  }, [apply])

  /** Turn the form — plus whatever is being changed right now — into settings. */
  const compose = useCallback(
    (patch: Partial<Draft>): PinningSettingsValue => {
      const url = (patch.kuboUrl ?? kuboUrl).trim()
      const gatewayUrl = (patch.gateway ?? gateway).trim()
      const next: PinningSettingsValue = {
        kubo: {
          enabled: patch.kuboEnabled ?? kuboEnabled,
          apiUrl: url === '' ? DEFAULT_PINNING_SETTINGS.kubo.apiUrl : url
        },
        pinata: {
          enabled: patch.pinataEnabled ?? pinataEnabled,
          // Never sent from here — the engine recomputes it from the keychain
          // and its reply is what this screen believes.
          hasToken
        },
        pinOnImport: patch.pinOnImport ?? pinOnImport
      }
      if (gatewayUrl !== '') next.pinata.gateway = gatewayUrl
      return next
    },
    [gateway, hasToken, kuboEnabled, kuboUrl, pinOnImport, pinataEnabled]
  )

  /**
   * Change something and write it to disk.
   *
   * The switch moves first so the window feels immediate, and moves back if the
   * write fails — a control that shows "on" while the file on disk says "off"
   * is worse than a slow one.
   */
  const commit = useCallback(
    async (patch: Partial<Draft>): Promise<PinningSettingsValue | undefined> => {
      const before: Draft = { kuboEnabled, kuboUrl, pinataEnabled, gateway, pinOnImport }

      if (patch.kuboEnabled !== undefined) setKuboEnabled(patch.kuboEnabled)
      if (patch.kuboUrl !== undefined) setKuboUrl(patch.kuboUrl)
      if (patch.pinataEnabled !== undefined) setPinataEnabled(patch.pinataEnabled)
      if (patch.gateway !== undefined) setGateway(patch.gateway)
      if (patch.pinOnImport !== undefined) setPinOnImport(patch.pinOnImport)

      const result = await save.run(compose(patch))
      if (result === undefined) {
        setKuboEnabled(before.kuboEnabled)
        setKuboUrl(before.kuboUrl)
        setPinataEnabled(before.pinataEnabled)
        setGateway(before.gateway)
        setPinOnImport(before.pinOnImport)
        return undefined
      }
      apply(result, false)
      return result
    },
    [apply, compose, gateway, kuboEnabled, kuboUrl, pinOnImport, pinataEnabled, save]
  )

  const enableNodePins = useCallback(() => {
    void commit({ kuboEnabled: true })
  }, [commit])

  /** Re-read `hasToken` from the keychain's own answer. */
  const refreshHasToken = useCallback(async (): Promise<void> => {
    const result = await getApi().getSettings()
    if (result.ok) apply(result.value, false)
  }, [apply])

  /* ---------------------------------------------------------------------- */
  /* Checking the two targets                                                */
  /* ---------------------------------------------------------------------- */

  /*
   * Both checks save first. `pin:targets` asks the engine, and the engine reads
   * the settings file — so checking without saving would test the address the
   * member had before they edited it, and report a confusing answer about a
   * node they are not pointing at.
   */
  const checkKubo = useCallback(async () => {
    const saved = await commit({})
    if (saved === undefined) return
    await kuboProbe.run()
  }, [commit, kuboProbe])

  const testPinata = useCallback(async () => {
    const saved = await commit({})
    if (saved === undefined) return
    await pinataProbe.run()
  }, [commit, pinataProbe])

  /* ---------------------------------------------------------------------- */
  /* The Pinata key                                                          */
  /* ---------------------------------------------------------------------- */

  const submitToken = useCallback(
    async (event: FormEvent<HTMLFormElement>): Promise<void> => {
      event.preventDefault()
      const field = tokenField.current
      if (field === null) return

      const entered = field.value.trim()
      if (entered === '') return

      setTokenNotice(null)
      tokenClear.reset()

      const result = await tokenSave.run(entered)

      /*
       * Wiped whatever happened. On success the engine has it; on failure the
       * failure is a computer that cannot keep a credential safely, which
       * re-pasting the same key will not fix. Either way, leaving a bearer
       * credential sitting in a DOM node is the one outcome worth avoiding.
       */
      field.value = ''
      setTokenEntered(false)

      if (result === undefined) return

      if (!pinataEnabled) {
        // Saving a key is an unambiguous "yes, use Pinata". Doing it silently
        // would be a surprise, so the confirmation says so out loud.
        setTokenNotice('Key saved, and Pinata has been switched on.')
        await commit({ pinataEnabled: true })
      } else {
        setTokenNotice('Key saved.')
        await refreshHasToken()
      }
    },
    [commit, pinataEnabled, refreshHasToken, tokenClear, tokenSave]
  )

  const removeToken = useCallback(async () => {
    setTokenNotice(null)
    tokenSave.reset()
    const result = await tokenClear.run()
    if (result === undefined) return
    setTokenNotice('The saved key has been removed from this computer.')
    await refreshHasToken()
  }, [refreshHasToken, tokenClear, tokenSave])

  /* ---------------------------------------------------------------------- */
  /* Render                                                                  */
  /* ---------------------------------------------------------------------- */

  const kuboStatus = findTarget(kuboProbe.value, 'kubo')
  const pinataStatus = findTarget(pinataProbe.value, 'pinata')
  const nowhereToPin = !kuboEnabled && !pinataEnabled
  const secureStorageBroken = isSecureStorageFailure(tokenSave.error)

  return (
    <div className="view">
      <ViewHeader
        title="Settings"
        lead="A backup keeps the files. Something has to keep them reachable — and the two are not the same thing. This is where you set up the computer that does it."
      />

      {loadError !== null && (
        <Banner tone="danger" title="Your settings could not be read">
          {loadError} The choices below are the app's defaults until that is fixed.
        </Banner>
      )}

      {save.error !== null && (
        <Banner
          tone="danger"
          title="That setting was not saved"
          actions={
            <button type="button" className="btn btn-sm" onClick={save.reset}>
              Dismiss
            </button>
          }
        >
          {save.error}
        </Banner>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* PRIMARY — the member's own node                                     */}
      {/* ------------------------------------------------------------------ */}

      <NodeSection
        pinsEnabled={kuboEnabled}
        onEnablePins={enableNodePins}
        onSettingsChanged={reloadSettings}
        enablingPins={save.pending}
      >
        <Disclosure
          summary="Advanced: where this app sends pins"
          note="Set for you when the node is installed — change it only if your node lives somewhere else"
          quiet
        >
          <Toggle
            checked={kuboEnabled}
            disabled={!loaded || save.pending}
            onChange={(next) => {
              void commit({ kuboEnabled: next })
            }}
            label="Pin to the node at the address below"
            hint="Switch this off only if you want the app to stop using your node entirely."
          />

          <div className="field">
            <label className="field-label" htmlFor="kubo-api-url">
              Address of the node
            </label>
            <input
              id="kubo-api-url"
              className="input input-mono"
              type="text"
              inputMode="url"
              spellCheck={false}
              autoComplete="off"
              value={kuboUrl}
              placeholder={DEFAULT_PINNING_SETTINGS.kubo.apiUrl}
              disabled={!loaded}
              onChange={(event) => {
                setKuboUrl(event.target.value)
              }}
              onBlur={() => {
                void commit({})
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void checkKubo()
              }}
            />
            <p className="field-hint">
              {DEFAULT_PINNING_SETTINGS.kubo.apiUrl} is where a node on this computer normally
              listens. The app writes the right address here when it sets a node up for you, so it
              is worth changing only if your node runs on another machine — or if the usual port was
              taken and it had to move.
            </p>
          </div>

          <div className="row">
            <button
              type="button"
              className="btn"
              onClick={() => {
                void checkKubo()
              }}
              disabled={kuboProbe.pending || save.pending || !loaded}
            >
              {kuboProbe.pending ? 'Checking…' : 'Check this address'}
            </button>
            {kuboProbe.pending && <span className="spinner" aria-hidden="true" />}
          </div>

          <div aria-live="polite" className="stack stack-sm">
            {kuboProbe.error !== null && (
              <Banner tone="danger" title="The check could not run">
                {kuboProbe.error}
              </Banner>
            )}

            {kuboStatus !== null && kuboStatus.available && (
              <Banner tone="ok" title="A node answered at that address">
                {kuboStatus.detail ?? 'Pins from this app will go there.'}
              </Banner>
            )}

            {kuboStatus !== null && !kuboStatus.available && (
              <Banner tone="warn" title="No node answered at that address">
                {kuboStatus.detail ?? 'Nothing responded there.'}
              </Banner>
            )}
          </div>
        </Disclosure>
      </NodeSection>

      {/* ------------------------------------------------------------------ */}
      {/* Pin as you go                                                       */}
      {/* ------------------------------------------------------------------ */}

      <Card title="Pinning new content">
        <Toggle
          checked={pinOnImport}
          disabled={!loaded || save.pending}
          onChange={(next) => {
            void commit({ pinOnImport: next })
          }}
          label="Pin new content automatically"
          hint="Anything this app archives from now on is handed to your node — and to Pinata, if you have set one up — as it is archived."
        />

        <p className="muted">
          This is on by default, and the reason is not a preference. Of the 428 files this DAO has
          already lost, nearly every one was something BIC had rescued from Arweave or an ordinary
          website and saved to IPFS — content that nobody else on the network had any reason to
          keep. It was archived and never pinned, and one day it simply stopped answering. Twelve
          NFTs are now gone from the network entirely. Pinning as you go is what stops that
          happening a second time.
        </p>

        {nowhereToPin && (
          <Banner tone="warn" title="Nowhere to pin to yet">
            New content will be archived to this computer but not offered to anyone. Set up your own
            node above — it needs no account and no key — and this looks after itself.
          </Banner>
        )}
      </Card>

      {/* ------------------------------------------------------------------ */}
      {/* SECONDARY — Pinata                                                  */}
      {/* ------------------------------------------------------------------ */}

      <section className="card card-secondary stack">
        <Disclosure
          summary="Pinata (optional)"
          note={
            hasToken
              ? 'A key is saved on this computer'
              : 'A paid hosting company — useful if the DAO already pays for one, not needed otherwise'
          }
        >
          <Banner tone="warn" title="Read this before signing up">
            Asking Pinata to keep content by its content ID — which is exactly what this app needs —
            is a <strong>paid</strong> feature. On a free account the request is refused outright,
            and no key, permission or setting changes that. The free tier is also 1 GB and 500 files
            against an archive of 1.9 GB and 20,808 files, so it could not hold the archive even if
            the feature were included. <strong>Your own node does the same job for nothing</strong>{' '}
            and is set up above. Pinata is worth having on top of a node — a copy on machines that
            never sleep — but it is not a substitute for one, and it is not the way to keep this
            archive alive on its own.{' '}
            <ExternalLink url={PINATA_PRICING_URL}>Pinata&rsquo;s own pricing page</ExternalLink> has
            the current numbers.
          </Banner>

          <Toggle
            checked={pinataEnabled}
            disabled={!loaded || save.pending}
            onChange={(next) => {
              void commit({ pinataEnabled: next })
            }}
            label="Keep a copy with Pinata as well"
            hint="Only useful with a paid plan. Content already on the network gets copied to machines that are always on."
          />

          <p className="muted">
            Pinata fetches content from the network rather than from your disk, so on its own it
            cannot rescue anything that has already gone. Used together with your node it can: the
            node puts the content back on the network, and Pinata collects it from there.
          </p>

          {hasToken ? (
            <div className="stack stack-sm">
              <div className="row">
                <Pill tone="ok">A key is saved</Pill>
                <button
                  type="button"
                  className="btn btn-sm btn-danger"
                  onClick={() => {
                    void removeToken()
                  }}
                  disabled={tokenClear.pending}
                >
                  {tokenClear.pending ? 'Removing…' : 'Remove'}
                </button>
              </div>
              <p className="field-hint">
                The key itself is kept in this computer&rsquo;s keychain — never in the archive,
                never in this window, and never in any file you would send to another member. This
                app cannot read it back; it can only ask the operating system to use it or to forget
                it.
              </p>
            </div>
          ) : (
            <form className="stack stack-sm" onSubmit={(event) => void submitToken(event)}>
              <div className="field">
                <label className="field-label" htmlFor="pinata-token">
                  Pinata access key (JWT)
                </label>
                <input
                  id="pinata-token"
                  ref={tokenField}
                  className="input input-mono"
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="Paste the key from Pinata"
                  onChange={(event) => {
                    // Only whether the box has something in it is remembered.
                    // The key itself never leaves the input element.
                    setTokenEntered(event.target.value.trim() !== '')
                  }}
                />
                <p className="field-hint">
                  In Pinata, go to <ExternalLink url={PINATA_KEYS_URL}>API Keys</ExternalLink>,
                  create a key, and copy the long <strong>JWT</strong> value. It goes straight into
                  this computer&rsquo;s keychain — it is never written into the archive, and it
                  never leaves this app.
                </p>
              </div>
              <div className="row">
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={!tokenEntered || tokenSave.pending}
                >
                  {tokenSave.pending ? 'Saving…' : 'Save key'}
                </button>
              </div>
            </form>
          )}

          <div aria-live="polite" className="stack stack-sm">
            {tokenNotice !== null && (
              <Banner tone="ok" title="Done">
                {tokenNotice}
              </Banner>
            )}

            {secureStorageBroken && (
              <Banner tone="danger" title="This computer has nowhere safe to keep the key">
                Nothing has been saved. The key is a password to the DAO&rsquo;s Pinata account —
                anyone who could read it could unpin the DAO&rsquo;s content — so this app will not
                write it into an ordinary file, and there is no option to make it do so. On Linux
                this usually means your desktop&rsquo;s password store (GNOME Keyring or KWallet) is
                not running; starting it and trying again fixes it. In the meantime, pin to your own
                IPFS node instead: it needs no key at all.
              </Banner>
            )}

            {tokenSave.error !== null && !secureStorageBroken && (
              <Banner tone="danger" title="The key was not saved">
                {tokenSave.error}
              </Banner>
            )}

            {tokenClear.error !== null && (
              <Banner tone="danger" title="The key could not be removed">
                {tokenClear.error}
              </Banner>
            )}
          </div>

          <div className="field">
            <label className="field-label" htmlFor="pinata-gateway">
              Your Pinata gateway (optional)
            </label>
            <input
              id="pinata-gateway"
              className="input input-mono"
              type="text"
              inputMode="url"
              spellCheck={false}
              autoComplete="off"
              value={gateway}
              placeholder="https://yourname.mypinata.cloud"
              disabled={!loaded}
              onChange={(event) => {
                setGateway(event.target.value)
              }}
              onBlur={() => {
                void commit({})
              }}
            />
            <p className="field-hint">
              If your Pinata plan includes a gateway of your own, putting it here makes your pinned
              content load through it. Leave it empty otherwise — everything works without it.
            </p>
          </div>

          <div className="row">
            <button
              type="button"
              className="btn"
              onClick={() => {
                void testPinata()
              }}
              disabled={pinataProbe.pending || save.pending || !loaded}
            >
              {pinataProbe.pending ? 'Testing…' : 'Test'}
            </button>
            {pinataProbe.pending && <span className="spinner" aria-hidden="true" />}
          </div>

          <div aria-live="polite" className="stack stack-sm">
            {pinataProbe.error !== null && (
              <Banner tone="danger" title="The test could not run">
                {pinataProbe.error}
              </Banner>
            )}

            {pinataStatus !== null && pinataStatus.available && (
              <Banner tone="ok" title="Pinata accepted the key">
                {pinataStatus.detail ??
                  'The key works. Content this app pins will be kept on the DAO’s Pinata account.'}
              </Banner>
            )}

            {pinataStatus !== null && !pinataStatus.available && (
              <Banner tone="warn" title="Pinata is not usable yet">
                {pinataStatus.detail ?? 'Pinata did not accept the key.'}
              </Banner>
            )}
          </div>
        </Disclosure>
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* The short version                                                   */}
      {/* ------------------------------------------------------------------ */}

      <Card title="Why it is shaped this way">
        <dl className="kv">
          <dt>Your own node</dt>
          <dd>
            Holds the actual bytes and tells the network it has them. This is the only thing that
            can make a dead content ID reachable again, because for those files there is nothing
            left for anyone else to fetch. It is free, it needs no account, and nobody can withdraw
            it.
          </dd>
          <dt>A hosting company</dt>
          <dd>
            Is a useful second copy on machines that never sleep, and nothing more than that. Two
            have already failed this archive: one was shut down entirely, and the other charges for
            the one feature this app needs. Pay for one if the DAO wants to; do not rely on one.
          </dd>
          <dt>Neither of them</dt>
          <dd>
            Is a substitute for the .car backup on the Export screen. The backup is the copy that
            survives an account being closed or a machine being wiped.
          </dd>
        </dl>
      </Card>

      <UpdateCheck />
    </div>
  )
}
