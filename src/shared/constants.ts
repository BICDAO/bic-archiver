/**
 * Network endpoints and tunables.
 *
 * Every endpoint here was reachability-tested when this file was written.
 * Endpoints rot; the app treats each list as an ordered set of candidates and
 * falls through on failure rather than trusting any single one.
 */

/**
 * Gateways that support the trustless (verifiable) retrieval protocol —
 * `Accept: application/vnd.ipld.car` and `?format=raw`. Preferred, because the
 * blocks they return can be hash-verified locally, which preserves the original
 * CID by construction instead of trying to recreate it.
 */
export const TRUSTLESS_GATEWAYS = [
  'https://trustless-gateway.link',
  'https://ipfs.io',
  'https://dweb.link',
  'https://w3s.link'
] as const

/**
 * Plain HTTP gateways, used only as a last resort when no trustless gateway
 * will serve the content. Bytes retrieved this way cannot be hash-verified
 * against the requested CID without re-chunking, so anything stored from these
 * is flagged `cidPreserved: false` until reconstruction confirms otherwise.
 */
export const FALLBACK_GATEWAYS = [
  'https://ipfs.io',
  'https://dweb.link',
  'https://gateway.pinata.cloud',
  'https://4everland.io',
  'https://nftstorage.link'
] as const

/**
 * Delegated routing endpoint (IPIP-337). Answers "is anyone announcing this
 * CID?" without running a DHT node. An empty provider list is the strongest
 * available signal that content has fallen off the network.
 */
export const DELEGATED_ROUTING = 'https://delegated-ipfs.dev/routing/v1'

/** Public Ethereum JSON-RPC endpoints, tried in order. */
export const ETH_RPCS = [
  'https://ethereum-rpc.publicnode.com',
  'https://cloudflare-eth.com',
  'https://eth.drpc.org',
  'https://rpc.flashbots.net'
] as const

/** Arweave gateways for `ar://` URIs. */
export const ARWEAVE_GATEWAYS = ['https://arweave.net', 'https://ar-io.net'] as const

/** ERC-721 `tokenURI(uint256)`. */
export const SELECTOR_TOKEN_URI = '0xc87b56dd'
/** ERC-1155 `uri(uint256)`. */
export const SELECTOR_URI = '0x0e89341c'
/** ERC-721 `name()`. */
export const SELECTOR_NAME = '0x06fdde03'

/*
 * Zora's original (v1) Media contract, 0xabefbc9fd2f806065b4f3c237d4b59d9a97bcac7,
 * keeps two links per token. `tokenURI` is the artwork itself; the metadata
 * (name, description, mimeType) is at `tokenMetadataURI`. It also records the
 * SHA-256 of both files at mint. Each selector below is the first four bytes of
 * the keccak-256 of its signature, and each was checked with a live `eth_call`
 * for token 3366 on 2026-10-04.
 */

/** Zora v1 Media `tokenMetadataURI(uint256)` → string. */
export const SELECTOR_TOKEN_METADATA_URI = '0x157c3df9'
/** Zora v1 Media `tokenContentHashes(uint256)` → bytes32, the artwork's SHA-256. */
export const SELECTOR_TOKEN_CONTENT_HASHES = '0xfad32197'
/** Zora v1 Media `tokenMetadataHashes(uint256)` → bytes32, the metadata's SHA-256. */
export const SELECTOR_TOKEN_METADATA_HASHES = '0x01ddc3b5'

/** Per-request network timeout, milliseconds. */
export const FETCH_TIMEOUT_MS = 60_000
/** Timeout for a whole trustless CAR retrieval, milliseconds. */
export const CAR_TIMEOUT_MS = 180_000
/** How many gateways to race a health probe across. */
export const HEALTH_CONCURRENCY = 4

/** Subdirectory names inside the archive, matching the existing manual layout. */
export const LAYOUT = {
  webMetadata: 'web metadata',
  arweaveMetadata: 'arweave metadata',
  webImage: 'web image',
  arweaveImage: 'arweave image',
  arweaveAnimation: 'arweave animation',
  provenance: '_provenance.json'
} as const
