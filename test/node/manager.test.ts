/**
 * Whose node is this, and what are we allowed to do to it?
 *
 * Every destructive thing this app can do to an IPFS node hangs off one
 * question, and getting it wrong is not recoverable by an apology. A member who
 * already runs Kubo — Homebrew, IPFS Desktop, their own build, possibly with
 * years of pinned content in it — must find that node used and otherwise
 * completely untouched. `uninstallNode` deleting somebody else's binary, or
 * `installAndStart` rewriting somebody else's ports, would be this app causing
 * exactly the kind of loss it was written to prevent.
 *
 * So the first half of this file is about the boundary: an `external` node is
 * never uninstalled, never reconfigured, never shut down, and never even
 * claimed in the status object. The refusal is checked against real files that
 * the ordinary path genuinely does delete — there is a control at the end
 * showing the same call removing the same directory when the node *is* ours —
 * because "nothing was deleted" is worth nothing if nothing could have been.
 *
 * The second half is about telling the member something true and useful:
 * a node reachable only through `/p2p-circuit` relays is behind a router that
 * allows no incoming connections. It is still serving the archive, so this is
 * not an error and must not read as one, but it is a weaker contribution than
 * the member probably thinks they are making, and they can fix it.
 *
 * Nothing here starts a daemon or writes to a real service manager: `autostart`
 * is replaced wholesale (its own file tests it), settings are in-memory, and
 * every RPC is answered by a router that has no handler for any write at all —
 * so "no write was attempted" is asserted against a fake that could not have
 * satisfied one.
 */

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DEFAULT_PINNING_SETTINGS, type PinningSettings } from '../../src/shared/pinning'
import { TempDirs } from '../helpers/support'

import { FetchRouter, kuboRpc, text } from './harness'

/* -------------------------------------------------------------------------- */
/* the app around the node, replaced                                           */
/* -------------------------------------------------------------------------- */

const settingsState = vi.hoisted(() => ({
  current: undefined as unknown as PinningSettings,
  saved: [] as PinningSettings[]
}))

vi.mock('../../src/main/settings', () => ({
  loadSettings: async (): Promise<PinningSettings> => settingsState.current,
  saveSettings: async (settings: PinningSettings): Promise<void> => {
    settingsState.saved.push(settings)
  }
}))

/**
 * Autostart is mocked rather than exercised, and deliberately so: a real
 * `disableAutostart()` here would `launchctl bootout` a service in the login
 * session of whoever ran the suite. Recording the calls also turns "an external
 * node is left alone" into something checkable — the assertion becomes *the
 * login item was never disabled*, rather than a hope that it was not.
 */
const autostart = vi.hoisted(() => ({
  enabled: false,
  calls: [] as string[]
}))

vi.mock('../../src/main/node/autostart', () => ({
  enableAutostart: async (): Promise<void> => {
    autostart.calls.push('enable')
    autostart.enabled = true
  },
  disableAutostart: async (): Promise<void> => {
    autostart.calls.push('disable')
    autostart.enabled = false
  },
  isAutostartEnabled: async (): Promise<boolean> => autostart.enabled,
  startViaServiceManager: async (): Promise<boolean> => {
    autostart.calls.push('start')
    return false
  },
  stopViaServiceManager: async (): Promise<boolean> => {
    autostart.calls.push('stop')
    return false
  },
  recentLogTail: async (): Promise<string | undefined> => undefined,
  autostartLogPath: async (): Promise<string | undefined> => undefined
}))

const { getNodeStatus, nodePaths, uninstallNode } = await import('../../src/main/node/manager')

/* -------------------------------------------------------------------------- */
/* fixtures                                                                    */
/* -------------------------------------------------------------------------- */

const temps = new TempDirs()

const OUR_PEER = '12D3KooWSoMeMaNaGeDnOdEiDeNtItYaAaAaAaAaAaAaAaAaAaAaAa'
const THEIR_PEER = '12D3KooWTheIrOwNnOdEiDeNtItYbBbBbBbBbBbBbBbBbBbBbBbBb'

let savedHome: string | undefined

beforeEach(async () => {
  savedHome = process.env['HOME']
  // `nodePaths()` derives from `os.homedir()` when Electron is absent, so a
  // temporary HOME puts the managed node's whole tree inside the test's own
  // directory. Nothing here can reach the real ~/.bic-archiver.
  process.env['HOME'] = await temps.make('bic-manager-home-')

  settingsState.current = structuredClone(DEFAULT_PINNING_SETTINGS)
  settingsState.saved.length = 0
  autostart.enabled = false
  autostart.calls.length = 0
})

afterEach(async () => {
  if (savedHome === undefined) delete process.env['HOME']
  else process.env['HOME'] = savedHome
  vi.unstubAllGlobals()
  await temps.cleanup()
})

/** Everything a previous managed install leaves on disk. */
async function installOurNode(
  options: { peerId?: string; apiPort?: number; storageMax?: string } = {}
): Promise<void> {
  const paths = nodePaths()
  const apiPort = options.apiPort ?? 5001

  await mkdir(paths.binDir, { recursive: true })
  await writeFile(paths.binPath, '#!/bin/sh\necho "ipfs version 0.43.0"\n', { mode: 0o755 })

  await mkdir(paths.repoPath, { recursive: true })
  await writeFile(
    join(paths.repoPath, 'config'),
    JSON.stringify({
      Identity: { PeerID: options.peerId ?? OUR_PEER },
      Addresses: { API: `/ip4/127.0.0.1/tcp/${apiPort}`, Gateway: '/ip4/127.0.0.1/tcp/8080' },
      Datastore: { StorageMax: options.storageMax ?? '20GiB' }
    }),
    'utf8'
  )
  // A marker inside the repository, so "the archive was kept" is a statement
  // about a file rather than about a directory entry.
  await writeFile(join(paths.repoPath, 'datastore-marker'), 'pretend 1.9 GB of rescued NFTs', 'utf8')

  await mkdir(dirname(paths.recordPath), { recursive: true })
  await writeFile(
    paths.recordPath,
    JSON.stringify({
      version: '0.43.0',
      binPath: paths.binPath,
      repoPath: paths.repoPath,
      installedAt: new Date('2026-05-01T00:00:00.000Z').toISOString()
    }),
    'utf8'
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

/** Anything that would change or end a node, as opposed to asking it something. */
const WRITE_RPCS = /\/api\/v0\/(shutdown|config\/replace|repo\/gc|pin\/rm|config\?arg=[^&]+&arg=)/

/* -------------------------------------------------------------------------- */
/* a node the member already had                                               */
/* -------------------------------------------------------------------------- */

describe('a node the member set up themselves', () => {
  /** Their node, answering on the default port, with nothing of ours on disk. */
  function theirNodeIsRunning(): FetchRouter {
    return new FetchRouter()
      .on(
        /127\.0\.0\.1:5001\//,
        kuboRpc({
          peerId: THEIR_PEER,
          addresses: ['/ip4/192.0.2.10/tcp/4001', '/ip4/127.0.0.1/tcp/4001'],
          version: '0.38.1',
          storageMax: '100GiB'
        })
      )
      .offline()
      .install()
  }

  it('is reported as external, and not claimed as ours', async () => {
    theirNodeIsRunning()

    const status = await getNodeStatus(settingsState.current)

    expect(status.state).toBe('external')
    expect(status.managed).toBe(false)
    expect(status.peerId).toBe(THEIR_PEER)
    expect(status.version).toBe('0.38.1')
    // We do not name their repository. Nothing downstream should be given a
    // path it might feel entitled to delete.
    expect(status.repoPath).toBeUndefined()
    expect(status.detail).toMatch(/never change, stop or remove it/i)
  })

  it('is only ever read from, never written to', async () => {
    const router = theirNodeIsRunning()

    await getNodeStatus(settingsState.current)

    expect(router.calls.length).toBeGreaterThan(0)
    expect(router.never(WRITE_RPCS), 'a write RPC was sent to somebody else’s node').toBe(true)
    // And their apiUrl is not rewritten into our settings either.
    expect(settingsState.saved).toHaveLength(0)
  })

  it('is refused by uninstall, in words that say where to go instead', async () => {
    theirNodeIsRunning()

    const message = await uninstallNode().then(
      () => 'it did not throw',
      (err: unknown) => (err instanceof Error ? err.message : String(err))
    )

    expect(message).toMatch(/was not set up by this app/i)
    expect(message).toMatch(/will not remove it/i)
    expect(message).toMatch(/Homebrew, IPFS Desktop/)
  })

  it('survives an uninstall completely — files, service, settings and process', async () => {
    // A leftover binary from an abandoned managed install, with no record
    // beside it, so the member has both: our stray files *and* their own
    // running node. This is the case where a careless uninstall does damage,
    // because `paths.binDir` is exactly what the ordinary path deletes.
    const paths = nodePaths()
    await mkdir(paths.binDir, { recursive: true })
    await writeFile(paths.binPath, 'leftover', 'utf8')

    const router = theirNodeIsRunning()
    autostart.enabled = true

    await expect(uninstallNode()).rejects.toThrowError(/will not remove it/i)

    // Nothing was deleted…
    expect(await exists(paths.binPath)).toBe(true)
    // …their node was not asked to shut down…
    expect(router.never(WRITE_RPCS)).toBe(true)
    // …their login item was not disabled…
    expect(autostart.calls).not.toContain('disable')
    expect(autostart.calls).not.toContain('stop')
    // …and their settings were not rewritten.
    expect(settingsState.saved).toHaveLength(0)
  })

  it('CONTROL: the same call does delete our node, so the refusal above means something', async () => {
    // Without this, every assertion in the previous test could be passing
    // because `uninstallNode` is incapable of deleting anything at all.
    await installOurNode()
    const paths = nodePaths()
    // Ours, and not running.
    new FetchRouter().offline().install()
    autostart.enabled = true

    const status = await uninstallNode()

    expect(await exists(paths.binPath), 'our binary should have been removed').toBe(false)
    expect(await exists(paths.recordPath)).toBe(false)
    expect(autostart.calls).toContain('disable')
    expect(status.state).toBe('not-installed')

    // But the archive itself stays: "remove the program" is not "delete 1.9 GB
    // of rescued NFTs", and `removeRepo` was not asked for.
    expect(await exists(join(paths.repoPath, 'datastore-marker'))).toBe(true)
    expect(status.detail).toMatch(/still on this disk/i)
    expect(await readFile(join(paths.repoPath, 'datastore-marker'), 'utf8')).toContain('rescued NFTs')
  })

  it('is not mistaken for ours just because it holds the port ours wants', async () => {
    // Our node is installed but stopped, and something else — their Homebrew
    // node — has taken 5001. Peer ID is the discriminator, never the port.
    await installOurNode()
    new FetchRouter()
      .on(/127\.0\.0\.1:5001\//, kuboRpc({ peerId: THEIR_PEER, addresses: [] }))
      .offline()
      .install()

    const status = await getNodeStatus(settingsState.current)

    expect(status.state).toBe('installed-stopped')
    expect(status.peerId).not.toBe(THEIR_PEER)
    expect(status.detail).toMatch(/Another IPFS node is using/i)
    expect(status.detail).toMatch(/move it to a free port/i)
  })
})

/* -------------------------------------------------------------------------- */
/* a node that can only be reached through relays                              */
/* -------------------------------------------------------------------------- */

describe('a node behind a router that allows no incoming connections', () => {
  /** Every announced address goes through somebody else's relay. */
  const RELAY_ONLY = [
    `/ip4/147.75.83.83/tcp/4001/p2p/12D3KooWRelayOne/p2p-circuit/p2p/${OUR_PEER}`,
    `/ip4/145.40.118.135/udp/4001/quic-v1/p2p/12D3KooWRelayTwo/p2p-circuit/p2p/${OUR_PEER}`
  ]

  it('says so, in terms of what it means rather than what it is called', async () => {
    await installOurNode()
    new FetchRouter()
      .on(/127\.0\.0\.1:5001\//, kuboRpc({ peerId: OUR_PEER, addresses: RELAY_ONLY }))
      .offline()
      .install()
    autostart.enabled = true

    const status = await getNodeStatus(settingsState.current)

    expect(status.state).toBe('running')
    expect(status.managed).toBe(true)
    expect(status.multiaddrs?.every((addr) => addr.includes('/p2p-circuit'))).toBe(true)

    const detail = status.detail ?? ''
    // The words a member can act on: what is happening, that it still works,
    // and the one thing that would improve it.
    expect(detail).toMatch(/only be reached through relays/i)
    expect(detail).toMatch(/other computers passing traffic on its behalf/i)
    expect(detail).toMatch(/your router does not allow direct connections/i)
    expect(detail).toMatch(/still serving the archive/i)
    expect(detail).toMatch(/port 4001/)
    // Not an error, and it must not read like one — this member is providing.
    expect(status.state).not.toBe('error')
    expect(detail).not.toMatch(/NAT|p2p-circuit|multiaddr/i)
  })

  it('says nothing of the kind when even one address is direct', async () => {
    await installOurNode()
    new FetchRouter()
      .on(
        /127\.0\.0\.1:5001\//,
        kuboRpc({
          peerId: OUR_PEER,
          addresses: [`/ip4/203.0.113.7/tcp/4001/p2p/${OUR_PEER}`, ...RELAY_ONLY]
        })
      )
      .offline()
      .install()
    autostart.enabled = true

    const status = await getNodeStatus(settingsState.current)

    expect(status.state).toBe('running')
    expect(status.detail ?? '').not.toMatch(/only be reached through relays/i)
  })

  it('applies to an external node too, since the member is still the provider', async () => {
    new FetchRouter()
      .on(
        /127\.0\.0\.1:5001\//,
        kuboRpc({
          peerId: THEIR_PEER,
          addresses: [`/ip4/147.75.83.83/tcp/4001/p2p/12D3KooWRelayOne/p2p-circuit/p2p/${THEIR_PEER}`]
        })
      )
      .offline()
      .install()

    const status = await getNodeStatus(settingsState.current)

    expect(status.state).toBe('external')
    expect(status.detail ?? '').toMatch(/only be reached through relays/i)
    // Both things are true at once and both are worth saying.
    expect(status.detail ?? '').toMatch(/never change, stop or remove it/i)
  })
})

/* -------------------------------------------------------------------------- */
/* nothing at all                                                              */
/* -------------------------------------------------------------------------- */

describe('a computer with no node', () => {
  it('reports not-installed, and says what setting one up is for', async () => {
    new FetchRouter().offline().install()

    const status = await getNodeStatus(settingsState.current)

    expect(status.state).toBe('not-installed')
    expect(status.managed).toBe(false)
    expect(status.autostart).toBe(false)
    expect(status.detail).toMatch(/no IPFS node on this computer yet/i)
    expect(status.detail).toMatch(/other people can actually get files from/i)
  })

  it('recognises a set-up that did not finish', async () => {
    const paths = nodePaths()
    await mkdir(paths.repoPath, { recursive: true })
    new FetchRouter().offline().install()

    const status = await getNodeStatus(settingsState.current)

    expect(status.state).toBe('not-installed')
    expect(status.detail).toMatch(/did not finish/i)
    expect(status.detail).toMatch(/pick up where it left off/i)
  })

  it('uninstalling nothing is not an error', async () => {
    new FetchRouter().offline().install()
    const status = await uninstallNode()
    expect(status.state).toBe('not-installed')
  })

  it('a node that answers with something that is not Kubo is not treated as a node', async () => {
    // A dev server on 5001 is a real thing that happens.
    new FetchRouter()
      .on(/127\.0\.0\.1:5001\//, () => text('<!doctype html><title>My app</title>', 200, { 'content-type': 'text/html' }))
      .offline()
      .install()

    const status = await getNodeStatus(settingsState.current)
    expect(status.state).toBe('not-installed')
    expect(status.managed).toBe(false)
  })
})
