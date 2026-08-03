/**
 * Local content import and automated CID reconstruction.
 *
 * Two jobs live here:
 *
 * 1. Turning bytes (or a folder on disk) into UnixFS blocks in our blockstore,
 *    so they can be written out as a `.car` backup.
 * 2. Reproducing a *specific historical CID* from bytes we managed to recover
 *    some other way (an HTTP gateway mirror, a copy on someone's laptop, an
 *    Arweave mirror). This is the automated replacement for the part of the
 *    manual instructions that tells a DAO member to keep re-running
 *    `ipfs add --cid-version=1 ...` by hand and comparing attributes at
 *    https://cid.ipfs.tech/ until the hash finally matches.
 *
 * A CID is not a hash of the file — it is a hash of a *tree of blocks* that was
 * built from the file. Change the chunk size, the leaf format, the tree fanout
 * or the layout and the same bytes produce a completely different CID. There is
 * no way to invert that, so the only honest approach is to replay the parameter
 * combinations that real-world tools actually used, in order of likelihood.
 * That list is `RECONSTRUCTION_MATRIX`.
 *
 * The hash function is always sha2-256: `ipfs-unixfs-importer` hardcodes it in
 * its `persist()` helper, which matches every mainstream IPFS tool.
 */

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readdir, realpath, stat } from 'node:fs/promises'
import { basename, join, resolve as resolvePath } from 'node:path'

import { MemoryBlockstore } from 'blockstore-core'
import { importBytes, importer } from 'ipfs-unixfs-importer'
import { fixedSize } from 'ipfs-unixfs-importer/chunker'
import { balanced, trickle } from 'ipfs-unixfs-importer/layout'
import { CID } from 'multiformats/cid'

import type {
  DirectoryCandidate,
  FileCandidate,
  ImporterOptions,
  WritableStorage
} from 'ipfs-unixfs-importer'

/**
 * The knobs that change the CID produced from a given set of bytes.
 *
 * Anything not listed here is either fixed by the IPFS ecosystem (sha2-256) or
 * pinned by this module to a deterministic value (HAMT shard threshold, single
 * leaf reduction) so that results are reproducible between runs and machines.
 */
export interface ImportOptions {
  cidVersion?: 0 | 1
  rawLeaves?: boolean
  chunkSize?: number
  maxChildrenPerNode?: number
  layout?: 'balanced' | 'trickle'
}

/** 256 KiB — the classic IPFS chunk size, used by `ipfs add` since 2015. */
const CHUNK_256_KIB = 262_144
/** 512 KiB — a common hand-tuned `--chunker=size-524288`. */
const CHUNK_512_KIB = 524_288
/** 1 MiB — the chunk size of the IPIP-499 `unixfs-v1-2025` profile. */
const CHUNK_1_MIB = 1_048_576
/** 64 KiB — old js-ipfs / browser-era tooling. */
const CHUNK_64_KIB = 65_536

/**
 * Our defaults, matching modern Kubo (`ipfs add --cid-version=1`): CIDv1, raw
 * leaves, 256 KiB fixed-size chunks, 174 links per node, balanced layout,
 * sha2-256.
 */
const DEFAULT_OPTIONS: Required<ImportOptions> = {
  cidVersion: 1,
  rawLeaves: true,
  chunkSize: CHUNK_256_KIB,
  maxChildrenPerNode: 174,
  layout: 'balanced'
}

/** Fill in every unset field so behaviour never depends on library defaults. */
function resolveOptions(opts: ImportOptions = {}): Required<ImportOptions> {
  return {
    cidVersion: opts.cidVersion ?? DEFAULT_OPTIONS.cidVersion,
    rawLeaves: opts.rawLeaves ?? DEFAULT_OPTIONS.rawLeaves,
    chunkSize: opts.chunkSize ?? DEFAULT_OPTIONS.chunkSize,
    maxChildrenPerNode: opts.maxChildrenPerNode ?? DEFAULT_OPTIONS.maxChildrenPerNode,
    layout: opts.layout ?? DEFAULT_OPTIONS.layout
  }
}

/**
 * Translate our small option set into the importer's much larger one.
 *
 * Everything that could drift between library versions is pinned explicitly:
 * a future default change in `ipfs-unixfs-importer` must not silently change
 * the CIDs this app produces.
 */
function toImporterOptions(opts: ImportOptions = {}): ImporterOptions {
  const o = resolveOptions(opts)

  if (!Number.isInteger(o.chunkSize) || o.chunkSize < 1) {
    throw new Error('Internal error: the chunk size for an IPFS import must be a positive whole number.')
  }
  if (!Number.isInteger(o.maxChildrenPerNode) || o.maxChildrenPerNode < 2) {
    throw new Error('Internal error: the links-per-node setting for an IPFS import must be 2 or more.')
  }

  const importerOptions: ImporterOptions = {
    cidVersion: o.cidVersion,
    rawLeaves: o.rawLeaves,
    chunker: fixedSize({ chunkSize: o.chunkSize }),
    layout:
      o.layout === 'trickle'
        ? trickle({ maxChildrenPerNode: o.maxChildrenPerNode, layerRepeat: 4 })
        : balanced({ maxChildrenPerNode: o.maxChildrenPerNode }),
    // Kubo's balanced builder returns a lone leaf as the root of a small file.
    reduceSingleLeafToSelf: true,
    // Directory sharding: pinned to Kubo's long-standing behaviour (256 KiB of
    // estimated link bytes, 256-way HAMT) so folder CIDs stay reproducible.
    shardSplitThresholdBytes: CHUNK_256_KIB,
    shardSplitStrategy: 'links-bytes',
    shardFanoutBits: 8,
    wrapWithDirectory: false
  }

  if (o.layout === 'trickle') {
    // Kubo's trickle DAG never collapses a single leaf into the root, and uses
    // UnixFS `raw` leaves rather than `file` leaves when raw leaves are off.
    importerOptions.reduceSingleLeafToSelf = false
    importerOptions.leafType = 'raw'
  }

  return importerOptions
}

/**
 * Import raw bytes as a UnixFS file, writing every block into `blockstore`.
 *
 * @returns the root CID and the number of bytes of content imported.
 */
export async function addBytes(
  bytes: Uint8Array,
  blockstore: WritableStorage,
  opts?: ImportOptions
): Promise<{ cid: CID; bytes: number }> {
  if (!(bytes instanceof Uint8Array)) {
    throw new Error('Internal error: only raw bytes can be imported into the archive.')
  }

  const result = await importBytes(bytes, blockstore, toImporterOptions(opts))

  return { cid: result.cid, bytes: bytes.byteLength }
}

/** Lowercase hex sha256 of the given bytes, for the provenance record. */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * Parameter combinations to replay when we hold a file's bytes but need to
 * reproduce a particular historical CID. Ordered most-likely-first.
 *
 * Every entry is fully specified so the list reads as documentation of which
 * tool and era produced which shape of DAG.
 */
export const RECONSTRUCTION_MATRIX: ImportOptions[] = [
  // `ipfs add` with no flags — the Kubo default from 2015 to today, and by far
  // the most common origin of the "Qm..." CIDs found in old NFT metadata.
  {
    cidVersion: 0,
    rawLeaves: false,
    chunkSize: CHUNK_256_KIB,
    maxChildrenPerNode: 174,
    layout: 'balanced'
  },
  // `ipfs add --cid-version=1` (which implies --raw-leaves), and the default of
  // Helia, ipfs-car, w3up/web3.storage and NFT.Storage. Produces "bafybei..."
  // roots, or a bare "bafkrei..." raw block for a file under one chunk.
  {
    cidVersion: 1,
    rawLeaves: true,
    chunkSize: CHUNK_256_KIB,
    maxChildrenPerNode: 174,
    layout: 'balanced'
  },
  // `ipfs add --cid-version=1 --raw-leaves=false`. Also what you get when a
  // pinning service re-encodes an existing CIDv0 DAG as CIDv1: identical dag-pb
  // blocks, different CID prefix.
  {
    cidVersion: 1,
    rawLeaves: false,
    chunkSize: CHUNK_256_KIB,
    maxChildrenPerNode: 174,
    layout: 'balanced'
  },
  // `ipfs add --raw-leaves` while leaving the CID version at 0: a CIDv0 dag-pb
  // root over CIDv1 raw leaves. Small files collapse to a bare raw block.
  {
    cidVersion: 0,
    rawLeaves: true,
    chunkSize: CHUNK_256_KIB,
    maxChildrenPerNode: 174,
    layout: 'balanced'
  },
  // The IPIP-499 "unixfs-v1-2025" profile (Kubo 0.38+ opt-in, newer Helia):
  // 1 MiB chunks and 1024 links per node.
  {
    cidVersion: 1,
    rawLeaves: true,
    chunkSize: CHUNK_1_MIB,
    maxChildrenPerNode: 1024,
    layout: 'balanced'
  },
  // `ipfs add --chunker=size-1048576` on the classic v0 default — a popular
  // tweak for large video/audio uploads.
  {
    cidVersion: 0,
    rawLeaves: false,
    chunkSize: CHUNK_1_MIB,
    maxChildrenPerNode: 174,
    layout: 'balanced'
  },
  // 1 MiB chunks with modern leaves but the legacy 174-link fanout: js-ipfs and
  // ipfs-car with a custom chunker.
  {
    cidVersion: 1,
    rawLeaves: true,
    chunkSize: CHUNK_1_MIB,
    maxChildrenPerNode: 174,
    layout: 'balanced'
  },
  // 1 MiB chunks, CIDv1, dag-pb leaves.
  {
    cidVersion: 1,
    rawLeaves: false,
    chunkSize: CHUNK_1_MIB,
    maxChildrenPerNode: 174,
    layout: 'balanced'
  },
  // `ipfs add --trickle` — the streaming-oriented DAG shape, CIDv0 flavour.
  {
    cidVersion: 0,
    rawLeaves: false,
    chunkSize: CHUNK_256_KIB,
    maxChildrenPerNode: 174,
    layout: 'trickle'
  },
  // `ipfs add --trickle --cid-version=1`.
  {
    cidVersion: 1,
    rawLeaves: true,
    chunkSize: CHUNK_256_KIB,
    maxChildrenPerNode: 174,
    layout: 'trickle'
  },
  // 512 KiB chunks — the other widely copy-pasted `--chunker=size-N` value.
  {
    cidVersion: 0,
    rawLeaves: false,
    chunkSize: CHUNK_512_KIB,
    maxChildrenPerNode: 174,
    layout: 'balanced'
  },
  {
    cidVersion: 1,
    rawLeaves: true,
    chunkSize: CHUNK_512_KIB,
    maxChildrenPerNode: 174,
    layout: 'balanced'
  },
  // Kubo 0.38's `--max-links=1024` applied to the classic 256 KiB chunk size.
  {
    cidVersion: 1,
    rawLeaves: true,
    chunkSize: CHUNK_256_KIB,
    maxChildrenPerNode: 1024,
    layout: 'balanced'
  },
  {
    cidVersion: 0,
    rawLeaves: false,
    chunkSize: CHUNK_256_KIB,
    maxChildrenPerNode: 1024,
    layout: 'balanced'
  },
  // 64 KiB chunks — early js-ipfs / ipfs-deploy and some browser uploaders.
  {
    cidVersion: 0,
    rawLeaves: false,
    chunkSize: CHUNK_64_KIB,
    maxChildrenPerNode: 174,
    layout: 'balanced'
  },
  {
    cidVersion: 1,
    rawLeaves: true,
    chunkSize: CHUNK_64_KIB,
    maxChildrenPerNode: 174,
    layout: 'balanced'
  },
  // `ipfs add --trickle --chunker=size-1048576`, seen on large archival adds.
  {
    cidVersion: 0,
    rawLeaves: false,
    chunkSize: CHUNK_1_MIB,
    maxChildrenPerNode: 174,
    layout: 'trickle'
  },
  // Trickle with CIDv1 dag-pb leaves — rare, but cheap to rule out.
  {
    cidVersion: 1,
    rawLeaves: false,
    chunkSize: CHUNK_256_KIB,
    maxChildrenPerNode: 174,
    layout: 'trickle'
  }
]

/** CID equality that does not depend on both CIDs coming from the same module copy. */
function sameCid(a: CID, b: CID): boolean {
  if (a.version !== b.version || a.code !== b.code) {
    return false
  }

  const x = a.multihash.bytes
  const y = b.multihash.bytes

  if (x.byteLength !== y.byteLength) {
    return false
  }

  for (let i = 0; i < x.byteLength; i++) {
    if (x[i] !== y[i]) {
      return false
    }
  }

  return true
}

/**
 * A key identifying the DAG shape an option set will produce for a payload of
 * this exact size, so provably-identical attempts are only run once.
 *
 * A file that fits in a single chunk ignores the chunk size and the fanout
 * entirely; a file whose chunks all fit under one parent ignores the fanout.
 * Collapsing those cases turns 18 matrix entries into ~4 real imports for a
 * typical metadata JSON file.
 */
function attemptKey(o: Required<ImportOptions>, byteLength: number): string {
  const chunks = Math.max(1, Math.ceil(byteLength / o.chunkSize))
  const base = `${o.cidVersion}|${String(o.rawLeaves)}|${o.layout}`

  if (chunks <= 1) {
    return `${base}|single`
  }

  const fanout = chunks <= o.maxChildrenPerNode ? 'flat' : String(o.maxChildrenPerNode)

  return `${base}|${o.chunkSize}|${fanout}`
}

/**
 * Try to reproduce `targetCid` from `bytes`.
 *
 * Each candidate parameter set is imported into a throwaway in-memory
 * blockstore first, so a failed attempt leaves nothing behind. The moment one
 * reproduces the target the same parameters are replayed into the real
 * `blockstore`, which is what makes the archive byte-identical to the original
 * content the contract pointed at.
 *
 * If nothing matches, the bytes are still imported with our defaults so the
 * content is preserved, and `matched: false` is returned with the CID we
 * actually produced. The caller must report that honestly: the file is saved,
 * but under a different hash than the one on chain.
 *
 * @returns `tried` is the number of distinct parameter combinations actually
 * imported — combinations that provably produce the same DAG for a payload of
 * this size are collapsed into one attempt.
 */
export async function reconstructCid(
  bytes: Uint8Array,
  targetCid: CID,
  blockstore: WritableStorage
): Promise<{ matched: boolean; cid: CID; options?: ImportOptions; tried: number }> {
  if (!(bytes instanceof Uint8Array)) {
    throw new Error('Internal error: only raw bytes can be checked against an original IPFS hash.')
  }

  const target = CID.asCID(targetCid)

  if (target == null) {
    throw new Error('Internal error: the original IPFS hash to reproduce was not a valid CID.')
  }

  const attempted = new Set<string>()
  let tried = 0

  for (const entry of RECONSTRUCTION_MATRIX) {
    const options = resolveOptions(entry)

    // A CIDv1 setting can never produce a CIDv0 ("Qm...") hash, so skip those
    // outright. The reverse is not true: cidVersion 0 with raw leaves yields a
    // CIDv1 raw block for a single-chunk file, so nothing is skipped there.
    if (target.version === 0 && options.cidVersion === 1) {
      continue
    }

    const key = attemptKey(options, bytes.byteLength)

    if (attempted.has(key)) {
      continue
    }

    attempted.add(key)
    tried++

    // Throwaway store: probe blocks are discarded unless this attempt wins.
    const probe = new MemoryBlockstore()
    const probed = await addBytes(bytes, probe, options)

    if (sameCid(probed.cid, target)) {
      const stored = await addBytes(bytes, blockstore, options)

      return { matched: true, cid: stored.cid, options, tried }
    }
  }

  // No combination reproduced the original hash. Keep the bytes anyway.
  const fallback = await addBytes(bytes, blockstore, DEFAULT_OPTIONS)

  return { matched: false, cid: fallback.cid, tried }
}

/**
 * Operating-system bookkeeping files that are invisible in Finder/Explorer.
 *
 * They were never part of the original IPFS folder, so including them would
 * guarantee the folder hash could never match. Excluding them is what gives a
 * member a realistic chance of reproducing a directory CID from a copy of the
 * files sitting on their desktop.
 */
const IGNORED_FILENAMES = new Set([
  '.DS_Store',
  '.localized',
  '.Spotlight-V100',
  '.Trashes',
  '.fseventsd',
  '.AppleDouble',
  '__MACOSX',
  'Thumbs.db',
  'desktop.ini'
])

function isIgnoredName(name: string): boolean {
  // "._foo" files are macOS AppleDouble sidecars written onto non-HFS volumes.
  return IGNORED_FILENAMES.has(name) || name.startsWith('._')
}

/**
 * Compare names by their UTF-8 bytes.
 *
 * `Array.prototype.sort` compares UTF-16 code units, which orders some
 * non-Latin and emoji filenames differently from Go's byte-wise sort. Kubo adds
 * directory entries in byte order, and directory link order is part of the
 * folder hash, so this has to match exactly.
 */
function compareUtf8(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'))
}

/** Lazily stream a file from disk so large media never sits in memory whole. */
function fileContent(absPath: string): AsyncIterable<Uint8Array> {
  return {
    async *[Symbol.asyncIterator]() {
      const stream = createReadStream(absPath)

      try {
        for await (const chunk of stream) {
          yield chunk as Uint8Array
        }
      } catch (err) {
        throw new Error(
          `Could not read "${basename(absPath)}". The file may have been moved, renamed or locked by another program while the archive was being built.`,
          { cause: err }
        )
      } finally {
        stream.destroy()
      }
    }
  }
}

/**
 * Walk `absDir`, appending import candidates in the order Kubo would add them.
 *
 * `chain` holds the resolved real paths of the directories we are currently
 * inside, which stops a symlink loop from recursing forever.
 */
async function collectCandidates(
  absDir: string,
  relPath: string,
  out: Array<FileCandidate | DirectoryCandidate>,
  chain: Set<string>
): Promise<void> {
  const real = await realpath(absDir)

  if (chain.has(real)) {
    throw new Error(
      `The folder "${relPath}" contains a shortcut that points back into itself, so it cannot be archived. Please remove the shortcut and try again.`
    )
  }

  chain.add(real)

  let entries
  try {
    entries = await readdir(absDir, { withFileTypes: true })
  } catch (err) {
    throw new Error(
      `Could not open the folder "${relPath}". Please check that it still exists and that you have permission to read it.`,
      { cause: err }
    )
  }

  const kept = entries.filter((entry) => !isIgnoredName(entry.name))
  kept.sort((a, b) => compareUtf8(a.name, b.name))

  if (kept.length === 0) {
    // An empty folder is still part of the archive and still affects the hash.
    out.push({ path: relPath })
    chain.delete(real)
    return
  }

  for (const entry of kept) {
    if (entry.name.endsWith('\\')) {
      throw new Error(
        `"${relPath}/${entry.name}" ends with a backslash, which IPFS cannot represent in a folder listing. Please rename it and try again.`
      )
    }

    const abs = join(absDir, entry.name)
    const rel = `${relPath}/${entry.name}`

    let isDirectory = entry.isDirectory()
    let isFile = entry.isFile()

    if (entry.isSymbolicLink()) {
      // Follow the shortcut and archive whatever it actually points at.
      const target = await stat(abs).catch(() => undefined)

      if (target == null) {
        throw new Error(
          `"${rel}" is a shortcut pointing at something that no longer exists. Please remove or fix it and try again.`
        )
      }

      isDirectory = target.isDirectory()
      isFile = target.isFile()
    }

    if (isDirectory) {
      await collectCandidates(abs, rel, out, chain)
    } else if (isFile) {
      out.push({ path: rel, content: fileContent(abs) })
    } else {
      throw new Error(
        `"${rel}" is not an ordinary file or folder, so it cannot be archived. Please remove it from the folder and try again.`
      )
    }
  }

  chain.delete(real)
}

/**
 * Import a folder from disk, recursively, preserving file and folder names.
 *
 * The returned CID is the CID of the folder itself — the same value Kubo prints
 * last for `ipfs add -r <folder>`. Folder hashes depend on every name and every
 * child hash, so a member trying to reproduce an existing folder CID must have
 * all of the original files present, with their original names, and nothing
 * extra (see `IGNORED_FILENAMES` for the invisible OS files we drop).
 */
export async function addDirectoryFromFs(
  dirPath: string,
  blockstore: WritableStorage,
  opts?: ImportOptions
): Promise<CID> {
  const absDir = resolvePath(dirPath)

  const info = await stat(absDir).catch(() => undefined)

  if (info == null) {
    throw new Error(`Could not find the folder "${dirPath}". Please check the location and try again.`)
  }

  if (!info.isDirectory()) {
    throw new Error(`"${dirPath}" is a file, not a folder. Please choose a folder to import.`)
  }

  const rootName = basename(absDir)

  if (rootName === '' || rootName === '/') {
    throw new Error(
      'A whole disk cannot be imported as an archive folder. Please choose a named folder instead.'
    )
  }

  const candidates: Array<FileCandidate | DirectoryCandidate> = []
  await collectCandidates(absDir, rootName, candidates, new Set<string>())

  // Every candidate path starts with `rootName`, so the importer builds one
  // directory node for it and yields that node last.
  let rootCid: CID | undefined
  let lastCid: CID | undefined

  for await (const entry of importer(candidates, blockstore, toImporterOptions(opts))) {
    lastCid = entry.cid

    if (entry.path === rootName) {
      rootCid = entry.cid
    }
  }

  const result = rootCid ?? lastCid

  if (result == null) {
    throw new Error(
      `Nothing could be imported from "${dirPath}". The folder appears to contain no readable files.`
    )
  }

  return result
}
