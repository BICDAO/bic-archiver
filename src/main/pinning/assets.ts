/**
 * The asset inventory — one row per thing inside an archive.
 *
 * This is the table a DAO member looks at to answer the only question that
 * matters: *which of our files is nobody keeping?* The May-2026 sweep of the
 * real 1.8 GB backup is the reason it exists. 10,270 of 10,762 CIDs were still
 * served by strangers; the 428 that were not were almost entirely the assets BIC
 * had itself rescued from Arweave and the ordinary web — 96.5% and 88.6% dead
 * respectively, against 0.7% for native IPFS content other people also pin.
 * Twelve NFTs had gone completely dark. The pattern is not random and it is not
 * bad luck: **content nobody pins dies, and the content BIC rescues is precisely
 * the content nobody else pins.**
 *
 * So the inventory keeps two independent facts about every entry and never
 * conflates them:
 *
 *   `network` — is anybody out there serving it? (from a health run)
 *   `pins`    — is anybody deliberately keeping it? (from Kubo / Pinata)
 *
 * A row that is 'unreachable' *and* pinned nowhere is one lost hard drive away
 * from being gone forever. {@link summarise} counts exactly that, because a
 * single honest number is worth more than ten thousand rows nobody reads.
 *
 * Nothing in this module touches the network. Everything is read from the
 * archive's own blockstore, so there is nothing to time out.
 */

import * as dagPb from '@ipld/dag-pb'
import { UnixFS } from 'ipfs-unixfs'
import { CID } from 'multiformats/cid'

import type { PBLink } from '@ipld/dag-pb'

import { LAYOUT } from '../../shared/constants.js'
import type { AssetRow, PinState, PinTargetId } from '../../shared/pinning.js'
import type { HealthResult } from '../../shared/types.js'
import type { ArchiveStore } from '../archive/store.js'
import { getBlockBytes, type Blockstore } from '../ipfs/blockstore.js'
import { cumulativeSize, listDirectory } from '../ipfs/dag.js'

/* -------------------------------------------------------------------------- */
/* tunables                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Hard ceiling on how many rows one walk may produce.
 *
 * The DAO's largest real archive is ~10,762 entries, so this is roughly fifty
 * times the expected size. It exists because a DAG can share sub-trees: a
 * deliberately built (or accidentally pathological) archive can describe
 * astronomically many *paths* from a handful of blocks, and walking it would
 * consume the machine. Hitting this is reported as a plain error rather than
 * silently truncating the list, because a short list would under-report the one
 * number this module exists to produce.
 */
const MAX_ROWS = 500_000

/* -------------------------------------------------------------------------- */
/* roles                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Folders the archiver creates for content it rescued off Arweave or the
 * ordinary web. A file inside one of these takes the folder's name as its role,
 * because that name *is* the interesting fact about it: these are the two
 * categories that died at 96.5% and 88.6%.
 */
const LAYOUT_DIRS: ReadonlySet<string> = new Set([
  LAYOUT.webMetadata,
  LAYOUT.arweaveMetadata,
  LAYOUT.webImage,
  LAYOUT.arweaveImage,
  LAYOUT.arweaveAnimation
])

/** Roles the archiver stores under their bare name, for IPFS-native content. */
const KNOWN_FILE_ROLES: ReadonlySet<string> = new Set([
  'metadata',
  'image',
  'animation',
  'thumbnail',
  'preview',
  'media'
])

/** Metadata fields whose names differ from the role they represent. */
const ROLE_ALIASES: Readonly<Record<string, string>> = {
  image_url: 'image',
  image_original: 'image',
  image_original_url: 'image',
  imageurl: 'image',
  image_data: 'image',
  animation_url: 'animation',
  animationurl: 'animation',
  external_url: 'link',
  token_metadata: 'metadata',
  tokenuri: 'metadata'
}

const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'avif',
  'svg',
  'tiff',
  'bmp',
  'heic'
])

const ANIMATION_EXTENSIONS: ReadonlySet<string> = new Set([
  'mp4',
  'webm',
  'mov',
  'm4v',
  'ogv',
  'mp3',
  'wav',
  'ogg',
  'flac',
  'glb',
  'gltf'
])

/**
 * Is this folder one of the archiver's named rescue folders?
 *
 * Matches the five in `LAYOUT` exactly, plus the open-ended pattern the archiver
 * follows for any other role (`web animation/`, `arweave thumbnail/`, …), so a
 * folder it invents next year is still classified correctly here.
 */
function isLayoutDir(name: string): boolean {
  const key = name.trim().toLowerCase()
  if (key === '') return false
  return LAYOUT_DIRS.has(key) || /^(web|arweave) \S/.test(key)
}

/** The file name with its final extension removed, lowercased. */
function baseName(name: string): string {
  const trimmed = name.trim()
  const dot = trimmed.lastIndexOf('.')
  const base = dot > 0 ? trimmed.slice(0, dot) : trimmed
  return base.toLowerCase()
}

/** The final extension, lowercased and without the dot. '' when there is none. */
function extensionOf(name: string): string {
  const trimmed = name.trim()
  const dot = trimmed.lastIndexOf('.')
  if (dot <= 0 || dot === trimmed.length - 1) return ''
  return trimmed.slice(dot + 1).toLowerCase()
}

/** Best guess at what a loose file is, from its name and then its extension. */
function roleFromFileName(name: string): string {
  const base = baseName(name)
  const alias = ROLE_ALIASES[base]
  if (alias !== undefined) return alias
  if (KNOWN_FILE_ROLES.has(base)) return base

  const extension = extensionOf(name)
  if (extension === 'json') return 'metadata'
  if (IMAGE_EXTENSIONS.has(extension)) return 'image'
  if (ANIMATION_EXTENSIONS.has(extension)) return 'animation'
  return 'file'
}

/**
 * What this entry is, in a word a member can scan a column of.
 *
 * The layout it reads is the one `provenance.ts` writes and the one the DAO's
 * hand-made backups already use:
 *
 *   <archive root>/                      role 'archive root'
 *     <Token Name>/                      role 'folder',  nft '<Token Name>'
 *       metadata                         role 'metadata'      — original CID
 *       image                            role 'image'         — original CID
 *       _provenance.json                 role 'provenance'
 *       arweave image/<file>             role 'arweave image' — rescued by BIC
 *       web metadata/<file>              role 'web metadata'  — rescued by BIC
 */
function roleFor(name: string, isDirectory: boolean, parentName: string, depth: number): string {
  if (depth === 0) return 'archive root'

  if (isDirectory) {
    // A direct child of the root is an NFT's own folder, whatever it is called.
    if (depth === 1) return 'folder'
    return isLayoutDir(name) ? name.trim().toLowerCase() : 'folder'
  }

  if (name === LAYOUT.provenance) return 'provenance'
  if (isLayoutDir(parentName)) return parentName.trim().toLowerCase()
  return roleFromFileName(name)
}

/* -------------------------------------------------------------------------- */
/* errors and cancellation                                                     */
/* -------------------------------------------------------------------------- */

/** An error whose message is already fit to show a non-technical member. */
function plain(message: string, cause?: unknown): Error {
  const err = cause === undefined ? new Error(message) : new Error(message, { cause })
  err.name = 'ArchiverError'
  return err
}

function abortError(): Error {
  const err = new Error('The list was cancelled before it finished.')
  err.name = 'AbortError'
  return err
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError()
}

/* -------------------------------------------------------------------------- */
/* CID spellings                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Every spelling of one CID, so a lookup succeeds whichever form was recorded.
 *
 * The same block is `Qm…` in a 2023 hand-made backup and `bafybei…` in one this
 * app produced, and a member does not care which — but a `Set.has()` does. Both
 * are returned whenever the conversion is possible (v0 exists only for dag-pb +
 * sha2-256), along with the original text so an unparseable value still matches
 * itself.
 */
export function cidSpellings(cid: string): string[] {
  const text = typeof cid === 'string' ? cid.trim() : ''
  if (text === '') return []

  const out = [text]

  let parsed: CID
  try {
    parsed = CID.parse(text)
  } catch {
    return out
  }

  try {
    const v1 = parsed.toV1().toString()
    if (!out.includes(v1)) out.push(v1)
  } catch {
    /* not convertible; the original spelling is all we have */
  }

  try {
    const v0 = parsed.toV0().toString()
    if (!out.includes(v0)) out.push(v0)
  } catch {
    /* only dag-pb + sha2-256 CIDs have a v0 form */
  }

  return out
}

/** Look one CID up in a set that may hold it under any spelling. */
function setHasCid(set: ReadonlySet<string>, cid: string): boolean {
  for (const spelling of cidSpellings(cid)) {
    if (set.has(spelling)) return true
  }
  return false
}

/* -------------------------------------------------------------------------- */
/* DAG classification                                                          */
/* -------------------------------------------------------------------------- */

/**
 * What one block turned out to be.
 *
 * `missing` and `damaged` are kept apart deliberately: one means "download it
 * again", the other means "this copy is corrupt". Both are reported as rows
 * rather than swallowed, because a member whose archive has a hole needs to see
 * the hole.
 */
type NodeKind =
  | { kind: 'directory'; sharded: boolean; links: readonly PBLink[] }
  | { kind: 'file'; bytes?: number }
  | { kind: 'missing' }
  | { kind: 'damaged' }

/**
 * Decide whether a CID is a folder or a file — the one thing this module must
 * not get wrong.
 *
 * `ipfs-unixfs-exporter`'s `recursive()` would be the obvious way to walk an
 * archive, but in this version it yields light entries carrying no `type` field
 * at all, so every folder would be counted as a file and the totals would be
 * quietly wrong. Deciding from the block itself is both correct and cheaper: one
 * read answers "is it a directory?" *and* hands back the links needed to walk
 * into it, where the exporter route costs a second read per node.
 *
 * Non-dag-pb codecs have no UnixFS links to follow and are therefore always
 * files: a raw leaf (0x55) is a lump of bytes by definition, and dag-cbor,
 * dag-json and identity blocks are leaves as far as a UnixFS listing goes.
 */
async function classify(cid: CID, blockstore: Blockstore): Promise<NodeKind> {
  if (cid.code !== dagPb.code) {
    return { kind: 'file' }
  }

  let bytes: Uint8Array
  try {
    bytes = await getBlockBytes(blockstore, cid)
  } catch {
    return { kind: 'missing' }
  }

  let node
  try {
    node = dagPb.decode(bytes)
  } catch {
    return { kind: 'damaged' }
  }

  if (node.Data === undefined) {
    // A links-only dag-pb node. Unusual, but it behaves like a directory —
    // the same reading `dag.ts` takes, so the two modules agree.
    return { kind: 'directory', sharded: false, links: node.Links }
  }

  let unixfs: UnixFS
  try {
    unixfs = UnixFS.unmarshal(node.Data)
  } catch {
    return { kind: 'damaged' }
  }

  if (unixfs.isDirectory()) {
    return {
      kind: 'directory',
      sharded: unixfs.type === 'hamt-sharded-directory',
      links: node.Links
    }
  }

  // A file's own links are its chunks, not its contents — never walked, so a
  // 300 MB video is one row rather than three hundred.
  try {
    return { kind: 'file', bytes: Number(unixfs.fileSize()) }
  } catch {
    return { kind: 'file' }
  }
}

/** One child of a directory, however that directory is encoded. */
interface ChildEntry {
  name: string
  cid: CID
  /** The dag-pb link `Tsize`: cumulative size of the child's whole sub-DAG. */
  size: number
}

/**
 * The children of a directory we have already classified.
 *
 * Plain directories are read straight off the links we decoded a moment ago.
 * Split (HAMT-sharded) directories — which this app never creates but a merged
 * older backup may contain — go through `listDirectory`, which resolves the
 * shard structure into real file names instead of two-character shard prefixes.
 */
async function childrenOf(
  cid: CID,
  node: Extract<NodeKind, { kind: 'directory' }>,
  blockstore: Blockstore
): Promise<ChildEntry[]> {
  if (node.sharded) {
    const entries = await listDirectory(cid, blockstore)
    return entries.map((entry) => ({ name: entry.name, cid: entry.cid, size: entry.size }))
  }

  const out: ChildEntry[] = []
  for (const link of node.links) {
    out.push({ name: link.Name ?? '', cid: link.Hash, size: link.Tsize ?? 0 })
  }
  return out
}

/* -------------------------------------------------------------------------- */
/* the walk                                                                    */
/* -------------------------------------------------------------------------- */

/** One pending entry in the depth-first walk. */
interface WalkItem {
  cid: CID
  /** Path relative to the archive root, without a leading slash. '' for root. */
  path: string
  /** Name of the folder immediately containing this entry. '' for root. */
  parentName: string
  /** Name of the top-level NFT folder this entry belongs to. '' for root. */
  nft: string
  /** The parent link's `Tsize`, or the measured size for the root. */
  size: number
  depth: number
}

function makeRow(item: WalkItem, isDirectory: boolean, role: string, size: number): AssetRow {
  return {
    cid: item.cid.toString(),
    path: item.path,
    nft: item.nft,
    role,
    size: Number.isFinite(size) && size > 0 ? Math.round(size) : 0,
    isDirectory,
    network: 'unchecked',
    pins: {}
  }
}

/**
 * Walk an archive's DAG and describe everything in it.
 *
 * Rows come back in depth-first order, starting with the archive root itself —
 * `role: 'archive root'`, `nft: ''`, `path: ''`. Pinning that one CID
 * recursively covers the entire archive, which is why it is first and why it is
 * never omitted. Every other path is relative to it, e.g.
 * `Bored Ape #1/arweave image/ape.png`.
 *
 * One row is produced per *entry*, not per unique CID: the same image reached
 * through two NFTs is two rows sharing one `cid`, because a member looking for
 * "where does this file live" needs both paths. De-duplicate by `cid` before
 * pinning.
 *
 * `network` starts `'unchecked'` and `pins` starts empty — neither is guessed.
 * Feed them in afterwards with {@link mergeHealth} and {@link mergePinStates}.
 *
 * @throws A plain-English `Error` when the archive has no assembled backup
 * folder yet, or when it is so large the list cannot be built. Missing or
 * corrupt blocks do *not* throw: they appear as rows with role `'missing'` or
 * `'damaged'`, so a member sees the hole rather than an empty screen.
 * @throws An `Error` with `name === 'AbortError'` if `signal` is aborted.
 */
export async function buildAssetRows(store: ArchiveStore, signal?: AbortSignal): Promise<AssetRow[]> {
  throwIfCancelled(signal)

  const rootText = store.manifest.rootCid?.trim() ?? ''
  if (rootText === '') {
    throw plain(
      'This archive has not been put together into a backup folder yet, so there is nothing to list. ' +
        'Build the backup first — that is the step that gives the whole archive a single address.'
    )
  }

  let root: CID
  try {
    root = CID.parse(rootText)
  } catch (err) {
    throw plain(
      `This archive records its backup folder as "${rootText}", which is not an address this app can read. ` +
        'Build the backup folder again to give it a fresh address.',
      err
    )
  }

  const blockstore = store.blockstore

  let rootSize = 0
  try {
    rootSize = await cumulativeSize(root, blockstore)
  } catch {
    // The root block may be missing; the walk below reports that properly.
  }

  const rows: AssetRow[] = []
  const stack: WalkItem[] = [
    { cid: root, path: '', parentName: '', nft: '', size: rootSize, depth: 0 }
  ]

  while (stack.length > 0) {
    throwIfCancelled(signal)

    const item = stack.pop()
    if (item === undefined) break

    if (rows.length >= MAX_ROWS) {
      throw plain(
        `This archive describes more than ${MAX_ROWS.toLocaleString('en-GB')} items, which is far more than ` +
          'a backup of NFTs should contain. Listing it was stopped so the app does not run out of memory. ' +
          'Check that the right folder was opened, and contact whoever supports this app if it is correct.'
      )
    }

    const node = await classify(item.cid, blockstore)
    const name = item.depth === 0 ? '' : lastSegment(item.path)

    if (node.kind === 'missing') {
      rows.push(makeRow(item, false, 'missing', item.size))
      continue
    }
    if (node.kind === 'damaged') {
      rows.push(makeRow(item, false, 'damaged', item.size))
      continue
    }
    if (node.kind === 'file') {
      const size = node.bytes !== undefined && node.bytes > 0 ? node.bytes : item.size
      rows.push(makeRow(item, false, roleFor(name, false, item.parentName, item.depth), size))
      continue
    }

    // A directory. Its recorded size is the whole sub-DAG beneath it, which is
    // why `summarise` adds up files only.
    rows.push(makeRow(item, true, roleFor(name, true, item.parentName, item.depth), item.size))

    let children: ChildEntry[]
    try {
      children = await childrenOf(item.cid, node, blockstore)
    } catch {
      // A split directory whose shards are not all stored locally. The folder
      // itself is already listed; its contents simply cannot be reached.
      continue
    }

    // Pushed in reverse so they come back off the stack in link order, which is
    // the canonical (byte-wise by name) order `dag.ts` guarantees.
    for (let i = children.length - 1; i >= 0; i -= 1) {
      const child = children[i]
      if (child === undefined) continue

      const childName = child.name.trim() === '' ? child.cid.toString() : child.name
      const path = item.depth === 0 ? childName : `${item.path}/${childName}`
      const nft = item.depth === 0 ? childName : item.nft

      stack.push({
        cid: child.cid,
        path,
        parentName: name,
        nft,
        size: child.size,
        depth: item.depth + 1
      })
    }
  }

  return rows
}

/** The last `/`-separated segment of a path. */
function lastSegment(path: string): string {
  const cut = path.lastIndexOf('/')
  return cut === -1 ? path : path.slice(cut + 1)
}

/* -------------------------------------------------------------------------- */
/* merging in what we learned                                                  */
/* -------------------------------------------------------------------------- */

/** Worst-first, so a CID checked twice keeps its most pessimistic verdict. */
const NETWORK_SEVERITY: Readonly<Record<AssetRow['network'], number>> = {
  healthy: 0,
  unchecked: 1,
  'at-risk': 2,
  unreachable: 3
}

/**
 * Apply health-check verdicts to the rows they belong to.
 *
 * Rows are matched on CID in every spelling, so a health run over `Qm…` marks a
 * row the archive recorded as `bafybei…`. Rows nothing was checked for keep
 * whatever `network` they already had — a missing result is not evidence of
 * anything, and quietly downgrading it to 'unreachable' would send a member
 * chasing files that are perfectly fine.
 *
 * If one CID somehow arrives with two different verdicts, the worse one wins.
 * Returns new rows; the input array and its rows are not modified.
 */
export function mergeHealth(rows: AssetRow[], health: HealthResult[]): AssetRow[] {
  const verdicts = new Map<string, AssetRow['network']>()

  for (const result of health) {
    if (result === undefined || result === null) continue
    const verdict = result.verdict
    if (verdict !== 'healthy' && verdict !== 'at-risk' && verdict !== 'unreachable') continue

    for (const spelling of cidSpellings(result.cid)) {
      const existing = verdicts.get(spelling)
      if (existing === undefined || NETWORK_SEVERITY[verdict] > NETWORK_SEVERITY[existing]) {
        verdicts.set(spelling, verdict)
      }
    }
  }

  if (verdicts.size === 0) {
    return rows.map(cloneRow)
  }

  return rows.map((row) => {
    const clone = cloneRow(row)
    for (const spelling of cidSpellings(row.cid)) {
      const verdict = verdicts.get(spelling)
      if (verdict !== undefined) {
        clone.network = verdict
        break
      }
    }
    return clone
  })
}

/**
 * Apply "what is actually pinned" to the rows.
 *
 * Pass `null` (or omit) for a target you did not ask about — a node that was
 * switched off, a Pinata account with no token. That leaves the row's state for
 * that target *absent*, which reads as `unknown`, and is the whole point: the
 * contract in `pinning.ts` is explicit that `unknown` must never be rendered as
 * "not pinned", because the difference decides whether a member spends an
 * afternoon re-pinning content that was never at risk.
 *
 * An *empty* set, on the other hand, is a real answer meaning "nothing is
 * pinned" — both `kubo.listPins` and `pinata.listPinnedCids` throw rather than
 * return a short set, precisely so that an empty one can be trusted.
 *
 * Sets are consulted in every CID spelling, and Kubo's set includes indirect
 * pins, so the ten thousand files inside a recursively pinned archive folder are
 * correctly reported as kept.
 *
 * Returns new rows; the input array and its rows are not modified.
 */
export function mergePinStates(
  rows: AssetRow[],
  kuboPins: ReadonlySet<string> | null | undefined,
  pinataPins: ReadonlySet<string> | null | undefined
): AssetRow[] {
  return rows.map((row) => {
    const clone = cloneRow(row)
    applyPinSet(clone, 'kubo', kuboPins)
    applyPinSet(clone, 'pinata', pinataPins)
    return clone
  })
}

function applyPinSet(
  row: AssetRow,
  target: PinTargetId,
  pins: ReadonlySet<string> | null | undefined
): void {
  if (pins === null || pins === undefined) return
  const state: PinState = setHasCid(pins, row.cid) ? 'pinned' : 'not-pinned'
  row.pins[target] = state
}

function cloneRow(row: AssetRow): AssetRow {
  return { ...row, pins: { ...row.pins } }
}

/* -------------------------------------------------------------------------- */
/* the numbers                                                                 */
/* -------------------------------------------------------------------------- */

/** What {@link summarise} reports. */
export interface AssetSummary {
  /** Every row, folders included. */
  total: number
  files: number
  folders: number
  /**
   * Total bytes of *file* content. Folders are excluded on purpose: a folder's
   * recorded size already contains everything beneath it, so counting both
   * would report an archive as several times its real weight.
   */
  bytes: number
  /** Rows a health run found nobody willing to serve. */
  unreachable: number
  /**
   * **The number that matters.** Rows that are pinned at no target we asked
   * about *and* are not confirmed healthy on the public network.
   *
   * Deliberately counts `'unchecked'` rows as well as `'at-risk'` and
   * `'unreachable'` ones. Before a health run there is no evidence anyone serves
   * them and no evidence anyone keeps them, and that is exactly the state the
   * DAO's 428 dead CIDs were in for two years while everyone assumed the backup
   * was fine. Erring towards alarm is the right direction for this one figure:
   * the failure this app exists to prevent is complacency, not over-caution.
   */
  unpinnedEverywhere: number
}

/**
 * Reduce a table nobody will read to five numbers somebody will.
 *
 * Counts rows, not unique CIDs — the same file archived under two NFTs is two
 * things a member has to look after.
 */
export function summarise(rows: AssetRow[]): AssetSummary {
  let files = 0
  let folders = 0
  let bytes = 0
  let unreachable = 0
  let unpinnedEverywhere = 0

  for (const row of rows) {
    if (row.isDirectory) {
      folders += 1
    } else {
      files += 1
      if (Number.isFinite(row.size) && row.size > 0) bytes += row.size
    }

    if (row.network === 'unreachable') unreachable += 1

    const keptSomewhere = row.pins.kubo === 'pinned' || row.pins.pinata === 'pinned'
    if (!keptSomewhere && row.network !== 'healthy') unpinnedEverywhere += 1
  }

  return { total: rows.length, files, folders, bytes, unreachable, unpinnedEverywhere }
}
