/**
 * Verifiable ("trustless") IPFS retrieval.
 *
 * This is the module that makes the manual archiving ritual obsolete.
 *
 * The manual process downloads a *file* from a gateway and then tries to guess
 * the chunker, CID version and codec that would reproduce the original hash.
 * That is a dark art, and it usually fails.
 *
 * Instead we ask gateways for the underlying **blocks** over the trustless
 * protocol (`?format=car` + `Accept: application/vnd.ipld.car`) and re-hash
 * every single block we receive. If the hashes match, the original CID is
 * preserved *by construction* — there is nothing to guess. If they do not
 * match, the response is thrown away wholesale and the next gateway is tried:
 * a public gateway must never be able to feed us bytes we did not ask for.
 *
 * Everything here has a timeout and a finite number of attempts. Content that
 * has fallen off the network (the common, important case) fails fast with a
 * message a non-technical DAO member can act on.
 */

import { CarReader } from '@ipld/car'
import * as dagPb from '@ipld/dag-pb'
import type { PBNode } from '@ipld/dag-pb'
import { UnixFS } from 'ipfs-unixfs'
import { CID } from 'multiformats/cid'
import * as Digest from 'multiformats/hashes/digest'
import { identity } from 'multiformats/hashes/identity'
import { sha256, sha512 } from 'multiformats/hashes/sha2'
import type { MultihashHasher } from 'multiformats/hashes/interface'
import {
  CAR_TIMEOUT_MS,
  FALLBACK_GATEWAYS,
  FETCH_TIMEOUT_MS,
  TRUSTLESS_GATEWAYS
} from '../../shared/constants.js'
import { getBlockBytes, hasBlock, putBlock, type Blockstore } from './blockstore.js'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** How much of the DAG a trustless request should return. */
export type DagScope = 'all' | 'entity' | 'block'

/** Options for {@link fetchCar}. */
export interface FetchCarOptions {
  /**
   * `all` — the whole sub-DAG (default; what you want for archiving).
   * `entity` — just the addressed file/directory entity.
   * `block` — a single block.
   */
  scope?: DagScope
  /** Path *below* the CID, e.g. `"1"` or `"metadata/1.json"`. No leading slash. */
  path?: string
  /** Cancels the retrieval (user pressed Stop). */
  signal?: AbortSignal
  /** Per-gateway budget for the whole transfer. Defaults to `CAR_TIMEOUT_MS`. */
  timeoutMs?: number
  /**
   * Per-gateway budget for the *first byte of the reply*. A gateway that has
   * not answered by then is abandoned early, so unreachable content fails in
   * seconds instead of tying up the full `timeoutMs` on every gateway in turn.
   * Defaults to 30 seconds (clamped to `timeoutMs`).
   */
  headersTimeoutMs?: number
  /** Override the gateway list. Defaults to `TRUSTLESS_GATEWAYS`. */
  gateways?: readonly string[]
  /** Refuse responses larger than this many bytes. Defaults to 2 GiB. */
  maxBytes?: number
}

/** A verified set of IPFS blocks. */
export interface CarFetchResult {
  /**
   * Every block in the response, hash-verified, keyed by `cid.toString()` using
   * the CID exactly as it was encoded in the CAR. Parse a key back with
   * `CID.parse(key)` — it round-trips, including CIDv0 (`Qm…`) keys.
   */
  blocks: Map<string, Uint8Array>
  /** Base URL of the gateway that served this response. */
  gateway: string
}

/** Options for {@link fetchDag}. `scope` is always `'all'`. */
export type FetchDagOptions = Omit<FetchCarOptions, 'scope'>

/** Summary of a DAG that has been fetched and persisted locally. */
export interface DagFetchResult {
  /** The CID that was requested; the root of the stored sub-DAG. */
  root: CID
  /** Base URL of the gateway that served it. */
  gateway: string
  /** How many distinct blocks were verified and stored. */
  blocks: number
  /** Total size of those blocks, in bytes. */
  bytes: number
}

/** Options for {@link resolvePath}. */
export interface ResolvePathOptions {
  signal?: AbortSignal
  timeoutMs?: number
  headersTimeoutMs?: number
  gateways?: readonly string[]
  /**
   * Safety valve when searching a HAMT-sharded directory: the maximum number of
   * shard nodes to visit before giving up. Defaults to 4096.
   */
  maxShardNodes?: number
}

/** Options for {@link fetchHttpBytes} and {@link fetchIpfsBytesFallback}. */
export interface HttpFetchOptions {
  signal?: AbortSignal
  /** Budget for the whole transfer. Defaults to `FETCH_TIMEOUT_MS`. */
  timeoutMs?: number
  /**
   * Budget for the first byte of the reply. Defaults to 30 seconds (clamped to
   * `timeoutMs`). See {@link FetchCarOptions.headersTimeoutMs}.
   */
  headersTimeoutMs?: number
  /** Refuse responses larger than this many bytes. Defaults to 2 GiB. */
  maxBytes?: number
  /** Value for the `Accept` header. */
  accept?: string
}

/** Result of a plain HTTPS byte fetch. */
export interface HttpBytesResult {
  bytes: Uint8Array
  contentType?: string
  /** HTTP status of the (successful) response. Non-2xx responses throw. */
  status: number
}

/** Result of a last-resort plain-gateway byte fetch. */
export interface FallbackBytesResult {
  bytes: Uint8Array
  /** Base URL of the gateway that served it. */
  gateway: string
  contentType?: string
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Multihash codes we are able to verify. Anything else is refused. */
const MH_IDENTITY = 0x00
const MH_SHA2_256 = 0x12
const MH_SHA2_512 = 0x13

/** IPLD codec codes. */
const CODEC_DAG_PB = dagPb.code
const CODEC_RAW = 0x55
const CODEC_DAG_CBOR = 0x71
const CODEC_DAG_JSON = 0x0129
const CODEC_JSON = 0x0200

const CAR_ACCEPT = 'application/vnd.ipld.car'
const USER_AGENT = 'bic-archiver/0.1 (+ipfs trustless retrieval)'

/** Hard ceiling on any single response body. */
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024 * 1024

/**
 * How long to wait for a gateway to say *anything* before moving on.
 *
 * The failure mode that matters — content that has fallen off the network —
 * looks like a gateway accepting the connection and then never replying. Left
 * to the full `CAR_TIMEOUT_MS` on each of four gateways that would be twelve
 * minutes of nothing. This deadline covers only the wait for the first byte;
 * once a gateway starts sending, the full timeout applies.
 */
const DEFAULT_HEADERS_TIMEOUT_MS = 30_000

/** Default ceiling on HAMT shard nodes visited during a path lookup. */
const MAX_SHARD_NODES = 4096

/** Pseudo-gateway name used when a CID carries its own bytes. */
const INLINE_SOURCE = 'inline (no download needed)'

/** Two lowercase/uppercase hex characters — a HAMT bucket prefix. */
const HEX_PREFIX = /^[0-9A-Fa-f]{2}$/

/** Does this string contain a percent-escape, i.e. is it already URL-encoded? */
const PERCENT_ESCAPE = /%[0-9A-Fa-f]{2}/

// ---------------------------------------------------------------------------
// Block verification — the security property this whole app rests on
// ---------------------------------------------------------------------------

/**
 * Re-hash `bytes` with the hash function named inside `cid` and compare the
 * result against the digest the CID commits to.
 *
 * Returns `false` — never throws — when the bytes do not match, when the CID
 * uses a hash function we cannot compute, or when hashing fails. A `false`
 * result must always be treated as "reject these bytes"; there is no safe way
 * to store content we could not verify under a CID we did not compute.
 *
 * Supports `sha2-256` (essentially all of IPFS), `sha2-512`, and `identity`
 * (used by tiny inline blocks, where the "digest" *is* the content).
 */
export async function verifyBlock(cid: CID, bytes: Uint8Array): Promise<boolean> {
  const hasher = hasherFor(cid.multihash.code)
  if (hasher === undefined) {
    return false
  }

  try {
    const computed = await hasher.digest(bytes)
    return Digest.equals(cid.multihash, computed)
  } catch {
    return false
  }
}

function hasherFor(code: number): MultihashHasher | undefined {
  switch (code) {
    case MH_SHA2_256:
      return sha256
    case MH_SHA2_512:
      return sha512
    case MH_IDENTITY:
      return identity
    default:
      return undefined
  }
}

// ---------------------------------------------------------------------------
// Trustless CAR retrieval
// ---------------------------------------------------------------------------

/**
 * Fetch a verified set of blocks for `cid` over the trustless gateway protocol.
 *
 * Each gateway in turn is asked for
 * `{gateway}/ipfs/{cid}[/{path}]?format=car&dag-scope={scope}` with
 * `Accept: application/vnd.ipld.car`. The response is parsed as a CAR and
 * **every block in it is re-hashed**. A single bad block invalidates the whole
 * response and we move on to the next gateway — partial trust is not a thing.
 *
 * @throws A plain-English `Error` naming every gateway tried and what each one
 * said, when no gateway can serve verified blocks.
 * @throws An `Error` with `name === 'AbortError'` if `opts.signal` is aborted.
 */
export async function fetchCar(cid: CID, opts: FetchCarOptions = {}): Promise<CarFetchResult> {
  const scope: DagScope = opts.scope ?? 'all'
  const path = encodeIpfsPath(opts.path)
  const gateways = opts.gateways ?? TRUSTLESS_GATEWAYS
  const timeoutMs = opts.timeoutMs ?? CAR_TIMEOUT_MS
  const headersTimeoutMs = opts.headersTimeoutMs ?? DEFAULT_HEADERS_TIMEOUT_MS
  const maxBytes = opts.maxBytes ?? MAX_RESPONSE_BYTES

  throwIfCancelled(opts.signal)

  // An identity CID carries its content inside itself. Nothing to download,
  // and nothing a gateway could get wrong.
  if (cid.multihash.code === MH_IDENTITY && path === '') {
    return {
      blocks: new Map([[cid.toString(), cid.multihash.digest]]),
      gateway: INLINE_SOURCE
    }
  }

  if (gateways.length === 0) {
    throw new PlainError(
      'No IPFS gateways are configured, so this content cannot be downloaded. ' +
        'This is a setup problem with the app rather than a problem with the content.'
    )
  }

  const failures: GatewayFailure[] = []

  for (const gateway of gateways) {
    throwIfCancelled(opts.signal)
    const url = `${trimSlash(gateway)}/ipfs/${cid.toString()}${path === '' ? '' : `/${path}`}?format=car&dag-scope=${scope}`

    try {
      return await fetchCarFromGateway(
        cid,
        url,
        gateway,
        timeoutMs,
        headersTimeoutMs,
        maxBytes,
        opts.signal
      )
    } catch (err) {
      if (isCancellation(err)) {
        throw err
      }
      failures.push({ gateway: hostOf(gateway), reason: reasonText(err) })
    }
  }

  throw retrievalError(cid, path, failures)
}

async function fetchCarFromGateway(
  cid: CID,
  url: string,
  gateway: string,
  timeoutMs: number,
  headersTimeoutMs: number,
  maxBytes: number,
  outerSignal: AbortSignal | undefined
): Promise<CarFetchResult> {
  const timer = createTimeout(timeoutMs, headersTimeoutMs, outerSignal)

  try {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: timer.signal,
      headers: { accept: CAR_ACCEPT, 'user-agent': USER_AGENT }
    })
    timer.headersReceived()

    if (!response.ok) {
      await discardBody(response)
      throw new PlainError(describeHttpStatus(response.status))
    }

    const body = await readBodyLimited(response, maxBytes)

    let reader: CarReader
    try {
      reader = await CarReader.fromBytes(body)
    } catch {
      throw new PlainError('sent something that was not a valid IPFS archive')
    }

    const blocks = new Map<string, Uint8Array>()
    const byDigest = new Set<string>()

    for await (const block of reader.blocks()) {
      if (!(await verifyBlock(block.cid, block.bytes))) {
        throw new PlainError(
          `sent data that did not match its fingerprint (block ${block.cid.toString()}), so it was rejected`
        )
      }
      blocks.set(block.cid.toString(), block.bytes)
      byDigest.add(digestKey(block.cid))
    }

    if (blocks.size === 0) {
      throw new PlainError('returned an empty archive')
    }

    if (!byDigest.has(digestKey(cid))) {
      throw new PlainError('returned an archive that did not contain the item we asked for')
    }

    return { blocks, gateway }
  } catch (err) {
    throw translateTransportError(err, timer, outerSignal)
  } finally {
    timer.cleanup()
  }
}

/**
 * Fetch the entire sub-DAG under `cid`, verify it, and persist every block into
 * `blockstore`.
 *
 * Because each stored block is keyed by its own verified hash, re-exporting the
 * blockstore as a `.car` later reproduces the original root CID exactly.
 *
 * @param opts - Same as {@link FetchCarOptions} minus `scope`. Passing a `path`
 * fetches the sub-DAG at that path; `root` in the result is still the CID you
 * asked for, because that is the CAR's root.
 */
export async function fetchDag(
  cid: CID,
  blockstore: Blockstore,
  opts: FetchDagOptions = {}
): Promise<DagFetchResult> {
  const { blocks, gateway } = await fetchCar(cid, { ...opts, scope: 'all' })

  const pairs: Array<{ cid: CID; bytes: Uint8Array }> = []
  let bytes = 0

  for (const [key, value] of blocks) {
    let blockCid: CID
    try {
      blockCid = CID.parse(key)
    } catch {
      // Cannot happen for keys we produced, but never let a bad key abort a
      // whole archive.
      continue
    }
    pairs.push({ cid: blockCid, bytes: value })
    bytes += value.byteLength
  }

  try {
    for await (const _stored of blockstore.putMany(pairs, { signal: opts.signal })) {
      // Draining the generator is what performs the writes.
    }
  } catch (err) {
    if (isCancellation(err)) {
      throw err
    }
    throw new PlainError(
      'The downloaded content could not be saved to disk. ' +
        `Check that the drive has free space and is still connected. (${messageOf(err)})`
    )
  }

  return { root: cid, gateway, blocks: pairs.length, bytes }
}

// ---------------------------------------------------------------------------
// Local UnixFS path resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a path like `"1"` or `"metadata/1.json"` beneath `root` to the CID it
 * points at, by decoding dag-pb nodes **locally**.
 *
 * Gateways cannot convert dag-pb to dag-json, so directory listings have to be
 * decoded client-side; that is exactly what happens here. Blocks already in
 * `blockstore` are used as-is; missing ones are fetched (verified) one block at
 * a time and stored, so a second resolve of the same path is free.
 *
 * Handles both plain UnixFS directories and HAMT-sharded ones. For a sharded
 * directory the shard tree is searched breadth-first, preferring shards already
 * on disk, bounded by `opts.maxShardNodes`.
 *
 * @returns The CID of the entry at `path` — which may be a file or a directory.
 * @throws A plain-English `Error` when a path segment does not exist, when a
 * segment names something that is not a folder, or when the directory data
 * cannot be understood.
 */
export async function resolvePath(
  root: CID,
  path: string,
  blockstore: Blockstore,
  opts: ResolvePathOptions = {}
): Promise<CID> {
  const segments = splitPath(path)
  let current = root
  const walked: string[] = []

  for (const segment of segments) {
    throwIfCancelled(opts.signal)

    const here = walked.length === 0 ? 'the top level' : `"${walked.join('/')}"`
    const node = await loadDirectoryNode(current, blockstore, opts, segment, here)
    current = await lookupChild(node, segment, blockstore, opts, here)
    walked.push(segment)
  }

  return current
}

/** Load a CID that we expect to be a UnixFS directory, and decode it. */
async function loadDirectoryNode(
  cid: CID,
  blockstore: Blockstore,
  opts: ResolvePathOptions,
  wanted: string,
  here: string
): Promise<PBNode> {
  if (cid.code !== CODEC_DAG_PB) {
    throw new PlainError(
      `"${wanted}" could not be found because ${here} is a single file, not a folder ` +
        `(${describeCodec(cid.code)}).`
    )
  }

  const bytes = await loadBlock(cid, blockstore, opts)

  try {
    return dagPb.decode(bytes)
  } catch {
    throw new PlainError(
      `The folder listing at ${here} could not be read — the data appears to be damaged.`
    )
  }
}

/** Find `name` inside a decoded directory node. */
async function lookupChild(
  node: PBNode,
  name: string,
  blockstore: Blockstore,
  opts: ResolvePathOptions,
  here: string
): Promise<CID> {
  const unixfs = readUnixFs(node)

  // Only a directory that *declares* itself HAMT-sharded gets the shard search.
  // Guessing from link names would be unsafe: in a plain folder containing
  // "ab1.json", a prefix-stripping search for "1.json" would match it.
  if (unixfs?.type === 'hamt-sharded-directory') {
    return searchShardedDirectory(node, name, blockstore, opts, here)
  }

  // A dag-pb node can perfectly well be a *file* (chunked into child links).
  // Saying "that folder is empty" about a JPEG would be nonsense.
  if (unixfs !== undefined && unixfs.type !== 'directory') {
    throw new PlainError(
      `"${name}" could not be found because ${here} is a file, not a folder.`
    )
  }

  for (const candidate of nameCandidates(name)) {
    for (const link of node.Links) {
      if (link.Name === candidate) {
        return link.Hash
      }
    }
  }

  throw missingEntryError(name, here, node.Links.map((link) => link.Name ?? '(unnamed)'))
}

/**
 * Breadth-first search of a HAMT-sharded directory.
 *
 * Entries in a shard are named `<2 hex chars><entry name>`; sub-shards are
 * named with exactly the 2 hex characters. We do not compute the murmur3 bucket
 * index (that would need a dependency we do not have), so instead we walk the
 * shard tree, preferring nodes already in the blockstore. That is slower than a
 * direct bucket lookup for very large collections but it is exact, and for the
 * normal case — the whole DAG was already fetched with `dag-scope=all` — it
 * never touches the network.
 */
async function searchShardedDirectory(
  rootNode: PBNode,
  name: string,
  blockstore: Blockstore,
  opts: ResolvePathOptions,
  here: string
): Promise<CID> {
  const budget = opts.maxShardNodes ?? MAX_SHARD_NODES
  const wanted = nameCandidates(name)
  const seen = new Set<string>()
  const localShards: CID[] = []
  const remoteShards: CID[] = []

  let node: PBNode | undefined = rootNode
  let visited = 1

  while (node !== undefined) {
    const hit = matchShardEntry(node, wanted)
    if (hit !== undefined) {
      return hit
    }

    for (const link of node.Links) {
      const linkName = link.Name ?? ''
      if (linkName.length !== 2 || !HEX_PREFIX.test(linkName)) {
        continue
      }
      const key = link.Hash.toString()
      if (seen.has(key)) {
        continue
      }
      seen.add(key)

      if (await hasBlock(blockstore, link.Hash)) {
        localShards.push(link.Hash)
      } else {
        remoteShards.push(link.Hash)
      }
    }

    const next = localShards.pop() ?? remoteShards.shift()
    if (next === undefined) {
      break
    }

    visited += 1
    if (visited > budget) {
      throw new PlainError(
        `The folder at ${here} is too large to search for "${name}" (checked ${budget} sections). ` +
          'Try archiving the exact file address instead of a folder path.'
      )
    }

    throwIfCancelled(opts.signal)
    node = await loadDirectoryNode(next, blockstore, opts, name, here)
  }

  throw new PlainError(
    `There is no "${name}" in the folder at ${here}. ` +
      'Double-check the token number or file name.'
  )
}

/** Does any link in this shard node hold the entry we want? */
function matchShardEntry(node: PBNode, wanted: readonly string[]): CID | undefined {
  for (const link of node.Links) {
    const linkName = link.Name ?? ''
    if (linkName.length <= 2 || !HEX_PREFIX.test(linkName.slice(0, 2))) {
      continue
    }
    const entry = linkName.slice(2)
    for (const candidate of wanted) {
      if (entry === candidate) {
        return link.Hash
      }
    }
  }
  return undefined
}

function readUnixFs(node: PBNode): UnixFS | undefined {
  if (node.Data === undefined) {
    return undefined
  }
  try {
    return UnixFS.unmarshal(node.Data)
  } catch {
    return undefined
  }
}

/**
 * Read one block, from disk if we have it and from the network if we do not.
 * Anything that arrives over the network is verified before it is stored, and a
 * locally stored block that fails verification (bit-rot, tampering) is
 * re-fetched rather than trusted.
 */
async function loadBlock(
  cid: CID,
  blockstore: Blockstore,
  opts: ResolvePathOptions
): Promise<Uint8Array> {
  if (cid.multihash.code === MH_IDENTITY) {
    return cid.multihash.digest
  }

  if (await hasBlock(blockstore, cid)) {
    try {
      const stored = await getBlockBytes(blockstore, cid)
      if (await verifyBlock(cid, stored)) {
        return stored
      }
    } catch {
      // Fall through to a network fetch.
    }
  }

  const fetchOptions: FetchCarOptions = { scope: 'block' }
  if (opts.signal !== undefined) fetchOptions.signal = opts.signal
  if (opts.timeoutMs !== undefined) fetchOptions.timeoutMs = opts.timeoutMs
  if (opts.headersTimeoutMs !== undefined) fetchOptions.headersTimeoutMs = opts.headersTimeoutMs
  if (opts.gateways !== undefined) fetchOptions.gateways = opts.gateways

  const { blocks } = await fetchCar(cid, fetchOptions)
  const bytes = blocks.get(cid.toString()) ?? findByDigest(blocks, cid)

  if (bytes === undefined) {
    throw new PlainError(
      `A piece of this content (${cid.toString()}) could not be downloaded. ` +
        'It may have fallen off the IPFS network.'
    )
  }

  await putBlock(blockstore, cid, bytes)
  return bytes
}

/** Find a block by multihash, tolerating CIDv0/CIDv1 differences in the key. */
function findByDigest(blocks: Map<string, Uint8Array>, cid: CID): Uint8Array | undefined {
  const target = digestKey(cid)
  for (const [key, value] of blocks) {
    try {
      if (digestKey(CID.parse(key)) === target) {
        return value
      }
    } catch {
      continue
    }
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Plain HTTP retrieval (web2 + Arweave + last-resort gateways)
// ---------------------------------------------------------------------------

/**
 * Plain HTTPS GET with a timeout, following redirects.
 *
 * Used for `https://` and `ar://` content, which has no CID to verify against.
 * Non-2xx responses throw rather than returning, so a 404 error page can never
 * be silently archived as if it were the artwork.
 *
 * @throws A plain-English `Error` on a non-2xx status, a timeout, an
 * unreachable host, or an oversized response.
 */
export async function fetchHttpBytes(
  url: string,
  opts: HttpFetchOptions = {}
): Promise<HttpBytesResult> {
  const timeoutMs = opts.timeoutMs ?? FETCH_TIMEOUT_MS
  const headersTimeoutMs = opts.headersTimeoutMs ?? DEFAULT_HEADERS_TIMEOUT_MS
  const maxBytes = opts.maxBytes ?? MAX_RESPONSE_BYTES

  throwIfCancelled(opts.signal)
  assertWebUrl(url)

  const timer = createTimeout(timeoutMs, headersTimeoutMs, opts.signal)

  try {
    const headers: Record<string, string> = { 'user-agent': USER_AGENT }
    if (opts.accept !== undefined) {
      headers.accept = opts.accept
    }

    const response = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: timer.signal,
      headers
    })
    timer.headersReceived()

    if (!response.ok) {
      await discardBody(response)
      throw new PlainError(`${hostOf(url)} ${describeHttpStatus(response.status)}.`)
    }

    const bytes = await readBodyLimited(response, maxBytes)
    const contentType = response.headers.get('content-type')

    const result: HttpBytesResult = { bytes, status: response.status }
    if (contentType !== null && contentType !== '') {
      result.contentType = contentType
    }
    return result
  } catch (err) {
    throw translateTransportError(err, timer, opts.signal, hostOf(url))
  } finally {
    timer.cleanup()
  }
}

/**
 * Last-resort retrieval: ask ordinary (non-trustless) gateways for the bytes of
 * `cid[/path]`.
 *
 * **These bytes cannot be hash-verified against the requested CID** — a plain
 * gateway reassembles the file for us and we never see the block boundaries, so
 * re-importing the bytes may produce a different CID. Callers must record the
 * result with `cidPreserved: false` unless a later reconstruction step proves
 * the original CID can be reproduced.
 *
 * Only reach for this after {@link fetchCar} has failed on every trustless
 * gateway.
 *
 * @throws A plain-English `Error` naming every fallback gateway tried.
 */
export async function fetchIpfsBytesFallback(
  cid: CID,
  path: string,
  opts: HttpFetchOptions & { gateways?: readonly string[] } = {}
): Promise<FallbackBytesResult> {
  const gateways = opts.gateways ?? FALLBACK_GATEWAYS
  const encoded = encodeIpfsPath(path)

  throwIfCancelled(opts.signal)

  if (cid.multihash.code === MH_IDENTITY && encoded === '') {
    return { bytes: cid.multihash.digest, gateway: INLINE_SOURCE }
  }

  if (gateways.length === 0) {
    throw new PlainError(
      'No IPFS gateways are configured, so this content cannot be downloaded. ' +
        'This is a setup problem with the app rather than a problem with the content.'
    )
  }

  const failures: GatewayFailure[] = []

  for (const gateway of gateways) {
    throwIfCancelled(opts.signal)
    const url = `${trimSlash(gateway)}/ipfs/${cid.toString()}${encoded === '' ? '' : `/${encoded}`}`

    try {
      const httpOptions: HttpFetchOptions = {}
      if (opts.signal !== undefined) httpOptions.signal = opts.signal
      httpOptions.timeoutMs = opts.timeoutMs ?? FETCH_TIMEOUT_MS
      if (opts.headersTimeoutMs !== undefined) httpOptions.headersTimeoutMs = opts.headersTimeoutMs
      if (opts.maxBytes !== undefined) httpOptions.maxBytes = opts.maxBytes
      if (opts.accept !== undefined) httpOptions.accept = opts.accept

      const { bytes, contentType } = await fetchHttpBytes(url, httpOptions)

      if (bytes.byteLength === 0) {
        throw new PlainError('returned an empty file')
      }

      const result: FallbackBytesResult = { bytes, gateway }
      if (contentType !== undefined) {
        result.contentType = contentType
      }
      return result
    } catch (err) {
      if (isCancellation(err)) {
        throw err
      }
      failures.push({ gateway: hostOf(gateway), reason: stripHost(reasonText(err), hostOf(gateway)) })
    }
  }

  const label = encoded === '' ? cid.toString() : `${cid.toString()}/${encoded}`
  const count = failures.length
  throw new PlainError(
    `This content could not be downloaded from IPFS. Tried ${count} ${count === 1 ? 'gateway' : 'gateways'}; ` +
      'none of them had it. It has most likely fallen off the network. ' +
      `What each one said: ${failures.map((f) => `${f.gateway} — ${f.reason}`).join('; ')}. ` +
      `(Content ID: ${label})`
  )
}

// ---------------------------------------------------------------------------
// Error construction — everything a DAO member sees comes from here
// ---------------------------------------------------------------------------

interface GatewayFailure {
  gateway: string
  reason: string
}

/** An error whose message is already written in plain English for the user. */
class PlainError extends Error {
  override readonly name = 'ArchiverError'
}

function retrievalError(cid: CID, path: string, failures: GatewayFailure[]): Error {
  const label = path === '' ? cid.toString() : `${cid.toString()}/${path}`
  const count = failures.length
  const plural = count === 1 ? 'gateway' : 'gateways'
  const details = failures.map((f) => `${f.gateway} — ${f.reason}`).join('; ')
  const tampered = failures.some((f) => f.reason.includes('fingerprint'))

  const answered = count === 1 ? 'the one that answered' : 'the ones that answered'
  const headline = tampered
    ? `This content could not be downloaded safely. Tried ${count} ${plural}; ${answered} sent data that did not match its fingerprint, so it was refused instead of saved.`
    : `This content could not be found on IPFS. Tried ${count} ${plural}; none had it. It may have fallen off the network.`

  return new PlainError(`${headline} What each one said: ${details}. (Content ID: ${label})`)
}

function missingEntryError(name: string, here: string, available: string[]): Error {
  const shown = available.slice(0, 8).join(', ')
  const more = available.length > 8 ? `, and ${available.length - 8} more` : ''
  const listing =
    available.length === 0
      ? ' That folder is empty.'
      : ` That folder contains: ${shown}${more}.`

  return new PlainError(`There is no "${name}" in the folder at ${here}.${listing}`)
}

function describeHttpStatus(status: number): string {
  if (status === 404 || status === 410) {
    return `did not have it (${status})`
  }
  if (status === 400 || status === 422) {
    return `rejected the request as malformed (${status})`
  }
  if (status === 401 || status === 403) {
    return `refused us access (${status})`
  }
  if (status === 429) {
    return 'is limiting how often we can ask (429) — try again in a few minutes'
  }
  if (status === 408 || status === 504 || status === 524) {
    return `spent too long looking for it and gave up (${status})`
  }
  if (status >= 500) {
    return `had a problem at its end (${status})`
  }
  return `replied with an unexpected error (${status})`
}

function describeCodec(code: number): string {
  switch (code) {
    case CODEC_RAW:
      return 'raw file data'
    case CODEC_DAG_PB:
      return 'a UnixFS file or folder'
    case CODEC_DAG_CBOR:
      return 'dag-cbor data, which this app cannot open as a folder'
    case CODEC_DAG_JSON:
      return 'dag-json data, which this app cannot open as a folder'
    case CODEC_JSON:
      return 'plain JSON data'
    default:
      return `data of an unfamiliar kind (codec ${code})`
  }
}

/** Turn any thrown value into the "what the gateway said" fragment. */
function reasonText(err: unknown): string {
  if (err instanceof PlainError) {
    return err.message
  }
  return describeNetworkError(err)
}

function describeNetworkError(err: unknown): string {
  const text = causeChain(err)
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo|dns/i.test(text)) {
    return 'could not be reached — check your internet connection'
  }
  if (/ECONNREFUSED/i.test(text)) {
    return 'refused the connection'
  }
  if (/ECONNRESET|socket hang up|terminated|premature close|aborted/i.test(text)) {
    return 'dropped the connection part-way through'
  }
  if (/certificate|SSL|TLS|self.signed/i.test(text)) {
    return 'has a security certificate problem'
  }
  if (/ETIMEDOUT|timeout/i.test(text)) {
    return 'did not respond in time'
  }
  return 'could not be reached'
}

/**
 * Normalise everything that can go wrong in one HTTP exchange into either a
 * cancellation, a timeout, or a plain-English description.
 */
function translateTransportError(
  err: unknown,
  timer: Timeout,
  outerSignal: AbortSignal | undefined,
  host?: string
): Error {
  if (err instanceof PlainError) {
    return err
  }
  if (outerSignal?.aborted === true) {
    return cancelledError()
  }
  if (timer.expired === undefined && isCancellation(err)) {
    return cancelledError()
  }
  if (timer.expired !== undefined) {
    const seconds = Math.max(1, Math.round(timer.expiredAfterMs / 1000))
    // Callers that know the host prefix it themselves, so the text below is
    // deliberately subjectless: "ipfs.io — did not answer within 30 seconds".
    const description =
      timer.expired === 'headers'
        ? `did not answer within ${seconds} seconds, so we stopped waiting`
        : `started sending the content but did not finish within ${seconds} seconds, so the download was stopped`
    return new PlainError(host === undefined ? description : `${host} ${description}`)
  }
  const description = describeNetworkError(err)
  return new PlainError(host === undefined ? description : `${host} ${description}`)
}

function cancelledError(): Error {
  const err = new Error('This download was cancelled.')
  err.name = 'AbortError'
  return err
}

function isCancellation(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError'
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw cancelledError()
  }
}

/** Collect messages from an error and its `cause` chain (Node wraps fetch errors). */
function causeChain(err: unknown): string {
  const parts: string[] = []
  let current: unknown = err
  for (let depth = 0; depth < 5 && current != null; depth += 1) {
    if (current instanceof Error) {
      parts.push(current.message)
      const code = (current as { code?: unknown }).code
      if (typeof code === 'string') {
        parts.push(code)
      }
      current = (current as { cause?: unknown }).cause
    } else {
      parts.push(String(current))
      break
    }
  }
  return parts.join(' | ')
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Avoid "ipfs.io — ipfs.io did not have it" when re-wrapping an HTTP error. */
function stripHost(reason: string, host: string): string {
  const prefix = `${host} `
  return reason.startsWith(prefix) ? reason.slice(prefix.length) : reason
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

interface Timeout {
  readonly signal: AbortSignal
  /**
   * Which of *our* deadlines fired, if any. `undefined` means the request was
   * not timed out by us (it succeeded, failed for another reason, or the caller
   * cancelled it).
   */
  readonly expired: 'headers' | 'body' | undefined
  /** Budget, in ms, of whichever deadline fired. */
  readonly expiredAfterMs: number
  /** Call as soon as response headers arrive; stops the first-byte clock. */
  headersReceived(): void
  cleanup(): void
}

/**
 * Two deadlines, one signal.
 *
 * The first-byte deadline is what stops a dead CID from costing
 * `gateways.length * timeoutMs`: gateways that never answer are dropped
 * quickly. Once a gateway *is* answering, the generous total budget applies, so
 * a slow-but-alive 500 MB download is not cut off.
 */
function createTimeout(
  totalMs: number,
  headersMs: number,
  outer: AbortSignal | undefined
): Timeout {
  const controller = new AbortController()
  const firstByteMs = Math.max(1, Math.min(headersMs, totalMs))

  let expired: 'headers' | 'body' | undefined
  let expiredAfterMs = totalMs

  let headersTimer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
    expired = 'headers'
    expiredAfterMs = firstByteMs
    controller.abort()
  }, firstByteMs)

  const bodyTimer = setTimeout(() => {
    if (expired === undefined) {
      expired = 'body'
      expiredAfterMs = totalMs
    }
    controller.abort()
  }, totalMs)

  const onOuterAbort = (): void => {
    controller.abort()
  }

  if (outer !== undefined) {
    if (outer.aborted) {
      controller.abort()
    } else {
      outer.addEventListener('abort', onOuterAbort, { once: true })
    }
  }

  return {
    signal: controller.signal,
    get expired(): 'headers' | 'body' | undefined {
      return expired
    },
    get expiredAfterMs(): number {
      return expiredAfterMs
    },
    headersReceived(): void {
      if (headersTimer !== undefined) {
        clearTimeout(headersTimer)
        headersTimer = undefined
      }
    },
    cleanup(): void {
      if (headersTimer !== undefined) {
        clearTimeout(headersTimer)
      }
      clearTimeout(bodyTimer)
      outer?.removeEventListener('abort', onOuterAbort)
    }
  }
}

/**
 * Read a response body, refusing to buffer more than `maxBytes`. Protects
 * against a gateway that streams forever inside our timeout window.
 */
async function readBodyLimited(response: Response, maxBytes: number): Promise<Uint8Array> {
  const body = response.body

  if (body === null) {
    const buffer = new Uint8Array(await response.arrayBuffer())
    if (buffer.byteLength > maxBytes) {
      throw new PlainError(tooLargeMessage(maxBytes))
    }
    return buffer
  }

  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0

  for (;;) {
    const { done, value } = await reader.read()
    if (done) {
      break
    }
    if (value === undefined) {
      continue
    }
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined)
      throw new PlainError(tooLargeMessage(maxBytes))
    }
    chunks.push(value)
  }

  const first = chunks[0]
  if (chunks.length === 1 && first !== undefined) {
    return first
  }

  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

function tooLargeMessage(maxBytes: number): string {
  const gb = (maxBytes / (1024 * 1024 * 1024)).toFixed(1)
  return `sent more than ${gb} GB of data, which is larger than this app will download in one go`
}

/** Release a response we are not going to read, so the socket is freed. */
async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel()
  } catch {
    // Nothing useful to do if the body was already consumed or closed.
  }
}

function assertWebUrl(url: string): void {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new PlainError(`"${url}" is not a valid web address, so it cannot be downloaded.`)
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new PlainError(
      `Only web addresses starting with http:// or https:// can be downloaded. Got "${parsed.protocol}//".`
    )
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

function trimSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url
}

/** Stable key for a CID's multihash, so CIDv0 and CIDv1 of one block match. */
function digestKey(cid: CID): string {
  return toHex(cid.multihash.bytes)
}

function toHex(bytes: Uint8Array): string {
  let out = ''
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, '0')
  }
  return out
}

/** Split a path into non-empty segments, dropping `.` and leading/trailing slashes. */
function splitPath(path: string): string[] {
  return path
    .split('/')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0 && segment !== '.')
}

/**
 * Names to try when matching a path segment against a directory link: the
 * segment as given, plus its percent-decoded form when it looks encoded.
 */
function nameCandidates(segment: string): string[] {
  if (!PERCENT_ESCAPE.test(segment)) {
    return [segment]
  }
  try {
    const decoded = decodeURIComponent(segment)
    return decoded === segment ? [segment] : [segment, decoded]
  } catch {
    return [segment]
  }
}

/** Percent-encode a path for use in a gateway URL, without double-encoding. */
function encodeIpfsPath(path: string | undefined): string {
  if (path === undefined || path === '') {
    return ''
  }
  return splitPath(path)
    .map((segment) => (PERCENT_ESCAPE.test(segment) ? segment : encodeURIComponent(segment)))
    .join('/')
}
