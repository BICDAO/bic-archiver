/**
 * The shared BIC archive, the one-click mirror, and the gallery.
 *
 * These three things exist because of one measured fact: of 10,762 content IDs
 * in the real May-2026 backup, 428 were served by nobody, and they were almost
 * entirely the assets BIC had rescued from Arweave and old web servers — 96.5%
 * and 88.6% dead respectively, against 0.7% of native IPFS content. Nobody else
 * has a reason to keep BIC's rescues alive, so BIC has to, and one person's
 * laptop is not a plan.
 *
 * The cheapest fix available is other members. Every member who mirrors the
 * archive is another provider, and it costs them a click and some disk.
 */

/**
 * Where the archive lives.
 *
 * `rootCid` is a snapshot: a UnixFS directory CID changes whenever its contents
 * change, so this value is correct only until the next NFT is added. That is a
 * real limitation of shipping a CID in an app binary — every member who clicks
 * mirror after the next update would pin a stale copy.
 *
 * The durable answer is a stable pointer the DAO republishes: an IPNS name, or
 * DNSLink on a domain BIC controls. `pointer` is where that goes. When it is
 * set, resolve it and treat `rootCid` only as the fallback for when resolution
 * fails.
 */
export const BIC_ARCHIVE = {
  /** Verified 2026-08-04: 19,175 blocks, 20,808 files, 274 folders. */
  rootCid: 'bafybeiad6nqfpptsvw4zr22mcfbq4dg3f4kzvnuwlxb3glcpobmgutmyba',
  label: 'BIC Backup May-2026',
  approxBytes: 1_933_339_888,
  approxFiles: 20_808,
  /**
   * DNSLink on the DAO's own domain, verified working 2026-08-04: a TXT record
   * at `_dnslink.bureauofinternetculture.art` holds `dnslink=/ipfs/<cid>`, and
   * fetching a path under `/ipns/bureauofinternetculture.art/` returns real
   * content.
   *
   * This is what stops the mirror button going stale. `rootCid` above is only a
   * snapshot; when Rex updates the archive he edits that one TXT value and every
   * member follows automatically, with no app release.
   *
   * Note: a bare request for the root times out at the gateway, because it tries
   * to render a directory listing of 20,808 entries. That is not a resolution
   * failure — resolve the name, then address content by path or CID rather than
   * asking a gateway to list the root.
   */
  pointer: '/ipns/bureauofinternetculture.art' as string | null
} as const

/** What a member's machine can actually do for the archive. */
export type MirrorCapability =
  /** A local IPFS node: a real provider, content served to anyone who asks. */
  | 'node'
  /** A Pinata account: a real provider, hosted, survives the laptop closing. */
  | 'pinata'
  /** Neither: the bytes can still be saved to disk, but nothing is served. */
  | 'cold-copy'

/** One step of a mirror run, streamed to the GUI. */
export interface MirrorProgress {
  phase: 'checking' | 'resolving' | 'fetching' | 'pinning' | 'verifying' | 'done' | 'error'
  /** Plain English, for a member who has never heard of a CID. */
  message: string
  /** 0..1 when known. */
  progress?: number
  bytesDone?: number
  bytesTotal?: number
}

/** The outcome of clicking the one big button. */
export interface MirrorResult {
  ok: boolean
  /** What we were actually able to do. */
  used: MirrorCapability[]
  rootCid: string
  blocks: number
  bytes: number
  /** True only when this machine now serves the content to other people. */
  nowServing: boolean
  /** Plain-English summary, safe to show anyone. */
  summary: string
  /** Plain-English problems; empty when everything worked. */
  errors: string[]
}

/* -------------------------------------------------------------------------- */
/* Gallery                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Custom scheme used to show archived images in the window.
 *
 * The renderer has no filesystem and no Node, so it cannot read the blockstore.
 * Handing it `data:` URLs would mean base64-ing multi-megabyte images through
 * IPC for every thumbnail. Instead the main process serves bytes over this
 * scheme, straight from the blockstore, and the renderer just uses it in `src`.
 *
 * Form: `bic-media://cid/<cid>`. Must be registered as a privileged scheme
 * BEFORE app ready, and allowed in the Content-Security-Policy `img-src` and
 * `media-src`.
 */
export const MEDIA_SCHEME = 'bic-media'
export const mediaUrl = (cid: string): string => `${MEDIA_SCHEME}://cid/${cid}`

/** One NFT as the gallery shows it. */
export interface GalleryItem {
  /** Folder name inside the archive; unique, used as the key. */
  folder: string
  /** Display name from metadata, falling back to the folder name. */
  name: string
  contract?: string
  tokenId?: string
  /** CIDs of the pieces, when present. */
  imageCid?: string
  animationCid?: string
  metadataCid?: string
  /** Content type of the image, so the GUI knows whether it can render it. */
  imageContentType?: string
  /** Parsed metadata, for the detail panel. */
  metadata?: Record<string, unknown>
  /** Normalised traits, since collections disagree about the field name. */
  attributes: Array<{ label: string; value: string }>
  description?: string
  /** Total bytes of everything under this NFT's folder. */
  sizeBytes: number
  /** Worst network verdict across this NFT's own CIDs. */
  network: 'healthy' | 'at-risk' | 'unreachable' | 'unchecked'
  /** True when nothing under this NFT is pinned anywhere. */
  atRisk: boolean
}

/** Summary across the whole gallery. */
export interface GallerySummary {
  items: number
  bytes: number
  withImage: number
  unreachable: number
  atRisk: number
}
