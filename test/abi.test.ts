/**
 * ABI encoding/decoding — the hand-rolled replacement for viem/ethers.
 *
 * `decodeAbiString` is the single point where "what the contract said" becomes "a link we
 * can follow". Everything downstream (IPFS retrieval, on-chain metadata, the whole archive)
 * is built on it being right, so it is tested against a payload captured from a real
 * mainnet `eth_call` rather than one this test invented.
 */

import { describe, expect, it } from 'vitest'

import { decodeAbiString } from '../src/main/chain/rpc'
import { encodeUint256 } from '../src/main/chain/tokenUri'
import { abiEncodeString } from './helpers/support'

/**
 * Captured live from `tokenURI(uint256)` on a mainnet ERC-721.
 *
 * Word 0  — 0x20: the string starts 32 bytes in.
 * Word 1  — 0x37: it is 55 bytes long.
 * Words 2-3 — those 55 UTF-8 bytes, zero-padded to the 32-byte boundary.
 */
const LIVE_TOKEN_URI_PAYLOAD =
  '0x' +
  '0000000000000000000000000000000000000000000000000000000000000020' +
  '0000000000000000000000000000000000000000000000000000000000000037' +
  '697066733a2f2f516d65536a53696e4870506e6d586d73704d6a776958794e36' +
  '7a533445397a63636172694752336a7863615774712f31000000000000000000'

const LIVE_TOKEN_URI = 'ipfs://QmeSjSinHpPnmXmspMjwiXyN6zS4E9zccariGR3jxcaWtq/1'

describe('decodeAbiString', () => {
  it('decodes the exact payload captured from a live mainnet tokenURI call', () => {
    expect(decodeAbiString(LIVE_TOKEN_URI_PAYLOAD)).toBe(LIVE_TOKEN_URI)
  })

  it('round-trips: encoding that same string reproduces the captured payload byte for byte', () => {
    // If this fails, either our understanding of the layout or the captured bytes are
    // wrong — and both would be worth knowing about.
    expect(abiEncodeString(LIVE_TOKEN_URI)).toBe(LIVE_TOKEN_URI_PAYLOAD)
    expect(decodeAbiString(abiEncodeString(LIVE_TOKEN_URI))).toBe(LIVE_TOKEN_URI)
  })

  it('has the padding the encoding rules require', () => {
    const body = LIVE_TOKEN_URI_PAYLOAD.slice(2)
    // 4 words: offset, length, and 55 bytes of text padded up to 64.
    expect(body.length).toBe(64 * 4)
    expect(body.endsWith('00'.repeat(9))).toBe(true)
  })

  it('accepts an uppercase 0X prefix and surrounding whitespace', () => {
    const messy = `  0X${LIVE_TOKEN_URI_PAYLOAD.slice(2).toUpperCase()}  `
    expect(decodeAbiString(messy)).toBe(LIVE_TOKEN_URI)
  })

  it('round-trips a long string that spans several words', () => {
    const long = `ipfs://${'Qm'.padEnd(100, 'z')}/deep/path/1.json`
    expect(decodeAbiString(abiEncodeString(long))).toBe(long)
  })

  it('round-trips multi-byte UTF-8', () => {
    const unicode = 'data:text/plain,Bored Ape \u{1F412} — n°1'
    expect(decodeAbiString(abiEncodeString(unicode))).toBe(unicode)
  })

  describe('empty returns', () => {
    it('treats "0x" — a contract with nothing to say — as an empty string', () => {
      expect(decodeAbiString('0x')).toBe('')
    })

    it('treats "" as an empty string', () => {
      expect(decodeAbiString('')).toBe('')
    })

    it('decodes a properly encoded empty string to ""', () => {
      expect(decodeAbiString(abiEncodeString(''))).toBe('')
      // offset word = 32, length word = 0, no payload.
      expect(abiEncodeString('')).toBe(`0x${'0'.repeat(62)}20${'0'.repeat(64)}`)
    })

    it('strips the NUL padding some contracts leave inside the declared length', () => {
      const body =
        '0'.repeat(62) +
        '20' + // offset 32
        '0'.repeat(62) +
        '08' + // length 8
        '6970667300000000' + // "ipfs" + 4 NULs
        '0'.repeat(48)
      expect(decodeAbiString(`0x${body}`)).toBe('ipfs')
    })
  })

  describe('malformed input', () => {
    it('rejects non-hex characters in plain English', () => {
      expect(() => decodeAbiString('0xZZZZ')).toThrow(/not valid data/i)
    })

    it('rejects an odd number of hex digits', () => {
      expect(() => decodeAbiString('0x123')).toThrow(/not valid data/i)
    })

    it('rejects a reply too short to hold an offset and a length', () => {
      expect(() => decodeAbiString(`0x${'0'.repeat(64)}`)).toThrow(/too short/i)
    })

    it('rejects an offset that points past the end of the reply', () => {
      const body = '0'.repeat(62) + 'e0' + '0'.repeat(64)
      expect(() => decodeAbiString(`0x${body}`)).toThrow(/doesn't understand|does not understand/i)
    })

    it('rejects an absurd offset without trying to allocate it', () => {
      const body = 'f'.repeat(64) + '0'.repeat(64)
      expect(() => decodeAbiString(`0x${body}`)).toThrow(/doesn't understand|does not understand/i)
    })

    it('rejects a declared length longer than the bytes actually sent', () => {
      const body =
        '0'.repeat(62) +
        '20' + // offset 32
        '0'.repeat(62) +
        'ff' + // claims 255 bytes...
        '00'.repeat(32) // ...but only 32 follow
      expect(() => decodeAbiString(`0x${body}`)).toThrow(/cut short/i)
    })

    it('rejects a non-string argument', () => {
      expect(() => decodeAbiString(undefined as unknown as string)).toThrow(
        /returned nothing we could read/i
      )
      expect(() => decodeAbiString(null as unknown as string)).toThrow(
        /returned nothing we could read/i
      )
    })

    it('never leaks hex or jargon into a message a member will read', () => {
      const messages: string[] = []
      for (const bad of ['0xZZ', '0x123', `0x${'0'.repeat(64)}`]) {
        try {
          decodeAbiString(bad)
        } catch (error) {
          messages.push((error as Error).message)
        }
      }
      expect(messages).toHaveLength(3)
      for (const message of messages) {
        expect(message).toMatch(/^[A-Z]/)
        expect(message).not.toMatch(/0x|ABI|offset|word|utf-?8/i)
      }
    })
  })
})

describe('encodeUint256', () => {
  it('encodes token id "0" as a full word of zeros', () => {
    expect(encodeUint256('0')).toBe('0'.repeat(64))
  })

  it('encodes token id "1"', () => {
    expect(encodeUint256('1')).toBe(`${'0'.repeat(63)}1`)
  })

  it('encodes a token id far beyond Number.MAX_SAFE_INTEGER exactly', () => {
    // 2^53 + 1 — the smallest integer a float64 cannot represent, i.e. the first value
    // that would be silently corrupted by parsing the id as a Number.
    const beyondFloat = '9007199254740993'
    expect(BigInt(beyondFloat) > BigInt(Number.MAX_SAFE_INTEGER)).toBe(true)
    expect(encodeUint256(beyondFloat)).toBe(`${'0'.repeat(50)}20000000000001`)
    // And it survives the round trip, which Number() would not.
    expect(BigInt(`0x${encodeUint256(beyondFloat)}`).toString()).toBe(beyondFloat)
  })

  it('encodes a 78-digit id (2^256 - 1) as 64 f characters', () => {
    const max = (2n ** 256n - 1n).toString()
    expect(max).toHaveLength(78)
    expect(encodeUint256(max)).toBe('f'.repeat(64))
  })

  it('always returns 64 lowercase hex characters with no 0x prefix', () => {
    for (const id of ['0', '1', '4271', '9007199254740993', (2n ** 200n).toString()]) {
      const word = encodeUint256(id)
      expect(word).toHaveLength(64)
      expect(word).toMatch(/^[0-9a-f]{64}$/)
      expect(word.startsWith('0x')).toBe(false)
    }
  })

  it('concatenates directly onto a selector to form valid calldata', () => {
    const data = `0xc87b56dd${encodeUint256('1')}`
    expect(data).toHaveLength(2 + 8 + 64)
    expect(data).toMatch(/^0x[0-9a-f]+$/)
  })

  it('accepts a 0x-prefixed id as a convenience, and normalises it', () => {
    expect(encodeUint256('0xdeadbeef')).toBe(encodeUint256('3735928559'))
  })

  it('ignores surrounding whitespace and leading zeros', () => {
    expect(encodeUint256('  0007  ')).toBe(encodeUint256('7'))
  })

  it('refuses a value above 2^256 - 1 in plain English', () => {
    expect(() => encodeUint256((2n ** 256n).toString())).toThrow(/too large to be a real NFT number/i)
  })

  it('refuses an empty or non-numeric id in plain English', () => {
    expect(() => encodeUint256('')).toThrow(/No token number was given/i)
    expect(() => encodeUint256('   ')).toThrow(/No token number was given/i)
    expect(() => encodeUint256('abc')).toThrow(/not a valid token number/i)
    expect(() => encodeUint256('1.5')).toThrow(/not a valid token number/i)
    expect(() => encodeUint256('-1')).toThrow(/not a valid token number/i)
  })
})
