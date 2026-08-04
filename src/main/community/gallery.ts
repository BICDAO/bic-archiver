/**
 * The gallery — the archive as a member actually sees it.
 *
 * Every other view in this app is a list of content addresses. That is the right
 * shape for proving something is safe and the wrong shape for getting anybody to
 * care. The May-2026 sweep found 428 dead CIDs and twelve NFTs with no copy
 * anywhere but BIC's one backup file; "12 rows are unreachable" moves nobody,
 * whereas twelve pictures of things the DAO owns, greyed out, moves people to
 * click the mirror button. So this module turns the archive DAG back into
 * pictures, names and traits.
 *
 * What it reads is the layout `provenance.ts` writes and the DAO's hand-made
 * backups already use:
 *
 *   <archive root>/
 *     <Token Name>/
 *       metadata                 the original IPFS file, no extension
 *       image                    the original IPFS file, no extension
 *       animation
 *       web metadata/<file>      rescued off an ordinary web server
 *       web image/<file>
 *       arweave image/<file>     rescued off Arweave
 *       arweave animation/<file>
 *       _provenance.json         the audit record
 *
 * …except that the real May-2026 backup, which is what this has to work on,
 * disagrees with that in every way a hand-built archive can. Measured over its
 * 65 top-level folders: `image` and `metadata` are *folders* in 37 and 42 of
 * them (`image/nft.mp4`, `metadata/metadata.json`) and plain files in the rest;
 * two folders' `metadata/` holds the collection's entire ten-thousand-file
 * metadata directory, named by token id; four folders are bundles containing
 * several NFTs each; and the rescue folders include `web glb/`, `web vrm/` and
 * `web pet/` alongside the documented five. Every one of those shapes is handled
 * below, and the reason each rule exists is written next to it.
 *
 * Three things are done defensively on purpose:
 *
 *  - **Every folder produces an item.** A folder whose blocks are missing, whose
 *    metadata is not JSON, or which came out of somebody's 2023 hand-made backup
 *    with a completely different shape still appears, named after the folder. A
 *    gallery that silently omits the broken ones would hide exactly the NFTs
 *    this app exists to rescue.
 *  - **Content types come from the bytes, not the file name.** Half the rescued
 *    files have no extension at all, and `animation` is as likely to be a 40 MB
 *    `.glb` as an MP4. The GUI has to know before it puts the thing in an
 *    `<img>`.
 *  - **Nothing here touches the network.** Every byte is read from the archive's
 *    own blockstore, so there is no request to time out and no gateway to blame.
 *    Network verdicts arrive separately, through {@link mergeGalleryHealth}.
 */

import * as dagPb from '@ipld/dag-pb'
import { UnixFS } from 'ipfs-unixfs'
import { exporter } from 'ipfs-unixfs-exporter'
import { CID } from 'multiformats/cid'

import type { PBLink } from '@ipld/dag-pb'
import type { UnixFSEntry } from 'ipfs-unixfs-exporter'

import type { GalleryItem, GallerySummary } from '../../shared/community.js'
import { LAYOUT } from '../../shared/constants.js'
import type { ArchivedToken, HealthResult } from '../../shared/types.js'
import type { ArchiveStore } from '../archive/store.js'
import { getBlockBytes, type Blockstore } from '../ipfs/blockstore.js'
import { cumulativeSize, listDirectory } from '../ipfs/dag.js'
import { cidSpellings } from '../pinning/assets.js'

/* -------------------------------------------------------------------------- */
/* tunables                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Ceiling on how many NFT folders one gallery may describe.
 *
 * The DAO's real archive holds 274. Fifty thousand is far past anything
 * legitimate and exists only so a hostile or accidentally enormous directory
 * cannot fill memory before anyone notices.
 */
const MAX_ITEMS = 50_000

/** Refuse to read anything larger than this as a metadata document. */
const MAX_METADATA_BYTES = 8 * 1024 * 1024

/**
 * Above this, the parsed metadata object is left off the item.
 *
 * Fully on-chain NFTs embed an entire SVG in `image_data`, which can be several
 * megabytes of base64. Carrying hundreds of those across IPC to draw a grid of
 * thumbnails would cost more than the images themselves. The name, description
 * and traits are still extracted; only the raw object is dropped.
 */
const MAX_INLINE_METADATA_BYTES = 256 * 1024

/** Enough leading bytes to recognise any format below, including XML preambles. */
const SNIFF_BYTES = 512

/** `_provenance.json` is a few kilobytes; anything huge under that name is not it. */
const MAX_PROVENANCE_BYTES = 1024 * 1024

/** Display limits, so one absurd metadata file cannot bloat the whole list. */
const MAX_ATTRIBUTES = 200
const MAX_TRAIT_TEXT = 500
const MAX_DESCRIPTION = 4_000

/**
 * Default ceiling on a single {@link readMediaBytes} call.
 *
 * A 200 MB video must never be buffered whole just because something asked for
 * it; callers that need more read it in slices.
 */
const DEFAULT_MEDIA_LIMIT = 64 * 1024 * 1024

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
  const err = new Error('Loading the gallery was cancelled before it finished.')
  err.name = 'AbortError'
  return err
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted === true) throw abortError()
}

/* -------------------------------------------------------------------------- */
/* names, extensions and roles                                                 */
/* -------------------------------------------------------------------------- */

/** The file name with its final extension removed, trimmed and lowercased. */
function baseNameOf(name: string): string {
  const trimmed = name.trim()
  const dot = trimmed.lastIndexOf('.')
  return (dot > 0 ? trimmed.slice(0, dot) : trimmed).toLowerCase()
}

/** The final extension, lowercased and without the dot. '' when there is none. */
function extensionOf(name: string): string {
  const trimmed = name.trim()
  const dot = trimmed.lastIndexOf('.')
  if (dot <= 0 || dot === trimmed.length - 1) return ''
  return trimmed.slice(dot + 1).toLowerCase()
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
  'tif',
  'bmp',
  'heic'
])

const ANIMATION_EXTENSIONS: ReadonlySet<string> = new Set([
  'mp4',
  'webm',
  'mov',
  'm4v',
  'ogv',
  'ogg',
  'mp3',
  'wav',
  'flac',
  'glb',
  'gltf',
  'html'
])

/** Media types by extension — the fallback for files whose bytes say nothing. */
const TYPE_BY_EXTENSION: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
  tiff: 'image/tiff',
  tif: 'image/tiff',
  bmp: 'image/bmp',
  heic: 'image/heic',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  ogv: 'video/ogg',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  flac: 'audio/flac',
  glb: 'model/gltf-binary',
  gltf: 'model/gltf+json',
  json: 'application/json',
  html: 'text/html',
  txt: 'text/plain',
  pdf: 'application/pdf'
}

/** Folder names the archiver uses for content it rescued, per role. */
const METADATA_DIRS = [LAYOUT.webMetadata, LAYOUT.arweaveMetadata] as const
const IMAGE_DIRS = [LAYOUT.webImage, LAYOUT.arweaveImage] as const
const ANIMATION_DIRS = [LAYOUT.arweaveAnimation, 'web animation'] as const

/* -------------------------------------------------------------------------- */
/* reading the DAG                                                             */
/* -------------------------------------------------------------------------- */

/** One entry in a directory. `size` is the link `Tsize` — the whole sub-DAG. */
interface Entry {
  name: string
  cid: CID
  size: number
}

/**
 * What one CID turned out to be.
 *
 * `unreadable` covers both "not on this computer" and "corrupt", because from
 * the gallery's point of view they are the same fact: there is nothing to show,
 * and the folder must still be listed so the member sees the hole.
 */
type DirRead =
  | { kind: 'directory'; entries: Entry[] }
  | { kind: 'file' }
  | { kind: 'unreadable' }

function entriesFromLinks(links: readonly PBLink[]): Entry[] {
  const out: Entry[] = []
  for (const link of links) {
    out.push({ name: link.Name ?? '', cid: link.Hash, size: link.Tsize ?? 0 })
  }
  return out
}

/**
 * List a directory straight out of its own block.
 *
 * Deciding from the block (rather than through the exporter) costs one read and
 * answers "is this a folder?" and "what is in it?" at the same time — the same
 * approach `pinning/assets.ts` takes, so the two modules cannot disagree about
 * what counts as a folder. Split (HAMT-sharded) directories, which this app
 * never writes but a merged 2023 backup may contain, go through `listDirectory`
 * so their entries come back as real names.
 */
async function readDirectory(cid: CID, blockstore: Blockstore): Promise<DirRead> {
  if (cid.code !== dagPb.code) return { kind: 'file' }

  let bytes: Uint8Array
  try {
    bytes = await getBlockBytes(blockstore, cid)
  } catch {
    return { kind: 'unreadable' }
  }

  let node
  try {
    node = dagPb.decode(bytes)
  } catch {
    return { kind: 'unreadable' }
  }

  if (node.Data === undefined) {
    // A links-only dag-pb node behaves like a directory.
    return { kind: 'directory', entries: entriesFromLinks(node.Links) }
  }

  let unixfs: UnixFS
  try {
    unixfs = UnixFS.unmarshal(node.Data)
  } catch {
    return { kind: 'unreadable' }
  }

  if (!unixfs.isDirectory()) return { kind: 'file' }

  if (unixfs.type === 'hamt-sharded-directory') {
    try {
      const entries = await listDirectory(cid, blockstore)
      return {
        kind: 'directory',
        entries: entries.map((entry) => ({ name: entry.name, cid: entry.cid, size: entry.size }))
      }
    } catch {
      return { kind: 'unreadable' }
    }
  }

  return { kind: 'directory', entries: entriesFromLinks(node.Links) }
}

/** A slice of one file's bytes, plus how big the whole file is. */
interface FileSlice {
  bytes: Uint8Array
  /** Size of the complete file. `bytes` may be shorter. */
  totalBytes: number
}

/** Clamp a requested window to something the file can actually satisfy. */
function sliceWindow(
  total: number,
  offset: number,
  length: number | undefined,
  cap: number
): { start: number; length: number } {
  const size = Number.isFinite(total) && total > 0 ? Math.floor(total) : 0
  const start = Math.min(Math.max(Math.floor(Number.isFinite(offset) ? offset : 0), 0), size)
  const remaining = size - start

  const requested =
    length === undefined || !Number.isFinite(length)
      ? remaining
      : Math.min(Math.max(Math.floor(length), 0), remaining)

  const limit = Number.isFinite(cap) && cap > 0 ? Math.floor(cap) : 0

  return { start, length: Math.min(requested, limit) }
}

function concatChunks(chunks: Uint8Array[], limit: number): Uint8Array {
  if (chunks.length === 1) {
    const only = chunks[0]
    if (only !== undefined) {
      return only.byteLength <= limit ? only : only.subarray(0, limit)
    }
  }

  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
  const out = new Uint8Array(Math.min(total, limit))
  let offset = 0
  for (const chunk of chunks) {
    if (offset >= out.byteLength) break
    const room = out.byteLength - offset
    out.set(chunk.byteLength <= room ? chunk : chunk.subarray(0, room), offset)
    offset += Math.min(chunk.byteLength, room)
  }
  return out
}

/** The real size of an exported entry's content, in bytes. */
function contentSizeOf(entry: UnixFSEntry, cid: CID): number {
  switch (entry.type) {
    case 'file': {
      const declared = entry.unixfs.fileSize()
      return declared === undefined ? Number(entry.size) : Number(declared)
    }
    case 'raw':
      return Number(entry.size)
    case 'identity':
      // The exporter reports the multihash length here but streams the digest.
      return cid.multihash.digest.byteLength
    case 'object':
      return entry.node.byteLength
    default:
      return 0
  }
}

/**
 * Read part of one file out of the blockstore.
 *
 * Returns `null` — never throws — when the CID names a folder, when its blocks
 * are not on this computer, or when the content cannot be read. Every caller
 * here has a sensible answer for "we could not read it", and none of them has a
 * sensible answer for an exception thrown while drawing a picture grid.
 */
async function readFileSlice(
  cid: CID,
  blockstore: Blockstore,
  offset: number,
  length: number | undefined,
  cap: number
): Promise<FileSlice | null> {
  let entry: UnixFSEntry
  try {
    entry = await exporter(cid, blockstore)
  } catch {
    return null
  }

  if (entry.type === 'directory') return null

  const total = contentSizeOf(entry, cid)
  const window = sliceWindow(total, offset, length, cap)

  if (entry.type === 'object') {
    // dag-cbor / dag-json nodes have no byte stream; their block is the content.
    return {
      bytes: entry.node.subarray(window.start, window.start + window.length),
      totalBytes: total
    }
  }

  if (window.length === 0) {
    return { bytes: new Uint8Array(0), totalBytes: total }
  }

  const chunks: Uint8Array[] = []
  let read = 0

  try {
    for await (const chunk of entry.content({ offset: window.start, length: window.length })) {
      chunks.push(chunk)
      read += chunk.byteLength
      if (read >= window.length) break
    }
  } catch {
    // A block in the middle of the file is missing or corrupt.
    return null
  }

  return { bytes: concatChunks(chunks, window.length), totalBytes: total }
}

/* -------------------------------------------------------------------------- */
/* content sniffing                                                            */
/* -------------------------------------------------------------------------- */

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  if (bytes.byteLength < signature.length) return false
  for (let i = 0; i < signature.length; i++) {
    if (bytes[i] !== signature[i]) return false
  }
  return true
}

/** ASCII text of a byte range, for the magic numbers that are readable words. */
function ascii(bytes: Uint8Array, start: number, length: number): string {
  if (bytes.byteLength < start + length) return ''
  let out = ''
  for (let i = start; i < start + length; i++) {
    out += String.fromCharCode(bytes[i] ?? 0)
  }
  return out
}

/** ISO base-media brands that are not video, keyed by the brand at offset 8. */
const ISO_BRANDS: Readonly<Record<string, string>> = {
  avif: 'image/avif',
  avis: 'image/avif',
  heic: 'image/heic',
  heix: 'image/heic',
  heif: 'image/heif',
  mif1: 'image/heif',
  'qt  ': 'video/quicktime',
  'M4A ': 'audio/mp4'
}

/**
 * What is this file, judged by its first bytes?
 *
 * The archive is full of files with no extension (that is the layout: an entry
 * called `image` *is* the original CID) and of rescued files whose extension
 * came from a URL and lies. Magic numbers do not lie, and the difference decides
 * whether the GUI puts the thing in an `<img>`, in a `<video>`, or in neither —
 * a `.glb` model in an `<img>` is just a broken-image icon and a confused member.
 *
 * Returns `undefined` when the bytes match nothing known; the caller falls back
 * to the file name.
 */
export function sniffContentType(head: Uint8Array): string | undefined {
  if (head.byteLength === 0) return undefined

  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'
  if (startsWith(head, [0xff, 0xd8, 0xff])) return 'image/jpeg'

  const gif = ascii(head, 0, 6)
  if (gif === 'GIF87a' || gif === 'GIF89a') return 'image/gif'

  if (ascii(head, 0, 4) === 'RIFF') {
    const form = ascii(head, 8, 4)
    if (form === 'WEBP') return 'image/webp'
    if (form === 'WAVE') return 'audio/wav'
    if (form === 'AVI ') return 'video/x-msvideo'
  }

  if (ascii(head, 4, 4) === 'ftyp') {
    const brand = ascii(head, 8, 4)
    return ISO_BRANDS[brand] ?? 'video/mp4'
  }

  if (startsWith(head, [0x1a, 0x45, 0xdf, 0xa3])) return 'video/webm'
  if (ascii(head, 0, 4) === 'OggS') return 'audio/ogg'
  if (ascii(head, 0, 4) === 'fLaC') return 'audio/flac'
  if (ascii(head, 0, 3) === 'ID3') return 'audio/mpeg'
  if (head[0] === 0xff && (head[1] === 0xfb || head[1] === 0xf3 || head[1] === 0xf2)) {
    return 'audio/mpeg'
  }
  if (ascii(head, 0, 4) === 'glTF') return 'model/gltf-binary'
  if (ascii(head, 0, 5) === '%PDF-') return 'application/pdf'
  if (startsWith(head, [0x42, 0x4d])) return 'image/bmp'
  if (startsWith(head, [0x49, 0x49, 0x2a, 0x00]) || startsWith(head, [0x4d, 0x4d, 0x00, 0x2a])) {
    return 'image/tiff'
  }

  // Text formats. An SVG may be preceded by a byte order mark, an XML
  // declaration, a doctype and comments, so the whole head is searched rather
  // than only its first characters.
  const text = decodeUtf8(head)
  // Drop a UTF-8 byte order mark before looking at the first real character.
  const trimmed = (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).trimStart()

  if (trimmed.startsWith('<')) {
    const lower = trimmed.toLowerCase()
    if (lower.includes('<svg')) return 'image/svg+xml'
    if (lower.startsWith('<!doctype html') || lower.startsWith('<html')) return 'text/html'
    if (lower.startsWith('<?xml')) return 'application/xml'
    return undefined
  }

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return 'application/json'

  return undefined
}

/** The sniffed type, then the extension, then an honest "we do not know". */
function contentTypeFor(head: Uint8Array, fileName: string): string {
  return sniffContentType(head) ?? TYPE_BY_EXTENSION[extensionOf(fileName)] ?? 'application/octet-stream'
}

function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  } catch {
    return ''
  }
}

/* -------------------------------------------------------------------------- */
/* metadata                                                                    */
/* -------------------------------------------------------------------------- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseJson(bytes: Uint8Array): Record<string, unknown> | undefined {
  let text = decodeUtf8(bytes)
  if (text === '') return undefined
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)

  let value: unknown
  try {
    value = JSON.parse(text) as unknown
  } catch {
    return undefined
  }

  return isRecord(value) ? value : undefined
}

/** Shorten for display, saying so, rather than letting one field fill the panel. */
function clip(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`
}

function readString(source: Record<string, unknown>, fields: readonly string[]): string | undefined {
  for (const field of fields) {
    const value = source[field]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return undefined
}

/** Turn any trait value into something printable, or drop it. */
function traitValue(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed === '' ? undefined : clip(trimmed, MAX_TRAIT_TEXT)
  }
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : undefined
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'boolean') return value ? 'true' : 'false'

  try {
    const text = JSON.stringify(value)
    return text === undefined || text === '' ? undefined : clip(text, MAX_TRAIT_TEXT)
  } catch {
    return undefined
  }
}

/** Field names collections use for the *name* of a trait. */
const LABEL_FIELDS = ['trait_type', 'traitType', 'trait', 'key', 'name', 'label', 'type'] as const
/** Field names collections use for the *value* of a trait. */
const VALUE_FIELDS = ['value', 'trait_value', 'val'] as const

function traitFromObject(item: Record<string, unknown>): { label: string; value: string } | undefined {
  const label = readString(item, LABEL_FIELDS)
  let value: string | undefined

  for (const field of VALUE_FIELDS) {
    if (field in item) {
      value = traitValue(item[field])
      break
    }
  }

  if (label !== undefined && value !== undefined) {
    return { label: clip(label, MAX_TRAIT_TEXT), value }
  }

  if (label === undefined && value === undefined) {
    // The `{ "Hat": "Cap" }` shape: a one-key object that *is* the trait.
    const keys = Object.keys(item)
    const only = keys[0]
    if (keys.length === 1 && only !== undefined) {
      const single = traitValue(item[only])
      if (single !== undefined) return { label: clip(only, MAX_TRAIT_TEXT), value: single }
    }
    return undefined
  }

  if (label !== undefined) {
    // A named trait with no value is noise, not information.
    return undefined
  }

  return value === undefined ? undefined : { label: 'Trait', value }
}

/** Is every value in this object something we could print? */
function isFlatRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false
  for (const entry of Object.values(value)) {
    if (entry !== null && typeof entry === 'object') return false
  }
  return true
}

/**
 * Normalise traits, because collections cannot agree on how to write them.
 *
 * Seen in the DAO's own archive and in the wild:
 *
 *   "attributes": [{ "trait_type": "Hat", "value": "Cap" }]   the OpenSea shape
 *   "attributes": [{ "key": "Hat", "value": "Cap" }]          Tezos-ish
 *   "attributes": [{ "name": "Hat", "value": "Cap" }]
 *   "attributes": { "Hat": "Cap" }                            a plain object
 *   "attributes": ["Cap", "Blue"]                             just the values
 *   "traits":     …                                           same, other name
 *
 * All of them come out as `{ label, value }` pairs of strings. Anything that
 * cannot be printed is dropped rather than rendered as `[object Object]`.
 */
export function normaliseAttributes(
  metadata: Record<string, unknown> | undefined
): Array<{ label: string; value: string }> {
  if (metadata === undefined) return []

  let source = metadata['attributes'] ?? metadata['traits'] ?? metadata['attribute']
  if (source === undefined && isFlatRecord(metadata['properties'])) {
    source = metadata['properties']
  }
  if (source === undefined) return []

  const out: Array<{ label: string; value: string }> = []

  if (Array.isArray(source)) {
    for (const item of source) {
      if (out.length >= MAX_ATTRIBUTES) break

      if (isRecord(item)) {
        const trait = traitFromObject(item)
        if (trait !== undefined) out.push(trait)
        continue
      }

      const value = traitValue(item)
      if (value !== undefined) out.push({ label: 'Trait', value })
    }
    return out
  }

  if (isRecord(source)) {
    for (const [key, value] of Object.entries(source)) {
      if (out.length >= MAX_ATTRIBUTES) break
      const printable = traitValue(value)
      if (printable === undefined) continue
      out.push({ label: clip(key.trim() === '' ? 'Trait' : key.trim(), MAX_TRAIT_TEXT), value: printable })
    }
  }

  return out
}

/* -------------------------------------------------------------------------- */
/* finding the pieces inside one NFT folder                                    */
/* -------------------------------------------------------------------------- */

/**
 * One direct child of an NFT folder, already classified.
 *
 * Classifying every child up front costs one block read each and removes the
 * single biggest source of wrong answers here: in the DAO's real May-2026
 * backup, `image` and `metadata` are *directories* in 37 and 42 of the 65
 * folders — `image/nft.mp4`, `metadata/metadata.json` — and only files in the
 * rest. Guessing from the name alone would lose the picture for more than half
 * the collection.
 */
interface Child extends Entry {
  kind: 'file' | 'directory' | 'unreadable'
  /** Contents, when this child is a folder. */
  entries: Entry[]
}

async function readChildren(
  entries: Entry[],
  blockstore: Blockstore,
  signal?: AbortSignal
): Promise<Child[]> {
  const out: Child[] = []

  for (const entry of entries) {
    throwIfCancelled(signal)
    const listing = await readDirectory(entry.cid, blockstore)
    out.push({
      ...entry,
      kind: listing.kind,
      entries: listing.kind === 'directory' ? listing.entries : []
    })
  }

  return out
}

/** How to find one role's file, in the shapes the real archives actually use. */
interface RoleSpec {
  /**
   * Names of a direct child to try, in order. Both files and folders: the same
   * name means the same thing whichever it turns out to be.
   */
  names: readonly string[]
  /** Extensions worth preferring when choosing inside a folder. */
  extensions: ReadonlySet<string>
  /** File names worth preferring inside a folder, without their extension. */
  insideNames: readonly string[]
  /**
   * May we take an arbitrary file from a folder holding many candidates?
   *
   * True for pictures: a cover taken from a folder of 150 images is a fair
   * representation of a folder of 150 images. False for metadata, because an
   * arbitrary pick there would put another token's *name and traits* on this
   * tile — confidently wrong, which is worse than blank.
   */
  coverFromCrowd: boolean
}

const JSON_EXTENSIONS: ReadonlySet<string> = new Set(['json', 'txt'])

const METADATA_ROLE: RoleSpec = {
  names: ['metadata', ...METADATA_DIRS, 'token', 'json'],
  extensions: JSON_EXTENSIONS,
  insideNames: ['metadata', 'token', 'index', 'info', 'nft'],
  coverFromCrowd: false
}

const IMAGE_ROLE: RoleSpec = {
  names: ['image', ...IMAGE_DIRS, 'images', 'image_original', 'thumbnail', 'preview'],
  extensions: IMAGE_EXTENSIONS,
  insideNames: ['nft', 'image', 'artwork', 'preview', 'thumbnail'],
  coverFromCrowd: true
}

const ANIMATION_ROLE: RoleSpec = {
  names: [
    'animation',
    ...ANIMATION_DIRS,
    'animation_original',
    'media',
    'artifact',
    'video',
    // The archiver's open-ended `web <role>` pattern, as seen on RetroDoge:
    // `web glb/154.glb`, `web vrm/154.vrm`.
    'web glb',
    'web vrm',
    'web pet',
    'web model'
  ],
  extensions: ANIMATION_EXTENSIONS,
  insideNames: ['nft', 'animation', 'media', 'video', 'artifact'],
  coverFromCrowd: true
}

/** How many sub-folders to look inside when nothing at the top level matched. */
const MAX_FALLBACK_DIRS = 16

/** How far down one role may be chased. `image/nft.mp4` is two; three is plenty. */
const MAX_RESOLVE_DEPTH = 3

/**
 * Which entry inside a folder is the one we want?
 *
 * Ordered by how much the choice can be trusted:
 *
 *  1. a file named the way the archiver names them (`metadata.json`, `nft.jpg`);
 *  2. a folder named for the role (`web image/` inside a sub-collection);
 *  3. a file named after this token's id — which is what saves the folders whose
 *     `metadata/` holds the collection's entire 10,000-file metadata directory,
 *     as two of the DAO's V1 PUNK folders do;
 *  4. the only entry there is, which cannot be ambiguous;
 *  5. for pictures only, the first plausible one.
 *
 * `strict` drops rule 4. It is used when the folder being searched was *not*
 * named for the role, where "it is the only file in here" is no evidence at all
 * — that rule is what would otherwise call a rescued PNG an animation because it
 * happened to be alone in `arweave image/`.
 */
function chooseInside(
  entries: Entry[],
  spec: RoleSpec,
  tokenId: string | undefined,
  strict = false
): Entry | undefined {
  if (entries.length === 0) return undefined

  for (const wanted of spec.insideNames) {
    const match = entries.find((entry) => baseNameOf(entry.name) === wanted)
    if (match !== undefined) return match
  }

  for (const wanted of spec.names) {
    const match = entries.find((entry) => entry.name.trim().toLowerCase() === wanted.toLowerCase())
    if (match !== undefined) return match
  }

  if (tokenId !== undefined) {
    const wanted = normaliseId(tokenId)
    const match = entries.find((entry) => normaliseId(baseNameOf(entry.name)) === wanted)
    if (match !== undefined) return match
  }

  if (strict) {
    return spec.coverFromCrowd
      ? entries.find((entry) => spec.extensions.has(extensionOf(entry.name)))
      : undefined
  }

  if (entries.length === 1) return entries[0]

  if (spec.coverFromCrowd) {
    return entries.find((entry) => spec.extensions.has(extensionOf(entry.name)))
  }

  return undefined
}

/** `007` and `7` are the same token id; compare them as numbers when we can. */
function normaliseId(text: string): string {
  const trimmed = text.trim()
  try {
    return BigInt(trimmed).toString(10)
  } catch {
    return trimmed.toLowerCase()
  }
}

/**
 * Follow a candidate down to an actual file.
 *
 * A child called `image` may be the picture, or a folder holding the picture, or
 * a folder holding a folder holding the picture. All three exist in the DAO's
 * backups. An entry we cannot read at all is returned as it is: its address is
 * still worth recording, because that is precisely the hole a member needs to
 * see on the tile.
 */
async function resolveToFile(
  candidate: Child,
  spec: RoleSpec,
  tokenId: string | undefined,
  blockstore: Blockstore,
  depth = 0
): Promise<Entry | undefined> {
  if (candidate.kind !== 'directory') {
    return { name: candidate.name, cid: candidate.cid, size: candidate.size }
  }

  if (depth >= MAX_RESOLVE_DEPTH) return undefined

  const chosen = chooseInside(candidate.entries, spec, tokenId)
  if (chosen === undefined) return undefined

  const listing = await readDirectory(chosen.cid, blockstore)
  return resolveToFile(
    { ...chosen, kind: listing.kind, entries: listing.kind === 'directory' ? listing.entries : [] },
    spec,
    tokenId,
    blockstore,
    depth + 1
  )
}

/** Find one role's file among an NFT folder's children. */
async function pickRole(
  children: Child[],
  spec: RoleSpec,
  tokenId: string | undefined,
  blockstore: Blockstore
): Promise<Entry | undefined> {
  // 1. The names the layout uses, in order of how much we trust them.
  for (const wanted of spec.names) {
    const candidate = children.find((child) => child.name.trim().toLowerCase() === wanted.toLowerCase())
    if (candidate === undefined) continue
    const found = await resolveToFile(candidate, spec, tokenId, blockstore)
    if (found !== undefined) return found
  }

  // 2. A loose file whose extension gives it away.
  const loose = children.find(
    (child) =>
      child.kind !== 'directory' &&
      child.name.trim() !== LAYOUT.provenance &&
      spec.extensions.has(extensionOf(child.name))
  )
  if (loose !== undefined) return { name: loose.name, cid: loose.cid, size: loose.size }

  // 3. Nothing named right at this level. Some folders in the real archive hold
  //    a handful of *sub*-collections ("NFD x DOG x Zora" contains five named
  //    NFTs, each with its own `image`), so one more level is worth a look to
  //    put a cover on the tile.
  //
  //    Pictures only, and only on a confident match. A cover borrowed from one
  //    of five nested NFTs is a fair illustration of a folder of five NFTs; a
  //    *name* and *traits* borrowed the same way would put one token's identity
  //    on another token's tile, which is why metadata never does this.
  if (!spec.coverFromCrowd) return undefined

  let looked = 0
  for (const child of children) {
    if (child.kind !== 'directory') continue
    if (looked >= MAX_FALLBACK_DIRS) break
    looked += 1

    const inside = chooseInside(child.entries, spec, tokenId, true)
    if (inside === undefined) continue

    const listing = await readDirectory(inside.cid, blockstore)
    const found = await resolveToFile(
      { ...inside, kind: listing.kind, entries: listing.kind === 'directory' ? listing.entries : [] },
      spec,
      tokenId,
      blockstore,
      1
    )
    if (found !== undefined) return found
  }

  return undefined
}

/* -------------------------------------------------------------------------- */
/* which NFT is this?                                                          */
/* -------------------------------------------------------------------------- */

/** Strip the ` (2)` the archiver appends when two tokens want the same name. */
function withoutDuplicateSuffix(name: string): string {
  return name.replace(/\s*\(\d+\)$/, '').trim()
}

/**
 * The token id hidden in a folder name — `V1 PUNK #1802` → `1802`.
 *
 * Only used to pick the right file out of a folder that holds a whole
 * collection's worth of them, and only when nothing better has said which token
 * this is. Returns nothing unless the name really does end in a number, so a
 * folder called `Coup d’État` never guesses.
 */
function tokenIdFromFolderName(folder: string): string | undefined {
  const hash = /#\s*(\d+)\s*$/.exec(folder.trim())
  if (hash?.[1] !== undefined) return hash[1]

  const trailing = /(?:^|[\s#_-])(\d{1,20})\s*$/.exec(folder.trim())
  return trailing?.[1]
}

function tokenIndex(tokens: ArchivedToken[]): Map<string, ArchivedToken> {
  const index = new Map<string, ArchivedToken>()
  for (const token of tokens) {
    const key = token.folderName.trim().toLowerCase()
    if (key !== '' && !index.has(key)) index.set(key, token)
  }
  return index
}

/**
 * Read the contract and token id out of `_provenance.json`.
 *
 * Worth the extra read: for a backup somebody else built, or one merged from a
 * 2023 hand-made archive, this record is the only place the chain identity
 * survives — the metadata JSON itself almost never contains it.
 */
async function identityFromProvenance(
  children: Child[],
  blockstore: Blockstore
): Promise<{ contract?: string; tokenId?: string }> {
  const file = children.find(
    (entry) => entry.kind !== 'directory' && entry.name.trim() === LAYOUT.provenance
  )
  if (file === undefined) return {}
  if (file.size > MAX_PROVENANCE_BYTES) return {}

  const slice = await readFileSlice(file.cid, blockstore, 0, MAX_PROVENANCE_BYTES, MAX_PROVENANCE_BYTES)
  if (slice === null) return {}

  const json = parseJson(slice.bytes)
  const token = json?.['token']
  if (!isRecord(token)) return {}

  const out: { contract?: string; tokenId?: string } = {}
  const contract = token['contract']
  const tokenId = token['tokenId']
  if (typeof contract === 'string' && contract.trim() !== '') out.contract = contract.trim()
  if (typeof tokenId === 'string' && tokenId.trim() !== '') out.tokenId = tokenId.trim()
  else if (typeof tokenId === 'number' && Number.isFinite(tokenId)) out.tokenId = String(tokenId)

  return out
}

/* -------------------------------------------------------------------------- */
/* building the gallery                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Describe every NFT in the archive, in the order the backup folder lists them.
 *
 * One item per folder directly under the archive root — that is what an NFT is
 * in this layout. Files sitting loose at the root are skipped: they belong to no
 * token and drawing them as one would be a lie.
 *
 * `network` starts `'unchecked'` and `atRisk` starts `false` for every item.
 * Neither is guessed from local information: this module cannot see the network,
 * and pretending otherwise is exactly the complacency that cost the DAO 428
 * CIDs. Feed real verdicts in with {@link mergeGalleryHealth}.
 *
 * A folder that cannot be read at all still produces an item, named after the
 * folder, with no CIDs and whatever size the parent link recorded. Members need
 * to see the holes.
 *
 * @throws A plain-English `Error` when the archive has not been assembled into a
 * backup folder yet, when its recorded root address is unusable, or when the
 * root itself is not on this computer.
 * @throws An `Error` with `name === 'AbortError'` if `signal` is aborted.
 */
export async function buildGallery(store: ArchiveStore, signal?: AbortSignal): Promise<GalleryItem[]> {
  throwIfCancelled(signal)

  const rootText = store.manifest.rootCid?.trim() ?? ''
  if (rootText === '') {
    throw plain(
      'This archive has not been put together into a backup folder yet, so there is nothing to show. ' +
        'Build the backup first — that is the step that gives the whole archive a single address.'
    )
  }

  let root: CID
  try {
    root = CID.parse(rootText)
  } catch (err) {
    throw plain(
      `This archive records its backup folder as "${rootText}", which is not an address this app can ` +
        'read. Build the backup folder again to give it a fresh address.',
      err
    )
  }

  const blockstore = store.blockstore
  const opened = await readDirectory(root, blockstore)

  if (opened.kind !== 'directory') {
    throw plain(
      'The backup folder for this archive could not be opened from this computer. Its contents may not ' +
        'have been downloaded yet, or the archive folder may have been moved. Build the backup folder ' +
        'again, or import the .car file that holds it.'
    )
  }

  const listing = await unwrapNamedRoot(opened, blockstore)

  if (listing.entries.length > MAX_ITEMS) {
    throw plain(
      `This backup folder contains more than ${MAX_ITEMS.toLocaleString('en-GB')} items, which is far ` +
        'more than a collection of NFTs should. Loading it was stopped so the app does not run out of ' +
        'memory. Check that the right archive folder was opened.'
    )
  }

  const knownTokens = tokenIndex(store.listTokens())
  const items: GalleryItem[] = []

  for (const entry of listing.entries) {
    throwIfCancelled(signal)

    const folder = entry.name.trim() === '' ? entry.cid.toString() : entry.name
    const contents = await readDirectory(entry.cid, blockstore)

    if (contents.kind !== 'directory') {
      // Loose files at the archive root are not NFTs; a folder we cannot read is
      // still one, and must be shown.
      if (contents.kind === 'unreadable') {
        items.push(unreadableItem(folder, entry.size))
      }
      continue
    }

    items.push(await buildItem(folder, entry, contents.entries, blockstore, knownTokens, signal))
  }

  return items
}

/** Names that mean "this folder is one NFT", not "this folder holds NFTs". */
const ROLE_NAMES: ReadonlySet<string> = new Set([
  'metadata',
  'image',
  'animation',
  'images',
  'thumbnail',
  'preview',
  'media',
  LAYOUT.provenance.toLowerCase(),
  ...METADATA_DIRS,
  ...IMAGE_DIRS,
  ...ANIMATION_DIRS
])

/**
 * Step through a single wrapping folder, when there is one.
 *
 * The DAO's published backup is a directory containing one entry called
 * "BIC Backup May-2026", and the NFT folders are inside *that*. An archive this
 * app assembles has no such wrapper. Both have to look right in the gallery, so
 * a lone folder is stepped through — but only when what is inside it looks like
 * a list of NFTs rather than the insides of one, which is what the role-name
 * check decides. An archive holding a single NFT called "Ape #1" therefore stays
 * exactly as it is, because `Ape #1` contains `image` and `metadata`.
 */
async function unwrapNamedRoot(
  listing: Extract<DirRead, { kind: 'directory' }>,
  blockstore: Blockstore
): Promise<Extract<DirRead, { kind: 'directory' }>> {
  const only = listing.entries.length === 1 ? listing.entries[0] : undefined
  if (only === undefined) return listing

  const inner = await readDirectory(only.cid, blockstore)
  if (inner.kind !== 'directory' || inner.entries.length < 2) return listing

  for (const entry of inner.entries) {
    if (ROLE_NAMES.has(entry.name.trim().toLowerCase())) return listing
  }

  return inner
}

/** An NFT folder whose blocks are not on this computer. */
function unreadableItem(folder: string, size: number): GalleryItem {
  return {
    folder,
    name: folder,
    attributes: [],
    sizeBytes: Number.isFinite(size) && size > 0 ? Math.round(size) : 0,
    network: 'unchecked',
    atRisk: false
  }
}

async function buildItem(
  folder: string,
  entry: Entry,
  children: Entry[],
  blockstore: Blockstore,
  knownTokens: Map<string, ArchivedToken>,
  signal?: AbortSignal
): Promise<GalleryItem> {
  const contents = await readChildren(children, blockstore, signal)

  const item: GalleryItem = {
    folder,
    name: folder,
    attributes: [],
    sizeBytes: 0,
    network: 'unchecked',
    atRisk: false
  }

  // --- size ---------------------------------------------------------------
  try {
    item.sizeBytes = Math.round(await cumulativeSize(entry.cid, blockstore))
  } catch {
    // The parent link already records the size of this whole sub-DAG.
    item.sizeBytes = Number.isFinite(entry.size) && entry.size > 0 ? Math.round(entry.size) : 0
  }

  // --- which token is this? -----------------------------------------------
  // Settled first: knowing the token id is what lets the right file be picked
  // out of a folder holding a whole collection's metadata.
  const token =
    knownTokens.get(folder.trim().toLowerCase()) ??
    knownTokens.get(withoutDuplicateSuffix(folder).toLowerCase())

  if (token !== undefined) {
    item.contract = token.ref.contract
    item.tokenId = token.ref.tokenId
  } else {
    const identity = await identityFromProvenance(contents, blockstore)
    if (identity.contract !== undefined) item.contract = identity.contract
    if (identity.tokenId !== undefined) item.tokenId = identity.tokenId
  }

  const tokenId = item.tokenId ?? tokenIdFromFolderName(folder)

  // --- the pieces ---------------------------------------------------------
  throwIfCancelled(signal)
  const metadataFile = await pickRole(contents, METADATA_ROLE, tokenId, blockstore)
  const imageFile = await pickRole(contents, IMAGE_ROLE, tokenId, blockstore)
  const animationFile = await pickRole(contents, ANIMATION_ROLE, tokenId, blockstore)

  if (metadataFile !== undefined) item.metadataCid = metadataFile.cid.toString()
  if (imageFile !== undefined) item.imageCid = imageFile.cid.toString()
  if (animationFile !== undefined) item.animationCid = animationFile.cid.toString()

  // --- what the metadata says --------------------------------------------
  if (metadataFile !== undefined) {
    throwIfCancelled(signal)

    const slice = await readFileSlice(
      metadataFile.cid,
      blockstore,
      0,
      MAX_METADATA_BYTES,
      MAX_METADATA_BYTES
    )
    const metadata = slice === null ? undefined : parseJson(slice.bytes)

    if (metadata !== undefined) {
      const name = readString(metadata, ['name', 'title'])
      if (name !== undefined) item.name = clip(name, MAX_TRAIT_TEXT)

      const description = readString(metadata, ['description'])
      if (description !== undefined) item.description = clip(description, MAX_DESCRIPTION)

      item.attributes = normaliseAttributes(metadata)

      // Fully on-chain tokens carry megabytes of base64 in here; the fields the
      // detail panel needs have already been taken out above.
      if (slice !== null && slice.bytes.byteLength <= MAX_INLINE_METADATA_BYTES) {
        item.metadata = metadata
      }
    }
  }

  // --- what can the GUI do with the image? --------------------------------
  if (imageFile !== undefined) {
    throwIfCancelled(signal)

    const head = await readFileSlice(imageFile.cid, blockstore, 0, SNIFF_BYTES, SNIFF_BYTES)
    item.imageContentType =
      head === null ? 'application/octet-stream' : contentTypeFor(head.bytes, imageFile.name)
  }

  return item
}

/* -------------------------------------------------------------------------- */
/* merging in what a health run learned                                        */
/* -------------------------------------------------------------------------- */

/** Worst-first, so an NFT with one dead file is not reported as healthy. */
const NETWORK_SEVERITY: Readonly<Record<GalleryItem['network'], number>> = {
  healthy: 0,
  unchecked: 1,
  'at-risk': 2,
  unreachable: 3
}

/**
 * Apply health verdicts to the NFTs they belong to.
 *
 * An NFT is only as safe as its least safe piece, so the **worst** verdict
 * across its own metadata, image and animation wins: a token whose picture is
 * gone is not "healthy" because its JSON survives.
 *
 * `atRisk` is set when the run found *nobody* announcing one of this NFT's
 * files — `providers === 0`, which is also what makes a verdict 'at-risk' or
 * 'unreachable'. That is the honest reading of "nothing is keeping this": the
 * content may still be served by a gateway's cache today and be gone next month.
 * Note it says nothing about pins on this machine that the wider network cannot
 * see — a node behind a home router that nothing can dial announces nothing.
 *
 * NFTs no result matched keep whatever they had. A missing result is not
 * evidence of anything, and quietly marking one 'unreachable' would send a
 * member chasing files that are perfectly fine.
 *
 * CIDs are matched in every spelling, so a run over `Qm…` marks an item the
 * archive recorded as `bafybei…`. Returns new items; the input is not modified.
 */
export function mergeGalleryHealth(items: GalleryItem[], health: HealthResult[]): GalleryItem[] {
  const verdicts = new Map<string, GalleryItem['network']>()
  const unprovided = new Set<string>()

  for (const result of health) {
    if (result === null || result === undefined) continue

    const verdict = result.verdict
    if (verdict !== 'healthy' && verdict !== 'at-risk' && verdict !== 'unreachable') continue

    for (const spelling of cidSpellings(result.cid)) {
      const existing = verdicts.get(spelling)
      if (existing === undefined || NETWORK_SEVERITY[verdict] > NETWORK_SEVERITY[existing]) {
        verdicts.set(spelling, verdict)
      }
      if (!(result.providers > 0)) unprovided.add(spelling)
    }
  }

  return items.map((item) => {
    const clone: GalleryItem = { ...item, attributes: [...item.attributes] }
    if (verdicts.size === 0) return clone

    let worst: GalleryItem['network'] | undefined
    let nobodyHasIt = false

    for (const cid of ownCids(item)) {
      for (const spelling of cidSpellings(cid)) {
        const verdict = verdicts.get(spelling)
        if (verdict !== undefined && (worst === undefined || NETWORK_SEVERITY[verdict] > NETWORK_SEVERITY[worst])) {
          worst = verdict
        }
        if (unprovided.has(spelling)) nobodyHasIt = true
      }
    }

    if (worst !== undefined) {
      clone.network = worst
      clone.atRisk = nobodyHasIt
    }

    return clone
  })
}

/** The CIDs this NFT is responsible for, ignoring the ones it does not have. */
function ownCids(item: GalleryItem): string[] {
  const out: string[] = []
  for (const cid of [item.metadataCid, item.imageCid, item.animationCid]) {
    if (typeof cid === 'string' && cid.trim() !== '') out.push(cid.trim())
  }
  return out
}

/* -------------------------------------------------------------------------- */
/* the numbers                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Five numbers for the top of the gallery.
 *
 * `bytes` adds up the folders, which do not overlap — each NFT's size is the
 * whole sub-DAG beneath it — so the total is the weight of the collection as a
 * member would think of it.
 */
export function summariseGallery(items: GalleryItem[]): GallerySummary {
  let bytes = 0
  let withImage = 0
  let unreachable = 0
  let atRisk = 0

  for (const item of items) {
    if (Number.isFinite(item.sizeBytes) && item.sizeBytes > 0) bytes += item.sizeBytes
    if (typeof item.imageCid === 'string' && item.imageCid !== '') withImage += 1
    if (item.network === 'unreachable') unreachable += 1
    if (item.atRisk) atRisk += 1
  }

  return { items: items.length, bytes, withImage, unreachable, atRisk }
}

/* -------------------------------------------------------------------------- */
/* serving one file to the window                                              */
/* -------------------------------------------------------------------------- */

/** What {@link readMediaBytes} hands back. */
export interface MediaBytes {
  /**
   * The bytes read. This may be a *slice*: compare its length with
   * `totalBytes` before assuming it is the whole file.
   */
  bytes: Uint8Array
  /** Decided from the bytes themselves; `application/octet-stream` when unknown. */
  contentType: string
  /** Size of the complete file in the archive. */
  totalBytes: number
}

/** How much of a file {@link readMediaBytes} should read. */
export interface ReadMediaOptions {
  /**
   * Hard ceiling on how many bytes come back in one call. Defaults to 64 MB, so
   * a feature-length video cannot be pulled into memory by accident.
   */
  maxBytes?: number
  /** Where to start reading, for Range requests. Defaults to the beginning. */
  offset?: number
  /**
   * How many bytes to read from `offset`. Defaults to the rest of the file,
   * still capped by `maxBytes`. `0` is a cheap way to ask only what a file is
   * and how big it is.
   */
  length?: number
}

/**
 * Read one file out of the archive's blockstore, for the `bic-media://` scheme.
 *
 * The renderer has no filesystem and no Node: this is the only path by which an
 * archived image reaches the window. It answers `null` — and never throws — when
 * the CID cannot be read: unparseable, a folder, not on this computer, or
 * corrupt. Every one of those is a broken thumbnail, not a crash.
 *
 * Reading is bounded twice over: by `maxBytes` (64 MB by default) and by the
 * slice actually asked for, and a slice reads only the blocks it needs, so
 * seeking inside a large video costs a few blocks rather than the whole file.
 */
export async function readMediaBytes(
  store: ArchiveStore,
  cid: string | CID,
  opts?: ReadMediaOptions
): Promise<MediaBytes | null> {
  const parsed = toCid(cid)
  if (parsed === null) return null

  const blockstore = store.blockstore
  const cap = opts?.maxBytes !== undefined && opts.maxBytes >= 0 ? opts.maxBytes : DEFAULT_MEDIA_LIMIT

  const slice = await readFileSlice(parsed, blockstore, opts?.offset ?? 0, opts?.length, cap)
  if (slice === null) return null

  // The magic numbers live at the start of the file, which a slice from further
  // in does not contain — so ask for the head separately when we have to.
  let head = slice.bytes
  if ((opts?.offset ?? 0) > 0 || head.byteLength === 0) {
    const start = await readFileSlice(parsed, blockstore, 0, SNIFF_BYTES, SNIFF_BYTES)
    if (start !== null) head = start.bytes
  }

  return {
    bytes: slice.bytes,
    contentType: sniffContentType(head.subarray(0, SNIFF_BYTES)) ?? 'application/octet-stream',
    totalBytes: slice.totalBytes
  }
}

/** Parse a CID, whichever form the caller had. `null` when it is not one. */
function toCid(value: string | CID): CID | null {
  if (typeof value !== 'string') {
    return value instanceof CID ? value : null
  }
  const text = value.trim()
  if (text === '') return null
  try {
    return CID.parse(text)
  } catch {
    return null
  }
}
