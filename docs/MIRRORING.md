# Mirroring BIC's archive

Mirroring means: **another copy of BIC's whole archive exists in the world, and
your computer is one of the places it can be fetched from.**

That is one button in the app. This page explains what is behind it, how the copy
is made, how you can tell whether you are genuinely serving it or merely holding
it, and what the drift warning means when it appears months later.

- The friendly walkthrough: [`FOR-MEMBERS.md`](FOR-MEMBERS.md).
- Why members run nodes at all, and what running one costs and reveals:
  [`RUNNING-A-NODE.md`](RUNNING-A-NODE.md).
- Pinning individual content, and Pinata: [`PINNING.md`](PINNING.md).

---

## 1. Why one more copy matters

Of the 10,762 content IDs in BIC's May-2026 backup, **428 were served by
nobody** — 96.5% of everything BIC had rescued from Arweave, 88.6% of what it had
rescued from ordinary websites, against 0.7% of native IPFS content that other
people also keep. Twelve NFTs had lost every single file and existed only inside
one `.car` in one Google Drive folder.

Nothing was deleted. BIC was simply the only one offering those files, and one
day it stopped.

A mirror fixes that arithmetic directly. One member mirroring turns one provider
into two. Ten members mirroring means the archive survives any one of them
disappearing — no subscription, no account, and no company that can be wound down.
See [`RUNNING-A-NODE.md` §1](RUNNING-A-NODE.md#1-why-members-and-not-a-service)
for the full measurement and for why the two hosted services BIC used are no
longer available to it.

---

## 2. What the button actually does

The app works down a list, best outcome first, and it is honest about which one
it managed.

1. **Your own IPFS node.** The only outcome that makes you a real provider. The
   node is asked to fetch the archive itself where it can — a node that fetched
   the content is a node that has it — and only if it cannot reach the content
   does the app download the blocks and hand them over as a `.car`.
2. **Pinata.** A hosted copy that survives your laptop closing. This works
   *without* a node only when somebody else is already providing the content,
   because pin-by-CID asks Pinata to go and find it. When nobody is providing it
   and there is no node to fetch from, the app says so rather than queueing a job
   that will sit in "searching" until it expires. **Note that pin-by-CID is now a
   paid Pinata feature** — see [`PINNING.md`](PINNING.md).
3. **A cold copy.** A verifiable `.car` on your disk. Nothing is served, and the
   summary says so in one plain sentence rather than letting a green tick imply
   something untrue.

By default the copy goes into a *BIC Archive Mirror* folder in your Downloads;
you can choose somewhere else.

### How the copy is made

The archive is about **1.9 GB across ~19,000 blocks and 20,808 files**. Fetching
that as one request would hold the whole thing in memory and blow through every
sensible timeout, so it is split into **units** — the top-level folders, or
smaller pieces where a folder is unusually large — and each unit is fetched,
verified and stored on its own.

Two consequences worth knowing:

- **Progress is real.** 1.9 GB of silence is indistinguishable from a hung app,
  so each unit reports as it lands.
- **Stopping loses nothing.** Press Stop and the units already downloaded stay
  on disk; running it again carries on rather than starting the 1.9 GB over.

Every block is hash-verified as it arrives. A mirror is not "some bytes that
claim to be the archive" — it is provably the same content, which is the entire
point of addressing things by hash.

### Where the archive address comes from

BIC publishes through **DNSLink**: a TXT record at
`_dnslink.bureauofinternetculture.art` holding `dnslink=/ipfs/<root cid>`. The
app resolves that record, so when BIC updates the archive it edits one DNS value
and every member follows automatically — no app release, no stale CID baked into
a binary.

A CID *is* also compiled into the app, but only as a last-resort fallback for
when the name cannot be resolved at all, and it is deliberately never used as
evidence of what BIC publishes *today*. Comparing your copy against a CID from an
old app release would manufacture a false "you are out of date" every time BIC
updated the archive between releases.

---

## 3. Serving versus holding — the distinction the whole app turns on

**Saving bytes to a disk is not the same as serving them to other people**, and
conflating the two is exactly how 428 files were lost. They were "backed up", on
a machine that announced them to nobody.

So the app reports the two separately and never blurs them:

> **Saved to this computer — but not shared with anyone yet.** Nobody can fetch
> these files from you until this computer runs IPFS.

versus

> **This computer is now serving the archive to other people.**

The second sentence appears only when the content is genuinely retrievable by
somebody else: a local IPFS node that has it pinned, or a Pinata account the app
has *verified* is holding it. A queued Pinata job is not a mirror. A `.car` on a
desktop is not a mirror. Both are worth having and both are reported honestly for
what they are — but only one of them makes you a provider.

If you end up in the first state, the app offers **Set up IPFS so people can
fetch it from you**, which is [`RUNNING-A-NODE.md`](RUNNING-A-NODE.md).

---

## 4. The drift warning

A UnixFS directory's content ID changes the moment anything inside it changes. So
a member who mirrored in May is serving May's archive for ever, and — exactly like
the original failure — nothing tells them. Nobody gets an email when a directory
CID moves on.

The app checks. There are four possible answers, and the wording matters:

| Verdict | What it means | What to do |
| --- | --- | --- |
| **In sync** | What you hold matches what BIC publishes. | Nothing. The app does not offer to re-copy 1.9 GB you already have. |
| **Behind** | BIC has published a newer archive. | **Update my copy.** Only the new and changed parts are fetched. |
| **Unknown** | The published address could not be looked up — you are offline, DNS is being interfered with, or the record is temporarily unavailable. | Nothing. This is not a problem with your copy. |
| **Not mirrored** | No sign that this computer has a copy. | Make one, if you want to help. |

Two design points that are easy to get wrong and are worth stating:

**A failed lookup is never reported as drift.** Being offline is not the same as
being out of date, and a check that cannot run must never tell a member their
copy is stale. "Unknown" says exactly that, in plain words, and it is shown as a
quiet grey line — never a red alert. Being offline is not an emergency.

**Your node gets the last word.** The mirror writes down what it copied, and that
note is the primary evidence. But notes go missing — a fresh install, a copy made
some other way, a member who mirrored before the app kept notes — so when the note
is absent or disagrees, your own IPFS node is asked whether it is already keeping
the current archive. If it is, the verdict is **in sync** and you are not sent to
redo 1.9 GB you already hold.

Only **behind** is urgent, and only **behind** is shown in red.

---

## 5. Checking a mirror by hand

You do not have to take the app's word for any of this.

```sh
# What does BIC publish right now?
dig +short TXT _dnslink.bureauofinternetculture.art

# Does your own node hold that root, pinned?
ipfs pin ls --type=recursive <root cid>

# Is anybody announcing it? (Ask from a machine that is NOT the provider.)
curl -s "https://delegated-ipfs.dev/routing/v1/providers/<root cid>" | head -c 400
```

**Do not test by opening `https://ipfs.io/ipfs/<root cid>` in a browser.** A bare
request for the root times out with a 504 because the gateway tries to render a
listing of 20,808 entries — that is the listing being enormous, not the content
being missing. Ask for something *inside* the archive, or for the root's raw
block with `?format=raw`.

And a gateway returning `200` is not proof that content is alive: gateways cache,
and a cache hit with no providers is content that is one eviction from gone.
[`RUNNING-A-NODE.md` §7](RUNNING-A-NODE.md#telling-a-cached-gateway-response-from-proof-that-content-is-really-available)
explains how to tell those two apart properly.

---

## 6. Where this lives in the code

| Path | Role |
| --- | --- |
| `src/shared/community.ts` | The fixed contract: `BIC_ARCHIVE` (including the DNSLink `pointer`), `MirrorCapability`, `MirrorProgress`, `MirrorResult`, `MEDIA_SCHEME`, `GalleryItem`. |
| `src/main/community/mirror.ts` | `resolveArchiveRoot`, `detectCapabilities`, `mirrorArchive`, `checkMirrorStatus` — unit splitting, verification, the capability ladder, `nowServing`. |
| `src/main/community/drift.ts` | `resolvePublishedCid`, `getLocalMirrorCid`, `checkDrift`, `recordMirrored`. DNSLink over DoH, then the OS resolver, then gateways. |
| `src/renderer/components/Welcome.tsx` | The big button and its honest result sentences. |
| `src/renderer/components/DriftBanner.tsx` | The four verdicts, and why only one of them is red. |
