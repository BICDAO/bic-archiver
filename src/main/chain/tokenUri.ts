/**
 * Reading a token's metadata link off-chain, and making sense of whatever the
 * contract hands back.
 *
 * This module replaces four separate manual steps:
 *   - calling `tokenURI` through Etherscan's "Read as Proxy" tab,
 *   - knowing whether a collection is ERC-721 or ERC-1155,
 *   - pasting `data:application/json;base64,…` blobs into an online decoder,
 *   - and "copy only the hash, no slashes" when the link is an IPFS one.
 */

import { Buffer } from 'node:buffer'
import { CID } from 'multiformats/cid'
import {
  ARWEAVE_GATEWAYS,
  SELECTOR_TOKEN_CONTENT_HASHES,
  SELECTOR_TOKEN_METADATA_HASHES,
  SELECTOR_TOKEN_METADATA_URI,
  SELECTOR_TOKEN_URI,
  SELECTOR_URI
} from '../../shared/constants'
import type { IpfsPath, ResolvedTokenUri, TokenRef, TokenStandard } from '../../shared/types'
import { decodeAbiString, ethCall } from './rpc'

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/
const MAX_UINT256 = (1n << 256n) - 1n

/** ERC-165 `supportsInterface(bytes4)`. */
const SELECTOR_SUPPORTS_INTERFACE = '0x01ffc9a7'
/** ERC-165 interface ids. `bytes4` is padded on the *right* inside its word. */
const INTERFACE_ID_ERC721 = '80ac58cd'
const INTERFACE_ID_ERC1155 = 'd9b67a26'

/**
 * Encodes a decimal token id as a 32-byte big-endian ABI word.
 *
 * IMPORTANT for callers: the result has **no `0x` prefix** and is exactly 64
 * lowercase hex characters, so it concatenates directly onto a selector:
 *
 *     const data = SELECTOR_TOKEN_URI + encodeUint256(tokenId)
 *
 * Token ids routinely exceed `Number.MAX_SAFE_INTEGER`, which is why the input
 * is a decimal *string* and the maths is done with BigInt. A `0x…` string is
 * accepted too, as a convenience.
 */
export function encodeUint256(decimal: string): string {
  const raw = typeof decimal === 'string' ? decimal.trim() : String(decimal ?? '').trim()
  if (!raw) {
    throw new Error('No token number was given. Every NFT has a number, for example 1 or 4271.')
  }

  let value: bigint
  if (/^0x[0-9a-fA-F]+$/.test(raw)) {
    value = BigInt(raw)
  } else if (/^[0-9]+$/.test(raw)) {
    value = BigInt(raw)
  } else {
    throw new Error(
      `"${raw}" is not a valid token number. Token numbers are whole numbers like 1 or 4271.`
    )
  }

  if (value > MAX_UINT256) {
    throw new Error(`Token number "${raw}" is too large to be a real NFT number.`)
  }

  return value.toString(16).padStart(64, '0')
}

/**
 * Extracts `{cid, path}` from any way an IPFS link is written in the wild.
 *
 * Handles: `ipfs://CID/path`, `ipfs://ipfs/CID/path`, `ipfs:/CID`, `/ipfs/CID`,
 * gateway URLs like `https://ipfs.io/ipfs/CID/path` (with or without a query
 * string), subdomain gateways like `https://<cid>.ipfs.dweb.link/path`, and a
 * bare `Qm…` / `bafy…` hash. The CID is validated by actually parsing it, and
 * returned exactly as it appeared.
 *
 * Returns `null` when the string is not an IPFS link at all.
 */
export function parseIpfsUri(uri: string): IpfsPath | null {
  if (typeof uri !== 'string') return null

  // Strip whitespace, NUL padding, and stray wrapping punctuation.
  let value = uri.trim().replace(/\0+/g, '')
  value = value.replace(/^["'<\s]+/, '').replace(/[">'\s]+$/, '')
  if (!value) return null

  const lower = value.toLowerCase()
  let remainder: string | null

  if (lower.startsWith('ipfs://')) {
    remainder = value.slice('ipfs://'.length)
  } else if (lower.startsWith('dweb:/ipfs/')) {
    remainder = value.slice('dweb:/ipfs/'.length)
  } else if (lower.startsWith('ipfs:')) {
    // Covers the malformed-but-common `ipfs:/CID` and `ipfs:CID`.
    remainder = value.slice('ipfs:'.length)
  } else if (lower.startsWith('http://') || lower.startsWith('https://')) {
    remainder = ipfsPartOfHttpUrl(value)
  } else if (lower.startsWith('/ipfs/')) {
    remainder = value.slice('/ipfs/'.length)
  } else if (lower.startsWith('ipfs/')) {
    remainder = value.slice('ipfs/'.length)
  } else {
    // Possibly a bare hash, with or without a trailing path.
    remainder = value
  }

  if (remainder === null) return null
  return splitCidAndPath(remainder)
}

/**
 * Reads `tokenURI(id)` (ERC-721) and falls back to `uri(id)` (ERC-1155), then
 * works out what kind of link came back.
 *
 * Side effect worth knowing about: when a call succeeds, `ref.standard` is
 * updated in place to the standard that actually worked (`'erc721'` or
 * `'erc1155'`). `ResolvedTokenUri` has nowhere to put that fact, and callers
 * hold on to the same `TokenRef` object, so this is where it is recorded.
 */
export async function resolveTokenUri(ref: TokenRef): Promise<ResolvedTokenUri> {
  if (!ref || typeof ref.contract !== 'string' || !ADDRESS_RE.test(ref.contract.trim())) {
    throw new Error(
      `"${String(ref?.contract)}" doesn't look like a collection address. It should start with 0x and have 40 letters and numbers after it.`
    )
  }
  const contract = ref.contract.trim()

  const chainId = ref.chainId ?? 1
  if (chainId !== 1) {
    throw new Error(
      `This app can only archive tokens on the Ethereum main network, and this one is on network ${chainId}.`
    )
  }

  const tokenWord = encodeUint256(ref.tokenId)

  // ERC-1155 collections get asked their way round first; everything else is
  // tried as an ERC-721 first, because that is overwhelmingly the common case.
  const attempts: Array<{ standard: TokenStandard; selector: string; label: string }> =
    ref.standard === 'erc1155'
      ? [
          { standard: 'erc1155', selector: SELECTOR_URI, label: 'uri' },
          { standard: 'erc721', selector: SELECTOR_TOKEN_URI, label: 'tokenURI' }
        ]
      : [
          { standard: 'erc721', selector: SELECTOR_TOKEN_URI, label: 'tokenURI' },
          { standard: 'erc1155', selector: SELECTOR_URI, label: 'uri' }
        ]

  const problems: string[] = []

  for (const attempt of attempts) {
    let hex: string
    try {
      hex = await ethCall(contract, attempt.selector + tokenWord, { chainId })
    } catch (error) {
      const failure = error as { fatal?: boolean; reverted?: boolean; revertReason?: string } | null
      // Only a refusal by the contract itself is worth answering by asking a
      // different function. A dead network, a bad address or endpoints that
      // won't serve us would fail identically the second time, so those go
      // straight back to the caller instead of costing another set of
      // timeouts.
      if (failure?.fatal === true || failure?.reverted !== true) throw error
      problems.push(
        failure.revertReason
          ? `"${attempt.label}" was refused by the contract ("${failure.revertReason}")`
          : `the contract has no working "${attempt.label}" function`
      )
      continue
    }

    let raw: string
    try {
      raw = decodeAbiString(hex)
    } catch {
      problems.push(`the answer from "${attempt.label}" was not a readable link`)
      continue
    }

    const trimmed = raw.trim()
    if (!trimmed) {
      problems.push(`"${attempt.label}" gave back an empty link`)
      continue
    }

    // Record which standard actually answered, for the rest of the app.
    ref.standard = attempt.standard

    return classifyUri(raw, substituteIdPlaceholder(trimmed, tokenWord))
  }

  throw new Error(
    `We reached Ethereum, but the collection at ${contract} wouldn't give us a link to token ${ref.tokenId}'s information. Most often this means that token number isn't part of this collection, or the address isn't an NFT collection at all. (What we tried: ${problems.join('; and ')}.)`
  )
}

/** What a contract that keeps a token's metadata apart from its artwork says. */
export interface TokenMetadataLink {
  /** What `tokenMetadataURI(id)` returned, classified the same way as a token URI. */
  metadataUri: ResolvedTokenUri
  /** The artwork's SHA-256 as recorded at mint, lowercase hex without `0x`. */
  contentSha256?: string
  /** The metadata file's SHA-256 as recorded at mint, lowercase hex without `0x`. */
  metadataSha256?: string
}

/**
 * Asks the contract for a separate metadata link: `tokenMetadataURI(id)`.
 *
 * Zora's original (v1) Media contract stores two links per token. Its
 * `tokenURI` is the artwork file itself, and the metadata (name,
 * description, mimeType) sits at `tokenMetadataURI`. It also records the
 * SHA-256 of both files when the token is minted, readable from
 * `tokenContentHashes(id)` and `tokenMetadataHashes(id)`; those are read too
 * when the contract has them.
 *
 * Best effort, and never throws. Almost every contract refuses this call, and
 * `undefined` then means "carry on as before": `tokenURI` is the metadata. The
 * same goes for an empty answer, an unreadable one, or a link of a kind this
 * app can't open.
 */
export async function resolveTokenMetadataUri(ref: TokenRef): Promise<TokenMetadataLink | undefined> {
  if (!ref || typeof ref.contract !== 'string' || !ADDRESS_RE.test(ref.contract.trim())) {
    return undefined
  }
  const chainId = ref.chainId ?? 1
  if (chainId !== 1) return undefined
  const contract = ref.contract.trim()

  let tokenWord: string
  try {
    tokenWord = encodeUint256(ref.tokenId)
  } catch {
    return undefined
  }

  let raw: string
  try {
    raw = decodeAbiString(await ethCall(contract, SELECTOR_TOKEN_METADATA_URI + tokenWord, { chainId }))
  } catch {
    return undefined
  }

  const trimmed = raw.trim()
  if (!trimmed) return undefined

  let metadataUri: ResolvedTokenUri
  try {
    metadataUri = classifyUri(raw, trimmed)
  } catch {
    return undefined
  }

  const link: TokenMetadataLink = { metadataUri }

  const contentSha256 = await readSha256(contract, SELECTOR_TOKEN_CONTENT_HASHES + tokenWord, chainId)
  if (contentSha256 !== undefined) link.contentSha256 = contentSha256

  const metadataSha256 = await readSha256(contract, SELECTOR_TOKEN_METADATA_HASHES + tokenWord, chainId)
  if (metadataSha256 !== undefined) link.metadataSha256 = metadataSha256

  return link
}

/**
 * Best-effort ERC-165 probe. Never throws: a contract that doesn't implement
 * ERC-165 (or an endpoint that won't answer) simply yields `'unknown'`, and
 * {@link resolveTokenUri} will work it out by trying both functions anyway.
 */
export async function detectStandard(contract: string): Promise<TokenStandard> {
  const checks: Array<{ interfaceId: string; standard: TokenStandard }> = [
    { interfaceId: INTERFACE_ID_ERC721, standard: 'erc721' },
    { interfaceId: INTERFACE_ID_ERC1155, standard: 'erc1155' }
  ]

  for (const check of checks) {
    try {
      // bytes4 arguments are left-aligned in their 32-byte word.
      const data = `${SELECTOR_SUPPORTS_INTERFACE}${check.interfaceId}${'0'.repeat(56)}`
      const hex = await ethCall(contract, data)
      if (decodeAbiBool(hex)) return check.standard
    } catch {
      // Best effort only — fall through to the next interface, then 'unknown'.
    }
  }

  return 'unknown'
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * ERC-1155 allows a single `uri` for the whole collection containing the
 * literal `{id}`, which clients must replace with the lowercase, zero-padded
 * 64-character hex token id.
 */
function substituteIdPlaceholder(uri: string, tokenWord: string): string {
  return uri.replace(/\{id\}/gi, tokenWord)
}

/** Turns the contract's answer into a `ResolvedTokenUri`. */
function classifyUri(raw: string, uri: string): ResolvedTokenUri {
  const value = uri.trim()
  const lower = value.toLowerCase()

  if (lower.startsWith('data:')) {
    return decodeDataUri(raw, value)
  }

  if (lower.startsWith('ar://')) {
    const id = value.slice('ar://'.length).replace(/^\/+/, '')
    if (!id) {
      throw new Error('The contract points at Arweave but didn\'t say which file.')
    }
    return {
      raw,
      kind: 'arweave',
      normalizedUrl: `${ARWEAVE_GATEWAYS[0]}/${id}`,
      onchain: false
    }
  }

  // Deliberately before the plain-http branch: a gateway URL such as
  // https://ipfs.io/ipfs/Qm… is IPFS content that happens to be reachable over
  // http, and archiving it as IPFS is what preserves the original hash.
  const ipfsPath = parseIpfsUri(value)
  if (ipfsPath) {
    return { raw, kind: 'ipfs', ipfsPath, onchain: false }
  }

  if (lower.startsWith('http://') || lower.startsWith('https://')) {
    return { raw, kind: 'http', normalizedUrl: value, onchain: false }
  }

  throw new Error(
    `The contract points to "${truncate(value, 120)}", which isn't a kind of link this app knows how to open. It handles ipfs://, https://, ar:// and data: links.`
  )
}

/**
 * Decodes on-chain metadata — the step the manual instructions do by pasting
 * base64 into an online tool. Supports both
 * `data:application/json;base64,<b64>` and plain/percent-encoded
 * `data:application/json,<json>`.
 *
 * If the payload isn't JSON (an on-chain SVG, say) the result still has
 * `kind: 'data'` and `onchain: true`, just without `inlineJson`.
 */
function decodeDataUri(raw: string, uri: string): ResolvedTokenUri {
  const comma = uri.indexOf(',')
  if (comma < 0) {
    throw new Error(
      "This token stores its information inside the contract itself, but the stored data is incomplete and can't be read."
    )
  }

  const mediaType = uri.slice('data:'.length, comma)
  const payload = uri.slice(comma + 1)
  const isBase64 = /(^|;)\s*base64\s*(;|$)/i.test(mediaType)

  let text: string
  if (isBase64) {
    text = Buffer.from(payload.replace(/\s+/g, ''), 'base64').toString('utf8')
  } else {
    try {
      text = decodeURIComponent(payload)
    } catch {
      // Not percent-encoded (or badly encoded) — take it literally.
      text = payload
    }
  }

  const result: ResolvedTokenUri = { raw, kind: 'data', onchain: true }

  const trimmed = text.trim()
  if (trimmed.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (isPlainObject(parsed)) result.inlineJson = parsed
    } catch {
      // Leave inlineJson undefined; the caller reports it as unreadable
      // metadata rather than failing the whole token here.
    }
  }

  return result
}

/** Pulls the `<cid>/<path>` part out of an http(s) gateway URL, or null. */
function ipfsPartOfHttpUrl(value: string): string | null {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }

  // Subdomain gateway: https://<cid>.ipfs.<host>/<path>
  const subdomain = /^([^.]+)\.ipfs\./i.exec(url.hostname)
  const label = subdomain?.[1]
  if (label && isCid(label)) {
    const path = url.pathname.replace(/^\/+/, '')
    return path ? `${label}/${path}` : label
  }

  // Path gateway: https://<host>/ipfs/<cid>/<path>
  const index = url.pathname.toLowerCase().indexOf('/ipfs/')
  if (index >= 0) return url.pathname.slice(index + '/ipfs/'.length)

  return null
}

/** Splits `CID/rest/of/path` into its parts, validating the CID. */
function splitCidAndPath(input: string): IpfsPath | null {
  let value = input.trim()

  // Drop any query string or fragment (e.g. `?filename=cat.png`).
  const marker = value.search(/[?#]/)
  if (marker >= 0) value = value.slice(0, marker)

  value = value.replace(/^\/+/, '')
  if (!value) return null

  const parts = value.split('/')
  let index = 0
  while (index < parts.length && parts[index] === '') index++

  let candidate = parts[index]
  if (candidate === undefined) return null

  // `ipfs://ipfs/CID/...` — a duplicated namespace seen in older contracts.
  if (candidate.toLowerCase() === 'ipfs') {
    index++
    candidate = parts[index]
    if (candidate === undefined) return null
  }

  if (!isCid(candidate)) return null

  const path = parts
    .slice(index + 1)
    .join('/')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')

  return { cid: candidate, path }
}

/** True when the string really parses as a CID (v0 base58 or v1 multibase). */
function isCid(value: string): boolean {
  if (!value || value.length < 46 || value.includes('.')) return false
  try {
    CID.parse(value)
    return true
  } catch {
    return false
  }
}

/** Decodes a single ABI-encoded `bool`. */
function decodeAbiBool(hex: string): boolean {
  let body = hex.trim()
  if (body.startsWith('0x') || body.startsWith('0X')) body = body.slice(2)
  if (body.length < 64) return false
  try {
    return BigInt(`0x${body.slice(0, 64)}`) !== 0n
  } catch {
    return false
  }
}

/**
 * Reads one `bytes32` holding a SHA-256, as lowercase hex without `0x`.
 *
 * `undefined` when the call fails, the answer is too short to be a `bytes32`,
 * or the value is all zeros, which is what an unset mapping entry returns.
 */
async function readSha256(contract: string, data: string, chainId: number): Promise<string | undefined> {
  let hex: string
  try {
    hex = await ethCall(contract, data, { chainId })
  } catch {
    return undefined
  }

  let body = hex.trim()
  if (body.startsWith('0x') || body.startsWith('0X')) body = body.slice(2)
  if (body.length < 64 || !/^[0-9a-fA-F]+$/.test(body)) return undefined

  const word = body.slice(0, 64).toLowerCase()
  return /^0+$/.test(word) ? undefined : word
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value
}
