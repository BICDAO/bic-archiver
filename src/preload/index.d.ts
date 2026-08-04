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
  TokenResult
} from './index'

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
