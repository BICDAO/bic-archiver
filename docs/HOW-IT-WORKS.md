# How it works, and why it works that way

For whoever maintains this next.

This document explains the decisions that are not obvious from the code, and records
the things that were verified against the live network rather than assumed. If you
are about to change how content is fetched, how directories are built, or how the
chain is read — read the matching section first. Each one exists because the naive
version is subtly wrong in a way that only shows up as a CID that does not match, six
months later, when somebody tries to verify a backup.

---

## 1. Trustless CAR retrieval preserves the original CID by construction

This is the single idea the whole app is built on.

### The manual procedure, and why it is a dark art

The old instructions said: download the file from a gateway, then run `ipfs add` with
various flags until the resulting hash matches the CID in the metadata.

That is hard because **a CID is not the hash of the file**. It is the hash of the
*root block of a DAG* built from the file. Getting to that root block involves a pile
of parameters that the file itself does not record:

- where the chunk boundaries are (256 KiB? 1 MiB? 64 KiB?),
- whether the leaves are raw blocks or UnixFS `file` nodes,
- how many links fit in a parent node before a new layer is added,
- whether the tree is `balanced` or `trickle`,
- CIDv0 (`Qm…`, dag-pb, base58) or CIDv1 (`bafy…`, multicodec-tagged, base32),
- and for a single-chunk file, whether the lone leaf is collapsed into the root.

A plain gateway request (`GET /ipfs/{cid}`) reassembles the DAG and hands you the
*content*. Every one of those parameters has been thrown away by the time the bytes
reach you. Recovering the original CID means guessing them back. Hence the ritual.

### What we do instead

We ask the gateway for the **blocks**, not the file:

```http
GET {gateway}/ipfs/{cid}?format=car&dag-scope=block
Accept: application/vnd.ipld.car
```

The response is a CAR stream of the raw, unmodified blocks. For every block we
receive, `verifyBlock()` in `src/main/ipfs/trustlessFetch.ts` re-computes the
multihash named by the block's own CID and compares it to the bytes.

If it matches, we are holding **the original block, byte for byte**. Its CID is not
recreated — it is simply *true*, because a CID is nothing more than the hash of those
bytes plus a codec tag. Every parameter in the list above is already baked into the
block we now hold. There is nothing left to guess. Walking the DAG's links and
fetching each child the same way preserves the whole tree the same way.

Two consequences worth stating explicitly:

1. **Verification is not a nicety, it is the mechanism.** If a block's hash does not
   match, the response is discarded *wholesale* and the next gateway is tried. A
   public gateway must never be able to feed us bytes we did not ask for — and since
   we treat verification as the thing that establishes correctness, accepting an
   unverified block would silently destroy the guarantee for everything downstream.
2. **`cidPreserved: true` on a trustless fetch is a fact, not an estimate.** It means
   the stored CID equals the referenced CID and the bytes hash to it. The GUI is
   entitled to show a green tick.

### A gateway quirk you will hit

Gateways **cannot** convert dag-pb to dag-json. Asking for `?format=dag-json` on a
UnixFS directory returns an error telling you to fetch `?format=raw` and decode it
client-side. That is why `resolvePath()` fetches raw blocks and decodes dag-pb here,
with `@ipld/dag-pb`, rather than asking the gateway to do the work. Do not "simplify"
this back into a dag-json request; it does not work.

### `dag-scope`

- `block` — just the addressed block. Used for existence probes and for walking a
  path one directory at a time.
- `entity` — the addressed entity (a whole file's DAG, or a directory's own block
  without its children's contents).
- `all` — the entire sub-DAG.

Choosing the smallest scope that answers the question is what keeps a health sweep
over thousands of CIDs cheap and keeps us polite to gateways run by volunteers.

---

## 2. Why the reconstruction matrix still exists

Section 1 covers the *normal* case. The matrix covers the case this app was written
for: **the content has fallen off IPFS and no trustless gateway will serve its
blocks.**

When that happens, the app does not give up. It tries the plain HTTP gateways
(`FALLBACK_GATEWAYS`), and sometimes one of them still has the file cached, or the
metadata pointed at an `https://ipfs.io/ipfs/Qm…` URL that resolves even though the
content is unpinned. Now we are back in the old world: we hold the *content*, and the
parameters are gone.

So `reconstructCid()` in `src/main/ipfs/importer.ts` does exactly what a member used
to do by hand, except exhaustively and in about a second. It replays candidate
parameter sets into a **throwaway in-memory blockstore**, compares the resulting root
CID to the target, and only when one matches does it replay those same parameters
into the real blockstore. A failed attempt leaves nothing behind.

If a set matches, we have re-derived the original DAG and `cidPreserved` is `true` —
proven, not assumed. If nothing matches, the bytes are still imported with our
defaults so the content is not lost, and the result is reported honestly as
`cidPreserved: false`. That distinction is load-bearing: a member must never be told
a file is verifiable when it is not.

### What each entry corresponds to

The list is ordered most-likely-first. Every entry is a tool and an era.

| # | cidVersion | rawLeaves | chunk | links | layout | What produced CIDs like this |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 0 | no | 256 KiB | 174 | balanced | `ipfs add` with no flags — the Kubo default from 2015 to today. By far the most common origin of the `Qm…` CIDs in old NFT metadata. |
| 2 | 1 | yes | 256 KiB | 174 | balanced | `ipfs add --cid-version=1` (which implies `--raw-leaves`), and the default of Helia, `ipfs-car`, w3up/web3.storage and NFT.Storage. Gives `bafybei…` roots, or a bare `bafkrei…` raw block for a sub-chunk file. |
| 3 | 1 | no | 256 KiB | 174 | balanced | `--cid-version=1 --raw-leaves=false`. Also what a pinning service produces when it re-encodes an existing CIDv0 DAG as CIDv1: identical dag-pb blocks, different CID prefix. |
| 4 | 0 | yes | 256 KiB | 174 | balanced | `ipfs add --raw-leaves` with the CID version left at 0 — a CIDv0 dag-pb root over CIDv1 raw leaves. Small files collapse to a bare raw block. |
| 5 | 1 | yes | 1 MiB | 1024 | balanced | The IPIP-499 `unixfs-v1-2025` profile: Kubo 0.38+ opt-in, newer Helia. |
| 6 | 0 | no | 1 MiB | 174 | balanced | `ipfs add --chunker=size-1048576` on the classic v0 default — a popular tweak for large video and audio. |
| 7 | 1 | yes | 1 MiB | 174 | balanced | js-ipfs and `ipfs-car` with a custom chunker: modern leaves, legacy fanout. |
| 8 | 1 | no | 1 MiB | 174 | balanced | The same with dag-pb leaves. |
| 9 | 0 | no | 256 KiB | 174 | trickle | `ipfs add --trickle` — the streaming-oriented DAG shape, v0 flavour. |
| 10 | 1 | yes | 256 KiB | 174 | trickle | `ipfs add --trickle --cid-version=1`. |
| 11 | 0 | no | 512 KiB | 174 | balanced | `--chunker=size-524288`, the other widely copy-pasted chunker value. |
| 12 | 1 | yes | 512 KiB | 174 | balanced | The same with modern leaves. |
| 13 | 1 | yes | 256 KiB | 1024 | balanced | Kubo 0.38's `--max-links=1024` applied to the classic chunk size. |
| 14 | 0 | no | 256 KiB | 1024 | balanced | The same on a v0 add. |
| 15 | 0 | no | 64 KiB | 174 | balanced | Early js-ipfs, `ipfs-deploy` and browser-era uploaders. |
| 16 | 1 | yes | 64 KiB | 174 | balanced | The same with modern leaves. |
| 17 | 0 | no | 1 MiB | 174 | trickle | `ipfs add --trickle --chunker=size-1048576`, seen on large archival adds. |
| 18 | 1 | no | 256 KiB | 174 | trickle | Trickle with CIDv1 dag-pb leaves. Rare, but cheap to rule out. |

Two optimisations keep 18 entries from meaning 18 imports:

- **Version pruning.** A CIDv1 setting can never produce a `Qm…` hash, so when the
  target is CIDv0 every `cidVersion: 1` entry is skipped outright. The reverse is
  *not* true and nothing is skipped there: `cidVersion: 0` with raw leaves yields a
  CIDv1 raw block for a single-chunk file.
- **Shape collapsing.** `attemptKey()` recognises that a file fitting in one chunk
  ignores the chunk size and the fanout entirely, and that a file whose chunks all fit
  under one parent ignores the fanout. For a typical metadata JSON, 18 entries reduce
  to about 4 real imports.

### What is deliberately *not* in the matrix

The hash function (sha2-256) is fixed by the ecosystem. Everything else that could
drift is **pinned** in `toImporterOptions()` rather than left to library defaults:
HAMT shard threshold (256 KiB of estimated link bytes), shard fanout (8 bits, 256-way),
`shardSplitStrategy: 'links-bytes'`, `reduceSingleLeafToSelf`, and — for trickle —
`leafType: 'raw'` and no single-leaf reduction, matching Kubo. A future default change
in `ipfs-unixfs-importer` must not silently change the CIDs this app produces. If you
upgrade that package, the offline suite's CID fixtures are what will catch it.

### When to grow the matrix

Add an entry when you meet real content in the wild that nothing reproduces, and write
the tool and era in the comment the way the existing entries do. Do not add
combinations speculatively — each one costs an import attempt on every rescued file,
and the list is already ordered by how often it pays.

---

## 3. `eth_call` replaces "Read as Proxy"

The manual instructions send a member to Etherscan, into the **Read as Proxy** tab, to
call `tokenURI`. That step is an artefact of Etherscan's user interface, not of
Ethereum.

Etherscan builds its *Read Contract* form from the **verified ABI of the address you
are looking at**. A proxy contract's own ABI contains `implementation()`,
`upgradeTo()` and a fallback — no `tokenURI`. So there is nothing to click, and
Etherscan offers a second tab that fetches the implementation's ABI and renders a form
from that instead. The proxy is only opaque to the *form builder*.

`eth_call` has no such problem. It executes a message call against the code at the
address, exactly as a transaction would, and a proxy's fallback `DELEGATECALL`s into
the implementation within that same call. The correct `tokenURI` comes back. Proxies
are transparent to `eth_call` — there is no proxy step to perform, and no
implementation address to discover.

We also never need an ABI at all, because we hand-encode the call
(`src/main/chain/tokenUri.ts`):

```
0xc87b56dd                                                          tokenURI(uint256)
0000000000000000000000000000000000000000000000000000000000000001    the token id, 32-byte big-endian
```

and hand-decode the returned string (`decodeAbiString` in `src/main/chain/rpc.ts`):
an offset word, then a length word at that offset, then that many UTF-8 bytes. Token
IDs are carried as decimal *strings* throughout the app and encoded via `BigInt`,
because real token IDs exceed `Number.MAX_SAFE_INTEGER`.

**Verified live:** an `eth_call` of `tokenURI(uint256)` against a live ERC-721 through
`https://ethereum-rpc.publicnode.com` returned the ABI-encoded string
`ipfs://QmeSjSinHpPnmXmspMjwiXyN6zS4E9zccariGR3jxcaWtq/1`. No proxy handling of any
kind was involved.

Resolution order is ERC-721 `tokenURI(uint256)`, then ERC-1155 `uri(uint256)`, then
`data:` decoding. `EthCallError` distinguishes *nothing answered us* (network problem,
try again) from *the chain gave a definitive no* (the function does not exist — trying
a **different** function is worthwhile, retrying the same one is not). That
distinction is what stops a token on a dead RPC from burning four full timeouts before
reporting a misleading "this contract has no tokenURI".

The `data:` case matters more than it looks: on-chain collections like Nouns return
base64 JSON, and Moonbirds returns `data:...;utf-8,` which is **not** base64. Both are
decoded in-process. That removes the step where a member pastes a blob into a random
online decoder — which was, incidentally, the least safe thing in the whole manual
procedure.

---

## 4. Directory link ordering must be canonical

A UnixFS directory is a dag-pb node whose `Links` are encoded **in array order**. The
directory's CID is the hash of those encoded bytes. Therefore:

> two directories with identical contents but different link order have different
> CIDs.

Kubo — and therefore IPFS Desktop, and therefore every backup the DAO has ever made by
hand, and every gateway you would use to check one — sorts links by the **raw UTF-8
bytes of the link name**, using Go's bytewise string comparison. If we appended links
in arrival order (metadata, then image, then animation, as the archiver happens to
fetch them), our folder CIDs would diverge from the reference implementation. The
files would be identical and the fingerprints would not match, which is the worst
possible failure mode for an app whose entire product is a fingerprint.

`src/main/ipfs/dag.ts` therefore sorts explicitly in `compareLinks()`: bytewise over
the UTF-8 encoding, shorter-is-smaller on a common prefix. `@ipld/dag-pb`'s `prepare()`
applies the same ordering, so this is belt and braces — but it is written out so the
intent is visible, and so `validate()` can never reject a node we built.

The second half of canonicality is **`Tsize`**. Every link carries the *cumulative*
size of the whole sub-DAG it points at — the sum of every block length beneath it,
including the linked block itself. It is part of the encoded link, so getting it wrong
changes the CID just as surely as misordering does. `cumulativeSize()` computes it.
Note that directory nodes carry no per-child bookkeeping inside their UnixFS `Data`
field: `filesize` and `blocksizes` are file-only fields, and `ipfs-unixfs`'s
`marshal()` omits `filesize` for directories. All size bookkeeping for a directory
lives in the *parent's* link `Tsize`.

A useful property falls out of canonical sorting: **directory assembly is
order-independent**. That is what allowed `buildArchiveRoot` and `mergeExistingBackup`
to be rewritten from "add one link at a time" — which re-encodes the whole directory
node on every insertion, and is quadratic — into "plan the tree in memory, call
`buildDirectory` once per folder". Merging a backup with thousands of entries went
from hanging past 600 s to assembling 400 token folders in about a second, with
identical CIDs. If you touch this, that identity is the thing to test.

Related: `buildProvenance()` is a **pure function of the token**. It uses
`token.archivedAt`, never a live clock. This is deliberate and load-bearing — it is
what lets `buildArchiveRoot` rebuild every token folder from the manifest and get the
same CID every time. Do not add a timestamp to it.

---

## 5. Verified findings

These were checked against the live network. They are the evidence the design rests
on; re-check them if something stops behaving.

**Trustless CAR retrieval works, on multiple independent gateways.**
`GET {gateway}/ipfs/{cid}?format=car&dag-scope=block` with
`Accept: application/vnd.ipld.car` returns `200` with
`Content-Type: application/vnd.ipld.car; version=1; order=dfs; dups=n` from
`trustless-gateway.link`, `ipfs.io` and `dweb.link`. This is what makes section 1
possible rather than theoretical.

**Gateways cannot convert dag-pb to dag-json.** `?format=dag-json` on a UnixFS
directory returns an error instructing the client to fetch `?format=raw` and decode
locally. Hence the client-side dag-pb decoding.

**`eth_call` works on public endpoints and sees through proxies.**
`https://ethereum-rpc.publicnode.com` and `https://cloudflare-eth.com` both answer;
`tokenURI(uint256)` on a live ERC-721 returned
`ipfs://QmeSjSinHpPnmXmspMjwiXyN6zS4E9zccariGR3jxcaWtq/1` with no "Read as Proxy"
equivalent step.

**Delegated routing gives a usable liveness signal.**
`https://delegated-ipfs.dev/routing/v1/providers/{cid}` returns `{"Providers":[…]}`
for live content and `{"Providers":[]}` for content that has fallen off the network.
An empty provider list is the strongest available evidence that every copy is gone.

**The DAO's own October 2025 backup is unreachable — but the content is not lost.**
`bafybeidgu3wl7p6lggejzxcvzcbnwrbcatbgktcvk6aqfe3ficuhxwilym` returns `504` from every
gateway tried and has **zero providers announced**. The CIDv0 form
(`QmVFMvY5nPaBtWwak98Xxs69QJWswucBH8rYokwKdFoB6i`) behaves identically, as it must —
same multihash, same DHT key.

The resolution, learned after the app was built: **the DAO stopped relying on the IPFS
network to hold its backups.** As of May 2026 the maintainer keeps `.tar` and `.car`
files in a Google Drive folder instead. So the unreachable CID reflects nobody pinning
that content any more, not data loss — the `.car` in Drive still carries the block-level
hash data needed to restore those exact CIDs to IPFS.

Two things follow, and they shape the app:

1. **`importCar` matters more than `mergeExisting`.** Restoring from a `.car` on disk is
   the live path; merging an older backup by CID only works while somebody is actively
   serving that CID. The Add-NFTs screen says so rather than inviting a doomed paste.
2. **"Backed up" and "available" are different properties.** A `.car` in Drive protects
   the bytes, but every CID in it stays unreachable on IPFS until someone re-adds and
   pins it. Health checks report availability, so an archive can be perfectly safe and
   still show every row red. That is not a bug, and the wording says so.

Closing that gap is what section 6 is about. It is also why a pinning service alone
cannot do it: re-adding has to happen on a machine that holds the bytes.

This is still the case the failure paths are tuned against. The
app warns within a few seconds (the routing lookup runs *concurrently* with the
download attempt, so the member is not left staring at nothing for a minute) and fails
with the full explanation at around 68 s, naming each gateway and what it said, and
telling the member to ask whether anyone can re-pin the files or send a `.car`.

**Live end-to-end behaviour, for calibration.** BAYC #1 (IPFS directory metadata +
IPFS image) archives in under a second with both CIDs preserved. Nouns #1 (base64
on-chain JSON and SVG) and Moonbirds #1 (non-base64 `data:`) both decode. Cool Cats #1
has `https` metadata whose image is an `https://ipfs.io/ipfs/Qm…` URL — recognised as
IPFS and stored under its **original** CID rather than re-hashed. A `.car` export,
re-imported into a fresh archive, reproduces the identical root CID.

**The rescue path provably works.** With every trustless gateway forced dead, a file
addressed as `ipfs://<cid>` was re-downloaded from a plain gateway and
`reconstructCid` reproduced the original CID exactly. A file addressed as
`<dir>/1` is honestly marked `cidPreserved: false` with a note that the folder listing
was unavailable — *unless* the directory block is already in the local blockstore from
an earlier archive or merge, in which case the exact CID is resolved with zero network
calls and then proven.

---

## 6. Pinning: why Kubo is load-bearing and `pinByHash` alone is not

Full treatment in [`PINNING.md`](PINNING.md). The part that belongs here is the
decision, and the measurement that forced it.

### The measurement

The May-2026 backup (1.8 GB, 10,762 unique CIDs) was swept with this app's own
`checkMany`: **10,270 healthy, 64 at risk, 428 unreachable.** The 428 are 189 folders
and 239 files, and they are not a random sample of the archive:

| Population | Dead | Total | Rate |
| --- | ---: | ---: | ---: |
| Arweave-sourced assets BIC saved to IPFS | 55 | 57 | 96.5% |
| Web2-sourced assets BIC saved to IPFS | 39 | 44 | 88.6% |
| Native IPFS content others also pin | 151 | 20,707 | 0.7% |

(Counted per archive entry, so the three do not sum to 428 unique CIDs.) Twelve NFTs
have lost every file. The survival rate correlates with exactly one variable: whether
anybody other than BIC had a reason to pin it. **The content this app rescues is, by
construction, the content nobody else pins.**

### Why pin-by-CID cannot fix it

`POST /pinning/pinByHash` is a *retrieval* request: it hands Pinata a CID and asks it
to find the content on the network. For the 428 there is nothing to find, so the job
ends `expired` no matter how many times it is retried. A pinning service cannot read
your disk, and the `.car` on your disk is the only remaining copy.

This is the trap for a future maintainer. A pinning implementation built on
`pinByHash` alone passes every test you would think to write — because tests use live
CIDs — and fails on precisely the 4% the feature exists for.

### The sequence

1. `POST /api/v0/dag/import` (multipart) into a local Kubo node. Blocks land under
   their **original** CIDs — nothing is re-chunked or re-hashed — so the node becomes a
   real provider for them and starts announcing.
2. `POST /api/v0/id` for the node's multiaddrs, filtered to what a stranger could
   dial (`selectDialableAddrs` in `kubo.ts`: loopback always dropped; private ranges
   dropped unless they are all there is, in which case they are kept *with a note*
   that a cloud service will not reach them).
3. `POST /pinning/pinByHash` with `pinataOptions.hostNodes` set to those multiaddrs.
   That turns "search for this" into "fetch it from here". `hostNodes` is the
   mechanism, not a tuning knob.
4. Verify. `data/pinList?status=pinned` is the authority on whether a pin landed;
   `pinning/pinJobs` is used to learn *why* one has not. With ≤50 jobs outstanding
   each is queried individually every round, because that is how `expired` surfaces in
   seconds rather than at the end of the wait. A job that disappears from the queue
   without appearing in the pin list stays `queued` — never promoted to `pinned` on a
   silence.

### Consequences that are easy to get wrong

- **`dag/import` pins the roots recursively.** So a naive per-CID loop after the
  import reports every CID as *already pinned* — telling a member "5 skipped, 0
  pinned" on the very run that rescued their archive. `runKubo` snapshots the pin set
  *before* the import and diffs, so newly covered CIDs read as `pinned`.
- **A CID is `pinned` only when every enabled target holds it.** Kubo-pinned +
  Pinata-failed is `failed`, with the reason attached. Half a backup is the situation
  this app exists to end.
- **Pinata's pin list only ever returns the spelling the pin was created with.** Kubo's
  `pin/ls` normalises v0/v1; Pinata does not. Every set lookup goes through `hasCid`,
  which tries all spellings, or a 2023 `Qm…` pin recorded in a new archive as `bafy…`
  is re-pinned on every run *and* reported as unpinned.
- **The scratch CAR is written inside the archive folder, not `os.tmpdir()`.** `/tmp`
  is a tmpfs on many Linux distributions, and streaming 1.8 GB through RAM takes the
  machine down. `tmpdir()` remains a fallback for read-only media.
- **With no dialable node, candidate CIDs get a routing lookup first** and only the
  ones somebody still announces are sent to Pinata. Deliberately not a gateway probe:
  a cache hit means a browser can load it, not that anyone announces it, so it cannot
  help Pinata find anything. It is also the faster path.
- **Never enumerate an archive by walking the blockstore.** A blockstore is keyed by
  multihash, so `getAll()` returns every block as a *raw* CID and dag-pb folders come
  back under the wrong codec. Walk the DAG (`buildAssetRows`) instead.

### The token

The Pinata JWT is a bearer credential and is treated as one: `safeStorage` only,
never in `manifest.json`, the archive, a `.car`, a settings file or this repo; never
across IPC (only `hasToken: boolean` goes to the renderer); never logged; and redacted
from any error text — including Pinata's own echoed error bodies — *before* that text
reaches the IPC sanitiser, so a leak cannot ride out through a log line. If
`safeStorage` is unavailable the app says so and offers no plaintext fallback.

### Not wired up

`pinOnImport` persists and defaults to `true`, but `archive:addTokens` does not yet
start a pin run when it finishes; pinning is currently the explicit **Assets ▸ Pin
everything** action. Wiring it means calling `pinArchive` after the manifest save,
inside the same `withArchiveLock`.

---

## 7. Things that will bite you

- **Never let a network call be unbounded.** Every one has a deadline and a finite
  number of attempts, and the whole app's credibility rests on failing fast and
  clearly on dead content. `CAR_TIMEOUT_MS`, `FETCH_TIMEOUT_MS` and
  `ROUTING_TIMEOUT_MS` are the knobs; adding a call that ignores them reintroduces the
  hang.
- **Health checking must never throw.** `src/main/health/check.ts` is failure-tolerant
  by design — the app exists because content dies quietly, so the checker must not die
  quietly with it.
- **Progress must invalidate the root CID.** The engine persists each token as it
  lands. If a run is cancelled and the assembled `rootCid` is left in place, the
  manifest describes a set of files the root does not cover, and a member can export a
  `.car` whose fingerprint silently omits what they just archived. Invalidation
  happens in a `finally`, on every path out. Keep it there.
- **Asset failures must not throw; fatal failures must.** A broken image sets
  `status: 'partial'` and costs the member nothing else. An unreadable contract throws
  an `ArchiverError` whose message is safe to show verbatim, carrying a `.partial`
  token with whatever was learned.
- **Error text is a feature.** Messages from the engine are displayed to a
  non-technical member as-is. The IPC layer sanitises them, and that sanitiser has
  already eaten the flagship dead-backup diagnostic once by truncating it. If you add
  length limits, test them against that 770-character message.
- **A pin is only as live as the daemon.** Kubo pins serve nobody while `ipfs daemon`
  is stopped or the machine is asleep. Pairing the node with Pinata is not belt and
  braces — the node is what makes dead content fetchable at all, and Pinata is what
  keeps it fetchable at 3 a.m.
- **Never claim a pin you have not seen.** "Pinata accepted the request" and "Pinata
  holds the content" are different claims and only the second one is a backup. Any new
  target must verify by reading back, not by trusting a 200.
- **The renderer must stay inert.** If you find yourself importing `node:` anything,
  `electron`, an IPFS package, or `src/main/*` into a component, the build will stop
  you by name. That guard is not in the way — it is the security boundary.
