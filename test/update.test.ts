/**
 * Version comparison for the update check.
 *
 * Small surface, and worth pinning down anyway, because both ways of getting it
 * wrong are user-visible and annoying. Tell a member on the newest build that an
 * update exists and they will go and reinstall what they already have; miss a
 * real release and the check is decoration. The unreadable cases matter most:
 * the version on the right-hand side comes out of a GitHub reply, which is text
 * from the internet and is allowed to be anything at all.
 */

import { describe, expect, it } from 'vitest'

import { isNewer, parseVersion } from '../src/shared/update'

describe('parseVersion', () => {
  it('reads a plain version', () => {
    expect(parseVersion('1.2.3')).toEqual([1, 2, 3])
  })

  it('reads the v-prefixed form the tags actually use', () => {
    expect(parseVersion('v0.2.1')).toEqual([0, 2, 1])
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
      '1.2',
      '1',
      'v',
      'latest',
      '1.2.3.4',
      '01.02.03.04.05',
      'not a version',
      '1.2.-3',
      '9999999.0.0',
      '<script>alert(1)</script>'
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

  describe('an unreadable version is never an update', () => {
    for (const [candidate, current] of [
      ['latest', '0.2.1'],
      ['', '0.2.1'],
      ['0.2.2', 'unknown'],
      ['0.2.2', ''],
      [null, '0.2.1'],
      ['0.2.2', null],
      [undefined, undefined]
    ] as const) {
      it(`${JSON.stringify(candidate)} over ${JSON.stringify(current)}`, () => {
        expect(isNewer(candidate, current)).toBe(false)
      })
    }
  })
})
