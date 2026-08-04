/**
 * Shared plumbing for the managed-node and drift tests. No assertions live here.
 *
 * Everything in `test/node/` and `test/drift/` runs with the network cable
 * unplugged (`test/setup/no-network.ts` takes `fetch` away), so these are the
 * three things those suites need in order to exercise real network-shaped code:
 *
 *   1. A **router** for `globalThis.fetch`, recording every call — URL, method,
 *      headers and, crucially, the `redirect` mode. A drift test that claims
 *      "the 504 from listing 20,808 entries is never triggered" is only worth
 *      anything if it can prove the request was made with `redirect: 'manual'`.
 *      An unrouted URL fails the way the real thing fails (a rejected promise
 *      carrying an errno), never a silent `undefined`.
 *   2. A **tar.gz builder**, because the only honest way to test "a download
 *      whose hash does not match is never unpacked or executed" is to serve a
 *      real archive containing a real executable that leaves a trace when it
 *      runs, and then show the trace is absent.
 *   3. **Kubo RPC replies**, so a node can be made to answer, refuse, or claim
 *      to be somebody else's.
 */

import { gzipSync } from 'node:zlib'

import { vi } from 'vitest'

/* -------------------------------------------------------------------------- */
/* the fetch router                                                            */
/* -------------------------------------------------------------------------- */

export interface RecordedCall {
  url: string
  method: string
  /** `manual`, `follow`, … — the thing that decides whether a 301 is chased. */
  redirect: string | undefined
  headers: Record<string, string>
}

type Handler = (call: RecordedCall) => Response | Promise<Response>

/**
 * A failure shaped like a real one.
 *
 * `fetch` rejects with a `TypeError` whose `cause` carries the errno; several
 * places in the app switch on that code to choose a message, so a stub that
 * threw a bare `Error` would exercise a branch that cannot happen in the wild.
 */
export function networkError(url: string, code = 'ECONNREFUSED'): TypeError {
  const cause = new Error(`connect ${code} ${url}`)
  ;(cause as NodeJS.ErrnoException).code = code
  const err = new TypeError('fetch failed')
  ;(err as TypeError & { cause?: unknown }).cause = cause
  return err
}

/**
 * `HeadersInit` is a DOM global; this project's node tsconfig has `lib: ES2023`
 * and gets `fetch` from @types/node, which exports the alias from a module
 * rather than declaring it globally. Borrow the shape from `Headers` itself so
 * the type stays exactly whatever the runtime accepts.
 */
type HeaderInput = NonNullable<ConstructorParameters<typeof Headers>[0]>

function headerRecord(init: HeaderInput | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (init === undefined) return out
  new Headers(init).forEach((value, key) => {
    out[key.toLowerCase()] = value
  })
  return out
}

function urlOf(input: unknown): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.toString()
  const maybe = (input as { url?: unknown } | null)?.url
  return typeof maybe === 'string' ? maybe : String(input)
}

/** Route `fetch` by URL pattern, and remember everything that was asked. */
export class FetchRouter {
  readonly calls: RecordedCall[] = []

  #routes: Array<{ match: RegExp | ((url: string) => boolean); handler: Handler }> = []
  #fallback: Handler = (call) => {
    throw new Error(
      `No route for ${call.method} ${call.url}\n` +
        'Add one with router.on(), or router.offline() if the test is about a machine ' +
        'that cannot reach anything.'
    )
  }

  /** Answer any URL matching `match`. Routes are tried in the order added. */
  on(match: RegExp | ((url: string) => boolean), handler: Handler): this {
    this.#routes.push({ match, handler })
    return this
  }

  /** Anything unrouted fails as if the machine were offline. */
  offline(code = 'ECONNREFUSED'): this {
    this.#fallback = (call) => {
      throw networkError(call.url, code)
    }
    return this
  }

  readonly fetch = async (input: unknown, init: RequestInit = {}): Promise<Response> => {
    const url = urlOf(input)
    const call: RecordedCall = {
      url,
      method: (init.method ?? 'GET').toUpperCase(),
      redirect: init.redirect,
      headers: headerRecord(init.headers)
    }
    this.calls.push(call)

    for (const route of this.#routes) {
      const hit = typeof route.match === 'function' ? route.match(url) : route.match.test(url)
      if (hit) return route.handler(call)
    }
    return this.#fallback(call)
  }

  /** Replace `globalThis.fetch`. `vi.unstubAllGlobals()` puts the guard back. */
  install(): this {
    vi.stubGlobal('fetch', this.fetch)
    return this
  }

  urls(): string[] {
    return this.calls.map((call) => call.url)
  }

  hits(pattern: RegExp): RecordedCall[] {
    return this.calls.filter((call) => pattern.test(call.url))
  }

  /** Nothing has been asked of this URL pattern at all. */
  never(pattern: RegExp): boolean {
    return this.hits(pattern).length === 0
  }
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

export function text(body: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/plain', ...headers } })
}

export function bytes(body: Uint8Array, headers: Record<string, string> = {}): Response {
  return new Response(body, {
    status: 200,
    headers: { 'content-length': String(body.byteLength), ...headers }
  })
}

/* -------------------------------------------------------------------------- */
/* a Kubo node that answers                                                    */
/* -------------------------------------------------------------------------- */

export interface FakeNode {
  peerId: string
  addresses: string[]
  version?: string
  repoSize?: number
  storageMax?: string
  /** CIDs the node claims to be keeping. */
  pinned?: readonly string[]
}

/**
 * Replies for the handful of RPCs the app makes of a node.
 *
 * Read-only by construction: there is no handler here for `config/replace`,
 * `shutdown`, `pin/rm` or `repo/gc`, so a test that asserts "nothing wrote to
 * this node" is asserting against a router that could not have answered a write
 * even if one had been attempted.
 */
export function kuboRpc(node: FakeNode): Handler {
  return (call) => {
    const path = new URL(call.url).pathname
    const params = new URL(call.url).searchParams

    if (path === '/api/v0/id') {
      return json({ ID: node.peerId, Addresses: node.addresses })
    }
    if (path === '/api/v0/version') {
      return json({ Version: node.version ?? '0.43.0' })
    }
    if (path === '/api/v0/repo/stat') {
      return json({ RepoSize: node.repoSize ?? 1_024, NumObjects: 7 })
    }
    if (path === '/api/v0/config') {
      return json({ Key: params.get('arg'), Value: node.storageMax ?? '20GiB' })
    }
    if (path === '/api/v0/pin/ls') {
      const wanted = params.get('arg') ?? ''
      const has = (node.pinned ?? []).includes(wanted)
      return json({ Keys: has ? { [wanted]: { Type: 'recursive' } } : {} })
    }
    return text(`unexpected RPC: ${path}`, 404)
  }
}

/* -------------------------------------------------------------------------- */
/* building a real .tar.gz                                                     */
/* -------------------------------------------------------------------------- */

const TAR_BLOCK = 512

function octalField(value: number, digits: number): string {
  return `${value.toString(8).padStart(digits, '0')}\0`
}

function tarHeader(name: string, size: number, mode: number): Buffer {
  const header = Buffer.alloc(TAR_BLOCK, 0)
  header.write(name, 0, 100, 'utf8')
  header.write(octalField(mode, 7), 100, 8, 'ascii')
  header.write(octalField(0, 7), 108, 8, 'ascii')
  header.write(octalField(0, 7), 116, 8, 'ascii')
  header.write(octalField(size, 11), 124, 12, 'ascii')
  header.write(octalField(Math.floor(Date.now() / 1000), 11), 136, 12, 'ascii')
  // The checksum is computed with this field full of spaces, then written over.
  header.write('        ', 148, 8, 'ascii')
  header.write('0', 156, 1, 'ascii') // regular file
  header.write('ustar\0', 257, 6, 'ascii')
  header.write('00', 263, 2, 'ascii')

  let sum = 0
  for (const byte of header) sum += byte
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii')
  return header
}

function pad(size: number): Buffer {
  const remainder = size % TAR_BLOCK
  return remainder === 0 ? Buffer.alloc(0) : Buffer.alloc(TAR_BLOCK - remainder, 0)
}

export interface TarEntry {
  /** Path inside the archive, e.g. `kubo/ipfs`. */
  name: string
  data: Buffer | string
  mode?: number
}

/** A real gzipped tar, the shape `dist.ipfs.tech` publishes. */
export function tarGz(entries: readonly TarEntry[]): Buffer {
  const parts: Buffer[] = []
  for (const entry of entries) {
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8')
    parts.push(tarHeader(entry.name, data.length, entry.mode ?? 0o644), data, pad(data.length))
  }
  // Two zero blocks close the archive.
  parts.push(Buffer.alloc(TAR_BLOCK * 2, 0))
  return gzipSync(Buffer.concat(parts))
}

/**
 * An `ipfs` stand-in that leaves a trace when it runs.
 *
 * This is what makes "nothing was executed" a real assertion rather than a
 * hopeful one: if a rejected download were ever unpacked and run, the sentinel
 * file would exist.
 */
export function sentinelScript(sentinelPath: string, version = '0.43.0'): string {
  return [
    '#!/bin/sh',
    `printf 'executed %s\\n' "$*" >> '${sentinelPath}'`,
    `echo 'ipfs version ${version}'`,
    ''
  ].join('\n')
}
