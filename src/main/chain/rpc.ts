/**
 * A tiny, dependency-free Ethereum JSON-RPC client.
 *
 * The manual archiving process asks a DAO member to open Etherscan, find the
 * "Read as Proxy" tab and call `tokenURI` by hand. `eth_call` does the same job
 * automatically and sees straight through proxy contracts, so none of that is
 * needed here.
 *
 * Two rules govern everything in this file:
 *   1. Every request has a hard timeout. Nothing is ever retried forever.
 *   2. Every thrown message is written for a non-technical reader.
 */

import { ETH_RPCS, FETCH_TIMEOUT_MS } from '../../shared/constants'

/** 0x followed by exactly 40 hex characters. */
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/
/** 0x followed by any number of hex characters (including none). */
const HEX_RE = /^0x[0-9a-fA-F]*$/

/**
 * Error thrown by {@link ethCall}. Not exported — callers in this package
 * duck-type the two extra fields:
 *
 *   reachable    — true when at least one Ethereum service answered us. False
 *                  means the problem is the network/inputs, not the contract.
 *   fatal        — true when making a different contract call would fail
 *                  exactly the same way (bad address, unsupported network,
 *                  nothing reachable). Callers use it to bail out instead of
 *                  burning another full timeout on a doomed fallback.
 *   reverted     — the chain gave a definitive "no": the function doesn't
 *                  exist, or it rejected these arguments. Trying a *different*
 *                  function is worthwhile; trying the same one is not.
 *   revertReason — the contract's own words, when it supplied any.
 */
class EthCallError extends Error {
  readonly reachable: boolean
  readonly fatal: boolean
  readonly reverted: boolean
  readonly revertReason?: string

  constructor(
    message: string,
    options: { reachable: boolean; fatal: boolean; reverted?: boolean; revertReason?: string }
  ) {
    super(message)
    this.name = 'EthCallError'
    this.reachable = options.reachable
    this.fatal = options.fatal
    this.reverted = options.reverted ?? false
    if (options.revertReason) this.revertReason = options.revertReason
  }
}

/** Monotonic JSON-RPC request id. Some endpoints echo it back; none require it. */
let requestId = 0

/** One endpoint's failure, phrased for a human. */
interface EndpointFailure {
  url: string
  reason: string
  /** The endpoint answered us — it just didn't answer usefully. */
  answered: boolean
}

/**
 * Performs an `eth_call` against Ethereum mainnet.
 *
 * Each URL in {@link ETH_RPCS} is tried in order until one returns a usable
 * hex result. A JSON-RPC `error` member counts as that endpoint failing, so we
 * fall through to the next one; if every endpoint fails, a plain-English Error
 * is thrown that says which kind of failure it was.
 *
 * @param to   Contract address, `0x` + 40 hex characters.
 * @param data ABI-encoded calldata, `0x` + selector + arguments.
 * @returns The raw hex result, e.g. `0x0000…`. May be exactly `"0x"` when the
 *          call succeeded but the contract returned nothing.
 */
export async function ethCall(
  to: string,
  data: string,
  opts?: { chainId?: number }
): Promise<string> {
  if (typeof to !== 'string' || !ADDRESS_RE.test(to.trim())) {
    throw new EthCallError(
      `"${String(to)}" doesn't look like an Ethereum contract address. An address starts with 0x and has 40 letters and numbers after it.`,
      { reachable: false, fatal: true }
    )
  }
  if (typeof data !== 'string' || !HEX_RE.test(data.trim())) {
    throw new EthCallError(
      'The app built an invalid request for the contract. This is a bug in the app, not something you did wrong.',
      { reachable: false, fatal: true }
    )
  }

  const chainId = opts?.chainId ?? 1
  if (chainId !== 1) {
    throw new EthCallError(
      `This app can only read contracts on the Ethereum main network, but this token is on network ${chainId}.`,
      { reachable: false, fatal: true }
    )
  }

  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: ++requestId,
    method: 'eth_call',
    params: [{ to: to.trim(), data: data.trim() }, 'latest']
  })

  const failures: EndpointFailure[] = []

  for (const url of ETH_RPCS) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json'
        },
        body,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
      })

      if (!response.ok) {
        failures.push({
          url,
          reason:
            response.status === 429
              ? 'is busy and asked us to slow down'
              : `replied with an error (code ${response.status})`,
          answered: true
        })
        continue
      }

      const text = await response.text()
      let payload: unknown
      try {
        payload = JSON.parse(text)
      } catch {
        failures.push({ url, reason: 'sent back something we could not read', answered: true })
        continue
      }

      const envelope = payload as {
        result?: unknown
        error?: { code?: unknown; message?: unknown }
      }

      if (envelope && envelope.error) {
        const detail =
          typeof envelope.error.message === 'string' && envelope.error.message.trim()
            ? envelope.error.message.trim()
            : 'no reason given'

        // A revert is the chain's final answer, not one endpoint having a bad
        // day. Stop here rather than asking three more services the same
        // question and getting the same "no" three more times.
        if (isRevert(envelope.error.code, detail)) {
          const reason = cleanRevertReason(detail)
          throw new EthCallError(
            reason
              ? `The contract at ${to.trim()} turned down this request and said: "${reason}".`
              : `The contract at ${to.trim()} turned down this request. That function may not exist on it.`,
            { reachable: true, fatal: false, reverted: true, ...(reason ? { revertReason: reason } : {}) }
          )
        }

        failures.push({ url, reason: `refused the request (${detail})`, answered: true })
        continue
      }

      const result = envelope?.result
      if (typeof result !== 'string' || !HEX_RE.test(result.trim())) {
        failures.push({ url, reason: 'sent back an answer in an unexpected format', answered: true })
        continue
      }

      return result.trim()
    } catch (error) {
      // A revert thrown above is a conclusion, not a transport failure.
      if (error instanceof EthCallError) throw error
      failures.push({ url, reason: describeNetworkError(error), answered: false })
    }
  }

  const anyAnswered = failures.some((failure) => failure.answered)
  const details = failures
    .slice(0, 2)
    .map((failure) => `${hostOf(failure.url)} ${failure.reason}`)
    .join('; ')

  if (!anyAnswered) {
    throw new EthCallError(
      `We couldn't reach the Ethereum network. The app tried ${failures.length} public Ethereum services and none of them answered. Please check your internet connection and try again. (Details: ${details}.)`,
      { reachable: false, fatal: true }
    )
  }

  throw new EthCallError(
    `None of the ${failures.length} public Ethereum services would answer our question about the contract at ${to.trim()}. They may be busy right now — please wait a minute and try again. (Details: ${details}.)`,
    { reachable: true, fatal: false }
  )
}

/**
 * Decodes a single ABI-encoded dynamic `string` return value.
 *
 * Layout: word 0 is the byte offset of the string, the word at that offset is
 * the byte length, then that many UTF-8 bytes followed by zero padding up to
 * the next 32-byte boundary.
 *
 * An empty return (`""` or `"0x"`) decodes to `""` — that is what a contract
 * gives you when the function exists but has nothing to say. Anything that
 * claims to be a string but cannot be one throws.
 */
export function decodeAbiString(hex: string): string {
  if (typeof hex !== 'string') {
    throw new Error('The contract returned nothing we could read.')
  }

  let body = hex.trim()
  if (body.startsWith('0x') || body.startsWith('0X')) body = body.slice(2)
  if (body.length === 0) return ''

  if (!/^[0-9a-fA-F]+$/.test(body) || body.length % 2 !== 0) {
    throw new Error(
      "The contract's reply was not valid data. The link to this token's information could not be read."
    )
  }

  const bytes = hexToBytes(body)
  if (bytes.length === 0) return ''
  if (bytes.length < 64) {
    throw new Error(
      "The contract's reply was too short to contain a link to this token's information."
    )
  }

  const offsetWord = readWord(bytes, 0)
  // A sane offset is tiny (almost always 32). Guard before touching Number().
  if (offsetWord > 0xffffffffn || Number(offsetWord) + 32 > bytes.length) {
    throw new Error(
      "The contract's reply was formatted in a way this app doesn't understand, so the link to this token's information could not be read."
    )
  }
  const offset = Number(offsetWord)

  const lengthWord = readWord(bytes, offset)
  const available = bytes.length - offset - 32
  if (lengthWord > BigInt(available)) {
    throw new Error(
      "The contract's reply was cut short, so the link to this token's information could not be read."
    )
  }
  const length = Number(lengthWord)
  if (length === 0) return ''

  const start = offset + 32
  const text = new TextDecoder('utf-8').decode(bytes.subarray(start, start + length))
  // Some contracts pad the declared length with NUL bytes; strip them.
  return text.replace(/\0+$/, '')
}

/** Reads a 32-byte big-endian word starting at `at`. */
function readWord(bytes: Uint8Array, at: number): bigint {
  let value = 0n
  for (let i = at; i < at + 32; i++) {
    value = (value << 8n) | BigInt(bytes[i] ?? 0)
  }
  return value
}

/** Converts an even-length hex string (no 0x prefix) to bytes. */
function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

/** Turns a fetch/abort failure into something a non-technical member can read. */
function describeNetworkError(error: unknown): string {
  const name = (error as { name?: unknown } | null)?.name
  if (name === 'TimeoutError') {
    return `did not answer within ${Math.round(FETCH_TIMEOUT_MS / 1000)} seconds`
  }
  if (name === 'AbortError') return 'was interrupted before it answered'
  const message = (error as { message?: unknown } | null)?.message
  if (typeof message === 'string' && message.trim()) {
    return `could not be reached (${message.trim()})`
  }
  return 'could not be reached'
}

/**
 * Was this JSON-RPC error the chain saying "no", as opposed to an endpoint
 * having a problem? Standard code 3 is "execution reverted"; the message text
 * catches the endpoints that use their own codes.
 */
function isRevert(code: unknown, message: string): boolean {
  if (code === 3) return true
  return /revert|invalid opcode|out of gas|stack underflow/i.test(message)
}

/** Strips the boilerplate so only the contract's own words remain. */
function cleanRevertReason(message: string): string {
  const reason = message
    .replace(/^\s*(execution\s+)?reverted:?\s*/i, '')
    .replace(/^\s*err:\s*/i, '')
    .trim()
  if (!reason || /^execution reverted$/i.test(reason) || /^reverted$/i.test(reason)) return ''
  return reason.length > 160 ? `${reason.slice(0, 160)}…` : reason
}

/** Hostname only, so error details stay short and readable. */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}
