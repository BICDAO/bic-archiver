/**
 * Settings and credential storage.
 *
 * The Pinata JWT is a bearer credential: anyone holding it can unpin the DAO's
 * content, burn its storage quota, or upload whatever they like under its name.
 * Losing it is not like losing a preference. So this file is mostly one
 * question asked from several directions — *can the key end up in a file?*
 *
 * The answers it pins down:
 *
 *   - it is never written into `settings.json`, and a credential somebody else
 *     put there is taken back out again;
 *   - when the computer has no real credential store, storing is **refused**
 *     rather than quietly downgraded to plaintext, and nothing at all is
 *     written;
 *   - `hasToken` is derived from what can actually be decrypted, so a settings
 *     file copied between machines cannot make the app believe it holds a key
 *     it does not have;
 *   - a corrupt, truncated or hand-edited file yields working settings instead
 *     of an exception — losing a preference is a shrug, refusing to start is
 *     not.
 *
 * The `safeStorage` stand-in really does scramble what it is given, so "no file
 * contains the token" is a meaningful assertion rather than an artefact of a
 * pass-through fake.
 */

import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { DEFAULT_PINNING_SETTINGS, type PinningSettings } from '../../src/shared/pinning'
import { SettingsStore, redactSecrets, type SecureStorage } from '../../src/main/settings'
import { TempDirs } from '../helpers/support'
import { DECOY_JWT, FAKE_TOKEN, allStrings, findTokenLeak } from './helpers'

const temp = new TempDirs()

/* -------------------------------------------------------------------------- */
/* A credential store stand-in that actually hides things                      */
/* -------------------------------------------------------------------------- */

/** Not real encryption — but not the identity function either, which is the point. */
function scramble(text: string): Buffer {
  return Buffer.from(Uint8Array.from(Buffer.from(text, 'utf8'), (byte) => byte ^ 0x5a))
}

function unscramble(bytes: Buffer): string {
  return Buffer.from(Uint8Array.from(bytes, (byte) => byte ^ 0x5a)).toString('utf8')
}

interface FakeKeychain extends SecureStorage {
  /** How many times the app asked the "keychain" to unlock the key. */
  reads: number
}

function keychain(options: { available?: boolean; backend?: string } = {}): FakeKeychain {
  const store: FakeKeychain = {
    reads: 0,
    isEncryptionAvailable: () => options.available ?? true,
    encryptString: (text: string) => scramble(text),
    decryptString: (bytes: Buffer) => {
      store.reads += 1
      return unscramble(bytes)
    }
  }
  if (options.backend !== undefined) {
    store.getSelectedStorageBackend = () => options.backend as string
  }
  return store
}

async function newStore(options: { available?: boolean; backend?: string } = {}): Promise<{
  dir: string
  store: SettingsStore
  secure: FakeKeychain
}> {
  const dir = await temp.make('bic-settings-')
  const secure = keychain(options)
  return { dir, store: new SettingsStore({ directory: dir, secureStorage: secure }), secure }
}

/* -------------------------------------------------------------------------- */
/* Looking for the key on disk                                                 */
/* -------------------------------------------------------------------------- */

/** Every file under `dir`, as raw bytes. Temp files and all. */
async function everyFile(dir: string): Promise<Array<{ path: string; bytes: Buffer }>> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true })
  const files: Array<{ path: string; bytes: Buffer }> = []
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const path = join(entry.parentPath, entry.name)
    files.push({ path, bytes: await readFile(path) })
  }
  return files
}

/** Fail, naming the file, if the key can be found anywhere under `dir`. */
async function expectNoTokenOnDisk(dir: string, token = FAKE_TOKEN): Promise<void> {
  const files = await everyFile(dir)
  // Guard against the assertion below passing because the scan found nothing.
  expect(files.length).toBeGreaterThan(0)
  for (const file of files) {
    const text = file.bytes.toString('utf8')
    const leak = findTokenLeak(text, token)
    expect(leak === undefined ? file.path : `LEAKED "${leak}" into ${file.path}`).toBe(file.path)
  }
}

/** Capture what the store writes to the console, so a leak there is caught too. */
function captureWarnings(): string[] {
  const lines: string[] = []
  const record = (...args: unknown[]): void => {
    lines.push(args.map((arg) => String(arg)).join(' '))
  }
  vi.spyOn(console, 'warn').mockImplementation(record)
  vi.spyOn(console, 'error').mockImplementation(record)
  return lines
}

afterEach(async () => {
  vi.restoreAllMocks()
  await temp.cleanup()
})

/* ========================================================================== */
/* The key is never written into the settings JSON                            */
/* ========================================================================== */

describe('the Pinata key stays out of settings.json', () => {
  it('stores the key without putting it, or any part of it, in the settings file', async () => {
    const { dir, store } = await newStore()

    await store.setPinataToken(FAKE_TOKEN)

    const text = await readFile(store.settingsPath, 'utf8')
    expect(findTokenLeak(text)).toBeUndefined()

    const parsed: unknown = JSON.parse(text)
    for (const value of allStrings(parsed)) {
      expect(findTokenLeak(value)).toBeUndefined()
    }

    // What the file *should* record: that a key exists, not what it is.
    expect((parsed as { pinata?: { hasToken?: unknown } }).pinata?.hasToken).toBe(true)

    // And the key really was stored — otherwise the assertion above would pass
    // for the boring reason that nothing happened at all.
    await expect(store.getPinataToken()).resolves.toBe(FAKE_TOKEN)
    await expectNoTokenOnDisk(dir)
  })

  it('drops a credential a caller tries to smuggle in on the settings object', async () => {
    const { dir, store } = await newStore()

    const rogue = {
      ...structuredClone(DEFAULT_PINNING_SETTINGS),
      pinata: { enabled: true, hasToken: true, token: FAKE_TOKEN, apiSecret: DECOY_JWT },
      pinataJwt: FAKE_TOKEN
    } as unknown as PinningSettings

    await store.saveSettings(rogue)

    const text = await readFile(store.settingsPath, 'utf8')
    expect(text).not.toContain(FAKE_TOKEN)
    expect(text).not.toContain(DECOY_JWT)
    expect(text).not.toContain('pinataJwt')
    // Only known fields of known types survive the trip to disk.
    expect(JSON.parse(text)).toEqual({
      kubo: { enabled: true, apiUrl: 'http://127.0.0.1:5001' },
      pinata: { enabled: true, hasToken: false },
      pinOnImport: true
    })
    await expectNoTokenOnDisk(dir)
  })

  it('takes a credential back out of a settings file that already had one', async () => {
    const { dir, store } = await newStore()
    const warnings = captureWarnings()

    await writeFile(
      store.settingsPath,
      JSON.stringify({
        kubo: { enabled: true, apiUrl: 'http://127.0.0.1:5001' },
        pinata: { enabled: true, hasToken: true, token: FAKE_TOKEN },
        pinOnImport: true
      })
    )

    const settings = await store.loadSettings()

    // Not in what we hand back…
    for (const value of allStrings(settings)) {
      expect(findTokenLeak(value)).toBeUndefined()
    }
    // …and not left sitting in a readable file either.
    await expectNoTokenOnDisk(dir)
    expect(warnings.join('\n')).toMatch(/credential-looking field/i)
    for (const line of warnings) expect(findTokenLeak(line)).toBeUndefined()
  })
})

/* ========================================================================== */
/* No secure storage means no storage at all                                  */
/* ========================================================================== */

describe('refusing to store a key in the clear', () => {
  it('refuses, explains, and writes nothing when the computer has no keychain', async () => {
    const { dir, store } = await newStore({ available: false })

    // A settings file already exists, so "nothing was written" is a real check
    // rather than a check against an empty folder.
    await store.saveSettings(structuredClone(DEFAULT_PINNING_SETTINGS))

    await expect(store.setPinataToken(FAKE_TOKEN)).rejects.toThrow(
      /no secure place to keep the Pinata key/i
    )

    // The whole point: not one byte of it anywhere.
    await expectNoTokenOnDisk(dir)
    const paths = (await everyFile(dir)).map((file) => file.path)
    expect(paths).not.toContain(store.tokenPath)
    await expect(store.hasPinataToken()).resolves.toBe(false)
  })

  it('names the alternatives instead of leaving the member stuck', async () => {
    const { store } = await newStore({ available: false })

    const message = await store
      .setPinataToken(FAKE_TOKEN)
      .then(() => '')
      .catch((err: unknown) => (err instanceof Error ? err.message : String(err)))

    // A local Kubo node needs no credential at all, and a pasted key can live
    // in memory for the session — a refusal without a way forward is a dead end.
    expect(message).toMatch(/pin to your own IPFS \(Kubo\) node/i)
    expect(message).toMatch(/held in memory only and forgotten when you quit/i)
    expect(findTokenLeak(message)).toBeUndefined()
  })

  it("refuses Linux's basic_text backend, which is obfuscation rather than encryption", async () => {
    const realPlatform = process.platform
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })

    try {
      const { dir, store } = await newStore({ available: true, backend: 'basic_text' })
      // So that "nothing was written" is checked against a folder with files in
      // it, rather than against an empty one.
      await store.saveSettings(structuredClone(DEFAULT_PINNING_SETTINGS))

      const status = store.secureStorageStatus()
      expect(status.available).toBe(false)
      expect(status.reason ?? '').toMatch(/scrambled with a value anyone can look up/i)

      await expect(store.setPinataToken(FAKE_TOKEN)).rejects.toThrow(/not offering a real password store/i)
      await expectNoTokenOnDisk(dir)
    } finally {
      Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true })
    }
  })

  it('accepts a real Linux backend', async () => {
    const realPlatform = process.platform
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })

    try {
      const { store } = await newStore({ available: true, backend: 'gnome_libsecret' })
      expect(store.secureStorageStatus()).toEqual({ available: true })
      await expect(store.setPinataToken(FAKE_TOKEN)).resolves.toBeUndefined()
    } finally {
      Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true })
    }
  })

  it('keeps a session-only key in memory and never on disk', async () => {
    const { dir, store } = await newStore({ available: false })
    await store.saveSettings(structuredClone(DEFAULT_PINNING_SETTINGS))

    store.useTokenThisSessionOnly(FAKE_TOKEN)

    await expect(store.getPinataToken()).resolves.toBe(FAKE_TOKEN)
    await expect(store.hasPinataToken()).resolves.toBe(true)
    expect((await store.loadSettings()).pinata.hasToken).toBe(true)
    await expectNoTokenOnDisk(dir)
  })

  it('refuses an empty paste rather than storing nothing and claiming success', async () => {
    const { store } = await newStore()

    await expect(store.setPinataToken('   ')).rejects.toThrow(/No Pinata key was entered/i)
    await expect(store.hasPinataToken()).resolves.toBe(false)
  })
})

/* ========================================================================== */
/* A damaged settings file must never stop the app                            */
/* ========================================================================== */

describe('loadSettings repairs whatever it finds', () => {
  /** Write raw text as the settings file, then load it. */
  async function loadFrom(text: string): Promise<{ settings: PinningSettings; store: SettingsStore }> {
    const { store } = await newStore()
    captureWarnings()
    await writeFile(store.settingsPath, text)
    return { settings: await store.loadSettings(), store }
  }

  it('falls back to the defaults for a truncated file', async () => {
    const { settings } = await loadFrom('{"kubo": {"enabled": tru')

    expect(settings).toEqual(structuredClone(DEFAULT_PINNING_SETTINGS))
  })

  it('falls back to the defaults for a file that is not an object at all', async () => {
    const { settings } = await loadFrom('["kubo", "pinata"]')

    expect(settings).toEqual(structuredClone(DEFAULT_PINNING_SETTINGS))
  })

  it('keeps the fields that are usable and defaults only the ones that are not', async () => {
    const { settings } = await loadFrom(
      JSON.stringify({
        kubo: { enabled: 'yes', apiUrl: 'http://192.168.1.9:5001/' },
        pinata: { enabled: true, gateway: 'https://bic.mypinata.cloud' },
        pinOnImport: 3
      })
    )

    // `enabled: 'yes'` and `pinOnImport: 3` are the wrong type, so they default.
    expect(settings.kubo.enabled).toBe(true)
    expect(settings.pinOnImport).toBe(true)
    // A usable URL survives, with its trailing slash trimmed (every caller
    // appends `/api/v0/…`).
    expect(settings.kubo.apiUrl).toBe('http://192.168.1.9:5001')
    expect(settings.pinata.enabled).toBe(true)
    expect(settings.pinata.gateway).toBe('https://bic.mypinata.cloud')
  })

  it('refuses a node address that is not http(s)', async () => {
    const { settings } = await loadFrom(
      JSON.stringify({ kubo: { enabled: true, apiUrl: 'file:///etc/passwd' } })
    )

    expect(settings.kubo.apiUrl).toBe('http://127.0.0.1:5001')
  })

  it('starts from the defaults when there is no settings file at all', async () => {
    const { store } = await newStore()

    await expect(store.loadSettings()).resolves.toEqual(structuredClone(DEFAULT_PINNING_SETTINGS))
  })

  it('keeps pinning on by default, because unpinned content is how the 428 were lost', async () => {
    expect(DEFAULT_PINNING_SETTINGS.pinOnImport).toBe(true)
  })
})

/* ========================================================================== */
/* hasToken is derived, never believed                                        */
/* ========================================================================== */

describe('hasToken', () => {
  it('is false when the file claims a key that the keychain does not have', async () => {
    const { store } = await newStore()
    captureWarnings()

    await writeFile(
      store.settingsPath,
      JSON.stringify({ pinata: { enabled: true, hasToken: true }, pinOnImport: true })
    )

    // A settings file copied from another machine must not be able to convince
    // the app it holds a credential.
    expect((await store.loadSettings()).pinata.hasToken).toBe(false)
  })

  it('is false when the stored key cannot be unlocked, without deleting it', async () => {
    const { dir, store } = await newStore()
    captureWarnings()
    await store.setPinataToken(FAKE_TOKEN)

    // A locked keyring today can be an unlocked one tomorrow, so the ciphertext
    // must survive being unreadable.
    const locked = new SettingsStore({
      directory: dir,
      secureStorage: {
        isEncryptionAvailable: () => true,
        encryptString: scramble,
        decryptString: () => {
          throw new Error('the keyring is locked')
        }
      }
    })

    expect((await locked.loadSettings()).pinata.hasToken).toBe(false)
    await expect(locked.getPinataToken()).resolves.toBeNull()
    expect((await everyFile(dir)).map((file) => file.path)).toContain(store.tokenPath)
  })

  it('turns false again once the key is cleared', async () => {
    const { dir, store } = await newStore()
    await store.setPinataToken(FAKE_TOKEN)

    await store.clearPinataToken()

    await expect(store.getPinataToken()).resolves.toBeNull()
    expect((await store.loadSettings()).pinata.hasToken).toBe(false)
    expect((await everyFile(dir)).map((file) => file.path)).not.toContain(store.tokenPath)
  })

  it('reads the keychain once and then remembers, rather than prompting per CID', async () => {
    const { dir, secure } = await newStore()
    const writer = new SettingsStore({ directory: dir, secureStorage: secure })
    await writer.setPinataToken(FAKE_TOKEN)

    const reader = new SettingsStore({ directory: dir, secureStorage: secure })
    for (let i = 0; i < 5; i += 1) {
      await expect(reader.getPinataToken()).resolves.toBe(FAKE_TOKEN)
    }

    expect(secure.reads).toBe(1)
  })
})

/* ========================================================================== */
/* Belt and braces                                                            */
/* ========================================================================== */

describe('accidental disclosure', () => {
  it('cannot be serialised into a crash report', async () => {
    const { store } = await newStore()
    await store.setPinataToken(FAKE_TOKEN)

    const serialised = JSON.stringify(store)

    expect(findTokenLeak(serialised)).toBeUndefined()
    expect(serialised).toContain('held in the system keychain')
  })

  it('redacts credential-shaped text on its way to a log or a screen', async () => {
    const samples = [
      `Authorization: Bearer ${FAKE_TOKEN}`,
      `request failed for ${DECOY_JWT}`,
      `https://api.pinata.cloud/x?token=${FAKE_TOKEN}&status=pinned`
    ]

    for (const sample of samples) {
      const cleaned = redactSecrets(sample)
      expect(cleaned).not.toContain(FAKE_TOKEN)
      expect(cleaned).not.toContain(DECOY_JWT)
      expect(cleaned).toContain('[key hidden]')
    }
  })

  it('leaves a CID alone, because mangling one destroys the only identifier a member has', async () => {
    const cid = 'bafybeieo2p3k22c3swpk24bckghbv53m3alpr2hmptg5uhwuaghi6ird7a'

    expect(redactSecrets(`Could not reach ${cid}`)).toContain(cid)
  })
})
