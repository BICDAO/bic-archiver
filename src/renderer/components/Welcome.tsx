/**
 * The first thing a member sees: open an archive, or help keep BIC's alive.
 *
 * Two jobs, and the second one is why this screen was pulled out of `App.tsx`.
 *
 * 1. **Choose an archive.** An archive is a folder on the member's own computer;
 *    saying that plainly here is the difference between "why is it asking me for
 *    a folder?" and knowing where your backup actually lives.
 *
 * 2. **Help keep BIC's archive alive.** Of 10,762 content IDs in the real
 *    May-2026 backup, 428 were served by nobody, almost all of them files BIC
 *    had rescued from Arweave or a dead web server — content nobody else has any
 *    reason to keep. Twelve NFTs now exist in one folder on one Google Drive.
 *    The fix is not a service (two have already failed this archive) but members
 *    running real nodes, so the big button here does the whole job: install a
 *    real IPFS node, start it, set it to come back at login, then copy the
 *    archive onto it.
 *
 * Three rules the wording follows, because getting them wrong is how an archive
 * dies quietly:
 *
 *   • The size is stated *before* the click, never after. 1.8 GB is a real ask.
 *   • "Mirroring" is claimed only when this computer genuinely serves the
 *     content to other people. A copy on a disk that nobody can fetch is a
 *     backup — worth having, not the same thing — and `MirrorResult.nowServing`
 *     is the only field allowed to decide which sentence appears.
 *   • Every long job has a Stop that works, and stopping is safe: a half-copied
 *     archive is resumed, not restarted.
 *
 * Settings is reachable from here on purpose. Until now the sidebar — and with
 * it Settings — only existed once an archive was open, so a member could not set
 * their node up *before* archiving anything, which is precisely the order most
 * people want to do it in.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode
} from 'react'

import { BIC_ARCHIVE } from '../../shared/community'
import type { MirrorCapability, MirrorResult } from '../../shared/community'
import type { DriftStatus, ManagedNodeStatus, NodeInstallProgress } from '../../shared/node'
import type { ArchiveSnapshot, MirrorStatus } from '../../preload'
import { getApi, useArchive } from '../hooks'
import DriftBanner, { RunReadout, startMirrorRun, useMirrorRun } from './DriftBanner'
import {
  Banner,
  Card,
  OperationStatus,
  Pill,
  formatBytes,
  formatCount,
  isCancellation,
  useOperation
} from './Layout'

/* ========================================================================== */
/* Setting the node up                                                        */
/* ========================================================================== */

/**
 * Installing a node is a module-level store for the same reason the mirror run
 * is: it is an ~80 MB download followed by several minutes of set-up, and it
 * must not be lost or forgotten because a component happened to unmount. It also
 * means the "install, then copy" chain survives a member clicking away
 * mid-install — the copy still starts when the node is ready.
 */
interface NodeSetupState {
  busy: boolean
  phase: NodeInstallProgress['phase'] | null
  message: string
  progress: number | null
  bytesDone: number | null
  bytesTotal: number | null
  /** The node as it stood when the last set-up finished. */
  status: ManagedNodeStatus | null
  /** A finished plain-English sentence, or null. May be a cancellation. */
  error: string | null
  /** Bumped whenever a set-up ends, however it ended. */
  finishedAt: number
}

const SETUP_IDLE: NodeSetupState = {
  busy: false,
  phase: null,
  message: '',
  progress: null,
  bytesDone: null,
  bytesTotal: null,
  status: null,
  error: null,
  finishedAt: 0
}

let setupState: NodeSetupState = SETUP_IDLE
const setupListeners = new Set<() => void>()
let setupOpId: string | null = null
let setupListening = false

function publishSetup(next: NodeSetupState): void {
  setupState = next
  for (const listener of [...setupListeners]) listener()
}

/** Attached once and never detached — see the note on the mirror stream. */
function listenToSetup(): void {
  if (setupListening) return
  setupListening = true
  getApi().onNodeProgress((progress: NodeInstallProgress) => {
    if (!setupState.busy) return

    // The download reports bytes; unpacking and configuring do not. Carrying the
    // download's counters into a later phase would leave a number on screen that
    // stopped being true minutes ago.
    const samePhase = progress.phase === setupState.phase

    publishSetup({
      ...setupState,
      phase: progress.phase,
      message: progress.message !== '' ? progress.message : setupState.message,
      progress:
        typeof progress.progress === 'number'
          ? progress.progress
          : samePhase
            ? setupState.progress
            : null,
      bytesDone:
        typeof progress.bytesDone === 'number'
          ? progress.bytesDone
          : samePhase
            ? setupState.bytesDone
            : null,
      bytesTotal:
        typeof progress.bytesTotal === 'number'
          ? progress.bytesTotal
          : samePhase
            ? setupState.bytesTotal
            : null
    })
  })
}

function subscribeToSetup(listener: () => void): () => void {
  listenToSetup()
  setupListeners.add(listener)
  return () => {
    setupListeners.delete(listener)
  }
}

function readSetup(): NodeSetupState {
  return setupState
}

/**
 * Install and start a real IPFS node, and then — if that worked — start copying
 * the archive onto it.
 *
 * `thenMirror` is what makes this one button rather than two. It is honoured
 * only when the node genuinely came up: a member who pressed Stop, or whose
 * install failed, must not then watch a 1.8 GB download start on its own.
 */
function startNodeSetup(thenMirror: boolean): void {
  if (setupState.busy) return
  listenToSetup()

  const api = getApi()
  const opId = api.newOperationId()
  setupOpId = opId

  publishSetup({
    ...SETUP_IDLE,
    busy: true,
    finishedAt: setupState.finishedAt,
    message: 'Checking what is already on this computer…'
  })

  const finish = (outcome: { status?: ManagedNodeStatus; error?: string }): void => {
    if (setupOpId !== opId) return
    setupOpId = null
    publishSetup({
      ...SETUP_IDLE,
      finishedAt: Date.now(),
      progress: outcome.status !== undefined ? 1 : null,
      status: outcome.status ?? null,
      error: outcome.error ?? null
    })

    const ready =
      outcome.status !== undefined &&
      (outcome.status.state === 'running' || outcome.status.state === 'external')
    if (thenMirror && ready) startMirrorRun()
  }

  void api.installNode(opId).then(
    (result) => {
      finish(result.ok ? { status: result.value } : { error: result.error })
    },
    () => {
      finish({ error: 'Something went wrong inside the app. Please try that again.' })
    }
  )
}

function cancelNodeSetup(): void {
  const opId = setupOpId
  if (opId === null) return
  publishSetup({ ...setupState, message: 'Stopping…' })
  void getApi().cancel(opId)
}

function dismissNodeSetup(): void {
  if (setupState.busy) return
  publishSetup({ ...SETUP_IDLE, finishedAt: setupState.finishedAt })
}

interface NodeSetup extends NodeSetupState {
  start: (thenMirror: boolean) => void
  cancel: () => void
  dismiss: () => void
}

function useNodeSetup(): NodeSetup {
  const state = useSyncExternalStore(subscribeToSetup, readSetup, readSetup)
  return useMemo(
    () => ({ ...state, start: startNodeSetup, cancel: cancelNodeSetup, dismiss: dismissNodeSetup }),
    [state]
  )
}

/* ========================================================================== */
/* Wording helpers                                                            */
/* ========================================================================== */

const ARCHIVE_SIZE = formatBytes(BIC_ARCHIVE.approxBytes)
const ARCHIVE_FILES = formatCount(BIC_ARCHIVE.approxFiles)

/**
 * How many computers the network can see holding the archive.
 *
 * `providers` is a fact about the *network*, not about this machine: a node
 * behind a router nothing can dial holds the archive perfectly and announces it
 * to nobody. So zero is reported as "cannot see", never as "nobody has it".
 */
function describeProviders(providers: number, keepingLocally: boolean): string {
  if (providers > 1) {
    return `${formatCount(providers)} computers are sharing it with the world right now.`
  }
  if (providers === 1) {
    return 'One computer is sharing it with the world right now.'
  }
  return keepingLocally
    ? 'The network cannot see anyone sharing it at the moment. Your copy is safe either way — ' +
        'this usually means your router is not letting other people connect in, so people reach ' +
        'you more slowly, through relays.'
    : 'The network cannot see anyone sharing it at the moment.'
}

/* ========================================================================== */
/* The big button                                                             */
/* ========================================================================== */

/**
 * The most important control in the app, and the only one whose wording is
 * load-bearing: everything it says about what this computer is doing for the
 * archive has to be true, including when the answer is "nothing yet".
 */
function KeepArchiveAlive({
  driftIsBehind,
  onOpenSettings,
  onOpened,
  onReclaim
}: {
  /** From the drift check above: BIC has published a newer archive. */
  driftIsBehind: boolean
  onOpenSettings: () => void
  onOpened: (snapshot: ArchiveSnapshot, isNew: boolean, target?: 'gallery') => void
  onReclaim?: (car: { path: string; bytes: number }) => void
}): ReactNode {
  const mirror = useMirrorRun()
  const setup = useNodeSetup()
  /*
   * Needed for `set`. The archive is a module-level store, and the shell decides
   * what to draw from it — so a screen that builds an archive by calling the
   * bridge directly has to push the new snapshot in. Skipping that leaves the
   * store holding `null`, which the shell reads as "no archive open" and answers
   * with this very screen: the job succeeds, 1.9 GB lands, and the member
   * watches the button go back to how it was.
   */
  const archive = useArchive()

  const [status, setStatus] = useState<MirrorStatus | null>(null)
  const [capabilities, setCapabilities] = useState<MirrorCapability[] | null>(null)
  const [node, setNode] = useState<ManagedNodeStatus | null>(null)
  const [checking, setChecking] = useState(true)
  const [autostartPending, setAutostartPending] = useState(false)

  /*
   * Building an archive out of the copy that has just landed.
   *
   * A real operation rather than a boolean, because this is a ~30 second job on
   * 1.9 GB and a button that only says "Opening…" for half a minute is
   * indistinguishable from one that has hung. The engine already narrates each
   * step; this is what puts that narration on screen, with a Stop that works.
   */
  const buildOp = useOperation()

  /**
   * Turn the finished copy into an archive, then show the member the pictures.
   *
   * This is the whole point of the copy as far as most people are concerned, and
   * until now there was no way to get here: mirroring wrote blocks and a `.car`,
   * the gallery reads an archive, and nothing joined the two. A member could
   * hold every NFT the DAO owns and have no screen that would show them one.
   *
   * Offered whatever the run achieved, deliberately. Serving the archive is a
   * separate and better outcome, but a copy that nobody can fetch is still a
   * copy of every picture, and making the gallery wait for a working IPFS node
   * would hide it from exactly the members most likely to give up on all of it.
   */
  const seeTheNfts = useCallback(
    async (source: { rootCid: string; carPath?: string }) => {
      const where = await getApi().suggestArchivePath('BIC Archive')
      if (!where.ok) {
        buildOp.fail(where.error)
        return
      }

      const built = await buildOp.run({
        start: 'Putting your copy together — this usually takes about half a minute…',
        body: (opId) =>
          getApi().archiveFromMirror(
            {
              dir: where.value,
              name: 'BIC Archive',
              rootCid: source.rootCid,
              // Absent when the node already held the archive and nothing was
              // downloaded; the main process then asks the node for it instead.
              ...(source.carPath === undefined ? {} : { carPath: source.carPath })
            },
            opId
          )
      })
      if (built === null) return

      if (built.redundantCar !== undefined) onReclaim?.(built.redundantCar)

      /*
       * Store first, then the view. Both land in one render, and doing it the
       * other way round asks the shell to show the gallery of an archive it does
       * not yet believe is open — which is not a cosmetic problem: the shell
       * reads a null store as "no archive", so the member is returned to this
       * screen and every sign of the work disappears.
       */
      archive.set(built.snapshot)
      onOpened(built.snapshot, true, 'gallery')
    },
    [archive, buildOp, onOpened, onReclaim]
  )

  /**
   * The same control wherever a copy exists; only the surrounding story differs.
   *
   * The wait is stated before the click rather than after, for the same reason
   * the 1.8 GB is: half a minute of nothing is long enough to conclude the app
   * has died, and a member who was told to expect it waits instead.
   */
  const galleryButton = (source: { rootCid: string; carPath?: string }): ReactNode => (
    <button
      type="button"
      className="btn btn-primary btn-sm"
      onClick={() => void seeTheNfts(source)}
      disabled={buildOp.busy}
      title="Takes about half a minute — the whole archive is checked on the way in"
    >
      {buildOp.busy ? 'Opening…' : 'See the NFTs (about 30 seconds)'}
    </button>
  )

  /** A finished run, as the button wants it. */
  const fromResult = (result: MirrorResult): { rootCid: string; carPath?: string } => ({
    rootCid: result.rootCid,
    ...(result.carPath === undefined ? {} : { carPath: result.carPath })
  })

  const mirrorFinishedAt = mirror.finishedAt
  const setupFinishedAt = setup.finishedAt

  /*
   * The mirror run is shared with the drift banner above. A copy the *banner*
   * started is the banner's to narrate — this card stays quiet about it and just
   * re-reads the status when it ends, so one job is never drawn twice.
   */
  const ourRun = mirror.origin !== 'drift'

  /*
   * Three questions, asked together on mount and again after anything that could
   * change the answers. None of them is allowed to fail the panel: a status
   * screen that cannot draw itself is how a member ends up with no idea whether
   * they are helping.
   */
  useEffect(() => {
    let alive = true
    setChecking(true)
    const api = getApi()

    void Promise.all([api.mirrorStatus(), api.mirrorCapabilities(), api.nodeStatus()]).then(
      ([mirrorResult, capabilityResult, nodeResult]) => {
        if (!alive) return
        if (mirrorResult.ok) setStatus(mirrorResult.value)
        if (capabilityResult.ok) setCapabilities(capabilityResult.value)
        if (nodeResult.ok) setNode(nodeResult.value)
        setChecking(false)
      }
    )

    return () => {
      alive = false
    }
  }, [mirrorFinishedAt, setupFinishedAt])

  const enableAutostart = useCallback(() => {
    setAutostartPending(true)
    void getApi()
      .setAutostart(true)
      .then((result) => {
        setAutostartPending(false)
        if (result.ok) setNode(result.value)
      })
  }, [])

  /* ---- what this computer can do --------------------------------------- */

  const liveNode = node !== null && (node.state === 'running' || node.state === 'external')
  const nodeReady = liveNode || (capabilities?.includes('node') ?? false)
  const keepingLocally = status?.pinnedLocally ?? false
  const keepingOnPinata = status?.pinnedOnPinata ?? false
  const keeping = keepingLocally || keepingOnPinata
  const providers = status?.providers ?? 0

  const lead = (
    <>
      BIC&rsquo;s backup is {ARCHIVE_SIZE} — about {ARCHIVE_FILES} files. Hundreds of them are
      rescues from Arweave and old websites that nobody else has any reason to keep, so every
      member holding a copy is another place the archive can come back from.
    </>
  )

  /* ---- something is running -------------------------------------------- */

  if (setup.busy) {
    return (
      <Card title="Setting up IPFS on this computer" lead={lead}>
        <RunReadout
          message={setup.message}
          progress={setup.progress}
          bytesDone={setup.bytesDone}
          bytesTotal={setup.bytesTotal}
          onStop={setup.cancel}
        />
        <p className="small muted">
          The program is downloaded from the official IPFS site and its fingerprint is checked
          before anything is unpacked or run. Copying the archive starts on its own once the node
          is up. Stopping now leaves nothing running, and starting again picks up where it left
          off.
        </p>
      </Card>
    )
  }

  if (mirror.busy && ourRun) {
    return (
      <Card title="Copying BIC's archive" lead={lead}>
        <RunReadout
          message={mirror.message}
          progress={mirror.progress}
          bytesDone={mirror.bytesDone}
          bytesTotal={mirror.bytesTotal}
          onStop={mirror.cancel}
        />
        <p className="small muted">
          You can leave this running and carry on. Stopping keeps everything copied so far, so
          starting again carries on rather than beginning again.
        </p>
      </Card>
    )
  }

  if (mirror.busy) {
    // Started from the notice above, which is drawing the bar and the Stop
    // button. Repeating either here would be two controls for one job.
    return (
      <Card title="Help keep BIC's archive alive" lead={lead}>
        <div className="row">
          <span className="spinner" aria-hidden="true" />
          <span className="muted">
            Your copy is being brought up to date — see the notice at the top of this screen.
          </span>
        </div>
      </Card>
    )
  }

  /* ---- a set-up that just ended badly ----------------------------------- */

  if (setup.error !== null) {
    const stopped = isCancellation(setup.error)
    return (
      <Card title="Help keep BIC's archive alive" lead={lead}>
        <Banner
          tone={stopped ? 'warn' : 'danger'}
          title={stopped ? 'Stopped' : 'IPFS could not be set up'}
          actions={
            <>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={() => setup.start(true)}
              >
                Try again
              </button>
              <button type="button" className="btn btn-sm" onClick={setup.dismiss}>
                Dismiss
              </button>
            </>
          }
        >
          {setup.error}
        </Banner>
      </Card>
    )
  }

  /* ---- a copy that stopped or failed ------------------------------------ */

  if (mirror.error !== null && ourRun) {
    const stopped = isCancellation(mirror.error)
    return (
      <Card title="Help keep BIC's archive alive" lead={lead}>
        <Banner
          tone={stopped ? 'warn' : 'danger'}
          title={stopped ? 'Stopped' : 'The archive could not be copied'}
          actions={
            <>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={() => mirror.start()}
              >
                {stopped ? 'Carry on copying' : 'Try again'}
              </button>
              <button type="button" className="btn btn-sm" onClick={mirror.dismiss}>
                Dismiss
              </button>
            </>
          }
        >
          {mirror.error}
        </Banner>
      </Card>
    )
  }

  /* ---- a copy that just finished ---------------------------------------- */

  if (mirror.result !== null && ourRun) {
    const result = mirror.result
    const notes = result.errors.slice(0, 3)

    if (result.nowServing) {
      return (
        <Card title="You are keeping BIC's archive alive" lead={lead}>
          <Banner
            tone="ok"
            title="This computer is now serving the archive to other people"
            actions={
              <>
                {galleryButton(fromResult(result))}
                <button type="button" className="btn btn-sm" onClick={mirror.dismiss}>
                  Dismiss
                </button>
              </>
            }
          >
            <div className="stack stack-sm">
              <p>{result.summary}</p>
              <OperationStatus op={buildOp} />
              {notes.length > 0 && (
                <ul className="bullets">
                  {notes.map((note) => (
                    <li key={note}>{note}</li>
                  ))}
                </ul>
              )}
            </div>
          </Banner>
        </Card>
      )
    }

    /*
     * The honest half of the contract. `nowServing === false` means the bytes are
     * on a disk and no one on earth can fetch them from this machine, which is a
     * backup and not a mirror. Saying otherwise here would recreate the exact
     * false confidence that lost 428 files.
     */
    return (
      <Card title="Help keep BIC's archive alive" lead={lead}>
        <Banner
          tone={result.ok ? 'warn' : 'danger'}
          title={
            result.ok
              ? 'Saved to this computer — but not shared with anyone yet'
              : 'The archive could not be copied'
          }
          actions={
            <>
              {/*
                First, and accented, even though serving the archive is the more
                valuable outcome. A member who has just waited out 1.8 GB has
                earned the sight of what they downloaded, and "set up IPFS" asks
                them for yet another step before anything they can see. The
                pictures are also the best argument for taking that step.
              */}
              {result.ok && galleryButton(fromResult(result))}
              <button type="button" className="btn btn-sm" onClick={() => setup.start(true)}>
                Set up IPFS so people can fetch it from you
              </button>
              <button type="button" className="btn btn-sm" onClick={mirror.dismiss}>
                Dismiss
              </button>
            </>
          }
        >
          <div className="stack stack-sm">
            <p>{result.summary}</p>
            <OperationStatus op={buildOp} />
            {result.ok && (
              <p className="small">
                Nobody can fetch these files from you until this computer runs IPFS, so the copy
                helps you and not yet the archive.
              </p>
            )}
            {notes.length > 0 && (
              <ul className="bullets">
                {notes.map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
            )}
          </div>
        </Banner>
      </Card>
    )
  }

  /* ---- still asking ----------------------------------------------------- */

  if (checking && status === null && node === null) {
    return (
      <Card title="Help keep BIC's archive alive" lead={lead}>
        <div className="row">
          <span className="spinner" aria-hidden="true" />
          <span className="muted">Checking what this computer can do for the archive…</span>
        </div>
      </Card>
    )
  }

  /* ---- already helping --------------------------------------------------- */

  if (keeping) {
    return (
      <Card title="You are keeping BIC's archive alive" lead={lead}>
        <div className="stack stack-sm">
          <div className="row">
            <Pill tone="ok">
              {keepingLocally ? 'Held and served by this computer' : 'Held for you by Pinata'}
            </Pill>
          </div>

          {keepingLocally && (
            <p>
              This computer has the whole archive and hands it to anyone who asks for it. It keeps
              doing that while the app is closed.
            </p>
          )}
          {keepingOnPinata && (
            <p>
              {keepingLocally
                ? 'Pinata is keeping a second copy in the cloud, so the archive stays reachable ' +
                  'when this computer is off.'
                : 'Pinata is keeping a copy in the cloud for you, so the archive stays reachable ' +
                  'even when this computer is off.'}
            </p>
          )}

          <p className="small muted">{describeProviders(providers, keepingLocally)}</p>

          {/*
            The member who mirrored weeks ago and came back. There is no finished
            run to read a `.car` out of — there may never have been one — so the
            content is pulled back out of their own node.

            Gated on `keepingLocally` rather than `keeping`: a copy that exists
            only on Pinata is not on this computer, and offering to open it would
            be offering something that cannot work.
          */}
          {keepingLocally && status !== null && status.rootCid !== '' && (
            <div className="stack stack-sm">
              <div className="row">{galleryButton({ rootCid: status.rootCid })}</div>
              <p className="small muted">
                Builds an archive from the copy your node is already holding, so you can look
                through what you are keeping. Nothing is downloaded again.
              </p>
              <OperationStatus op={buildOp} />
            </div>
          )}

          {driftIsBehind && (
            <p className="small">
              BIC has published a newer version since your copy was made — the notice above will
              bring it up to date. There is no need to copy the whole archive again.
            </p>
          )}

          {node !== null && node.managed && !node.autostart && (
            <div className="row">
              <span className="grow small">
                Your IPFS node is not set to start when you log in, so it will stop serving the
                archive after a restart.
              </span>
              <button
                type="button"
                className="btn btn-sm"
                onClick={enableAutostart}
                disabled={autostartPending}
              >
                {autostartPending ? 'Setting…' : 'Start it automatically'}
              </button>
            </div>
          )}
        </div>
      </Card>
    )
  }

  /* ---- not helping yet: the big button ---------------------------------- */

  const nodeProblem =
    node !== null && node.state === 'error' && node.detail !== undefined ? node.detail : null

  return (
    // The accent lives here, and only here on this screen: this is the one
    // action most members will ever need to take. The busy, error and
    // already-helping states above deliberately do not carry it — there is
    // nothing left to decide by then.
    <Card title="Help keep BIC's archive alive" lead={lead} accent>
      <div className="stack">
        {nodeReady ? (
          <>
            <p>
              This computer already runs IPFS. Copying the archive puts it on your node, which then
              hands it to anyone who asks — you become a real backup for the DAO.
            </p>
            <div className="row">
              <button
                type="button"
                className="btn btn-primary btn-lg"
                onClick={() => mirror.start()}
              >
                Copy the archive and start sharing it
              </button>
            </div>
            <p className="small muted">
              About {ARCHIVE_SIZE} and {ARCHIVE_FILES} files. Your node fetches only the parts it
              does not already have, and you can stop at any point without losing what has arrived.
            </p>
          </>
        ) : (
          <>
            <p>
              One button does the whole thing: it installs IPFS on this computer, copies the archive
              onto it, and sets it to start when you log in. From then on your computer keeps a copy
              of the archive and shares it with anyone who asks — including while this app is
              closed.
            </p>
            <div className="row">
              <button
                type="button"
                className="btn btn-primary btn-lg"
                onClick={() => setup.start(true)}
              >
                Set up IPFS and copy the archive
              </button>
            </div>
            <p className="small muted">
              A one-off download of well under 100 MB for IPFS itself, then about {ARCHIVE_SIZE} and{' '}
              {ARCHIVE_FILES} files for the archive. Nothing is installed until the download has
              been checked against the official fingerprint, and you can stop at any point.
            </p>
            <div className="row">
              <button type="button" className="btn btn-link" onClick={() => mirror.start()}>
                Just save the files to this computer instead
              </button>
            </div>
            <p className="small faint">
              That keeps the files safe on your disk, but nobody can fetch them from you, so it does
              not help the archive stay reachable. It is a backup, not a mirror.
            </p>
          </>
        )}

        {nodeProblem !== null && <p className="small muted">{nodeProblem}</p>}

        <p className="small faint">
          Prefer to set things up yourself?{' '}
          <button type="button" className="btn btn-link" onClick={onOpenSettings}>
            Open Settings
          </button>
        </p>
      </div>
    </Card>
  )
}

/* ========================================================================== */
/* The screen                                                                 */
/* ========================================================================== */

export interface WelcomeProps {
  /**
   * Called once an archive has been created or reopened.
   *
   * `target` is only ever `'gallery'`, and only from the mirror flow: a member
   * who has just copied the archive is sent to the pictures rather than to the
   * empty token list they would otherwise land on.
   */
  onOpened: (snapshot: ArchiveSnapshot, isNew: boolean, target?: 'gallery') => void
  /**
   * A `.car` that has been folded into an archive and is now a duplicate. The
   * shell makes the offer, because by then this screen is gone.
   */
  onReclaim?: (car: { path: string; bytes: number }) => void
  /** Show the app's settings, which this screen can reach with no archive open. */
  onOpenSettings: () => void
  /**
   * Show the help screen. Offered here because this is the one screen a member
   * reaches before they have anything at all, and "IPFS" and "pinning" are two
   * words that mean nothing until somebody explains them.
   */
  onOpenHelp?: () => void
  /** Present only when there is an archive to go back to. */
  onCancel?: () => void
}

export default function Welcome({
  onOpened,
  onReclaim,
  onOpenSettings,
  onOpenHelp,
  onCancel
}: WelcomeProps): ReactNode {
  const archive = useArchive()
  const [name, setName] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const [working, setWorking] = useState(false)

  /**
   * The drift check runs in the banner; its verdict is passed up so the big
   * button and the banner never both offer to copy 1.8 GB. "Out of date" is the
   * banner's story, and the card defers to it.
   */
  const [driftIsBehind, setDriftIsBehind] = useState(false)

  /**
   * Where the new archive will go. `suggested` is proposed by the engine from
   * the name and is what almost everyone will use; `chosenDir` is set only when
   * a member deliberately picks somewhere else, and then wins.
   */
  const [suggested, setSuggested] = useState<string | null>(null)
  const [chosenDir, setChosenDir] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const timer = setTimeout(() => {
      const wanted = name.trim() === '' ? 'DAO archive' : name.trim()
      void getApi()
        .suggestArchivePath(wanted)
        .then((result) => {
          if (!cancelled && result.ok) setSuggested(result.value)
        })
    }, 200)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [name])

  const targetDir = chosenDir ?? suggested

  /** The folder picker, with "the member closed it" told apart from a failure. */
  const askForFolder = useCallback(async (title: string): Promise<string | null> => {
    const chosen = await getApi().pickDirectory({ title })
    if (!chosen.ok) {
      setProblem(chosen.error)
      return null
    }
    return chosen.value
  }, [])

  /*
   * `archive.create` / `archive.open` publish to the store but only report
   * success as a boolean, and the snapshot on this render's controller is the
   * one from *before* the call. So the engine is called directly for the value
   * and `archive.set` — a module-level function, never stale — publishes it.
   */
  const startNew = useCallback(async () => {
    setProblem(null)
    setWorking(true)
    try {
      /*
       * The folder is ours to make. Asking a member to "choose an empty folder"
       * makes them understand why emptiness matters before they know what an
       * archive is — and it was the very first thing the app demanded of them.
       * A location is proposed instead, and changing it is the option.
       */
      const dir = targetDir ?? (await askForFolder('Choose where to keep this archive'))
      if (dir === null) return
      const created = await getApi().createArchive(
        dir,
        name.trim() === '' ? 'DAO archive' : name.trim()
      )
      if (!created.ok) {
        setProblem(created.error)
        return
      }
      archive.set(created.value)
      onOpened(created.value, true)
    } finally {
      setWorking(false)
    }
  }, [archive, askForFolder, name, onOpened, targetDir])

  const openExisting = useCallback(async () => {
    setProblem(null)
    setWorking(true)
    try {
      const dir = await askForFolder('Choose an archive folder')
      if (dir === null) return
      const reopened = await getApi().openArchive(dir)
      if (!reopened.ok) {
        setProblem(reopened.error)
        return
      }
      archive.set(reopened.value)
      onOpened(reopened.value, false)
    } finally {
      setWorking(false)
    }
  }, [archive, askForFolder, onOpened])

  const onVerdict = useCallback((status: DriftStatus | null) => {
    setDriftIsBehind(status?.verdict === 'behind')
  }, [])

  return (
    <div className="welcome">
      {/*
        Above everything, including the app's own title: a member whose copy has
        gone stale is serving last month's archive to the world, and that is more
        urgent than anything else this screen has to say.
      */}
      <DriftBanner onVerdict={onVerdict} />

      <div>
        <h1 className="welcome-title">BIC Archiver</h1>
      </div>

      {problem !== null && (
        <Banner tone="danger" title="That did not work">
          {problem}
        </Banner>
      )}

      {/*
        First, above the archive cards. Helping BIC's archive survive is the one
        thing on this screen that matters to somebody other than the person
        looking at it, and it is the only thing most members will ever need to
        do — so it should not be reachable only by scrolling past two cards
        about making an archive of their own.
      */}
      <KeepArchiveAlive
        driftIsBehind={driftIsBehind}
        onOpenSettings={onOpenSettings}
        onOpened={onOpened}
        {...(onReclaim === undefined ? {} : { onReclaim })}
      />

      <div className="choice-grid">
        {/*
          No accent. Starting an archive of your own is a perfectly good thing
          to do, but it is not what most members came here for — the card above
          is. Two accented cards would just mean neither reads as the answer.
        */}
        <section className="choice">
          <h2 className="choice-title">Start a new archive</h2>
          <p className="choice-why">
            An archive is just a folder on this computer. Everything downloaded is kept inside it,
            so you can close the app and pick up where you left off.
          </p>
          <div className="field">
            <label className="field-label" htmlFor="archive-name">
              Give it a name
            </label>
            <input
              id="archive-name"
              className="input"
              type="text"
              value={name}
              placeholder="DAO archive"
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !working) void startNew()
              }}
            />
            <p className="field-hint">Used for the folder listing and the backup file name.</p>
          </div>
          {targetDir !== null && (
            <p className="field-hint welcome-target">
              It will be created here:{' '}
              <code className="welcome-target-path" title={targetDir}>
                {targetDir}
              </code>
            </p>
          )}
          <div className="choice-foot">
            <button
              type="button"
              className="btn btn-primary btn-lg btn-block"
              onClick={() => void startNew()}
              disabled={working}
            >
              Create the archive
            </button>
            <button
              type="button"
              className="btn btn-sm btn-quiet btn-block"
              onClick={() => {
                void (async () => {
                  const picked = await askForFolder('Choose where to keep this archive')
                  if (picked !== null) setChosenDir(picked)
                })()
              }}
              disabled={working}
            >
              Put it somewhere else…
            </button>
          </div>
        </section>

        <section className="choice">
          <h2 className="choice-title">Open an archive you made earlier</h2>
          <p className="choice-why">
            Point at the folder you used last time. Everything in it — the NFTs, the downloaded
            files and the fingerprint — comes back exactly as you left it.
          </p>
          <div className="choice-foot">
            <button
              type="button"
              className="btn btn-lg btn-block"
              onClick={() => void openExisting()}
              disabled={working}
            >
              Choose the folder…
            </button>
          </div>
        </section>
      </div>

      <div className="row row-between">
        <p className="small muted grow">
          Settings is where your IPFS node, your Pinata key and automatic pinning live. You can set
          all of it up before you archive anything.
        </p>
        <div className="row">
          {onOpenHelp !== undefined && (
            <button type="button" className="btn" onClick={onOpenHelp}>
              What is all this?
            </button>
          )}
          <button type="button" className="btn" onClick={onOpenSettings}>
            Settings
          </button>
        </div>
      </div>

      {onCancel !== undefined && (
        <div className="row">
          <button type="button" className="btn" onClick={onCancel}>
            Never mind — go back
          </button>
        </div>
      )}

      <Card title="Why this matters">
        <ul className="bullets">
          <li>
            IPFS only keeps a file while somebody is offering it. When the last computer offering
            it switches off, the file is gone, and nothing anywhere sends up a flare.
          </li>
          <li>
            That has already happened to BIC. Of the 10,762 files in the last backup,{' '}
            <strong>428 were being offered by nobody at all</strong> — and 12 artworks existed
            nowhere but a single file in a single Google Drive folder.
          </li>
          <li>
            It hit one kind of file hardest: the pieces BIC rescued from Arweave and old websites.
            Almost all of those were gone, against well under one in a hundred of the rest. Popular
            art is kept alive by strangers; BIC&rsquo;s rescues are kept alive by BIC.
          </li>
          <li>
            Which is the whole idea here. Every member running this is one more place the archive
            can come back from, and it costs you some disk space and nothing else.
          </li>
        </ul>
      </Card>

      <Card title="Who made this, and who to ask">
        <p className="card-lead">
          This app was written by Claude, Anthropic&rsquo;s AI, working with BIC. The code is open
          for anyone to read or check.
        </p>
        <p className="card-lead">
          If something does not work, or a word here does not make sense, tag{' '}
          <strong>@Path</strong> in the BIC Discord. No question is too basic — the app exists
          because this stuff is genuinely confusing, and being stuck is worth saying out loud
          rather than quietly giving up on.
        </p>
      </Card>
    </div>
  )
}
