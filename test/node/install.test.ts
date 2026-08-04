/**
 * The managed node's installer — the code that downloads and then RUNS an
 * executable on a member's computer. Everything else in this app can fail and
 * cost somebody an NFT; this can fail and cost them their machine.
 *
 * So these tests are not about whether the happy path works. They are about the
 * two rules that make the happy path safe to have at all:
 *
 *   1. **Nothing is unpacked or executed until its SHA-512 matches**, and
 *   2. **the bytes come from `dist.ipfs.tech` over HTTPS or they do not come.**
 *
 * "Nothing is executed" is proved rather than assumed. The archive served in
 * these tests contains a real `ipfs` that appends to a sentinel file when it
 * runs, and the control case at the bottom shows the sentinel genuinely appears
 * when an install is allowed to complete. Every refusal test then asserts the
 * sentinel is absent — which it could not do if the harness were incapable of
 * producing one.
 *
 * The checksum parser gets the most attention, because it is where rule 1 is
 * quietly lost. There is no combined `SHA512SUMS` for this release, and asking
 * dist.ipfs.tech for one does not return 404 — it returns an IPFS *resolution
 * error page*: prose, with a 200-ish shape. A parser that scavenged the first
 * long token out of a file would happily read a hash out of an error page, and
 * from then on the app would be "verifying" downloads against nothing at all.
 */

import { createHash } from 'node:crypto'
import { statfsSync } from 'node:fs'
import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { KUBO_DIST } from '../../src/shared/node'
import {
  downloadKubo,
  kuboArtifact,
  parseChecksumFile,
  pathExists,
  platformKey
} from '../../src/main/node/install'
import { TempDirs } from '../helpers/support'

import { FetchRouter, bytes, sentinelScript, tarGz, text } from './harness'

const temps = new TempDirs()

afterEach(async () => {
  vi.unstubAllGlobals()
  await temps.cleanup()
})

/** A well-formed but wrong SHA-512, so shape can never be what saves us. */
const WRONG_HASH = 'a1b2c3d4e5f6'.repeat(10) + '0123456789abcdef'.slice(0, 8)

/* -------------------------------------------------------------------------- */
/* which build this computer needs                                             */
/* -------------------------------------------------------------------------- */

describe('kuboArtifact', () => {
  it('builds the pinned URL and its sibling checksum, both on the official host', () => {
    const artifact = kuboArtifact('darwin-arm64')

    expect(artifact.fileName).toBe('kubo_v0.43.0_darwin-arm64.tar.gz')
    expect(artifact.url).toBe('https://dist.ipfs.tech/kubo/v0.43.0/kubo_v0.43.0_darwin-arm64.tar.gz')
    expect(artifact.checksumUrl).toBe(`${artifact.url}${KUBO_DIST.checksumSuffix}`)
    expect(artifact.checksumUrl.endsWith('.sha512')).toBe(true)
    expect(new URL(artifact.url).protocol).toBe('https:')
    expect(new URL(artifact.url).host).toBe('dist.ipfs.tech')
    expect(artifact.binName).toBe('ipfs')
  })

  it('asks for a .zip and ipfs.exe on Windows', () => {
    const artifact = kuboArtifact('win32-x64')
    expect(artifact.fileName).toBe('kubo_v0.43.0_windows-amd64.zip')
    expect(artifact.binName).toBe('ipfs.exe')
  })

  it('every platform it claims to support has a real artifact name', () => {
    for (const key of ['darwin-arm64', 'darwin-x64', 'win32-x64', 'win32-arm64', 'linux-x64', 'linux-arm64']) {
      expect(() => kuboArtifact(key)).not.toThrow()
    }
  })

  it('refuses an unsupported platform with a message naming that platform', () => {
    // A DAO member on FreeBSD deserves "this computer cannot, use another one",
    // not a download that 404s three minutes later.
    expect(() => kuboArtifact('freebsd-x64')).toThrowError(/FreeBSD/)
    expect(() => kuboArtifact('sunos-x64')).toThrowError(/Solaris/)
    expect(() => kuboArtifact('linux-mips')).toThrowError(/Linux \(mips\)/)
    // An architecture nobody has heard of still gets named rather than hidden.
    expect(() => kuboArtifact('plan9-riscv64')).toThrowError(/plan9 \(riscv64\)/)
  })

  it('says what still works on a platform it cannot serve', () => {
    let message = ''
    try {
      kuboArtifact('freebsd-x64')
    } catch (err) {
      message = err instanceof Error ? err.message : String(err)
    }
    expect(message).toMatch(/still make backups/i)
    expect(message).toMatch(/macOS, Windows or Linux/)
    expect(message).not.toMatch(/[Ee]rror:|stack|undefined/)
  })

  it('platformKey is what this computer actually is', () => {
    expect(platformKey()).toBe(`${process.platform}-${process.arch}`)
  })
})

/* -------------------------------------------------------------------------- */
/* the checksum parser — where rule 1 is quietly lost                          */
/* -------------------------------------------------------------------------- */

describe('parseChecksumFile', () => {
  const NAME = 'kubo_v0.43.0_darwin-arm64.tar.gz'
  const HASH = 'b'.repeat(128)

  it('reads the published shape: 128 hex, two spaces, the file name', () => {
    expect(parseChecksumFile(`${HASH}  ${NAME}\n`, NAME)).toBe(HASH)
  })

  it('accepts the BSD binary-mode marker and CRLF line endings', () => {
    expect(parseChecksumFile(`${HASH} *${NAME}\r\n`, NAME)).toBe(HASH)
  })

  it('is case-insensitive about the hex but returns it lowercase', () => {
    expect(parseChecksumFile(`${'B'.repeat(128)}  ${NAME}`, NAME)).toBe(HASH)
  })

  /**
   * The real failure mode. dist.ipfs.tech does not 404 a missing checksum file;
   * it resolves the path through IPFS and hands back the resolver's complaint.
   * Both shapes below were the reason `parseChecksumFile` accepts exactly one
   * thing.
   */
  it('rejects an IPFS resolution error page rather than reading a hash out of it', () => {
    const errorPage = [
      'ipfs resolve -r /ipfs/bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi/kubo/v0.43.0/SHA512SUMS:',
      'no link named "SHA512SUMS" under bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi',
      ''
    ].join('\n')

    expect(() => parseChecksumFile(errorPage, NAME)).toThrowError(/could not be read/i)
    expect(() => parseChecksumFile(errorPage, NAME)).toThrowError(/nothing has been installed/i)
  })

  it('rejects an HTML error page', () => {
    const html = [
      '<!DOCTYPE html>',
      '<html><head><title>404 Not Found</title></head>',
      '<body><h1>ipfs resolve: no link named &quot;SHA512SUMS&quot;</h1>',
      '<p>The requested path could not be resolved.</p></body></html>',
      ''
    ].join('\n')

    expect(() => parseChecksumFile(html, NAME)).toThrowError(/could not be read/i)
  })

  it('rejects anything that is not exactly 128 hex characters', () => {
    for (const [label, hash] of [
      ['sha1', 'c'.repeat(40)],
      ['sha256', 'c'.repeat(64)],
      ['one short', 'c'.repeat(127)],
      ['one long', 'c'.repeat(129)]
    ] as const) {
      expect(() => parseChecksumFile(`${hash}  ${NAME}`, NAME), label).toThrowError(/could not be read/i)
    }
  })

  it('rejects an empty or whitespace-only file', () => {
    expect(() => parseChecksumFile('', NAME)).toThrowError(/could not be read/i)
    expect(() => parseChecksumFile('   \n\n\t\n', NAME)).toThrowError(/could not be read/i)
  })

  it('rejects hex-looking text that is not hex', () => {
    // 128 characters, all plausible-looking, one of them a 'z'.
    const nearly = `${'d'.repeat(127)}z`
    expect(() => parseChecksumFile(`${nearly}  ${NAME}`, NAME)).toThrowError(/could not be read/i)
  })

  /**
   * The length check above is one half of rule 1; this is the other. A checksum
   * line is a line that BEGINS with the hash — a parser that hunted for
   * hash-shaped text anywhere in a line would read a live checksum out of a
   * commented-out one, a log prefix, or any prose that happens to contain 128
   * hex characters. The commented form is the sharp case, because it is
   * byte-for-byte a valid entry with four characters in front of it.
   */
  it('will not take a hash from anywhere but the start of a line', () => {
    expect(() => parseChecksumFile(`# ${'a'.repeat(128)}  ${NAME}`, NAME)).toThrowError(/could not be read/i)
    expect(() => parseChecksumFile(`>>> ${'a'.repeat(128)}  ${NAME}`, NAME)).toThrowError(/could not be read/i)
  })

  /**
   * The sibling file names exactly one artifact, so a single entry whose name
   * does not match is a naming difference at the publisher, not an ambiguity —
   * there is still only one candidate hash, and it still has to match the bytes.
   * A file listing several artifacts is a different matter: picking one at
   * random there would be guessing.
   */
  describe('when the file names a different artifact', () => {
    it('accepts a lone entry, because there is nothing to choose between', () => {
      expect(parseChecksumFile(`${HASH}  kubo_v0.43.0_linux-amd64.tar.gz`, NAME)).toBe(HASH)
    })

    it('refuses to guess between several, and says which file it wanted', () => {
      const many = [
        `${'1'.repeat(128)}  kubo_v0.43.0_linux-amd64.tar.gz`,
        `${'2'.repeat(128)}  kubo_v0.43.0_windows-amd64.zip`
      ].join('\n')

      expect(() => parseChecksumFile(many, NAME)).toThrowError(new RegExp(NAME))
      expect(() => parseChecksumFile(many, NAME)).toThrowError(/could not be verified/i)
    })

    it('picks OUR line out of a combined file, not the first one', () => {
      const combined = [
        `${'1'.repeat(128)}  kubo_v0.43.0_linux-amd64.tar.gz`,
        `${'2'.repeat(128)}  ${NAME}`,
        `${'3'.repeat(128)}  kubo_v0.43.0_windows-amd64.zip`
      ].join('\n')

      expect(parseChecksumFile(combined, NAME)).toBe('2'.repeat(128))
    })

    it('matches on the file name alone, ignoring any directory in front of it', () => {
      expect(parseChecksumFile(`${HASH}  ./dist/${NAME}`, NAME)).toBe(HASH)
    })
  })
})

/* -------------------------------------------------------------------------- */
/* downloadKubo — the part that writes an executable to disk                   */
/* -------------------------------------------------------------------------- */

/**
 * The installer refuses to start without ~600 MB free, which is correct
 * behaviour and nothing to do with what is being checked here — so a machine
 * that low skips these rather than reporting a false failure.
 */
function hasRoomToInstall(): boolean {
  try {
    const info = statfsSync(process.cwd())
    return Number(info.bavail) * Number(info.bsize) > 1024 ** 3
  } catch {
    return true
  }
}

describe('downloadKubo', () => {
  /** Windows unpacks through PowerShell, which this offline harness cannot drive. */
  const canRun = process.platform !== 'win32' && hasRoomToInstall()

  interface Scene {
    destDir: string
    sentinel: string
    archive: Buffer
    hash: string
    artifact: ReturnType<typeof kuboArtifact>
    router: FetchRouter
    progress: string[]
  }

  /**
   * A complete, believable release: a real gzipped tar whose `ipfs` is a real
   * program, served from the real URL the installer will ask for.
   */
  async function scene(): Promise<Scene> {
    const destDir = await temps.make('bic-node-install-')
    const sentinel = join(await temps.make('bic-node-sentinel-'), 'executed.txt')
    const archive = tarGz([
      { name: `kubo/${kuboArtifact().binName}`, data: sentinelScript(sentinel), mode: 0o755 },
      { name: 'kubo/README.md', data: '# not the program\n' }
    ])
    return {
      destDir,
      sentinel,
      archive,
      hash: createHash('sha512').update(archive).digest('hex'),
      artifact: kuboArtifact(),
      router: new FetchRouter(),
      progress: []
    }
  }

  /** Nothing landed, nothing ran, nothing is left half-written. */
  async function assertNothingInstalled(s: Scene): Promise<void> {
    expect(await pathExists(s.sentinel), 'the downloaded program was executed').toBe(false)
    expect(await pathExists(join(s.destDir, s.artifact.binName))).toBe(false)
    expect(await pathExists(join(s.destDir, '.staging'))).toBe(false)
    expect(await readdir(s.destDir)).toEqual([])
  }

  it.runIf(canRun)('refuses a download whose SHA-512 does not match, and deletes it', async () => {
    const s = await scene()
    s.router
      .on((url) => url === s.artifact.checksumUrl, () => text(`${WRONG_HASH}  ${s.artifact.fileName}\n`))
      .on((url) => url === s.artifact.url, () => bytes(s.archive))
      .install()

    await expect(downloadKubo(s.destDir, (p) => s.progress.push(p.phase))).rejects.toThrowError(
      /did not match the fingerprint/i
    )

    await assertNothingInstalled(s)

    // It got as far as checking, and stopped there.
    expect(s.progress).toContain('verifying')
    expect(s.progress).not.toContain('extracting')
  })

  it.runIf(canRun)('says plainly what happened, and does not suggest installing IPFS by hand', async () => {
    const s = await scene()
    s.router
      .on((url) => url === s.artifact.checksumUrl, () => text(`${WRONG_HASH}  ${s.artifact.fileName}\n`))
      .on((url) => url === s.artifact.url, () => bytes(s.archive))
      .install()

    const message = await downloadKubo(s.destDir, () => undefined).then(
      () => 'it did not throw',
      (err: unknown) => (err instanceof Error ? err.message : String(err))
    )

    expect(message).toMatch(/deleted/i)
    expect(message).toMatch(/nothing was installed/i)
    expect(message).toMatch(/do not install IPFS by hand/i)
    expect(message).not.toMatch(/sha|hash|digest/i)
  })

  it.runIf(canRun)('refuses an IPFS error page where the checksum should be, before downloading anything', async () => {
    const s = await scene()
    const errorPage =
      'ipfs resolve -r /ipfs/bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi/kubo/v0.43.0/' +
      `${s.artifact.fileName}.sha512: no link named "${s.artifact.fileName}.sha512"\n`

    s.router
      .on((url) => url === s.artifact.checksumUrl, () => text(errorPage))
      .on((url) => url === s.artifact.url, () => bytes(s.archive))
      .install()

    await expect(downloadKubo(s.destDir, () => undefined)).rejects.toThrowError(/could not be read/i)

    // The 80 MB was never spent: there is no point downloading bytes that could
    // never be trusted.
    expect(s.router.calls.filter((call) => call.url === s.artifact.url)).toHaveLength(0)
    await assertNothingInstalled(s)
  })

  it.runIf(canRun)('refuses a redirect off the official host, even with a matching checksum', async () => {
    const s = await scene()
    s.router
      .on((url) => url === s.artifact.checksumUrl, () => text(`${s.hash}  ${s.artifact.fileName}\n`))
      .on((url) => url === s.artifact.url, () => {
        const response = bytes(s.archive)
        // What a redirect looks like once `fetch` has followed it.
        Object.defineProperty(response, 'url', {
          value: 'https://cdn.evil.example/kubo/v0.43.0/kubo.tar.gz',
          configurable: true
        })
        return response
      })
      .install()

    await expect(downloadKubo(s.destDir, () => undefined)).rejects.toThrowError(
      /redirected away from dist\.ipfs\.tech to cdn\.evil\.example/
    )
    await assertNothingInstalled(s)
  })

  it.runIf(canRun)('refuses a transfer that stops early, even though its bytes are a prefix of the real ones', async () => {
    const s = await scene()
    s.router
      .on((url) => url === s.artifact.checksumUrl, () => text(`${s.hash}  ${s.artifact.fileName}\n`))
      .on((url) => url === s.artifact.url, () =>
        // Truthful content-length, truncated body: the shape a dropped
        // connection has.
        new Response(s.archive.subarray(0, Math.floor(s.archive.length / 2)), {
          status: 200,
          headers: { 'content-length': String(s.archive.length) }
        })
      )
      .install()

    await expect(downloadKubo(s.destDir, () => undefined)).rejects.toThrowError(/stopped early/i)
    await assertNothingInstalled(s)
  })

  /**
   * The control. Without this, every assertion above could be passing because
   * the harness is incapable of installing anything at all.
   */
  it.runIf(canRun)('installs and runs the program when the checksum does match', async () => {
    const s = await scene()
    s.router
      .on((url) => url === s.artifact.checksumUrl, () => text(`${s.hash}  ${s.artifact.fileName}\n`))
      .on((url) => url === s.artifact.url, () => bytes(s.archive))
      .install()

    const installed = await downloadKubo(s.destDir, (p) => s.progress.push(p.phase))

    expect(installed.binPath).toBe(join(s.destDir, s.artifact.binName))
    expect(installed.version).toBe('0.43.0')

    // Executable, and it genuinely executed — which is what makes the absence of
    // this sentinel meaningful in every test above.
    expect((await stat(installed.binPath)).mode & 0o111).toBeGreaterThan(0)
    expect(await readFile(s.sentinel, 'utf8')).toMatch(/executed --version/)

    // Exactly one file was lifted out of the archive; the README stayed in it.
    expect(await readdir(s.destDir)).toEqual([s.artifact.binName])

    expect(s.progress).toEqual(
      expect.arrayContaining(['checking', 'downloading', 'verifying', 'extracting'])
    )
  })

  it.runIf(canRun)('reports real byte counts while downloading', async () => {
    const s = await scene()
    const reports: Array<{ done?: number; total?: number }> = []
    s.router
      .on((url) => url === s.artifact.checksumUrl, () => text(`${s.hash}  ${s.artifact.fileName}\n`))
      .on((url) => url === s.artifact.url, () => bytes(s.archive))
      .install()

    await downloadKubo(s.destDir, (p) => {
      if (p.phase === 'downloading') reports.push({ done: p.bytesDone, total: p.bytesTotal })
    })

    const last = reports.at(-1)
    expect(last?.done).toBe(s.archive.length)
    expect(last?.total).toBe(s.archive.length)
  })
})
