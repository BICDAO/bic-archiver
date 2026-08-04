/**
 * Reads a .car backup and reports what is inside it and what is still alive on
 * IPFS.
 *
 * Written for the case BIC is actually in: the master backups live in Google
 * Drive as .car files, so the bytes are safe, but every content ID inside them
 * may or may not still be served by anyone. That distinction is invisible until
 * something is checked, and it is exactly what decides whether the DAO needs to
 * re-pin.
 *
 *   node scripts/inspect-car.mjs <backup.car> [--no-health] [--json out.json]
 *
 * Runs on plain Node — no Electron, no window, no GUI. Every block is
 * hash-verified as it is read; a tampered or truncated file fails loudly.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'

import { exporter, recursive } from 'ipfs-unixfs-exporter'

/** dag-pb — the only codec that can be a UnixFS directory. Raw (0x55) never is. */
const DAG_PB = 0x70

import { importCar, openBlockstore, checkHealth, checkProviders } from '../out-lib/index.js'

/**
 * Two-phase sweep, because the obvious approach does not scale.
 *
 * `checkMany` spends five round trips per CID (one routing lookup plus a probe
 * against each gateway) at four in flight. On a real 10,762-CID archive that
 * measured 0.58 CIDs/s — over five hours.
 *
 * But the routing lookup alone settles the ~94% of CIDs that have providers:
 * if somebody is announcing a copy, it is online and no probe adds anything.
 * Only the zero-provider minority needs gateways, to tell "a cache is still
 * answering" (at risk) from "nothing anywhere" (unreachable). That is one cheap
 * request for almost everything and the expensive path for the few that matter.
 */
async function sweep(items, onResult, { concurrency = 24 } = {}) {
  const results = new Array(items.length)
  let next = 0

  const worker = async () => {
    for (;;) {
      const i = next++
      if (i >= items.length) return
      const item = items[i]
      let r
      try {
        const providers = await checkProviders(item.cid)
        if (providers > 0) {
          r = {
            cid: item.cid,
            label: item.label,
            providers,
            gateways: [],
            verdict: 'healthy',
            checkedAt: new Date().toISOString()
          }
        } else {
          // Zero providers is not proof of death — a gateway cache may still
          // be serving it. Pay for the full check only here.
          r = await checkHealth(item.cid, item.label)
        }
      } catch (err) {
        r = {
          cid: item.cid,
          label: item.label,
          providers: 0,
          gateways: [],
          verdict: 'unreachable',
          checkedAt: new Date().toISOString(),
          error: String(err && err.message ? err.message : err)
        }
      }
      results[i] = r
      onResult(r)
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker))
  return results
}

const argv = process.argv.slice(2)
const carPath = argv.find((a) => !a.startsWith('--'))
const doHealth = !argv.includes('--no-health')
const jsonAt = argv.includes('--json') ? argv[argv.indexOf('--json') + 1] : null
/**
 * Checking every CID in a large archive is not practical interactively — a
 * 20,000-file backup where the content is gone costs roughly eight seconds per
 * lookup, which runs to hours. Sampling answers the question that actually
 * matters ("is this archive still on the network at all?") in minutes.
 */
const sampleN = argv.includes('--sample') ? Number(argv[argv.indexOf('--sample') + 1]) : null

if (!carPath || (sampleN !== null && !Number.isFinite(sampleN))) {
  console.error(
    'usage: node scripts/inspect-car.mjs <backup.car> [--no-health] [--sample N] [--json out.json]'
  )
  process.exit(2)
}

function human(n) {
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i += 1
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`
}

function shortCid(c) {
  const s = String(c)
  return s.length > 20 ? `${s.slice(0, 10)}…${s.slice(-6)}` : s
}

const scratch = await mkdtemp(join(tmpdir(), 'bic-inspect-'))

try {
  const info = await stat(carPath)
  console.log(`\nReading ${carPath}  (${human(info.size)})\n`)

  const blockstore = await openBlockstore(join(scratch, 'blocks'))
  const { roots, blocks } = await importCar(carPath, blockstore)

  console.log(`Verified ${blocks.toLocaleString()} blocks. Roots: ${roots.length}`)
  for (const r of roots) console.log(`  root: ${r}`)
  if (roots.length === 0) {
    console.log('\nThis file declares no root, so there is nothing to walk.')
    process.exit(1)
  }

  /* ---- walk the tree -------------------------------------------------- */

  const files = []
  const dirs = []

  for (const root of roots) {
    for await (const node of recursive(root, blockstore)) {
      const rel = node.path.replace(`${root}/`, '').replace(String(root), '') || '/'

      // recursive() yields light entries with no `type`, so ask the exporter —
      // the same way car.ts does — but only for dag-pb, since a raw block is
      // always a file leaf and decoding it would be wasted work.
      let isDir = false
      if (node.cid.code === DAG_PB) {
        try {
          isDir = (await exporter(node.cid, blockstore)).type === 'directory'
        } catch {
          isDir = false
        }
      }

      if (isDir) {
        dirs.push({ path: rel, cid: String(node.cid) })
      } else {
        files.push({
          path: rel,
          cid: String(node.cid),
          size: Number(node.size ?? 0)
        })
      }
    }
  }

  const totalBytes = files.reduce((a, f) => a + f.size, 0)
  console.log(
    `\nContents: ${files.length.toLocaleString()} files in ` +
      `${dirs.length.toLocaleString()} folders, ${human(totalBytes)} total\n`
  )

  const byTop = new Map()
  for (const f of files) {
    const top = f.path.split('/')[0] || '/'
    const cur = byTop.get(top) ?? { files: 0, bytes: 0 }
    cur.files += 1
    cur.bytes += f.size
    byTop.set(top, cur)
  }
  const tops = [...byTop.entries()].sort((a, b) => b[1].bytes - a[1].bytes)
  console.log('Largest entries:')
  for (const [name, s] of tops.slice(0, 25)) {
    console.log(`  ${String(s.files).padStart(4)} files  ${human(s.bytes).padStart(9)}  ${name}`)
  }
  if (tops.length > 25) console.log(`  … and ${tops.length - 25} more`)

  /* ---- health --------------------------------------------------------- */

  let health = []
  if (doHealth) {
    // Directories matter as much as files here — the root CID is the one a
    // member would paste to restore the whole backup, so if it is unreachable
    // the archive is effectively unshareable even when every leaf survives.
    const items = [
      ...dirs.map((d) => ({ cid: d.cid, label: `${d.path}  (folder)` })),
      ...files.map((f) => ({ cid: f.cid, label: f.path }))
    ]
    const allUnique = [...new Map(items.map((i) => [i.cid, i])).values()]

    // Deterministic even spread rather than a random draw, so a rerun is
    // comparable and the sample is not clustered in one corner of the tree.
    let unique = allUnique
    if (sampleN !== null && sampleN < allUnique.length) {
      const step = allUnique.length / sampleN
      unique = Array.from({ length: sampleN }, (_, i) => allUnique[Math.floor(i * step)])
      console.log(
        `\nSampling ${unique.length.toLocaleString()} of ${allUnique.length.toLocaleString()} ` +
          `unique content IDs, spread evenly through the archive.`
      )
    } else {
      console.log(
        `\nChecking ${unique.length.toLocaleString()} unique content IDs against the public network.`
      )
    }
    console.log('This asks whether anyone is still serving them — it does not re-upload anything.\n')

    let done = 0
    let healthy = 0
    let atRisk = 0
    let unreachable = 0

    health = await sweep(unique, (r) => {
      done += 1
      if (r.verdict === 'healthy') healthy += 1
      else if (r.verdict === 'at-risk') atRisk += 1
      else unreachable += 1
      if (done % 10 === 0 || done === unique.length) {
        process.stdout.write(
          `\r  ${done}/${unique.length}  online ${healthy}  at-risk ${atRisk}  unreachable ${unreachable}   `
        )
      }
    })
    process.stdout.write('\n')

    const dead = health.filter((h) => h.verdict === 'unreachable')
    const risky = health.filter((h) => h.verdict === 'at-risk')

    const scope = unique.length === allUnique.length ? 'all' : 'sampled'
    const pct = (n) => `${((n / unique.length) * 100).toFixed(1)}%`

    console.log('\n' + '='.repeat(72))
    console.log(`  Online       ${String(healthy).padStart(6)}   ${pct(healthy)}`)
    console.log(
      `  At risk      ${String(atRisk).padStart(6)}   ${pct(atRisk)}   (served, but nobody announces a copy)`
    )
    console.log(
      `  Unreachable  ${String(unreachable).padStart(6)}   ${pct(unreachable)}   (nobody is serving these)`
    )
    console.log('='.repeat(72))
    if (scope === 'sampled') {
      console.log(
        `\nThat is a sample of ${unique.length} from ${allUnique.length.toLocaleString()} content IDs.\n` +
          `Read it as an estimate of the whole archive, not an exact count. Re-run\n` +
          `without --sample for a definitive per-file answer (slow: dead lookups cost\n` +
          `about eight seconds each).`
      )
    }

    if (dead.length > 0) {
      console.log(`\nUnreachable — present in this .car, absent from the network:`)
      for (const h of dead.slice(0, 40)) {
        console.log(`  ${shortCid(h.cid)}  ${h.label}`)
      }
      if (dead.length > 40) console.log(`  … and ${dead.length - 40} more`)
      console.log(
        `\nThese exist only inside this backup file. Re-pin them to put them back on IPFS.`
      )
    }
    if (risky.length > 0 && dead.length === 0) {
      console.log(`\nAt risk — a gateway cache is answering, but no node announces a copy.`)
    }
  }

  if (jsonAt) {
    await writeFile(
      jsonAt,
      JSON.stringify(
        {
          car: carPath,
          bytes: info.size,
          roots: roots.map(String),
          blocks,
          files,
          directories: dirs,
          health
        },
        null,
        2
      )
    )
    console.log(`\nWrote ${jsonAt}`)
  }
} finally {
  await rm(scratch, { recursive: true, force: true })
}
