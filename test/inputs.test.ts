/**
 * Whatever the member happened to have on the clipboard.
 *
 * `parseTokenInput` is the app's front door, `sanitizeFolderName` decides what the archive
 * looks like on disk and inside IPFS, and `extractAssetUrls` decides what actually gets
 * saved. All three are pure, so all three are cheap to pin down properly.
 *
 * Invisible characters are written as \uXXXX escapes throughout: a literal zero-width
 * space in a test file is a test nobody can review.
 */

import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'vitest'

import { extractAssetUrls, parseTokenInput, sanitizeFolderName } from '../src/main/archive/inputs'
import { at } from './helpers/support'

/** Bored Ape Yacht Club - a real mainnet collection, used as a realistic address. */
const BAYC = '0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D'
const BAYC_LOWER = BAYC.toLowerCase()
/** feistydao.eth resolves to this. */
const FEISTY = '0x8569FCa4fb54CE58228992CDA60bc920A574cf39'

describe('parseTokenInput - OpenSea links', () => {
  it('reads the modern /assets/<chain>/<contract>/<id> form', () => {
    expect(parseTokenInput(`https://opensea.io/assets/ethereum/${BAYC}/1`)).toEqual([
      { chainId: 1, contract: BAYC_LOWER, tokenIds: ['1'] }
    ])
  })

  it('reads the older /assets/<contract>/<id> form as Ethereum', () => {
    expect(parseTokenInput(`https://opensea.io/assets/${BAYC}/7`)).toEqual([
      { chainId: 1, contract: BAYC_LOWER, tokenIds: ['7'] }
    ])
  })

  it('reads the OpenSea "matic" slug as Polygon', () => {
    expect(parseTokenInput(`https://opensea.io/assets/matic/${BAYC}/5`)).toEqual([
      { chainId: 137, contract: BAYC_LOWER, tokenIds: ['5'] }
    ])
  })

  it('reads the /item/ form and a www. prefix', () => {
    expect(parseTokenInput(`https://www.opensea.io/item/base/${BAYC}/12`)).toEqual([
      { chainId: 8453, contract: BAYC_LOWER, tokenIds: ['12'] }
    ])
  })

  it('reads a collection link with no token number as "the whole collection"', () => {
    expect(parseTokenInput(`https://opensea.io/assets/ethereum/${BAYC}`)).toEqual([
      { chainId: 1, contract: BAYC_LOWER, tokenIds: [] }
    ])
  })

  it('explains an OpenSea link that is not an item link', () => {
    expect(() => parseTokenInput('https://opensea.io/collection/boredapeyachtclub')).toThrow(
      /does not point at a single NFT/i
    )
  })

  it('names the network it cannot read, and lists the ones it can', () => {
    expect(() => parseTokenInput(`https://opensea.io/assets/solana/${BAYC}/1`)).toThrow(
      /"solana" network.*Supported networks: Ethereum, Polygon, Base, Arbitrum, Optimism, Klaytn and Avalanche/is
    )
  })
})

describe('parseTokenInput - Etherscan and other links', () => {
  it('reads etherscan.io/token/<contract>?a=<id>', () => {
    expect(parseTokenInput(`https://etherscan.io/token/${BAYC}?a=123`)).toEqual([
      { chainId: 1, contract: BAYC_LOWER, tokenIds: ['123'] }
    ])
  })

  it('reads polygonscan.com as chain 137', () => {
    expect(parseTokenInput(`https://polygonscan.com/token/${BAYC}?a=9`)).toEqual([
      { chainId: 137, contract: BAYC_LOWER, tokenIds: ['9'] }
    ])
  })

  it('does not mistake a holder address in ?a= for a token number', () => {
    expect(parseTokenInput(`https://etherscan.io/token/${BAYC}?a=${FEISTY}`)).toEqual([
      { chainId: 1, contract: BAYC_LOWER, tokenIds: [] }
    ])
  })

  it('reads a Rarible-style 0xCONTRACT:123 path segment', () => {
    expect(parseTokenInput(`https://rarible.com/token/${BAYC}:42`)).toEqual([
      { chainId: 1, contract: BAYC_LOWER, tokenIds: ['42'] }
    ])
  })

  it('explains a link with no contract address in it', () => {
    expect(() => parseTokenInput('https://example.com/some/page')).toThrow(
      /could not find a contract address in the link/i
    )
  })
})

describe('parseTokenInput - addresses, ranges and lists', () => {
  it('accepts a bare contract address', () => {
    expect(parseTokenInput(BAYC)).toEqual([{ chainId: 1, contract: BAYC_LOWER, tokenIds: [] }])
  })

  it('lowercases the address so the same contract never appears twice', () => {
    const specs = parseTokenInput(`${BAYC} 1\n${BAYC_LOWER} 2`)
    expect(specs).toHaveLength(1)
    expect(at(specs, 0).tokenIds).toEqual(['1', '2'])
  })

  it('expands a range', () => {
    expect(parseTokenInput(`${BAYC} 1-5`)).toEqual([
      { chainId: 1, contract: BAYC_LOWER, tokenIds: ['1', '2', '3', '4', '5'] }
    ])
  })

  it('expands a range written with spaces around the dash', () => {
    expect(at(parseTokenInput(`${BAYC} 1 - 3`), 0).tokenIds).toEqual(['1', '2', '3'])
  })

  it('expands a backwards range', () => {
    expect(at(parseTokenInput(`${BAYC} 5-1`), 0).tokenIds).toEqual(['1', '2', '3', '4', '5'])
  })

  it('handles a mixed list of single ids and ranges', () => {
    expect(at(parseTokenInput(`${BAYC} 1,2,7-9`), 0).tokenIds).toEqual(['1', '2', '7', '8', '9'])
  })

  it('accepts 0xCONTRACT:123 and 0xCONTRACT/123', () => {
    expect(at(parseTokenInput(`${BAYC}:123`), 0).tokenIds).toEqual(['123'])
    expect(at(parseTokenInput(`${BAYC}/123`), 0).tokenIds).toEqual(['123'])
  })

  it('de-duplicates ids, normalising leading zeros', () => {
    expect(at(parseTokenInput(`${BAYC} 1 1 01 007 7`), 0).tokenIds).toEqual(['1', '7'])
  })

  it('de-duplicates across ranges that overlap', () => {
    expect(at(parseTokenInput(`${BAYC} 1-3 2-4`), 0).tokenIds).toEqual(['1', '2', '3', '4'])
  })

  it('keeps several contracts separate, in the order they were first seen', () => {
    const specs = parseTokenInput(`${BAYC} 1\n${FEISTY} 2 3\n${BAYC} 4`)
    expect(specs).toHaveLength(2)
    expect(at(specs, 0)).toEqual({ chainId: 1, contract: BAYC_LOWER, tokenIds: ['1', '4'] })
    expect(at(specs, 1)).toEqual({
      chainId: 1,
      contract: FEISTY.toLowerCase(),
      tokenIds: ['2', '3']
    })
  })

  it('mixes an OpenSea link and a loose address on one paste', () => {
    const specs = parseTokenInput(
      `https://opensea.io/assets/ethereum/${BAYC}/1\n${FEISTY} 10-12\n# a comment\n// also ignored`
    )
    expect(specs).toHaveLength(2)
    expect(at(specs, 0).tokenIds).toEqual(['1'])
    expect(at(specs, 1).tokenIds).toEqual(['10', '11', '12'])
  })

  it('treats #123 as a token number but "# note" as a comment', () => {
    expect(at(parseTokenInput(`${BAYC}\n#123`), 0).tokenIds).toEqual(['123'])
    expect(at(parseTokenInput(`${BAYC}\n# 123 is my favourite`), 0).tokenIds).toEqual([])
  })

  it('survives punctuation people paste around links', () => {
    expect(parseTokenInput(`<https://opensea.io/assets/ethereum/${BAYC}/1>.`)).toEqual([
      { chainId: 1, contract: BAYC_LOWER, tokenIds: ['1'] }
    ])
  })

  it('handles CRLF line endings', () => {
    expect(at(parseTokenInput(`${BAYC} 1\r\n${BAYC} 2\r\n`), 0).tokenIds).toEqual(['1', '2'])
  })
})

describe('parseTokenInput - errors a member has to be able to act on', () => {
  it('rejects a truncated address and says how many characters are missing', () => {
    expect(() => parseTokenInput('0x1234')).toThrow(/not a valid contract address/i)
    expect(() => parseTokenInput('0x1234')).toThrow(/exactly 40 letters and numbers/i)
    expect(() => parseTokenInput('0x1234')).toThrow(/this one has 4/)
  })

  it('rejects an ENS name and says where to find the real address', () => {
    expect(() => parseTokenInput('feistydao.eth')).toThrow(/is an ENS name, not a contract address/i)
    expect(() => parseTokenInput('feistydao.eth')).toThrow(/Etherscan or OpenSea/)
  })

  it('rejects token numbers pasted before any contract address', () => {
    expect(() => parseTokenInput('1 2 3')).toThrow(/before any contract address/i)
  })

  it('rejects an empty paste', () => {
    expect(() => parseTokenInput('')).toThrow(/nothing to archive yet/i)
    expect(() => parseTokenInput('   \n  ')).toThrow(/nothing to archive yet/i)
  })

  it('rejects something it cannot classify at all', () => {
    expect(() => parseTokenInput('please archive the monkeys')).toThrow(/could not make sense of/i)
  })

  it('caps a single range at 10,000 and suggests the first chunk to use instead', () => {
    let message = ''
    try {
      parseTokenInput(`${BAYC} 1-10001`)
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toMatch(/covers 10,001 token numbers/)
    expect(message).toMatch(/only handle 10,000 at a time/)
    expect(message).toMatch(/"1-10000"/)
    expect(message).toMatch(/carry on from "10001"/)
  })

  it('allows a range of exactly 10,000', () => {
    expect(at(parseTokenInput(`${BAYC} 1-10000`), 0).tokenIds).toHaveLength(10_000)
  })

  it('quotes the offending line in every error', () => {
    let message = ''
    try {
      parseTokenInput(`${BAYC} 1\nsomething silly here`)
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toMatch(/Offending line: "something silly here"/)
  })

  it('rejects a token id above 2^256 - 1', () => {
    expect(() => parseTokenInput(`${BAYC} ${(2n ** 256n).toString()}`)).toThrow(
      /too large to be a real token ID/i
    )
  })
})

describe('sanitizeFolderName', () => {
  it('replaces path separators and other illegal characters with dashes', () => {
    expect(sanitizeFolderName('a/b')).toBe('a-b')
    expect(sanitizeFolderName('a\\b')).toBe('a-b')
    expect(sanitizeFolderName('C:*?"<>|')).toBe('C-------')
  })

  it('turns control characters into spaces and collapses runs of whitespace', () => {
    expect(sanitizeFolderName('Ape\u0001#1')).toBe('Ape #1')
    expect(sanitizeFolderName('Ape\t\n  #1')).toBe('Ape #1')
    expect(sanitizeFolderName('Ape\u007F#1')).toBe('Ape #1')
    expect(sanitizeFolderName('Ape\u0000\u001F#1')).toBe('Ape #1')
  })

  it('drops zero-width and line-separator characters entirely', () => {
    expect(sanitizeFolderName('Ape\u200B#1')).toBe('Ape#1')
    expect(sanitizeFolderName('\uFEFFApe')).toBe('Ape')
    expect(sanitizeFolderName('Ape\u2028\u2029#1')).toBe('Ape#1')
  })

  it('never returns "." or ".."', () => {
    expect(sanitizeFolderName('..')).toBe('untitled')
    expect(sanitizeFolderName('.')).toBe('untitled')
    expect(sanitizeFolderName('...')).toBe('untitled')
    // Slashes become dashes, then the leading dots are trimmed, so nothing a
    // filesystem could read as a parent-directory reference survives.
    expect(sanitizeFolderName('../../etc/passwd')).toBe('-..-etc-passwd')
  })

  it('side-steps the Windows reserved device names', () => {
    expect(sanitizeFolderName('CON')).toBe('_CON')
    expect(sanitizeFolderName('con')).toBe('_con')
    expect(sanitizeFolderName('con.txt')).toBe('_con.txt')
    expect(sanitizeFolderName('NUL')).toBe('_NUL')
    expect(sanitizeFolderName('COM9')).toBe('_COM9')
    // Not reserved - must be left alone.
    expect(sanitizeFolderName('CONSTANTINOPLE')).toBe('CONSTANTINOPLE')
    expect(sanitizeFolderName('COM10')).toBe('COM10')
  })

  it('keeps emoji and other non-Latin names', () => {
    expect(sanitizeFolderName('Bored Ape \u{1F412} #1')).toBe('Bored Ape \u{1F412} #1')
    expect(sanitizeFolderName('トークン #1')).toBe('トークン #1')
  })

  it('caps a 200-character name at 120 characters', () => {
    const result = sanitizeFolderName('x'.repeat(200))
    expect(result).toHaveLength(120)
    expect(result).toBe('x'.repeat(120))
  })

  it('caps multi-byte names at 200 UTF-8 bytes as well as 120 characters', () => {
    // 100 Hangul syllables = 300 UTF-8 bytes.
    const result = sanitizeFolderName('한'.repeat(100))
    expect(Buffer.byteLength(result, 'utf8')).toBeLessThanOrEqual(200)
    expect(result.length).toBeLessThanOrEqual(120)
    expect(result.length).toBeGreaterThan(0)
    // Never split a character in half.
    expect(result).toBe('한'.repeat(result.length))
  })

  it('never splits an emoji surrogate pair when capping by bytes', () => {
    const result = sanitizeFolderName('\u{1F412}'.repeat(100))
    expect(Buffer.byteLength(result, 'utf8')).toBeLessThanOrEqual(200)
    expect(result.length).toBeGreaterThan(0)
    expect([...result].every((ch) => ch === '\u{1F412}')).toBe(true)
  })

  it('falls back when nothing usable is left', () => {
    expect(sanitizeFolderName('')).toBe('untitled')
    expect(sanitizeFolderName('   ')).toBe('untitled')
    expect(sanitizeFolderName('\u200B')).toBe('untitled')
    expect(sanitizeFolderName(undefined as unknown as string)).toBe('untitled')
  })

  it("uses the caller's fallback before the hard-coded one", () => {
    expect(sanitizeFolderName('', 'Bored Ape #1')).toBe('Bored Ape #1')
    // ...and falls through to 'untitled' when even the fallback is unusable.
    expect(sanitizeFolderName('', '..')).toBe('untitled')
  })

  it('is deterministic', () => {
    const nasty = 'A/B C\u200D\u{1F412}  ..  '
    expect(sanitizeFolderName(nasty)).toBe(sanitizeFolderName(nasty))
  })

  it('never returns "", "." or ".." for any input we can think of', () => {
    const nasties = [
      '',
      ' ',
      '.',
      '..',
      '...',
      './.',
      '/',
      '//',
      '\\',
      '\t',
      '\n',
      '\u0000',
      '\u200B',
      '\uFEFF',
      '\u2028\u2029',
      '.hidden',
      'trailing.',
      'trailing ',
      ' leading',
      'CON',
      'PRN.',
      'aux.tar.gz',
      'x'.repeat(1000),
      '\u{1F412}'.repeat(100),
      '?',
      '*',
      '|',
      '<>',
      '"',
      ':',
      '::::'
    ]
    for (const nasty of nasties) {
      const label = `input ${JSON.stringify(nasty)}`
      const result = sanitizeFolderName(nasty)
      expect(result, label).not.toBe('')
      expect(result, label).not.toBe('.')
      expect(result, label).not.toBe('..')
      expect(result.includes('/'), label).toBe(false)
      expect(result.includes('\\'), label).toBe(false)
      expect(result.includes('\u0000'), label).toBe(false)
      // Windows silently strips leading/trailing dots and spaces, so we must not emit any.
      expect(result.trim(), label).toBe(result)
      expect(result.startsWith('.'), label).toBe(false)
      expect(result.endsWith('.'), label).toBe(false)
      expect(Buffer.byteLength(result, 'utf8'), label).toBeLessThanOrEqual(200)
    }
  })
})

describe('extractAssetUrls', () => {
  it('finds the standard image / animation fields', () => {
    expect(
      extractAssetUrls({
        name: 'Ape #1',
        image: 'ipfs://QmImage/1.png',
        animation_url: 'ipfs://QmAnim/1.html'
      })
    ).toEqual([
      { role: 'image', url: 'ipfs://QmImage/1.png' },
      { role: 'animation', url: 'ipfs://QmAnim/1.html' }
    ])
  })

  it('finds image_url when the collection used that spelling instead', () => {
    expect(extractAssetUrls({ image_url: 'https://example.com/1.png' })).toEqual([
      { role: 'image', url: 'https://example.com/1.png' }
    ])
  })

  it('wraps inline image_data SVG as a data: URL so it can be archived like any file', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>'
    const found = extractAssetUrls({ image_data: svg })
    expect(found).toHaveLength(1)
    const entry = at(found, 0)
    expect(entry.role).toBe('image')
    expect(entry.url.startsWith('data:image/svg+xml;base64,')).toBe(true)
    const decoded = Buffer.from(
      entry.url.slice('data:image/svg+xml;base64,'.length),
      'base64'
    ).toString('utf8')
    expect(decoded).toBe(svg)
  })

  it('leaves an image_data value that is already a data: URL alone', () => {
    const url = 'data:image/svg+xml;base64,PHN2Zy8+'
    expect(extractAssetUrls({ image_data: url })).toEqual([{ role: 'image', url }])
  })

  it('finds properties.files[] entries, as strings and as objects', () => {
    const found = extractAssetUrls({
      image: 'ipfs://QmImage',
      properties: {
        files: ['ipfs://QmFileA', { uri: 'ipfs://QmFileB', type: 'image/png' }]
      }
    })
    expect(found).toEqual([
      { role: 'image', url: 'ipfs://QmImage' },
      { role: 'file', url: 'ipfs://QmFileA' },
      { role: 'file_2', url: 'ipfs://QmFileB' }
    ])
  })

  it('finds a top-level files[] array too', () => {
    expect(extractAssetUrls({ files: [{ url: 'ipfs://QmTop' }] })).toEqual([
      { role: 'file', url: 'ipfs://QmTop' }
    ])
  })

  it('prefers the original reference over a gateway mirror of the same asset', () => {
    // { raw, gateway } describes ONE asset. Taking both would archive it twice, and the
    // gateway copy is the one that loses the CID.
    expect(
      extractAssetUrls({
        image: { raw: 'ipfs://QmOriginal', gateway: 'https://ipfs.io/ipfs/QmOriginal' }
      })
    ).toEqual([{ role: 'image', url: 'ipfs://QmOriginal' }])
  })

  it('gives every asset a unique role, suffixing repeats', () => {
    const found = extractAssetUrls({
      image: 'ipfs://A',
      image_url: 'https://B',
      image_data: '<svg/>',
      animation_url: 'ipfs://C'
    })
    expect(found.map((f) => f.role)).toEqual(['image', 'image_2', 'image_3', 'animation'])
    expect(new Set(found.map((f) => f.role)).size).toBe(found.length)
  })

  it('de-duplicates by URL', () => {
    expect(extractAssetUrls({ image: 'ipfs://Same', image_url: 'ipfs://Same' })).toEqual([
      { role: 'image', url: 'ipfs://Same' }
    ])
  })

  it('finds Tezos-style and audio fields', () => {
    expect(
      extractAssetUrls({
        artifactUri: 'ipfs://QmArt',
        displayUri: 'ipfs://QmDisplay',
        thumbnailUri: 'ipfs://QmThumb',
        losslessAudio: 'ipfs://QmAudio'
      })
    ).toEqual([
      { role: 'artifact', url: 'ipfs://QmArt' },
      { role: 'display', url: 'ipfs://QmDisplay' },
      { role: 'thumbnail', url: 'ipfs://QmThumb' },
      { role: 'audio', url: 'ipfs://QmAudio' }
    ])
  })

  it('ignores empty, null and non-object input', () => {
    expect(extractAssetUrls({})).toEqual([])
    expect(extractAssetUrls({ image: '', animation_url: null })).toEqual([])
    expect(extractAssetUrls({ image: '   ' })).toEqual([])
    expect(extractAssetUrls(null as unknown as Record<string, unknown>)).toEqual([])
    expect(extractAssetUrls([] as unknown as Record<string, unknown>)).toEqual([])
  })

  it('trims whitespace around a URL', () => {
    expect(extractAssetUrls({ image: '  ipfs://QmTrim  ' })).toEqual([
      { role: 'image', url: 'ipfs://QmTrim' }
    ])
  })
})
