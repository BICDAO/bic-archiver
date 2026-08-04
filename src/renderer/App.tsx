/**
 * The window: which archive is open, which screen is showing, and what the
 * engine is doing right now.
 *
 * Four decisions here are worth knowing about:
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
 *
 *  • Settings and Help are reachable with no archive open. They used to live
 *    only in the sidebar, and the sidebar only exists once an archive has been
 *    created — so a member could not set up their IPFS node until after they had
 *    archived something, which is the wrong way round. Both now render
 *    full-width over the welcome screen with a Back control, and the welcome
 *    screen offers a visible way in.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'

import type { ProgressEvent } from '../shared/types'
import type { ArchiveSnapshot } from '../preload'
import { useArchive, useProgress } from './hooks'

import { AddTokensView } from './components/AddTokensView'
import { ProgressList } from './components/ProgressList'
import ArchiveView from './components/ArchiveView'
import AssetsView from './components/AssetsView'
import DriftBanner from './components/DriftBanner'
import ExportView from './components/ExportView'
import GalleryView from './components/GalleryView'
import HealthView from './components/HealthView'
import Help from './components/Help'
import PinningSettings from './components/PinningSettings'
import Welcome from './components/Welcome'
import { formatCount } from './components/Layout'

/* ========================================================================== */
/* Navigation                                                                 */
/* ========================================================================== */

type ViewId =
  | 'add'
  | 'archive'
  | 'gallery'
  | 'assets'
  | 'health'
  | 'export'
  | 'settings'
  | 'help'

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
    /*
     * Directly after Archive on purpose. The Archive screen is a table of
     * content IDs; this is the same archive as the pictures it exists to save,
     * and a member who has just added 200 NFTs wants to see them, not to read
     * their hashes.
     */
    id: 'gallery',
    label: 'Gallery',
    icon: (
      <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" {...stroke}>
        <path d="M2.2 3.4h11.6v9.2H2.2z" />
        <circle cx="5.7" cy="6.5" r="1.1" />
        <path d="m2.6 12.2 3.5-3.5 2 2 2-2.3 3.3 3.8" />
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
 * Settings and Help sit apart from the rest, at the foot of the sidebar.
 * Neither is a step in the job — a member goes to Settings once to say where
 * content should be pinned, and to Help when a word on screen means nothing to
 * them — so putting either in the run of screens would imply it is something you
 * do every time.
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

const HELP: NavEntry = {
  id: 'help',
  label: 'Help',
  icon: (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" {...stroke}>
      <circle cx="8" cy="8" r="6.2" />
      <path d="M6.2 6.3a1.8 1.8 0 1 1 2.5 1.66c-.5.22-.76.66-.76 1.15v.24" />
      <path d="M8 11.6h.01" />
    </svg>
  )
}

const SECONDARY_NAV: NavEntry[] = [SETTINGS, HELP]

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
/* A screen with no archive behind it                                         */
/* ========================================================================== */

/**
 * Settings or Help, shown over the welcome screen when no archive is open.
 *
 * There is no sidebar to go back to at this point, so the Back control is the
 * only way out and has to be the first thing on the screen. The two stacked
 * `.view` wrappers line up because both centre themselves at the same width.
 */
function StandaloneScreen({
  onBack,
  children
}: {
  onBack: () => void
  children: ReactNode
}): ReactNode {
  return (
    <>
      <div className="view" style={{ gap: 0, paddingBottom: 22 }}>
        <div className="row">
          <button type="button" className="btn" onClick={onBack}>
            ← Back to the start
          </button>
        </div>
      </div>
      {children}
    </>
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
   * Every screen shares one scrolling column, so without this a member who
   * clicks Settings from the foot of the welcome screen arrives half-way down
   * Settings — which, since the top of that screen is then empty, reads as a
   * window that has failed to draw. Changing screen puts you at the top of it.
   *
   * Both are needed. With an archive open the sidebar pins the window and the
   * `.main-scroll` column does the scrolling; with no archive open that column
   * is the whole page and it is the document that scrolls, so resetting only the
   * element would silently do nothing on precisely the screen that needs it.
   */
  const scrollRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 })
    window.scrollTo({ top: 0 })
  }, [view, switching, hasArchive])

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

  /*
   * Opening a different archive replaces the whole window with the welcome
   * screen. Settings and Help render *over* that screen, so a member sitting on
   * one of them would be shown it again instead of the archive picker they just
   * asked for.
   */
  const switchArchive = useCallback(() => {
    setSwitching(true)
    setView((current) => (current === 'settings' || current === 'help' ? 'archive' : current))
  }, [])

  const leaveStandalone = useCallback(() => {
    setView('archive')
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
    /*
     * No archive — or one open that the member is replacing. Settings comes
     * first because setting up an IPFS node before archiving anything is a
     * perfectly reasonable order to work in, and until now the app made it
     * impossible.
     */
    return (
      <div className="main-scroll" ref={scrollRef}>
        {view === 'settings' ? (
          <StandaloneScreen onBack={leaveStandalone}>
            <PinningSettings />
          </StandaloneScreen>
        ) : view === 'help' ? (
          <StandaloneScreen onBack={leaveStandalone}>
            <Help />
          </StandaloneScreen>
        ) : (
          <Welcome
            onOpened={opened}
            onOpenSettings={() => setView('settings')}
            onOpenHelp={() => setView('help')}
            onCancel={snapshot === null ? undefined : () => setSwitching(false)}
          />
        )}
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
          {SECONDARY_NAV.map((entry) => (
            <NavButton
              key={entry.id}
              entry={entry}
              current={view === entry.id}
              onSelect={setView}
            />
          ))}
        </nav>

        <div className="sidebar-foot">
          <button type="button" className="btn btn-sm" onClick={switchArchive}>
            Open a different archive
          </button>
          <p className="small faint">
            Everything downloaded is stored inside the folder above, addressed by content, so it can
            be verified later.
          </p>
        </div>
      </aside>

      <main className="main">
        <div className="main-scroll" ref={scrollRef}>
          <div hidden={view !== 'add'}>
            <AddTokensView onAdded={() => setView('archive')} onNeedArchive={switchArchive} />
          </div>
          <div hidden={view !== 'archive'}>
            <ArchiveView
              snapshot={snapshot}
              onSnapshot={archive.set}
              onAddTokens={() => setView('add')}
            />
          </div>
          <div hidden={view !== 'gallery'}>
            {/*
              `active` is deliberately not passed. Every screen stays mounted
              behind `hidden`, so the gallery loads itself the first time it is
              actually looked at rather than reading 20,808 files' worth of
              metadata on start-up for a member who never opens it.
            */}
            <GalleryView
              snapshot={snapshot}
              onAddTokens={() => setView('add')}
              onCheckHealth={() => setView('health')}
            />
          </div>
          <div hidden={view !== 'assets'}>
            {/*
              The drift notice sits above Assets as well as on the welcome
              screen. Assets is where a member goes to ask "is this content
              safe?", and a stale copy of BIC's archive is exactly that question
              — but they have no reason to return to the welcome screen once an
              archive is open, so it has to be visible from inside the app too.
            */}
            <div className="view" style={{ marginBottom: 22 }}>
              <DriftBanner />
            </div>
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
          <div hidden={view !== 'help'}>
            <Help />
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
 * re-renders on every event a run produces, which must not drag the mounted
 * screens (one of them a long table, another a grid of pictures) through a
 * re-render with it.
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
