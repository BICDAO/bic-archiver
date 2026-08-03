/**
 * What is actually in this archive.
 *
 * The manual process this app replaces produced a folder tree that nobody could
 * check: you could see files, but not whether the content IDs still matched the
 * ones the contract points at. This screen is the answer to "did it work?" —
 * per token, per file, with the original content ID and whether it survived.
 */

import { useCallback, useMemo, useState, type ReactNode } from 'react'

import type { ArchivedToken, FetchedResource, TokenRef } from '../../shared/types'
import type { ArchiveSnapshot } from '../../preload'
import { Cid } from './Cid'
import {
  Banner,
  Card,
  EmptyState,
  OperationStatus,
  Pill,
  ViewHeader,
  describeSource,
  formatBytes,
  formatCount,
  formatWhen,
  roleLabel,
  useOperation,
  type Tone
} from './Layout'

/**
 * Used only for the "View" links beside a file's content ID, which open in the
 * member's own browser. The archive itself never depends on a gateway — the
 * files are already on disk — so a link that 404s means "this is not on the
 * public network right now", which is exactly what the Health screen is for.
 */
const IPFS_GATEWAY = 'https://ipfs.io'

/* ========================================================================== */
/* Reading a token                                                            */
/* ========================================================================== */

export function tokenKey(ref: TokenRef): string {
  return `${ref.chainId}:${ref.contract.toLowerCase()}:${ref.tokenId}`
}

interface NamedResource {
  role: string
  resource: FetchedResource
}

/** Everything stored for one token, description file first. */
function resourcesOf(token: ArchivedToken): NamedResource[] {
  const list: NamedResource[] = []
  if (token.metadata !== undefined) list.push({ role: 'metadata', resource: token.metadata })
  for (const [role, resource] of Object.entries(token.assets ?? {})) {
    list.push({ role, resource })
  }
  return list
}

const STATUS_LOOK: Record<ArchivedToken['status'], { tone: Tone; label: string }> = {
  ok: { tone: 'ok', label: 'Saved' },
  partial: { tone: 'warn', label: 'Partly saved' },
  failed: { tone: 'danger', label: 'Not saved' }
}

/**
 * Did the files keep the exact content IDs the contract points at?
 *
 * This is the single most valuable fact on the screen. A backup whose IDs match
 * is provably the same content the NFT refers to; one that had to be rebuilt is
 * the same *bytes*, but anyone checking it against the contract will see a
 * different hash and has to be told why.
 */
function preservation(token: ArchivedToken): { tone: Tone; label: string; explain: string } {
  const addressed = resourcesOf(token).filter((entry) => entry.resource.originalCid !== undefined)
  if (addressed.length === 0) {
    return {
      tone: 'neutral',
      label: 'Not applicable',
      explain:
        'Nothing here was referred to by an IPFS content ID — it came from a website or straight off the blockchain — so there was no original ID to keep.'
    }
  }
  const rebuilt = addressed.filter((entry) => !entry.resource.cidPreserved)
  if (rebuilt.length === 0) {
    return {
      tone: 'ok',
      label: 'Kept',
      explain:
        'Every file kept the exact content ID the contract points at, so this backup can be checked against the contract by anyone.'
    }
  }
  return {
    tone: 'warn',
    label: `${rebuilt.length} rebuilt`,
    explain:
      'Some files had to be downloaded from an ordinary web gateway, which does not prove the ID. The content is saved, but its ID is not guaranteed to match the one in the contract — the rows below say which.'
  }
}

/** A token URI can be a megabyte of on-chain JSON; never put all of it on screen. */
function previewUri(raw: string): string {
  const flat = raw.replace(/\s+/g, ' ').trim()
  return flat.length > 160 ? `${flat.slice(0, 150)}…` : flat
}

function describeUriKind(token: ArchivedToken): string {
  switch (token.tokenUri.kind) {
    case 'ipfs':
      return 'IPFS'
    case 'arweave':
      return 'Arweave'
    case 'http':
      return 'A website'
    case 'data':
      return 'The blockchain itself'
    default:
      return 'Unknown'
  }
}

/* ========================================================================== */
/* The view                                                                   */
/* ========================================================================== */

export interface ArchiveViewProps {
  snapshot: ArchiveSnapshot
  onSnapshot: (snapshot: ArchiveSnapshot) => void
  /** Take the member to the Add NFTs screen. */
  onAddTokens: () => void
}

export default function ArchiveView({
  snapshot,
  onSnapshot,
  onAddTokens
}: ArchiveViewProps): ReactNode {
  const op = useOperation()
  const [openRows, setOpenRows] = useState<ReadonlySet<string>>(() => new Set<string>())
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null)

  const manifest = snapshot.manifest
  const tokens = manifest.tokens
  const rootCid = manifest.rootCid
  const importedRoots = manifest.importedRoots

  const toggleRow = useCallback((key: string) => {
    setOpenRows((previous) => {
      const next = new Set(previous)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  const build = useCallback(async () => {
    const result = await op.run({
      start: 'Putting the archive together…',
      body: (opId) => window.api.buildRoot(opId),
      success: () => 'The archive is assembled. Its fingerprint is below, and it is ready to save.'
    })
    if (result !== null) onSnapshot(result.snapshot)
  }, [op, onSnapshot])

  const remove = useCallback(
    async (token: ArchivedToken) => {
      setConfirmRemove(null)
      const result = await op.run({
        start: `Removing ${token.name}…`,
        body: () => window.api.removeToken(token.ref),
        success: () =>
          `${token.name} was removed. The archive will need assembling again before you save a backup.`
      })
      if (result !== null) onSnapshot(result)
    },
    [op, onSnapshot]
  )

  const counts = useMemo(() => {
    let ok = 0
    let partial = 0
    let failed = 0
    for (const token of tokens) {
      if (token.status === 'ok') ok += 1
      else if (token.status === 'partial') partial += 1
      else failed += 1
    }
    return { ok, partial, failed }
  }, [tokens])

  return (
    <div className="view">
      <ViewHeader
        title="Archive"
        lead="Everything this archive holds. Each NFT keeps its description file and its pictures exactly as the contract points at them, so the backup can be checked later by anyone."
        actions={
          <button type="button" className="btn" onClick={onAddTokens}>
            Add more NFTs
          </button>
        }
      />

      <OperationStatus op={op} />

      {/* -------------------------------------------------------------- */}
      {/* The archive's own fingerprint                                   */}
      {/* -------------------------------------------------------------- */}

      {tokens.length > 0 &&
        (rootCid !== undefined ? (
          <Card
            title="This archive's fingerprint"
            lead="One content ID that stands for everything below. Give it to another member and they can fetch the exact same files — or check that the backup they already have is identical."
            actions={
              <button type="button" className="btn" onClick={() => void build()} disabled={op.busy}>
                Rebuild
              </button>
            }
          >
            <div>
              <Cid cid={rootCid} label="archive fingerprint" head={16} tail={12} size="lg" />
            </div>
            <p className="small muted">
              This fingerprint describes the contents exactly as they are now. Add or remove
              anything and it changes — so assemble it again, and share the new one, whenever the
              archive changes.
            </p>
          </Card>
        ) : (
          <Banner
            tone="warn"
            title="Not assembled yet"
            actions={
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={() => void build()}
                disabled={op.busy}
              >
                Assemble now
              </button>
            }
          >
            The contents have changed since this archive was last put together, so it has no
            fingerprint right now. Assembling works one out from everything below; you need it
            before you can save a backup or check the archive's health.
          </Banner>
        ))}

      {/* -------------------------------------------------------------- */}
      {/* Contents                                                        */}
      {/* -------------------------------------------------------------- */}

      {tokens.length === 0 ? (
        <EmptyState
          title="Nothing archived yet"
          action={
            <button type="button" className="btn btn-primary btn-lg" onClick={onAddTokens}>
              Go to Add NFTs
            </button>
          }
        >
          Paste a contract address or an OpenSea link on the Add NFTs screen and the archiver will
          find the tokens, read their descriptions off the blockchain and download everything they
          point at.
        </EmptyState>
      ) : (
        <div className="stack">
          <div className="row row-between">
            <h2 className="card-title">
              {formatCount(tokens.length)} {tokens.length === 1 ? 'NFT' : 'NFTs'}
            </h2>
            <div className="row">
              {counts.ok > 0 && <Pill tone="ok">{formatCount(counts.ok)} saved</Pill>}
              {counts.partial > 0 && <Pill tone="warn">{formatCount(counts.partial)} partly saved</Pill>}
              {counts.failed > 0 && <Pill tone="danger">{formatCount(counts.failed)} not saved</Pill>}
            </div>
          </div>

          <div className="table-wrap">
            <table className="table">
              <caption className="sr-only">
                Every NFT in this archive, with how much of it was saved and whether the original
                IPFS content IDs were kept.
              </caption>
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Token</th>
                  <th scope="col">Saved</th>
                  <th scope="col">Files</th>
                  <th scope="col">Original ID</th>
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {tokens.map((token) => {
                  const key = tokenKey(token.ref)
                  const open = openRows.has(key)
                  const files = resourcesOf(token)
                  const kept = preservation(token)
                  const look = STATUS_LOOK[token.status]
                  const detailId = `detail-${key.replace(/[^a-zA-Z0-9]/g, '-')}`

                  return [
                    <tr key={key} className={open ? 'row-open' : undefined}>
                      <th scope="row">
                        <button
                          type="button"
                          className="expander"
                          aria-expanded={open}
                          aria-controls={detailId}
                          onClick={() => toggleRow(key)}
                        >
                          <span className="expander-caret" aria-hidden="true">
                            ▶
                          </span>
                          <span>
                            {token.name}
                            <span className="sr-only">
                              {open ? ' — hide the files' : ' — show the files'}
                            </span>
                          </span>
                        </button>
                      </th>
                      <td className="tabular nowrap">#{token.ref.tokenId}</td>
                      <td>
                        <Pill tone={look.tone}>{look.label}</Pill>
                      </td>
                      <td className="num">{formatCount(files.length)}</td>
                      <td>
                        <Pill tone={kept.tone}>{kept.label}</Pill>
                      </td>
                      <td className="nowrap">
                        {confirmRemove === key ? (
                          <span className="row">
                            <button
                              type="button"
                              className="btn btn-sm btn-danger"
                              onClick={() => void remove(token)}
                              disabled={op.busy}
                            >
                              Remove it
                            </button>
                            <button
                              type="button"
                              className="btn btn-sm btn-ghost"
                              onClick={() => setConfirmRemove(null)}
                            >
                              Keep
                            </button>
                          </span>
                        ) : (
                          <button
                            type="button"
                            className="btn btn-sm btn-ghost"
                            onClick={() => setConfirmRemove(key)}
                            disabled={op.busy}
                          >
                            Remove<span className="sr-only"> {token.name} from this archive</span>
                          </button>
                        )}
                      </td>
                    </tr>,

                    <tr key={`${key}-detail`} id={detailId} className="row-detail" hidden={!open}>
                      <td colSpan={6}>
                        <TokenDetail token={token} files={files} explain={kept.explain} />
                      </td>
                    </tr>
                  ]
                })}
              </tbody>
            </table>
          </div>

          <p className="small muted">
            <strong>Original ID</strong> says whether a file kept the exact IPFS content ID the
            contract points at. "Kept" means anyone can verify this backup against the contract.
            "Rebuilt" means the file was rescued from an ordinary gateway, so the content is right
            but its ID may differ — open the row to see which file, and why.
          </p>
        </div>
      )}

      {/* -------------------------------------------------------------- */}
      {/* Older backups folded in                                         */}
      {/* -------------------------------------------------------------- */}

      {importedRoots.length > 0 && (
        <Card
          title="Older backups added to this archive"
          lead="Content that came from a backup someone else made, rather than from the blockchain. It is part of this archive and is included in everything you export."
        >
          <ul className="stack stack-sm">
            {importedRoots.map((cid) => (
              <li key={cid}>
                <Cid cid={cid} label="backup content ID" head={12} tail={8} />
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  )
}

/* ========================================================================== */
/* One expanded row                                                           */
/* ========================================================================== */

function TokenDetail({
  token,
  files,
  explain
}: {
  token: ArchivedToken
  files: NamedResource[]
  explain: string
}): ReactNode {
  return (
    <div className="stack">
      <dl className="kv small">
        <dt>Contract</dt>
        <dd>
          <Cid cid={token.ref.contract} label="contract address" head={10} tail={8} />
        </dd>
        <dt>Description came from</dt>
        <dd>
          {describeUriKind(token)}
          {token.tokenUri.onchain && ' — stored entirely on-chain, so it cannot disappear'}
        </dd>
        <dt>Contract points at</dt>
        <dd className="input-mono" style={{ overflowWrap: 'anywhere' }}>
          {previewUri(token.tokenUri.raw)}
        </dd>
        <dt>Archived</dt>
        <dd>{formatWhen(token.archivedAt)}</dd>
      </dl>

      {token.errors.length > 0 && (
        <Banner tone={token.status === 'failed' ? 'danger' : 'warn'} title="What went wrong">
          <ul className="bullets">
            {token.errors.map((message, index) => (
              <li key={`${index}-${message.slice(0, 24)}`}>{message}</li>
            ))}
          </ul>
        </Banner>
      )}

      {files.length === 0 ? (
        <p className="small muted">Nothing was downloaded for this token.</p>
      ) : (
        <>
          <table className="subtable">
            <caption className="sr-only">Every file saved for {token.name}.</caption>
            <thead>
              <tr>
                <th scope="col">What it is</th>
                <th scope="col">Content ID</th>
                <th scope="col">Size</th>
                <th scope="col">Came from</th>
                <th scope="col">Original ID</th>
              </tr>
            </thead>
            <tbody>
              {files.map(({ role, resource }) => (
                <tr key={`${role}-${resource.cid}`}>
                  <th scope="row">{roleLabel(role)}</th>
                  <td>
                    <Cid
                      cid={resource.cid}
                      label={`content ID for the ${roleLabel(role).toLowerCase()}`}
                      head={10}
                      tail={6}
                      gateway={IPFS_GATEWAY}
                      linkText="View"
                      linkTitle="Open this file in your web browser, if it is still online"
                    />
                    {resource.originalCid !== undefined &&
                      resource.originalCid !== resource.cid && (
                        <div className="small faint" style={{ marginTop: 4 }}>
                          Contract points at <Cid cid={resource.originalCid} label="content ID in the contract" head={10} tail={6} />
                        </div>
                      )}
                    {resource.notes !== undefined && resource.notes.length > 0 && (
                      <ul className="bullets small" style={{ marginTop: 4 }}>
                        {resource.notes.map((note, index) => (
                          <li key={`${index}-${note.slice(0, 24)}`}>{note}</li>
                        ))}
                      </ul>
                    )}
                  </td>
                  <td className="num nowrap">{formatBytes(resource.bytes)}</td>
                  <td className="nowrap">{describeSource(resource.source)}</td>
                  <td>
                    {resource.originalCid === undefined ? (
                      <span className="faint">—</span>
                    ) : resource.cidPreserved ? (
                      <Pill tone="ok">Kept</Pill>
                    ) : (
                      <Pill tone="warn">Rebuilt</Pill>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="small muted">{explain}</p>
        </>
      )}
    </div>
  )
}
