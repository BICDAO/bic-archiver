/**
 * The operating system's resolver, replaced.
 *
 * `drift.ts` asks `node:dns/promises` for TXT records as its second source, after
 * DNS-over-HTTPS and before gateways. Left alone, that is a real lookup of a real
 * domain from the machine running the suite — which would make these tests a
 * report on whoever's DNS server, pass or fail depending on the café wifi, and
 * quietly turn "everything is unreachable" into "everything except this one
 * thing, which answered". Taking `fetch` away (see `test/setup/no-network.ts`)
 * does nothing about it, because DNS is not HTTP.
 *
 * So the resolver is a fixture like everything else. The default is the failure a
 * machine with no working DNS gives, and each test opts in to a zone.
 *
 * Nothing here asserts. It is shared state a `vi.mock` factory can reach, which
 * is the only reason it is a module rather than four lines in each test file.
 */

/** What the resolver will do with the next question. */
interface DnsState {
  answer: (host: string) => Promise<string[][]>
  /** Every host asked about, in order, so "DoH was tried first" is checkable. */
  asked: string[]
}

export const dnsState: DnsState = {
  answer: async () => {
    throw dnsFailure('ENOTFOUND')
  },
  asked: []
}

/** The shape `node:dns` rejects with, errno and all. */
export function dnsFailure(code: string, host = '_dnslink.example'): NodeJS.ErrnoException {
  const err: NodeJS.ErrnoException = new Error(`query${code} ${host}`)
  err.code = code
  err.errno = undefined
  return err
}

/** Called by the `vi.mock` factory in each test file. */
export async function fakeResolveTxt(host: string): Promise<string[][]> {
  dnsState.asked.push(host)
  return dnsState.answer(host)
}

/** Back to a machine whose resolver answers nothing. */
export function resetDns(): void {
  dnsState.asked.length = 0
  dnsState.answer = async () => {
    throw dnsFailure('ENOTFOUND')
  }
}

/**
 * A resolver that serves the given zone. Hosts not in it get NXDOMAIN, which is
 * what a real resolver says and is not the same as an error.
 *
 * Values are given as whole strings; DNS delivers long TXT values in 255-byte
 * chunks, and `drift.ts` rejoins them, so anything containing `|` is split there
 * to exercise that.
 */
export function dnsServing(zone: Readonly<Record<string, readonly string[]>>): void {
  dnsState.answer = async (host) => {
    const records = zone[host]
    if (records === undefined) throw dnsFailure('ENOTFOUND', host)
    return records.map((record) => record.split('|'))
  }
}

/** A resolver that fails every question with one errno. */
export function dnsFailing(code: string): void {
  dnsState.answer = async (host) => {
    throw dnsFailure(code, host)
  }
}

/**
 * A resolver that accepts the question and never answers.
 *
 * `resolveTxt` offers no timeout of its own, so this is the case where a status
 * panel hangs for ever unless the caller imposes its own deadline. `drift.ts`
 * does; this is what proves it.
 *
 * `hosts` limits the silence to the names given — everything else gets NXDOMAIN
 * immediately — because the module asks about two hosts in sequence and a test
 * that hangs both pays the deadline twice for no extra evidence.
 */
export function dnsHanging(hosts?: readonly string[]): void {
  dnsState.answer = (host) => {
    if (hosts !== undefined && !hosts.includes(host)) {
      return Promise.reject(dnsFailure('ENOTFOUND', host))
    }
    return new Promise<string[][]>(() => undefined)
  }
}
