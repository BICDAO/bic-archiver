/**
 * A managed IPFS node.
 *
 * The point of this app is that BIC's archive survives, and the only thing that
 * keeps content alive on IPFS is somebody serving it. Two hosted services have
 * already failed us: Storacha's infrastructure was decommissioned outright
 * (up./console./access.storacha.network are NXDOMAIN), and Pinata's pin-by-CID
 * turns out to be a paid feature whose free tier — 1 GB, 500 files — cannot
 * hold a 1.9 GB, 20,808-file archive regardless.
 *
 * So the durable answer is members, each running a real node. Ten members is
 * ten providers, no subscription, and nothing anyone can switch off. But that
 * only works if a member does not have to open a terminal, which is what this
 * module is for: the app installs, configures, starts and keeps alive a real
 * Kubo node on their behalf.
 *
 * The node must outlive the app's window. A member who closes the app should go
 * on serving the archive, so this installs a real login item rather than
 * spawning a child process that dies with us.
 */

/** What state the member's node is in. */
export type NodeState =
  /** No node we know of, managed or otherwise. */
  | 'not-installed'
  /** Downloading / unpacking / initialising. */
  | 'installing'
  /** We installed it, it is not currently running. */
  | 'installed-stopped'
  | 'starting'
  | 'running'
  /** Something went wrong; `detail` says what, in plain English. */
  | 'error'
  /**
   * A node the member (or Homebrew) installed themselves, which we did not set
   * up and must not reconfigure or uninstall. We use it, we do not own it.
   */
  | 'external'

export interface ManagedNodeStatus {
  state: NodeState
  /** True only when this app installed the node and may manage its lifecycle. */
  managed: boolean
  version?: string
  peerId?: string
  apiUrl: string
  repoPath?: string
  repoSizeBytes?: number
  storageMaxBytes?: number
  /** Whether the node is set to start when the member logs in. */
  autostart: boolean
  /**
   * Dialable addresses. When every entry is a `/p2p-circuit` relay address the
   * node is behind NAT and cannot be dialled directly — it still serves content
   * through relays, but more slowly and less reliably. Worth telling the member.
   */
  multiaddrs?: string[]
  /** Plain English, safe to show anyone. Never a stack trace. */
  detail?: string
}

/** Streamed while installing, which involves an ~80 MB download. */
export interface NodeInstallProgress {
  phase:
    | 'checking'
    | 'downloading'
    | 'verifying'
    | 'extracting'
    | 'initialising'
    | 'configuring'
    | 'starting'
    | 'autostart'
    | 'done'
    | 'error'
  message: string
  progress?: number
  bytesDone?: number
  bytesTotal?: number
}

/**
 * Where Kubo comes from.
 *
 * SECURITY: this downloads an executable. Two rules, both non-negotiable:
 *   1. HTTPS from the official distribution host only. Never a mirror supplied
 *      by anything other than this constant.
 *   2. The archive's SHA-512 must be checked against the published SHA512SUMS
 *      before a single byte is unpacked or executed. A download that does not
 *      match is deleted, not run.
 * Skipping (2) would turn this app into a way to run arbitrary code on every
 * member's machine, which is a considerably worse outcome than losing an NFT.
 */
export const KUBO_DIST = {
  baseUrl: 'https://dist.ipfs.tech/kubo',
  /** Pinned so every member gets a known build; bump deliberately. */
  version: 'v0.43.0',
  /**
   * Each artifact has its own sibling checksum file — there is NO combined
   * SHA512SUMS, and asking for one returns an IPFS resolution error rather than
   * a 404, which is an easy way to end up "verifying" against an error page.
   * Verified 2026-08-04, e.g.
   *   kubo_v0.43.0_darwin-arm64.tar.gz.sha512
   * whose contents are:
   *   <128 hex chars><two spaces><filename>
   */
  checksumSuffix: '.sha512'
} as const

/** Maps Node's platform/arch onto Kubo's distribution naming. */
export const KUBO_PLATFORMS: Record<string, { slug: string; ext: 'tar.gz' | 'zip'; bin: string }> = {
  'darwin-arm64': { slug: 'darwin-arm64', ext: 'tar.gz', bin: 'ipfs' },
  'darwin-x64': { slug: 'darwin-amd64', ext: 'tar.gz', bin: 'ipfs' },
  'win32-x64': { slug: 'windows-amd64', ext: 'zip', bin: 'ipfs.exe' },
  'win32-arm64': { slug: 'windows-arm64', ext: 'zip', bin: 'ipfs.exe' },
  'linux-x64': { slug: 'linux-amd64', ext: 'tar.gz', bin: 'ipfs' },
  'linux-arm64': { slug: 'linux-arm64', ext: 'tar.gz', bin: 'ipfs' }
}

/** Identifier for the login item, on every platform. */
export const AUTOSTART_LABEL = 'art.bureauofinternetculture.archiver.ipfs'

/**
 * How much disk the managed node may use, in bytes. The May-2026 archive is
 * 1.9 GB, so 20 GB leaves room for it to grow considerably before a member has
 * to think about it.
 */
export const DEFAULT_STORAGE_MAX = 20 * 1024 * 1024 * 1024

/* -------------------------------------------------------------------------- */
/* Drift                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Whether the member's copy still matches what BIC publishes.
 *
 * BIC's archive is published via DNSLink at
 * `_dnslink.bureauofinternetculture.art`, so the canonical root CID changes
 * whenever the archive is updated. A member who mirrored last month is quietly
 * serving a stale copy, and — exactly like the original problem — nothing tells
 * them. This is the check that does.
 */
export interface DriftStatus {
  /** Root CID currently published via DNSLink, when it could be resolved. */
  publishedCid?: string
  /** Root CID this member actually holds and serves. */
  localCid?: string
  /**
   * in-sync    — local matches published; nothing to do
   * behind     — published has moved on; the member should re-mirror
   * unknown    — DNSLink could not be resolved (offline, DNS down, record gone)
   * not-mirrored — this member has never mirrored the archive
   */
  verdict: 'in-sync' | 'behind' | 'unknown' | 'not-mirrored'
  /** When the member last mirrored, ISO-8601. */
  lastMirroredAt?: string
  /** Plain English, safe to show anyone. */
  detail: string
  checkedAt: string
}
