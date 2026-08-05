/**
 * Shared contracts for pinning.
 *
 * Background that shapes every type here: a backup file keeps the *bytes*, but
 * it does not make a CID *resolvable*. The May-2026 archive proved the point —
 * 95% of its content was still served by other people, while 428 CIDs (almost
 * all of them assets BIC had rescued from Arweave or web2, where BIC was the
 * only pinner) existed nowhere but the .car.
 *
 * That drives one non-obvious design decision. Pinata's pin-by-CID asks Pinata
 * to *find* content on the network, so it cannot rescue dead CIDs — there is
 * nothing to find. The working route is:
 *
 *   1. import the .car into a local Kubo node, which preserves the original
 *      CIDs exactly and makes that node a provider for them;
 *   2. ask Pinata to pin by CID, passing the local node's multiaddrs as
 *      `hostNodes` so Pinata knows where to fetch from;
 *   3. verify the pin actually landed rather than trusting the response.
 *
 * Kubo is therefore not merely the self-hosted option; it is the mechanism that
 * makes reviving dead content possible at all.
 */

/** Where content can be pinned. */
export type PinTargetId = 'kubo' | 'pinata'

/**
 * State of one CID at one target.
 * `unknown` means we have not asked yet — never render it as "not pinned",
 * because the difference matters when deciding what still needs rescuing.
 */
export type PinState = 'pinned' | 'pinning' | 'not-pinned' | 'failed' | 'unknown'

/** Whether a target is usable right now, and if not, why not in plain English. */
export interface PinTargetStatus {
  target: PinTargetId
  /** Configured, reachable and authorised. */
  available: boolean
  /** Shown to the member when `available` is false. Never contains a token. */
  detail?: string
  /** Kubo only: the node's dialable multiaddrs, used as Pinata `hostNodes`. */
  multiaddrs?: string[]
  /** Kubo only: the node's peer ID. */
  peerId?: string
}

/** One row in the Assets view: a single piece of content in the archive. */
export interface AssetRow {
  cid: string
  /** Full path inside the archive. */
  path: string
  /** Top-level NFT folder the asset belongs to, for grouping. */
  nft: string
  /** 'metadata' | 'image' | 'animation' | 'folder' | … derived from the path. */
  role: string
  size: number
  isDirectory: boolean
  /** Availability on the public network; 'unchecked' until a health run. */
  network: 'healthy' | 'at-risk' | 'unreachable' | 'unchecked'
  /** Pin state per target. Absent key means `unknown`. */
  pins: Partial<Record<PinTargetId, PinState>>
}

/** Outcome of pinning one CID at one target. */
export interface PinResult {
  cid: string
  target: PinTargetId
  state: PinState
  /** Plain English, safe to show a member. Never contains a token. */
  error?: string
  /** Pinata request id, for following up on a queued pin. */
  requestId?: string
}

/** Streamed to the GUI while a pin run is in flight. */
export interface PinProgress {
  cid: string
  target: PinTargetId
  phase: 'importing' | 'requesting' | 'waiting' | 'verifying' | 'done' | 'error'
  /** Plain English, e.g. "Asking Pinata to fetch this from your node…". */
  message: string
  /** 0..1 when known. */
  progress?: number
}

/** Summary of a completed pin run. */
export interface PinRunSummary {
  requested: number
  pinned: number
  queued: number
  failed: number
  skipped: number
  /** Per-CID detail for the failures, so the member can act. */
  failures: PinResult[]
}

/**
 * Persisted pinning configuration.
 *
 * The Pinata token is NEVER part of this object. It is held separately via
 * Electron `safeStorage` (OS keychain-backed) and only `hasToken` crosses the
 * IPC boundary, so a token cannot leak into renderer state, logs or a crash
 * report.
 */
export interface PinningSettings {
  kubo: {
    enabled: boolean
    /** Default 'http://127.0.0.1:5001'. */
    apiUrl: string
  }
  pinata: {
    enabled: boolean
    /** True when a token is stored. The token itself never crosses IPC. */
    hasToken: boolean
    /** Optional dedicated gateway, e.g. 'https://mygateway.mypinata.cloud'. */
    gateway?: string
  }
  /**
   * Pin newly archived content automatically. Defaults to TRUE: unpinned
   * content is how this archive lost 428 CIDs in the first place, so pinning
   * is the default behaviour rather than an extra step someone must remember.
   */
  pinOnImport: boolean
}

/** The default settings a fresh install starts with. */
export const DEFAULT_PINNING_SETTINGS: PinningSettings = {
  kubo: { enabled: true, apiUrl: 'http://127.0.0.1:5001' },
  pinata: { enabled: false, hasToken: false },
  pinOnImport: true
}

/** Kubo RPC paths used by the app. All are POST, per the Kubo RPC API. */
export const KUBO_RPC = {
  id: '/api/v0/id',
  dagImport: '/api/v0/dag/import',
  /**
   * The other direction: ask the node for content it already holds, as a `.car`.
   *
   * Needed because a member whose node already had the archive downloaded
   * nothing, so there is no backup file to build an archive from. The node is
   * the only copy on the machine, and this is how it is asked for it back.
   */
  dagExport: '/api/v0/dag/export',
  pinAdd: '/api/v0/pin/add',
  pinLs: '/api/v0/pin/ls',
  swarmConnect: '/api/v0/swarm/connect',
  repoStat: '/api/v0/repo/stat'
} as const

/** Pinata endpoints. Auth is always `Authorization: Bearer <JWT>`. */
export const PINATA = {
  testAuth: 'https://api.pinata.cloud/data/testAuthentication',
  /** Legacy pin-by-CID; accepts `pinataOptions.hostNodes`, which we rely on. */
  pinByHash: 'https://api.pinata.cloud/pinning/pinByHash',
  /** Query queued/failed pin-by-CID jobs. */
  pinJobs: 'https://api.pinata.cloud/pinning/pinJobs',
  /** List what is actually pinned, to verify rather than trust. */
  pinList: 'https://api.pinata.cloud/data/pinList',
  /** Direct upload, used when no Kubo node can serve the bytes. */
  uploadV3: 'https://uploads.pinata.cloud/v3/files'
} as const
