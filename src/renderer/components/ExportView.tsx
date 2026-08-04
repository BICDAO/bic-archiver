/**
 * Getting the archive out of the app, and other people's backups into it.
 *
 * There are two honest ways to hand this content to somebody else and they are
 * not equivalent, so both are offered side by side with the trade-off written
 * on the card rather than buried in a manual:
 *
 *   .car             keeps the IPFS file attributes, so the original content
 *                    IDs can be reproduced exactly. This is a real backup.
 *   browsable folder ordinary files anyone can open, but the IPFS attributes
 *                    are gone, so the hashes cannot be reproduced from it.
 *
 * A member who does not know what a content ID is still needs to pick the right
 * one, which is why "recommended" is on the card and the reason is one line
 * long.
 */

import { useCallback, useState, type ReactNode } from 'react'

import type { ArchiveSnapshot } from '../../preload'
import { Cid } from './Cid'
import {
  Banner,
  Card,
  OperationStatus,
  ViewHeader,
  formatBytes,
  formatCount,
  useOperation
} from './Layout'

/*
 * This screen used to end with a button to storacha.network, described as a
 * service that "accepts .car files directly". It is gone: `up.storacha.network`,
 * `console.storacha.network` and `access.storacha.network` have no DNS records
 * at all, and the apex now redirects elsewhere. Sending a member there would be
 * sending them to nothing — and worse, telling them the backup was safe once
 * they got there.
 *
 * The honest answer now lives inside the app, in two steps: Settings, for the
 * local IPFS (Kubo) node and the Pinata key, then Assets ▸ Pin everything. No
 * external pinning link belongs on this screen, and not only because the last
 * one rotted. Handing a .car to a service is not what puts content back: asking
 * a service to pin a content ID asks it to go and *find* that content, which
 * cannot work for the files this archive exists to rescue, because nobody is
 * offering them any more. A node here holding the backup is what makes them
 * fetchable again, and `manager.ts` passes that node's multiaddrs to Pinata as
 * `hostNodes` so Pinata fetches from it. See docs/PINNING.md §2 and §3.
 */

/* ========================================================================== */
/* Reveal-in-folder                                                           */
/* ========================================================================== */

function RevealButton({ path, children }: { path: string; children: ReactNode }): ReactNode {
  const [problem, setProblem] = useState<string | null>(null)

  const reveal = useCallback(() => {
    setProblem(null)
    void window.api.openPath(path).then((result) => {
      if (!result.ok) setProblem(result.error)
    })
  }, [path])

  return (
    <>
      <button type="button" className="btn btn-sm" onClick={reveal}>
        {children}
      </button>
      {problem !== null && <span className="small muted">{problem}</span>}
    </>
  )
}

/* ========================================================================== */
/* The view                                                                   */
/* ========================================================================== */

export interface ExportViewProps {
  snapshot: ArchiveSnapshot
  onSnapshot: (snapshot: ArchiveSnapshot) => void
  /**
   * Take the member to the Assets screen, where the backup is actually pinned.
   * Optional, and degrades to plain words rather than a dead button — same
   * contract as `HealthView`'s `onExport`.
   */
  onOpenAssets?: () => void
  /**
   * Take the member to Settings, which is where the node and the Pinata key are
   * set up — the step before Assets can do anything. Optional on the same terms.
   */
  onOpenSettings?: () => void
}

export default function ExportView({
  snapshot,
  onSnapshot,
  onOpenAssets,
  onOpenSettings
}: ExportViewProps): ReactNode {
  const carOp = useOperation()
  const folderOp = useOperation()
  const importOp = useOperation()
  const mergeOp = useOperation()

  const [carPath, setCarPath] = useState<string | null>(null)
  const [folderPath, setFolderPath] = useState<string | null>(null)
  const [importedRoots, setImportedRoots] = useState<readonly string[]>([])

  const manifest = snapshot.manifest
  const rootCid = manifest.rootCid
  const isEmpty = manifest.tokens.length === 0 && manifest.importedRoots.length === 0

  /* ---------------------------------------------------------------- */
  /* Export: the verifiable backup                                     */
  /* ---------------------------------------------------------------- */

  const saveCar = useCallback(async () => {
    const chosen = await window.api.saveCar({ title: 'Save the verifiable backup' })
    if (!chosen.ok) {
      carOp.fail(chosen.error)
      return
    }
    if (chosen.value === null) return // The member closed the save window.

    setCarPath(null)
    const path = chosen.value
    const result = await carOp.run({
      start: 'Writing the backup file…',
      body: (opId) => window.api.exportCar(path, opId),
      success: (value) =>
        `Backup saved — ${formatCount(value.blocks)} pieces, ${formatBytes(value.bytes)}. Keep this file somewhere safe, and keep a copy off this computer. The file on its own does not put the content back on IPFS — that is what Assets ▸ Pin everything does.`
    })
    if (result !== null) setCarPath(result.path)
  }, [carOp])

  /* ---------------------------------------------------------------- */
  /* Export: the browsable copy                                        */
  /* ---------------------------------------------------------------- */

  const saveFolder = useCallback(async () => {
    const chosen = await window.api.pickDirectory({
      title: 'Choose an empty folder for the browsable copy'
    })
    if (!chosen.ok) {
      folderOp.fail(chosen.error)
      return
    }
    if (chosen.value === null) return

    setFolderPath(null)
    const dir = chosen.value
    const result = await folderOp.run({
      start: 'Writing the files where you can open them…',
      body: (opId) => window.api.exportFolder(dir, opId),
      success: (value) =>
        `Saved ${formatCount(value.files)} files (${formatBytes(value.bytes)}). Remember that a plain folder does not carry the IPFS attributes — keep the .car backup as well.`
    })
    if (result !== null) setFolderPath(result.path)
  }, [folderOp])

  /* ---------------------------------------------------------------- */
  /* Import someone else's backup                                      */
  /* ---------------------------------------------------------------- */

  const readCar = useCallback(async () => {
    const chosen = await window.api.openCar({ title: 'Choose a .car backup to read' })
    if (!chosen.ok) {
      importOp.fail(chosen.error)
      return
    }
    if (chosen.value === null) return

    setImportedRoots([])
    const path = chosen.value
    const result = await importOp.run({
      start: 'Reading the backup file and checking every piece…',
      body: (opId) => window.api.importCar(path, opId),
      success: (value) =>
        value.roots.length === 0
          ? `Read ${formatCount(value.blocks)} pieces, but the file did not say what its contents are. If you know its content ID, add it from the Add NFTs screen instead.`
          : `Read ${formatCount(value.blocks)} pieces. Now add its contents to this archive using the button below.`
    })
    if (result !== null) {
      onSnapshot(result.snapshot)
      setImportedRoots(result.roots)
    }
  }, [importOp, onSnapshot])

  const merge = useCallback(
    async (cid: string) => {
      const trimmed = cid.trim()
      if (trimmed === '') {
        mergeOp.fail('Paste the content ID of the backup you want to add, then try again.')
        return
      }
      const result = await mergeOp.run({
        start: 'Looking for that backup and folding it into this archive…',
        body: (opId) => window.api.mergeExisting(trimmed, opId),
        success: () =>
          'That backup is now part of this archive, and everything you export from here includes it.'
      })
      if (result !== null) {
        onSnapshot(result.snapshot)
        setImportedRoots((previous) => previous.filter((root) => root !== trimmed))
      }
    },
    [mergeOp, onSnapshot]
  )

  /* ---------------------------------------------------------------- */

  /** Sidebar directions for whichever screen this view cannot navigate to. */
  const whereToFind =
    onOpenSettings === undefined && onOpenAssets === undefined
      ? 'Both are in the sidebar on the left — Assets in the run of screens, Settings at the foot of it.'
      : onOpenSettings === undefined
        ? 'Settings is at the foot of the sidebar on the left.'
        : onOpenAssets === undefined
          ? 'Assets is in the sidebar on the left.'
          : null

  return (
    <div className="view">
      <ViewHeader
        title="Export"
        lead="Save everything in this archive to a file you can keep, hand to another member, or read back into the app later. Putting the content back on IPFS is the step after this one, on Assets."
      />

      {isEmpty && (
        <Banner tone="warn" title="There is nothing to export yet">
          Add some NFTs first — or read in a backup file below — and then come back here.
        </Banner>
      )}

      {/* -------------------------------------------------------------- */}
      {/* The fingerprint                                                 */}
      {/* -------------------------------------------------------------- */}

      <Card
        title="This archive's fingerprint"
        lead="The one content ID that stands for everything in this archive. Anyone with it can fetch exactly these files, or check that a copy they already hold is identical."
      >
        {rootCid !== undefined ? (
          <div>
            <Cid cid={rootCid} label="archive fingerprint" head={16} tail={12} size="lg" />
          </div>
        ) : (
          <p className="muted">
            Not worked out yet — the contents have changed since the archive was last put together.
            Exporting will assemble it automatically, and the fingerprint will appear here
            afterwards.
          </p>
        )}
      </Card>

      {/* -------------------------------------------------------------- */}
      {/* The two ways out                                                */}
      {/* -------------------------------------------------------------- */}

      <div className="choice-grid">
        <section className="choice choice-recommended">
          <div className="row">
            <h2 className="choice-title grow">Export .car backup</h2>
            <span className="pill pill-info">
              <span className="pill-dot" aria-hidden="true" />
              Recommended
            </span>
          </div>
          <p className="choice-why">
            A single file that preserves the IPFS file attributes needed to reproduce the original
            file hashes — so the content IDs in this archive can always be proved again, by anyone.
          </p>
          <ul className="bullets small">
            <li>Restore it into this app, or hand it to another member.</li>
            <li>Import it into your own IPFS node, from Assets, to put the content back online.</li>
            <li>Not something you can browse by double-clicking — that is the other option.</li>
          </ul>
          <div className="choice-foot stack">
            <button
              type="button"
              className="btn btn-primary btn-lg"
              onClick={() => void saveCar()}
              disabled={carOp.busy || isEmpty}
            >
              Choose where to save…
            </button>
            <OperationStatus op={carOp} stopLabel="Stop saving">
              {carPath !== null && <RevealButton path={carPath}>Show in folder</RevealButton>}
            </OperationStatus>
          </div>
        </section>

        <section className="choice">
          <h2 className="choice-title">Export browsable folder</h2>
          <p className="choice-why">
            Ordinary folders and files you can open by double-clicking, and share with anyone.{' '}
            <strong>
              It does not preserve the IPFS file attributes, so the original file hashes cannot be
              reproduced from it.
            </strong>{' '}
            Use it to look at the content — not as your only backup.
          </p>
          <ul className="bullets small">
            <li>One folder per NFT, with its description file and its pictures.</li>
            <li>Pick an empty folder — the files are written straight into it.</li>
          </ul>
          <div className="choice-foot stack">
            <button
              type="button"
              className="btn btn-lg"
              onClick={() => void saveFolder()}
              disabled={folderOp.busy || isEmpty}
            >
              Choose a folder…
            </button>
            <OperationStatus op={folderOp} stopLabel="Stop saving">
              {folderPath !== null && <RevealButton path={folderPath}>Show in folder</RevealButton>}
            </OperationStatus>
          </div>
        </section>
      </div>

      {/* -------------------------------------------------------------- */}
      {/* Keeping it online                                               */}
      {/* -------------------------------------------------------------- */}

      <Card title="Keeping the backup online">
        <p className="muted">
          A .car file on your own computer protects the content, but it does not put it back on
          IPFS. Nothing on the network is serving these files until somebody pins them — and the
          content this archive rescued from Arweave and old websites is precisely the content
          nobody else is keeping.
        </p>
        <p className="small muted">
          Asking a pinning service to keep a content ID asks it to go and <em>find</em> that
          content somewhere on the network and copy it. For something people are still sharing that
          works. For something that has already gone quiet there is nothing to find, and the
          request simply expires — which is why no service, on its own, can rescue the files this
          archive was made for. What can is an IPFS node on this computer with the backup imported
          into it: that makes those content IDs fetchable again, and the app passes your node&rsquo;s
          addresses to Pinata itself, so Pinata collects from you instead of searching.
        </p>
        <ul className="bullets small">
          <li>
            <strong>Settings</strong> — point the app at your own IPFS node (a free program, no
            account), and paste a Pinata key if the DAO has one. Pinata is what keeps the content
            up while this computer is switched off.
          </li>
          <li>
            <strong>Assets</strong> ▸ <strong>Pin everything</strong> — imports the backup into
            your node, asks Pinata to fetch it from there, and then checks that it really arrived.
          </li>
        </ul>
        <p className="small muted">
          Saving the .car and stopping there is how content goes quietly dark — in the DAO&rsquo;s
          real May 2026 backup, 428 content IDs had already gone that way.
        </p>
        {(onOpenSettings !== undefined || onOpenAssets !== undefined) && (
          <div className="row">
            {onOpenSettings !== undefined && (
              <button type="button" className="btn btn-primary" onClick={onOpenSettings}>
                Set up pinning in Settings
              </button>
            )}
            {onOpenAssets !== undefined && (
              <button type="button" className="btn" onClick={onOpenAssets}>
                Go to Assets
              </button>
            )}
          </div>
        )}
        {/* Whatever the window did not hand us a way to reach, say where it is
            instead. A member told to open a screen that has no button and no
            address is a member who stops here. */}
        {whereToFind !== null && <p className="small muted">{whereToFind}</p>}
      </Card>

      {/* -------------------------------------------------------------- */}
      {/* Restoring                                                       */}
      {/* -------------------------------------------------------------- */}

      <Card
        title="Restore from a backup"
        lead="Read a .car file another member made — every piece is hash-checked as it is read — and then fold its contents into this archive."
      >
        <div className="row">
          <button
            type="button"
            className="btn"
            onClick={() => void readCar()}
            disabled={importOp.busy}
          >
            Choose a .car file…
          </button>
        </div>
        <OperationStatus op={importOp} stopLabel="Stop reading" />

        {importedRoots.length > 0 && (
          <div className="stack stack-sm">
            <p className="small muted">
              That file contained {importedRoots.length === 1 ? 'this backup' : 'these backups'}. Add{' '}
              {importedRoots.length === 1 ? 'it' : 'them'} to this archive so{' '}
              {importedRoots.length === 1 ? 'its' : 'their'} contents are included in everything you
              export from now on.
            </p>
            {importedRoots.map((root) => (
              <div className="row" key={root}>
                <Cid cid={root} label="backup content ID" head={12} tail={8} />
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  onClick={() => void merge(root)}
                  disabled={mergeOp.busy}
                >
                  Add to this archive
                </button>
              </div>
            ))}
          </div>
        )}

        <OperationStatus op={mergeOp} stopLabel="Stop looking" />

        <p className="small muted">
          Only have the content ID of an older backup, not a file? Paste it on the{' '}
          <strong>Add NFTs</strong> screen, under &ldquo;Already have an older backup?&rdquo; — it
          can check whether the content is still online before you wait for it.
        </p>
      </Card>
    </div>
  )
}
