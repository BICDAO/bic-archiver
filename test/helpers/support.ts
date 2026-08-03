/**
 * Small shared helpers for the test suite. No assertions live here — only the plumbing
 * that would otherwise be copy-pasted into every file.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { MemoryBlockstore } from 'blockstore-core'
import type { CID } from 'multiformats/cid'
import type { Blockstore } from 'interface-blockstore'

/* -------------------------------------------------------------------------- */
/* Scratch directories                                                        */
/* -------------------------------------------------------------------------- */

/**
 * A set of temporary directories that can be torn down in one call from `afterEach`.
 * Everything lands under `node:os.tmpdir()`, never inside the project.
 */
export class TempDirs {
  private readonly created: string[] = []

  /** Make a fresh temp directory and remember it for cleanup. */
  async make(prefix = 'bic-archiver-test-'): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), prefix))
    this.created.push(dir)
    return dir
  }

  /** A path *inside* a fresh temp directory, for a file that does not exist yet. */
  async file(name: string): Promise<string> {
    return join(await this.make(), name)
  }

  /** Remove every directory handed out so far. Safe to call twice. */
  async cleanup(): Promise<void> {
    const dirs = this.created.splice(0, this.created.length)
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
  }
}

/* -------------------------------------------------------------------------- */
/* Blockstore helpers                                                         */
/* -------------------------------------------------------------------------- */

/** A fresh in-memory blockstore. */
export function memoryStore(): Blockstore {
  return new MemoryBlockstore()
}

/** Read a whole block back as one `Uint8Array`, whatever shape `get()` returns. */
export async function readBlock(store: Blockstore, cid: CID): Promise<Uint8Array> {
  const source: unknown = await Promise.resolve(store.get(cid) as unknown)
  if (source instanceof Uint8Array) return source

  const chunks: Uint8Array[] = []
  let total = 0
  for await (const chunk of source as AsyncIterable<Uint8Array>) {
    chunks.push(chunk)
    total += chunk.byteLength
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

/* -------------------------------------------------------------------------- */
/* Bytes                                                                      */
/* -------------------------------------------------------------------------- */

const encoder = new TextEncoder()

export function utf8(text: string): Uint8Array {
  return encoder.encode(text)
}

/**
 * Deterministic pseudo-random bytes — a simple xorshift so the same `seed` always yields
 * the same content on every machine. Real random bytes would make a CID assertion
 * meaningless; a run of zeros would compress into an unrealistically boring DAG.
 */
export function pseudoRandomBytes(length: number, seed = 0x2545f491): Uint8Array {
  const out = new Uint8Array(length)
  let state = seed >>> 0
  for (let i = 0; i < length; i++) {
    state ^= state << 13
    state >>>= 0
    state ^= state >>> 17
    state ^= state << 5
    state >>>= 0
    out[i] = state & 0xff
  }
  return out
}

/* -------------------------------------------------------------------------- */
/* Indexing under noUncheckedIndexedAccess                                    */
/* -------------------------------------------------------------------------- */

/**
 * `arr[0]` is `T | undefined` under `noUncheckedIndexedAccess`, which turns every
 * assertion into an optional-chaining exercise. `at()` narrows and fails the test with a
 * useful message if the element really is missing.
 */
export function at<T>(items: readonly T[], index: number): T {
  const value = items[index]
  if (value === undefined) {
    throw new Error(`Expected an element at index ${index}, but the list has ${items.length}.`)
  }
  return value
}

/* -------------------------------------------------------------------------- */
/* ABI                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Encode a string the way a Solidity `returns (string)` does: offset word, length word,
 * the UTF-8 bytes, zero padding to the next 32-byte boundary.
 *
 * Used to build fake `eth_call` replies. It is deliberately an independent implementation
 * of the layout `decodeAbiString` reads, so a test round-trip actually proves something.
 */
export function abiEncodeString(value: string): string {
  const bytes = utf8(value)
  const padding = (32 - (bytes.byteLength % 32)) % 32
  const offsetWord = (32n).toString(16).padStart(64, '0')
  const lengthWord = BigInt(bytes.byteLength).toString(16).padStart(64, '0')

  let body = ''
  for (const byte of bytes) body += byte.toString(16).padStart(2, '0')
  body += '00'.repeat(padding)

  return `0x${offsetWord}${lengthWord}${body}`
}

/**
 * A stand-in for a public Ethereum JSON-RPC endpoint.
 *
 * `respond` receives the calldata (`0x` + 4-byte selector + arguments) and returns either a
 * hex result string, or `{ revert }` to make the contract refuse the call the way a missing
 * function does. Every request is recorded in `calls`.
 */
export interface RpcStub {
  fetch: typeof globalThis.fetch
  calls: string[]
}

export function makeRpcStub(
  respond: (data: string) => string | { revert: string }
): RpcStub {
  const calls: string[] = []

  const stub = async (_input: unknown, init?: RequestInit): Promise<Response> => {
    const body = typeof init?.body === 'string' ? init.body : '{}'
    const parsed = JSON.parse(body) as {
      id?: number
      params?: Array<{ data?: string }>
    }
    const data = parsed.params?.[0]?.data ?? ''
    calls.push(data)

    const answer = respond(data)
    const payload =
      typeof answer === 'string'
        ? { jsonrpc: '2.0', id: parsed.id ?? 1, result: answer }
        : {
            jsonrpc: '2.0',
            id: parsed.id ?? 1,
            error: { code: 3, message: `execution reverted: ${answer.revert}` }
          }

    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })
  }

  return { fetch: stub as unknown as typeof globalThis.fetch, calls }
}
