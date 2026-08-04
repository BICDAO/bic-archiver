/**
 * Ambient declaration of everything the window can see.
 *
 * The renderer never imports the preload *implementation* — it only ever
 * touches `window.api`. This file wires that global up to the contract declared
 * in `src/preload/index.ts`, so a typo in a channel argument or a misread result
 * shape is a compile error in the GUI rather than a blank screen in front of a
 * DAO member.
 *
 * Type-only re-exports are provided too, for components that want to name a
 * shape directly:
 *
 *   import type { ArchiveSnapshot, IpcResult } from '../preload'
 */

import type { ArchiverApi } from './index'

export type {
  AddTokensResult,
  ArchiveSnapshot,
  ArchiverApi,
  BuildRootResult,
  DialogOptions,
  ExportCarResult,
  ExportFolderResult,
  HealthCheckItem,
  HealthCheckResult,
  ImportCarResult,
  IpcResult,
  KuboImportResult,
  MergeExistingResult,
  MirrorStatus,
  TokenResult
} from './index'

/**
 * The mirror and gallery shapes come from `src/shared/community.ts`, re-exported
 * for the same reason as the pinning ones below: a component can name them
 * without reaching into `src/main`.
 *
 * `mediaUrl()` and `MEDIA_SCHEME` are *values*, so they are not here — import
 * them from `../shared/community` directly. That file holds no engine code and
 * is safe in the window bundle.
 */
export type {
  GalleryItem,
  GallerySummary,
  MirrorCapability,
  MirrorProgress,
  MirrorResult
} from '../shared/community'

/**
 * The pinning shapes come from `src/shared/pinning.ts` and are re-exported here
 * so a component can name them without reaching across the tree — and so the
 * window never has to import from `src/main`, where the Pinata key lives.
 *
 * Note what is *not* in `PinningSettings`: the key itself. It carries
 * `pinata.hasToken: boolean` only, which is the entire reason the renderer can
 * be typed against the real settings object at all.
 */
export type {
  AssetRow,
  PinProgress,
  PinResult,
  PinRunSummary,
  PinState,
  PinTargetId,
  PinTargetStatus,
  PinningSettings
} from '../shared/pinning'

declare global {
  interface Window {
    /**
     * The archive engine. Every method resolves — none of them reject — to
     * `{ ok: true, value }` or `{ ok: false, error }`, where `error` is a
     * plain-English sentence safe to show a non-technical member as-is.
     */
    readonly api: ArchiverApi
  }
}
