# Pinning: putting the archive back on IPFS, and keeping it there

A `.car` file protects the *bytes*. It does not make a content ID *resolvable*.
Those are two different properties, and the gap between them is where this DAO
has already lost content.

This document explains what was measured, why the obvious fix does not work, what
does work and why, and how to set both halves of it up.

- Members who just want the steps: [`FOR-MEMBERS.md`](FOR-MEMBERS.md) §8.
- Everything else about the engine: [`HOW-IT-WORKS.md`](HOW-IT-WORKS.md).

---

## 1. What the DAO's own backup measured

In May 2026 the maintainer's 1.8 GB `.car` backup was run through this app's own
tooling — every content ID in it checked against delegated routing and against
live gateways. **10,762 unique content IDs.**

| Verdict | Count | Share | Meaning |
| --- | ---: | ---: | --- |
| Healthy | 10,270 | 95.4% | Somebody announces it and a gateway will serve it |
| At risk | 64 | 0.6% | A gateway still has it cached, but nobody announces holding it |
| **Unreachable** | **428** | **4.0%** | Nobody has it, nobody will serve it |

428 out of 10,762 sounds survivable until you look at *which* 428. They are
189 folders and 239 files, and they are not a random sample:

| Where the content came from | Dead | Total | Rate |
| --- | ---: | ---: | ---: |
| Arweave assets that BIC saved to IPFS | 55 | 57 | **96.5%** |
| Web2 assets that BIC saved to IPFS | 39 | 44 | **88.6%** |
| Native IPFS content other people also pin | 151 | 20,707 | **0.7%** |

(Those three populations are counted per archive entry — one image referenced by
several NFTs is counted once per NFT — so they do not add up to the 428 unique
CIDs above. The *rates* are what matter, and the rates differ by two orders of
magnitude.)

**Twelve NFTs are fully dark.** Not degraded — every single file gone from the
public network. They exist only inside that one `.car` file, in one Google Drive
folder, on one person's account.

### The conclusion, stated plainly

> Content that nobody pins dies. And the content BIC rescues — assets pulled off
> Arweave or off ordinary websites and saved to IPFS so they would survive — is
> precisely the content that nobody else has any reason to pin.

Native IPFS content in this archive is 99.3% alive because strangers are keeping
it: the collection's own pinning service, other collectors, gateway caches that
keep getting refreshed. Nobody is doing that for the file BIC pulled out of a
dying Arweave gateway in 2023. BIC was the only pinner, BIC's pin lapsed, and the
file stopped answering. No alarm went off. Nobody noticed for two years.

That is the entire reason this half of the app exists, and it is why
`pinOnImport` defaults to **on** in `src/shared/pinning.ts`.

---

## 2. Why pin-by-CID cannot rescue dead content

The instinct is: we have a Pinata account, Pinata has a pin-by-CID endpoint, so
paste the 428 dead CIDs into it and the problem is solved.

It does not work, and it is worth being precise about why.

`POST https://api.pinata.cloud/pinning/pinByHash` does not accept content. It
accepts a *content ID* and a promise to go looking for it:

```
you → Pinata:  "pin bafybeigd…"
Pinata → DHT:  "who has bafybeigd…?"
DHT   → Pinata: (nothing)
Pinata → you:  job status: expired
```

Pin-by-CID is a **retrieval** request. It asks Pinata to find the content
somewhere on the network and copy it. For a healthy CID that is exactly right,
and it is why the 10,270 healthy CIDs in the archive can be pinned in bulk with
nothing but a Pinata key.

For a dead CID there is nothing to find. Every copy that ever announced itself is
gone; that is the definition of the verdict. Pinata searches, fails, and after a
while marks the job `expired` — which the app translates into:

> Pinata could not find this content anywhere on the network. Start your own IPFS
> node and import the backup so Pinata has somewhere to fetch it from.

The `.car` file on your disk has the bytes. Pinata cannot see your disk. Nothing
connects the two until you make your computer a *provider* for those CIDs.

**This is the single most important thing in this document.** Every design
decision below follows from it. A future maintainer who "simplifies" the pinning
path down to `pinByHash` alone will produce something that works perfectly on the
95% that never needed help and fails silently on the 4% that is the whole point.

---

## 3. The sequence that does work

```
┌─ 1 ─────────────────────────────────────────────────────────────────────┐
│  POST http://127.0.0.1:5001/api/v0/dag/import                           │
│  multipart/form-data: the .car file      →  your Kubo node now HOLDS    │
│  ?pin-roots=true&stats=true                 every block, under the      │
│                                             ORIGINAL CIDs, and          │
│                                             announces itself as a       │
│                                             provider for them           │
└─────────────────────────────────────────────────────────────────────────┘
                                   ↓
┌─ 2 ─────────────────────────────────────────────────────────────────────┐
│  POST http://127.0.0.1:5001/api/v0/id                                   │
│  →  { ID: "12D3Koo…", Addresses: [ "/ip4/…/tcp/4001/p2p/12D3Koo…", … ] }│
│     Keep only what a stranger could dial: loopback dropped, private     │
│     ranges dropped unless they are all there is.                        │
└─────────────────────────────────────────────────────────────────────────┘
                                   ↓
┌─ 3 ─────────────────────────────────────────────────────────────────────┐
│  POST https://api.pinata.cloud/pinning/pinByHash                        │
│  Authorization: Bearer <JWT>                                            │
│  { "hashToPin": "bafybeigd…",                                           │
│    "pinataOptions": { "hostNodes": [ "/ip4/…/tcp/4001/p2p/12D3Koo…" ] } │
│  }                                          →  Pinata dials YOUR node   │
│                                                and fetches from it      │
└─────────────────────────────────────────────────────────────────────────┘
                                   ↓
┌─ 4 ─────────────────────────────────────────────────────────────────────┐
│  GET  …/pinning/pinJobs?ipfs_pin_hash=…    (why it has not landed)      │
│  GET  …/data/pinList?status=pinned&…       (whether it HAS landed)      │
│  Poll until it is in the pin list. "Accepted" is not "pinned".          │
└─────────────────────────────────────────────────────────────────────────┘
```

### Step 1 — import into Kubo

`dag/import` takes the CAR as `multipart/form-data` and adds every block to the
node's blockstore **under its existing CID**. Nothing is re-hashed, re-chunked or
re-encoded, so the CIDs on chain still point at exactly this content. With
`pin-roots=true` the roots are pinned recursively, which means the whole tree
under them survives a `repo gc`.

Once that is done and the daemon is running, your machine is a genuine provider:
it announces those CIDs to the DHT and will serve the blocks to anyone who asks —
Pinata, a gateway, another member.

`src/main/pinning/kubo.ts` streams the file over `node:http` rather than buffering
it, so a 1.8 GB backup does not have to fit in memory.

### Step 2 — read the node's dialable addresses

`POST /api/v0/id` returns the peer ID and every multiaddr the node has announced.
Not all of them are useful to hand to a cloud service:

- `/ip4/127.0.0.1/…` — **always dropped.** Handing Pinata `127.0.0.1` points
  Pinata at Pinata's own machine.
- `/ip4/192.168.…`, `/ip4/10.…`, `/ip4/100.64–127.…`, link-local, ULA — private.
  Dropped when there is anything public; **kept, with a warning, when they are
  all that exists**, because they are still useful to a peer on your own network.
- Public addresses are sorted direct-before-relayed, QUIC before TCP, IPv4 first,
  and the peer ID is appended if the node left it off.

If nothing dialable survives, the app says so in words rather than sending Pinata
a request that is guaranteed to fail — see [Troubleshooting](#6-troubleshooting).

### Step 3 — pin by CID *with* `hostNodes`

`pinataOptions.hostNodes` is a list of multiaddrs Pinata will connect to directly
before falling back to searching the network. That is what turns pin-by-CID's
default "go and find this somewhere" into "fetch it from here". **`hostNodes` is
not a tuning knob; it is the mechanism.** Without it, a dead CID cannot be
rescued through this endpoint at all.

Pinata answers with a *request id*, not a pin. The app records that as state
`pinning`, never `pinned`.

### Step 4 — verify, do not trust

"Pinata accepted the request" and "Pinata has the content" are different claims,
and only the second one is a backup. So:

- **`pinList?status=pinned`** is the authority on whether something is pinned.
- **`pinJobs`** is used to learn *why* something has not arrived. With 50 or
  fewer jobs outstanding the app asks about each one individually every round,
  because that is how the `expired` verdict — the most informative failure in the
  whole app — surfaces in seconds instead of at the end of a ten-minute wait.

Polling is 5 s, 10 s, 20 s, 30 s, 30 s, then every minute, up to ten minutes by
default. A job that vanishes from the queue without appearing in the pin list
stays `queued`. It is never upgraded to `pinned` on the strength of a silence.

### What happens when there is no node

Pinata alone is still worth having: it covers the 95% that is alive, and it keeps
that content available when your computer is off. So the app does not refuse to
run — but it does not lie about the rest either.

With no dialable `hostNodes`, every candidate CID gets one delegated-routing
provider lookup first, and only the ones somebody is still announcing are sent to
Pinata. The rest are reported as failed with the reason, in words:

> Nobody on the network is sharing this any more, so Pinata has nothing to fetch.
> It can only be brought back by importing the backup into an IPFS node on this
> computer first — that is what gives Pinata somewhere to get it from.

This is deliberately a routing lookup and not a gateway probe. A gateway cache
hit tells you a browser could load the file; it does not mean anybody is
*announcing* it, so it cannot help Pinata find anything. The lookup also makes
the run *faster*: skipping thousands of doomed `pinByHash` calls costs far less
than the lookups.

---

## 4. Setting up Kubo (your own IPFS node)

Kubo is the reference IPFS implementation. It is one binary, it needs no account,
and it costs nothing. The app talks to it over its local HTTP RPC and never
touches your repo except to import blocks and add pins.

### macOS

```sh
brew install kubo   # installs the `ipfs` command
ipfs init           # creates ~/.ipfs — once, ever, on this machine
ipfs daemon         # starts the node; leave this window open
```

`brew install kubo` currently gives 0.42.0; anything from 0.20 upward is fine.

### Windows and Linux

Download the binary from <https://docs.ipfs.tech/install/command-line/>, put it
on your `PATH`, then run the same `ipfs init` and `ipfs daemon`.

### What each command actually does

- **`ipfs init`** creates the repository at `~/.ipfs` and generates the node's
  identity — its peer ID and private key. Run once. Running it again on an
  initialised repo does nothing.
- **`ipfs daemon`** is the node. It opens the local RPC on **127.0.0.1:5001**
  (what this app talks to), a local gateway on 8080, and the peer-to-peer swarm
  port **4001**. It connects to the DHT, announces what it is pinning, and serves
  blocks to whoever asks.

**The daemon must be running for any of this to mean anything.** A pinned CID on
a stopped node is served to nobody — it is a `.car` file with extra steps. Close
the terminal window and you are back to where the DAO was in 2024. If the machine
is going to sleep, the content is unreachable for as long as it sleeps.

Leaving a terminal open forever is a poor plan, which is the honest argument for
pairing it with Pinata: the node is what *rescues* the content, Pinata is what
*keeps it up* when your laptop is shut.

### In the app

**Settings ▸ Your own IPFS node.** The address defaults to
`http://127.0.0.1:5001` and should not need changing. When the node answers, the
screen shows its peer ID and the addresses it offered — those are the exact
strings handed to Pinata as `hostNodes`.

### Three practical points

- **Disk.** The node keeps its own copy of the blocks, so importing a 1.8 GB
  backup costs about 1.8 GB in `~/.ipfs` on top of the archive folder. `ipfs repo
  stat` shows the total.
- **`ipfs repo gc` deletes everything unpinned.** Anything imported with
  `pin-roots=true`, or pinned afterwards, survives. Anything else does not. The
  app never runs `gc` for you.
- **Inbound port 4001.** Pinata can only fetch from your node if it can reach it.
  On most home connections this works via NAT hole-punching; behind a corporate
  or university firewall it usually does not. See
  [Troubleshooting](#6-troubleshooting).

---

## 5. Setting up Pinata

Pinata is a commercial pinning service: it holds content on IPFS for you, on
machines that do not go to sleep. The DAO signs up itself; this app never touches
an account or a payment.

1. Sign in at <https://app.pinata.cloud>.
2. Go to **API Keys**
   (<https://app.pinata.cloud/developers/api-keys>), create a key, and copy the
   long **JWT** value. It is shown once.
3. In the app: **Settings ▸ Pinata ▸ Keep a copy with Pinata as well**, paste the
   JWT, **Save key**. The app immediately calls
   `data/testAuthentication` and tells you whether it worked.

### Where the key lives, and where it does not

The JWT is a bearer credential: anyone holding it can pin, unpin and read the
account. So:

- It is stored **only** through Electron `safeStorage`, which is backed by the OS
  keychain (Keychain on macOS, DPAPI on Windows, libsecret on Linux).
- It is **never** written into `manifest.json`, into the archive, into a `.car`,
  into a settings JSON, or into this repository — including tests and fixtures.
- It **never crosses IPC to the renderer.** The window only ever learns
  `hasToken: boolean`. The input box is uncontrolled: the value is read from the
  DOM once on submit, handed to the main process, and the field is wiped
  immediately, whether it saved or not.
- The app **cannot read it back.** It can only ask the operating system to use it
  or to forget it. "Remove" in Settings clears the keychain entry.
- It is never logged, and anything token-shaped is redacted from error text
  *before* that text reaches the GUI — including error bodies Pinata itself echoes
  back.

If secure storage is unavailable, the app says so and offers no plaintext
fallback. That is deliberate.

### Optional: a dedicated gateway

If your Pinata plan includes a dedicated gateway
(`https://yourname.mypinata.cloud`), put it in Settings. It is used for
retrieval only and is never required.

---

## 6. Troubleshooting

### "Pinata could not find this content anywhere on the network" — job `expired`

**What it means.** Pinata searched, and nothing on the public network is offering
that content. This is not a Pinata fault and retrying will not help — it is
[section 2](#2-why-pin-by-cid-cannot-rescue-dead-content) happening to you.

**What to do.** Start your own node, import the backup into it, and pin again:

```sh
ipfs daemon                 # in its own terminal window, leave it running
```

then in the app, **Settings** → switch on your own IPFS node, then
**Assets ▸ Pin everything**. The app exports a `.car` if it needs one, imports it
into the node, and re-asks Pinata with `hostNodes` pointing at you. Manually, the
same thing is:

```sh
ipfs dag import /path/to/BIC-backup.car
```

### "Your IPFS node is only reachable on your local network"

**What it means.** Step 2 found no public multiaddrs — only `192.168.x.x` or
similar. Pinata is on the internet and cannot dial a private address, so it
cannot fetch from you. Your own copy is still fine, and pinning locally still
works; what fails is the hand-off.

**What to do, in order of effort:**

1. **Wait a minute and check again.** A daemon that has just started has often not
   learned its public address yet.
2. **Let it hole-punch.** Kubo's AutoNAT and relay usually get a home connection
   dialable within a couple of minutes. Corporate, university and guest networks
   usually block it outright.
3. **Forward TCP and UDP 4001** to this machine on your router, if you control it.
4. **Move the archive.** Run the import on a machine that is reachable — a VPS,
   or another member's connection — and pin from there.

### "Your IPFS node is only listening on this computer"

Only loopback was announced, so nothing outside the machine can reach it at all.
Usually the daemon is running in offline mode (`ipfs daemon --offline`) or is
still starting. Restart it without `--offline`.

### "Your IPFS node is running but has not announced any network addresses yet"

Give it a minute after starting and check again.

### "No node answered at that address"

Nothing is listening on `127.0.0.1:5001`. Either the daemon is not running (the
`ipfs daemon` window was closed, or the machine slept), or it is on a different
port. Start it; the app re-checks whenever you open Settings.

### Pinata says the key is not valid

The JWT was mistyped, truncated, or revoked in the Pinata dashboard. Create a new
key and paste the whole **JWT** value — not the API key or the API secret, which
are different, shorter strings.

### "Your Pinata account has used up its free storage allowance"

Exactly what it says. The 1.8 GB backup does not fit in a small free tier. Free
up space in the Pinata dashboard or move to a paid plan, then run the pin again —
already-pinned items are skipped, so nothing is repeated.

### A job sits at "Pinata has queued this and is fetching it"

Pinata is fetching over IPFS from your node; a large file over a home upload link
is genuinely minutes of work. The app waits ten minutes by default and then
reports honestly that the job is still queued rather than claiming success. Run
the pin again later — anything that landed in the meantime is reported as already
pinned and costs nothing.

### Everything reports "skipped"

That means it was already pinned. Note that `dag/import` pins the roots
recursively, so on the run that *rescued* an archive the app compares the node's
pin set from before the import with the one after, and reports newly covered CIDs
as pinned rather than skipped. A second run over the same archive legitimately
reports all-skipped.

---

## 7. Storacha is gone — a correction

Earlier versions of these docs and of the Export screen pointed members at
**Storacha** (formerly web3.storage) as a place to upload a `.car` file.

**That advice is now wrong and must not be repeated.** As of August 2026:

- `up.storacha.network`, `console.storacha.network` and `access.storacha.network`
  have **no DNS records at all** — not an outage, no records.
- `storacha.network` redirects to `fil.one`.

Anything that tells a member to upload a `.car` to Storacha will send them to a
dead end at the exact moment they are trying to save content. The replacements
are the two destinations documented above:

- **Your own Kubo node** — no account, no payment, and the only thing that can
  bring dead CIDs back at all.
- **Pinata** — for keeping content up when your machine is not.

There is a lesson in this beyond a broken link. The DAO's content did not survive
because a service promised to keep it; it survived where *several unrelated
people* happened to keep it. Treat any single pinning service, including Pinata,
as one copy among several — and keep the `.car` file in Drive regardless.

---

## 8. What is not wired up yet

Honest gaps, so nobody documents a promise the code does not keep:

- **"Pin new content automatically" is stored but not yet acted on.** The
  `pinOnImport` setting persists correctly and defaults to on, but
  `archive:addTokens` does not start a pin run when it finishes. Until it does,
  pinning is the explicit **Assets ▸ Pin everything** step. Wiring it means
  calling `pinArchive` after the manifest is saved, inside the same archive lock.
- **A pin run cannot be cancelled during the CAR pack.** `exportCar` deliberately
  swallows throws from its progress callback, so there is no way to interrupt it.
  The signal is checked either side, so a member who presses Stop during a 1.8 GB
  pack waits for the pack to finish and then stops.
- **Kubo pins only serve while the daemon runs.** There is no "install as a
  service" step in the app, and no supervision. Closing the terminal stops the
  node.

---

## 9. Where this lives in the code

| Path | Role |
| --- | --- |
| `src/shared/pinning.ts` | The fixed contract: `PinState`, `PinTargetStatus`, `AssetRow`, `PinRunSummary`, `PinningSettings`, `KUBO_RPC`, `PINATA`. Read the header comment first. |
| `src/main/pinning/kubo.ts` | `detectKubo`, `importCarToKubo`, `pinCid`, `listPins`. Streams the CAR; classifies multiaddrs. |
| `src/main/pinning/pinata.ts` | `testPinataAuth`, `pinByCid`, `pinJobResult`, `listPinnedCids`. Every returned string is redacted. |
| `src/main/pinning/manager.ts` | `getTargets`, `pinAll`, `pinArchive` — the four-step sequence, progress, verification, summaries. |
| `src/main/pinning/assets.ts` | `buildAssetRows`, `mergeHealth`, `mergePinStates`, `summarise` — one row per entry in the archive. |
| `src/main/settings.ts` | Settings on disk, plus the `safeStorage` token. |
| `src/renderer/components/AssetsView.tsx` | The Assets screen: what is in the archive, who is keeping it, what to press. |
| `src/renderer/components/PinningSettings.tsx` | Settings ▸ node and key. The key is never in React state. |
