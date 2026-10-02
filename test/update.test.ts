/**
 * Version comparison for the update check.
 *
 * Small surface, and worth pinning down anyway, because both ways of getting it
 * wrong are user-visible and annoying. Tell a member on the newest build that an
 * update exists and they will go and reinstall what they already have; miss a
 * real release and the check is decoration. The unreadable cases matter most:
 * the version on the right-hand side comes out of a GitHub reply, which is text
 * from the internet and is allowed to be anything at all.
 *
 * The second way has already happened once: 0.3.0 was published under the tag
 * `v0.3`, the parser only knew three-part versions, and a member running 0.3.0
 * would have been told they were up to date when `v0.4` came out.
 */

import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'

import { checkForUpdate } from '../src/main/update'
import { UPDATE_SOURCE, isNewer, parseVersion } from '../src/shared/update'

describe('parseVersion', () => {
  it('reads a plain version', () => {
    expect(parseVersion('1.2.3')).toEqual([1, 2, 3])
  })

  it('reads the v-prefixed form the tags actually use', () => {
    expect(parseVersion('v0.2.1')).toEqual([0, 2, 1])
  })

  it('reads a tag that stops early, counting the missing parts as 0', () => {
    expect(parseVersion('v0.3')).toEqual([0, 3, 0])
    expect(parseVersion('0.4')).toEqual([0, 4, 0])
    expect(parseVersion('v1')).toEqual([1, 0, 0])
    expect(parseVersion('1')).toEqual([1, 0, 0])
    expect(parseVersion('0.4-rc.1')).toEqual([0, 4, 0])
  })

  it('ignores surrounding whitespace', () => {
    expect(parseVersion('  v10.0.4 ')).toEqual([10, 0, 4])
  })

  it('keeps the numbers and drops a pre-release suffix', () => {
    expect(parseVersion('1.2.3-rc.1')).toEqual([1, 2, 3])
    expect(parseVersion('1.2.3+build7')).toEqual([1, 2, 3])
  })

  describe('refuses anything it cannot read, rather than guessing', () => {
    for (const bad of [
      '',
      'v',
      'latest',
      '1.2.3.4',
      '01.02.03.04.05',
      'not a version',
      '1.2.-3',
      '9999999.0.0',
      '<script>alert(1)</script>',
      // A short tag is fine. A broken one is not.
      '1.',
      '.4',
      'v0.4.',
      '0..4',
      'v.4',
      'vv0.4',
      '9999999',
      '0.9999999',
      '0.4x',
      '0.4 beta',
      '1e3',
      '0x10',
      '-1',
      '０.４'
    ]) {
      it(JSON.stringify(bad), () => {
        expect(parseVersion(bad)).toBeNull()
      })
    }

    for (const bad of [null, undefined, 42, {}, ['1.2.3']]) {
      it(String(JSON.stringify(bad)), () => {
        expect(parseVersion(bad)).toBeNull()
      })
    }
  })
})

describe('isNewer', () => {
  it('sees a higher patch, minor and major', () => {
    expect(isNewer('0.2.2', '0.2.1')).toBe(true)
    expect(isNewer('0.3.0', '0.2.9')).toBe(true)
    expect(isNewer('1.0.0', '0.99.99')).toBe(true)
  })

  it('is false for the same version', () => {
    expect(isNewer('0.2.1', '0.2.1')).toBe(false)
    expect(isNewer('v0.2.1', '0.2.1')).toBe(false)
  })

  it('is false for an older version', () => {
    expect(isNewer('0.1.0', '0.2.1')).toBe(false)
    expect(isNewer('0.2.0', '0.2.1')).toBe(false)
  })

  it('compares numerically, not as text — 10 is above 9', () => {
    expect(isNewer('0.10.0', '0.9.0')).toBe(true)
    expect(isNewer('0.9.0', '0.10.0')).toBe(false)
  })

  it('does not rank a pre-release above the release of the same version', () => {
    expect(isNewer('1.2.3-rc.1', '1.2.3')).toBe(false)
    expect(isNewer('1.2.3', '1.2.3-rc.1')).toBe(false)
  })

  it('does not offer a short tag of the version already running', () => {
    expect(isNewer('v0.3', '0.3.0')).toBe(false)
    expect(isNewer('v0.3', '0.3.1')).toBe(false)
  })

  it('sees a newer release behind a short tag', () => {
    expect(isNewer('v0.4', '0.3.0')).toBe(true)
    expect(isNewer('1', '0.9.9')).toBe(true)
  })

  describe('an unreadable version is never an update', () => {
    for (const [candidate, current] of [
      ['latest', '0.2.1'],
      ['', '0.2.1'],
      ['0.2.2', 'unknown'],
      ['0.2.2', ''],
      [null, '0.2.1'],
      ['0.2.2', null],
      [undefined, undefined],
      ['v0.4.', '0.3.0'],
      ['0..4', '0.3.0'],
      ['v0.4.0.0', '0.3.0'],
      ['9999999', '0.3.0']
    ] as const) {
      it(`${JSON.stringify(candidate)} over ${JSON.stringify(current)}`, () => {
        expect(isNewer(candidate, current)).toBe(false)
      })
    }
  })
})

describe('checkForUpdate — the sentence a member is shown', () => {
  afterEach(() => {
    // Puts the offline guard from test/setup/no-network.ts back.
    vi.unstubAllGlobals()
  })

  /** Stand in for GitHub's `releases/latest`, answering with `reply`. */
  function githubAnswers(reply: unknown): Mock<typeof fetch> {
    const stub = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(reply), { status: 200 }))
    vi.stubGlobal('fetch', stub)
    return stub
  }

  it('offers v0.4 to a member on 0.3.0', async () => {
    githubAnswers({ tag_name: 'v0.4' })

    const result = await checkForUpdate('0.3.0')

    expect(result.newer).toBe(true)
    expect(result.latest).toBe('0.4')
    expect(result.summary).toBe('Version 0.4 is available. You are running 0.3.0.')
  })

  it('tells a member on 0.3.0 that v0.3 is the version they already have', async () => {
    githubAnswers({ tag_name: 'v0.3' })

    const result = await checkForUpdate('0.3.0')

    expect(result.newer).toBe(false)
    expect(result.summary).toBe('You are running 0.3.0, which is the newest version.')
  })

  describe('says a broken tag could not be read, instead of "you are up to date"', () => {
    for (const tag of ['v0.4.', '0..4', 'v0.4.0.0', 'V0.4', 'release-0.4']) {
      it(JSON.stringify(tag), async () => {
        githubAnswers({ tag_name: tag })

        const result = await checkForUpdate('0.3.0')

        expect(result.newer).toBe(false)
        expect(result.latest).toBeNull()
        expect(result.summary).toBe(
          'GitHub named a version this app could not read, so nothing changed.'
        )
      })
    }
  })

  it('asks the fixed address and links the fixed page, whatever else the reply says', async () => {
    const stub = githubAnswers({ tag_name: 'v0.4', html_url: 'https://example.com/elsewhere' })

    const result = await checkForUpdate('0.3.0')

    expect(stub).toHaveBeenCalledOnce()
    expect(stub.mock.calls[0]?.[0]).toBe(UPDATE_SOURCE.latest)
    expect(result.url).toBe(UPDATE_SOURCE.releases)
  })
})
