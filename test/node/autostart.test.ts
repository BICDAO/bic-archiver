/**
 * The login item — what makes a member's node still be running on Tuesday.
 *
 * Ten members each running a node is BIC's answer to two hosted services having
 * already failed the archive. That answer is only worth anything if the nodes
 * are up when nobody is thinking about them, which makes this module's job
 * narrow and specific: install a real login item, and make sure a crashed
 * daemon comes back.
 *
 * The second half is the one with a cautionary tale attached. Homebrew's own
 * kubo LaunchAgent sets `RunAtLoad` but **not** `KeepAlive`, so a node that
 * crashes there stays dead until a human notices. For an archive whose entire
 * failure mode is "nobody noticed", inheriting that would be quietly fatal —
 * the member believes they are providing, and they are not. So `KeepAlive` is
 * asserted here directly, on the file that is actually written, rather than
 * trusted to a comment.
 *
 * Nothing in this file runs `launchctl` or `systemctl` for real: `runProcess`
 * is replaced, and every command is recorded and asserted instead. That is not
 * only for speed. A test that genuinely bootstrapped a LaunchAgent would be
 * installing a background service into the login session of whoever ran the
 * suite, and leaving it behind if it failed halfway.
 *
 * The files, by contrast, are real. They are written to a temporary HOME, read
 * back off the disk, and — on macOS — handed to `plutil` to confirm the system
 * itself considers the plist valid.
 */

import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AUTOSTART_LABEL } from '../../src/shared/node'
import { TempDirs } from '../helpers/support'

/* -------------------------------------------------------------------------- */
/* every command, recorded rather than run                                     */
/* -------------------------------------------------------------------------- */

interface Ran {
  file: string
  args: string[]
}

const ran = vi.hoisted(() => [] as Ran[])
const reply = vi.hoisted(() => ({
  /** Overridden per test to make a service manager present, absent, or cross. */
  current: (_file: string, _args: readonly string[]) => ({
    code: 0,
    stdout: '',
    stderr: '',
    missing: false,
    timedOut: false
  })
}))

vi.mock('../../src/main/node/install', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/node/install')>()
  return {
    ...actual,
    runProcess: async (file: string, args: readonly string[]) => {
      ran.push({ file, args: [...args] })
      return reply.current(file, args)
    }
  }
})

const {
  disableAutostart,
  enableAutostart,
  isAutostartEnabled,
  startViaServiceManager,
  stopViaServiceManager
} = await import('../../src/main/node/autostart')

/* -------------------------------------------------------------------------- */
/* a temporary home, and a chosen platform                                     */
/* -------------------------------------------------------------------------- */

const temps = new TempDirs()

/** Environment variables this module reads, so each can be put back exactly. */
const HOME_VARS = ['HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'APPDATA'] as const
const savedEnv = new Map<string, string | undefined>()
let savedPlatform: NodeJS.Platform

let home = ''

beforeEach(async () => {
  savedPlatform = process.platform
  for (const key of HOME_VARS) savedEnv.set(key, process.env[key])

  home = await temps.make('bic-autostart-home-')
  // `os.homedir()` follows $HOME on POSIX, which is what keeps every file this
  // module writes inside a directory the test owns.
  process.env['HOME'] = home
  delete process.env['XDG_CONFIG_HOME']
  delete process.env['XDG_DATA_HOME']
  process.env['APPDATA'] = join(home, 'AppData', 'Roaming')

  ran.length = 0
  reply.current = () => ({ code: 0, stdout: '', stderr: '', missing: false, timedOut: false })
})

afterEach(async () => {
  Object.defineProperty(process, 'platform', { value: savedPlatform, configurable: true })
  for (const key of HOME_VARS) {
    const value = savedEnv.get(key)
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  vi.unstubAllGlobals()
  await temps.cleanup()
})

/**
 * Pretend to be a platform.
 *
 * Every branch dispatches on `process.platform` at call time, so this exercises
 * the real macOS and Linux code on whichever machine runs the suite instead of
 * leaving two thirds of the module untested everywhere.
 */
function asPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
}

function commands(file: string): string[][] {
  return ran.filter((entry) => entry.file === file).map((entry) => entry.args)
}

function argvOf(file: string): string[] {
  return commands(file).map((args) => args.join(' '))
}

/** POSIX only: forcing `darwin`/`linux` on Windows would break path handling. */
const posix = process.platform !== 'win32'

const BIN = '/tmp/bic-test/ipfs'
const REPO = '/tmp/bic-test/repo'

/* -------------------------------------------------------------------------- */
/* macOS: the plist                                                            */
/* -------------------------------------------------------------------------- */

describe.runIf(posix)('the macOS LaunchAgent', () => {
  function plistPath(): string {
    return join(home, 'Library', 'LaunchAgents', `${AUTOSTART_LABEL}.plist`)
  }

  /** `<key>Name</key>` followed by `<true/>` — the two together, not separately. */
  function booleanKey(plist: string, key: string): boolean | undefined {
    const match = new RegExp(`<key>${key}</key>\\s*<(true|false)\\s*/>`).exec(plist)
    if (match === undefined || match === null) return undefined
    return match[1] === 'true'
  }

  it('sets KeepAlive, which is what Homebrew leaves out', async () => {
    asPlatform('darwin')
    await enableAutostart(BIN, REPO)

    const plist = await readFile(plistPath(), 'utf8')

    // The whole point. Without this, a crashed node stays dead and the member
    // goes on believing they are serving the archive.
    expect(booleanKey(plist, 'KeepAlive'), 'KeepAlive is missing — a crash would never be recovered').toBe(
      true
    )
    // And the other half: start when the member logs in, not only when the app
    // happens to be open.
    expect(booleanKey(plist, 'RunAtLoad')).toBe(true)
  })

  it('names the right program, repository and label', async () => {
    asPlatform('darwin')
    await enableAutostart(BIN, REPO)
    const plist = await readFile(plistPath(), 'utf8')

    expect(plist).toContain(`<string>${AUTOSTART_LABEL}</string>`)
    expect(plist).toContain(`<string>${BIN}</string>`)
    expect(plist).toContain('<string>daemon</string>')
    // IPFS_PATH is set explicitly: a member with their own node has it pointing
    // at ~/.ipfs, and inheriting that would run *their* repository under our
    // login item.
    expect(plist).toMatch(/<key>IPFS_PATH<\/key>\s*<string>\/tmp\/bic-test\/repo<\/string>/)
    // Somewhere to look when a node will not start.
    expect(plist).toContain('StandardErrorPath')
  })

  it('starts the agent the way that actually starts it', async () => {
    asPlatform('darwin')
    await enableAutostart(BIN, REPO)

    const launchctl = argvOf('launchctl')
    const uid = process.getuid?.() ?? 0

    // `bootstrap` loads it; `kickstart -k` is what genuinely runs it. The
    // deprecated `load` will happily report success having started nothing,
    // which looks exactly like a working set-up and serves no bytes.
    expect(launchctl.some((args) => args.startsWith(`bootstrap gui/${uid} `))).toBe(true)
    expect(launchctl).toContain(`kickstart -k gui/${uid}/${AUTOSTART_LABEL}`)
    expect(launchctl.some((args) => args.startsWith('load'))).toBe(false)

    // A service disabled in launchd's override database stays disabled through
    // a reinstall, and `bootstrap` still reports success.
    expect(launchctl).toContain(`enable gui/${uid}/${AUTOSTART_LABEL}`)
  })

  it('never asks for administrator rights', async () => {
    asPlatform('darwin')
    await enableAutostart(BIN, REPO)

    // Everything is per-user: the `gui/<uid>` domain, never `system/`. Nobody
    // is asked for a password to keep a backup alive.
    expect(ran.map((entry) => entry.file)).not.toContain('sudo')
    for (const args of commands('launchctl')) {
      expect(args.join(' ')).not.toMatch(/\bsystem\//)
    }
    // And the file itself is inside the member's own home directory.
    expect(plistPath().startsWith(home)).toBe(true)
  })

  it('escapes a path that would otherwise break the XML', async () => {
    asPlatform('darwin')
    const awkward = '/tmp/Bob & Alice/<archive>/ipfs'
    await enableAutostart(awkward, '/tmp/Bob & Alice/repo')

    const plist = await readFile(plistPath(), 'utf8')
    expect(plist).toContain('/tmp/Bob &amp; Alice/&lt;archive&gt;/ipfs')
    // A raw `&` here would make launchd reject the file, and the node would
    // never start again with no indication why.
    expect(plist).not.toMatch(/&(?!amp;|lt;|gt;|quot;)/)
  })

  it.runIf(process.platform === 'darwin')('writes a plist macOS itself accepts', async () => {
    asPlatform('darwin')
    await enableAutostart('/tmp/Bob & Alice/ipfs', '/tmp/Bob & Alice/repo')

    // The real `plutil`, not our stubbed runProcess — this is the system's own
    // opinion of the file, which is the only opinion that matters to launchd.
    const { runProcess: realRunProcess } = await vi.importActual<typeof import('../../src/main/node/install')>(
      '../../src/main/node/install'
    )
    const result = await realRunProcess('plutil', ['-lint', plistPath()], { timeoutMs: 30_000 })
    expect(result.missing).toBe(false)
    expect(`${result.stdout}${result.stderr}`.trim()).toMatch(/OK$/m)
    expect(result.code).toBe(0)
  })

  it('round-trips: enable, report enabled, disable, report disabled', async () => {
    asPlatform('darwin')

    expect(await isAutostartEnabled()).toBe(false)

    await enableAutostart(BIN, REPO)
    expect(await isAutostartEnabled()).toBe(true)

    ran.length = 0
    await disableAutostart()

    expect(await isAutostartEnabled()).toBe(false)
    await expect(stat(plistPath())).rejects.toThrow()

    // Unloading matters as much as deleting the file: `KeepAlive` means the
    // running daemon belongs to launchd, and deleting a plist does not stop it.
    const uid = process.getuid?.() ?? 0
    expect(argvOf('launchctl')).toContain(`bootout gui/${uid}/${AUTOSTART_LABEL}`)
  })

  it('says so plainly when macOS refuses, and does not claim the node is broken', async () => {
    asPlatform('darwin')
    reply.current = (_file, args) =>
      args[0] === 'kickstart'
        ? {
            code: 5,
            stdout: '',
            stderr: 'Load failed: 5: Input/output error',
            missing: false,
            timedOut: false
          }
        : { code: 0, stdout: '', stderr: '', missing: false, timedOut: false }

    const message = await enableAutostart(BIN, REPO).then(
      () => 'it did not throw',
      (err: unknown) => (err instanceof Error ? err.message : String(err))
    )

    expect(message).toMatch(/would not set it to start automatically/i)
    // The node is installed and usable; only the login item failed. Saying
    // otherwise would send a member off to reinstall something that works.
    expect(message).toMatch(/You can still start it from this app/i)
    expect(message).toContain('Load failed: 5')
    expect(message).not.toMatch(/at \w+ \(|\.ts:\d+|undefined/)
  })

  it('will not ask launchd to start an agent that was never installed', async () => {
    asPlatform('darwin')
    await expect(startViaServiceManager()).resolves.toBe(false)
    await expect(stopViaServiceManager()).resolves.toBe(false)
    expect(ran).toHaveLength(0)
  })

  it('stops the service rather than the process, because KeepAlive would restart it', async () => {
    asPlatform('darwin')
    await enableAutostart(BIN, REPO)
    ran.length = 0

    await expect(stopViaServiceManager()).resolves.toBe(true)
    expect(argvOf('launchctl')).toEqual([`bootout gui/${process.getuid?.() ?? 0}/${AUTOSTART_LABEL}`])
  })

  it('treats "not loaded" as stopped, because it is', async () => {
    asPlatform('darwin')
    await enableAutostart(BIN, REPO)
    // What launchd actually says when the agent is not loaded in this session.
    // It is a non-zero exit, but the node is not running either way, and
    // reporting failure here would send the caller off to kill a process that
    // does not exist.
    reply.current = () => ({
      code: 113,
      stdout: '',
      stderr: `Could not find service "${AUTOSTART_LABEL}" in domain for gui/${process.getuid?.() ?? 0}`,
      missing: false,
      timedOut: false
    })

    await expect(stopViaServiceManager()).resolves.toBe(true)
  })

  it('reports a refusal it does not understand as "not stopped"', async () => {
    asPlatform('darwin')
    await enableAutostart(BIN, REPO)
    reply.current = () => ({
      code: 36,
      stdout: '',
      stderr: 'Boot-out failed: 36: Operation now in progress',
      missing: false,
      timedOut: false
    })

    // The honest answer, and the safe one: the caller then stops the process
    // itself rather than assuming a node that may still be running is down.
    await expect(stopViaServiceManager()).resolves.toBe(false)
  })
})

/* -------------------------------------------------------------------------- */
/* Linux: the systemd user unit                                                */
/* -------------------------------------------------------------------------- */

describe.runIf(posix)('the Linux login item', () => {
  const unitPath = (): string =>
    join(home, '.config', 'systemd', 'user', `${AUTOSTART_LABEL}.service`)
  const desktopPath = (): string => join(home, '.config', 'autostart', `${AUTOSTART_LABEL}.desktop`)
  const launcherPath = (): string => join(home, '.local', 'share', AUTOSTART_LABEL, 'start-ipfs.sh')

  /** A machine where `systemctl --user` works. */
  function withSystemd(enabled = 'enabled'): void {
    reply.current = (file, args) => {
      if (file !== 'systemctl') return { code: 0, stdout: '', stderr: '', missing: false, timedOut: false }
      const stdout = args.includes('is-enabled') ? `${enabled}\n` : ''
      return { code: 0, stdout, stderr: '', missing: false, timedOut: false }
    }
  }

  it('sets Restart=always, the same promise KeepAlive makes on macOS', async () => {
    asPlatform('linux')
    withSystemd()
    await enableAutostart(BIN, REPO)

    const unit = await readFile(unitPath(), 'utf8')
    expect(unit).toContain('Restart=always')
    expect(unit).toContain('WantedBy=default.target')
    expect(unit).toContain(`ExecStart=${launcherPath()}`)
  })

  it('puts the quoting in one place — a shell script — and makes it executable', async () => {
    asPlatform('linux')
    withSystemd()
    await enableAutostart("/tmp/Bob's kit/ipfs", "/tmp/Bob's kit/repo")

    const launcher = await readFile(launcherPath(), 'utf8')
    // A home directory with an apostrophe in it is where a node silently never
    // starts, because systemd's quoting rules and the Desktop Entry spec's are
    // not the same rules.
    expect(launcher).toContain(`IPFS_PATH='/tmp/Bob'\\''s kit/repo'`)
    expect(launcher).toContain(`exec '/tmp/Bob'\\''s kit/ipfs' daemon`)
    expect((await stat(launcherPath())).mode & 0o111).toBeGreaterThan(0)
  })

  it('round-trips through systemd', async () => {
    asPlatform('linux')
    withSystemd()

    expect(await isAutostartEnabled()).toBe(false)

    await enableAutostart(BIN, REPO)
    expect(argvOf('systemctl')).toContain(`--user enable --now ${AUTOSTART_LABEL}.service`)
    expect(await isAutostartEnabled()).toBe(true)

    await disableAutostart()
    expect(argvOf('systemctl')).toContain(`--user disable --now ${AUTOSTART_LABEL}.service`)
    expect(await isAutostartEnabled()).toBe(false)
    await expect(stat(unitPath())).rejects.toThrow()
    await expect(stat(launcherPath())).rejects.toThrow()
  })

  it('falls back to a desktop entry where there is no user systemd', async () => {
    asPlatform('linux')
    reply.current = () => ({ code: 1, stdout: '', stderr: '', missing: true, timedOut: false })

    await enableAutostart(BIN, REPO)

    const desktop = await readFile(desktopPath(), 'utf8')
    expect(desktop).toContain(`Exec=${launcherPath()}`)
    expect(desktop).toContain('X-GNOME-Autostart-enabled=true')
    // It genuinely is enabled — just without the crash recovery a unit gives.
    expect(await isAutostartEnabled()).toBe(true)

    await disableAutostart()
    expect(await isAutostartEnabled()).toBe(false)
  })

  it('does not report a unit that systemd says is disabled', async () => {
    asPlatform('linux')
    withSystemd()
    await enableAutostart(BIN, REPO)

    // The file on disk is not the answer: `systemctl disable` leaves it there.
    withSystemd('disabled')
    expect(await isAutostartEnabled()).toBe(false)
  })
})

/* -------------------------------------------------------------------------- */
/* Windows: the Startup folder                                                 */
/* -------------------------------------------------------------------------- */

describe.runIf(posix)('the Windows Startup entry', () => {
  const cmdPath = (): string =>
    join(
      home,
      'AppData',
      'Roaming',
      'Microsoft',
      'Windows',
      'Start Menu',
      'Programs',
      'Startup',
      `${AUTOSTART_LABEL}.cmd`
    )

  it('round-trips through the per-user Startup folder', async () => {
    asPlatform('win32')

    expect(await isAutostartEnabled()).toBe(false)

    await enableAutostart('C:\\Users\\Someone Else\\ipfs.exe', 'C:\\Users\\Someone Else\\repo')
    expect(await isAutostartEnabled()).toBe(true)

    const cmd = await readFile(cmdPath(), 'utf8')
    // Quoted, because "Someone Else" has a space in it and an unquoted path
    // there starts nothing at all.
    expect(cmd).toContain('set "IPFS_PATH=C:\\Users\\Someone Else\\repo"')
    expect(cmd).toContain('start "" /B "C:\\Users\\Someone Else\\ipfs.exe" daemon')
    // Windows batch files need CRLF.
    expect(cmd).toContain('\r\n')

    // No admin rights: a per-user Startup folder, not the machine-wide one.
    expect(ran).toHaveLength(0)

    await disableAutostart()
    expect(await isAutostartEnabled()).toBe(false)
  })

  it('says so rather than pretending, when there is no Startup folder to use', async () => {
    asPlatform('win32')
    delete process.env['APPDATA']

    await expect(enableAutostart(BIN, REPO)).rejects.toThrowError(/could not find your Windows Start-up folder/i)
    // Reporting success here would leave a member certain their node restarts
    // with the computer when it does not.
    expect(await isAutostartEnabled()).toBe(false)
  })
})

/* -------------------------------------------------------------------------- */
/* anything else                                                               */
/* -------------------------------------------------------------------------- */

describe('an unsupported platform', () => {
  it('explains what still works instead of failing silently', async () => {
    asPlatform('freebsd')

    const message = await enableAutostart(BIN, REPO).then(
      () => 'it did not throw',
      (err: unknown) => (err instanceof Error ? err.message : String(err))
    )
    expect(message).toMatch(/cannot set your IPFS node to start automatically on freebsd/i)
    expect(message).toMatch(/The node itself still works/i)

    // And the two calls that must never throw, do not: a member on an odd
    // platform can still turn the switch off.
    await expect(disableAutostart()).resolves.toBeUndefined()
    await expect(isAutostartEnabled()).resolves.toBe(false)
  })
})
