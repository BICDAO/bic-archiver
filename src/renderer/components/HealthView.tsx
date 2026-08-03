/**
 * Is any of this still out there?
 *
 * This is the screen the app exists for. The DAO's own October 2025 backup went
 * unreachable without anyone noticing — no error, no warning, just a content ID
 * that one day stopped answering. Nothing about IPFS tells you that has
 * happened; you have to go and ask.
 *
 * So this screen asks, for every content ID in the archive at once: does the
 * network still know anyone holding it, and will any public gateway actually
 * hand it over? Results stream in one row at a time and the worst news sorts to
 * the top, because the whole point is that a member sees it.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'

import type { HealthResult } from '../../shared/types'
import type { ArchiveSnapshot, HealthCheckItem } from '../../preload'
import { useHealth } from '../hooks'
import { Cid } from './Cid'
import {
  Banner,
  Card,
  EmptyState,
  Pill,
  ProgressBar,
  ViewHeader,
  formatCount,
  formatWhen,
  gatewayHost,
  isCancellation,
  roleLabel,
  type Tone
} from './Layout'

/* ========================================================================== */
/* What to check                                                              */
/* ========================================================================== */

/**
 * Every content ID this archive depends on, each with a label a member will
 * recognise. Duplicates are collapsed: two tokens can share one picture, and
 * checking it twice would only pad the table and slow the sweep.
 */
function collectTargets(snapshot: ArchiveSnapshot): HealthCheckItem[] {
  const items: HealthCheckItem[] = []
  const seen = new Set<string>()

  const add = (cid: string | undefined, label: string): void => {
    if (cid === undefined || cid === '') return
    if (seen.has(cid)) return
    seen.add(cid)
    items.push({ cid, label })
  }

  const manifest = snapshot.manifest
  add(manifest.rootCid, "This archive's fingerprint")
  for (const root of manifest.importedRoots) add(root, 'An older backup added to this archive')

  for (const token of manifest.tokens) {
    add(token.metadata?.cid, `${token.name} — description file`)
    for (const [role, resource] of Object.entries(token.assets ?? {})) {
      add(resource.cid, `${token.name} — ${roleLabel(role).toLowerCase()}`)
    }
  }

  return items
}

/* ========================================================================== */
/* Verdicts                                                                   */
/* ========================================================================== */

const VERDICT_LOOK: Record<HealthResult['verdict'], { tone: Tone; label: string; rank: number }> = {
  unreachable: { tone: 'danger', label: 'Unreachable', rank: 0 },
  'at-risk': { tone: 'warn', label: 'At risk', rank: 1 },
  healthy: { tone: 'ok', label: 'Online', rank: 2 }
}

function compareResults(a: HealthResult, b: HealthResult): number {
  const byVerdict = VERDICT_LOOK[a.verdict].rank - VERDICT_LOOK[b.verdict].rank
  if (byVerdict !== 0) return byVerdict
  return a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: 'base' })
}

/* ========================================================================== */
/* The view                                                                   */
/* ========================================================================== */

export interface HealthViewProps {
  snapshot: ArchiveSnapshot
  /** Take the member to the Export screen, where a .car can be saved right now. */
  onExport: () => void
}

export default function HealthView({ snapshot, onExport }: HealthViewProps): ReactNode {
  /*
   * The sweep itself lives in the shared health store: it mints the operation
   * id, streams each row in over the `health` channel as it lands, and survives
   * this component being hidden while a member looks at another screen.
   */
  const health = useHealth()
  const [lastRunAt, setLastRunAt] = useState<string | null>(null)
  const [expected, setExpected] = useState(0)

  const targets = useMemo(() => collectTargets(snapshot), [snapshot])
  const results = health.results
  const running = health.running

  /*
   * The health store outlives this component, so results from the archive that
   * was open a moment ago would otherwise still be on screen — labelled with
   * tokens the member is no longer looking at. Switching archive throws them
   * away rather than showing an answer to a question nobody asked.
   */
  const archiveDir = snapshot.dir
  const lastArchiveDir = useRef(archiveDir)
  const clear = health.clear
  useEffect(() => {
    if (lastArchiveDir.current === archiveDir) return
    lastArchiveDir.current = archiveDir
    clear()
    setLastRunAt(null)
    setExpected(0)
  }, [archiveDir, clear])

  const checkAll = useCallback(async () => {
    const items = collectTargets(snapshot)
    if (items.length === 0) return
    health.clear()
    setExpected(items.length)
    await health.check(items)
    setLastRunAt(new Date().toISOString())
  }, [health, snapshot])

  const sorted = useMemo(() => [...results].sort(compareResults), [results])

  const tally = useMemo(() => {
    let unreachable = 0
    let atRisk = 0
    let healthy = 0
    for (const result of results) {
      if (result.verdict === 'unreachable') unreachable += 1
      else if (result.verdict === 'at-risk') atRisk += 1
      else healthy += 1
    }
    return { unreachable, atRisk, healthy }
  }, [results])

  const hasRun = results.length > 0 || lastRunAt !== null

  return (
    <div className="view">
      <ViewHeader
        title="Health"
        lead="IPFS keeps a file only for as long as somebody keeps offering it. Nothing warns you when the last copy goes away — so this checks every content ID in the archive against the public network and tells you what is still there."
        actions={
          <button
            type="button"
            className="btn btn-primary btn-lg"
            onClick={() => void checkAll()}
            disabled={running || targets.length === 0}
          >
            {running ? 'Checking…' : hasRun ? 'Check again' : 'Check all'}
          </button>
        }
      />

      {/* -------------------------------------------------------------- */}
      {/* The headline                                                    */}
      {/* -------------------------------------------------------------- */}

      {hasRun && !running && (
        <>
          {tally.unreachable > 0 ? (
            <Banner
              tone="danger"
              big
              title={`${formatCount(tally.unreachable)} ${tally.unreachable === 1 ? 'item is' : 'items are'} unreachable`}
              actions={
                <button type="button" className="btn btn-sm btn-primary" onClick={onExport}>
                  Save a .car backup now
                </button>
              }
            >
              No computer on the IPFS network is offering{' '}
              {tally.unreachable === 1 ? 'this content' : 'these items'} any more, and no public
              gateway would hand{' '}
              {tally.unreachable === 1 ? 'it' : 'them'} over. If this archive already holds the
              files, save a <strong>.car</strong> backup today and get it pinned somewhere — that
              copy may be the last one. If it does not, ask other members whether anyone still has
              the files.
            </Banner>
          ) : tally.atRisk > 0 ? (
            <Banner
              tone="warn"
              big
              title={`${formatCount(tally.atRisk)} ${tally.atRisk === 1 ? 'item is' : 'items are'} at risk`}
            >
              Gateways still serve{' '}
              {tally.atRisk === 1 ? 'this content' : 'these items'}, but nobody on the network is
              announcing that they hold{' '}
              {tally.atRisk === 1 ? 'it' : 'them'} — usually a sign that the copy is sitting in one
              gateway's cache and will vanish when that cache clears. Pin{' '}
              {tally.atRisk === 1 ? 'it' : 'them'} somewhere, or save a .car backup.
            </Banner>
          ) : (
            <Banner
              tone="ok"
              big
              title={`All ${formatCount(tally.healthy)} ${tally.healthy === 1 ? 'item is' : 'items are'} still online`}
            >
              Every content ID in this archive was answered by the network. Check again from time to
              time — this can change without any warning.
            </Banner>
          )}
        </>
      )}

      {running && (
        <div className="card stack stack-sm" aria-live="polite">
          <div className="row">
            <span className="spinner" aria-hidden="true" />
            <span className="grow">
              Checked {formatCount(results.length)} of {formatCount(expected)}. Rows appear below as
              the answers arrive — you can leave this screen and come back.
            </span>
            <button type="button" className="btn btn-sm" onClick={() => void health.cancel()}>
              Stop checking
            </button>
          </div>
          <ProgressBar
            value={expected > 0 ? results.length / expected : null}
            label="Checking content IDs"
          />
        </div>
      )}

      {health.error !== null && (
        <Banner
          tone={isCancellation(health.error) ? 'warn' : 'danger'}
          title={isCancellation(health.error) ? 'Stopped' : 'The check could not finish'}
        >
          {health.error}
        </Banner>
      )}

      {health.cancelled && !running && health.error === null && (
        <Banner tone="warn" title="Stopped before the end">
          Only the rows below were checked. Press Check again to do the rest.
        </Banner>
      )}

      {/* -------------------------------------------------------------- */}
      {/* Results                                                         */}
      {/* -------------------------------------------------------------- */}

      {sorted.length === 0 ? (
        targets.length === 0 ? (
          <EmptyState title="Nothing to check yet">
            This archive has no content IDs in it so far. Add some NFTs, then come back and press
            Check all.
          </EmptyState>
        ) : (
          !running && (
            <EmptyState
              title={`${formatCount(targets.length)} ${targets.length === 1 ? 'item' : 'items'} ready to check`}
              action={
                <button type="button" className="btn btn-primary btn-lg" onClick={() => void checkAll()}>
                  Check all
                </button>
              }
            >
              Every description file, picture and animation in this archive — plus the archive's own
              fingerprint — will be looked up on the IPFS network and tried against several public
              gateways. It takes a minute or two.
            </EmptyState>
          )
        )
      ) : (
        <div className="table-wrap">
          <table className="table">
            <caption className="sr-only">
              Health of every content ID in this archive. Unreachable items are listed first.
            </caption>
            <thead>
              <tr>
                <th scope="col">What it is</th>
                <th scope="col">Content ID</th>
                <th scope="col">Copies offered</th>
                <th scope="col">Gateways tried</th>
                <th scope="col">Verdict</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((result) => {
                const look = VERDICT_LOOK[result.verdict]
                return (
                  <tr key={result.cid}>
                    <th scope="row">{result.label}</th>
                    <td>
                      <Cid cid={result.cid} label={`content ID for ${result.label}`} head={10} tail={6} />
                    </td>
                    <td className="num nowrap">
                      {result.providers === 0 ? (
                        <span className="pill pill-danger">None</span>
                      ) : (
                        formatCount(result.providers)
                      )}
                    </td>
                    <td>
                      {result.gateways.length === 0 ? (
                        <span className="faint">—</span>
                      ) : (
                        <div className="gateway-list">
                          {result.gateways.map((gateway) => (
                            <span
                              key={gateway.gateway}
                              className={`gateway-chip ${gateway.ok ? 'is-ok' : 'is-bad'}`}
                              title={
                                gateway.ok
                                  ? `${gatewayHost(gateway.gateway)} served it in ${formatCount(gateway.ms)} ms`
                                  : `${gatewayHost(gateway.gateway)} did not serve it (${String(gateway.status)})`
                              }
                            >
                              {gatewayHost(gateway.gateway)}
                              <span aria-hidden="true">{gateway.ok ? '✓' : '✕'}</span>
                              <span className="sr-only">
                                {gateway.ok ? 'served it' : 'did not serve it'}
                              </span>
                            </span>
                          ))}
                        </div>
                      )}
                    </td>
                    <td>
                      <Pill tone={look.tone}>{look.label}</Pill>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {lastRunAt !== null && !running && (
        <p className="small faint">Last checked {formatWhen(lastRunAt)}.</p>
      )}

      {/* -------------------------------------------------------------- */}
      {/* What the words mean                                             */}
      {/* -------------------------------------------------------------- */}

      <Card title="What these words mean">
        <dl className="kv">
          <dt>
            <Pill tone="ok">Online</Pill>
          </dt>
          <dd>
            Computers on the network say they hold this, and at least one public gateway handed it
            over when asked. Nothing to do.
          </dd>

          <dt>
            <Pill tone="warn">At risk</Pill>
          </dt>
          <dd>
            A gateway still serves it, but nobody is announcing that they hold a copy — so what you
            are seeing is probably a cache, not a real copy. Save a .car backup and get it pinned
            before the cache clears.
          </dd>

          <dt>
            <Pill tone="danger">Unreachable</Pill>
          </dt>
          <dd>
            Nobody is offering it and no gateway would serve it. In practice that means every copy
            has gone offline.{' '}
            <strong>
              If this archive holds the files, export a .car backup now and ask a pinning service to
              keep it
            </strong>{' '}
            — and if it does not, ask around the DAO: another member's computer may still have them,
            and they can send you their .car file to import.
          </dd>

          <dt>Copies offered</dt>
          <dd>
            How many computers told the network they hold this content. Zero is the clearest early
            warning you will ever get.
          </dd>
        </dl>
      </Card>
    </div>
  )
}
