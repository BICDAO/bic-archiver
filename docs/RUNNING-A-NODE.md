# Running a node

**The plan is now members, not services.** This page explains why that changed,
what the app does to your computer when you press the button, exactly what it
costs you, what it reveals about you, and how to fix the three things that
actually go wrong.

- Just want the steps, in friendly language? [`FOR-MEMBERS.md`](FOR-MEMBERS.md).
- What a mirror is and how the copy is made: [`MIRRORING.md`](MIRRORING.md).
- The pinning sequence and Pinata: [`PINNING.md`](PINNING.md).

---

## 1. Why members, and not a service

### What was measured

In May 2026 BIC's own 1.8 GB `.car` backup was run through this app's checker.
Every content ID in it was asked two independent questions: *is anybody
announcing that they hold this?* and *will a public gateway actually serve it
right now?* **10,762 unique content IDs**:

| Verdict | Count | Share |
| --- | ---: | ---: |
| Healthy | 10,270 | 95.4% |
| At risk (a cache still has it, nobody announces it) | 64 | 0.6% |
| **Unreachable** | **428** | **4.0%** |

4% sounds survivable until you look at *which* 4%:

| Where the content came from | Dead | Total | Rate |
| --- | ---: | ---: | ---: |
| Arweave assets BIC rescued and saved to IPFS | 55 | 57 | **96.5%** |
| Web2 assets BIC rescued and saved to IPFS | 39 | 44 | **88.6%** |
| Native IPFS content other people also pin | 151 | 20,707 | **0.7%** |

Two orders of magnitude between those rates, and the reason is not technical.
Native IPFS content survives because strangers keep it — the collection's own
pinning service, other collectors, gateway caches that keep being refreshed.
Nobody has any reason to keep the file BIC pulled out of a dying Arweave gateway
in 2023. **BIC was the only pinner, BIC's pin lapsed, and the file stopped
answering.** No alarm went off. Nobody noticed for two years.

**Twelve NFTs are fully dark.** Not degraded — every file gone from the public
network. They exist only inside one `.car` file, in one Google Drive folder, on
one person's account.

### The honest history: two services have already failed this archive

Both of the hosted answers BIC reached for are now unavailable to it, and it is
worth being precise about how, because the failures were different and the
lesson is the same.

**Storacha (formerly web3.storage) — the infrastructure is gone.** Older versions
of these docs and of this app's Export screen told members to upload the `.car`
there. As of August 2026, `up.storacha.network`, `console.storacha.network` and
`access.storacha.network` return **NXDOMAIN** — not an outage, not a 503, no DNS
records at all — and `storacha.network` itself redirects to `fil.one`. A member
following that advice today would hit a dead end at the exact moment they were
trying to save something.

**Pinata — pin-by-CID is paid-only, and the free tier could not hold this
archive anyway.** Verified live against the real API: `POST
/pinning/pinByHash` answers **403 `PAID_FEATURE_ONLY`** on a free account. That
is a fact about the plan, not about the key; making a new key or changing its
permissions does not help. And even with pin-by-CID working, the free tier is
**1 GB and 500 files** against an archive of **1.9 GB and 20,808 files**. It does
not fit by a factor of two on bytes and a factor of forty on file count.

Neither service did anything wrong. The problem is structural: each one was a
**single point of failure**, and the DAO's content only ever survived where
*several unrelated people* happened to be keeping it.

### The conclusion

> Content that nobody pins dies. The content BIC rescues is precisely the
> content nobody else has a reason to pin. So BIC has to — and one person's
> laptop is not a plan either.

Ten members running nodes is ten independent providers. No subscription, no
account, no company that can be acquired, wound down or repriced, and no single
machine whose failure loses anything. That is the entire argument, and it only
works if a non-technical member never has to open a terminal.

Which is what the rest of this page is about.

---

## 2. What the app does for you

Press **Set up IPFS and copy the archive** on the welcome screen, or **Set up my
node** in Settings, and the app does all of this by itself. Every step streams a
plain-English progress message, and every one of them can be stopped.

1. **Works out which build you need.** Kubo — the reference IPFS program — ships
   a different artifact per platform. The app picks it from your OS and CPU
   (macOS Apple Silicon and Intel, Windows x64 and ARM, Linux x64 and ARM64) and
   never asks you.

2. **Downloads it from the official host, over HTTPS.** `https://dist.ipfs.tech/kubo`,
   pinned to **Kubo v0.43.0**, about **80 MB**. That address is fixed in the
   app's source. Nothing you type, nothing the window sends, and nothing in an
   archive can point the download somewhere else — the "install" request carries
   no URL, no version and no path, deliberately.

3. **Checks the SHA-512 before anything is unpacked or run.** Each artifact has
   its own sibling `.sha512` file on the same host. The app downloads it, parses
   the single hash out of it, hashes what it received, and compares. **A mismatch
   deletes the download and reports a failure. Unverified bytes are never
   unpacked and never executed.** This app downloads and runs a program on your
   computer; that check is the thing that makes it safe to, and it is not
   optional or skippable.

4. **Unpacks just the one file it needs.** The `ipfs` binary is read out of the
   archive to a path the app chooses, so nothing inside a downloaded archive can
   decide where files land on your disk.

5. **Creates a repository.** `ipfs init` in the app's own folder — not in
   `~/.ipfs`, so if you later install IPFS yourself the two never collide. It
   sets a 20 GiB storage ceiling (a limit, not a reservation) and picks ports
   that are actually free (see [§7](#7-troubleshooting)).

6. **Starts the node** and then *checks that it answers* before telling you
   anything worked. Installed, configured and launched is not the same as
   running, and this app does not report the first three as the fourth.

7. **Installs a login item so it keeps serving after you close the app.** This is
   the step that turns "a member who happens to have the app open" into "a
   provider". Details in [§5](#5-what-gets-installed-and-where).

8. **Then copies the archive**, if you came in through the welcome screen — the
   node and the mirror are one button, because a node with nothing in it helps
   nobody. That part is [`MIRRORING.md`](MIRRORING.md).

### It never touches a node you already have

If you already run Kubo — Homebrew, IPFS Desktop, your own build — the app
finds it, uses it, and reports it as **external**. It does not reconfigure it,
does not change its ports, does not set it to autostart and **will not uninstall
it**. The test is the repository's own peer ID compared against the one in the
repository the app created, not a port number, because anything can occupy a
port.

---

## 3. What it costs you

| | |
| --- | --- |
| **Download, once** | About **80 MB** for Kubo itself. |
| **Disk, for the program** | About 90 MB unpacked. |
| **Disk, for the archive** | About **2 GB today** (1,933,339,888 bytes across 20,808 files), and it grows as BIC archives more. The node's ceiling is set to 20 GiB so you will not have to think about it for a long time. |

> **"1.8 GB" and "1.9 GB" are the same number.** The archive is 1,933,339,888
> bytes: 1.9 GB counted in billions, 1.8 GB counted in units of 1024. The app's
> screens show 1.8; these engineering notes usually say 1.9. Nothing changed
> size between documents.
| **Upload bandwidth** | Only when somebody actually fetches something from you. There is no constant stream and no fixed rate; it is the same shape as any file-sharing program — mostly nothing, occasionally a few megabytes when a member or a gateway pulls a file. |
| **CPU / battery** | Small and steady. The node is idle almost all of the time. |
| **Money** | None. No account, no sign-up, no subscription, no card. |

If disk is tight, the honest answer is that this is not a good machine to mirror
from — say so in the DAO rather than half-doing it. A partial copy that reports
itself as a mirror is exactly the failure this whole project exists to fix.

---

## 4. Privacy, stated plainly

Running an IPFS node is peer-to-peer software, and peer-to-peer software works by
computers talking to each other directly. So:

**Peers you connect to can see your IP address.** This is not a flaw in IPFS or
in this app; it is what "connect to" means. Every peer your node exchanges data
with — another member, a gateway fetching a file, a machine you asked for a
block — sees the address the connection came from, exactly as it would with
BitTorrent, a video call, or visiting a website. If that is not acceptable on
your connection, do not run the node there.

**Whether your address is *published* depends on your router.**

- If inbound port **4001** reaches your machine (most home connections, either
  directly or via Kubo's hole-punching), your node announces its public address
  to the network's directory — the DHT — so strangers can find and dial you. Your
  IP is then discoverable by anyone who looks up content you provide.
- If it does not (many corporate, university and guest networks, and some home
  routers), your node reaches the network through **relays**: other computers
  that pass traffic on its behalf. In that case the addresses it announces are
  the *relays'*, and **your own IP is not published in the DHT**.

**Do not read too much into that second case.** Relay-only is not anonymity. Your
node still makes outbound connections, and every peer on the other end of one —
including the relay operators themselves — sees your IP. It means your address is
not *listed in a public directory*; it does not mean it is hidden from the people
you are talking to. If you want your traffic actually concealed, an IPFS node is
the wrong tool and you should not rely on this app to provide it.

**What else a node reveals.** A node announces *what it holds*, so somebody
watching the network can learn that your computer is providing BIC's archive.
That content is public by design — it is a DAO archive meant to be fetched — but
it is worth knowing that "I am serving this" is a public statement, not a private
one. Your node holds only the archive; it does not read, index or announce
anything else on your disk.

**What the app does not do.** It creates no account, collects no telemetry, and
sends nothing about you anywhere. The only credential in the whole app is an
optional Pinata key, which lives in your operating system's keychain, never
crosses into the app's window, and is never written to disk in the clear or into
any backup.

The app tells you which of these two situations you are in: Settings shows the
node's addresses, and says so in words when every one of them is a relay
address.

---

## 5. What gets installed, and where

Everything lives inside the app's own per-user folder. Nothing needs
administrator rights, nothing is written to a system location, and nothing goes
in `~/.ipfs`.

```
<app data folder>/ipfs-node/
  bin/ipfs            the Kubo binary (ipfs.exe on Windows)
  repo/               the node's repository: its identity, config and blocks
  installed.json      the app's record that this install is its own
```

The app data folder is:

| | |
| --- | --- |
| macOS | `~/Library/Application Support/BIC Archiver` |
| Windows | `%APPDATA%\BIC Archiver` |
| Linux | `~/.config/BIC Archiver` |

Ports: the local control port is **5001** and the local gateway is **8080**,
unless something else already has them, in which case the app scans upward for a
free one and tells you which it moved to. The peer-to-peer port is **4001** — the
only one that has anything to do with the outside world.

### The login item

So the node outlives the app's window, a real login item is installed per
platform:

| | |
| --- | --- |
| **macOS** | A LaunchAgent at `~/Library/LaunchAgents/art.bureauofinternetculture.archiver.ipfs.plist`, loaded with `launchctl bootstrap gui/$UID` and started with `launchctl kickstart -k`. |
| **Linux** | A systemd **user** unit at `~/.config/systemd/user/art.bureauofinternetculture.archiver.ipfs.service` with `Restart=always`, falling back to an XDG autostart entry where user systemd is not available. |
| **Windows** | A `.cmd` shim in your own Startup folder. |

Two properties are deliberate. **No administrator rights, ever** — everything is
in your home directory and talks only to per-user service managers, so nobody is
asked for a password to keep a backup alive. And **crashes are recovered**: the
macOS plist sets `KeepAlive`, and the systemd unit sets `Restart=always`.
Homebrew's own kubo LaunchAgent sets `RunAtLoad` but *not* `KeepAlive`, so a
crashed daemon there stays dead until somebody notices — which, for an archive
whose entire failure mode is "nobody noticed", is precisely the wrong behaviour.

In the GUI the login item is the **Keep running when I close the app** switch in
Settings. Turning it off, or uninstalling the node, removes it. **Turning it off
is allowed even with no node installed**, which is how a leftover login item from
a removed node gets cleaned up.

### Uninstalling

**Settings ▸ Remove the node program** deletes the binary, the login item and the
app's install record. **It keeps the repository by default** — that folder is your copy
of the archive, and "remove the program" and "delete 1.9 GB of rescued NFTs" are
different requests that do not belong behind the same button. Delete
`<app data folder>/ipfs-node/repo` by hand if you genuinely want the space back.

---

## 6. Already have a node? Nothing to do

If Kubo is already running on `127.0.0.1:5001`, the app finds it, uses it for
mirroring and pinning, and shows it as a node it does not manage. You keep
control of it: your ports, your config, your `ipfs daemon` (or your Homebrew
service), your decision about when it runs. The app will refuse to stop it,
reconfigure it, set it to autostart, or uninstall it, and says so rather than
silently doing nothing.

The one thing worth knowing: `ipfs repo gc` deletes everything that is not
pinned. Content imported with pinned roots survives it. The app never runs `gc`
for you.

---

## 7. Troubleshooting

### A stale `repo.lock` — the one that silently blocks every start

**Symptom.** The node will not start. There is no useful error, nothing in the
log, and nothing visibly wrong. Starting it again does the same thing.

**Cause.** Kubo writes `repo.lock` inside its repository while the daemon runs
and removes it on a clean exit. If the process was killed hard — `SIGKILL`, a
crash, a forced shutdown, a battery dying — the file survives. Every subsequent
start then refuses to open the repository, and **it logs nothing about why**. This
cost an hour of somebody's life during development and it is by far the most
likely thing to go wrong on a member's machine.

**What the app does.** Every start clears a genuinely stale lock first, and it is
careful about "genuinely":

- If a daemon *answers* on the repository's API address, the lock is real and is
  left alone. Deleting a live daemon's lock lets a second daemon open the same
  datastore and corrupt it.
- A lock touched moments ago is left alone too — it may belong to a daemon that
  is still starting up.
- Otherwise the app checks whether any process actually holds the file open, and
  only then removes it. On Windows the deletion is itself the liveness test,
  because Windows refuses to delete a file a process has open.

**By hand,** if you ever need to: make sure no `ipfs` process is running, then
delete `repo.lock` from the repository folder (see [§5](#5-what-gets-installed-and-where)).
Never delete it while a daemon is alive.

### macOS: `launchctl load` is deprecated, and worse than deprecated

If you are debugging the login item by hand, do not use `launchctl load`. It is
deprecated, and it will happily "load" an agent **without starting it** — which
looks exactly like success and serves exactly nothing. Use the modern pair:

```sh
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/art.bureauofinternetculture.archiver.ipfs.plist
launchctl kickstart -k gui/$UID/art.bureauofinternetculture.archiver.ipfs
launchctl print gui/$UID/art.bureauofinternetculture.archiver.ipfs   # inspect it
launchctl bootout gui/$UID/art.bureauofinternetculture.archiver.ipfs # remove it
```

That is what the app does. `bootstrap` registers the job, `kickstart -k` actually
starts it (and restarts it if it was already running).

**A known macOS behaviour, not a bug in the plist.** `KeepAlive` is set and
launchd accepts it — `launchctl print` reports `properties = keepalive |
runatload`. But on battery power macOS may defer the respawn after a crash:
`launchctl print` then shows `pended nondemand spawn = inefficient` and the node
stays down until the machine is on mains or something else wakes it. Every
`ProcessType` value was tested and the behaviour is identical, so this is macOS
power policy rather than something the app can configure away. Plugging in, or
starting the node from the app, brings it straight back.

### The daemon exits during start-up with a "bind" or "address in use" error

Something else already holds one of the local ports. Kubo's default gateway is
`127.0.0.1:8080`, which on a developer's laptop is occupied roughly always, and a
daemon that cannot bind it **exits during start-up after appearing to install
perfectly** — the same silent-failure shape as the repo lock.

The app avoids this by testing ports before it configures the repository: it
keeps 5001 unless something that is not our node is genuinely using it, and
otherwise scans upward, writes the port it chose into settings, and says which
port it moved to. If you are running a node by hand, `ipfs config Addresses.Gateway`
and `ipfs config Addresses.API` are the two to change.

### "Your node can only be reached through relays"

Your router is not letting anyone dial in on port 4001. The node still works —
other people reach it through a relay computer in the middle — but it is slower
and less reliable, and a cloud pinning service may not be able to fetch from you
at all.

In order of effort: wait a couple of minutes (a node that just started often has
not worked out its own address yet); let Kubo's hole-punching try; forward TCP
**and** UDP 4001 to this machine if you control the router; or accept relay-only,
which is a real contribution and better than nothing. On corporate, university and
guest networks it usually cannot be fixed and that is fine — mirror from
somewhere else.

See also [§4](#4-privacy-stated-plainly): relay-only changes what is *published*
about you, and it is worth knowing which side of that line you are on.

### Telling a cached gateway response from proof that content is really available

This is the trap that hides the whole problem, so it is worth understanding.

Fetching `https://ipfs.io/ipfs/<cid>` and getting a `200` **does not prove the
content is alive.** Public gateways cache aggressively. A gateway that fetched a
file last week will serve it from its own cache today even if every computer that
ever held it has since gone offline. The content looks fine right up to the
moment the cache is evicted, and then it is simply gone — this is exactly the
state the app calls **at risk**, and it is what 64 of BIC's content IDs were in.

They are two different questions and you have to ask both:

| Question | What answers it | What a "yes" means |
| --- | --- | --- |
| Is anybody *announcing* that they hold this? | A routing lookup | Somebody is a real provider; the content can be found by anyone |
| Will a gateway *serve* it right now? | A gateway probe | It is retrievable today — possibly only from a cache |

- **Both yes** → healthy.
- **Serves, but nobody announces** → **at risk**. A cache is keeping it alive.
- **Neither** → unreachable.

The app does exactly this, using a delegated routing endpoint
(`https://delegated-ipfs.dev/routing/v1`) for the first question and several
independent gateways for the second. By hand:

```sh
# Question 1 — who, if anyone, is announcing it?
curl -s "https://delegated-ipfs.dev/routing/v1/providers/<cid>" | head -c 400
ipfs routing findprovs -n 5 <cid>        # if you have a node running

# Question 2 — will a gateway hand it over? Ask more than one.
curl -sI "https://ipfs.io/ipfs/<cid>?format=raw"
curl -sI "https://dweb.link/ipfs/<cid>?format=raw"
curl -sI "https://trustless-gateway.link/ipfs/<cid>?format=raw"
```

An empty provider list with a `200` from one gateway and failures from the others
is the signature of a cache hit, and it means the content is one eviction from
gone. Three practical notes:

- **Do not test from the machine that is providing the content.** Your own node
  answering is not evidence that anyone else can get it.
- **Do not trust a single gateway.** Ask two or three; caches are per-gateway.
- **A slow failure is not the same as a fast one.** A gateway that holds the
  connection open and then times out (often around 504 at the one-minute mark) is
  searching the network and finding nothing — that is a real "nobody has it", not
  a broken request.

One important exception, so nobody misreads it as a failure: a bare request for
the **root** of BIC's archive times out with a 504 because the gateway tries to
render a directory listing of 20,808 entries. That is the listing being enormous,
not the content being missing. Address something *inside* the archive, or ask for
the root's raw block with `?format=raw`, and it answers fine.

### "There is no IPFS node on this computer yet"

You tried to switch autostart on before a node existed. Set the node up first;
the app does the whole thing.

### The node is running but the archive is not being served

Having a node and serving the archive are two different things. Check the drift
banner and Settings: if you have never mirrored, or your copy is behind what BIC
now publishes, the node is running and holding nothing anyone is asking for. See
[`MIRRORING.md`](MIRRORING.md).

---

## 8. Where this lives in the code

| Path | Role |
| --- | --- |
| `src/shared/node.ts` | The fixed contract: `NodeState`, `ManagedNodeStatus`, `NodeInstallProgress`, `DriftStatus`, `KUBO_DIST`, `KUBO_PLATFORMS`, `AUTOSTART_LABEL`, `DEFAULT_STORAGE_MAX`. |
| `src/main/node/install.ts` | Download, **SHA-512 verification**, tar/zip extraction, `ensureRepo`, `clearStaleLock`, the install record. |
| `src/main/node/autostart.ts` | LaunchAgent / systemd user unit / Startup shim; `bootstrap`+`kickstart`; start and stop via the service manager. |
| `src/main/node/manager.ts` | `getNodeStatus`, `installAndStart`, `startNode`, `stopNode`, `uninstallNode`, `nodePaths` — and the managed-vs-external distinction. |
| `src/main/community/drift.ts` | Whether this member's copy still matches what BIC publishes. |
| `src/renderer/components/PinningSettings.tsx` | The Settings screen: node first, Pinata demoted. |
