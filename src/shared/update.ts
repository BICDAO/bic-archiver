/**
 * Asking whether a newer BIC Archiver has been published.
 *
 * What this deliberately is *not*: an auto-updater. This app is not code-signed
 * or notarised, so it cannot silently replace itself on a member's machine in
 * any way that machine would trust — and an app that downloads and runs a new
 * binary on its own is exactly the shape of thing this project spends
 * `node/install.ts` being careful about. So the check reports, and the member
 * decides. Nothing is downloaded here and nothing is ever executed.
 *
 * SECURITY — the addresses below are constants, and that is the whole design.
 * The window cannot name a URL to check, and the release page a member is sent
 * to is *this* constant rather than any field of the API's answer. GitHub's JSON
 * is treated as untrusted text throughout: a version string is read out of it
 * and matched against a strict pattern, and nothing else it says is believed.
 */

/** Fixed addresses. Never overridable, never assembled from a reply. */
export const UPDATE_SOURCE = {
  /**
   * Public and unauthenticated — the repository is public, so no token is sent
   * and none is needed. Returns the newest release that is neither a draft nor a
   * pre-release, which is exactly the set members should be offered.
   */
  latest: 'https://api.github.com/repos/BICDAO/bic-archiver/releases/latest',
  /** Where a member goes to fetch it. Not taken from the API response. */
  releases: 'https://github.com/BICDAO/bic-archiver/releases/latest'
} as const

/** How long to wait before deciding GitHub is not going to answer. */
export const UPDATE_TIMEOUT_MS = 10_000

/** The outcome of one check, written so it can be put on screen unchanged. */
export interface UpdateCheck {
  /** The running version, read from the app itself. */
  current: string
  /** The newest published version, or `null` when the check could not run. */
  latest: string | null
  /**
   * True only when `latest` parsed cleanly and is genuinely higher than
   * `current`. A check that failed, or an answer that could not be read, is
   * never reported as an update — "you are up to date" and "I could not ask"
   * are different sentences and members get the right one.
   */
  newer: boolean
  /** Plain English, safe to show anyone. */
  summary: string
  /** Where to get it. Always {@link UPDATE_SOURCE.releases}. */
  url: string
}

/**
 * `v1.2.3` / `1.2.3` / `1.2.3-beta.1` → the three numbers, or `null`.
 *
 * A tag that stops early counts its missing parts as 0: `v0.4` is 0.4.0 and
 * `v1` is 1.0.0. Releases have been tagged that way (0.3.0 went out as `v0.3`),
 * and refusing the short form left the check unable to see them. Nothing else
 * is loosened: digits only, one to three parts, at most six digits each.
 */
export function parseVersion(value: unknown): [number, number, number] | null {
  if (typeof value !== 'string') return null
  const match = /^\s*v?(\d{1,6})(?:\.(\d{1,6})(?:\.(\d{1,6}))?)?(?:[-+].*)?\s*$/.exec(value)
  if (match === null) return null

  const parts = [match[1], match[2] ?? '0', match[3] ?? '0'].map((part) =>
    Number.parseInt(part ?? '', 10)
  )
  if (parts.some((part) => !Number.isInteger(part))) return null
  return [parts[0] as number, parts[1] as number, parts[2] as number]
}

/**
 * Is `candidate` a higher version than `current`?
 *
 * False whenever either side cannot be read. An unparseable version is not
 * evidence of anything, and guessing "probably newer" would nag a member into
 * reinstalling the version they already have.
 *
 * A pre-release suffix is ignored rather than ranked: `1.2.3-rc.1` and `1.2.3`
 * compare equal here, so a member running the final build is never told that a
 * release candidate of the same version is an upgrade.
 */
export function isNewer(candidate: unknown, current: unknown): boolean {
  const next = parseVersion(candidate)
  const now = parseVersion(current)
  if (next === null || now === null) return false

  for (let i = 0; i < 3; i += 1) {
    const a = next[i] as number
    const b = now[i] as number
    if (a !== b) return a > b
  }
  return false
}
