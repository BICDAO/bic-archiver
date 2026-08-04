/**
 * `bic-media://` — how an archived picture reaches the window.
 *
 * The renderer has no filesystem, no Node and no network. Base64ing every
 * thumbnail through IPC would mean pushing tens of megabytes across the bridge
 * to draw one screen of a gallery, and holding it all in two processes at once.
 * So the main process answers a scheme of its own instead, straight out of the
 * archive's blockstore, and the renderer just writes:
 *
 *   <img src="bic-media://cid/bafkrei…">
 *   <video src="bic-media://cid/bafybei…" controls>
 *
 * Two rules make that safe:
 *
 *  1. **The only thing this handler will ever read is a content address.** The
 *     path after `//cid/` is parsed with the `CID` class and rejected outright
 *     if it is anything else. There is no file path, no `..`, no directory
 *     traversal and no way to talk it into opening something outside the
 *     blockstore — a CID either names a block we already hold or it names
 *     nothing at all.
 *  2. **It never throws.** A protocol handler that rejects tears a hole in the
 *     page for a member who cannot read a stack trace. Every failure comes back
 *     as a status code and a sentence of plain English: 400 for an address that
 *     is not an address, 404 for content we do not have, 503 while no archive is
 *     open, 500 if something genuinely unexpected happens.
 *
 * Range requests are supported so `<video>` can seek — Chromium's media stack
 * asks for byte ranges and will not scrub without them — and responses are
 * cached hard, because a CID is a hash: the bytes behind it can never change.
 *
 * Electron 43's `protocol.handle` takes a `Request` and returns a `Response`.
 * The old callback-style `registerBufferProtocol` API is deprecated and not used
 * here.
 */

import { app, protocol } from 'electron'
import { CID } from 'multiformats/cid'

import { MEDIA_SCHEME } from '../../shared/community.js'
import type { ArchiveStore } from '../archive/store.js'
import { readMediaBytes } from './gallery.js'

/* -------------------------------------------------------------------------- */
/* tunables                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Most bytes one buffered response may hold.
 *
 * Every image in the DAO's archive is orders of magnitude below this; it exists
 * so that a single request for a feature-length video cannot pull the whole
 * thing into memory. Larger files are streamed instead, a window at a time.
 */
const MAX_BUFFERED_BYTES = 64 * 1024 * 1024

/** How much is read at once when streaming something bigger than the ceiling. */
const STREAM_WINDOW_BYTES = 4 * 1024 * 1024

/**
 * Media types we will name in a response.
 *
 * Anything else is served as `application/octet-stream`: an archive can contain
 * any bytes at all, including HTML somebody once used as an `animation_url`, and
 * this app has no reason to hand the window something it might treat as a
 * document. Combined with `nosniff` and the restrictive CSP below, a hostile
 * file in a backup stays an inert lump of bytes.
 */
const SERVABLE_TYPES = /^(?:image|video|audio|model)\/[a-z0-9.+-]+$/i
const ALSO_SERVABLE: ReadonlySet<string> = new Set([
  'application/pdf',
  'application/json',
  'application/xml',
  'text/plain'
])

/**
 * A CID is a hash of the content, so the answer can never change. Caching for a
 * year makes scrolling a gallery of a few hundred NFTs instant on the second
 * pass.
 */
const CACHE_CONTROL = 'public, max-age=31536000, immutable'

/**
 * Belt and braces for content we did not write. Nothing served here should ever
 * be able to run a script, even if a member navigates straight to it: an SVG
 * out of an NFT is somebody else's code.
 */
const RESOURCE_CSP = "default-src 'none'; style-src 'unsafe-inline'; sandbox"

/* -------------------------------------------------------------------------- */
/* registration                                                                */
/* -------------------------------------------------------------------------- */

let schemeRegistered = false
let handlerInstalled = false

/** The archive the handler should read from, replaced on every install call. */
let resolveStore: () => ArchiveStore | null = () => null

/**
 * Declare the scheme, **before** `app.whenReady()`.
 *
 * `standard` gives it real URL parsing (so `bic-media://cid/<cid>` splits into a
 * host and a path rather than an opaque blob), `secure` keeps it out of Chromium's
 * mixed-content and insecure-origin rules, `stream` lets `<video>` request byte
 * ranges, and `supportFetchAPI` lets the renderer `fetch()` a file when it wants
 * the bytes rather than an element. CORS stays off: nothing outside this app has
 * any business reading the archive.
 *
 * Safe to call twice; the second call does nothing.
 */
export function registerMediaScheme(): void {
  if (schemeRegistered) return

  if (app.isReady()) {
    // Electron only reads this list while the app is starting up. Registering
    // now would silently do nothing, so say so in the log rather than leaving
    // somebody to wonder why every image is broken.
    console.error(
      `[bic-archiver] ${MEDIA_SCHEME}:// was registered after the app was ready; archived images will ` +
        'not display. Call registerMediaScheme() before app.whenReady().'
    )
    return
  }

  protocol.registerSchemesAsPrivileged([
    {
      scheme: MEDIA_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        corsEnabled: false
      }
    }
  ])

  schemeRegistered = true
}

/**
 * Install the handler. Call after the app is ready (it waits by itself if not).
 *
 * `getStore` is asked on every request rather than captured once, so closing one
 * archive and opening another needs no re-registration — and a request that
 * arrives while nothing is open is answered honestly instead of reading from a
 * store that has been closed underneath us.
 *
 * Safe to call twice: the second call swaps in the new `getStore` and leaves the
 * single registered handler in place.
 */
export function installMediaProtocol(getStore: () => ArchiveStore | null): void {
  resolveStore = typeof getStore === 'function' ? getStore : (): null => null

  if (handlerInstalled) return
  handlerInstalled = true

  const install = (): void => {
    try {
      protocol.handle(MEDIA_SCHEME, handleMediaRequest)
    } catch (err) {
      handlerInstalled = false
      console.error(`[bic-archiver] could not install the ${MEDIA_SCHEME}:// handler:`, err)
    }
  }

  if (app.isReady()) {
    install()
  } else {
    void app.whenReady().then(install)
  }
}

/* -------------------------------------------------------------------------- */
/* the handler                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Answer one `bic-media://cid/<cid>` request.
 *
 * Exported for tests. Never throws: every path ends in a `Response`.
 */
export async function handleMediaRequest(request: Request): Promise<Response> {
  try {
    const method = (request.method ?? 'GET').toUpperCase()
    if (method !== 'GET' && method !== 'HEAD') {
      return message(405, 'Archived files can only be read, not changed.', { Allow: 'GET, HEAD' })
    }

    const cid = cidFromUrl(request.url)
    if (cid === null) {
      return message(
        400,
        'That is not an address of anything in the archive, so there is nothing to show.'
      )
    }

    const store = resolveStore()
    if (store === null) {
      return message(503, 'No archive is open yet, so there is nothing to show.')
    }

    // A zero-length read is a cheap "what is this, and how big?" — it costs the
    // first block of the file and tells us everything the headers need.
    const probe = await readMediaBytes(store, cid, { offset: 0, length: 0 })
    if (probe === null) {
      return message(
        404,
        'This file is not stored on this computer. It may not have been downloaded yet, or the archive ' +
          'folder may have been moved.'
      )
    }

    const total = probe.totalBytes
    const contentType = safeContentType(probe.contentType)
    const range = parseRange(request.headers.get('range'), total)

    if (range === 'unsatisfiable') {
      return message(416, 'The part of this file that was asked for is past the end of it.', {
        'Content-Range': `bytes */${String(total)}`,
        'Accept-Ranges': 'bytes'
      })
    }

    if (range !== null) {
      // Never promise more in one response than we are willing to hold.
      const end = Math.min(range.end, range.start + MAX_BUFFERED_BYTES - 1)
      const length = end - range.start + 1

      const headers = baseHeaders(contentType, length)
      headers['Content-Range'] = `bytes ${String(range.start)}-${String(end)}/${String(total)}`

      if (method === 'HEAD') return new Response(null, { status: 206, headers })

      const slice = await readMediaBytes(store, cid, {
        offset: range.start,
        length,
        maxBytes: MAX_BUFFERED_BYTES
      })
      if (slice === null) return message(404, 'This file could not be read from the archive.')

      return new Response(slice.bytes, { status: 206, headers })
    }

    const headers = baseHeaders(contentType, total)

    if (method === 'HEAD') return new Response(null, { status: 200, headers })

    if (total > MAX_BUFFERED_BYTES) {
      // Big enough that buffering it would be reckless — hand it over a window
      // at a time instead. `<video>` normally asks for ranges and never reaches
      // this path; a direct fetch of a large file does.
      return new Response(mediaStream(store, cid, 0, total - 1), { status: 200, headers })
    }

    const whole = await readMediaBytes(store, cid, { maxBytes: MAX_BUFFERED_BYTES })
    if (whole === null) return message(404, 'This file could not be read from the archive.')

    headers['Content-Length'] = String(whole.bytes.byteLength)
    return new Response(whole.bytes, { status: 200, headers })
  } catch (err) {
    // Nothing above is expected to throw; if it does, the window gets a broken
    // image rather than an unhandled rejection in the main process.
    console.error(`[bic-archiver] ${MEDIA_SCHEME}:// request failed:`, err)
    return message(500, 'Something went wrong while reading this file from the archive.')
  }
}

/* -------------------------------------------------------------------------- */
/* parsing the request                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Pull the content address out of `bic-media://cid/<cid>`.
 *
 * Everything is checked: the scheme, the `cid` host, that exactly one path
 * segment follows it, and — the part that matters — that the segment really
 * parses as a CID. Anything else returns `null` and is answered with a 400.
 * Validation deliberately happens here rather than in the reader, so there is
 * one place to look when asking "can this handler be talked into opening
 * something else?". The answer is no: it has no concept of a path.
 */
export function cidFromUrl(url: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }

  if (parsed.protocol !== `${MEDIA_SCHEME}:`) return null
  if (parsed.hostname.toLowerCase() !== 'cid') return null

  const segments = parsed.pathname.split('/').filter((segment) => segment !== '')
  if (segments.length !== 1) return null

  const first = segments[0]
  if (first === undefined) return null

  let text: string
  try {
    text = decodeURIComponent(first).trim()
  } catch {
    return null
  }

  if (text === '' || text.length > 256) return null

  // The one check that makes this handler safe: it is a content address, or it
  // is nothing. `CID.parse` accepts only a real multibase-encoded multihash, so
  // no path, no traversal and no filename can survive this line.
  try {
    return CID.parse(text).toString()
  } catch {
    return null
  }
}

/** A single byte range the client asked for, already clamped to the file. */
interface ByteRange {
  start: number
  end: number
}

/**
 * Understand a `Range: bytes=…` header.
 *
 * Returns `null` when there is no usable range — including a malformed one,
 * which RFC 9110 says to ignore rather than fail — `'unsatisfiable'` when the
 * range starts past the end of the file, and otherwise the clamped range.
 * Multi-range requests are ignored (answered with the whole file), which is
 * allowed and avoids building multipart responses no media element asks for.
 */
export function parseRange(header: string | null, total: number): ByteRange | 'unsatisfiable' | null {
  if (header === null) return null

  const text = header.trim()
  if (!/^bytes\s*=/i.test(text)) return null

  const spec = text.slice(text.indexOf('=') + 1).trim()
  if (spec === '' || spec.includes(',')) return null

  const match = /^(\d*)-(\d*)$/.exec(spec)
  if (match === null) return null

  const startText = match[1] ?? ''
  const endText = match[2] ?? ''

  const size = Number.isFinite(total) && total > 0 ? Math.floor(total) : 0

  if (startText === '') {
    // `bytes=-500`: the last 500 bytes.
    if (endText === '') return null
    const wanted = Number(endText)
    if (!Number.isFinite(wanted) || wanted <= 0) return 'unsatisfiable'
    if (size === 0) return 'unsatisfiable'
    return { start: Math.max(0, size - Math.floor(wanted)), end: size - 1 }
  }

  const start = Number(startText)
  if (!Number.isFinite(start) || start < 0) return null
  if (size === 0 || start >= size) return 'unsatisfiable'

  if (endText === '') return { start: Math.floor(start), end: size - 1 }

  const end = Number(endText)
  if (!Number.isFinite(end) || end < start) return 'unsatisfiable'

  return { start: Math.floor(start), end: Math.min(Math.floor(end), size - 1) }
}

/* -------------------------------------------------------------------------- */
/* building the response                                                       */
/* -------------------------------------------------------------------------- */

function baseHeaders(contentType: string, length: number): Record<string, string> {
  return {
    'Content-Type': contentType,
    'Content-Length': String(Math.max(0, Math.floor(length))),
    'Accept-Ranges': 'bytes',
    'Cache-Control': CACHE_CONTROL,
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': RESOURCE_CSP
  }
}

/** Only name a type we are happy for the window to act on. */
function safeContentType(contentType: string): string {
  const base = contentType.split(';')[0]?.trim().toLowerCase() ?? ''
  if (base === '') return 'application/octet-stream'
  if (SERVABLE_TYPES.test(base)) return base
  if (ALSO_SERVABLE.has(base)) return base
  return 'application/octet-stream'
}

/** A plain-English answer a member could read, if anything ever showed it to them. */
function message(status: number, text: string, extra?: Record<string, string>): Response {
  return new Response(text, {
    status,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': RESOURCE_CSP,
      ...extra
    }
  })
}

/**
 * Stream a file that is too big to buffer, one window at a time.
 *
 * Only reached when something asks for a very large file without a Range
 * header. Memory stays bounded by {@link STREAM_WINDOW_BYTES} however long the
 * file is, and a short read part-way through is treated as the error it is
 * rather than as a quiet end-of-file — a truncated video that pretends to be
 * complete is exactly the kind of silent damage this app exists to prevent.
 */
function mediaStream(
  store: ArchiveStore,
  cid: string,
  start: number,
  end: number
): ReadableStream<Uint8Array> {
  let cursor = start

  return new ReadableStream<Uint8Array>({
    async pull(controller): Promise<void> {
      if (cursor > end) {
        controller.close()
        return
      }

      const span = Math.min(STREAM_WINDOW_BYTES, end - cursor + 1)

      let slice: Awaited<ReturnType<typeof readMediaBytes>>
      try {
        slice = await readMediaBytes(store, cid, { offset: cursor, length: span, maxBytes: span })
      } catch {
        slice = null
      }

      if (slice === null || slice.bytes.byteLength === 0) {
        controller.error(
          new Error('This file could not be read all the way through from the archive on this computer.')
        )
        return
      }

      controller.enqueue(slice.bytes)
      cursor += slice.bytes.byteLength

      if (cursor > end) controller.close()
    }
  })
}
