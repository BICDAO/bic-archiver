/**
 * The window: which archive is open, which screen is showing, and what the
 * engine is doing right now.
 *
 * Three decisions here are worth knowing about:
 *
 *  • Every screen stays mounted once an archive is open, hidden rather than
 *    unmounted. Archiving 200 tokens takes a while, and a member who clicks
 *    "Health" half-way through must not come back to a screen that has
 *    forgotten the run was ever happening. The same goes for a pin run started
 *    from Assets: it keeps going while its screen is out of sight.
 *
 *  • The open archive comes from the shared store in `hooks.ts`, not from state
 *    kept here. Both halves of the window read it, so a token added on the Add
 *    NFTs screen is in the Archive table without anything having to be told.
 *    Calls that change the archive hand back a fresh snapshot, and views pass it
 *    to `archive.set`.
 *
 *  • On top of that, the manifest is re-read shortly after any job reports that
 *    it has finished. The engine writes each token to disk the moment it lands,
 *    so re-reading is the only way to be certain the sidebar count and the
 *    Archive table match what is actually saved.
 */

import { useCallback, useEffect, useState, type ReactNode } from 'react'

import type { ProgressEvent } from '../shared/types'
import type { ArchiveSnapshot } from '../preload'
import { useArchive, useProgress } from './hooks'

import { AddTokensView } from './components/AddTokensView'
import { ProgressList } from './components/ProgressList'
import ArchiveView from './components/ArchiveView'
import AssetsView from './components/AssetsView'
import ExportView from './components/ExportView'
import HealthView from './components/HealthView'
import PinningSettings from './components/PinningSettings'
import { Banner, Card, formatCount } from './components/Layout'

/* ========================================================================== */
/* Navigation                                                                 */
/* ========================================================================== */

type ViewId = 'add' | 'archive' | 'assets' | 'health' | 'export' | 'settings'

interface NavEntry {
  id: ViewId
  label: string
  icon: ReactNode
}

const stroke = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const
}

const NAV: NavEntry[] = [
  {
    id: 'add',
    label: 'Add NFTs',
    icon: (
      <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" {...stroke}>
        <circle cx="8" cy="8" r="6.2" />
        <path d="M8 5.2v5.6M5.2 8h5.6" />
      </svg>
    )
  },
  {
    id: 'archive',
    label: 'Archive',
    icon: (
      <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" {...stroke}>
        <path d="M2 5.2h12v8.3H2z" />
        <path d="M1.4 2.6h13.2v2.6H1.4zM6.4 8.2h3.2" />
      </svg>
    )
  },
  {
    id: 'assets',
    label: 'Assets',
    icon: (
      <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" {...stroke}>
        <path d="M2.6 5.6 8 2.8l5.4 2.8L8 8.4 2.6 5.6Z" />
        <path d="M2.6 8.9 8 11.7l5.4-2.8" />
        <path d="M2.6 11.6 8 14.4l5.4-2.8" />
      </svg>
    )
  },
  {
    id: 'health',
    label: 'Health',
    icon: (
      <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" {...stroke}>
        <path d="M1.4 8h3l1.6-3.6L8.8 12l1.7-4h3.1" />
      </svg>
    )
  },
  {
    id: 'export',
    label: 'Export',
    icon: (
      <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" {...stroke}>
        <path d="M8 10.6V2.2M4.9 5.3 8 2.2l3.1 3.1" />
        <path d="M2.4 9.8v3.6h11.2V9.8" />
      </svg>
    )
  }
]

/**
 * Settings sits apart from the rest, at the foot of the sidebar. It is not a
 * step in the job — a member goes there once to say where content should be
 * pinned, and then rarely again — so putting it in the run of screens would
 * imply it is something you do every time.
 */
const SETTINGS: NavEntry = {
  id: 'settings',
  label: 'Settings',
  icon: (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" {...stroke}>
      <path d="M2.4 4.6h11.2M2.4 8h11.2M2.4 11.4h11.2" />
      <circle cx="5.8" cy="4.6" r="1.5" />
      <circle cx="10.2" cy="8" r="1.5" />
      <circle cx="5.8" cy="11.4" r="1.5" />
    </svg>
  )
}

function NavButton({
  entry,
  current,
  count,
  onSelect
}: {
  entry: NavEntry
  current: boolean
  /** Shown as a badge when there is something worth counting. */
  count?: number
  onSelect: (id: ViewId) => void
}): ReactNode {
  return (
    <button
      type="button"
      className="nav-item"
      aria-current={current ? 'page' : undefined}
      onClick={() => onSelect(entry.id)}
    >
      <span className="nav-icon">{entry.icon}</span>
      <span className="nav-label">{entry.label}</span>
      {count !== undefined && <span className="nav-count">{formatCount(count)}</span>}
    </button>
  )
}

/* ========================================================================== */
/* The shell                                                                  */
/* ========================================================================== */

export default function App(): ReactNode {
  const archive = useArchive()
  const [switching, setSwitching] = useState(false)
  const [view, setView] = useState<ViewId>('archive')

  const snapshot = archive.snapshot
  const booting = !archive.ready
  const hasArchive = snapshot !== null

  /*
   * Whenever a job reports that it has finished — anywhere in the window,
   * including the parts this file does not own — re-read the manifest. The
   * delay coalesces the burst of `done` events a multi-token run produces into
   * a single read.
   */
  useEffect(() => {
    if (!hasArchive) return
    let timer: ReturnType<typeof setTimeout> | null = null

    const unsubscribe = window.api.onProgress((event: ProgressEvent) => {
      if (event.phase !== 'done' && event.phase !== 'error') return
      if (timer !== null) return
      timer = setTimeout(() => {
        timer = null
        void archive.refresh()
      }, 700)
    })

    return () => {
      unsubscribe()
      if (timer !== null) clearTimeout(timer)
    }
  }, [hasArchive, archive])

  const opened = useCallback((next: ArchiveSnapshot, isNew: boolean) => {
    setSwitching(false)
    setView(isNew || next.manifest.tokens.length === 0 ? 'add' : 'archive')
  }, [])

  if (booting) {
    return (
      <div className="main-scroll">
        <div className="welcome">
          <p className="muted">Opening BIC Archiver…</p>
        </div>
      </div>
    )
  }

  if (snapshot === null || switching) {
    return (
      <div className="main-scroll">
        <ChooseArchive
          onOpened={opened}
          onCancel={snapshot === null ? undefined : () => setSwitching(false)}
        />
      </div>
    )
  }

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-name">BIC Archiver</span>
          <span className="brand-sub">NFT backups</span>
        </div>

        <div className="archive-card">
          <div className="archive-card-label">Open archive</div>
          <div className="archive-card-name">{snapshot.manifest.name}</div>
          <div className="archive-card-path" title={snapshot.dir}>
            {snapshot.dir}
          </div>
        </div>

        <nav className="nav" aria-label="Sections">
          {NAV.map((entry) => (
            <NavButton
              key={entry.id}
              entry={entry}
              current={view === entry.id}
              onSelect={setView}
              count={
                entry.id === 'archive' && snapshot.manifest.tokens.length > 0
                  ? snapshot.manifest.tokens.length
                  : undefined
              }
            />
          ))}
        </nav>

        <nav className="nav nav-secondary" aria-label="App settings">
          <NavButton entry={SETTINGS} current={view === SETTINGS.id} onSelect={setView} />
        </nav>

        <div className="sidebar-foot">
          <button type="button" className="btn btn-sm" onClick={() => setSwitching(true)}>
            Open a different archive
          </button>
          <p className="small faint">
            Everything downloaded is stored inside the folder above, addressed by content, so it can
            be verified later.
          </p>
        </div>
      </aside>

      <main className="main">
        <div className="main-scroll">
          <div hidden={view !== 'add'}>
            <AddTokensView
              onAdded={() => setView('archive')}
              onNeedArchive={() => setSwitching(true)}
            />
          </div>
          <div hidden={view !== 'archive'}>
            <ArchiveView
              snapshot={snapshot}
              onSnapshot={archive.set}
              onAddTokens={() => setView('add')}
            />
          </div>
          <div hidden={view !== 'assets'}>
            {/*
              `AssetsView` is written elsewhere and asks for one thing: the open
              archive. Everything else it shows — the rows, their health, their
              pin state at each target — it gets from `pin:assets` itself,
              because only the main process can tell that a row recorded as
              `bafybei…` and a pin recorded as `Qm…` are the same content.

              The three optional props are the shell's job, so they are all
              passed. Without `onOpenSettings` its "nothing is set up to keep
              this content" banner explains the problem and then offers no way
              to fix it; and `onSnapshot` matters because assembling the archive
              from that screen writes a new root that the sidebar count and the
              Archive table would otherwise not hear about.
            */}
            <AssetsView
              snapshot={snapshot}
              onOpenSettings={() => setView('settings')}
              onAddTokens={() => setView('add')}
              onSnapshot={archive.set}
            />
          </div>
          <div hidden={view !== 'health'}>
            <HealthView snapshot={snapshot} onExport={() => setView('export')} />
          </div>
          <div hidden={view !== 'export'}>
            {/*
              Export ends by telling the member that a .car is not a pin, and
              that the fix is Settings first (node, key) and then Assets. Both
              routes are handed over so that advice is a button rather than an
              instruction to go and find something.
            */}
            <ExportView
              snapshot={snapshot}
              onSnapshot={archive.set}
              onOpenAssets={() => setView('assets')}
              onOpenSettings={() => setView('settings')}
            />
          </div>
          <div hidden={view !== 'settings'}>
            <PinningSettings />
          </div>
        </div>

        {/*
          A running job stays visible whichever screen the member is on. The Add
          NFTs screen shows this same panel itself — and keeps the finished rows
          as its record of the run — so the shell does not repeat it there.
        */}
        {view !== 'add' && <ActivityStrip />}
      </main>
    </div>
  )
}

/* ========================================================================== */
/* What is happening right now                                                */
/* ========================================================================== */

/**
 * The foot of the window, while — and only while — something is running.
 *
 * Two reasons this is its own component rather than part of `App`. It keeps the
 * strip out of the way once a job is done, instead of leaving a panel of
 * finished rows wedged across the bottom of every screen; and `useProgress`
 * re-renders on every event a run produces, which must not drag four mounted
 * screens (one of them a long table) through a re-render with it.
 */
function ActivityStrip(): ReactNode {
  const progress = useProgress()
  if (!progress.busy) return null
  return (
    <div className="activity">
      <ProgressList title="What's happening" />
    </div>
  )
}

/* ========================================================================== */
/* First run                                                                  */
/* ========================================================================== */

/**
 * An archive is a folder on the member's own computer. Saying that plainly here
 * is the difference between "why is it asking me for a folder?" and knowing
 * where your backup actually lives.
 */
function ChooseArchive({
  onOpened,
  onCancel
}: {
  onOpened: (snapshot: ArchiveSnapshot, isNew: boolean) => void
  onCancel?: () => void
}): ReactNode {
  const archive = useArchive()
  const [name, setName] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const [working, setWorking] = useState(false)

  /** The folder picker, with "the member closed it" told apart from a failure. */
  const askForFolder = useCallback(async (title: string): Promise<string | null> => {
    const chosen = await window.api.pickDirectory({ title })
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
      const dir = await askForFolder('Choose an empty folder to keep this archive in')
      if (dir === null) return
      const created = await window.api.createArchive(
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
  }, [archive, askForFolder, name, onOpened])

  const openExisting = useCallback(async () => {
    setProblem(null)
    setWorking(true)
    try {
      const dir = await askForFolder('Choose an archive folder')
      if (dir === null) return
      const reopened = await window.api.openArchive(dir)
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

  return (
    <div className="welcome">
      <div>
        <h1 className="welcome-title">BIC Archiver</h1>
        <p className="welcome-lead">
          Paste a contract address and this app reads the NFTs off the blockchain, downloads
          everything they point at, and saves it as a backup that can be checked by anyone — no IPFS
          software to install, no hashes to copy by hand.
        </p>
      </div>

      {problem !== null && (
        <Banner tone="danger" title="That did not work">
          {problem}
        </Banner>
      )}

      <div className="choice-grid">
        <section className="choice choice-recommended">
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
          <div className="choice-foot">
            <button
              type="button"
              className="btn btn-primary btn-lg btn-block"
              onClick={() => void startNew()}
              disabled={working}
            >
              Choose an empty folder…
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

      {onCancel !== undefined && (
        <div className="row">
          <button type="button" className="btn" onClick={onCancel}>
            Never mind — go back
          </button>
        </div>
      )}

      <Card title="What this app is doing for you">
        <ul className="bullets">
          <li>Reads the token's description straight from the contract, proxies and all.</li>
          <li>
            Decodes descriptions that are stored on the blockchain itself, instead of you pasting
            them into a decoder.
          </li>
          <li>
            Downloads every file in a way that keeps its original IPFS content ID — and, when the
            content has to be rescued from an ordinary gateway, works the original ID out again and
            tells you whether it matched.
          </li>
          <li>Warns you when content has fallen off the network, instead of failing silently.</li>
        </ul>
      </Card>
    </div>
  )
}
