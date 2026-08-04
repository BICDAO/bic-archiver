/**
 * Settings and credential storage. MAIN PROCESS ONLY.
 *
 * Two things live here, deliberately kept apart:
 *
 *   settings.json         the member's pinning preferences, plain JSON, written
 *                         atomically so a crash cannot corrupt it
 *   pinata-token.enc      the Pinata JWT, encrypted by the operating system's
 *                         own credential store via Electron `safeStorage`
 *
 * The token is NEVER written into settings.json, never returned to the renderer,
 * and never put into a log line or an error message. `PinningSettings.pinata`
 * carries only `hasToken: boolean`, and even that is treated as *derived* state:
 * whatever the JSON file claims is ignored on load and recomputed from whether a
 * token can actually be decrypted right now. A settings file copied between
 * machines therefore cannot make the app believe it holds a key it does not
 * have.
 *
 * The one decision worth spelling out is the refusal path. `safeStorage` can
 * report that no encryption is available — a Linux session with no keyring
 * running — and on Linux it can also fall back to a `basic_text` backend, which
 * scrambles data with a value anyone can look up and is therefore no better than
 * plain text. In both cases this module REFUSES to store the token rather than
 * quietly writing a bearer credential somewhere readable. A leaked JWT lets
 * anyone act on the DAO's Pinata account: unpin content, burn the quota, upload
 * whatever they like. Losing the convenience of a saved key costs a member one
 * paste per session; losing the key itself costs the DAO its pinning account.
 * The member keeps both fallbacks — a local Kubo node needs no credential at
 * all, and {@link SettingsStore.useTokenThisSessionOnly} holds a pasted key in
 * memory for as long as the app is open.
 */

import { mkdir, open as openFile, readFile, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { app, safeStorage } from 'electron'

import { DEFAULT_PINNING_SETTINGS, type PinningSettings } from '../shared/pinning.js'

/** Plain JSON preferences, inside Electron's per-app `userData` folder. */
const SETTINGS_FILE = 'settings.json'
/** The encrypted Pinata JWT, base64 of the `safeStorage` ciphertext. */
const TOKEN_FILE = 'pinata-token.enc'
/** Owner read/write only. Ignored on Windows, where the ACL on userData applies. */
const SECRET_FILE_MODE = 0o600

/* ========================================================================== */
/* Plain-English errors, with secrets stripped                                */
/* ========================================================================== */

/** An error whose message is already written for a non-technical member. */
function plain(message: string, cause?: unknown): Error {
  const err = cause === undefined ? new Error(message) : new Error(message, { cause })
  err.name = 'ArchiverError'
  return err
}

/** JWTs, as Pinata issues them: three base64url segments starting `eyJ`. */
const JWT_PATTERN = /eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g
/** `Authorization: Bearer …` as it appears in fetch/undici error text. */
const BEARER_PATTERN = /\b(bearer|authorization:?)\s+\S+/gi
/** Credentials smuggled into a query string. */
const QUERY_SECRET_PATTERN = /([?&](?:token|jwt|key|api_?key|access_token|secret)=)[^&\s]+/gi

/** What replaces a secret once it has been stripped out. */
const HIDDEN = '[key hidden]'

/**
 * Remove anything token-shaped from text that is about to be shown or logged.
 *
 * This is a safety net, not the primary defence: no code path here ever puts the
 * token into a message in the first place. It exists because error text from
 * `fetch`, `undici` and Pinata itself sometimes echoes the request headers or
 * URL back at you, and a member pasting an error into a support chat must not be
 * pasting the DAO's credential with it.
 */
export function redactSecrets(text: string): string {
  return String(text ?? '')
    .replace(BEARER_PATTERN, (_match, label: string) => `${label} ${HIDDEN}`)
    .replace(QUERY_SECRET_PATTERN, (_match, label: string) => `${label}${HIDDEN}`)
    .replace(JWT_PATTERN, HIDDEN)
}

function errorText(err: unknown): string {
  return redactSecrets(err instanceof Error ? err.message : String(err))
}

/* ========================================================================== */
/* Messages the GUI shows                                                     */
/* ========================================================================== */

/** The alternatives a member always has when a key cannot be stored. */
const ALTERNATIVES =
  'You can still pin to your own IPFS (Kubo) node, which needs no key at all, or paste the Pinata key ' +
  'again each time you open the app — pasted that way it is held in memory only and forgotten when you quit.'

const NO_SECURE_STORAGE_MESSAGE =
  'This computer has no secure place to keep the Pinata key, so nothing has been saved. ' +
  "On Linux this usually means the desktop's password store (GNOME Keyring or KWallet) is not running; " +
  'on other systems it means the app could not reach the system keychain. ' +
  ALTERNATIVES +
  ' The app will not write the key into an ordinary file, because anything able to read that file could then use the ' +
  "DAO's Pinata account."

const WEAK_STORAGE_MESSAGE =
  'This computer is not offering a real password store, so the Pinata key could only be scrambled with a value ' +
  'anyone can look up — no safer than saving it in plain text. Nothing has been saved. ' +
  'Starting your desktop keyring (GNOME Keyring or KWallet) and trying again will fix this. ' +
  ALTERNATIVES

const NOT_IN_APP_MESSAGE =
  'Internal error: the settings store was used outside the app process, where the system keychain is not available.'

/* ========================================================================== */
/* Small helpers                                                              */
/* ========================================================================== */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

/** Read a file, treating "not there" as a normal, quiet outcome. */
async function readIfPresent(path: string, label: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch (err) {
    const code = isRecord(err) ? err['code'] : undefined
    if (code !== 'ENOENT') {
      // Worth knowing about (a permissions problem, a broken disk) but never
      // worth failing a read over: defaults are always a usable answer.
      console.warn(`[bic-archiver] could not read ${label}: ${errorText(err)}`)
    }
    return undefined
  }
}

/**
 * A Kubo RPC address we are willing to talk to.
 *
 * Anything that is not an http(s) URL is dropped in favour of the default, so a
 * hand-edited settings file cannot point the app at `file:` or an unusable
 * string. The trailing slash goes because every caller appends `/api/v0/…`.
 */
function cleanApiUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  if (text === '') return undefined
  let parsed: URL
  try {
    parsed = new URL(text)
  } catch {
    return undefined
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined
  return text.replace(/\/+$/, '')
}

/** A member's dedicated Pinata gateway, e.g. `https://x.mypinata.cloud`. */
function cleanGateway(value: unknown): string | undefined {
  const url = cleanApiUrl(value)
  return url === undefined ? undefined : url
}

/**
 * Does this object hold a field that looks like a stored credential?
 *
 * Only non-empty *string* values count, so the legitimate `hasToken: boolean`
 * never trips it. Used to detect — and then scrub — a settings file written by
 * something that should not have put a secret there.
 */
const SECRET_KEY_PATTERN = /token|jwt|secret|password|api[_-]?key|bearer|credential/i

function containsSecretField(value: Record<string, unknown>): boolean {
  for (const [key, entry] of Object.entries(value)) {
    if (key === 'hasToken') continue
    if (typeof entry === 'string' && entry.trim() !== '' && SECRET_KEY_PATTERN.test(key)) return true
  }
  return false
}

/**
 * Turn whatever was on disk into settings the app can rely on.
 *
 * Every field is taken only if it is the right type and passes its own sanity
 * check; anything else falls back to {@link DEFAULT_PINNING_SETTINGS}. A file
 * that is truncated, hand-edited, from an older build, or outright garbage
 * therefore yields working settings rather than an exception — losing a
 * preference is a shrug, refusing to start is not.
 *
 * `pinata.hasToken` is deliberately NOT read from disk. It is recomputed by the
 * caller from the encrypted token file, so the JSON can never claim a key that
 * is not really there.
 */
function normalizeSettings(value: unknown): { settings: PinningSettings; hadSecret: boolean } {
  const settings = structuredClone(DEFAULT_PINNING_SETTINGS)
  if (!isRecord(value)) return { settings, hadSecret: false }

  let hadSecret = containsSecretField(value)

  const kubo = value['kubo']
  if (isRecord(kubo)) {
    if (typeof kubo['enabled'] === 'boolean') settings.kubo.enabled = kubo['enabled']
    const apiUrl = cleanApiUrl(kubo['apiUrl'])
    if (apiUrl !== undefined) settings.kubo.apiUrl = apiUrl
    if (containsSecretField(kubo)) hadSecret = true
  }

  const pinata = value['pinata']
  if (isRecord(pinata)) {
    if (typeof pinata['enabled'] === 'boolean') settings.pinata.enabled = pinata['enabled']
    const gateway = cleanGateway(pinata['gateway'])
    if (gateway !== undefined) settings.pinata.gateway = gateway
    if (containsSecretField(pinata)) hadSecret = true
  }

  if (typeof value['pinOnImport'] === 'boolean') settings.pinOnImport = value['pinOnImport']

  return { settings, hadSecret }
}

/* ========================================================================== */
/* The store                                                                  */
/* ========================================================================== */

/**
 * The slice of Electron's `safeStorage` this module uses. Declared structurally
 * so the store can be pointed at a stand-in during tests without ever loosening
 * what the real app does.
 */
export interface SecureStorage {
  isEncryptionAvailable(): boolean
  encryptString(plainText: string): Buffer
  decryptString(encrypted: Buffer): string
  /** Linux only; `basic_text` means the "encryption" is not real. */
  getSelectedStorageBackend?(): string
}

export interface SettingsStoreOptions {
  /** Folder to keep the files in. Defaults to Electron's `userData`. */
  directory?: string
  /** Credential store to use. Defaults to Electron's `safeStorage`. */
  secureStorage?: SecureStorage
}

/** Whether a credential can be stored securely right now, and if not, why not. */
export interface SecureStorageStatus {
  available: boolean
  /** Plain English, safe to show a member. Present only when unavailable. */
  reason?: string
}

export class SettingsStore {
  readonly #directoryOverride: string | undefined
  readonly #secureOverride: SecureStorage | undefined

  /** Serialises every write so two saves can never interleave. */
  #writes: Promise<void> = Promise.resolve()

  /**
   * A key pasted for this session only, never written to disk. Set when secure
   * storage is unavailable, or when a member prefers not to save the key.
   */
  #sessionToken: string | null = null

  /**
   * The decrypted stored key, kept so repeated pin operations do not hit the
   * system keychain (and, on Linux, possibly prompt) once per CID.
   *
   * Only ever holds a *successful* read. A failure is deliberately not cached:
   * a keyring that was locked when the app started can be unlocked a minute
   * later, and remembering "there is no key" would leave the member re-entering
   * one they have already given us for the rest of the session.
   */
  #storedToken: string | null = null

  constructor(options: SettingsStoreOptions = {}) {
    // Resolved lazily: `app.getPath` is only meaningful inside Electron, and
    // constructing this object must never be the thing that throws.
    this.#directoryOverride = options.directory
    this.#secureOverride = options.secureStorage
  }

  /* ---------------------------------------------------------------------- */
  /* Settings                                                               */
  /* ---------------------------------------------------------------------- */

  /**
   * The member's pinning preferences, with defaults filled in.
   *
   * Never throws for a bad file: a missing, truncated, or corrupt settings file
   * yields {@link DEFAULT_PINNING_SETTINGS} merged with whatever fields were
   * still readable. `pinata.hasToken` is always the live answer — true only if a
   * key can actually be decrypted, or one was pasted for this session.
   */
  async loadSettings(): Promise<PinningSettings> {
    const text = await readIfPresent(this.settingsPath, 'the settings file')
    const parsed = text === undefined ? undefined : tryParse(text)

    if (text !== undefined && parsed === undefined) {
      console.warn('[bic-archiver] the settings file could not be read as JSON; using default settings')
    }

    const { settings, hadSecret } = normalizeSettings(parsed)
    const storedToken = await this.#readStoredToken()

    if (hadSecret) {
      // Something wrote a credential into the plain JSON file. Take it out of
      // the object being returned (normalizeSettings already did) and off the
      // disk, best effort — a secret sitting in a world-readable file is worth
      // removing even if we cannot be sure how it got there.
      console.warn(
        '[bic-archiver] the settings file contained a credential-looking field; removing it. ' +
          'The Pinata key belongs in the system keychain only.'
      )
      try {
        await this.#writeSettingsFile(settings, storedToken !== null)
      } catch (err) {
        console.warn(`[bic-archiver] could not rewrite the settings file: ${errorText(err)}`)
      }
    }

    settings.pinata.hasToken = storedToken !== null || this.#sessionToken !== null
    return settings
  }

  /**
   * Write the member's preferences.
   *
   * The incoming object is normalised first, which is what guarantees a caller
   * cannot persist a secret by hanging one off the settings object: only known
   * fields of known types survive the trip to disk. `hasToken` is written from
   * what the keychain actually holds, never from what the caller believed.
   */
  async saveSettings(settings: PinningSettings): Promise<void> {
    const { settings: clean } = normalizeSettings(settings)
    const storedToken = await this.#readStoredToken()
    await this.#writeSettingsFile(clean, storedToken !== null)
  }

  /** Absolute path of the plain JSON settings file. */
  get settingsPath(): string {
    return join(this.#directory(), SETTINGS_FILE)
  }

  /** Absolute path of the encrypted token file. */
  get tokenPath(): string {
    return join(this.#directory(), TOKEN_FILE)
  }

  /* ---------------------------------------------------------------------- */
  /* The Pinata key                                                         */
  /* ---------------------------------------------------------------------- */

  /**
   * Can this computer keep a credential safely?
   *
   * Checked before every store, and available to the GUI so it can explain the
   * situation up front instead of after a member has pasted a key.
   */
  secureStorageStatus(): SecureStorageStatus {
    let secure: SecureStorage
    try {
      secure = this.#secureStorage()
    } catch {
      return { available: false, reason: NOT_IN_APP_MESSAGE }
    }

    let available: boolean
    try {
      available = secure.isEncryptionAvailable()
    } catch (err) {
      console.warn(`[bic-archiver] the system keychain could not be reached: ${errorText(err)}`)
      return { available: false, reason: NO_SECURE_STORAGE_MESSAGE }
    }
    if (!available) return { available: false, reason: NO_SECURE_STORAGE_MESSAGE }

    // On Linux `safeStorage` can report success while using the `basic_text`
    // backend, whose key is a published constant. That is obfuscation, not
    // encryption, and storing a bearer credential under it would be exactly the
    // silent plaintext fallback this module exists to refuse.
    if (process.platform === 'linux' && typeof secure.getSelectedStorageBackend === 'function') {
      let backend: string
      try {
        backend = secure.getSelectedStorageBackend()
      } catch {
        backend = 'unknown'
      }
      if (backend === 'basic_text') return { available: false, reason: WEAK_STORAGE_MESSAGE }
    }

    return { available: true }
  }

  /**
   * Store the Pinata key in the operating system's credential store.
   *
   * Refuses — with an explanation a member can act on — when the computer cannot
   * encrypt it. Nothing is written in that case; see the note at the top of this
   * file for why silently falling back to plain text is not an option.
   */
  async setPinataToken(token: string): Promise<void> {
    const clean = typeof token === 'string' ? token.trim() : ''
    if (clean === '') {
      throw plain('No Pinata key was entered. Paste the key from Pinata (API Keys → your key → JWT) and try again.')
    }

    const status = this.secureStorageStatus()
    if (!status.available) {
      throw plain(status.reason ?? NO_SECURE_STORAGE_MESSAGE)
    }

    let encoded: string
    try {
      encoded = this.#secureStorage().encryptString(clean).toString('base64')
    } catch (err) {
      // `err` is redacted before it is read, but note that nothing here ever
      // interpolates `clean` into a message in the first place.
      throw plain(
        'This computer refused to lock the Pinata key, so nothing has been saved. ' +
          ALTERNATIVES +
          ` (${errorText(err)})`,
        err
      )
    }

    await this.#serialize(async () => {
      await this.#ensureDirectory()
      await this.#writeAtomic(this.tokenPath, encoded + '\n', SECRET_FILE_MODE, 'the Pinata key')
    })

    this.#storedToken = clean
    // A stored key supersedes anything pasted for this session.
    this.#sessionToken = null

    await this.#refreshHasTokenOnDisk(true)
  }

  /**
   * The Pinata key, or null when there is none. MAIN PROCESS ONLY.
   *
   * A key pasted for this session wins over a stored one, so "use a different
   * key just this once" behaves the way a member would expect. Returns null
   * rather than throwing when the stored key cannot be decrypted — a keychain
   * that has moved on (restored machine, new OS user) is a reason to ask for the
   * key again, not a reason to fail the operation with something unreadable.
   */
  async getPinataToken(): Promise<string | null> {
    this.#assertMainProcess()
    if (this.#sessionToken !== null) return this.#sessionToken
    return this.#readStoredToken()
  }

  /** True when a usable key is available, stored or pasted this session. */
  async hasPinataToken(): Promise<boolean> {
    if (this.#sessionToken !== null) return true
    return (await this.#readStoredToken()) !== null
  }

  /** Forget the key completely: the stored file, the cache, and any pasted key. */
  async clearPinataToken(): Promise<void> {
    this.#sessionToken = null
    this.#storedToken = null

    await this.#serialize(async () => {
      try {
        await rm(this.tokenPath, { force: true })
      } catch (err) {
        throw plain(
          `The saved Pinata key could not be removed from "${this.tokenPath}". ` +
            'Check that the file is not open elsewhere and that you have permission to change it. ' +
            `(${errorText(err)})`,
          err
        )
      }
    })

    await this.#refreshHasTokenOnDisk(false)
  }

  /**
   * Use a key for this session without saving it anywhere.
   *
   * This is the escape hatch for a computer with no keyring, and for a member
   * who would rather not leave a credential on a shared laptop. The key lives in
   * main-process memory, is never written to disk, and disappears when the app
   * quits. Passing an empty string is the same as forgetting it.
   */
  useTokenThisSessionOnly(token: string): void {
    const clean = typeof token === 'string' ? token.trim() : ''
    this.#sessionToken = clean === '' ? null : clean
  }

  /**
   * Nothing about this object is safe to serialise, so make the accidental case
   * — a crash reporter or a debug log calling `JSON.stringify` on it — harmless
   * by construction rather than by good intentions.
   */
  toJSON(): Record<string, unknown> {
    return { settingsPath: this.#directoryOverride ?? '<userData>', pinataKey: '<held in the system keychain>' }
  }

  /* ---------------------------------------------------------------------- */
  /* Internals                                                              */
  /* ---------------------------------------------------------------------- */

  #directory(): string {
    if (this.#directoryOverride !== undefined) return this.#directoryOverride
    try {
      return app.getPath('userData')
    } catch (err) {
      throw plain(NOT_IN_APP_MESSAGE, err)
    }
  }

  #secureStorage(): SecureStorage {
    if (this.#secureOverride !== undefined) return this.#secureOverride
    // `import { safeStorage } from 'electron'` outside the app yields undefined
    // rather than throwing, so check before using it.
    if (safeStorage === undefined || typeof safeStorage.isEncryptionAvailable !== 'function') {
      throw plain(NOT_IN_APP_MESSAGE)
    }
    return safeStorage
  }

  /**
   * The renderer must never hold this credential, so make a mistaken call fail
   * loudly here rather than quietly succeed somewhere it should not.
   */
  #assertMainProcess(): void {
    const processType = (process as unknown as { type?: string }).type
    if (processType === 'renderer' || processType === 'worker') {
      throw plain('Internal error: the Pinata key was requested outside the main process and has not been returned.')
    }
  }

  /** The stored key: decrypted on first use, then remembered for the session. */
  async #readStoredToken(): Promise<string | null> {
    if (this.#storedToken !== null) return this.#storedToken

    const raw = await readIfPresent(this.tokenPath, 'the saved Pinata key')
    if (raw === undefined) return null
    const encoded = raw.trim()
    if (encoded === '') return null

    let secure: SecureStorage
    try {
      secure = this.#secureStorage()
    } catch {
      return null
    }

    try {
      if (!secure.isEncryptionAvailable()) {
        console.warn(
          '[bic-archiver] a saved Pinata key exists but this computer cannot unlock it right now; ' +
            'treating it as absent'
        )
        return null
      }
      const bytes = Buffer.from(encoded, 'base64')
      if (bytes.length === 0) return null
      const decrypted = secure.decryptString(bytes).trim()
      if (decrypted === '') return null
      this.#storedToken = decrypted
      return decrypted
    } catch (err) {
      // Deliberately not deleted: a keychain can be temporarily unavailable, and
      // throwing away a credential a member may still be able to recover would
      // be the more damaging mistake. Clearing it is the member's call.
      console.warn(
        `[bic-archiver] the saved Pinata key could not be unlocked and is being ignored: ${errorText(err)}`
      )
      return null
    }
  }

  /** Keep the JSON file's derived `hasToken` in step, best effort. */
  async #refreshHasTokenOnDisk(hasToken: boolean): Promise<void> {
    try {
      const text = await readIfPresent(this.settingsPath, 'the settings file')
      const { settings } = normalizeSettings(text === undefined ? undefined : tryParse(text))
      await this.#writeSettingsFile(settings, hasToken)
    } catch (err) {
      // The value is recomputed on every load, so a stale flag in the file is
      // cosmetic. Never fail storing or clearing a key over it.
      console.warn(`[bic-archiver] could not update the settings file: ${errorText(err)}`)
    }
  }

  async #writeSettingsFile(settings: PinningSettings, hasToken: boolean): Promise<void> {
    const onDisk: PinningSettings = {
      ...settings,
      kubo: { ...settings.kubo },
      pinata: { ...settings.pinata, hasToken }
    }
    const text = JSON.stringify(onDisk, null, 2) + '\n'

    await this.#serialize(async () => {
      await this.#ensureDirectory()
      await this.#writeAtomic(this.settingsPath, text, 0o600, 'your settings')
    })
  }

  async #ensureDirectory(): Promise<void> {
    const dir = this.#directory()
    try {
      await mkdir(dir, { recursive: true })
    } catch (err) {
      throw plain(
        `The folder for the app's settings ("${dir}") could not be created. ` +
          'Check that the disk has free space and that you have permission to write there. ' +
          `(${errorText(err)})`,
        err
      )
    }
  }

  /**
   * Write a file so that a crash leaves either the old contents or the new ones,
   * never a half-written mixture: fill a temporary file, flush it to the
   * physical disk, then swap it into place with a single atomic rename.
   */
  async #writeAtomic(path: string, text: string, mode: number, label: string): Promise<void> {
    const tmpPath = `${path}.${process.pid}.tmp`

    try {
      // A leftover temp file from a crashed run would keep its old permissions,
      // because a mode is only applied when a file is created. For the token
      // file that would mean writing ciphertext into a world-readable file.
      await rm(tmpPath, { force: true })
      const handle = await openFile(tmpPath, 'w', mode)
      try {
        await handle.writeFile(text, 'utf8')
        await handle.sync()
      } finally {
        await handle.close()
      }
      await rename(tmpPath, path)
    } catch (err) {
      // A leftover temp file would keep a half-written secret on disk.
      await rm(tmpPath, { force: true }).catch(() => undefined)
      throw plain(
        `${label} could not be saved to "${path}". Check that the disk has free space, is not ` +
          `write-protected, and that you have permission to write there. (${errorText(err)})`,
        err
      )
    }

    // Ask the operating system to record the rename itself. Best effort: some
    // platforms and filesystems refuse to sync a directory.
    try {
      const dirHandle = await openFile(dirname(path), 'r')
      try {
        await dirHandle.sync()
      } finally {
        await dirHandle.close()
      }
    } catch {
      // Not supported here; the rename is still atomic.
    }
  }

  /** Run writes one at a time. A failure must not poison the queue. */
  async #serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#writes.then(task, task)
    this.#writes = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }
}

/* ========================================================================== */
/* The app's one store                                                        */
/* ========================================================================== */

const sharedStore = new SettingsStore()

/** The settings store the whole main process shares. */
export function getSettingsStore(): SettingsStore {
  return sharedStore
}

/** The settings store the whole main process shares. */
export const settingsStore = sharedStore

/** The member's pinning preferences, with defaults filled in. */
export function loadSettings(): Promise<PinningSettings> {
  return sharedStore.loadSettings()
}

/** Write the member's pinning preferences. */
export function saveSettings(settings: PinningSettings): Promise<void> {
  return sharedStore.saveSettings(settings)
}

/** Store the Pinata key in the system keychain, or explain why it cannot be. */
export function setPinataToken(token: string): Promise<void> {
  return sharedStore.setPinataToken(token)
}

/** The Pinata key, or null. MAIN PROCESS ONLY — never send this to the window. */
export function getPinataToken(): Promise<string | null> {
  return sharedStore.getPinataToken()
}

/** Forget the Pinata key entirely. */
export function clearPinataToken(): Promise<void> {
  return sharedStore.clearPinataToken()
}

/** True when a usable Pinata key is available. Safe to send to the window. */
export function hasPinataToken(): Promise<boolean> {
  return sharedStore.hasPinataToken()
}

/** Whether this computer can store a credential safely, and if not, why not. */
export function secureStorageStatus(): SecureStorageStatus {
  return sharedStore.secureStorageStatus()
}

/** Use a Pinata key for this session without saving it anywhere. */
export function useTokenThisSessionOnly(token: string): void {
  sharedStore.useTokenThisSessionOnly(token)
}
