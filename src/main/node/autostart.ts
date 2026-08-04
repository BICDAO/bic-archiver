/**
 * Making the member's node start itself, and stay started.
 *
 * The whole point of the managed node is that BIC's archive is served by real
 * people's computers rather than by a company that can switch it off. That only
 * holds if the node is running when nobody is thinking about it — which means it
 * must survive quitting the app, closing the laptop, and Tuesday.
 *
 * So this installs a genuine login item on each platform rather than spawning a
 * child process that dies with the window:
 *
 *   macOS   a LaunchAgent, loaded with `launchctl bootstrap` and started with
 *           `launchctl kickstart`. `launchctl load` is deprecated and — worse —
 *           will happily "load" an agent without starting it, which looks like
 *           success and serves nothing.
 *   Linux   a systemd *user* unit with `Restart=always`, falling back to an
 *           XDG autostart entry where user systemd is not available.
 *   Windows a `.cmd` shim in the per-user Startup folder.
 *
 * Two constraints shape all three. First, **never any administrator rights** —
 * everything here writes inside the member's own home directory and talks only
 * to per-user service managers, so nobody is ever asked for a password to keep a
 * backup alive. Second, **crashes must be recovered**: Homebrew's own kubo
 * LaunchAgent sets `RunAtLoad` but not `KeepAlive`, so a crashed daemon there
 * stays dead until somebody notices — which, for an archive whose entire failure
 * mode is "nobody noticed", is precisely the wrong behaviour. Ours sets
 * `KeepAlive` (and `Restart=always` on Linux).
 *
 * Where a platform genuinely cannot be supported, these functions say so in
 * plain words rather than returning quietly and leaving the member believing
 * something is set up that is not.
 */

import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { AUTOSTART_LABEL } from '../../shared/node.js'

import { plainError, runProcess } from './install.js'

/* -------------------------------------------------------------------------- */
/* where each platform keeps its login items                                   */
/* -------------------------------------------------------------------------- */

const SERVICE_TIMEOUT_MS = 60_000

function configHome(): string {
  const xdg = process.env['XDG_CONFIG_HOME']
  return xdg !== undefined && xdg.startsWith('/') ? xdg : join(homedir(), '.config')
}

function dataHome(): string {
  const xdg = process.env['XDG_DATA_HOME']
  return xdg !== undefined && xdg.startsWith('/') ? xdg : join(homedir(), '.local', 'share')
}

/** macOS: `~/Library/LaunchAgents/<label>.plist`. */
function plistPath(): string {
  return join(homedir(), 'Library', 'LaunchAgents', `${AUTOSTART_LABEL}.plist`)
}

/** Linux: `~/.config/systemd/user/<label>.service`. */
function unitPath(): string {
  return join(configHome(), 'systemd', 'user', `${AUTOSTART_LABEL}.service`)
}

/** Linux fallback: `~/.config/autostart/<label>.desktop`. */
function desktopPath(): string {
  return join(configHome(), 'autostart', `${AUTOSTART_LABEL}.desktop`)
}

/**
 * Linux: a tiny launcher script both the unit and the desktop entry point at.
 *
 * One script means the environment variable and the binary path are quoted in
 * exactly one place — POSIX shell — instead of once in systemd's quoting rules
 * and again in the Desktop Entry specification's, which is where a home
 * directory containing a space turns into a node that silently never starts.
 */
function launcherPath(): string {
  return join(dataHome(), AUTOSTART_LABEL, 'start-ipfs.sh')
}

/** Windows: a `.cmd` in the per-user Startup folder. No admin rights needed. */
function startupCmdPath(): string | undefined {
  const appData = process.env['APPDATA']
  if (appData === undefined || appData.trim() === '') return undefined
  return join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', `${AUTOSTART_LABEL}.cmd`)
}

function unsupported(): Error {
  return plainError(
    `This app cannot set your IPFS node to start automatically on ${process.platform}. ` +
      'The node itself still works — you will just need to start it from this app each time, ' +
      'and it will stop when this computer is restarted.'
  )
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** Write a file, creating its folder, with a clear message when that fails. */
async function writeConfigFile(path: string, contents: string, mode: number, what: string): Promise<void> {
  const dir = dirname(path)
  try {
    await mkdir(dir, { recursive: true })
    await writeFile(path, contents, { encoding: 'utf8', mode })
  } catch (err) {
    throw plainError(
      `${what} could not be saved to "${path}", so your node will not start automatically. ` +
        `Check that you are allowed to write there. (${err instanceof Error ? err.message : String(err)})`
    )
  }
}

/* -------------------------------------------------------------------------- */
/* macOS                                                                       */
/* -------------------------------------------------------------------------- */

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function buildPlist(binPath: string, repoPath: string, logDir: string): string {
  const args = [binPath, 'daemon']
  const items = args.map((arg) => `      <string>${xmlEscape(arg)}</string>`).join('\n')

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '  <dict>',
    '    <key>Label</key>',
    `    <string>${xmlEscape(AUTOSTART_LABEL)}</string>`,
    '    <key>ProgramArguments</key>',
    '    <array>',
    items,
    '    </array>',
    '    <key>EnvironmentVariables</key>',
    '    <dict>',
    '      <key>IPFS_PATH</key>',
    `      <string>${xmlEscape(repoPath)}</string>`,
    '    </dict>',
    '    <key>RunAtLoad</key>',
    '    <true/>',
    // Homebrew's kubo agent omits this, so a crash there is never recovered.
    // An archive whose failure mode is "nobody noticed" cannot afford that.
    //
    // Measured, so nobody has to rediscover it: launchd accepts this (it shows
    // up as `properties = keepalive | runatload` in `launchctl print`), but a
    // laptop running on BATTERY defers the respawn — `launchctl print` then
    // reports `pended nondemand spawn = inefficient` and the node stays down
    // until the machine is on power again. That is macOS power policy, not a
    // mistake here: every value of `ProcessType` (Background, Standard,
    // Adaptive, Interactive) was tried and behaves identically. On mains power
    // the restart happens as intended.
    '    <key>KeepAlive</key>',
    '    <true/>',
    '    <key>ThrottleInterval</key>',
    '    <integer>10</integer>',
    '    <key>StandardOutPath</key>',
    `    <string>${xmlEscape(join(logDir, `${AUTOSTART_LABEL}.out.log`))}</string>`,
    '    <key>StandardErrorPath</key>',
    `    <string>${xmlEscape(join(logDir, `${AUTOSTART_LABEL}.err.log`))}</string>`,
    '  </dict>',
    '</plist>',
    ''
  ].join('\n')
}

function guiDomain(): string {
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined
  if (uid === undefined) {
    throw plainError(
      'This app could not work out which user account it is running as, so it could not set your node to ' +
        'start automatically.'
    )
  }
  return `gui/${uid}`
}

async function enableOnMac(binPath: string, repoPath: string): Promise<void> {
  const logDir = join(homedir(), 'Library', 'Logs')
  await mkdir(logDir, { recursive: true }).catch(() => undefined)

  const path = plistPath()
  await writeConfigFile(path, buildPlist(binPath, repoPath, logDir), 0o644, 'The start-up settings for your node')

  const domain = guiDomain()
  const target = `${domain}/${AUTOSTART_LABEL}`

  // Remove any previous copy first: bootstrap refuses to replace a service that
  // is already loaded, and an old one would keep the old binary path.
  await runProcess('launchctl', ['bootout', target], { timeoutMs: SERVICE_TIMEOUT_MS })
  // A service can be *disabled* in launchd's per-user override database, which
  // survives deleting the plist and makes bootstrap succeed while nothing runs.
  await runProcess('launchctl', ['enable', target], { timeoutMs: SERVICE_TIMEOUT_MS })

  const bootstrap = await runProcess('launchctl', ['bootstrap', domain, path], {
    timeoutMs: SERVICE_TIMEOUT_MS
  })

  // `kickstart -k` starts the service, restarting it if it is somehow already
  // running. This is the step `launchctl load` does not reliably do.
  const kickstart = await runProcess('launchctl', ['kickstart', '-k', target], {
    timeoutMs: SERVICE_TIMEOUT_MS
  })

  if (kickstart.code !== 0) {
    const said = (kickstart.stderr || bootstrap.stderr || '').replace(/\s+/g, ' ').trim()
    throw plainError(
      'Your node was installed, but macOS would not set it to start automatically. ' +
        'You can still start it from this app whenever you want to. ' +
        (said === '' ? '' : `macOS said: ${said}`)
    )
  }
}

async function disableOnMac(): Promise<void> {
  const domain = guiDomain()
  await runProcess('launchctl', ['bootout', `${domain}/${AUTOSTART_LABEL}`], {
    timeoutMs: SERVICE_TIMEOUT_MS
  })
  await rm(plistPath(), { force: true }).catch(() => undefined)
}

/* -------------------------------------------------------------------------- */
/* Linux                                                                       */
/* -------------------------------------------------------------------------- */

/** Single-quote for POSIX sh: the only escaping any of the Linux files needs. */
function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function buildLauncher(binPath: string, repoPath: string): string {
  return [
    '#!/bin/sh',
    '# Written by BIC Archiver. Starts the IPFS node that serves the DAO archive.',
    `IPFS_PATH=${shQuote(repoPath)}`,
    'export IPFS_PATH',
    `exec ${shQuote(binPath)} daemon`,
    ''
  ].join('\n')
}

function buildUnit(launcher: string): string {
  return [
    '[Unit]',
    'Description=BIC Archiver IPFS node',
    'After=network-online.target',
    '',
    '[Service]',
    'Type=simple',
    `ExecStart=${launcher}`,
    // A crashed node that never comes back is how an archive quietly dies.
    'Restart=always',
    'RestartSec=10',
    '',
    '[Install]',
    'WantedBy=default.target',
    ''
  ].join('\n')
}

function buildDesktopEntry(launcher: string): string {
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=BIC Archiver IPFS node',
    'Comment=Keeps the BIC archive available on IPFS',
    `Exec=${launcher}`,
    'Terminal=false',
    'X-GNOME-Autostart-enabled=true',
    'NoDisplay=true',
    ''
  ].join('\n')
}

/** Is there a systemd we are allowed to talk to as this user? */
async function hasUserSystemd(): Promise<boolean> {
  const result = await runProcess('systemctl', ['--user', 'show-environment'], { timeoutMs: 15_000 })
  return !result.missing && result.code === 0
}

async function enableOnLinux(binPath: string, repoPath: string): Promise<void> {
  const launcher = launcherPath()
  await writeConfigFile(launcher, buildLauncher(binPath, repoPath), 0o755, 'The start-up script for your node')

  if (await hasUserSystemd()) {
    await rm(desktopPath(), { force: true }).catch(() => undefined)
    const unit = unitPath()
    await writeConfigFile(unit, buildUnit(launcher), 0o644, 'The start-up settings for your node')

    await runProcess('systemctl', ['--user', 'daemon-reload'], { timeoutMs: SERVICE_TIMEOUT_MS })
    const enabled = await runProcess(
      'systemctl',
      ['--user', 'enable', '--now', `${AUTOSTART_LABEL}.service`],
      { timeoutMs: SERVICE_TIMEOUT_MS }
    )
    if (enabled.code !== 0) {
      const said = enabled.stderr.replace(/\s+/g, ' ').trim()
      throw plainError(
        'Your node was installed, but this computer would not set it to start automatically. ' +
          'You can still start it from this app whenever you want to. ' +
          (said === '' ? '' : `The system said: ${said}`)
      )
    }
    return
  }

  // No user systemd (some minimal desktops, some containers). A desktop
  // autostart entry starts the node at login; it will not restart it after a
  // crash, which is worth knowing but far better than nothing.
  await rm(unitPath(), { force: true }).catch(() => undefined)
  await writeConfigFile(
    desktopPath(),
    buildDesktopEntry(launcher),
    0o644,
    'The start-up settings for your node'
  )
}

async function disableOnLinux(): Promise<void> {
  if (await hasUserSystemd()) {
    await runProcess('systemctl', ['--user', 'disable', '--now', `${AUTOSTART_LABEL}.service`], {
      timeoutMs: SERVICE_TIMEOUT_MS
    })
  }
  await rm(unitPath(), { force: true }).catch(() => undefined)
  await rm(desktopPath(), { force: true }).catch(() => undefined)
  await runProcess('systemctl', ['--user', 'daemon-reload'], { timeoutMs: SERVICE_TIMEOUT_MS })
  await rm(launcherPath(), { force: true }).catch(() => undefined)
}

async function isEnabledOnLinux(): Promise<boolean> {
  if (await exists(desktopPath())) return true
  if (!(await exists(unitPath()))) return false

  const result = await runProcess('systemctl', ['--user', 'is-enabled', `${AUTOSTART_LABEL}.service`], {
    timeoutMs: 15_000
  })
  if (result.missing) return false
  return /^(enabled|enabled-runtime|linked|static)/m.test(result.stdout.trim())
}

/* -------------------------------------------------------------------------- */
/* Windows                                                                     */
/* -------------------------------------------------------------------------- */

function buildStartupCmd(binPath: string, repoPath: string): string {
  // `set "NAME=value"` and quoted paths are what make a folder called
  // "C:\Users\Someone Else\..." work; `start "" /B` leaves no window behind.
  return [
    '@echo off',
    'rem Written by BIC Archiver. Starts the IPFS node that serves the DAO archive.',
    `set "IPFS_PATH=${repoPath}"`,
    `start "" /B "${binPath}" daemon`,
    ''
  ].join('\r\n')
}

async function enableOnWindows(binPath: string, repoPath: string): Promise<void> {
  const path = startupCmdPath()
  if (path === undefined) {
    throw plainError(
      'This app could not find your Windows Start-up folder, so it could not set your node to start ' +
        'automatically. You can still start it from this app whenever you want to.'
    )
  }
  await writeConfigFile(path, buildStartupCmd(binPath, repoPath), 0o644, 'The start-up settings for your node')
}

async function disableOnWindows(): Promise<void> {
  const path = startupCmdPath()
  if (path === undefined) return
  await rm(path, { force: true }).catch(() => undefined)
}

/* -------------------------------------------------------------------------- */
/* public API                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Set the member's node to start when they log in, and start it now.
 *
 * Never needs administrator rights on any platform.
 *
 * @throws A plain-English `Error` when the platform's service manager refuses,
 * or when the platform cannot be supported at all. The caller should treat that
 * as "the node works, it just will not start itself" rather than as a failed
 * installation.
 */
export async function enableAutostart(binPath: string, repoPath: string): Promise<void> {
  switch (process.platform) {
    case 'darwin':
      await enableOnMac(binPath, repoPath)
      return
    case 'linux':
      await enableOnLinux(binPath, repoPath)
      return
    case 'win32':
      await enableOnWindows(binPath, repoPath)
      return
    default:
      throw unsupported()
  }
}

/**
 * Stop the node starting automatically.
 *
 * On macOS and Linux this also stops the node right now, because the service
 * manager owns the running process — `bootout` and `disable --now` are how you
 * take it back. Best effort throughout: a login item that is already gone is a
 * success, not a failure.
 */
export async function disableAutostart(): Promise<void> {
  switch (process.platform) {
    case 'darwin':
      await disableOnMac()
      return
    case 'linux':
      await disableOnLinux()
      return
    case 'win32':
      await disableOnWindows()
      return
    default:
      // Nothing was ever installed on this platform, so nothing needs removing.
      return
  }
}

/** Will the member's node start by itself next time they log in? */
export async function isAutostartEnabled(): Promise<boolean> {
  switch (process.platform) {
    case 'darwin':
      return exists(plistPath())
    case 'linux':
      return isEnabledOnLinux()
    case 'win32': {
      const path = startupCmdPath()
      return path === undefined ? false : exists(path)
    }
    default:
      return false
  }
}

/**
 * Ask the platform's service manager to start the node now.
 *
 * Returns false when there is no login item installed, or the service manager
 * would not do it — the caller then falls back to starting the process itself.
 * Starting it through the service manager is preferred because the process then
 * belongs to launchd/systemd, and so outlives this app rather than dying with it.
 */
export async function startViaServiceManager(): Promise<boolean> {
  if (process.platform === 'darwin') {
    if (!(await exists(plistPath()))) return false
    const domain = guiDomain()
    const target = `${domain}/${AUTOSTART_LABEL}`
    // Bootstrap in case the agent is not loaded in this login session yet.
    await runProcess('launchctl', ['bootstrap', domain, plistPath()], { timeoutMs: SERVICE_TIMEOUT_MS })
    const result = await runProcess('launchctl', ['kickstart', target], { timeoutMs: SERVICE_TIMEOUT_MS })
    return result.code === 0
  }

  if (process.platform === 'linux') {
    if (!(await exists(unitPath()))) return false
    if (!(await hasUserSystemd())) return false
    const result = await runProcess('systemctl', ['--user', 'start', `${AUTOSTART_LABEL}.service`], {
      timeoutMs: SERVICE_TIMEOUT_MS
    })
    return result.code === 0
  }

  return false
}

/**
 * Ask the platform's service manager to stop the node.
 *
 * This has to happen *before* anything tries to kill the process directly:
 * `KeepAlive` on macOS and `Restart=always` on Linux exist precisely so that a
 * dead node comes back, so killing the process without telling the service
 * manager first simply restarts it a moment later.
 *
 * Returns false when there is no service manager entry to stop.
 */
export async function stopViaServiceManager(): Promise<boolean> {
  if (process.platform === 'darwin') {
    if (!(await exists(plistPath()))) return false
    const result = await runProcess('launchctl', ['bootout', `${guiDomain()}/${AUTOSTART_LABEL}`], {
      timeoutMs: SERVICE_TIMEOUT_MS
    })
    // "not loaded" is a fine outcome: the service is not running either way.
    return result.code === 0 || /not.*(loaded|find)/i.test(result.stderr)
  }

  if (process.platform === 'linux') {
    if (!(await exists(unitPath()))) return false
    if (!(await hasUserSystemd())) return false
    const result = await runProcess('systemctl', ['--user', 'stop', `${AUTOSTART_LABEL}.service`], {
      timeoutMs: SERVICE_TIMEOUT_MS
    })
    return result.code === 0
  }

  return false
}

/**
 * Where the platform put the node's log, when it keeps one.
 *
 * Worth surfacing: when a node will not start, this file is the only place the
 * reason is written down, and pointing a member at it beats asking them to
 * describe the symptom.
 */
export async function autostartLogPath(): Promise<string | undefined> {
  if (process.platform !== 'darwin') return undefined
  const path = join(homedir(), 'Library', 'Logs', `${AUTOSTART_LABEL}.err.log`)
  return (await exists(path)) ? path : undefined
}

/**
 * The last few lines the node wrote to its log, for a failure message.
 *
 * Only used when something has already gone wrong, and always trimmed: a log
 * tail belongs in a detail line, not in a wall of text.
 */
export async function recentLogTail(maxChars = 400): Promise<string | undefined> {
  const path = await autostartLogPath()
  if (path === undefined) return undefined
  const text = await readFile(path, 'utf8').catch(() => undefined)
  if (text === undefined) return undefined
  const trimmed = text.replace(/\s+/g, ' ').trim()
  if (trimmed === '') return undefined
  return trimmed.length <= maxChars ? trimmed : `…${trimmed.slice(-maxChars)}`
}
