/**
 * `repo.lock` — the failure that silently blocked every restart.
 *
 * When Kubo is killed rather than asked to stop (a crash, a force-quit, a
 * laptop losing power, `installAndStart` being cancelled at the wrong moment)
 * it leaves `repo.lock` behind in its repository. From then on **every**
 * attempt to start the daemon fails, and it fails the worst possible way: no
 * dialog, nothing in any log a member would ever open, and a node that simply
 * never comes back. For an archive whose entire failure mode is "nobody
 * noticed", a restart that silently stops working is the exact shape of the
 * problem this app exists to end.
 *
 * The obvious fix — delete the lock before starting — is also how you corrupt a
 * datastore, because a lock a *running* daemon holds is not stale. Two nodes
 * with the same repository open is data loss, not an inconvenience.
 *
 * So this file pins down both halves of that trade, and neither is worth much
 * without the other:
 *
 *   - a genuinely abandoned lock **is** cleared, so the member's node starts again;
 *   - a lock with a live daemon behind it is **never** touched, established three
 *     independent ways (the node answers; the lock is seconds old; some process
 *     still holds the file open) so that no single check failing is enough to
 *     lose the datastore.
 *
 * The "held open" case is not simulated: the file really is opened, and `lsof`
 * really is asked. That is the same question the shipping code puts to the
 * operating system, answered by the same operating system.
 */

import { mkdir, open, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { clearStaleLock, pathExists, runProcess } from '../../src/main/node/install'
import { TempDirs } from '../helpers/support'

import { FetchRouter, json } from './harness'

const temps = new TempDirs()

afterEach(async () => {
  vi.unstubAllGlobals()
  await temps.cleanup()
})

/** The daemon takes the lock before it listens, so anything newer is left alone. */
const GRACE_MS = 15_000

interface Repo {
  path: string
  lockPath: string
}

/**
 * A Kubo repository on disk, in whichever state the test needs.
 *
 * `apiAddr` is what the config says; `liveApiAddr` is the `api` file a running
 * daemon writes and a killed one leaves behind. The distinction matters: after
 * a SIGKILL *both* files survive, which is precisely why the address in `api`
 * cannot be taken as evidence that anything is running.
 */
async function makeRepo(
  options: { apiAddr?: string; liveApiAddr?: string; lock?: 'fresh' | 'stale' | 'none' | 'directory' } = {}
): Promise<Repo> {
  const path = await temps.make('bic-repo-')
  const lockPath = join(path, 'repo.lock')

  await writeFile(
    join(path, 'config'),
    JSON.stringify({
      Identity: { PeerID: '12D3KooWQ9dpM1QVQpvbCP1pnKKVQFbYqXbGtBpKQKQKQKQKQKQ0' },
      Addresses: {
        API: options.apiAddr ?? '/ip4/127.0.0.1/tcp/5199',
        Gateway: '/ip4/127.0.0.1/tcp/8199'
      },
      Datastore: { StorageMax: '20GiB' }
    }),
    'utf8'
  )

  if (options.liveApiAddr !== undefined) {
    await writeFile(join(path, 'api'), options.liveApiAddr, 'utf8')
  }

  const lock = options.lock ?? 'stale'
  if (lock === 'directory') {
    await mkdir(lockPath)
  } else if (lock !== 'none') {
    await writeFile(lockPath, '', 'utf8')
    if (lock === 'stale') {
      // Old enough to be past the grace period, which is what a lock left by
      // yesterday's crash looks like.
      const when = new Date(Date.now() - GRACE_MS * 4)
      await utimes(lockPath, when, when)
    }
  }

  return { path, lockPath }
}

/** Does this machine have the tool the third check depends on? */
async function hasLsof(): Promise<boolean> {
  const result = await runProcess('lsof', ['-v'], { timeoutMs: 10_000 })
  return !result.missing
}

/* -------------------------------------------------------------------------- */
/* clearing a lock nothing holds                                               */
/* -------------------------------------------------------------------------- */

describe('clearStaleLock, when nothing holds the repository', () => {
  it('clears the leftover lock a hard kill leaves behind', async () => {
    // The real scenario, reconstructed: after a SIGKILL both `repo.lock` and the
    // `api` file survive, and the address in `api` answers nothing at all.
    const repo = await makeRepo({ liveApiAddr: '/ip4/127.0.0.1/tcp/5199' })
    const router = new FetchRouter().offline().install()

    await expect(clearStaleLock(repo.path)).resolves.toBe(true)

    expect(await pathExists(repo.lockPath), 'the stale lock is still there').toBe(false)

    // It did not simply delete on sight: the node was asked first.
    expect(router.hits(/127\.0\.0\.1:5199/).length).toBeGreaterThan(0)
    expect(router.hits(/\/api\/v0\/id/).length).toBeGreaterThan(0)
  })

  it('leaves the rest of the repository alone', async () => {
    const repo = await makeRepo({ liveApiAddr: '/ip4/127.0.0.1/tcp/5199' })
    new FetchRouter().offline().install()

    await clearStaleLock(repo.path)

    // Only the lock goes. The config — and with it the node's identity, its
    // ports and its storage limit — is untouched.
    expect(await pathExists(join(repo.path, 'config'))).toBe(true)
    const config = JSON.parse(await readFile(join(repo.path, 'config'), 'utf8')) as {
      Identity?: { PeerID?: string }
    }
    expect(config.Identity?.PeerID).toBe('12D3KooWQ9dpM1QVQpvbCP1pnKKVQFbYqXbGtBpKQKQKQKQKQKQ0')
  })

  it('is a no-op, not an error, when there is no lock', async () => {
    const repo = await makeRepo({ lock: 'none' })
    const router = new FetchRouter().offline().install()

    await expect(clearStaleLock(repo.path)).resolves.toBe(false)

    // Nothing to clear means nothing to check: no node is disturbed and no
    // process list is walked over a file that does not exist.
    expect(router.calls).toHaveLength(0)
  })

  it('does not touch a repository that has no config at all', async () => {
    const empty = await temps.make('bic-repo-empty-')
    new FetchRouter().offline().install()
    await expect(clearStaleLock(empty)).resolves.toBe(false)
  })
})

/* -------------------------------------------------------------------------- */
/* refusing to clear a lock that is genuinely held                             */
/* -------------------------------------------------------------------------- */

describe('clearStaleLock, when a daemon is alive', () => {
  it('refuses when the node answers on the address in its config', async () => {
    const repo = await makeRepo()
    const router = new FetchRouter()
      .on(
        /127\.0\.0\.1:5199\/api\/v0\/id/,
        () => json({ ID: '12D3KooWQ9dpM1QVQpvbCP1pnKKVQFbYqXbGtBpKQKQKQKQKQKQ0', Addresses: [] })
      )
      .offline()
      .install()

    await expect(clearStaleLock(repo.path)).resolves.toBe(false)

    // Still there — a running daemon's lock is its own.
    expect(await pathExists(repo.lockPath)).toBe(true)
    expect(router.hits(/\/api\/v0\/id/).length).toBeGreaterThan(0)
  })

  it('refuses when the node answers on the address in the `api` file', async () => {
    // A daemon that moved to a free port writes the port it actually took into
    // `api`, and the config still names the old one. Checking only the config
    // would find silence and conclude, wrongly, that nothing is running.
    const repo = await makeRepo({
      apiAddr: '/ip4/127.0.0.1/tcp/5199',
      liveApiAddr: '/ip4/127.0.0.1/tcp/5233'
    })
    const router = new FetchRouter()
      .on(/127\.0\.0\.1:5233\/api\/v0\/id/, () => json({ ID: 'QmLive', Addresses: [] }))
      .offline()
      .install()

    await expect(clearStaleLock(repo.path)).resolves.toBe(false)
    expect(await pathExists(repo.lockPath)).toBe(true)
    expect(router.hits(/127\.0\.0\.1:5233/).length).toBeGreaterThan(0)
  })

  it('refuses while a process still has the lock file open, even with nothing answering', async () => {
    // The second line of defence, and the one that matters when a daemon is
    // busy opening a large datastore: it holds the lock but is not yet
    // listening, so the API is silent and only the operating system knows the
    // truth. Deleting here is what lets a second daemon in.
    if (!(await hasLsof())) {
      // Without `lsof` the module documents that it cannot tell, and prefers a
      // startable node to an unstartable one. Nothing to assert on this machine.
      return
    }

    const repo = await makeRepo()
    new FetchRouter().offline().install()

    const handle = await open(repo.lockPath, 'r')
    try {
      await expect(clearStaleLock(repo.path)).resolves.toBe(false)
      expect(await pathExists(repo.lockPath), 'a held lock was deleted').toBe(true)
    } finally {
      await handle.close()
    }

    // And once the holder lets go, the same lock clears — so the refusal above
    // was about the open handle and nothing else.
    await expect(clearStaleLock(repo.path)).resolves.toBe(true)
    expect(await pathExists(repo.lockPath)).toBe(false)
  })

  it('refuses a lock that was taken moments ago', async () => {
    // Freshness is its own check: a daemon that started a second ago has the
    // lock and is not yet answering, and there is no way to tell that from a
    // crash except by the clock.
    const repo = await makeRepo({ lock: 'fresh' })
    new FetchRouter().offline().install()

    await expect(clearStaleLock(repo.path)).resolves.toBe(false)
    expect(await pathExists(repo.lockPath)).toBe(true)
  })

  it('will not delete something that is not a file', async () => {
    const repo = await makeRepo({ lock: 'directory' })
    new FetchRouter().offline().install()

    await expect(clearStaleLock(repo.path)).resolves.toBe(false)
    expect((await stat(repo.lockPath)).isDirectory()).toBe(true)
    await rm(repo.lockPath, { recursive: true, force: true })
  })
})
