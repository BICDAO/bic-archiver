# BIC Archiver

https://www.virustotal.com/gui/file/57d22df0f6bf7ebe27ee8618d827e4bb0073d0ffea5e2cde280f9893c50bf739

A desktop app that turns an NFT contract address into a verifiable IPFS backup.

Paste an OpenSea link, an Etherscan link, or just a contract address and some token
numbers. The app reads `tokenURI` off-chain, follows it to wherever the metadata and
media actually live, downloads every file in a way that **preserves the original
content ID**, records where each byte came from, and writes a single `.car` file that
anyone can verify.

**Archiving needs no IPFS daemon** — no IPFS Desktop, no Kubo, nothing to install but
the app itself. *Putting content back on IPFS* is a different job, and for that a real
node is not optional; see [`docs/PINNING.md`](docs/PINNING.md) for why. **The app now
installs and supervises that node itself** — it downloads Kubo from the official host,
verifies its SHA-512 before running a byte of it, and installs a login item so a
member's computer keeps serving the archive after the app is closed. No terminal.

- **Members** who just want to make a backup: [`docs/FOR-MEMBERS.md`](docs/FOR-MEMBERS.md)
- **Running a node** — why members rather than services, what it costs, what it
  reveals, what goes wrong: [`docs/RUNNING-A-NODE.md`](docs/RUNNING-A-NODE.md)
- **Copying BIC's whole archive**: [`docs/MIRRORING.md`](docs/MIRRORING.md)
- **Keeping the content alive on IPFS**: [`docs/PINNING.md`](docs/PINNING.md)
- **Whoever maintains this next**: [`docs/HOW-IT-WORKS.md`](docs/HOW-IT-WORKS.md)

---

## The problem this replaces

Archiving one NFT by hand meant: install IPFS Desktop, open Etherscan, find the
contract, click **Read as Proxy** because the proxy's own ABI has no `tokenURI`, call
`tokenURI` with the token number, copy the result, paste a base64 `data:` blob into
an online decoder, read the image CID out of the JSON by eye, paste each CID into
IPFS Desktop's *Import from IPFS*, hand-create folders named `Ape #1`, `web image`
and so on, drag the pinned items into them, right-click the top folder and copy its
hash. And when a file had already fallen off IPFS: find a copy somewhere, then re-run
`ipfs add` with different flags over and over until the hash matched the one on chain.

Nobody did this for a whole collection. That is why the DAO's October 2025 backup is
now unreachable and nobody noticed until someone went looking.

### Old step → what does it now

| Manual step | Automated by | Where |
| --- | --- | --- |
| Install IPFS Desktop, wait for the daemon | Nothing, to *archive* — the app speaks the gateway HTTP protocols directly and keeps blocks in its own on-disk blockstore. To *serve*, the app installs and supervises Kubo itself | `src/main/ipfs/blockstore.ts`, `src/main/node/` |
| Open Etherscan, find the contract, click **Read as Proxy** | `eth_call` over public JSON-RPC; proxies are transparent to the EVM, so there is no proxy step | `src/main/chain/rpc.ts` |
| Call `tokenURI(id)` / `uri(id)` and copy the result | `resolveTokenUri()`, hand-rolled ABI encode/decode, ERC-721 then ERC-1155 | `src/main/chain/tokenUri.ts` |
| Paste a base64 `data:` blob into an online decoder | Decoded in-process, base64 **and** plain-percent-encoded `data:` URIs | `src/main/chain/tokenUri.ts` |
| Read `image` / `animation_url` out of the JSON by eye | `extractAssetUrls()` walks the metadata for every media field | `src/main/archive/inputs.ts` |
| Paste each CID into *Import from IPFS* | Trustless CAR retrieval — every block re-hashed locally before it is kept | `src/main/ipfs/trustlessFetch.ts` |
| Re-run `ipfs add` with different flags until the hash matches | `reconstructCid()` replays an 18-entry parameter matrix, and only ever runs after verified retrieval has failed everywhere | `src/main/ipfs/importer.ts` |
| Create folders by hand and drag pinned items in | Canonical dag-pb directories, byte-identical to what IPFS Desktop would produce | `src/main/ipfs/dag.ts` |
| Right-click the top folder, copy the hash | The archive fingerprint (root CID) is shown on screen and written into the manifest | `src/main/archive/archiver.ts` |
| *(nobody ever did this)* record where each byte came from | `_provenance.json` per token: source URL, gateway, timestamp, sha256, stored CID, original CID, whether they match | `src/main/archive/provenance.ts` |
| *(nobody ever did this)* notice content had gone | Health screen: delegated routing providers + live gateway probes | `src/main/health/check.ts` |
| *(nobody ever did this)* keep a second copy of the DAO's archive | One button: resolve DNSLink, fetch 1.9 GB in resumable units, verify every block, hand it to a node | `src/main/community/mirror.ts` |
| *(nobody ever did this)* notice your mirror had gone stale | Drift check against the DNSLink root; only `behind` is red, a failed lookup is never reported as drift | `src/main/community/drift.ts` |
| *(nobody ever did this)* actually look at what you are keeping | Gallery grid + detail panel, served from the blockstore over `bic-media://` | `src/main/community/gallery.ts`, `mediaProtocol.ts` |

---

## Architecture

Three processes, one direction of trust.

```
┌──────────────────────────── Electron main (Node 22, ESM) ─────────────────────────┐
│  THE ENGINE. All network I/O, all crypto, all disk access.                        │
│                                                                                   │
│   chain/      eth_call JSON-RPC ·  tokenURI → ResolvedTokenUri                    │
│   ipfs/       trustless CAR fetch · block verify · dag-pb · UnixFS import · CAR   │
│   archive/    input parsing · orchestration · manifest store · provenance         │
│   health/     delegated routing + gateway probes                                  │
│   pinning/    Kubo RPC · Pinata REST · the import→hostNodes→verify sequence       │
│   node/       downloads + SHA-512-verifies Kubo · repo · login item · lifecycle   │
│   community/  mirror BIC's archive · DNSLink drift · gallery · bic-media://       │
│   settings.ts settings file + the Pinata token, via safeStorage (OS keychain)     │
│   ipc.ts      39 request channels + 5 push events, every reply                    │
│               {ok:true,value} | {ok:false,error}                                  │
└──────────────────────────────────┬────────────────────────────────────────────────┘
                                   │  contextBridge, sandboxed, CJS preload
                                   │  + bic-media:// for archived pictures
┌──────────────────────────────────┴────────────────────────────────────────────────┐
│  Electron renderer (React 19). THE GUI, and nothing else.                         │
│  No Node integration. No `require`. No network of its own — CSP is `default-src   │
│  'none'`. It can only ask `window.api` to do things.                              │
└───────────────────────────────────────────────────────────────────────────────────┘
```

**Why no IPFS daemon.** Everything IPFS Desktop was doing for us is either an HTTP
request to a public gateway or a pure function over bytes:

- *Retrieval* is `GET {gateway}/ipfs/{cid}?format=car&dag-scope=…` with
  `Accept: application/vnd.ipld.car`, which returns the raw blocks. We verify each
  one against its own multihash ourselves.
- *Storage* is `blockstore-fs`, a directory of block files inside the archive folder.
- *Directory building* is `@ipld/dag-pb` + `ipfs-unixfs`, encoding the same canonical
  bytes Kubo does.
- *Export* is `@ipld/car`.

So *the archiving half* has no daemon to start, no ports to open, no repo to migrate
and no version of Kubo to keep in step with — a member can back up an NFT on a machine
with nothing installed but this app. The cost is that it depends on public gateways
being up — see [Limits](#limits-be-honest-about-these). (The *serving* half does pin a
Kubo version and does manage a repo and ports; that is the next two paragraphs, and it
is deliberately a separate subsystem for exactly this reason.)

**Where a daemon does become necessary.** Reading content off IPFS needs no node;
*putting it back* does. A pinning service's pin-by-CID asks it to find the content on
the network, which cannot work for content that is already gone — and 428 CIDs in the
DAO's real backup are exactly that. The only thing that can revive them is a node that
holds the blocks under their original CIDs and is dialable from the internet, which is
why `src/main/pinning/` speaks the Kubo RPC and hands Pinata the node's multiaddrs as
`hostNodes`. [`docs/PINNING.md`](docs/PINNING.md) has the whole argument.

**And why the app now runs that node itself.** The original plan was that the member
supplied the node. That plan died twice, measurably: Storacha's infrastructure was
decommissioned (`up.`/`console.`/`access.storacha.network` are NXDOMAIN), and Pinata's
`pinByHash` turned out to be **paid-only** — `403 PAID_FEATURE_ONLY`, verified live —
with a free tier of 1 GB / 500 files against an archive of 1.9 GB / 20,808 files. Both
were single points of failure; members are not. But "members run nodes" is only a plan
if a non-technical member never opens a terminal, so `src/main/node/` downloads Kubo,
**verifies its SHA-512 before unpacking or executing anything**, initialises a repo on
free ports, starts it, confirms it answers, and installs a per-user login item with
crash recovery. See [`docs/RUNNING-A-NODE.md`](docs/RUNNING-A-NODE.md).

**A node we did not install is never touched.** Managed-versus-external is decided by
comparing the repository's own peer ID against the one in the repo the app created —
not by a port number, which anything can occupy. An external node is used, reported
with `managed: false`, and never reconfigured, stopped, set to autostart or uninstalled.

**Why the renderer is inert.** A DAO member is going to paste URLs from Discord into
this app. The renderer cannot fetch them, cannot read the disk and cannot reach
Electron; it hands strings to the main process, which validates them. The build
enforces this: `rendererIsolationPlugin` in `electron.vite.config.ts` **fails the
build**, naming the offending import, if a Node builtin, `electron`, any IPFS package
or anything under `src/main/` ends up in the window bundle. The usual way to trip it
is dropping `type` from `import type { … } from '../preload'`.

### Module map

| Path | Role |
| --- | --- |
| `src/shared/types.ts` | The fixed contract between engine and GUI. Change it and both sides must change. |
| `src/shared/constants.ts` | Endpoints, ABI selectors, timeouts, archive layout names. Every endpoint was reachability-tested; each list is an ordered set of candidates, never a single point of failure. |
| `src/main/chain/rpc.ts` | `ethCall`, `decodeAbiString`. Hand-rolled JSON-RPC over `fetch`, no viem/ethers. Falls through four public endpoints. Distinguishes *unreachable* from *reverted*. |
| `src/main/chain/tokenUri.ts` | `resolveTokenUri`, `detectStandard`, `parseIpfsUri`, `encodeUint256`. ERC-721 → ERC-1155 → `data:` decode. |
| `src/main/ipfs/trustlessFetch.ts` | `fetchCar`, `fetchDag`, `resolvePath`, `verifyBlock`, `fetchHttpBytes`, `fetchIpfsBytesFallback`. The module that makes the manual ritual obsolete. |
| `src/main/ipfs/blockstore.ts` | `blockstore-fs` wrapper — open/close/get/put/has. |
| `src/main/ipfs/importer.ts` | `addBytes`, `reconstructCid`, `RECONSTRUCTION_MATRIX`, `sha256Hex`, `addDirectoryFromFs`. Every importer knob pinned so a library update cannot silently change our CIDs. |
| `src/main/ipfs/dag.ts` | `buildDirectory`, `listDirectory`, `cumulativeSize`, `mkdirp`. Canonical link ordering and `Tsize`. No network I/O. |
| `src/main/ipfs/car.ts` | `exportCar`, `importCar`, `exportBrowsableFolder`. Import hash-checks every block as it reads. |
| `src/main/archive/inputs.ts` | `parseTokenInput`, `extractAssetUrls`, `sanitizeFolderName`, `CHAIN_IDS`. Accepts OpenSea/Etherscan links, bare addresses, ranges (`1-50`), mixed lines. Errors quote the offending line. |
| `src/main/archive/archiver.ts` | `archiveToken`, `archiveMany`, `buildArchiveRoot`, `mergeExistingBackup`. The orchestrator. |
| `src/main/archive/store.ts` | `ArchiveStore` — the archive folder, its `manifest.json` (atomic writes + `.bak`), its blockstore, and a lock so two jobs cannot fight. |
| `src/main/archive/provenance.ts` | `buildProvenance`, `layoutPathFor`. Pure function of the token — no live clock, so folder CIDs are reproducible. |
| `src/main/health/check.ts` | `checkHealth`, `checkMany`, `checkProviders`, `probeGateway`. Never throws; dead content resolves in seconds. |
| `src/shared/pinning.ts` | The pinning contract: `PinState`, `PinTargetStatus`, `AssetRow`, `PinRunSummary`, `PinningSettings`, `KUBO_RPC`, `PINATA`. Its header comment is the design rationale. |
| `src/main/pinning/kubo.ts` | `detectKubo`, `importCarToKubo`, `pinCid`, `listPins`. Streams the CAR over `node:http`; classifies multiaddrs into what a remote service could actually dial. |
| `src/main/pinning/pinata.ts` | `testPinataAuth`, `pinByCid`, `pinJobResult`, `listPinnedCids`. Every returned string is redacted of anything token-shaped. |
| `src/main/pinning/manager.ts` | `getTargets`, `pinAll`, `pinArchive`. The import → `hostNodes` → verify sequence, with progress and an exact failure count. |
| `src/main/pinning/assets.ts` | `buildAssetRows`, `mergeHealth`, `mergePinStates`, `summarise`. Walks the DAG — never the blockstore, which is keyed by multihash and returns raw CIDs. |
| `src/shared/node.ts` | The managed-node contract: `NodeState`, `ManagedNodeStatus`, `NodeInstallProgress`, `DriftStatus`, `KUBO_DIST`, `KUBO_PLATFORMS`, `AUTOSTART_LABEL`, `DEFAULT_STORAGE_MAX` (20 GiB). Its header states the two non-negotiable download rules. |
| `src/main/node/install.ts` | `platformKey`, `kuboArtifact`, `downloadKubo`, `parseChecksumFile`, `extractBinaryFromTarGz`, `ensureRepo`, `clearStaleLock`, `readRepoInfo`, `runIpfs`, `parseStorageMax`, the install record. **Where the SHA-512 check lives.** |
| `src/main/node/autostart.ts` | `enableAutostart`, `disableAutostart`, `isAutostartEnabled`, `startViaServiceManager`, `stopViaServiceManager`, `recentLogTail`. LaunchAgent / systemd user unit / Startup shim. Per-user only — never asks for admin rights. |
| `src/main/node/manager.ts` | `getNodeStatus`, `installAndStart`, `startNode`, `stopNode`, `uninstallNode`, `nodePaths`. Port selection, managed-vs-external, and "nothing is reported as working until it answers". |
| `src/shared/community.ts` | The mirror/gallery contract: `BIC_ARCHIVE` (with the DNSLink `pointer`), `MirrorCapability`, `MirrorProgress`, `MirrorResult`, `MEDIA_SCHEME`, `mediaUrl`, `GalleryItem`, `GallerySummary`. |
| `src/main/community/mirror.ts` | `resolveArchiveRoot`, `detectCapabilities`, `mirrorArchive`, `checkMirrorStatus`. Splits 1.9 GB into resumable units; sets `nowServing` only when the content is genuinely retrievable by somebody else. |
| `src/main/community/drift.ts` | `resolvePublishedCid`, `getLocalMirrorCid`, `checkDrift`, `recordMirrored`. DNSLink over DoH → OS resolver → gateways. A failed lookup is `unknown`, never `behind`. |
| `src/main/community/gallery.ts` | `buildGallery`, `mergeGalleryHealth`, `summariseGallery`, `readMediaBytes`, `sniffContentType`, `normaliseAttributes`. |
| `src/main/community/mediaProtocol.ts` | `registerMediaScheme`, `installMediaProtocol`, `handleMediaRequest`, `cidFromUrl`, `parseRange`. The `bic-media://` scheme — see below. |
| `src/main/settings.ts` | Pinning settings on disk plus the Pinata token via `safeStorage`. The token never crosses IPC. |
| `src/main/ipc.ts` | All 39 channels and 5 push events, cancellation, progress fan-out, plain-English error sanitising, token redaction. |
| `src/main/index.ts` | Window, lifecycle, CSP, navigation hardening, `bic-media` scheme registration. |
| `src/preload/index.ts` | The `window.api` bridge **and** the single source of truth for IPC types. Built as CJS — sandboxed preloads must be. |
| `src/renderer/hooks.ts` | `useArchive`, `useProgress`, `useHealth`, `useAsyncAction`. One module-level store per concern via `useSyncExternalStore`. |
| `src/renderer/App.tsx` | Shell, sidebar, the welcome screen, the drift banner, activity strip. |
| `src/renderer/components/` | `Welcome`, `AddTokensView`, `ArchiveView`, `GalleryView`, `NftDetail`, `AssetsView`, `HealthView`, `ExportView`, `DriftBanner`, `PinningSettings`, `Help`, plus `Layout` primitives, `ProgressList`, `Cid`. |

### IPC channels

**39 request/response channels**, every one registered through the same `handle()`
wrapper, so every one resolves to `{ok:true,value}` or `{ok:false,error}` and none of
them ever rejects. `error` is always a plain-English sentence safe to put in front of a
non-technical member. Channels taking an `opId` register an `AbortController`, which is
what `op:cancel` reaches.

| Group | Channels |
| --- | --- |
| Archive | `archive:create`, `archive:open`, `archive:current`, `archive:parseInput`, `archive:addTokens`, `archive:removeToken`, `archive:buildRoot`, `archive:mergeExisting` |
| Health | `health:check` |
| Files | `export:car`, `export:folder`, `import:car` |
| Settings | `settings:get`, `settings:save`, `settings:setPinataToken`, `settings:clearPinataToken` |
| Pinning | `pin:targets`, `pin:assets`, `pin:all`, `pin:archive`, `kubo:importCar` |
| Community | `mirror:status`, `mirror:capabilities`, `mirror:run`, `drift:check`, `gallery:list`, `gallery:item` |
| **Managed node** | `node:status`, `node:install`, `node:start`, `node:stop`, `node:uninstall`, `node:setAutostart` |
| Shell | `dialog:pickDirectory`, `dialog:saveCar`, `dialog:openCar`, `shell:openPath`, `shell:openExternal` |
| Control | `op:cancel` |

**5 main→renderer push events**, each with an unsubscribe-returning wrapper on
`window.api`: `progress` (`onProgress`), `health` (`onHealth`), `pin-progress`
(`onPinProgress`), `mirror-progress` (`onMirrorProgress`), `node-progress`
(`onNodeProgress`). Terminal events are never coalesced away, and nothing is sent to a
destroyed `webContents`.

Three properties of the node channels are deliberate and should survive refactoring:

- **`node:install` takes no payload but an `opId`.** Nothing the renderer can send names
  a URL, a version, a mirror or a path. That is the security property — this channel
  ends in executing a downloaded binary, so no renderer bug and no injected string can
  redirect what gets run. The only source of the download location is `KUBO_DIST`.
- **`node:uninstall` does not expose `removeRepo`.** The engine supports it and defaults
  it to `false`; the channel never passes it. "Remove the program" and "delete 1.9 GB of
  rescued NFTs" are different requests and do not belong behind one boolean.
- **`node:status` is outside the node lock.** Install/start/stop/uninstall/setAutostart
  serialise against each other (an uninstall deleting a binary an install is writing is
  a real failure); status does not, because a panel must keep drawing itself while an
  install streams progress.

`KUBO_DIST`, `KUBO_PLATFORMS`, `AUTOSTART_LABEL` and `DEFAULT_STORAGE_MAX` are *values*
and are deliberately **not** re-exported to the window — `src/preload/index.d.ts` gives
the renderer `ManagedNodeStatus`, `NodeInstallProgress`, `NodeState` and `DriftStatus`
as types only. The window has no business naming a download location or a login-item
label.

### `bic-media://` — showing archived pictures in the window

The renderer has no filesystem and no Node, so it cannot read the blockstore. Base64ing
every thumbnail through IPC would push tens of megabytes across the bridge to draw one
screen of a gallery, and hold it in two processes at once. So the main process answers a
scheme of its own instead, straight out of the archive's blockstore:

```html
<img src="bic-media://cid/bafkrei…">
<video src="bic-media://cid/bafybei…" controls>
```

- **Registered before app ready** (`registerMediaScheme()` at module scope in
  `src/main/index.ts`), because privileged schemes must be. `installMediaProtocol()`
  then binds it to whichever archive is currently open.
- **The only thing it will ever read is a content address.** The path after `//cid/` is
  parsed with the `CID` class and rejected outright otherwise. No file path, no `..`, no
  traversal — a CID either names a block we already hold or it names nothing.
- **It never throws.** A rejecting protocol handler tears a hole in the page for someone
  who cannot read a stack trace, so every failure is a status code plus a sentence: 400
  for an address that is not an address, 404 for content we do not have, 503 while no
  archive is open, 500 for the genuinely unexpected.
- **Range requests are supported**, because Chromium's media stack will not let you scrub
  a `<video>` without them. Responses above 64 MB stream in 4 MB windows rather than
  buffering.
- **Cached hard** (`immutable`, one year) — a CID is a hash, so the bytes behind it can
  never change.
- Responses carry their own `default-src 'none'; sandbox` CSP, and `bic-media:` is in
  `img-src` and `media-src` in both the dev and production window policies, which are
  kept in step with the `<meta http-equiv="Content-Security-Policy">` tag.

`mediaUrl()` and `MEDIA_SCHEME` live in `src/shared/community.ts` and are safe in the
window bundle; that file holds no engine code.

### What an archive looks like on disk

An archive is an ordinary folder the member picks. Nothing is hidden anywhere else.

```
<archive folder>/
  manifest.json        ArchiveManifest — tokens, imported roots, root CID
  manifest.json.bak    previous manifest; writes are atomic (tmp → fsync → rename)
  blocks/              blockstore-fs: the content itself, addressed by CID
  exports/             scratch space for exports
  .pin-scratch-*/      transient: the CAR handed to Kubo during a pin run, removed
                       afterwards. It lives here rather than in os.tmpdir() because
                       /tmp is a tmpfs on many Linux distributions and a 1.8 GB
                       backup streamed through RAM takes the machine down.
```

And the folder tree the archive assembles (mirrors the layout the DAO already built
by hand, so a new backup sits next to a 2023 one and looks the same):

```
<Token Name>/
  metadata                 ← IPFS-addressed: the entry *is* the original CID
  image
  animation
  web metadata/<file>      ← rescued over https, so it gets a named subfolder
  web image/<file>
  arweave image/<file>
  _provenance.json
```

---

## Develop

```sh
npm ci
npm run dev          # electron-vite dev, HMR on the renderer
npm run typecheck    # tsc over tsconfig.node.json and tsconfig.web.json
npm run test         # vitest, offline suite
npm run build        # electron-vite build → out/{main,preload,renderer}
```

Requirements: **Node 22** and npm 10. TypeScript is `strict` with
`noUncheckedIndexedAccess` on; Node builtins must use the `node:` prefix; the project
is ESM (`"type": "module"`) except the preload, which electron-vite emits as
`out/preload/index.cjs`.

### Testing

Two suites, and the split is enforced by configuration rather than by discipline.

- **`npm run test`** — the offline suite (`vitest.config.ts`, `test/*.test.ts`). It
  loads `test/setup/no-network.ts`, which replaces `globalThis.fetch` with a stub that
  throws, so a test that quietly starts depending on a gateway fails loudly instead of
  turning the suite into a weather report. Tests that need to exercise a
  network-shaped code path stub `fetch` themselves with `vi.stubGlobal` and hand it
  back afterwards. **This is what CI runs**, with no `--passWithNoTests`: a broken
  include glob must go red, not green-with-zero-tests.
- **`npm run test:live`** — the live suite (`vitest.live.config.ts`,
  `test/live/*.live.test.ts`). Talks to Ethereum mainnet, real gateways and the
  delegated routing endpoint. Slow, rate-limited, and **fails for reasons that are not
  your fault**. It is deliberately unreachable from the default config. Run it by hand
  before cutting a release. **CI must never run it** — the workflow does not, on
  purpose.

The live suite is also documentation: one of its tests asserts that the DAO's own
October 2025 backup CID is unreachable. If that test ever starts *failing*, somebody
has re-pinned the content, and that is very good news.

### Adding a network dependency

Don't add one silently. Every endpoint lives in `src/shared/constants.ts` as an
ordered candidate list, and every call site is expected to fall through the list and
then fail with a sentence a non-technical member can act on. A new endpoint that is
not in that file, or a call without a timeout, is a bug.

---

## Cut a release

1. Bump `version` in `package.json`, commit.
2. `git tag v0.2.0 && git push origin main --tags`.
3. `.github/workflows/build.yml` runs typecheck/test/build, then builds the macOS
   `.dmg` and the Windows NSIS installer and attaches both to a **draft** GitHub
   release for that tag.
4. Download both, open each one once on a real machine, then press **Publish** on the
   draft.

Locally: `npm run dist:mac`, `npm run dist:win`, `npm run dist:linux` → `release/`.

**Builds are unsigned.** There are no code-signing certificates or notarisation
secrets in this repository, on purpose — a DAO should not be holding a signing key in
CI. macOS will refuse to open the app on first launch; the way past it is
System Settings → Privacy & Security → **Open Anyway**, which is written out for
members in [`docs/FOR-MEMBERS.md`](docs/FOR-MEMBERS.md). Windows SmartScreen shows
*More info* → *Run anyway*. If the DAO ever buys certificates, electron-builder picks
them up from secrets without any change to the build scripts.

---

## Limits, be honest about these

- **Ethereum mainnet only.** Input parsing understands Polygon, Base, Arbitrum,
  Optimism, Avalanche and Klaytn URLs, but `ethCall` refuses any `chainId` other than
  `1` with *"This app can only read contracts on the Ethereum main network."* The
  endpoint list in `constants.ts` is mainnet-only. Supporting another chain means
  adding its RPCs and threading `chainId` through — the plumbing is already there.
- **Public gateways, public RPCs, no keys.** The app depends on
  `trustless-gateway.link`, `ipfs.io`, `dweb.link`, `w3s.link`,
  `delegated-ipfs.dev` and four public JSON-RPC endpoints. They rate-limit, they go
  down, and they will eventually change. Token archiving is deliberately limited to
  three at a time for that reason. If a run gets slow or starts failing, suspect a
  429 before you suspect the code.
- **Pinning needs a node — the app installs one, but it is still a node.** The archiver
  alone makes a `.car` file; it does not put content back on IPFS. The app can now set
  up Kubo itself, but the physics are unchanged: Pinata's pin-by-CID *searches the
  network*, so it cannot rescue content that is already gone — the node has to serve the
  bytes first and be dialable from the internet. Behind a firewall that blocks inbound
  4001 the node falls back to relays, the rescue half degrades, and the app says so
  rather than pretending. See [`docs/PINNING.md`](docs/PINNING.md).
- **Hosted pinning is no longer a route for members.** Storacha's infrastructure is gone
  (NXDOMAIN) and Pinata's `pinByHash` is paid-only (`403 PAID_FEATURE_ONLY`, verified
  live) with a free tier of 1 GB / 500 files against 1.9 GB / 20,808. Pinata remains
  wired up and useful to whoever holds a paid plan; it is demoted to a collapsed section
  of Settings and is not the answer for anybody else.
- **The managed node downloads and executes a binary.** That is inherent to the feature.
  The mitigations are the whole of the security story: HTTPS from `KUBO_DIST` only, a
  pinned version, no renderer-supplied URL/version/path, and a SHA-512 check against the
  artifact's sibling `.sha512` before anything is unpacked or run — a mismatch deletes
  the download and reports failure. Note there is **no combined `SHA512SUMS`** on
  `dist.ipfs.tech`; asking for one returns an IPFS *resolution error page*, not a 404,
  which is an easy way to end up "verifying" against an error page. `parseChecksumFile`
  rejects anything that is not exactly 128 hex characters.
- **macOS defers `KeepAlive` respawns on battery.** The LaunchAgent sets `KeepAlive` and
  launchd accepts it, but after a crash on battery power macOS may report
  `pended nondemand spawn = inefficient` and leave the node down until the machine is on
  mains. Every `ProcessType` value behaves identically, so this is power policy, not a
  plist defect. Starting the node from the app brings it straight back.
- **Only Ethereum-mainnet NFTs, and only six platforms for the node.** Kubo artifacts
  exist for darwin arm64/x64, win32 x64/arm64 and linux x64/arm64; anything else gets a
  plain refusal that still leaves archiving and health checks working.
- **"Pin new content automatically" is stored but not yet acted on.** The setting
  persists and defaults to on; `archive:addTokens` does not start a pin run when it
  finishes. Pin explicitly from the Assets screen.
- **No ENS resolution.** `feistydao.eth` is rejected with an explanation, not
  resolved. Paste the `0x…` address.
- **Reconstruction is bounded.** Rescued files over 256 MB skip CID reconstruction
  (each attempt needs the whole file in memory); the content is saved and honestly
  marked not-preserved. Metadata over 64 MB is refused. At most 64 assets per token.
- **Assets that are folders** (some HTML-bundle `animation_url`s) are archived
  intact, but their recorded `sha256` is of the folder's own IPFS block rather than
  of one file. The provenance record says so.
- **Batch caps:** 1000 tokens per archiving run, 5000 CIDs per health sweep. Both
  refuse with a plain-English "do it in batches" message rather than silently
  truncating.
- **A browsable folder export is not a backup.** It writes ordinary files, which
  throws away the attributes needed to reproduce the original hashes. The `.car` is
  the backup; the folder is for looking at.

## Inspecting a `.car` from the command line

BIC keeps its master backups as `.car` files in Google Drive rather than relying
on the IPFS network to hold them. That keeps the bytes safe but says nothing
about whether any content ID inside is still being *served* — and those are
different properties. To find out:

```bash
npm run inspect -- /path/to/BIC-backup.car
```

It verifies every block's hash as it reads, lists what is inside, then checks
each content ID against the public network and reports what is online, what is
at risk, and what now exists only inside that file. Add `--no-health` to skip
the network pass, or `--json report.json` to keep a machine-readable copy.

Runs on plain Node — no Electron, no window — via a small library bundle
(`npm run build:lib`) so it shares the app's code paths rather than
reimplementing them.
