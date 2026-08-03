/**
 * The provenance record — `_provenance.json` inside every token folder.
 *
 * This file is the point of the whole exercise. Years from now, a DAO member who
 * has never met anyone involved should be able to open a folder out of a `.car`
 * backup and answer, without trusting this app or its authors:
 *
 *   - which NFT is this, on which chain, and what did its contract actually say?
 *   - where did each file come from, and which gateway handed it over, and when?
 *   - is this file byte-for-byte the thing the contract pointed at, or is it a
 *     rescued copy whose original IPFS address we could not reproduce?
 *   - has anything changed since? (every file is listed with its SHA-256)
 *
 * Two properties are load-bearing:
 *
 * 1. **It is a pure function of the archived token.** No clocks, no random ids,
 *    no environment. The same `ArchivedToken` always produces byte-identical
 *    JSON, which is what lets the archiver rebuild a token folder later and get
 *    exactly the same CID it got the first time.
 * 2. **It never softens bad news.** A file whose original CID could not be
 *    preserved says so, in plain English, right next to the hash it is stored
 *    under.
 */

import { LAYOUT } from '../../shared/constants.js'
import type { ArchivedToken, FetchedResource } from '../../shared/types.js'
import { sanitizeFolderName } from './inputs.js'

/** Identifies the shape of this record, for whoever reads it in ten years. */
const SCHEMA = 'bic-archiver/provenance@1'

/**
 * A `data:` token URI can hold an entire on-chain SVG, which would otherwise be
 * copied into this record in full. Past this many characters it is shortened —
 * the complete value is archived beside this file as the metadata anyway, and
 * its SHA-256 is recorded here.
 */
const MAX_RAW_TOKEN_URI = 8_192

/**
 * Folder names for content that came off the ordinary web, keyed by role.
 *
 * The two named here are fixed by the existing hand-made backups (see `LAYOUT`
 * in `constants.ts`); every other role follows the same pattern, so an
 * `animation_url` served over https lands in `web animation/`.
 */
const WEB_DIRS: Record<string, string> = {
  metadata: LAYOUT.webMetadata,
  image: LAYOUT.webImage
}

/** The same, for content fetched from Arweave. */
const ARWEAVE_DIRS: Record<string, string> = {
  metadata: LAYOUT.arweaveMetadata,
  image: LAYOUT.arweaveImage,
  animation: LAYOUT.arweaveAnimation
}

/** Common media types, so a rescued file keeps a sensible extension. */
const EXTENSION_BY_TYPE: Record<string, string> = {
  'application/json': '.json',
  'text/json': '.json',
  'application/ld+json': '.json',
  'text/plain': '.txt',
  'text/html': '.html',
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/avif': '.avif',
  'image/svg+xml': '.svg',
  'image/tiff': '.tiff',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'video/quicktime': '.mov',
  'audio/mpeg': '.mp3',
  'audio/wav': '.wav',
  'audio/x-wav': '.wav',
  'audio/ogg': '.ogg',
  'audio/flac': '.flac',
  'application/pdf': '.pdf',
  'model/gltf-binary': '.glb',
  'model/gltf+json': '.gltf',
  'application/zip': '.zip'
}

/** Strip parameters such as `; charset=utf-8` from a media type. */
function baseMediaType(contentType: string | undefined): string {
  if (contentType === undefined) return ''
  const semicolon = contentType.indexOf(';')
  return (semicolon === -1 ? contentType : contentType.slice(0, semicolon)).trim().toLowerCase()
}

function extensionFor(contentType: string | undefined): string {
  return EXTENSION_BY_TYPE[baseMediaType(contentType)] ?? ''
}

/** The last path segment of a URL, or '' when there is nothing usable. */
function basenameFromUrl(url: string): string {
  const text = url.trim()
  if (text === '') return ''

  let candidate = text

  try {
    // `new URL` handles https, ipfs, ar and anything else with a scheme.
    const parsed = new URL(text)
    const source = parsed.pathname === '' || parsed.pathname === '/' ? parsed.host + parsed.pathname : parsed.pathname
    candidate = source
  } catch {
    // Not a URL — treat it as a bare path.
    const query = candidate.search(/[?#]/)
    if (query >= 0) candidate = candidate.slice(0, query)
  }

  const segments = candidate.split('/').filter((segment) => segment !== '')
  const last = segments.length === 0 ? '' : segments[segments.length - 1]
  if (last === undefined || last === '') return ''

  try {
    return decodeURIComponent(last)
  } catch {
    return last
  }
}

/**
 * Where this resource lives inside its token folder, as path segments.
 *
 * The layout deliberately mirrors the folders the DAO already builds by hand in
 * IPFS Desktop, so a new backup sits next to a 2023 one and looks the same:
 *
 *   <Token Name>/metadata              content addressed on IPFS — original CID
 *   <Token Name>/image                 content addressed on IPFS — original CID
 *   <Token Name>/animation
 *   <Token Name>/web metadata/<file>   fetched over https
 *   <Token Name>/web image/<file>
 *   <Token Name>/arweave image/<file>
 *   <Token Name>/_provenance.json      this record
 *
 * Items that already have an IPFS address keep the bare role name, because the
 * whole point is that the entry *is* the original CID; anything rescued from the
 * web or Arweave goes into a named subfolder with its own filename, which is how
 * the manual instructions have always distinguished the two.
 *
 * Collisions are impossible by construction: roles are unique within a token,
 * IPFS-style entries are named after the role, and web/Arweave entries each get
 * a subfolder that is also named after the role.
 *
 * Exported because {@link buildProvenance} must record the path a file was
 * written to, and the archiver must write it to that same path — one definition,
 * used by both.
 */
export function layoutPathFor(role: string, resource: FetchedResource): string[] {
  const safeRole = sanitizeFolderName(role, 'item')

  if (resource.source === 'http') {
    return [WEB_DIRS[role] ?? `web ${safeRole}`, fileNameFor(safeRole, resource)]
  }

  if (resource.source === 'arweave') {
    return [ARWEAVE_DIRS[role] ?? `arweave ${safeRole}`, fileNameFor(safeRole, resource)]
  }

  // 'ipfs', 'onchain' and 'local' content is stored under its own address, so
  // the entry is the file itself.
  return [safeRole]
}

/** The filename to use for a rescued web/Arweave file. */
function fileNameFor(safeRole: string, resource: FetchedResource): string {
  const fallback = `${safeRole}${extensionFor(resource.contentType)}`
  const derived = sanitizeFolderName(basenameFromUrl(resource.sourceUrl), fallback)

  if (derived.includes('.')) {
    return derived
  }

  // No extension in the URL (common for Arweave ids and API routes) — add one
  // from the media type so the file opens by double-clicking it.
  return `${derived}${extensionFor(resource.contentType)}`
}

/** One file's entry in the audit record. */
interface ProvenanceItem {
  role: string
  path: string
  source: string
  sourceUrl: string
  gateway: string | null
  fetchedAt: string
  bytes: number
  sha256: string
  contentType: string | null
  storedCid: string
  originalCid: string | null
  /** true / false / null when there was no original IPFS address to match. */
  matchesOriginalCid: boolean | null
  cidPreserved: boolean
  notes: string[]
}

function itemFor(role: string, resource: FetchedResource): ProvenanceItem {
  const originalCid = resource.originalCid ?? null

  return {
    role,
    path: layoutPathFor(role, resource).join('/'),
    source: resource.source,
    sourceUrl: resource.sourceUrl,
    gateway: resource.gateway ?? null,
    fetchedAt: resource.fetchedAt,
    bytes: resource.bytes,
    sha256: resource.sha256,
    contentType: resource.contentType ?? null,
    storedCid: resource.cid,
    originalCid,
    matchesOriginalCid: originalCid === null ? null : resource.cidPreserved && resource.cid === originalCid,
    cidPreserved: resource.cidPreserved,
    notes: [...(resource.notes ?? [])]
  }
}

/** Shorten a very long token URI, saying plainly that it was shortened. */
function describeRawTokenUri(raw: string): { value: string; shortened: boolean; length: number } {
  if (raw.length <= MAX_RAW_TOKEN_URI) {
    return { value: raw, shortened: false, length: raw.length }
  }
  return {
    value: raw.slice(0, MAX_RAW_TOKEN_URI),
    shortened: true,
    length: raw.length
  }
}

/**
 * Build the audit record written to `<Token Name>/_provenance.json`.
 *
 * Pure: the same token always yields the same object, with the same key order,
 * so `JSON.stringify` of it is byte-stable and the folder's CID is reproducible.
 */
export function buildProvenance(token: ArchivedToken): Record<string, unknown> {
  const items: ProvenanceItem[] = []

  if (token.metadata !== undefined) {
    items.push(itemFor('metadata', token.metadata))
  }
  for (const [role, resource] of Object.entries(token.assets)) {
    items.push(itemFor(role, resource))
  }

  const totalBytes = items.reduce((sum, item) => sum + (Number.isFinite(item.bytes) ? item.bytes : 0), 0)
  const sources = [...new Set(items.map((item) => item.source))].sort()
  const gateways = [...new Set(items.map((item) => item.gateway).filter((g): g is string => g !== null))].sort()
  const unpreserved = items.filter((item) => item.matchesOriginalCid === false).map((item) => item.path)

  const rawTokenUri = describeRawTokenUri(token.tokenUri.raw ?? '')

  const tokenUri: Record<string, unknown> = {
    /** Exactly what `tokenURI(id)` / `uri(id)` returned, before any tidying. */
    raw: rawTokenUri.value,
    rawWasShortened: rawTokenUri.shortened,
    rawLength: rawTokenUri.length,
    kind: token.tokenUri.kind,
    storedOnChain: token.tokenUri.onchain
  }
  if (token.tokenUri.normalizedUrl !== undefined) {
    tokenUri.normalizedUrl = token.tokenUri.normalizedUrl
  }
  if (token.tokenUri.ipfsPath !== undefined) {
    tokenUri.ipfs = {
      cid: token.tokenUri.ipfsPath.cid,
      path: token.tokenUri.ipfsPath.path
    }
  }

  return {
    schema: SCHEMA,
    generatedBy: 'BIC Archiver',
    archivedAt: token.archivedAt,
    status: token.status,

    token: {
      chainId: token.ref.chainId,
      contract: token.ref.contract,
      tokenId: token.ref.tokenId,
      standard: token.ref.standard,
      name: token.name,
      preferredFolderName: token.folderName
    },

    tokenUri,

    metadata: token.metadata === undefined ? null : itemFor('metadata', token.metadata),
    assets: Object.fromEntries(
      Object.entries(token.assets).map(([role, resource]) => [role, itemFor(role, resource)])
    ),

    /** Flat index of everything stored in this folder, for quick checking. */
    files: items.map((item) => ({
      path: item.path,
      bytes: item.bytes,
      sha256: item.sha256,
      cid: item.storedCid
    })),

    summary: {
      fileCount: items.length,
      totalBytes,
      sources,
      gatewaysUsed: gateways,
      allOriginalAddressesPreserved: unpreserved.length === 0,
      filesWithoutTheirOriginalAddress: unpreserved
    },

    problems: [...token.errors],

    howToCheckThis: [
      'Every file listed under "files" is stored in this backup at the path shown, beside this record.',
      'To confirm a file has not changed, compute its SHA-256 and compare it with the "sha256" value here.',
      'Where "matchesOriginalCid" is true, the file is stored under exactly the IPFS address the smart ' +
        'contract pointed at, and every block was re-hashed while downloading, so no gateway could have ' +
        'altered it.',
      'Where "matchesOriginalCid" is false, the original file could not be downloaded in verifiable form. ' +
        'The contents were rescued from a gateway copy and stored under a newly computed address; the ' +
        '"notes" for that file explain what was tried.',
      'Where "matchesOriginalCid" is null, the file never had an IPFS address to match — it came from an ' +
        'ordinary web address, from Arweave, or directly from the Ethereum blockchain.',
      'This record does not include a hash of itself. Its own IPFS address is recorded in the folder that ' +
        'contains it.'
    ]
  }
}
