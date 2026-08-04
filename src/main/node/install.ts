/**
 * Putting a real IPFS node onto a member's computer — download, verify, unpack,
 * initialise — without them ever opening a terminal.
 *
 * This module downloads and then runs an executable, which makes it the most
 * security-sensitive code in the app. Two rules govern everything below and
 * neither of them bends:
 *
 *   1. **The bytes come from {@link KUBO_DIST} over HTTPS, and nowhere else.**
 *      The URL is built from the pinned constant, and the *final* URL (after any
 *      redirect) must still be on that host. A redirect to somebody else's
 *      server is refused rather than followed, because "we checked the hash we
 *      were also given by that server" is not a check at all.
 *   2. **Nothing is unpacked or executed until its SHA-512 matches.** The hash
 *      is computed while the download streams past, compared against the
 *      published sibling checksum file, and a mismatch deletes the download.
 *
 * The checksum parsing deserves its own note, because getting it wrong is the
 * quiet way to lose rule 2. There is **no** combined `SHA512SUMS` for this
 * release. Asking dist.ipfs.tech for one does not return 404 — it returns an
 * IPFS *resolution error page*, with a 200-ish shape and human-readable text.
 * Code that fetched that file and searched it for a hash would find nothing,
 * and code that was any less careful might treat the page itself as the
 * expected value. So {@link parseChecksumFile} accepts exactly one thing: a
 * line of exactly 128 hexadecimal characters followed by a filename. An error
 * page cannot survive that, and neither can a truncated download.
 *
 * The rest of the file is the unglamorous work that makes the above usable: a
 * tar reader that pulls out precisely one file (so a hostile archive has no path
 * to write anywhere we did not choose), a progress stream so an ~80 MB download
 * is not 80 MB of silence, and {@link clearStaleLock}, which exists because a
 * leftover `repo.lock` after a hard kill silently blocks *every* subsequent
 * daemon start and logs nothing at all.
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, type Dirent, type WriteStream } from 'node:fs'
import {
  chmod,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  statfs,
  writeFile
} from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { Readable } from 'node:stream'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'
import { clearTimeout as clearTimer, setTimeout as setTimer } from 'node:timers'
import { createGunzip } from 'node:zlib'

import {
  DEFAULT_STORAGE_MAX,
  KUBO_DIST,
  KUBO_PLATFORMS,
  type NodeInstallProgress
} from '../../shared/node.js'

/* -------------------------------------------------------------------------- */
/* public types                                                                */
/* -------------------------------------------------------------------------- */

/** Which Kubo build this computer needs, and where it lives. */
export interface KuboArtifact {
  /** `${process.platform}-${process.arch}`. */
  platform: string
  /** Kubo's own naming, e.g. `darwin-arm64`. */
  slug: string
  /** File name of the release archive. */
  fileName: string
  /** Name of the executable inside it, e.g. `ipfs` or `ipfs.exe`. */
  binName: string
  ext: 'tar.gz' | 'zip'
  version: string
  url: string
  checksumUrl: string
}

/** What {@link downloadKubo} produced. */
export interface InstalledBinary {
  binPath: string
  /** As reported by the binary itself, e.g. `0.43.0`. */
  version: string
}

/** Extra choices {@link ensureRepo} makes on the caller's behalf. */
export interface EnsureRepoOptions {
  /**
   * Control-port to put the node's API on. Left alone when absent, which means
   * Kubo's own default of 127.0.0.1:5001. The manager passes a different port
   * only when 5001 is genuinely taken by something else.
   */
  apiPort?: number
  /**
   * Gateway port. Kubo's default is 8080, which on a developer's machine is
   * very often already in use — and the daemon then refuses to start at all,
   * with an error a member cannot be expected to interpret.
   */
  gatewayPort?: number
  /** Disk the node may use. Defaults to {@link DEFAULT_STORAGE_MAX}. */
  storageMaxBytes?: number
}

/** What a Kubo repository on disk can tell us without starting the daemon. */
export interface RepoInfo {
  /** The node's permanent identity. Our discriminator for "is this ours?". */
  peerId?: string
  /** API address from the repo's config, as an http(s) URL. */
  apiUrl?: string
  /** API address a *running* daemon published in the repo's `api` file. */
  liveApiUrl?: string
  /** Gateway address from the repo's config, as an http(s) URL. */
  gatewayUrl?: string
  /** `Datastore.StorageMax`, in bytes, when it could be understood. */
  storageMaxBytes?: number
}

/** Result of running a command. Never throws for a non-zero exit. */
export interface ProcessResult {
  code: number
  stdout: string
  stderr: string
  /** True when the command itself is not installed on this computer. */
  missing: boolean
  /** True when we stopped it because it took too long. */
  timedOut: boolean
}

export interface RunProcessOptions {
  env?: NodeJS.ProcessEnv
  cwd?: string
  timeoutMs?: number
  signal?: AbortSignal
}

/* -------------------------------------------------------------------------- */
/* tunables                                                                    */
/* -------------------------------------------------------------------------- */

/** A checksum file is one short line. Anything larger is not one. */
const MAX_CHECKSUM_BYTES = 64 * 1024

/** SHA-512, written as hex. Exactly this, or it is not a checksum. */
const SHA512_HEX_LENGTH = 128

/** The release archive is ~30 MB compressed; this is a wide safety margin. */
const MAX_ARTIFACT_BYTES = 512 * 1024 * 1024

/** Give up when a download has not moved for this long. */
const DOWNLOAD_STALL_MS = 120_000
/** Backstop for the whole transfer, however slow the connection. */
const DOWNLOAD_TOTAL_MS = 60 * 60_000
/** Fetching one short line should not need longer than this. */
const CHECKSUM_TIMEOUT_MS = 60_000

/** Report download progress at most this often, so the GUI is not flooded. */
const PROGRESS_INTERVAL_MS = 250

/** Generating an identity key takes a moment; unpacking a zip can take longer. */
const IPFS_COMMAND_TIMEOUT_MS = 3 * 60_000
const UNZIP_TIMEOUT_MS = 10 * 60_000
/** Asking who holds a file is instant or not worth waiting for. */
const LOCK_PROBE_TIMEOUT_MS = 10_000
/** A daemon that has just started holds the lock before it answers anything. */
const LOCK_GRACE_MS = 15_000

/** Room needed before downloading: the archive, plus the unpacked binary. */
const REQUIRED_FREE_BYTES = 600 * 1024 * 1024

/** Ceiling on captured command output, so a chatty failure cannot fill memory. */
const MAX_CAPTURED_OUTPUT = 256 * 1024

/** Kubo's repository config is a few kilobytes of JSON. */
const MAX_REPO_CONFIG_BYTES = 8 * 1024 * 1024

const USER_AGENT = 'bic-archiver/0.1 (kubo installer)'

/* -------------------------------------------------------------------------- */
/* errors                                                                      */
/* -------------------------------------------------------------------------- */

/** An error whose message is already written for a non-technical member. */
export function plainError(message: string, cause?: unknown): Error {
  const err = cause === undefined ? new Error(message) : new Error(message, { cause })
  err.name = 'ArchiverError'
  return err
}

function cancelled(): Error {
  const err = new Error('This was cancelled.')
  err.name = 'AbortError'
  return err
}

export function isCancellation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'AbortError'
}

function errorCode(err: unknown): string | undefined {
  const seen = new Set<unknown>()
  const walk = (value: unknown, depth: number): string | undefined => {
    if (depth > 5 || !(value instanceof Error) || seen.has(value)) return undefined
    seen.add(value)
    const code = (value as { code?: unknown }).code
    if (typeof code === 'string') return code
    const nested = (value as { errors?: unknown }).errors
    if (Array.isArray(nested)) {
      for (const entry of nested) {
        const found = walk(entry, depth + 1)
        if (found !== undefined) return found
      }
    }
    return walk((value as { cause?: unknown }).cause, depth + 1)
  }
  return walk(err, 0)
}

function shortText(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  return raw.replace(/\s+/g, ' ').trim().slice(0, 300)
}

/* -------------------------------------------------------------------------- */
/* small helpers                                                               */
/* -------------------------------------------------------------------------- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Bytes as a member would say them, e.g. "82 MB". */
export function describeBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 MB'
  if (bytes < 1024) return `${Math.round(bytes)} bytes`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

export async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

/**
 * A listener that throws must never be able to break an install, so every
 * progress report goes through here.
 */
export function safeReport(
  onProgress: ((p: NodeInstallProgress) => void) | undefined,
  progress: NodeInstallProgress
): void {
  if (onProgress === undefined) return
  try {
    onProgress(progress)
  } catch (err) {
    console.warn('[bic-archiver] a node set-up progress listener threw:', err)
  }
}

/* -------------------------------------------------------------------------- */
/* running commands                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Run a command and collect its output.
 *
 * Deliberately never uses a shell: every argument is passed as an argument, so a
 * folder called `My Stuff & Things` — or anything less innocent — cannot turn
 * into something the shell interprets. A missing command and a timeout are
 * reported as flags rather than exceptions, because both are ordinary outcomes
 * here (no `lsof`, no `systemctl`) that callers handle rather than propagate.
 */
export async function runProcess(
  file: string,
  args: readonly string[],
  options: RunProcessOptions = {}
): Promise<ProcessResult> {
  const timeoutMs = options.timeoutMs ?? IPFS_COMMAND_TIMEOUT_MS

  if (options.signal?.aborted === true) throw cancelled()

  return new Promise<ProcessResult>((resolve, reject) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(file, [...args], {
        env: options.env ?? process.env,
        cwd: options.cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      })
    } catch (err) {
      resolve({ code: -1, stdout: '', stderr: shortText(err), missing: true, timedOut: false })
      return
    }

    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false

    const timer = setTimer(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)
    timer.unref()

    const onAbort = (): void => {
      child.kill('SIGKILL')
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })

    const finish = (result: ProcessResult): void => {
      if (settled) return
      settled = true
      clearTimer(timer)
      options.signal?.removeEventListener('abort', onAbort)
      if (options.signal?.aborted === true) {
        reject(cancelled())
        return
      }
      resolve(result)
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < MAX_CAPTURED_OUTPUT) stdout += chunk.toString('utf8')
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < MAX_CAPTURED_OUTPUT) stderr += chunk.toString('utf8')
    })

    child.on('error', (err: NodeJS.ErrnoException) => {
      finish({
        code: -1,
        stdout,
        stderr: shortText(err),
        missing: err.code === 'ENOENT',
        timedOut
      })
    })

    child.on('close', (code) => {
      finish({ code: code ?? -1, stdout, stderr, missing: false, timedOut })
    })
  })
}

/** Run the managed `ipfs` binary against one specific repository. */
export async function runIpfs(
  binPath: string,
  repoPath: string,
  args: readonly string[],
  options: RunProcessOptions = {}
): Promise<ProcessResult> {
  // IPFS_PATH is set explicitly rather than inherited: a member with their own
  // node has IPFS_PATH pointing at ~/.ipfs, and quietly reconfiguring *their*
  // node instead of ours is exactly the mistake this app must never make.
  const env: NodeJS.ProcessEnv = { ...process.env, IPFS_PATH: repoPath }
  return runProcess(binPath, args, { ...options, env })
}

/** The version the binary reports, e.g. `0.43.0`. Undefined if it will not run. */
export async function kuboVersion(
  binPath: string,
  signal?: AbortSignal
): Promise<string | undefined> {
  const result = await runProcess(binPath, ['--version'], { timeoutMs: 30_000, signal })
  if (result.code !== 0) return undefined
  const match = /ipfs\s+version\s+([0-9][\w.+-]*)/i.exec(result.stdout)
  return match?.[1]
}

/* -------------------------------------------------------------------------- */
/* which build this computer needs                                             */
/* -------------------------------------------------------------------------- */

/** `${process.platform}-${process.arch}`, the key {@link KUBO_PLATFORMS} uses. */
export function platformKey(): string {
  return `${process.platform}-${process.arch}`
}

/** How a platform reads to somebody who is not a programmer. */
function describePlatform(key: string): string {
  const names: Record<string, string> = {
    darwin: 'macOS',
    win32: 'Windows',
    linux: 'Linux',
    freebsd: 'FreeBSD',
    openbsd: 'OpenBSD',
    sunos: 'Solaris',
    aix: 'AIX'
  }
  const [platform = key, arch = ''] = key.split('-')
  const friendly = names[platform] ?? platform
  return arch === '' ? friendly : `${friendly} (${arch})`
}

/**
 * The Kubo release this computer needs.
 *
 * @throws A plain-English `Error` naming the platform when there is no build for
 * it — which is a real answer a member can act on ("use a different computer"),
 * not a bug to be hidden behind a generic failure.
 */
export function kuboArtifact(key: string = platformKey()): KuboArtifact {
  const entry = KUBO_PLATFORMS[key]
  if (entry === undefined) {
    throw plainError(
      `There is no IPFS build for ${describePlatform(key)}, so this app cannot set up a node on this computer. ` +
        'You can still make backups and check what is at risk here; running a node needs a computer with ' +
        'macOS, Windows or Linux on an Intel/AMD or ARM processor.'
    )
  }

  const version = KUBO_DIST.version
  const fileName = `kubo_${version}_${entry.slug}.${entry.ext}`
  const base = KUBO_DIST.baseUrl.replace(/\/+$/, '')
  const url = `${base}/${version}/${fileName}`

  return {
    platform: key,
    slug: entry.slug,
    fileName,
    binName: entry.bin,
    ext: entry.ext,
    version,
    url,
    checksumUrl: `${url}${KUBO_DIST.checksumSuffix}`
  }
}

/* -------------------------------------------------------------------------- */
/* the download itself                                                         */
/* -------------------------------------------------------------------------- */

/** A total budget plus a stall budget, on one signal. */
interface Deadline {
  readonly signal: AbortSignal
  touch(): void
  release(): void
  /** Why we gave up, when we did. */
  reason(): 'stall' | 'total' | 'cancelled' | undefined
}

function createDeadline(totalMs: number, stallMs: number | undefined, outer?: AbortSignal): Deadline {
  const controller = new AbortController()
  let reason: 'stall' | 'total' | 'cancelled' | undefined
  let released = false

  if (outer?.aborted === true) {
    reason = 'cancelled'
    controller.abort()
  }

  const total = setTimer(() => {
    if (reason === undefined) reason = 'total'
    controller.abort()
  }, totalMs)
  total.unref()

  let stall: ReturnType<typeof setTimer> | undefined
  const armStall = (): void => {
    if (stallMs === undefined || released) return
    if (stall !== undefined) clearTimer(stall)
    stall = setTimer(() => {
      if (reason === undefined) reason = 'stall'
      controller.abort()
    }, stallMs)
    stall.unref()
  }

  const onOuterAbort = (): void => {
    reason = 'cancelled'
    controller.abort()
  }
  outer?.addEventListener('abort', onOuterAbort, { once: true })

  armStall()

  return {
    signal: controller.signal,
    touch: armStall,
    reason: () => reason,
    release: () => {
      released = true
      clearTimer(total)
      if (stall !== undefined) clearTimer(stall)
      outer?.removeEventListener('abort', onOuterAbort)
    }
  }
}

/**
 * Fetch, refusing to leave the official distribution host.
 *
 * `fetch` follows redirects happily, and a redirect is exactly how a download
 * ends up somewhere other than where the code says it came from. The final URL
 * is therefore checked against the expected origin *after* the redirect chain
 * has been followed, and a hop off-host is a failure rather than a detail.
 */
async function fetchFromDist(url: string, deadline: Deadline): Promise<Response> {
  const expected = new URL(KUBO_DIST.baseUrl)
  if (expected.protocol !== 'https:') {
    throw plainError(
      'Refusing to download IPFS: the built-in download address is not a secure (https) one. ' +
        'This is a problem with the app itself — please report it.'
    )
  }

  const target = new URL(url)
  if (target.protocol !== 'https:' || target.host !== expected.host) {
    throw plainError(
      'Refusing to download IPFS from an unexpected address. ' +
        'This is a problem with the app itself — please report it.'
    )
  }

  let response: Response
  try {
    response = await fetch(target, {
      headers: { 'user-agent': USER_AGENT, accept: '*/*' },
      redirect: 'follow',
      signal: deadline.signal
    })
  } catch (err) {
    throw downloadTransportError(err, deadline)
  }

  const finalUrl = new URL(response.url === '' ? target.toString() : response.url)
  if (finalUrl.protocol !== 'https:' || finalUrl.host !== expected.host) {
    throw plainError(
      `The download was redirected away from ${expected.host} to ${finalUrl.host}, so it was stopped. ` +
        'This app only installs IPFS from its official download site.'
    )
  }

  if (!response.ok) {
    // Read and discard, so the socket is released rather than left hanging.
    await response.body?.cancel().catch(() => undefined)
    if (response.status === 404) {
      throw plainError(
        `The IPFS download for this computer (${basename(finalUrl.pathname)}) is no longer published at ` +
          `${expected.host}. This app is asking for version ${KUBO_DIST.version}; if that release has been ` +
          'withdrawn, a newer version of this app will be needed.'
      )
    }
    throw plainError(
      `The IPFS download site answered with error ${response.status}. It may be temporarily unavailable — ` +
        'wait a few minutes and try again.'
    )
  }

  return response
}

function downloadTransportError(err: unknown, deadline: Deadline): Error {
  const why = deadline.reason()
  if (why === 'cancelled') return cancelled()
  if (why === 'stall') {
    return plainError(
      'The IPFS download stopped part-way through and nothing more arrived for two minutes, so it was ' +
        'abandoned. Check your internet connection and try again — nothing has been installed.'
    )
  }
  if (why === 'total') {
    return plainError(
      'The IPFS download took too long and was stopped. Nothing has been installed; try again on a faster ' +
        'or more reliable connection.'
    )
  }
  if (isCancellation(err)) return cancelled()

  switch (errorCode(err)) {
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return plainError(
        `${new URL(KUBO_DIST.baseUrl).host} could not be found. This computer may be offline, or its ` +
          'internet connection may be blocking that address.'
      )
    case 'ECONNREFUSED':
    case 'ECONNRESET':
    case 'EPIPE':
      return plainError(
        'The connection to the IPFS download site was dropped. Check your internet connection and try again.'
      )
    case 'CERT_HAS_EXPIRED':
    case 'ERR_TLS_CERT_ALTNAME_INVALID':
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
      return plainError(
        'The secure connection to the IPFS download site could not be trusted, so the download was stopped. ' +
          'This can happen on networks that inspect traffic (some workplaces and public Wi-Fi). ' +
          'Nothing has been installed.'
      )
    default:
      return plainError(
        `The IPFS download could not be completed. Check your internet connection and try again. (${shortText(err)})`
      )
  }
}

/**
 * Pull the one expected value out of a `.sha512` file.
 *
 * The published format is `<128 hex chars><two spaces><filename>`. Nothing else
 * is accepted — and that is the whole point. Asking dist.ipfs.tech for a file
 * that does not exist returns an IPFS *resolution error page* rather than a 404,
 * so a parser that scavenged "the first long-looking token" could be handed a
 * page of prose and find something in it. Exactly 128 hexadecimal characters, or
 * no answer at all.
 */
export function parseChecksumFile(text: string, expectedFileName: string): string {
  const entries: Array<{ hash: string; name: string }> = []

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '') continue
    // `<hash><whitespace>[*]<filename>` — the `*` marks "binary mode" in the
    // GNU/BSD format and is not part of the name.
    const match = /^([0-9a-fA-F]+)\s+\*?(\S.*)$/.exec(line)
    if (match === null) continue
    const hash = match[1]
    const name = match[2]
    if (hash === undefined || name === undefined) continue
    if (hash.length !== SHA512_HEX_LENGTH) continue
    entries.push({ hash: hash.toLowerCase(), name: basename(name.trim()) })
  }

  if (entries.length === 0) {
    throw plainError(
      `The checksum published alongside the IPFS download could not be read, so the download was not ` +
        'trusted and nothing has been installed. The download site may be having problems — ' +
        'wait a few minutes and try again.'
    )
  }

  const matched = entries.find((entry) => entry.name === expectedFileName)
  if (matched !== undefined) return matched.hash

  const only = entries[0]
  if (entries.length === 1 && only !== undefined) return only.hash

  throw plainError(
    `The checksum file published alongside the IPFS download does not mention ${expectedFileName}, ` +
      'so the download could not be verified and nothing has been installed.'
  )
}

/** Download the sibling `.sha512` and return the hash it publishes. */
async function fetchExpectedHash(
  artifact: KuboArtifact,
  outerSignal: AbortSignal | undefined
): Promise<string> {
  const deadline = createDeadline(CHECKSUM_TIMEOUT_MS, undefined, outerSignal)
  try {
    const response = await fetchFromDist(artifact.checksumUrl, deadline)
    const body = response.body
    if (body === null) {
      throw plainError(
        'The checksum for the IPFS download came back empty, so the download was not trusted. Try again.'
      )
    }

    const reader = body.getReader()
    const decoder = new TextDecoder()
    let text = ''
    let total = 0
    try {
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        const value = chunk.value
        if (value === undefined) continue
        total += value.byteLength
        if (total > MAX_CHECKSUM_BYTES) {
          throw plainError(
            'The checksum published alongside the IPFS download was far larger than a checksum can be, ' +
              'so it was rejected and nothing has been installed.'
          )
        }
        text += decoder.decode(value, { stream: true })
      }
      text += decoder.decode()
    } finally {
      await reader.cancel().catch(() => undefined)
    }

    return parseChecksumFile(text, artifact.fileName)
  } finally {
    deadline.release()
  }
}

/** Stream a download to disk, hashing as it goes. Returns the hash, lowercase. */
async function downloadToFile(
  artifact: KuboArtifact,
  destPath: string,
  onProgress: ((p: NodeInstallProgress) => void) | undefined,
  outerSignal: AbortSignal | undefined
): Promise<string> {
  const deadline = createDeadline(DOWNLOAD_TOTAL_MS, DOWNLOAD_STALL_MS, outerSignal)
  let sink: WriteStream | undefined

  try {
    const response = await fetchFromDist(artifact.url, deadline)
    const body = response.body
    if (body === null) {
      throw plainError('The IPFS download came back empty. Try again in a moment.')
    }

    const declared = Number(response.headers.get('content-length') ?? '')
    const total = Number.isFinite(declared) && declared > 0 ? declared : undefined
    if (total !== undefined && total > MAX_ARTIFACT_BYTES) {
      await body.cancel().catch(() => undefined)
      throw plainError(
        `The IPFS download claims to be ${describeBytes(total)}, which is far larger than expected, ` +
          'so it was refused. Nothing has been installed.'
      )
    }

    const hash = createHash('sha512')
    let done = 0
    let lastReport = 0

    sink = createWriteStream(destPath, { flags: 'w', mode: 0o600 })
    const writable = sink
    const failure = new Promise<never>((_resolve, reject) => {
      writable.once('error', (err: unknown) => reject(diskError(err, destPath)))
    })

    const reader = (body as WebReadableStream<Uint8Array>).getReader()
    try {
      for (;;) {
        const chunk = await Promise.race([reader.read(), failure])
        if (chunk.done) break
        const value = chunk.value
        if (value === undefined || value.byteLength === 0) continue

        deadline.touch()
        done += value.byteLength
        if (done > MAX_ARTIFACT_BYTES) {
          throw plainError(
            'The IPFS download kept growing well past the size it should be, so it was stopped. ' +
              'Nothing has been installed.'
          )
        }

        hash.update(value)
        await Promise.race([writeChunk(writable, Buffer.from(value.buffer, value.byteOffset, value.byteLength)), failure])

        const now = Date.now()
        if (now - lastReport >= PROGRESS_INTERVAL_MS) {
          lastReport = now
          const progress: NodeInstallProgress = {
            phase: 'downloading',
            message:
              total === undefined
                ? `Downloading IPFS — ${describeBytes(done)} so far…`
                : `Downloading IPFS — ${describeBytes(done)} of ${describeBytes(total)}…`,
            bytesDone: done
          }
          if (total !== undefined) {
            progress.bytesTotal = total
            progress.progress = Math.min(1, done / total)
          }
          safeReport(onProgress, progress)
        }
      }
    } catch (err) {
      await reader.cancel().catch(() => undefined)
      if (isCancellation(err)) throw cancelled()
      if (err instanceof Error && err.name === 'ArchiverError') throw err
      throw downloadTransportError(err, deadline)
    }

    await Promise.race([endStream(writable), failure])
    sink = undefined

    if (total !== undefined && done !== total) {
      throw plainError(
        `The IPFS download stopped early — ${describeBytes(done)} of ${describeBytes(total)} arrived. ` +
          'Nothing has been installed; try again.'
      )
    }

    safeReport(onProgress, {
      phase: 'downloading',
      message: `Downloaded ${describeBytes(done)}.`,
      bytesDone: done,
      ...(total === undefined ? {} : { bytesTotal: total, progress: 1 })
    })

    return hash.digest('hex')
  } finally {
    if (sink !== undefined) sink.destroy()
    deadline.release()
  }
}

/** Write one chunk, waiting for the file to drain when it asks us to. */
function writeChunk(stream: WriteStream, chunk: Buffer): Promise<void> {
  if (stream.write(chunk)) return Promise.resolve()
  return new Promise<void>((resolve) => {
    stream.once('drain', () => resolve())
  })
}

function endStream(stream: WriteStream): Promise<void> {
  return new Promise<void>((resolve) => {
    stream.end(() => resolve())
  })
}

function diskError(err: unknown, path: string): Error {
  switch (errorCode(err)) {
    case 'ENOSPC':
      return plainError(
        `This computer ran out of disk space while saving the IPFS download to "${path}". ` +
          'Free up some space and try again.'
      )
    case 'EACCES':
    case 'EPERM':
      return plainError(
        `This app is not allowed to write to "${path}". Check the folder's permissions and try again.`
      )
    case 'EROFS':
      return plainError(`"${path}" is on a read-only disk, so nothing could be saved there.`)
    default:
      return plainError(`The IPFS download could not be saved to "${path}". (${shortText(err)})`)
  }
}

/* -------------------------------------------------------------------------- */
/* download + verify + unpack                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Fetch the pinned Kubo release, prove it is the published one, and unpack the
 * `ipfs` executable into `destDir`.
 *
 * Nothing is unpacked or run before the SHA-512 matches. On a mismatch the
 * download is deleted and this throws — there is no "continue anyway", because
 * the only reasons for a mismatch are a corrupted transfer or somebody serving
 * different bytes, and running the second one would be catastrophic.
 *
 * @throws A plain-English `Error` for every failure.
 * @throws An `Error` with `name === 'AbortError'` if `signal` is aborted.
 */
export async function downloadKubo(
  destDir: string,
  onProgress: (p: NodeInstallProgress) => void,
  signal?: AbortSignal
): Promise<InstalledBinary> {
  const artifact = kuboArtifact()

  safeReport(onProgress, {
    phase: 'checking',
    message: `Getting IPFS ${artifact.version} ready for ${describePlatform(artifact.platform)}…`
  })

  try {
    await mkdir(destDir, { recursive: true })
  } catch (err) {
    throw plainError(
      `The folder for the IPFS program ("${destDir}") could not be created. ` +
        `Check that the disk has space and that you are allowed to write there. (${shortText(err)})`
    )
  }

  await assertEnoughSpace(destDir)

  const work = join(destDir, '.staging')
  await rm(work, { recursive: true, force: true }).catch(() => undefined)
  await mkdir(work, { recursive: true })

  const archivePath = join(work, artifact.fileName)
  const binPath = join(destDir, artifact.binName)

  try {
    // The checksum first: if it cannot be read there is no point spending
    // 80 MB of somebody's data allowance on bytes we could never trust.
    const expected = await fetchExpectedHash(artifact, signal)

    const actual = await downloadToFile(artifact, archivePath, onProgress, signal)

    safeReport(onProgress, { phase: 'verifying', message: 'Checking the download is genuine…' })

    if (actual !== expected) {
      await rm(archivePath, { force: true }).catch(() => undefined)
      throw plainError(
        'The IPFS download did not match the fingerprint published for it, so it has been deleted and ' +
          'nothing was installed. This usually means the download was corrupted on the way here — ' +
          'try again. If it keeps happening, do not install IPFS by hand from another source; ' +
          'report this instead.'
      )
    }

    safeReport(onProgress, { phase: 'extracting', message: 'Unpacking IPFS…' })

    const stagedBin = join(work, artifact.binName)
    if (artifact.ext === 'tar.gz') {
      await extractBinaryFromTarGz(archivePath, artifact.binName, stagedBin)
    } else {
      await extractFromZip(archivePath, artifact.binName, stagedBin, work, signal)
    }

    if (process.platform !== 'win32') {
      await chmod(stagedBin, 0o755)
    }

    await placeBinary(stagedBin, binPath)

    const version = (await kuboVersion(binPath, signal)) ?? artifact.version.replace(/^v/, '')
    return { binPath, version }
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => undefined)
  }
}

/** Best-effort free-space check, so an 80 MB download does not fail at 79 MB. */
async function assertEnoughSpace(dir: string): Promise<void> {
  let free: number
  try {
    const info = await statfs(dir)
    free = Number(info.bavail) * Number(info.bsize)
  } catch {
    return // Some filesystems cannot answer; not a reason to refuse to install.
  }
  if (!Number.isFinite(free) || free <= 0) return
  if (free < REQUIRED_FREE_BYTES) {
    throw plainError(
      `There is only ${describeBytes(free)} free where the app keeps its files, and setting up an IPFS ` +
        `node needs about ${describeBytes(REQUIRED_FREE_BYTES)} to install (and room for the archive after ` +
        'that). Free up some space and try again.'
    )
  }
}

/** Move the unpacked binary into place, explaining the one failure that recurs. */
async function placeBinary(from: string, to: string): Promise<void> {
  try {
    await rm(to, { force: true })
  } catch (err) {
    if (process.platform === 'win32') {
      throw plainError(
        'The IPFS program could not be replaced because it is currently running. ' +
          'Stop your node first, then set it up again.'
      )
    }
    throw plainError(`The existing IPFS program at "${to}" could not be replaced. (${shortText(err)})`)
  }

  try {
    await rename(from, to)
  } catch (err) {
    throw plainError(
      `The IPFS program could not be moved into place at "${to}". ` +
        `Check that the disk has space and that you are allowed to write there. (${shortText(err)})`
    )
  }
}

/* -------------------------------------------------------------------------- */
/* unpacking                                                                   */
/* -------------------------------------------------------------------------- */

const TAR_BLOCK = 512

/** Reads exact byte counts out of a stream, whatever size the chunks arrive in. */
class ByteReader {
  readonly #iterator: AsyncIterator<Buffer>
  #buffer: Buffer = Buffer.alloc(0)
  #ended = false

  constructor(source: AsyncIterable<Buffer>) {
    this.#iterator = source[Symbol.asyncIterator]()
  }

  /** Exactly `n` bytes, or null at end of stream. */
  async read(n: number): Promise<Buffer | null> {
    while (this.#buffer.length < n && !this.#ended) {
      const next = await this.#iterator.next()
      if (next.done === true) {
        this.#ended = true
        break
      }
      const value = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value)
      this.#buffer = this.#buffer.length === 0 ? value : Buffer.concat([this.#buffer, value])
    }
    if (this.#buffer.length < n) return null
    const out = Buffer.from(this.#buffer.subarray(0, n))
    this.#buffer = this.#buffer.subarray(n)
    return out
  }

  /** Hand `n` bytes to `sink` in whatever pieces they arrive in. */
  async pipe(n: number, sink: (chunk: Buffer) => Promise<void>): Promise<void> {
    let left = n
    while (left > 0) {
      const wanted = Math.min(left, 1024 * 1024)
      const chunk = await this.read(wanted)
      if (chunk === null) {
        throw plainError(
          'The IPFS download was incomplete — it ended in the middle of a file. Nothing has been installed; ' +
            'try again.'
        )
      }
      await sink(chunk)
      left -= chunk.length
    }
  }

  async skip(n: number): Promise<void> {
    await this.pipe(n, async () => undefined)
  }
}

function octal(field: Buffer): number {
  const text = field.toString('ascii').replace(/\0.*$/, '').trim()
  if (text === '') return 0
  const value = Number.parseInt(text, 8)
  return Number.isFinite(value) && value >= 0 ? value : 0
}

/**
 * Pull exactly one file out of a `.tar.gz`, by name.
 *
 * Written by hand rather than shelling out to `tar` for two reasons. The first
 * is portability — nothing has to be installed for this to work. The second
 * matters more: this reader never writes a path that came out of the archive.
 * It looks for one entry, by its own file name, and streams it to a destination
 * *we* chose, so an archive containing `../../.bashrc` has nowhere to put it.
 */
export async function extractBinaryFromTarGz(
  archivePath: string,
  binName: string,
  destPath: string
): Promise<void> {
  const source = createReadStream(archivePath)
  const gunzip = createGunzip()
  source.on('error', (err) => gunzip.destroy(err))
  const stream: Readable = source.pipe(gunzip)

  const reader = new ByteReader(stream as AsyncIterable<Buffer>)
  let pendingLongName: string | undefined
  let found = false

  try {
    for (;;) {
      const header = await reader.read(TAR_BLOCK)
      if (header === null) break
      // Two zero blocks mark the end; one is enough for us to stop looking.
      if (header.every((byte) => byte === 0)) break

      const rawName = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '')
      const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '')
      const typeFlag = String.fromCharCode(header[156] ?? 0)
      const size = octal(header.subarray(124, 136))
      const padded = size % TAR_BLOCK === 0 ? size : size + (TAR_BLOCK - (size % TAR_BLOCK))

      if (size > MAX_ARTIFACT_BYTES) {
        throw plainError(
          'The IPFS download contains a file far larger than it should, so it was not unpacked. ' +
            'Nothing has been installed.'
        )
      }

      // GNU long-name records carry the next entry's name in their body.
      if (typeFlag === 'L') {
        const body = await reader.read(padded)
        if (body === null) break
        pendingLongName = body.subarray(0, size).toString('utf8').replace(/\0.*$/, '')
        continue
      }
      // Pax extended headers and GNU long link names: skipped whole.
      if (typeFlag === 'x' || typeFlag === 'g' || typeFlag === 'K') {
        await reader.skip(padded)
        continue
      }

      const name = pendingLongName ?? (prefix === '' ? rawName : `${prefix}/${rawName}`)
      pendingLongName = undefined

      const isRegular = typeFlag === '0' || typeFlag === '\0' || typeFlag === '7'
      if (!found && isRegular && basename(name) === binName) {
        const sink = createWriteStream(destPath, { flags: 'w', mode: 0o700 })
        try {
          await reader.pipe(size, (chunk) => writeChunk(sink, chunk))
          await endStream(sink)
        } catch (err) {
          sink.destroy()
          throw err
        }
        await reader.skip(padded - size)
        found = true
        // Keep reading is pointless once we have what we came for.
        break
      }

      await reader.skip(padded)
    }
  } finally {
    source.destroy()
    gunzip.destroy()
  }

  if (!found) {
    throw plainError(
      `The IPFS download did not contain the program file ("${binName}"), so nothing has been installed. ` +
        'Please report this.'
    )
  }
}

/** Quote a string for PowerShell's single-quoted (literal) form. */
function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

/**
 * Unpack the Windows `.zip` and lift the executable out of it.
 *
 * `Expand-Archive` ships with Windows PowerShell 5, which is on every supported
 * Windows; `tar.exe` (bsdtar, which also reads zip) has shipped since Windows 10
 * 1803 and is the fallback for a machine where PowerShell is locked down.
 */
async function extractFromZip(
  archivePath: string,
  binName: string,
  destPath: string,
  workDir: string,
  signal?: AbortSignal
): Promise<void> {
  const outDir = join(workDir, 'unpacked')
  await mkdir(outDir, { recursive: true })

  const script =
    `$ErrorActionPreference = 'Stop'; ` +
    `Expand-Archive -LiteralPath ${psQuote(archivePath)} -DestinationPath ${psQuote(outDir)} -Force`

  let unpacked = await runProcess(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { timeoutMs: UNZIP_TIMEOUT_MS, signal }
  )

  if (unpacked.code !== 0) {
    const fallback = await runProcess('tar.exe', ['-xf', archivePath, '-C', outDir], {
      timeoutMs: UNZIP_TIMEOUT_MS,
      signal
    })
    if (fallback.code === 0) unpacked = fallback
  }

  if (unpacked.code !== 0) {
    throw plainError(
      'The IPFS download could not be unpacked on this computer. ' +
        (unpacked.missing
          ? 'Windows PowerShell was not available to do it. '
          : `Windows reported: ${shortText(unpacked.stderr || unpacked.stdout)}. `) +
        'Nothing has been installed.'
    )
  }

  const found = await findFile(outDir, binName, 4)
  if (found === undefined) {
    throw plainError(
      `The IPFS download did not contain the program file ("${binName}"), so nothing has been installed. ` +
        'Please report this.'
    )
  }
  await rename(found, destPath)
}

/** Depth-limited search for one file name. */
async function findFile(dir: string, name: string, depth: number): Promise<string | undefined> {
  if (depth < 0) return undefined
  let entries: Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return undefined
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isFile() && entry.name === name) return full
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const found = await findFile(join(dir, entry.name), name, depth - 1)
    if (found !== undefined) return found
  }
  return undefined
}

/* -------------------------------------------------------------------------- */
/* the repository                                                              */
/* -------------------------------------------------------------------------- */

/** `/ip4/127.0.0.1/tcp/5001` and friends, as a URL we can call. */
export function multiaddrToUrl(addr: string): string | undefined {
  const parts = addr.split('/').filter((part) => part !== '')
  const protocol = parts[0]
  const host = parts[1]
  const transport = parts[2]
  const port = parts[3]
  if (protocol === undefined || host === undefined || transport !== 'tcp' || port === undefined) {
    return undefined
  }
  if (!/^\d{1,5}$/.test(port)) return undefined

  const scheme = parts.includes('https') || parts.includes('tls') ? 'https' : 'http'
  const authority = protocol === 'ip6' ? `[${host}]` : host
  return `${scheme}://${authority}:${port}`
}

/** `20GiB`, `10GB`, `2000000` — whatever Kubo's config happens to hold. */
export function parseStorageMax(value: string): number | undefined {
  const match = /^\s*([0-9]+(?:\.[0-9]+)?)\s*([KMGTP]?i?B?)\s*$/i.exec(value)
  if (match === null) return undefined
  const amount = Number(match[1])
  if (!Number.isFinite(amount)) return undefined

  const unit = (match[2] ?? '').toUpperCase()
  if (unit === '' || unit === 'B') return Math.round(amount)

  const binary = unit.includes('I')
  const step = binary ? 1024 : 1000
  const letter = unit.charAt(0)
  const power = { K: 1, M: 2, G: 3, T: 4, P: 5 }[letter]
  if (power === undefined) return undefined
  return Math.round(amount * step ** power)
}

/** Bytes in the form Kubo's config understands, exactly. */
export function formatStorageMax(bytes: number): string {
  const gib = 1024 ** 3
  const mib = 1024 ** 2
  const whole = Math.max(1, Math.floor(bytes))
  if (whole % gib === 0) return `${whole / gib}GiB`
  if (whole % mib === 0) return `${whole / mib}MiB`
  return String(whole)
}

/**
 * What a repository on disk says about itself, without starting the daemon.
 *
 * `Identity.PeerID` is the field that matters most: it is how the manager tells
 * *our* node from one the member already had, which is the difference between
 * "restart it" and "leave it alone, it is not ours".
 */
export async function readRepoInfo(repoPath: string): Promise<RepoInfo | undefined> {
  const configPath = join(repoPath, 'config')

  let raw: string
  try {
    const info = await stat(configPath)
    if (!info.isFile() || info.size > MAX_REPO_CONFIG_BYTES) return undefined
    raw = await readFile(configPath, 'utf8')
  } catch {
    return undefined
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch {
    return undefined
  }
  if (!isRecord(parsed)) return undefined

  const info: RepoInfo = {}

  const identity = parsed['Identity']
  if (isRecord(identity) && typeof identity['PeerID'] === 'string' && identity['PeerID'] !== '') {
    info.peerId = identity['PeerID']
  }

  const addresses = parsed['Addresses']
  if (isRecord(addresses)) {
    const api = addresses['API']
    const apiAddr = typeof api === 'string' ? api : Array.isArray(api) ? api.find((a) => typeof a === 'string') : undefined
    if (typeof apiAddr === 'string') {
      const url = multiaddrToUrl(apiAddr)
      if (url !== undefined) info.apiUrl = url
    }
    const gateway = addresses['Gateway']
    const gatewayAddr =
      typeof gateway === 'string'
        ? gateway
        : Array.isArray(gateway)
          ? gateway.find((a) => typeof a === 'string')
          : undefined
    if (typeof gatewayAddr === 'string') {
      const url = multiaddrToUrl(gatewayAddr)
      if (url !== undefined) info.gatewayUrl = url
    }
  }

  const datastore = parsed['Datastore']
  if (isRecord(datastore) && typeof datastore['StorageMax'] === 'string') {
    const bytes = parseStorageMax(datastore['StorageMax'])
    if (bytes !== undefined) info.storageMaxBytes = bytes
  }

  // Written by a running daemon and removed when it exits cleanly.
  const live = await readFile(join(repoPath, 'api'), 'utf8').catch(() => undefined)
  if (live !== undefined) {
    const url = multiaddrToUrl(live.trim())
    if (url !== undefined) info.liveApiUrl = url
  }

  return info
}

/**
 * Make sure a Kubo repository exists at `repoPath` and is configured the way the
 * archive needs it.
 *
 * Safe to call repeatedly: an existing repository is configured, never
 * re-initialised, so a member's pinned content survives running set-up again.
 *
 * @throws A plain-English `Error` when the repository cannot be created or
 * configured.
 */
export async function ensureRepo(
  binPath: string,
  repoPath: string,
  onProgress: (p: NodeInstallProgress) => void,
  signal?: AbortSignal,
  options: EnsureRepoOptions = {}
): Promise<void> {
  const alreadyThere = await isFile(join(repoPath, 'config'))

  if (!alreadyThere) {
    safeReport(onProgress, {
      phase: 'initialising',
      message: 'Setting up your node’s storage. This takes a few seconds…'
    })

    try {
      await mkdir(repoPath, { recursive: true })
    } catch (err) {
      throw plainError(
        `The folder for your node’s storage ("${repoPath}") could not be created. ` +
          `Check that the disk has space and that you are allowed to write there. (${shortText(err)})`
      )
    }

    const init = await runIpfs(binPath, repoPath, ['init'], {
      timeoutMs: IPFS_COMMAND_TIMEOUT_MS,
      signal
    })

    if (init.code !== 0 && !(await isFile(join(repoPath, 'config')))) {
      throw plainError(describeIpfsFailure('set up your node’s storage', init, repoPath))
    }
  }

  safeReport(onProgress, { phase: 'configuring', message: 'Configuring your node…' })

  const storageMax = formatStorageMax(options.storageMaxBytes ?? DEFAULT_STORAGE_MAX)
  await configure(binPath, repoPath, ['config', 'Datastore.StorageMax', storageMax], signal)

  if (options.apiPort !== undefined) {
    await configure(
      binPath,
      repoPath,
      ['config', 'Addresses.API', `/ip4/127.0.0.1/tcp/${options.apiPort}`],
      signal
    )
  }

  if (options.gatewayPort !== undefined) {
    await configure(
      binPath,
      repoPath,
      ['config', 'Addresses.Gateway', `/ip4/127.0.0.1/tcp/${options.gatewayPort}`],
      signal
    )
  }
}

async function configure(
  binPath: string,
  repoPath: string,
  args: readonly string[],
  signal: AbortSignal | undefined
): Promise<void> {
  const result = await runIpfs(binPath, repoPath, args, { timeoutMs: 60_000, signal })
  if (result.code !== 0) {
    throw plainError(describeIpfsFailure('configure your node', result, repoPath))
  }
}

/** Turn an `ipfs` command failure into something a member can act on. */
function describeIpfsFailure(what: string, result: ProcessResult, repoPath: string): string {
  const said = shortText(result.stderr || result.stdout)

  if (result.missing) {
    return (
      `The IPFS program could not be run, so the app could not ${what}. ` +
        'It may have been removed or blocked by security software. Try setting up the node again.'
    )
  }
  if (result.timedOut) {
    return `The IPFS program took too long to ${what} and was stopped. Try again.`
  }
  if (/lock|resource temporarily unavailable/i.test(said)) {
    return (
      `Your node’s storage at "${repoPath}" is being used by something else, so the app could not ${what}. ` +
        'If an IPFS node is already running on this computer, stop it and try again.'
    )
  }
  if (/repo.*version|migration|migrate/i.test(said)) {
    return (
      `Your node’s storage at "${repoPath}" was made by a different version of IPFS, so the app could not ` +
        `${what}. Moving that folder aside and setting the node up again will fix it, but anything only ` +
        'stored there would need adding back.'
    )
  }
  if (/no space|ENOSPC/i.test(said)) {
    return `This computer ran out of disk space, so the app could not ${what}. Free up some space and try again.`
  }
  if (/permission denied|EACCES/i.test(said)) {
    return (
      `This app is not allowed to write to "${repoPath}", so it could not ${what}. ` +
        'Check the folder’s permissions and try again.'
    )
  }
  return said === ''
    ? `The app could not ${what}. Try again.`
    : `The app could not ${what}. IPFS said: ${said}`
}

/* -------------------------------------------------------------------------- */
/* the stale lock                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Delete a `repo.lock` that no live daemon owns.
 *
 * This exists because of a failure that cost an hour of somebody's life and left
 * no trace to find it by: after a hard kill (a crash, a force-quit, a laptop
 * losing power) Kubo leaves `repo.lock` behind, and from then on **every**
 * attempt to start the daemon fails — silently, with nothing written to any log
 * a member would ever look at. The node simply never comes back.
 *
 * The obvious fix — delete the lock before starting — is also the dangerous one,
 * because deleting a lock a *running* daemon holds lets a second daemon open the
 * same datastore, which corrupts it. So liveness is established three ways
 * before anything is removed:
 *
 *   1. **Does the node answer?** A running daemon replies on its API. If it
 *      does, we do not touch anything, full stop.
 *   2. **Is the lock brand new?** A daemon takes the lock before it starts
 *      listening, so a lock touched seconds ago may belong to one still waking
 *      up. Those are left alone.
 *   3. **Does any process have the file open?** `lsof`/`fuser` on macOS and
 *      Linux answer this directly. On Windows the question answers itself: an
 *      open lock file cannot be deleted, so the attempt is the test.
 *
 * When none of those find a holder, the lock is a leftover and is removed.
 *
 * @returns true when a stale lock was found and cleared.
 */
export async function clearStaleLock(repoPath: string): Promise<boolean> {
  const lockPath = join(repoPath, 'repo.lock')

  let lockStat: Awaited<ReturnType<typeof stat>>
  try {
    lockStat = await stat(lockPath)
  } catch {
    return false // No lock, nothing to clear.
  }
  if (!lockStat.isFile()) return false

  // 1. A daemon that answers owns its lock. Do not go near it.
  const info = await readRepoInfo(repoPath)
  const candidates = [info?.liveApiUrl, info?.apiUrl].filter(
    (url): url is string => typeof url === 'string' && url !== ''
  )
  for (const url of candidates) {
    if (await apiAnswers(url)) return false
  }

  // 2. A lock touched moments ago may belong to a daemon still starting up.
  if (Date.now() - lockStat.mtimeMs < LOCK_GRACE_MS) return false

  // 3. Is anybody actually holding the file open?
  if (process.platform === 'win32') {
    // Windows refuses to delete a file a process holds open, so the delete is
    // itself the liveness test — and a safe one.
    try {
      await rm(lockPath, { force: false })
      return true
    } catch (err) {
      const code = errorCode(err)
      if (code === 'ENOENT') return false
      if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') return false
      throw plainError(
        `A leftover lock file at "${lockPath}" is stopping your node from starting, and it could not be ` +
          `removed. Restarting this computer will clear it. (${shortText(err)})`
      )
    }
  }

  if (await fileHeldByProcess(lockPath)) return false

  try {
    await rm(lockPath, { force: true })
  } catch (err) {
    throw plainError(
      `A leftover lock file at "${lockPath}" is stopping your node from starting, and it could not be ` +
        `removed. Check that you are allowed to change that folder. (${shortText(err)})`
    )
  }
  return true
}

/** POST `/api/v0/id`; true only when a real node answers. */
async function apiAnswers(apiUrl: string, timeoutMs = 3_000): Promise<boolean> {
  const controller = new AbortController()
  const timer = setTimer(() => controller.abort(), timeoutMs)
  timer.unref()
  try {
    const response = await fetch(`${apiUrl.replace(/\/+$/, '')}/api/v0/id`, {
      method: 'POST',
      headers: { 'user-agent': USER_AGENT, accept: 'application/json' },
      signal: controller.signal
    })
    await response.body?.cancel().catch(() => undefined)
    return response.ok
  } catch {
    return false
  } finally {
    clearTimer(timer)
  }
}

/**
 * Does any process have this file open?
 *
 * `lsof` is present on macOS and on most Linux desktops; `fuser` covers much of
 * the rest. When neither exists the honest answer is "cannot tell", and the
 * caller has already established that nothing is answering on the API and that
 * the lock is not fresh — at which point refusing to clear it would leave the
 * member with a node that can never start again, which is the worse of the two
 * mistakes.
 */
async function fileHeldByProcess(path: string): Promise<boolean> {
  const lsof = await runProcess('lsof', ['-t', '--', path], { timeoutMs: LOCK_PROBE_TIMEOUT_MS })
  if (!lsof.missing && lsof.code === 0) {
    return /\d/.test(lsof.stdout)
  }
  // lsof exits 1 when nothing holds the file — that is a real answer.
  if (!lsof.missing && lsof.code === 1 && lsof.stderr.trim() === '') return false

  const fuser = await runProcess('fuser', [path], { timeoutMs: LOCK_PROBE_TIMEOUT_MS })
  if (!fuser.missing && fuser.code === 0) {
    return /\d/.test(`${fuser.stdout}${fuser.stderr}`)
  }

  return false
}

/* -------------------------------------------------------------------------- */
/* record of what we installed                                                 */
/* -------------------------------------------------------------------------- */

/** Written beside the binary so a later run knows this install is ours. */
export interface InstallRecord {
  version: string
  binPath: string
  repoPath: string
  installedAt: string
}

export async function writeInstallRecord(path: string, record: InstallRecord): Promise<void> {
  await mkdir(dirname(path), { recursive: true }).catch(() => undefined)
  await writeFile(path, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
}

export async function readInstallRecord(path: string): Promise<InstallRecord | undefined> {
  const raw = await readFile(path, 'utf8').catch(() => undefined)
  if (raw === undefined) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch {
    return undefined
  }
  if (!isRecord(parsed)) return undefined

  const version = parsed['version']
  const binPath = parsed['binPath']
  const repoPath = parsed['repoPath']
  const installedAt = parsed['installedAt']
  if (typeof binPath !== 'string' || typeof repoPath !== 'string') return undefined

  return {
    version: typeof version === 'string' ? version : KUBO_DIST.version.replace(/^v/, ''),
    binPath,
    repoPath,
    installedAt: typeof installedAt === 'string' ? installedAt : new Date(0).toISOString()
  }
}
