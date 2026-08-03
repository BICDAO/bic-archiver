/**
 * User input parsing.
 *
 * DAO members paste whatever they happen to have on the clipboard: an OpenSea
 * link, an Etherscan link, a bare contract address, a contract plus a range of
 * token numbers, or several of those mixed together on one line. This module
 * turns all of that into `TokenInputSpec[]`, and turns metadata blobs into the
 * list of media we need to archive.
 *
 * Everything thrown from here is shown directly to a non-technical member, so
 * every message is plain English and quotes the line that caused the problem.
 */

import { Buffer } from 'node:buffer'
import type { TokenInputSpec } from '../../shared/types.js'

/**
 * Chain slugs as they appear in marketplace URLs, mapped to EVM chain IDs.
 * OpenSea writes Polygon as "matic"; both spellings are accepted.
 */
export const CHAIN_IDS: Record<string, number> = {
  ethereum: 1,
  eth: 1,
  matic: 137,
  polygon: 137,
  base: 8453,
  arbitrum: 42161,
  optimism: 10,
  klaytn: 8217,
  avalanche: 43114
}

/** Extra spellings seen in the wild. Kept out of CHAIN_IDS, which is a contract. */
const CHAIN_ALIASES: Record<string, number> = {
  mainnet: 1,
  'eth-mainnet': 1,
  'ethereum-mainnet': 1,
  'polygon-pos': 137,
  'matic-mainnet': 137,
  op: 10,
  'op-mainnet': 10,
  arb: 42161,
  'arbitrum-one': 42161,
  arbitrum_one: 42161,
  avax: 43114,
  'avalanche-c': 43114
}

/** Block explorer hostnames we can read a chain ID from. */
const EXPLORER_CHAIN_IDS: Record<string, number> = {
  'etherscan.io': 1,
  'optimistic.etherscan.io': 10,
  'polygonscan.com': 137,
  'basescan.org': 8453,
  'arbiscan.io': 42161,
  'snowtrace.io': 43114,
  'snowscan.xyz': 43114,
  'klaytnfinder.io': 8217,
  'kaiascan.io': 8217
}

/** A single range may not expand to more than this many token IDs. */
const MAX_RANGE_SIZE = 10_000

/** Largest possible ERC-721/1155 token ID. */
const MAX_UINT256 = 2n ** 256n - 1n

/** How many entries we will walk in any one metadata array. */
const MAX_ARRAY_SCAN = 512

/** Folder names are capped at this many characters... */
const MAX_FOLDER_NAME_CHARS = 120
/** ...and at this many UTF-8 bytes, so they fit real filesystem limits. */
const MAX_FOLDER_NAME_BYTES = 200

/** Last-resort folder name. `sanitizeFolderName` never returns '', '.' or '..'. */
const HARD_FALLBACK_FOLDER_NAME = 'untitled'

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/
const DECIMAL_RE = /^\d+$/
const RANGE_RE = /^(\d+)-(\d+)$/
const ENS_RE = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.eth$/i
const HAS_SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i
const HOSTISH_RE = /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}\//i

const WINDOWS_RESERVED_NAMES = new Set<string>([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  'COM1',
  'COM2',
  'COM3',
  'COM4',
  'COM5',
  'COM6',
  'COM7',
  'COM8',
  'COM9',
  'LPT1',
  'LPT2',
  'LPT3',
  'LPT4',
  'LPT5',
  'LPT6',
  'LPT7',
  'LPT8',
  'LPT9'
])

/* -------------------------------------------------------------------------- */
/* parseTokenInput                                                            */
/* -------------------------------------------------------------------------- */

/** A contract we are currently attaching loose token numbers to. */
interface Anchor {
  chainId: number
  contract: string
}

type Classified =
  | { kind: 'anchor'; chainId: number; contract: string; ids: string[] }
  | { kind: 'ids'; ids: string[] }

interface Bucket {
  chainId: number
  contract: string
  ids: string[]
  seen: Set<string>
}

/**
 * Parse anything a member pastes into a de-duplicated list of contracts and
 * token IDs.
 *
 * Accepted, in any mix, one per line or separated by commas/whitespace:
 *   https://opensea.io/assets/ethereum/0xCONTRACT/123
 *   https://opensea.io/assets/matic/0xCONTRACT/123
 *   https://opensea.io/assets/0xCONTRACT/123          (older form, Ethereum)
 *   https://etherscan.io/token/0xCONTRACT?a=123
 *   0xCONTRACT 123   /   0xCONTRACT:123   /   0xCONTRACT/123
 *   0xCONTRACT 1-50  /   0xCONTRACT 1,2,7-9
 *   0xCONTRACT       (no token numbers — the whole collection)
 *
 * Specs sharing a chain and contract are merged, token IDs are de-duplicated,
 * and both contracts and token IDs keep the order they were first seen in.
 * Token IDs are always decimal strings (leading zeros are normalised away).
 *
 * @throws Error, in plain English, quoting the offending line.
 */
export function parseTokenInput(text: string): TokenInputSpec[] {
  const normalized = normalizeInput(text)
  if (normalized.trim() === '') {
    throw new Error(
      'There is nothing to archive yet. Paste a contract address, an OpenSea link or an Etherscan link.'
    )
  }

  const order: string[] = []
  const buckets = new Map<string, Bucket>()
  let anchor: Anchor | undefined

  const bucketFor = (chainId: number, contract: string): Bucket => {
    const key = `${chainId}:${contract}`
    let bucket = buckets.get(key)
    if (!bucket) {
      bucket = { chainId, contract, ids: [], seen: new Set<string>() }
      buckets.set(key, bucket)
      order.push(key)
    }
    return bucket
  }

  const addIds = (bucket: Bucket, ids: readonly string[]): void => {
    for (const id of ids) {
      if (bucket.seen.has(id)) continue
      bucket.seen.add(id)
      bucket.ids.push(id)
    }
  }

  for (const rawLine of normalized.split('\n')) {
    const line = rawLine.trim()
    if (line === '') continue
    // "# a comment" is skipped, but "#123" is a token number.
    if (/^#(?!\d)/.test(line) || line.startsWith('//')) continue

    for (const rawPiece of line.split(/[\s,;|]+/)) {
      const piece = stripWrappers(rawPiece)
      if (piece === '') continue

      const classified = classifyPiece(piece, line)
      if (classified.kind === 'anchor') {
        anchor = { chainId: classified.chainId, contract: classified.contract }
        addIds(bucketFor(classified.chainId, classified.contract), classified.ids)
      } else {
        if (classified.ids.length === 0) continue
        if (!anchor) {
          throw new Error(
            `I found the token number "${piece}" before any contract address. ` +
              `Put the 0x… contract address first, like "0x1234…abcd ${piece}". ` +
              `Offending line: "${line}"`
          )
        }
        addIds(bucketFor(anchor.chainId, anchor.contract), classified.ids)
      }
    }
  }

  if (order.length === 0) {
    throw new Error(
      'I could not find a contract address in what you pasted. ' +
        'A contract address is 0x followed by 40 letters and numbers.'
    )
  }

  const specs: TokenInputSpec[] = []
  for (const key of order) {
    const bucket = buckets.get(key)
    if (!bucket) continue
    specs.push({ chainId: bucket.chainId, contract: bucket.contract, tokenIds: bucket.ids })
  }
  return specs
}

/**
 * Line endings to '\n', unicode dashes between digits to a plain '-', and
 * "1 - 50" tightened to "1-50" so ranges survive whitespace splitting.
 */
function normalizeInput(text: string): string {
  if (typeof text !== 'string') return ''
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[\u200B-\u200F\uFEFF]/g, '')
    .replace(/(\d)[ \t]*[-\u2010-\u2015\u2212][ \t]*(\d)/g, '$1-$2')
}

/** Remove quotes, brackets and trailing sentence punctuation around a piece. */
function stripWrappers(piece: string): string {
  let value = piece.trim()
  // Repeat, so "<https://…/1>." loses both the '.' and the '>'.
  for (let i = 0; i < 4; i++) {
    const before = value
    value = value
      .replace(/^[("'`[{<«]+/, '')
      .replace(/[)"'`\]}>»]+$/, '')
      .replace(/[.,;!]+$/, '')
      .trim()
    if (value === before) break
  }
  return value
}

function classifyPiece(piece: string, line: string): Classified {
  if (HAS_SCHEME_RE.test(piece) || HOSTISH_RE.test(piece)) {
    return classifyUrl(piece, line)
  }

  const parts = piece.split(/[:/#]+/).filter((p) => p !== '')
  const addrIdx = parts.findIndex((p) => ADDRESS_RE.test(p))

  if (addrIdx >= 0) {
    const contract = (parts[addrIdx] as string).toLowerCase()
    let chainId = 1
    const prefix = addrIdx > 0 ? parts[addrIdx - 1] : undefined
    if (prefix !== undefined) {
      const resolved = chainIdForSlug(prefix)
      if (resolved === undefined) {
        throw new Error(
          `I do not recognise the network "${prefix}". ` +
            `I can archive from: ${supportedNetworkList()}. Offending line: "${line}"`
        )
      }
      chainId = resolved
    }
    const ids: string[] = []
    for (const part of parts.slice(addrIdx + 1)) ids.push(...expandIds(part, line))
    return { kind: 'anchor', chainId, contract, ids }
  }

  if (parts.every((p) => DECIMAL_RE.test(p) || RANGE_RE.test(p))) {
    const ids: string[] = []
    for (const part of parts) ids.push(...expandIds(part, line))
    return { kind: 'ids', ids }
  }

  if (/^0x/i.test(piece)) {
    throw new Error(
      `"${piece}" is not a valid contract address. A contract address is 0x followed by ` +
        `exactly 40 letters and numbers (42 characters in total); this one has ` +
        `${String(piece.replace(/^0x/i, '').length)}. Offending line: "${line}"`
    )
  }
  if (ENS_RE.test(piece)) {
    throw new Error(
      `"${piece}" is an ENS name, not a contract address. Paste the 0x… contract address ` +
        `instead — you can find it on the collection's Etherscan or OpenSea page. ` +
        `Offending line: "${line}"`
    )
  }
  throw new Error(
    `I could not make sense of "${piece}". I understand contract addresses (0x… ), ` +
      `token numbers (7, or a range like 1-50), OpenSea links and Etherscan links. ` +
      `Offending line: "${line}"`
  )
}

function classifyUrl(piece: string, line: string): Classified {
  let url: URL
  try {
    url = new URL(HAS_SCHEME_RE.test(piece) ? piece : `https://${piece}`)
  } catch {
    throw new Error(`"${piece}" is not a link I can read. Offending line: "${line}"`)
  }

  const host = url.hostname.toLowerCase().replace(/^www\./, '')
  const segments = url.pathname
    .split('/')
    .map(safeDecode)
    .filter((s) => s !== '')

  if (host === 'opensea.io' || host.endsWith('.opensea.io')) {
    return classifyOpenSea(segments, piece, line)
  }

  // Everything else: find the address in the path (also splitting Rarible-style
  // "0xCONTRACT:123" segments), then look for a token number after it.
  const flat = segments.flatMap((s) => s.split(':')).filter((s) => s !== '')
  const addrIdx = flat.findIndex((s) => ADDRESS_RE.test(s))
  if (addrIdx === -1) {
    throw new Error(
      `I could not find a contract address in the link "${piece}". Open the page for a ` +
        `single NFT and copy that link, or paste the 0x… contract address directly. ` +
        `Offending line: "${line}"`
    )
  }

  const contract = (flat[addrIdx] as string).toLowerCase()
  let chainId = EXPLORER_CHAIN_IDS[host]
  if (chainId === undefined && host.endsWith('etherscan.io')) chainId = 1
  if (chainId === undefined && addrIdx > 0) chainId = chainIdForSlug(flat[addrIdx - 1] as string)
  if (chainId === undefined) chainId = 1

  const ids: string[] = []
  for (const segment of flat.slice(addrIdx + 1)) {
    if (DECIMAL_RE.test(segment)) {
      ids.push(normalizeTokenId(segment, line))
      break
    }
  }
  if (ids.length === 0) {
    const fromQuery = tokenIdFromQuery(url, line)
    if (fromQuery !== undefined) ids.push(fromQuery)
  }

  return { kind: 'anchor', chainId, contract, ids }
}

function classifyOpenSea(segments: string[], piece: string, line: string): Classified {
  const idx = segments.findIndex((s) => s === 'assets' || s === 'item' || s === 'items')
  if (idx === -1) {
    throw new Error(
      `"${piece}" does not point at a single NFT. OpenSea item links look like ` +
        `https://opensea.io/assets/ethereum/0x1234…abcd/7 — open one item in the ` +
        `collection and copy the link from your browser. Offending line: "${line}"`
    )
  }

  const first = segments[idx + 1]
  if (first === undefined) {
    throw new Error(
      `The OpenSea link "${piece}" is missing the contract address. ` +
        `Offending line: "${line}"`
    )
  }

  // Older form: /assets/0xCONTRACT/TOKENID (Ethereum implied).
  if (ADDRESS_RE.test(first)) {
    const ids: string[] = []
    const tokenId = segments[idx + 2]
    if (tokenId !== undefined && DECIMAL_RE.test(tokenId)) ids.push(normalizeTokenId(tokenId, line))
    return { kind: 'anchor', chainId: 1, contract: first.toLowerCase(), ids }
  }

  const chainId = chainIdForSlug(first)
  if (chainId === undefined) {
    throw new Error(
      `That OpenSea link is for the "${first}" network, which BIC Archiver cannot read yet. ` +
        `Supported networks: ${supportedNetworkList()}. Offending line: "${line}"`
    )
  }

  const contract = segments[idx + 2]
  if (contract === undefined || !ADDRESS_RE.test(contract)) {
    throw new Error(
      `The OpenSea link "${piece}" does not contain a valid contract address. ` +
        `Offending line: "${line}"`
    )
  }

  const ids: string[] = []
  const tokenId = segments[idx + 3]
  if (tokenId !== undefined && DECIMAL_RE.test(tokenId)) ids.push(normalizeTokenId(tokenId, line))
  return { kind: 'anchor', chainId, contract: contract.toLowerCase(), ids }
}

/** Etherscan writes the token ID as ?a=123. Other sites use tokenId / id. */
function tokenIdFromQuery(url: URL, line: string): string | undefined {
  for (const key of ['a', 'tokenId', 'token_id', 'tokenid', 'id']) {
    const value = url.searchParams.get(key)?.trim()
    if (!value) continue
    // ?a= is also used for a holder address filter — that is not a token ID.
    if (ADDRESS_RE.test(value)) continue
    if (DECIMAL_RE.test(value)) return normalizeTokenId(value, line)
    if (/^0x[0-9a-fA-F]{1,64}$/.test(value)) return BigInt(value).toString()
  }
  return undefined
}

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

function chainIdForSlug(slug: string): number | undefined {
  const key = slug.trim().toLowerCase()
  return CHAIN_IDS[key] ?? CHAIN_ALIASES[key]
}

function supportedNetworkList(): string {
  return 'Ethereum, Polygon, Base, Arbitrum, Optimism, Klaytn and Avalanche'
}

/** Expand one token-ID token: "7" or "1-50". */
function expandIds(part: string, line: string): string[] {
  const range = RANGE_RE.exec(part)
  if (range) {
    const rawStart = range[1]
    const rawEnd = range[2]
    if (rawStart === undefined || rawEnd === undefined) {
      throw new Error(`I could not read the range "${part}". Offending line: "${line}"`)
    }
    let start = toTokenBigInt(rawStart, line)
    let end = toTokenBigInt(rawEnd, line)
    if (start > end) {
      const swap = start
      start = end
      end = swap
    }
    const count = end - start + 1n
    if (count > BigInt(MAX_RANGE_SIZE)) {
      const firstChunkEnd = start + BigInt(MAX_RANGE_SIZE) - 1n
      throw new Error(
        `The range "${part}" covers ${count.toLocaleString('en-US')} token numbers, and ` +
          `I can only handle ${MAX_RANGE_SIZE.toLocaleString('en-US')} at a time. Please split ` +
          `it into smaller ranges — for example "${start.toString()}-${firstChunkEnd.toString()}" ` +
          `first, then carry on from "${(firstChunkEnd + 1n).toString()}". Offending line: "${line}"`
      )
    }
    const ids: string[] = []
    for (let i = start; i <= end; i++) ids.push(i.toString())
    return ids
  }

  if (DECIMAL_RE.test(part)) return [normalizeTokenId(part, line)]

  throw new Error(
    `I could not read "${part}" as a token number. Token numbers look like 7, ` +
      `or a range like 1-50. Offending line: "${line}"`
  )
}

function toTokenBigInt(decimal: string, line: string): bigint {
  const value = BigInt(decimal)
  if (value > MAX_UINT256) {
    throw new Error(
      `The token number "${decimal}" is too large to be a real token ID. ` +
        `Offending line: "${line}"`
    )
  }
  return value
}

/** Token IDs stay decimal strings, with leading zeros removed so they de-dupe. */
function normalizeTokenId(decimal: string, line: string): string {
  return toTokenBigInt(decimal, line).toString()
}

/* -------------------------------------------------------------------------- */
/* sanitizeFolderName                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Turn a token `name` into a folder name that is safe on macOS, Windows and
 * Linux, and valid as a UnixFS directory entry.
 *
 * Removes control characters, replaces `/ \ : * ? " < > |` with '-', collapses
 * whitespace, trims dots and spaces from both ends, side-steps the Windows
 * reserved device names, and caps the result at 120 characters (and 200 UTF-8
 * bytes, so multi-byte names still fit a 255-byte filesystem limit).
 *
 * Deterministic, and never returns '', '.' or '..' — it falls back to
 * `fallback`, and then to 'untitled', when nothing usable is left.
 */
export function sanitizeFolderName(name: string, fallback = HARD_FALLBACK_FOLDER_NAME): string {
  const cleaned = cleanFolderName(name)
  if (cleaned !== '') return cleaned
  const cleanedFallback = cleanFolderName(fallback)
  if (cleanedFallback !== '') return cleanedFallback
  return HARD_FALLBACK_FOLDER_NAME
}

function cleanFolderName(input: string): string {
  if (typeof input !== 'string' || input === '') return ''

  let value = input.normalize('NFC')
  // Zero-width and line/paragraph separators: drop entirely.
  value = value.replace(/[\u200B-\u200F\u2028\u2029\uFEFF]/g, '')
  // Control characters (C0 + DEL + C1): treated as whitespace.
  value = value.replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ')
  // Characters that are illegal in a path segment on at least one OS.
  value = value.replace(/[/\\:*?"<>|]/g, '-')
  value = value.replace(/\s+/g, ' ')
  value = trimDotsAndSpaces(value)
  value = capFolderName(value)
  value = trimDotsAndSpaces(value)
  if (value === '' || value === '.' || value === '..') return ''

  const base = (value.split('.')[0] ?? '').toUpperCase()
  if (WINDOWS_RESERVED_NAMES.has(base)) {
    value = trimDotsAndSpaces(capFolderName(`_${value}`))
    if (value === '' || value === '.' || value === '..') return ''
  }

  return value
}

function trimDotsAndSpaces(value: string): string {
  return value.replace(/^[.\s]+/, '').replace(/[.\s]+$/, '')
}

function capFolderName(value: string): string {
  let points = Array.from(value)
  if (points.length > MAX_FOLDER_NAME_CHARS) points = points.slice(0, MAX_FOLDER_NAME_CHARS)
  let out = points.join('')
  while (points.length > 0 && Buffer.byteLength(out, 'utf8') > MAX_FOLDER_NAME_BYTES) {
    points.pop()
    out = points.join('')
  }
  return out
}

/* -------------------------------------------------------------------------- */
/* extractAssetUrls                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Metadata fields we archive, in the order we report them, mapped to the stable
 * role name that becomes a folder/file name inside the archive.
 */
const ASSET_FIELDS: ReadonlyArray<readonly [field: string, role: string]> = [
  ['image', 'image'],
  ['image_url', 'image'],
  ['imageUrl', 'image'],
  ['image_data', 'image'],
  ['imageData', 'image'],
  ['image_original_url', 'image_original'],
  ['animation_url', 'animation'],
  ['animationUrl', 'animation'],
  ['animation', 'animation'],
  ['animation_original_url', 'animation_original'],
  ['media', 'media'],
  ['artifactUri', 'artifact'],
  ['artifact_uri', 'artifact'],
  ['displayUri', 'display'],
  ['display_uri', 'display'],
  ['thumbnailUri', 'thumbnail'],
  ['thumbnail_uri', 'thumbnail'],
  ['losslessAudio', 'audio'],
  ['lossless_audio', 'audio']
]

/** Fields whose value is inline markup rather than a link. */
const INLINE_FIELDS = new Set<string>(['image_data', 'imageData'])

/**
 * Keys that hold a URL when a metadata field is an object rather than a string.
 * Ordered so that the original reference (`ipfs://…`) wins over a gateway
 * mirror of the same bytes — the original is what preserves the CID.
 */
const OBJECT_URL_KEYS = [
  'uri',
  'url',
  'src',
  'href',
  'raw',
  'originalUrl',
  'gateway',
  'cachedUrl',
  'image'
] as const

/**
 * Pull every archivable media reference out of a metadata object.
 *
 * Covers ERC-721/1155 (`image`, `image_url`, `image_data`, `animation_url`,
 * `animation`, `media`), Tezos-style (`artifactUri`, `displayUri`,
 * `thumbnailUri`), `losslessAudio`, and `properties.files[]` / `files[]`
 * entries — whether those are plain strings or `{ uri | url | src, … }`
 * objects, or arrays of either.
 *
 * `image_data` (inline SVG) is returned with role 'image' and a `data:` URL.
 * Results are de-duplicated by URL; when two different URLs claim the same role
 * the later ones become 'image_2', 'image_3' and so on, so roles are always
 * unique and safe to use as file names.
 */
export function extractAssetUrls(
  metadata: Record<string, unknown>
): Array<{ role: string; url: string }> {
  if (!isRecord(metadata)) return []

  const candidates: Array<{ role: string; url: string }> = []

  for (const [field, role] of ASSET_FIELDS) {
    const value = metadata[field]
    if (value === undefined || value === null) continue
    if (INLINE_FIELDS.has(field)) {
      for (const inline of collectStrings(value, 0)) {
        const dataUrl = toDataUrl(inline)
        if (dataUrl !== '') candidates.push({ role, url: dataUrl })
      }
      continue
    }
    for (const url of collectUrls(value, 0)) candidates.push({ role, url })
  }

  const properties = metadata['properties']
  if (isRecord(properties)) {
    for (const url of collectFileUrls(properties['files'])) candidates.push({ role: 'file', url })
  }
  for (const url of collectFileUrls(metadata['files'])) candidates.push({ role: 'file', url })

  const seenUrls = new Set<string>()
  const usedRoles = new Set<string>()
  const results: Array<{ role: string; url: string }> = []
  for (const candidate of candidates) {
    if (seenUrls.has(candidate.url)) continue
    seenUrls.add(candidate.url)
    let role = candidate.role
    let suffix = 2
    while (usedRoles.has(role)) {
      role = `${candidate.role}_${String(suffix)}`
      suffix += 1
    }
    usedRoles.add(role)
    results.push({ role, url: candidate.url })
  }
  return results
}

function collectUrls(value: unknown, depth: number): string[] {
  if (depth > 3) return []
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed === '' ? [] : [trimmed]
  }
  if (Array.isArray(value)) {
    const out: string[] = []
    for (const entry of value.slice(0, MAX_ARRAY_SCAN)) out.push(...collectUrls(entry, depth + 1))
    return out
  }
  if (isRecord(value)) {
    // First matching key wins: `{ raw, gateway }` describes one asset, not two.
    for (const key of OBJECT_URL_KEYS) {
      const nested = value[key]
      if (typeof nested === 'string' && nested.trim() !== '') return [nested.trim()]
    }
  }
  return []
}

/** Like collectUrls, but returns raw strings (used for inline SVG markup). */
function collectStrings(value: unknown, depth: number): string[] {
  if (depth > 3) return []
  if (typeof value === 'string') return value.trim() === '' ? [] : [value]
  if (Array.isArray(value)) {
    const out: string[] = []
    for (const entry of value.slice(0, MAX_ARRAY_SCAN)) out.push(...collectStrings(entry, depth + 1))
    return out
  }
  return []
}

function collectFileUrls(files: unknown): string[] {
  if (files === undefined || files === null) return []
  if (Array.isArray(files)) {
    const out: string[] = []
    for (const entry of files.slice(0, MAX_ARRAY_SCAN)) out.push(...collectUrls(entry, 1))
    return out
  }
  if (isRecord(files)) {
    const out: string[] = []
    for (const entry of Object.values(files).slice(0, MAX_ARRAY_SCAN)) {
      out.push(...collectUrls(entry, 1))
    }
    return out
  }
  return []
}

/** Wrap inline SVG markup as a `data:` URL so it can be fetched like any asset. */
function toDataUrl(markup: string): string {
  const trimmed = markup.trim()
  if (trimmed === '') return ''
  if (/^data:/i.test(trimmed)) return trimmed
  return `data:image/svg+xml;base64,${Buffer.from(trimmed, 'utf8').toString('base64')}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
