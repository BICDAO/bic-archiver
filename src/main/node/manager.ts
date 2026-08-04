/**
 * The managed IPFS node: one button, one real provider.
 *
 * This is the module the whole community half of the app rests on. BIC's
 * measured problem is not that backups are missing — it is that nobody is
 * *serving* what BIC rescued. 428 CIDs were unreachable in the May-2026 sweep,
 * almost all of them assets pulled out of Arweave or web2 where BIC was the only
 * pinner, and two hosted services have already failed the archive: Storacha's
 * infrastructure is gone (NXDOMAIN), and Pinata's pin-by-CID is a paid feature
 * whose free tier could not hold 1.9 GB across 20,808 files anyway.
 *
 * The durable answer is members running their own nodes. Ten members is ten
 * providers, no subscription, and nothing anyone can switch off. That answer
 * only works if a non-technical member never has to open a terminal, which is
 * what {@link installAndStart} is: download, verify, initialise, configure,
 * start, and set to start again at login — and then *check the node actually
 * answers* before telling anybody it worked.
 *
 * Three rules run through everything here.
 *
 * **We never touch a node we did not install.** A member who already runs Kubo
 * (Homebrew, IPFS Desktop, their own build) gets used, not reconfigured. Their
 * node keeps its ports, its settings and its life expectancy; we report it as
 * `external`, with `managed: false`, and {@link uninstallNode} refuses outright.
 * The discriminator is the repository's own peer ID, compared with the one in
 * the repository *we* created — not a port number, which anything can occupy.
 *
 * **Nothing is reported as working until it answers.** Kubo can be installed,
 * configured, launched, and still not be running: a stale `repo.lock` blocks
 * every start silently, and a gateway port already taken by somebody's dev
 * server makes the daemon exit before it listens. Both are handled explicitly
 * rather than left to become a mystery.
 *
 * **Every failure is a sentence, not a stack trace.** The audience is a DAO
 * member who wants their NFTs to still exist in ten years, not a systems
 * administrator.
 */

import { spawn } from 'node:child_process'
import { rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { clearTimeout as clearTimer, setTimeout as setTimer } from 'node:timers'

import { app } from 'electron'

import {
  DEFAULT_STORAGE_MAX,
  KUBO_PLATFORMS,
  type ManagedNodeStatus,
  type NodeInstallProgress
} from '../../shared/node.js'
import { DEFAULT_PINNING_SETTINGS, type PinningSettings } from '../../shared/pinning.js'
import type { PinTargetStatus } from '../../shared/pinning.js'

import { detectKubo, repoStat } from '../pinning/kubo.js'
import { loadSettings, saveSettings } from '../settings.js'

import {
  disableAutostart,
  enableAutostart,
  isAutostartEnabled,
  recentLogTail,
  startViaServiceManager,
  stopViaServiceManager
} from './autostart.js'
import {
  clearStaleLock,
  describeBytes,
  downloadKubo,
  ensureRepo,
  isCancellation,
  isFile,
  kuboArtifact,
  kuboVersion,
  parseStorageMax,
  pathExists,
  plainError,
  platformKey,
  readInstallRecord,
  readRepoInfo,
  safeReport,
  writeInstallRecord,
  type RepoInfo
} from './install.js'

/* -------------------------------------------------------------------------- */
/* public types                                                                */
/* -------------------------------------------------------------------------- */

/** Where the managed node keeps its things. All inside the app's own folder. */
export interface NodePaths {
  /** Everything the managed node owns lives under here. */
  root: string
  binDir: string
  binPath: string
  repoPath: string
  /** Our proof that this install is ours, written after a successful set-up. */
  recordPath: string
}

export interface UninstallOptions {
  /**
   * Also delete the node's storage. Defaults to **false**: the repository holds
   * the member's copy of the archive, and re-downloading 1.9 GB because a button
   * was ambiguous is not a mistake worth risking.
   */
  removeRepo?: boolean
  signal?: AbortSignal
}

/* -------------------------------------------------------------------------- */
/* tunables                                                                    */
/* -------------------------------------------------------------------------- */

/** Kubo's default control port, and the one everything else assumes. */
const DEFAULT_API_PORT = 5001
/** Kubo's default gateway port — very often already taken on a laptop. */
const DEFAULT_GATEWAY_PORT = 8080
/** How far to look for a free port before giving up. */
const PORT_SEARCH_SPAN = 60

/** A daemon opens its datastore before it listens; on a big repo that is slow. */
const START_TIMEOUT_MS = 120_000
/**
 * How long to give the service manager before starting the daemon ourselves.
 *
 * Short, because this is the "launchctl said yes but nothing happened" case —
 * exactly the failure `launchctl load` is notorious for — and a member should
 * not wait out the full start-up budget twice before the fallback is tried.
 */
const SERVICE_START_WINDOW_MS = 45_000
const STOP_TIMEOUT_MS = 60_000
const POLL_INTERVAL_MS = 500

/** A local node answers instantly or is not well. */
const RPC_TIMEOUT_MS = 10_000

const USER_AGENT = 'bic-archiver/0.1 (node manager)'

/* -------------------------------------------------------------------------- */
/* where things live                                                           */
/* -------------------------------------------------------------------------- */

/**
 * The app's per-user data folder.
 *
 * Falls back to a dot-folder in the member's home directory when Electron is not
 * present, so importing this module can never be the thing that throws.
 */
function userDataDir(): string {
  try {
    if (app !== undefined && typeof app.getPath === 'function') {
      const dir = app.getPath('userData')
      if (typeof dir === 'string' && dir.trim() !== '') return dir
    }
  } catch {
    /* not running inside Electron */
  }
  return join(homedir(), '.bic-archiver')
}

/** Where the managed node's binary and storage live. */
export function nodePaths(): NodePaths {
  const root = join(userDataDir(), 'ipfs-node')
  const binDir = join(root, 'bin')
  const binName = process.platform === 'win32' ? 'ipfs.exe' : 'ipfs'
  return {
    root,
    binDir,
    binPath: join(binDir, binName),
    repoPath: join(root, 'repo'),
    recordPath: join(root, 'installed.json')
  }
}

/** Is this path inside the folder we own? Guards every delete. */
function isOurs(path: string, root: string): boolean {
  const target = resolve(path)
  const base = resolve(root)
  return target === base || target.startsWith(base + sep)
}

/* -------------------------------------------------------------------------- */
/* talking to a node                                                           */
/* -------------------------------------------------------------------------- */

function trimUrl(url: string): string {
  return url.replace(/\/+$/, '')
}

/** One POST to a node's RPC. Returns undefined for any failure at all. */
async function rpcJson(
  apiUrl: string,
  path: string,
  params: Record<string, string>,
  signal?: AbortSignal,
  timeoutMs = RPC_TIMEOUT_MS
): Promise<Record<string, unknown> | undefined> {
  const controller = new AbortController()
  const timer = setTimer(() => controller.abort(), timeoutMs)
  timer.unref()
  const onAbort = (): void => controller.abort()
  signal?.addEventListener('abort', onAbort, { once: true })

  try {
    const query = new URLSearchParams(params).toString()
    const url = `${trimUrl(apiUrl)}${path}${query === '' ? '' : `?${query}`}`
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'user-agent': USER_AGENT, accept: 'application/json' },
      signal: controller.signal
    })
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined)
      return undefined
    }
    const text = await response.text()
    const first = text.trim().split('\n', 1)[0] ?? ''
    const parsed: unknown = JSON.parse(first === '' ? text : first)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  } finally {
    clearTimer(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

/** Is a node answering here right now? */
async function apiAlive(apiUrl: string, signal?: AbortSignal, timeoutMs = 3_000): Promise<boolean> {
  return (await rpcJson(apiUrl, '/api/v0/id', {}, signal, timeoutMs)) !== undefined
}

async function rpcVersion(apiUrl: string, signal?: AbortSignal): Promise<string | undefined> {
  const body = await rpcJson(apiUrl, '/api/v0/version', {}, signal)
  const version = body?.['Version']
  return typeof version === 'string' && version.trim() !== '' ? version.trim() : undefined
}

/**
 * `Datastore.StorageMax`, read through the node's own API.
 *
 * A read, and only a read. An external node's configuration is never written by
 * this app — using somebody's node is not the same as taking it over.
 */
async function rpcStorageMax(apiUrl: string, signal?: AbortSignal): Promise<number | undefined> {
  const body = await rpcJson(apiUrl, '/api/v0/config', { arg: 'Datastore.StorageMax' }, signal)
  const value = body?.['Value']
  return typeof value === 'string' ? parseStorageMax(value) : undefined
}

async function repoSize(apiUrl: string, signal?: AbortSignal): Promise<number | undefined> {
  try {
    const stats = await repoStat(apiUrl, signal)
    return stats.repoSize
  } catch (err) {
    if (isCancellation(err)) throw err
    return undefined
  }
}

/** Wait until a node answers, or until we run out of patience. */
async function waitForApi(apiUrl: string, timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
  const until = Date.now() + timeoutMs
  for (;;) {
    if (signal?.aborted === true) {
      const err = new Error('This was cancelled.')
      err.name = 'AbortError'
      throw err
    }
    if (await apiAlive(apiUrl, signal, 2_000)) return true
    if (Date.now() >= until) return false
    await delay(POLL_INTERVAL_MS, signal)
  }
}

/** Wait until a node stops answering. */
async function waitForApiGone(apiUrl: string, timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
  const until = Date.now() + timeoutMs
  for (;;) {
    if (!(await apiAlive(apiUrl, signal, 2_000))) return true
    if (Date.now() >= until) return false
    await delay(POLL_INTERVAL_MS, signal)
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolveDelay) => {
    const timer = setTimer(() => {
      signal?.removeEventListener('abort', onAbort)
      resolveDelay()
    }, ms)
    timer.unref()
    const onAbort = (): void => {
      clearTimer(timer)
      resolveDelay()
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/* -------------------------------------------------------------------------- */
/* ports                                                                       */
/* -------------------------------------------------------------------------- */

/** Can we bind this port on the loopback address? */
function isPortFree(port: number): Promise<boolean> {
  return new Promise<boolean>((resolvePort) => {
    const server = createServer()
    server.once('error', () => resolvePort(false))
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
      server.close(() => resolvePort(true))
    })
  })
}

async function firstFreePort(start: number, span: number): Promise<number | undefined> {
  for (let port = start; port < start + span; port += 1) {
    if (port > 65_535) break
    if (await isPortFree(port)) return port
  }
  return undefined
}

interface PortChoice {
  port: number
  /** Set when we had to move off the usual port; shown to the member. */
  detail?: string
}

/**
 * Which control port the managed node should use.
 *
 * The usual answer is 5001. It stops being the answer when something else has
 * that port — most often the member's *own* IPFS node, occasionally an unrelated
 * program. Either way we move, record where we moved to, and say so, because a
 * node quietly listening somewhere the rest of the app is not looking is exactly
 * the kind of silent wrongness this project exists to stamp out.
 */
async function chooseApiPort(
  ourPeerId: string | undefined,
  configuredPort: number | undefined,
  signal?: AbortSignal
): Promise<PortChoice> {
  const preferred = configuredPort ?? DEFAULT_API_PORT

  if (await isPortFree(preferred)) return { port: preferred }

  // Occupied — but possibly by our own node, which is not a conflict.
  const probe = await detectKubo(`http://127.0.0.1:${preferred}`, signal)
  if (probe.available && ourPeerId !== undefined && probe.peerId === ourPeerId) {
    return { port: preferred }
  }

  const replacement = await firstFreePort(preferred + 1, PORT_SEARCH_SPAN)
  if (replacement === undefined) {
    throw plainError(
      `Port ${preferred} on this computer is already in use, and so is every port just after it, so the ` +
        'app could not find one for your node. Closing some other programs and trying again should fix it.'
    )
  }

  return {
    port: replacement,
    detail: probe.available
      ? `Another IPFS node is already using port ${preferred} on this computer, so your node was given ` +
        `port ${replacement} instead. Both can run side by side.`
      : `Port ${preferred} is already in use by another program, so your node was given port ${replacement} ` +
        'instead. Nothing else needs changing — the app has remembered the new address.'
  }
}

/**
 * Which gateway port the managed node should use.
 *
 * Kubo's default is 8080, which on a laptop that has ever run a web project is
 * very likely taken — and when it is, the daemon exits during start-up with a
 * bind error, having already looked to the member like it installed perfectly.
 */
async function chooseGatewayPort(configuredPort: number | undefined): Promise<PortChoice> {
  const preferred = configuredPort ?? DEFAULT_GATEWAY_PORT
  if (await isPortFree(preferred)) return { port: preferred }

  const replacement = await firstFreePort(preferred + 1, PORT_SEARCH_SPAN)
  if (replacement === undefined) {
    return { port: preferred }
  }
  return {
    port: replacement,
    detail:
      `Port ${preferred} is already in use on this computer, so your node was given port ${replacement} ` +
      'for its web address instead.'
  }
}

function portOfUrl(url: string | undefined): number | undefined {
  if (url === undefined) return undefined
  try {
    const parsed = new URL(url)
    const port = Number(parsed.port)
    return Number.isInteger(port) && port > 0 ? port : undefined
  } catch {
    return undefined
  }
}

/* -------------------------------------------------------------------------- */
/* status                                                                      */
/* -------------------------------------------------------------------------- */

const DEFAULT_API_URL = DEFAULT_PINNING_SETTINGS.kubo.apiUrl

function configuredApiUrl(settings: PinningSettings | undefined): string {
  const raw = settings?.kubo?.apiUrl
  if (typeof raw !== 'string' || raw.trim() === '') return DEFAULT_API_URL
  try {
    const parsed = new URL(raw.trim())
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return DEFAULT_API_URL
    return trimUrl(raw.trim())
  } catch {
    return DEFAULT_API_URL
  }
}

/**
 * Is every way of reaching this node a relay?
 *
 * A `/p2p-circuit` address means another computer is passing traffic on the
 * node's behalf because nothing can dial it directly — the normal state of a
 * machine behind a home router. The node still serves the archive, so this is
 * not a failure, but it is slower and less reliable than a direct connection and
 * a member deserves to know which of the two they are providing.
 */
function isRelayOnly(multiaddrs: readonly string[] | undefined): boolean {
  if (multiaddrs === undefined || multiaddrs.length === 0) return false
  return multiaddrs.every((addr) => addr.includes('/p2p-circuit'))
}

const RELAY_ONLY_DETAIL =
  'Your node can only be reached through relays — other computers passing traffic on its behalf — because ' +
  'your router does not allow direct connections to it. It is still serving the archive, just more slowly ' +
  'and less reliably than a node others can reach directly. Allowing incoming connections on port 4001 ' +
  'to this computer would make it a stronger provider.'

function joinDetails(parts: ReadonlyArray<string | undefined>): string | undefined {
  const kept = parts
    .map((part) => (typeof part === 'string' ? part.trim() : ''))
    .filter((part) => part !== '')
  return kept.length === 0 ? undefined : kept.join(' ')
}

/** Build the status of a node that is answering right now. */
async function runningStatus(
  apiUrl: string,
  probe: PinTargetStatus,
  options: {
    managed: boolean
    repoPath?: string
    autostart: boolean
    storageMaxBytes?: number
    extraDetail?: string
  },
  signal?: AbortSignal
): Promise<ManagedNodeStatus> {
  const [version, size, storageMax] = await Promise.all([
    rpcVersion(apiUrl, signal),
    repoSize(apiUrl, signal),
    options.storageMaxBytes === undefined ? rpcStorageMax(apiUrl, signal) : Promise.resolve(options.storageMaxBytes)
  ])

  const multiaddrs = probe.multiaddrs ?? []
  const detail = joinDetails([
    options.extraDetail,
    isRelayOnly(multiaddrs) ? RELAY_ONLY_DETAIL : undefined,
    // `detectKubo` explains the "only reachable on your own network" cases, which
    // are worth repeating verbatim rather than paraphrasing.
    isRelayOnly(multiaddrs) ? undefined : probe.detail,
    options.managed && !options.autostart
      ? 'Your node is not set to start when you log in, so it will stop when this computer restarts.'
      : undefined
  ])

  const status: ManagedNodeStatus = {
    state: options.managed ? 'running' : 'external',
    managed: options.managed,
    apiUrl,
    autostart: options.autostart
  }
  if (version !== undefined) status.version = version
  if (probe.peerId !== undefined) status.peerId = probe.peerId
  if (options.repoPath !== undefined) status.repoPath = options.repoPath
  if (size !== undefined) status.repoSizeBytes = size
  if (storageMax !== undefined) status.storageMaxBytes = storageMax
  if (multiaddrs.length > 0) status.multiaddrs = multiaddrs
  if (detail !== undefined) status.detail = detail
  return status
}

const EXTERNAL_DETAIL =
  'This IPFS node was set up outside this app, so the app uses it but will never change, stop or remove ' +
  'it. Everything you archive here is stored in that node.'

/**
 * What the member's node situation is right now.
 *
 * Tells a node we installed apart from one they already had, which is the
 * distinction every other operation depends on: our node we start, stop,
 * configure and can uninstall; theirs we use and leave completely alone.
 *
 * Never throws for an unreachable or missing node — that is an answer, and it is
 * in `state` and `detail`. Throws an `Error` with `name === 'AbortError'` only
 * if `signal` is aborted.
 */
export async function getNodeStatus(
  settings: PinningSettings,
  signal?: AbortSignal
): Promise<ManagedNodeStatus> {
  const paths = nodePaths()
  const configured = configuredApiUrl(settings)

  const [record, binExists, repo] = await Promise.all([
    readInstallRecord(paths.recordPath),
    isFile(paths.binPath),
    readRepoInfo(paths.repoPath)
  ])

  const autostart = await isAutostartEnabled()
  const ourApiUrl = repo?.liveApiUrl ?? repo?.apiUrl ?? configured
  const ourPeerId = repo?.peerId

  /* ---- a node we installed ------------------------------------------- */
  if (record !== undefined && binExists) {
    const probe = await detectKubo(ourApiUrl, signal)
    const isOurNode = probe.available && (ourPeerId === undefined || probe.peerId === ourPeerId)

    if (isOurNode) {
      return runningStatus(
        ourApiUrl,
        probe,
        {
          managed: true,
          repoPath: paths.repoPath,
          autostart,
          ...(repo?.storageMaxBytes === undefined ? {} : { storageMaxBytes: repo.storageMaxBytes })
        },
        signal
      )
    }

    // Installed, but not answering. Work out which flavour of "not answering".
    const stolenPort =
      probe.available && ourPeerId !== undefined && probe.peerId !== ourPeerId
        ? `Another IPFS node is using ${ourApiUrl}, which is where your node expects to be. ` +
          'Starting your node will move it to a free port automatically.'
        : undefined

    const status: ManagedNodeStatus = {
      state: 'installed-stopped',
      managed: true,
      apiUrl: ourApiUrl,
      repoPath: paths.repoPath,
      autostart,
      version: record.version,
      detail: joinDetails([
        'Your IPFS node is installed but is not running, so nothing on this computer is serving the archive right now.',
        stolenPort,
        autostart
          ? undefined
          : 'It is also not set to start when you log in — turning that on is what keeps the archive available.'
      ])
    }
    if (repo?.storageMaxBytes !== undefined) status.storageMaxBytes = repo.storageMaxBytes
    return status
  }

  /* ---- a node the member already had ---------------------------------- */
  const externalProbe = await detectKubo(configured, signal)
  if (externalProbe.available) {
    return runningStatus(
      configured,
      externalProbe,
      { managed: false, autostart: false, extraDetail: EXTERNAL_DETAIL },
      signal
    )
  }

  /* ---- nothing at all -------------------------------------------------- */
  if (KUBO_PLATFORMS[platformKey()] === undefined) {
    return {
      state: 'error',
      managed: false,
      apiUrl: configured,
      autostart: false,
      detail:
        `This app cannot set up an IPFS node on this kind of computer (${platformKey()}). ` +
        'You can still make backups and check what is at risk; serving the archive needs a computer running ' +
        'macOS, Windows or Linux.'
    }
  }

  const halfInstalled = record !== undefined || (await pathExists(paths.repoPath))
  return {
    state: 'not-installed',
    managed: false,
    apiUrl: configured,
    autostart: false,
    detail: halfInstalled
      ? 'A previous set-up did not finish, so there is no working IPFS node on this computer yet. ' +
        'Setting it up again will pick up where it left off.'
      : 'There is no IPFS node on this computer yet. Setting one up is what turns your copy of the archive ' +
        'into one other people can actually get files from.'
  }
}

/* -------------------------------------------------------------------------- */
/* starting and stopping                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Start the daemon.
 *
 * Preferred route is the platform's service manager, because a process launchd
 * or systemd owns keeps running after this app quits — which is the entire
 * point. The detached spawn is the fallback for Windows and for a machine where
 * the login item could not be installed; `detached` plus `unref` still outlives
 * the app, it just has nothing watching it.
 */
async function launchDaemon(
  binPath: string,
  repoPath: string,
  apiUrl: string,
  signal?: AbortSignal
): Promise<void> {
  if (await startViaServiceManager()) {
    if (await waitForApi(apiUrl, SERVICE_START_WINDOW_MS, signal)) return
  }

  try {
    const child = spawn(binPath, ['daemon'], {
      env: { ...process.env, IPFS_PATH: repoPath },
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    })
    child.on('error', (err) => {
      console.warn('[bic-archiver] the IPFS node could not be started:', err)
    })
    child.unref()
  } catch (err) {
    throw plainError(
      `The IPFS program at "${binPath}" could not be started. It may have been removed, or blocked by ` +
        `security software. (${err instanceof Error ? err.message : String(err)})`
    )
  }

  if (await waitForApi(apiUrl, START_TIMEOUT_MS, signal)) return

  const tail = await recentLogTail()
  throw plainError(
    'Your IPFS node was started but never answered, so it is not serving anything yet. ' +
      'That usually means another program is using one of the ports it needs, or its storage folder is in ' +
      'use by another copy of IPFS. Try again, and if it keeps happening restart this computer first. ' +
      (tail === undefined ? '' : `The node’s log ends with: ${tail}`)
  )
}

/**
 * Start the member's node.
 *
 * Clears a stale lock first — the failure that otherwise blocks every start
 * silently — and confirms the node answers before claiming success.
 */
export async function startNode(signal?: AbortSignal): Promise<ManagedNodeStatus> {
  const settings = await loadSettings()
  const status = await getNodeStatus(settings, signal)

  if (status.state === 'running' || status.state === 'external') return status
  if (status.state === 'not-installed' || status.state === 'error') {
    throw plainError(
      'There is no IPFS node on this computer to start yet. Set one up first — the app does the whole thing ' +
        'for you.'
    )
  }

  const paths = nodePaths()
  await clearStaleLock(paths.repoPath)
  await launchDaemon(paths.binPath, paths.repoPath, status.apiUrl, signal)
  return getNodeStatus(await loadSettings(), signal)
}

/**
 * Stop the member's node.
 *
 * The service manager has to be told *first*. `KeepAlive` on macOS and
 * `Restart=always` on Linux exist so a crashed node comes back, and they cannot
 * tell a crash from us killing it — stop the process without stopping the
 * service and it is simply running again a few seconds later.
 *
 * Refuses to stop a node this app did not install.
 */
export async function stopNode(signal?: AbortSignal): Promise<ManagedNodeStatus> {
  const settings = await loadSettings()
  const status = await getNodeStatus(settings, signal)

  if (status.state === 'external') {
    throw plainError(
      'That IPFS node was not set up by this app, so this app will not stop it. ' +
        'Whatever you used to install it — Homebrew, IPFS Desktop, or your own set-up — is what controls it.'
    )
  }
  if (status.state !== 'running') return status

  await stopViaServiceManager()

  if (await apiAlive(status.apiUrl, signal)) {
    // Kubo's own "shut down cleanly" command; a clean stop flushes the
    // datastore, which an outright kill does not.
    await rpcJson(status.apiUrl, '/api/v0/shutdown', {}, signal)
  }

  const gone = await waitForApiGone(status.apiUrl, STOP_TIMEOUT_MS, signal)
  const next = await getNodeStatus(await loadSettings(), signal)

  if (!gone && next.state === 'running') {
    return {
      ...next,
      detail: joinDetails([
        'Your IPFS node did not stop when it was asked to. It is still running and still serving the archive.',
        next.detail
      ])
    }
  }
  return next
}

/* -------------------------------------------------------------------------- */
/* install                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The one call behind the member-facing button: get this computer serving the
 * archive, from whatever state it is currently in.
 *
 * Download, verify, unpack, initialise, configure, clear any leftover lock,
 * start, set to start at login — and then confirm the node actually answers
 * before reporting success. Idempotent: safe to call when everything is already
 * done, when a previous attempt died half way, and when the member already runs
 * a node of their own (in which case nothing is installed at all, because theirs
 * already does the job and taking it over is not ours to do).
 *
 * @throws A plain-English `Error` if the node could not be made to work.
 * @throws An `Error` with `name === 'AbortError'` if `signal` is aborted.
 */
export async function installAndStart(
  onProgress: (p: NodeInstallProgress) => void,
  signal?: AbortSignal
): Promise<ManagedNodeStatus> {
  const report = (progress: NodeInstallProgress): void => safeReport(onProgress, progress)

  try {
    report({ phase: 'checking', message: 'Checking what is already on this computer…', progress: 0 })

    // Throws a plain, specific message on a platform Kubo has no build for,
    // which is a better answer than a download that 404s.
    const artifact = kuboArtifact()
    const paths = nodePaths()
    report({
      phase: 'checking',
      message: `Setting up IPFS ${artifact.version} for ${process.platform === 'darwin' ? 'macOS' : process.platform === 'win32' ? 'Windows' : 'Linux'}…`
    })

    let settings = await loadSettings()
    const existing = await getNodeStatus(settings, signal)

    /* ---- somebody else's node is already doing the job ----------------- */
    if (existing.state === 'external') {
      report({
        phase: 'done',
        message: 'This computer already runs its own IPFS node, so nothing needed installing.',
        progress: 1
      })
      return existing
    }

    /* ---- ours is already running -------------------------------------- */
    if (existing.state === 'running' && existing.managed) {
      if (!existing.autostart) {
        report({ phase: 'autostart', message: 'Setting your node to start when you log in…' })
        const note = await tryEnableAutostart(paths.binPath, paths.repoPath)
        const refreshed = await getNodeStatus(settings, signal)
        report({ phase: 'done', message: 'Your node is running and serving the archive.', progress: 1 })
        return note === undefined ? refreshed : { ...refreshed, detail: joinDetails([note, refreshed.detail]) }
      }
      report({ phase: 'done', message: 'Your node is already running and serving the archive.', progress: 1 })
      return existing
    }

    /* ---- the program itself -------------------------------------------- */
    let version = await kuboVersion(paths.binPath, signal)
    if (version === undefined) {
      const installed = await downloadKubo(paths.binDir, report, signal)
      version = installed.version
    } else {
      report({
        phase: 'checking',
        message: `IPFS ${version} is already installed here, so there is nothing to download.`
      })
    }

    /* ---- a lock left behind by a hard shutdown -------------------------- */
    // Before anything touches the repository: a leftover `repo.lock` blocks
    // `ipfs init`, `ipfs config` and every daemon start, silently and without
    // writing a word to any log.
    const clearedBefore = await clearStaleLock(paths.repoPath)

    /* ---- ports ---------------------------------------------------------- */
    const repoBefore = await readRepoInfo(paths.repoPath)
    const apiChoice = await chooseApiPort(repoBefore?.peerId, portOfUrl(repoBefore?.apiUrl), signal)
    const gatewayChoice = await chooseGatewayPort(portOfUrl(repoBefore?.gatewayUrl))

    /* ---- the repository -------------------------------------------------- */
    await ensureRepo(paths.binPath, paths.repoPath, report, signal, {
      apiPort: apiChoice.port,
      gatewayPort: gatewayChoice.port,
      storageMaxBytes: DEFAULT_STORAGE_MAX
    })

    await writeInstallRecord(paths.recordPath, {
      version,
      binPath: paths.binPath,
      repoPath: paths.repoPath,
      installedAt: new Date().toISOString()
    })

    /* ---- remember where the node lives ------------------------------------ */
    const apiUrl = `http://127.0.0.1:${apiChoice.port}`
    if (configuredApiUrl(settings) !== apiUrl || !settings.kubo.enabled) {
      const next: PinningSettings = {
        ...settings,
        kubo: { ...settings.kubo, enabled: true, apiUrl }
      }
      await saveSettings(next)
      settings = next
    }

    /* ---- start at login --------------------------------------------------- */
    report({ phase: 'autostart', message: 'Setting your node to start when you log in…' })
    const autostartNote = await tryEnableAutostart(paths.binPath, paths.repoPath)

    /* ---- start now -------------------------------------------------------- */
    report({ phase: 'starting', message: 'Starting your node…' })
    await clearStaleLock(paths.repoPath)
    await launchDaemon(paths.binPath, paths.repoPath, apiUrl, signal)

    const status = await getNodeStatus(settings, signal)
    const detail = joinDetails([
      apiChoice.detail,
      gatewayChoice.detail,
      clearedBefore
        ? 'A leftover lock file from a previous shutdown was cleared — that is what had been stopping the ' +
          'node from starting.'
        : undefined,
      autostartNote,
      status.detail
    ])

    report({
      phase: 'done',
      message: 'Your node is running. This computer is now serving the archive.',
      progress: 1
    })

    return detail === undefined ? status : { ...status, detail }
  } catch (err) {
    if (isCancellation(err)) {
      report({ phase: 'error', message: 'Setting up your node was cancelled. Nothing has been left running.' })
      throw err
    }
    const message = err instanceof Error ? err.message : String(err)
    report({ phase: 'error', message })
    throw err instanceof Error ? err : plainError(message)
  }
}

/**
 * Enable autostart, treating a refusal as a caveat rather than a failure.
 *
 * A node that runs but does not survive a reboot is still worth having; failing
 * the whole installation over the login item would leave the member with
 * nothing at all.
 */
async function tryEnableAutostart(binPath: string, repoPath: string): Promise<string | undefined> {
  try {
    await enableAutostart(binPath, repoPath)
    return undefined
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.warn('[bic-archiver] could not set the IPFS node to start at login:', message)
    return message
  }
}

/* -------------------------------------------------------------------------- */
/* uninstall                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Remove the node this app installed.
 *
 * Refuses, loudly, to touch a node the member set up themselves — including its
 * repository. The member's archive copy is kept by default: `removeRepo` has to
 * be asked for explicitly, because the repository is where 1.9 GB of rescued
 * NFTs live and "uninstall the program" is not the same request as "delete the
 * archive".
 */
export async function uninstallNode(options: UninstallOptions = {}): Promise<ManagedNodeStatus> {
  const { signal } = options
  const paths = nodePaths()
  const settings = await loadSettings()
  const status = await getNodeStatus(settings, signal)

  // Only an `external` node is somebody else's to keep. `not-installed` and
  // `error` mean there is nothing of ours here, and the cleanup below is then a
  // harmless no-op rather than something to refuse.
  if (status.state === 'external') {
    throw plainError(
      'That IPFS node was not set up by this app, so this app will not remove it. ' +
        'Uninstall it the same way it was installed — Homebrew, IPFS Desktop, or however it was set up.'
    )
  }

  const record = await readInstallRecord(paths.recordPath)

  // Stop the login item first, then the process, or KeepAlive brings it back
  // while we are deleting the very binary it is running.
  await disableAutostart().catch(() => undefined)
  if (await apiAlive(status.apiUrl, signal)) {
    await rpcJson(status.apiUrl, '/api/v0/shutdown', {}, signal)
    await waitForApiGone(status.apiUrl, STOP_TIMEOUT_MS, signal)
  }

  if (isOurs(paths.binDir, paths.root)) {
    await rm(paths.binDir, { recursive: true, force: true }).catch((err: unknown) => {
      throw plainError(
        `The app’s copy of IPFS at "${paths.binDir}" could not be removed. ` +
          `Check that it is not running, then try again. (${err instanceof Error ? err.message : String(err)})`
      )
    })
  }
  await rm(paths.recordPath, { force: true }).catch(() => undefined)

  let repoNote: string
  const repoIsOurs =
    isOurs(paths.repoPath, paths.root) &&
    (record === undefined || resolve(record.repoPath) === resolve(paths.repoPath))

  if (options.removeRepo === true && repoIsOurs) {
    await rm(paths.repoPath, { recursive: true, force: true }).catch((err: unknown) => {
      throw plainError(
        `Your node’s storage at "${paths.repoPath}" could not be removed. ` +
          `(${err instanceof Error ? err.message : String(err)})`
      )
    })
    repoNote = 'Your node and everything it was storing have been removed.'
  } else if (await pathExists(paths.repoPath)) {
    const kept = await folderNote(paths.repoPath)
    repoNote =
      'Your node has been removed. Your copy of the archive is still on this disk at ' +
      `"${paths.repoPath}"${kept}, so nothing has been lost — but nothing on this computer is serving it now.`
  } else {
    repoNote = 'Your node has been removed.'
  }

  return {
    state: 'not-installed',
    managed: false,
    apiUrl: configuredApiUrl(settings),
    autostart: false,
    detail: repoNote
  }
}

/** " (about 1.8 GB)", when the size is worth mentioning. */
async function folderNote(path: string): Promise<string> {
  const info = await readRepoInfo(path)
  if (info?.storageMaxBytes === undefined) return ''
  return ` (set to hold up to ${describeBytes(info.storageMaxBytes)})`
}

/* -------------------------------------------------------------------------- */
/* re-exports the rest of the main process is likely to want                    */
/* -------------------------------------------------------------------------- */

export type { RepoInfo }
export { nodePaths as managedNodePaths }
