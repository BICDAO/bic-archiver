/**
 * `parseIpfsUri` — every way an IPFS link is written in the wild.
 *
 * This is the step the manual instructions describe as "copy only the hash, no slashes".
 * Getting it wrong in either direction is expensive: treat a gateway URL as plain HTTP and
 * the archive silently loses the original CID; fail to recognise a bare hash and a member
 * is told their perfectly good input is nonsense.
 */

import { describe, expect, it } from 'vitest'

import { parseIpfsUri } from '../src/main/chain/tokenUri'

/** A real CIDv0 (46 chars, base58) — the BAYC metadata directory. */
const CID_V0 = 'QmeSjSinHpPnmXmspMjwiXyN6zS4E9zccariGR3jxcaWtq'
/** A real CIDv1 (59 chars, lowercase base32) — the DAO's Oct-2025 backup root. */
const CID_V1 = 'bafybeidgu3wl7p6lggejzxcvzcbnwrbcatbgktcvk6aqfe3ficuhxwilym'

describe('parseIpfsUri', () => {
  describe('the forms a contract returns', () => {
    it('ipfs://CID', () => {
      expect(parseIpfsUri(`ipfs://${CID_V0}`)).toEqual({ cid: CID_V0, path: '' })
    })

    it('ipfs://ipfs/CID — the duplicated namespace older contracts emit', () => {
      expect(parseIpfsUri(`ipfs://ipfs/${CID_V0}`)).toEqual({ cid: CID_V0, path: '' })
    })

    it('ipfs://CID/1 — a token id inside a directory', () => {
      expect(parseIpfsUri(`ipfs://${CID_V0}/1`)).toEqual({ cid: CID_V0, path: '1' })
    })

    it('ipfs://CID/deep/path/1.json', () => {
      expect(parseIpfsUri(`ipfs://${CID_V0}/deep/path/1.json`)).toEqual({
        cid: CID_V0,
        path: 'deep/path/1.json'
      })
    })

    it('ipfs:/CID and ipfs:CID — malformed but common', () => {
      expect(parseIpfsUri(`ipfs:/${CID_V0}`)).toEqual({ cid: CID_V0, path: '' })
      expect(parseIpfsUri(`ipfs:${CID_V0}`)).toEqual({ cid: CID_V0, path: '' })
    })

    it('/ipfs/CID and ipfs/CID', () => {
      expect(parseIpfsUri(`/ipfs/${CID_V0}/1`)).toEqual({ cid: CID_V0, path: '1' })
      expect(parseIpfsUri(`ipfs/${CID_V0}`)).toEqual({ cid: CID_V0, path: '' })
    })

    it('dweb:/ipfs/CID', () => {
      expect(parseIpfsUri(`dweb:/ipfs/${CID_V0}`)).toEqual({ cid: CID_V0, path: '' })
    })
  })

  describe('gateway URLs — IPFS content that merely arrives over https', () => {
    it('https://ipfs.io/ipfs/CID/nft.json', () => {
      expect(parseIpfsUri(`https://ipfs.io/ipfs/${CID_V0}/nft.json`)).toEqual({
        cid: CID_V0,
        path: 'nft.json'
      })
    })

    it('https://CID.ipfs.dweb.link/x — the subdomain form', () => {
      expect(parseIpfsUri(`https://${CID_V1}.ipfs.dweb.link/x`)).toEqual({
        cid: CID_V1,
        path: 'x'
      })
    })

    it('a subdomain gateway with no path', () => {
      expect(parseIpfsUri(`https://${CID_V1}.ipfs.dweb.link`)).toEqual({ cid: CID_V1, path: '' })
    })

    it('drops a query string, e.g. ?filename=cat.png', () => {
      expect(parseIpfsUri(`https://ipfs.io/ipfs/${CID_V0}/cat.png?filename=cat.png`)).toEqual({
        cid: CID_V0,
        path: 'cat.png'
      })
    })

    it('drops a fragment', () => {
      expect(parseIpfsUri(`ipfs://${CID_V0}/1#top`)).toEqual({ cid: CID_V0, path: '1' })
    })

    it('handles plain http as well as https', () => {
      expect(parseIpfsUri(`http://localhost:8080/ipfs/${CID_V0}/1`)).toEqual({
        cid: CID_V0,
        path: '1'
      })
    })
  })

  describe('bare hashes', () => {
    it('a bare CIDv0', () => {
      expect(parseIpfsUri(CID_V0)).toEqual({ cid: CID_V0, path: '' })
    })

    it('a bare CIDv1', () => {
      expect(parseIpfsUri(CID_V1)).toEqual({ cid: CID_V1, path: '' })
    })

    it('a bare hash with a path after it', () => {
      expect(parseIpfsUri(`${CID_V0}/1`)).toEqual({ cid: CID_V0, path: '1' })
    })
  })

  describe('tidying up what people paste', () => {
    it('trims whitespace, quotes and angle brackets', () => {
      expect(parseIpfsUri(`  "ipfs://${CID_V0}/1"  `)).toEqual({ cid: CID_V0, path: '1' })
      expect(parseIpfsUri(`<ipfs://${CID_V0}>`)).toEqual({ cid: CID_V0, path: '' })
    })

    it('strips the NUL padding a contract may leave on a fixed-width string', () => {
      expect(parseIpfsUri(`ipfs://${CID_V0}\0\0\0`)).toEqual({ cid: CID_V0, path: '' })
    })

    it('drops a trailing slash rather than inventing an empty path segment', () => {
      expect(parseIpfsUri(`ipfs://${CID_V0}/`)).toEqual({ cid: CID_V0, path: '' })
    })

    it('returns the CID exactly as it appeared, without normalising v0 to v1', () => {
      const parsed = parseIpfsUri(`ipfs://${CID_V0}/1`)
      expect(parsed?.cid).toBe(CID_V0)
      expect(parsed?.cid.startsWith('Qm')).toBe(true)
    })
  })

  describe('things that are not IPFS links', () => {
    it.each([
      ['an ordinary web URL', 'https://api.example.com/metadata/1.json'],
      ['an Arweave URI', 'ar://abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHI'],
      ['a data URI', 'data:application/json;base64,eyJuYW1lIjoiWCJ9'],
      ['a bare word', 'hello'],
      ['an empty string', ''],
      ['whitespace only', '   '],
      ['a token id', '4271'],
      ['ipfs:// with nothing after it', 'ipfs://'],
      ['a gateway URL with no CID', 'https://ipfs.io/ipfs/not-a-cid'],
      ['a hostname that merely contains .ipfs.', 'https://notacid.ipfs.dweb.link/x']
    ])('returns null for %s', (_label, input) => {
      expect(parseIpfsUri(input)).toBeNull()
    })

    it('returns null for a non-string', () => {
      expect(parseIpfsUri(undefined as unknown as string)).toBeNull()
      expect(parseIpfsUri(null as unknown as string)).toBeNull()
      expect(parseIpfsUri(42 as unknown as string)).toBeNull()
    })
  })
})
