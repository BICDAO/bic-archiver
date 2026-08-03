# BIC Archiver

A desktop app that turns an NFT contract address into a verifiable IPFS backup.

Paste an OpenSea link, an Etherscan link, or just a contract address and some token
numbers. The app reads `tokenURI` off-chain, follows it to wherever the metadata and
media actually live, downloads every file in a way that **preserves the original
content ID**, records where each byte came from, and writes a single `.car` file that
anyone can verify.

No IPFS daemon. No IPFS Desktop. No Kubo. Nothing to install but the app itself.

- **Members** who just want to make a backup: [`docs/FOR-MEMBERS.md`](docs/FOR-MEMBERS.md)
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
| Install IPFS Desktop, wait for the daemon | Nothing — the app speaks the gateway HTTP protocols directly and keeps blocks in its own on-disk blockstore | `src/main/ipfs/blockstore.ts` |
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
│   ipc.ts      18 channels, every one returning {ok:true,value} | {ok:false,error} │
└──────────────────────────────────┬────────────────────────────────────────────────┘
                                   │  contextBridge, sandboxed, CJS preload
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

So the app has no daemon to start, no ports to open, no repo to migrate, and no
version of Kubo to keep in step with. The cost is that it depends on public gateways
being up — see [Limits](#limits-be-honest-about-these).

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
| `src/main/ipc.ts` | All 18 channels, cancellation, progress fan-out, plain-English error sanitising. |
| `src/main/index.ts` | Window, lifecycle, CSP, navigation hardening. |
| `src/preload/index.ts` | The `window.api` bridge **and** the single source of truth for IPC types. Built as CJS — sandboxed preloads must be. |
| `src/renderer/hooks.ts` | `useArchive`, `useProgress`, `useHealth`, `useAsyncAction`. One module-level store per concern via `useSyncExternalStore`. |
| `src/renderer/App.tsx` | Shell, sidebar, first-run archive chooser, activity strip. |
| `src/renderer/components/` | `AddTokensView`, `ArchiveView`, `HealthView`, `ExportView`, plus `Layout` primitives, `ProgressList`, `Cid`. |

### What an archive looks like on disk

An archive is an ordinary folder the member picks. Nothing is hidden anywhere else.

```
<archive folder>/
  manifest.json        ArchiveManifest — tokens, imported roots, root CID
  manifest.json.bak    previous manifest; writes are atomic (tmp → fsync → rename)
  blocks/              blockstore-fs: the content itself, addressed by CID
  exports/             scratch space for exports
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
- **No built-in pinning.** The app makes a `.car` file; it does not put anything back
  on IPFS. Keeping content alive means uploading that file to a pinning service, and
  the Export screen points at one (Storacha) without ever touching an account or a
  payment. Adding real pinning means an API token per DAO, which is a product
  decision, not a missing function.
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
