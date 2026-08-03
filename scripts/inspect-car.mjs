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

import { importCar, openBlockstore, checkMany } from '../out-lib/index.js'

const argv = process.argv.slice(2)
const carPath = argv.find((a) => !a.startsWith('--'))
const doHealth = !argv.includes('--no-health')
const jsonAt = argv.includes('--json') ? argv[argv.indexOf('--json') + 1] : null

if (!carPath) {
  console.error('usage: node scripts/inspect-car.mjs <backup.car> [--no-health] [--json out.json]')
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
    const unique = [...new Map(items.map((i) => [i.cid, i])).values()]
    console.log(
      `\nChecking ${unique.length.toLocaleString()} unique content IDs against the public network.`
    )
    console.log('This asks whether anyone is still serving them — it does not re-upload anything.\n')

    let done = 0
    let healthy = 0
    let atRisk = 0
    let unreachable = 0

    health = await checkMany(unique, (r) => {
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

    console.log('\n' + '='.repeat(72))
    console.log(`  Online       ${healthy.toLocaleString()}`)
    console.log(`  At risk      ${atRisk.toLocaleString()}   (served, but nobody announces a copy)`)
    console.log(`  Unreachable  ${unreachable.toLocaleString()}   (nobody is serving these)`)
    console.log('='.repeat(72))

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
