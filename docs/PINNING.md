# Pinning: putting the archive back on IPFS, and keeping it there

A `.car` file protects the *bytes*. It does not make a content ID *resolvable*.
Those are two different properties, and the gap between them is where this DAO
has already lost content.

This document explains what was measured, why the obvious fix does not work, what
does work and why, and how to set it up.

> **What changed, in one paragraph.** Earlier versions of this page presented a
> hosted pinning service as the main route and a local node as the advanced
> option. That is now the wrong way round, and not as a matter of taste: Storacha's
> infrastructure no longer exists (NXDOMAIN — [§7](#7-storacha-is-gone--a-correction)),
> and Pinata's pin-by-CID has turned out to be a **paid-only** feature whose free
> tier could not hold this archive in any case ([§2a](#2a-and-pin-by-cid-is-now-a-paid-pinata-feature)).
> **The route is your own node, and the app installs and runs it for you** — no
> terminal, no account, no payment. Pinata is now an optional extra for people who
> have a paid plan. See [`RUNNING-A-NODE.md`](RUNNING-A-NODE.md).

- Members who just want the steps: [`FOR-MEMBERS.md`](FOR-MEMBERS.md).
- Running a node — cost, privacy, troubleshooting: [`RUNNING-A-NODE.md`](RUNNING-A-NODE.md).
- Copying BIC's whole archive: [`MIRRORING.md`](MIRRORING.md).
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

## 2a. And pin-by-CID is now a paid Pinata feature

Section 2 explains why pin-by-CID cannot rescue *dead* content. There is now a
second, blunter reason it cannot carry this archive, and it applies to the
healthy 95% too.

**Verified live against the real API:** on a free account,
`POST https://api.pinata.cloud/pinning/pinByHash` answers

```
403  { "error": { "reason": "PAID_FEATURE_ONLY",
                  "details": "You must be on a paid plan to pin by CID" } }
```

This is a fact about the **account**, not the key. The app says so in as many
words, because the instinctive response to a 403 is to go and make a new key:

> Pinata will not do this on a free account. Pinning by CID is a paid Pinata
> feature… this is a limit of the plan, not a problem with your key. Making a new
> key or changing its permissions will not help… running your own IPFS node keeps
> the archive alive just as well and costs nothing, and this app can set one up
> for you.

A genuine permissions 403 (`NO_SCOPES_FOUND`) still gets the original
check-your-key wording; the two are distinguished by the response *body*, not the
status code, because a plan limit may be reported under another code.

And even with a paid plan, the free tier's size limits were never going to work:
**1 GB and 500 files**, against an archive of **1.9 GB and 20,808 files**. Short
by a factor of two on bytes and forty on file count.

So Pinata is documented here as what it now is: a **useful optional extra for
whoever in the DAO has a paid plan**, and not the answer for members. The answer
for members is [§4](#4-your-own-node--the-app-sets-it-up-for-you).

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

## 4. Your own node — the app sets it up for you

Kubo is the reference IPFS implementation. It is one binary, it needs no account,
and it costs nothing.

**You no longer install it by hand.** Open **Settings ▸ Your own IPFS node** and
press the set-up button (or take the offer on the welcome screen). The app
downloads Kubo v0.43.0 from the official host over HTTPS, **verifies its SHA-512
before unpacking or running a single byte of it**, creates a repository in its
own folder, starts the node, checks that it actually answers, and installs a
login item so it keeps serving after you close the app.

That last part is the difference between a provider and a person who happens to
have an app open. **Leaving a terminal window open forever was never a workable
plan**, and it is why earlier versions of this document had to lean on a hosted
service to cover the hours a laptop was shut. It does not any more.

Full detail — what it costs in disk and bandwidth, what running a node reveals
about your IP address, where the files go, and how to fix the three things that
actually go wrong — is in [`RUNNING-A-NODE.md`](RUNNING-A-NODE.md).

### If you already run Kubo

The app finds it, uses it, and reports it as **external**: it will not
reconfigure it, will not change its ports, will not set it to autostart, and will
not uninstall it. Your node stays yours. `ipfs init` / `ipfs daemon` from
Homebrew, IPFS Desktop or your own build all work fine.

### Doing it by hand anyway

Nothing stops you. Install from <https://docs.ipfs.tech/install/command-line/> or
`brew install kubo`, then:

- **`ipfs init`** creates the repository at `~/.ipfs` and generates the node's
  identity — its peer ID and private key. Run once. Running it again on an
  initialised repo does nothing.
- **`ipfs daemon`** is the node. It opens the local RPC on **127.0.0.1:5001**
  (what this app talks to), a local gateway on 8080, and the peer-to-peer swarm
  port **4001**. It connects to the DHT, announces what it is pinning, and serves
  blocks to whoever asks.

**The daemon must be running for any of this to mean anything.** A pinned CID on
a stopped node is served to nobody — it is a `.car` file with extra steps. If the
machine sleeps, the content is unreachable for as long as it sleeps. This is
exactly what the managed node's login item exists to prevent.

### In the app

**Settings ▸ Your own IPFS node.** The address defaults to
`http://127.0.0.1:5001` and should not need changing — if the app had to move the
port because something else held it, it fills the new one in and tells you. When
the node answers, the screen shows its peer ID, its storage use and the addresses
it offered.

### Three practical points

- **Disk.** The node keeps its own copy of the blocks, so importing a 1.8 GB
  backup costs about 1.8 GB in the node's repository on top of the archive
  folder. `ipfs repo stat` shows the total; the app shows it in Settings. A
  managed node keeps its repository in the app's own data folder rather than
  `~/.ipfs`, with a 20 GiB ceiling.
- **`ipfs repo gc` deletes everything unpinned.** Anything imported with
  `pin-roots=true`, or pinned afterwards, survives. Anything else does not. The
  app never runs `gc` for you.
- **Inbound port 4001.** Pinata can only fetch from your node if it can reach it.
  On most home connections this works via NAT hole-punching; behind a corporate
  or university firewall it usually does not. See
  [Troubleshooting](#6-troubleshooting).

---

## 5. Pinata — optional, and only useful on a paid plan

Pinata is a commercial pinning service: it holds content on IPFS for you, on
machines that do not go to sleep. The DAO signs up itself; this app never touches
an account or a payment.

**Read [§2a](#2a-and-pin-by-cid-is-now-a-paid-pinata-feature) first.** On a free
account, pin-by-CID returns `403 PAID_FEATURE_ONLY` and nothing below will work;
and the free tier's 1 GB / 500 files cannot hold a 1.9 GB / 20,808-file archive
even on a plan that permits it. Nobody needs a Pinata key to help BIC — the node
in [§4](#4-your-own-node--the-app-sets-it-up-for-you) does the job, for free.
This section is for whoever in the DAO has the paid account. In the app, Pinata
lives in a collapsed section of Settings for exactly that reason.

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

### "Pinata will not do this on a free account" — `403 PAID_FEATURE_ONLY`

**What it means.** Pinning by CID is a paid Pinata feature. This is a fact about
the plan, not the key: making a new key, or giving it more permissions, will not
change it. See [§2a](#2a-and-pin-by-cid-is-now-a-paid-pinata-feature).

**What to do.** Nothing, unless somebody in the DAO has a paid plan. Set up your
own node instead — the app does the whole thing, it costs nothing, and it keeps
the archive alive just as well. See
[`RUNNING-A-NODE.md`](RUNNING-A-NODE.md).

(A genuine permissions problem reports `NO_SCOPES_FOUND` and gets the
check-your-key message below instead. The two are told apart by the response
body, not the status code.)

### "Pinata could not find this content anywhere on the network" — job `expired`

**What it means.** Pinata searched, and nothing on the public network is offering
that content. This is not a Pinata fault and retrying will not help — it is
[section 2](#2-why-pin-by-cid-cannot-rescue-dead-content) happening to you.

**What to do.** Get your own node running, so there is somewhere for Pinata to
fetch from, then pin again: **Settings ▸ Your own IPFS node** (the app installs
and starts it), then **Assets ▸ Pin everything**. The app exports a `.car` if it
needs one, imports it into the node, and re-asks Pinata with `hostNodes` pointing
at you. With a node you run yourself, the same thing by hand is:

```sh
ipfs daemon                          # leave it running
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

Nothing is listening on `127.0.0.1:5001`. Either the node is not running (a
managed node that has been stopped, an `ipfs daemon` window that was closed, or a
machine that slept), or it is on a different port. Start it from Settings; the app
re-checks whenever you open that screen.

If it refuses to start with no useful error at all, suspect a leftover
`repo.lock` — a hard shutdown leaves one behind, and it blocks every subsequent
start **silently**. The app clears stale locks on its own; the manual fix and the
reason it is dangerous to do carelessly are in
[`RUNNING-A-NODE.md` §7](RUNNING-A-NODE.md#a-stale-repolock--the-one-that-silently-blocks-every-start).

### Pinata says the key is not valid

The JWT was mistyped, truncated, or revoked in the Pinata dashboard. Create a new
key and paste the whole **JWT** value — not the API key or the API secret, which
are different, shorter strings.

### "Your Pinata account has used up its free storage allowance"

Exactly what it says, and it is not a near miss: the free tier is **1 GB and 500
files**, and the archive is **1.9 GB and 20,808 files**. Free up space in the
Pinata dashboard or move to a paid plan, then run the pin again — already-pinned
items are skipped, so nothing is repeated. Or use a node, which has no such limit
and no bill.

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
dead end at the exact moment they are trying to save content. The replacement is
the destination documented above:

- **Your own Kubo node** — no account, no payment, the only thing that can bring
  dead CIDs back at all, and now installed and kept running by the app itself.
- **Pinata**, additionally, for whoever holds the DAO's paid plan.

There is a lesson in this beyond a broken link, and it is the reason the app was
rearranged around member-run nodes. **Both hosted services BIC relied on have now
failed it** — one by ceasing to exist, one by moving the feature behind a paywall
whose free tier was two-fifths of the size needed. Neither did anything wrong;
each was simply a single point of failure, and the DAO's content only ever
survived where *several unrelated people* happened to be keeping it.

So treat any single pinning service, including Pinata, as one copy among several —
keep the `.car` file in Drive regardless, and get as many members as possible
running nodes.

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
- **Kubo pins only serve while the node runs**, which is still true — but the app
  now installs a real login item (LaunchAgent / systemd user unit / Startup shim)
  with crash recovery, so a managed node comes back after a logout, a reboot or a
  crash without anybody remembering to do anything. A node you installed yourself
  is still yours to supervise. One caveat: on macOS, `KeepAlive` is set and
  accepted, but on battery power the OS may defer the respawn after a crash — see
  [`RUNNING-A-NODE.md` §7](RUNNING-A-NODE.md#macos-launchctl-load-is-deprecated-and-worse-than-deprecated).

---

## 9. Where this lives in the code

| Path | Role |
| --- | --- |
| `src/shared/pinning.ts` | The fixed contract: `PinState`, `PinTargetStatus`, `AssetRow`, `PinRunSummary`, `PinningSettings`, `KUBO_RPC`, `PINATA`. Read the header comment first. |
| `src/main/pinning/kubo.ts` | `detectKubo`, `importCarToKubo`, `pinCid`, `listPins`. Streams the CAR; classifies multiaddrs. |
| `src/main/pinning/pinata.ts` | `testPinataAuth`, `pinByCid`, `pinJobResult`, `listPinnedCids`. Every returned string is redacted. `isPlanLimitation()` matches the response *body*, so `PAID_FEATURE_ONLY` is told apart from a real permissions 403. |
| `src/main/pinning/manager.ts` | `getTargets`, `pinAll`, `pinArchive` — the four-step sequence, progress, verification, summaries. |
| `src/main/pinning/assets.ts` | `buildAssetRows`, `mergeHealth`, `mergePinStates`, `summarise` — one row per entry in the archive. |
| `src/main/settings.ts` | Settings on disk, plus the `safeStorage` token. |
| `src/main/node/` | The managed node — download and SHA-512 verification, repository, login item, lifecycle. See [`RUNNING-A-NODE.md`](RUNNING-A-NODE.md). |
| `src/renderer/components/AssetsView.tsx` | The Assets screen: what is in the archive, who is keeping it, what to press. |
| `src/renderer/components/PinningSettings.tsx` | Settings ▸ node first, Pinata in a collapsed section. The key is never in React state. |
