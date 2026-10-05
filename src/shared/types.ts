/**
 * Shared type contracts for BIC Archiver.
 *
 * These types are the fixed interface between the main-process engine and the
 * renderer GUI. Treat them as a contract: implementations must conform, and any
 * change here must be reflected on both sides.
 */

/** Where a piece of content ultimately came from. */
export type AssetSource = 'ipfs' | 'http' | 'arweave' | 'onchain' | 'local'

/** Which token standard we used to read the token URI. */
export type TokenStandard = 'erc721' | 'erc1155' | 'unknown'

/** Identifies one NFT on one chain. */
export interface TokenRef {
  chainId: number
  /**
   * 0x address. Produced lowercase throughout — nothing here computes an
   * EIP-55 checksum — so every comparison against it must be case-insensitive.
   */
  contract: string
  /** Decimal string — token IDs exceed Number.MAX_SAFE_INTEGER. */
  tokenId: string
  standard: TokenStandard
}

/** An IPFS path split into its CID root and remaining path segments. */
export interface IpfsPath {
  /** Root CID as a string, exactly as it appeared. */
  cid: string
  /** Remaining path after the CID, without a leading slash. May be ''. */
  path: string
}

/** The result of reading tokenURI(id) / uri(id) off-chain. */
export interface ResolvedTokenUri {
  /** Exactly what the contract returned, before any normalisation. */
  raw: string
  kind: 'ipfs' | 'http' | 'arweave' | 'data'
  /** An https URL we can fetch, when applicable. */
  normalizedUrl?: string
  ipfsPath?: IpfsPath
  /** Decoded JSON for `data:` URIs (on-chain metadata). */
  inlineJson?: Record<string, unknown>
  /** True when the contract stored metadata fully on-chain. */
  onchain: boolean
}

/**
 * One resource (metadata / image / animation) that we have stored in the local
 * blockstore.
 */
export interface FetchedResource {
  /** CID of the content as stored in our blockstore. */
  cid: string
  /**
   * True when `cid` is byte-identical to the CID the contract referenced.
   * Always true for trustless CAR fetches; may be false for reconstructed
   * content. Meaningless (and set true) for non-IPFS sources, which have no
   * original CID to match.
   */
  cidPreserved: boolean
  /** The CID the contract referenced, when the source was IPFS. */
  originalCid?: string
  /** Total size in bytes of the resource content. */
  bytes: number
  /** Lowercase hex sha256 of the raw content, for provenance. */
  sha256: string
  contentType?: string
  source: AssetSource
  /** The URL or URI we fetched from. */
  sourceUrl: string
  /** ISO-8601 timestamp. */
  fetchedAt: string
  /** Which gateway served it, when relevant. */
  gateway?: string
  /** Human-readable notes, e.g. how a CID was reconstructed. */
  notes?: string[]
}

/** Everything we archived for a single token. */
export interface ArchivedToken {
  ref: TokenRef
  /** The `name` field from metadata, or a fallback. */
  name: string
  /** Filesystem/IPFS-safe folder name derived from `name`. */
  folderName: string
  tokenUri: ResolvedTokenUri
  /**
   * The token's separate metadata link, for a contract that keeps the metadata
   * apart from the artwork. Zora's original (v1) Media contract is the case
   * this exists for: there `tokenUri` is the artwork itself and this is what
   * `tokenMetadataURI(id)` returned. Absent for every other contract, where
   * `tokenUri` is the metadata.
   */
  metadataUri?: ResolvedTokenUri
  /**
   * SHA-256 fingerprints the contract itself recorded when the token was
   * minted, as lowercase hex without `0x` (Zora v1's `tokenContentHashes` and
   * `tokenMetadataHashes`). Absent when the contract records none.
   */
  contractSha256?: { content?: string; metadata?: string }
  metadata?: FetchedResource
  /** Parsed metadata JSON, for display and asset discovery. */
  metadataJson?: Record<string, unknown>
  /**
   * Additional assets keyed by role: 'image', 'animation', 'image_original',
   * etc. Keys mirror the metadata field they came from.
   */
  assets: Record<string, FetchedResource>
  status: 'ok' | 'partial' | 'failed'
  /** Plain-English problems, safe to show a non-technical member. */
  errors: string[]
  archivedAt: string
}

/** Persisted state of one archive workspace. */
export interface ArchiveManifest {
  version: 1
  name: string
  createdAt: string
  updatedAt: string
  /** Root CID of the assembled archive directory, once built. */
  rootCid?: string
  tokens: ArchivedToken[]
  /** CIDs of pre-existing backups merged into this archive. */
  importedRoots: string[]
}

/** Result of probing whether a CID is still retrievable. */
export interface HealthResult {
  cid: string
  /** What this CID is, e.g. "Bored Ape #1 — image". */
  label: string
  /** Number of providers announcing the CID via delegated routing. */
  providers: number
  gateways: Array<{
    gateway: string
    ok: boolean
    ms: number
    status: number | string
  }>
  /**
   * healthy     — providers found and/or gateways serve it
   * at-risk     — served by some gateways but no providers announced
   * unreachable — no providers and no gateway served it
   */
  verdict: 'healthy' | 'at-risk' | 'unreachable'
  checkedAt: string
}

/** Progress event streamed from the engine to the GUI. */
export interface ProgressEvent {
  /** Correlates events belonging to one token. */
  id: string
  phase:
    | 'resolving'
    | 'fetching-metadata'
    | 'fetching-assets'
    | 'storing'
    | 'verifying'
    | 'done'
    | 'error'
  /** Plain-English message for a non-technical member. */
  message: string
  /** 0..1 when known. */
  progress?: number
  detail?: string
}

/** A parsed user input describing which tokens to archive. */
export interface TokenInputSpec {
  chainId: number
  contract: string
  tokenIds: string[]
}
