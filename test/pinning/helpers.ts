/**
 * Shared plumbing for the pinning tests. No assertions live here.
 *
 * Three things the pinning code needs that nothing else in the suite does:
 *
 *   1. A **router** for `globalThis.fetch`, so a test can say "the node answers
 *      this, Pinata answers that" and then read back exactly what was sent. An
 *      unrouted URL is a loud failure rather than a silent `undefined`, because
 *      a pinning test that quietly stops making the request it is about would
 *      still pass.
 *   2. A **real loopback HTTP server**, because `importCarToKubo` deliberately
 *      uses `node:http` rather than `fetch` (a 1.8 GB upload through `fetch`
 *      lands in memory), so a `fetch` stub cannot see it at all. Nothing leaves
 *      127.0.0.1.
 *   3. A **recognisable fake token**, so "the token did not leak" is a
 *      meaningful assertion rather than a search for a string nobody ever had.
 */

import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

/* -------------------------------------------------------------------------- */
/* Fake credentials — never a real token, here or anywhere else                */
/* -------------------------------------------------------------------------- */

/**
 * The stand-in Pinata JWT. Obviously fake to a human, but long enough and
 * shaped enough to exercise the real code paths: `tokenProblem` rejects
 * anything under 20 characters, and the redaction patterns key off the three
 * dot-separated segments.
 */
export const FAKE_TOKEN = 'eyJhbGciOiJIUzI1NiJ9.FAKE.TOKEN'

/**
 * A second token-shaped string that is *not* the configured token, used to
 * prove that redaction works on shape alone — i.e. that a credential echoed
 * back by a service is stripped even when we have nothing to compare it to.
 */
export const DECOY_JWT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJERUNPWSJ9.NOT_A_REAL_SIGNATURE_0000'

/** Every substring of the token a leak could plausibly consist of. */
export function tokenFragments(token: string = FAKE_TOKEN): string[] {
  return [token, ...token.split('.').filter((part) => part.length >= 8)]
}

/**
 * Fail if any fragment of the token shows up in `text`.
 *
 * Returns the offending fragment (or `undefined`), so a caller can put it in an
 * assertion message rather than just a boolean.
 */
export function findTokenLeak(text: string, token: string = FAKE_TOKEN): string | undefined {
  for (const fragment of tokenFragments(token)) {
    if (text.includes(fragment)) return fragment
  }
  return undefined
}

/** Collect every string inside a JSON-ish value, so a leak cannot hide in a nested field. */
export function allStrings(value: unknown, into: string[] = []): string[] {
  if (typeof value === 'string') {
    into.push(value)
  } else if (Array.isArray(value)) {
    for (const entry of value) allStrings(entry, into)
  } else if (typeof value === 'object' && value !== null) {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      into.push(key)
      allStrings(entry, into)
    }
  }
  return into
}

/* -------------------------------------------------------------------------- */
/* A router for globalThis.fetch                                               */
/* -------------------------------------------------------------------------- */

/** One request the code under test made, kept so a test can inspect it. */
export interface RecordedRequest {
  readonly url: string
  readonly pathname: string
  readonly search: URLSearchParams
  readonly method: string
  readonly headers: Headers
  readonly body: unknown
  /** The request body parsed as JSON. Throws if it was not JSON. */
  json(): unknown
}

type Matcher = string | RegExp | ((request: RecordedRequest) => boolean)
type Responder = (request: RecordedRequest) => Response | Promise<Response>

function matches(matcher: Matcher, request: RecordedRequest): boolean {
  if (typeof matcher === 'string') return request.url.includes(matcher)
  if (matcher instanceof RegExp) return matcher.test(request.url)
  return matcher(request)
}

/**
 * A stand-in for the whole network.
 *
 * Routes are tried in the order they were added, so a test can register a
 * general rule and then override one URL. Anything unmatched throws with the
 * URL in the message: silence would let a test pass while the code under test
 * quietly stopped calling the endpoint the test is about.
 */
export class FetchRouter {
  readonly calls: RecordedRequest[] = []
  readonly #routes: Array<{ matcher: Matcher; respond: Responder }> = []

  /** Register a handler. Returns `this` so routes can be chained. */
  on(matcher: Matcher, respond: Responder): this {
    this.#routes.push({ matcher, respond })
    return this
  }

  /** Every request whose URL contains `fragment`, in the order they were made. */
  callsTo(fragment: string): RecordedRequest[] {
    return this.calls.filter((call) => call.url.includes(fragment))
  }

  /** How many requests were made to URLs containing `fragment`. */
  count(fragment: string): number {
    return this.callsTo(fragment).length
  }

  /** The URLs of every request made, in order. */
  urls(): string[] {
    return this.calls.map((call) => call.url)
  }

  /** Index of the first call to `fragment`, or -1. Used to assert ordering. */
  firstIndexOf(fragment: string): number {
    return this.calls.findIndex((call) => call.url.includes(fragment))
  }

  get fetch(): typeof globalThis.fetch {
    const dispatch = async (input: unknown, init?: RequestInit): Promise<Response> => {
      // Real `fetch` rejects immediately on an already-aborted signal. A stub
      // that ignored it would make every cancellation test pass for the wrong
      // reason — the run would simply never notice it had been cancelled.
      if (init?.signal?.aborted === true) {
        const aborted = new Error('This operation was aborted')
        aborted.name = 'AbortError'
        throw aborted
      }

      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : String((input as { url?: unknown } | null)?.url ?? input)

      const parsed = new URL(url)
      const body = init?.body
      const request: RecordedRequest = {
        url,
        pathname: parsed.pathname,
        search: parsed.searchParams,
        method: (init?.method ?? 'GET').toUpperCase(),
        headers: new Headers(init?.headers ?? {}),
        body,
        json: () => JSON.parse(typeof body === 'string' ? body : '') as unknown
      }
      this.calls.push(request)

      for (const route of this.#routes) {
        if (matches(route.matcher, request)) {
          return await route.respond(request)
        }
      }

      throw new Error(
        `The pinning tests made an unrouted request: ${request.method} ${url}\n` +
          'Add a route for it, or fix the code under test if it should not be calling that.'
      )
    }

    return dispatch as unknown as typeof globalThis.fetch
  }
}

/* -------------------------------------------------------------------------- */
/* Canned replies                                                              */
/* -------------------------------------------------------------------------- */

export function jsonReply(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json', ...headers }
  })
}

export function textReply(text: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(text, { status, headers: { 'content-type': 'text/plain', ...headers } })
}

/** Kubo streams several of its commands as one JSON object per line. */
export function ndjsonReply(lines: readonly unknown[], status = 200): Response {
  const text = lines.map((line) => (typeof line === 'string' ? line : JSON.stringify(line))).join('\n')
  return new Response(text === '' ? '' : text + '\n', {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

/** Kubo reports a command failure as a JSON body, whatever the HTTP status. */
export function kuboError(message: string, status = 500): Response {
  return new Response(JSON.stringify({ Message: message, Code: 0, Type: 'error' }), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

/* -------------------------------------------------------------------------- */
/* Transport failures, shaped the way undici really produces them              */
/* -------------------------------------------------------------------------- */

/**
 * What `fetch` throws when a socket fails: a bare `TypeError: fetch failed`
 * with the useful code one `cause` link down. Code that reads `err.code`
 * directly would find nothing, which is exactly the mistake worth catching.
 */
export function transportFailure(code: string, message = 'connect failed'): TypeError {
  const cause = new Error(`${message} ${code}`) as Error & { code: string }
  cause.code = code
  return new TypeError('fetch failed', { cause })
}

/**
 * The shape a host that resolves to both IPv6 and IPv4 produces — `localhost`
 * always does. The code has to search the `errors` array, not just `cause`.
 */
export function aggregateTransportFailure(code: string): TypeError {
  const first = new Error(`connect ${code} ::1:5001`) as Error & { code: string }
  first.code = code
  const second = new Error(`connect ${code} 127.0.0.1:5001`) as Error & { code: string }
  second.code = code
  const aggregate = new AggregateError([first, second], 'all connection attempts failed')
  return new TypeError('fetch failed', { cause: aggregate })
}

/* -------------------------------------------------------------------------- */
/* A real (loopback) Kubo, for the one request that bypasses fetch             */
/* -------------------------------------------------------------------------- */

export interface FakeKuboRequest {
  method: string
  pathname: string
  query: URLSearchParams
  headers: IncomingHttpHeaders
  body: Buffer
}

export interface FakeKuboReply {
  status?: number
  body?: string
  contentType?: string
}

export interface FakeKubo {
  /** `http://127.0.0.1:<port>` — pass this straight to the module under test. */
  url: string
  /** Every request the server received, in order. */
  requests: FakeKuboRequest[]
  close(): Promise<void>
}

/**
 * Start a throwaway IPFS-node-shaped HTTP server on 127.0.0.1.
 *
 * `importCarToKubo` streams its upload with `node:http`, so a `fetch` stub is
 * invisible to it; this is the only way to test that path at all. The listener
 * is bound to loopback on an ephemeral port and torn down by the caller.
 */
export async function startFakeKubo(
  respond: (request: FakeKuboRequest) => FakeKuboReply | Promise<FakeKuboReply>
): Promise<FakeKubo> {
  const requests: FakeKuboRequest[] = []

  const server: Server = createServer((incoming, outgoing) => {
    const chunks: Buffer[] = []
    incoming.on('data', (chunk: Buffer) => chunks.push(chunk))
    incoming.on('end', () => {
      const parsed = new URL(incoming.url ?? '/', 'http://127.0.0.1')
      const request: FakeKuboRequest = {
        method: incoming.method ?? 'GET',
        pathname: parsed.pathname,
        query: parsed.searchParams,
        headers: incoming.headers,
        body: Buffer.concat(chunks)
      }
      requests.push(request)

      void Promise.resolve(respond(request))
        .then((reply) => {
          const body = reply.body ?? ''
          outgoing.writeHead(reply.status ?? 200, {
            'content-type': reply.contentType ?? 'application/json',
            'content-length': String(Buffer.byteLength(body))
          })
          outgoing.end(body)
        })
        .catch(() => {
          outgoing.writeHead(500, { 'content-type': 'text/plain' })
          outgoing.end('test server failure')
        })
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo

  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
  }
}

/**
 * Pull the uploaded file back out of a `multipart/form-data` body.
 *
 * Deliberately parsed rather than trusted: the point of the assertion it feeds
 * is that the archive's bytes really arrived intact, byte for byte.
 */
export function multipartFile(body: Buffer, contentType: string | undefined): Buffer {
  const boundaryMatch = /boundary=(.+)$/.exec(contentType ?? '')
  if (boundaryMatch === null || boundaryMatch[1] === undefined) {
    throw new Error(`Not a multipart upload: content-type was "${contentType ?? '(none)'}"`)
  }

  const boundary = boundaryMatch[1].trim()
  const headerEnd = body.indexOf('\r\n\r\n')
  if (headerEnd === -1) throw new Error('Multipart body had no header section.')

  const start = headerEnd + 4
  const end = body.indexOf(`\r\n--${boundary}--`, start)
  if (end === -1) throw new Error('Multipart body had no closing boundary.')

  return body.subarray(start, end)
}

/** The `Content-Disposition` filename from a multipart body, still percent-encoded. */
export function multipartFilename(body: Buffer): string {
  const head = body.subarray(0, Math.min(body.length, 2048)).toString('utf8')
  const match = /filename="([^"]*)"/.exec(head)
  return match?.[1] ?? ''
}
