# Making a backup — a guide for DAO members

You do not need to know anything about IPFS to use this app. You need a contract
address or an OpenSea link, and about ten minutes.

By the end you will have one file that contains every picture and every description
for the NFTs you chose, and that anyone in the world can check is genuine.

---

## First, five words explained

Read these once. Everything below makes sense afterwards, and you can forget them
again.

**IPFS** is a way of sharing files where nobody is in charge. There is no company
holding your NFT's picture — there are just computers that happen to have a copy and
are offering it to anyone who asks. That is wonderful right up until the last computer
offering it switches off. Then the file is gone, and nothing anywhere sends you a
warning. This app exists because that already happened to us.

**A content ID** (you will also see it called a CID) is the long string starting
`bafy…` or `Qm…`. It is not a web address — it is a fingerprint, worked out from the
file's own contents. Change one pixel and you get a completely different content ID.
That is why it is useful: if someone hands you a file and it produces the fingerprint
your NFT says it should, that file is provably the original. Nobody can fake it, and
you do not have to trust whoever gave it to you.

**A .car file** is the backup this app makes. It holds the files *and* the exact
internal details IPFS needs to work out those fingerprints again. That is the whole
difference between it and an ordinary `.zip` or `.tar`. A `.tar` keeps your files
perfectly well, but it throws away the details that IPFS used to calculate the
fingerprint — so from a `.tar` you can restore the picture, but you can no longer
*prove* it is the picture the NFT points at. From a `.car` you can. Keep the `.car`.

**Pinning** is somebody promising to keep offering a file. A computer that has pinned
a file keeps it, and hands it over whenever anyone asks. That is the only thing
keeping anything on IPFS alive. Popular content is pinned by lots of strangers, so it
looks after itself. The files we rescued from elsewhere are pinned by nobody but us —
and when our copy stopped being offered, they were simply gone. Making a backup is
half the job. Pinning it is the other half.

**"Unreachable"** is the app telling you that nobody on the whole network is offering
a file any more, and no public server would hand it over either. If the app has
already downloaded that file, you may be holding one of the last copies in existence
— save a `.car` today and get it back online. If it has not, tell the DAO now, while
someone might still have it on an old laptop. This is the one word in the app worth
interrupting your evening for.

**Unreachable does not always mean lost.** BIC keeps its master backups as `.car`
files in a Google Drive folder rather than trusting the IPFS network to hold them, so
older BIC content IDs read as unreachable even though the files are perfectly safe.
It means nobody is *serving* that content right now. If you need an older backup, get
the newest `.car` from that Drive folder and use **Export ▸ Restore from a backup**
— don't paste the old content ID into **Add NFTs**, because there is nothing online
for the app to fetch.

---

## 1. Get the app

Download the installer for your computer from the DAO's releases page:

- **Mac** — the file ending `.dmg`
- **Windows** — the file ending `.exe`

You do **not** need to install IPFS Desktop, or IPFS anything. That was the old way.
This app does all of it by itself.

## 2. Open it the first time

Our builds are not signed by Apple or Microsoft — signing means paying them, and the
DAO has not. Your computer will therefore be suspicious the first time, and only the
first time.

**On a Mac,** you may see *"BIC Archiver" cannot be opened because it is from an
unidentified developer.* Click **OK**, then open **System Settings → Privacy &
Security**, scroll down to the message about BIC Archiver, and click **Open Anyway**.
Confirm once more and it will start. It never asks again.

**On Windows,** if a blue *Windows protected your PC* box appears, click **More info**
and then **Run anyway**.

## 3. Make an archive

The first screen asks what you want to do. Choose **Start a new archive**.

- Give it a name — *DAO archive* is fine. It is only used for the folder listing and
  the backup file name.
- Click **Choose an empty folder…** and pick, or create, an empty folder. Your
  Documents folder is a good home.

An archive is just that folder on your computer. Everything downloaded goes inside
it, so you can close the app at any time and pick up exactly where you left off by
choosing **Open an archive you made earlier** and pointing at the same folder.

## 4. Paste the NFTs you want to keep

Click **Add NFTs** in the left-hand column. There is a big box; paste whatever you
already have. All of these work, mixed together, one per line:

```
https://opensea.io/assets/ethereum/0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d/1
https://etherscan.io/token/0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d?a=7
0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d 1-50
0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d 1, 2, 7-9
```

That last shape is a **contract address** followed by **token numbers**. `1-50` means
every number from 1 to 50. There are *Try it* buttons under the box that fill in real
examples for you.

Two things that catch people out:

- A name like `feistydao.eth` is **not** a contract address. The app will say so. The
  address is the `0x…` string, 42 characters long, on the collection's OpenSea or
  Etherscan page.
- A contract address on its own, with no token numbers, is not enough — the app
  cannot guess which ones you want. Add at least one number.

As you type, a line under the box tells you what it understood — *"50 tokens from 1
contract · Ready to archive."* If it did not understand something, it says so there
instead, and quotes the line that confused it. Once it is happy, click the blue
button, which will read **Add 50 NFTs to the archive**.

## 5. Wait

A panel appears at the bottom of the window showing each NFT as it goes through:
looking up the token, fetching its description, fetching its pictures, saving. Three
are worked on at once, deliberately — the servers doing us this favour are run by
volunteers, and hammering them makes everything slower.

A few seconds each is normal. A minute or more means the app is patiently working
through servers that are not answering, which is exactly what you want it to do
rather than give up. There is a **Stop** button and it takes effect immediately;
anything already finished is safely saved.

When it is done, click **Archive** in the left-hand column. You will see one row per
NFT, with two columns worth understanding:

- **Saved** / **Partly saved** / **Not saved** — did everything download? *Partly
  saved* usually means the description was archived but one picture could not be.
- **Original ID** — the important one. A green **Kept** means every file you now hold
  is provably, bit-for-bit, the file the NFT points at, and anyone can check that
  against the contract. Something like **1 rebuilt** means one file had to be rescued
  from an ordinary web server, so its content ID is not guaranteed to match. The
  content is still saved either way.

Click any row to open it up and see every file, where it came from, and its content
ID. If a row reports a problem it is written in plain English and is worth reading —
but it is not worth panicking over. The rest was kept.

## 6. Check what is still alive

Click **Health**, then **Check all**.

The app asks the network two separate questions about every content ID in your
archive: *is anybody offering this?* and *will any public server actually hand it
over right now?* It gives one of three answers:

- **Healthy** — copies exist and servers will serve it.
- **At risk** — a server still has it cached, but nobody is announcing that they hold
  it. That is "fine today, gone next month".
- **Unreachable** — nobody has it and nobody will serve it. See *"Unreachable"* at the
  top of this page. This is the urgent one, and step 7 is what you do about it.

Unreachable items are listed first, in red, with a **Save a .car backup now** button
right there. Do that.

## 7. Keep them alive — pin them

This is the step that did not exist before, and it is the one that matters most.

Here is what we found when we checked the DAO's real backup from May 2026. It held
10,762 files and folders. **10,270 were fine. 428 were already gone**, and another 64
were halfway there — hanging on in one server's memory, with nobody actually keeping
them. And the 428 were not a random 428. Nearly every one was something we had rescued from somewhere else
and saved to IPFS, which meant we were the only ones keeping it. Of the files rescued
from Arweave, 96 out of every 100 were dead. Of the ones rescued from ordinary
websites, 89 out of 100. Of the ordinary IPFS content that other people also keep,
under 1 in 100. **Twelve NFTs had lost every single file.**

Nobody deleted anything. We just stopped offering the files, and after a while there
was nobody left to ask.

So: click **Assets** in the left-hand column. It lists everything in your archive and
who, if anyone, is holding on to it. Before you can use it you need at least one place
to keep things. There are two, and they do different jobs.

### The two places, and why you want both

**Your own IPFS node.** A free program that runs on your computer and offers your
files to anyone who asks. No account, no payment, nothing to sign up for. This is the
*only* thing that can bring back a file that has already gone quiet, because the file
exists nowhere else — the only copy is the one on your disk, and a node is what puts
it back in front of the world.

**Pinata.** A company that keeps files available for you, on machines that never sleep.
It costs money above a small free allowance, and someone in the DAO signs up for it.
Pinata cannot rescue a file that has already gone: it works by going and *fetching*
what you ask for, and a file nobody is offering cannot be fetched. What it can do is
keep things up when your own computer is switched off — which yours will be.

Together they work: your node puts the file back on the network, Pinata collects it
from your node and keeps it there for good. The app does that hand-off for you.

### Setting up your own node (about five minutes, once)

Open **Settings** at the bottom of the left-hand column. Under **Your own IPFS node**
there are three commands with a copy button. On a Mac, open **Terminal** (press
⌘-Space, type *Terminal*) and run them one at a time:

```sh
brew install kubo
ipfs init
ipfs daemon
```

The first command needs **Homebrew**, which many Macs already have. If Terminal answers
*command not found: brew*, get it from <https://brew.sh> first, or use the download page
below instead.

On Windows or Linux the Settings screen links to the download page, and then it is the
same last two commands.

**Leave that last window open.** `ipfs daemon` is the node itself — while that window
is running, your computer is offering your files to the world; when you close it, it
stops. You do not have to understand any of it. You do have to leave it running while
you pin, and start it again (`ipfs daemon`) next time.

Back in Settings, the node's details should appear within a few seconds. That is the
app talking to it.

### Setting up Pinata (optional, but do it eventually)

In Settings under **Pinata**, there is a link to Pinata's **API Keys** page. Sign in,
create a key, copy the long **JWT** value, paste it into the box, and press **Save
key**.

That key is a password to the DAO's Pinata account, so the app puts it straight into
your computer's keychain — the same place your browser keeps passwords. It never goes
into the archive, never into a `.car` file, and never into anything you would send to
another member. The app cannot even read it back afterwards; it can only ask your
computer to use it or to forget it.

### Now pin

Go to **Assets** and press **Pin everything**. Or press **Pin only what is at risk**,
which skips the files other people are already keeping and concentrates on the ones
nobody is.

You will see it work through three stages: copying the archive into your node, asking
Pinata to fetch it from you, then checking that it really arrived. That last stage
matters — the app does not tell you something is pinned because a service said "OK",
only when it can see it in the list of what is actually being kept.

When it finishes you get a count of what was pinned, what is still being fetched, and
what failed with the reason for each one in plain English.

**If it says Pinata could not find something:** that is the situation this whole page
is about. The file has gone from the network, so there is nothing for Pinata to fetch.
Start your own node (`ipfs daemon`), leave it running, and press **Pin everything**
again — that gives Pinata somewhere to get it from.

**If it says your node cannot be reached from outside:** your internet connection is
not letting anyone dial in. Your own copy is still fine, but Pinata cannot collect
from you. Wait a minute and try again first — a node that has just started often has
not sorted itself out. If it keeps saying it, ask in the DAO; someone on a friendlier
connection can do the pinning.

More detail, if you want it: [`PINNING.md`](PINNING.md).

## 8. Export the .car

Click **Export**.

The top of the screen shows **This archive's fingerprint** — a single content ID that
stands for everything in the archive. Share that string and another member can fetch
exactly these files, or check that a copy they already have is identical. If it says
*Not assembled yet*, do not worry; exporting works it out automatically.

Under **Export .car backup**, click **Choose where to save…** and pick a location.
That one file is your backup.

There is a second option, **Export browsable folder**, which writes ordinary files
you can double-click and look at. Use it to *look* at things. Do not use it as your
only backup: as explained at the top, ordinary files cannot reproduce the
fingerprints.

## 9. Put it somewhere safe — and somewhere online

A `.car` file sitting on your laptop protects the content from disappearing, but it
does **not** put it back on IPFS. Nobody else can fetch it while it is only on your
machine. That is what step 7 was for. Both halves matter:

1. **Keep a copy off your computer.** External drive, another member, the DAO's
   shared Drive folder. Two copies in two places is the whole rule.
2. **Keep it pinned.** Step 7. If you skipped it, go back — a backup nobody is
   offering is exactly how we lost 428 files last time.

Then tell the DAO the fingerprint from step 8, so anyone can verify the backup
without having to ask you for it.

> **A note on Storacha.** Older versions of this guide, and the Export screen, told you
> to upload the `.car` to **storacha.network**. Don't — that service is gone. Its
> addresses no longer exist at all, and the main one now redirects somewhere else
> entirely. Use step 7 instead: your own node, and Pinata.

---

## If something goes wrong

Every message in this app is written in plain English and tells you what to do next.
If one does not, that is a bug worth reporting. In the meantime:

**"That backup could not be added" / a check that takes a minute and then fails.**
The content genuinely is not out there any more. The message lists each server that
was asked and what it said. Nothing is broken on your end — this is the app doing its
job. Ask in the DAO whether anyone still has the files, or a `.car` of them, which
can be read straight back in from the Export screen.

**"This app can only read contracts on the Ethereum main network."** The NFT is on
Polygon, Base, Arbitrum or similar. This version only handles Ethereum mainnet.

**"…is not a valid contract address."** You have pasted an ENS name, a collection
name, or an address with a character missing. Go to the collection's Etherscan page
and copy the `0x…` string from there.

**"The archiver is busy…"** A run is still going. Wait for it, or press **Stop**.

**A run seems stuck.** Look at the bottom panel — if the messages are still changing,
it is working through slow servers. If you have had enough, **Stop** is instant and
loses nothing that has already been saved.

**You closed the app halfway through.** Nothing is lost. Every NFT is written to disk
the moment it finishes. Reopen the app, choose **Open an archive you made earlier**,
point at the same folder, and carry on.

**Everything failed at once, immediately.** Check your internet connection. The app
needs to reach the Ethereum network and public IPFS servers; on some office and
university networks these are blocked.

**"No node answered at that address."** The `ipfs daemon` window has been closed, or
the computer went to sleep. Open Terminal, run `ipfs daemon` again, and leave it open.
Nothing you pinned earlier is lost — the node picks it all up again.

**"Pinata could not find this content anywhere on the network."** The file has gone
from IPFS, so there is nothing out there for Pinata to collect. Start your own node
and press **Pin everything** again; see step 7.

**The window is blank, or says it could not reach the archiver.** Quit the app
completely and open it again. If it persists, reinstall it — your archive folder is
untouched by that, and reopening it restores everything.

---

## The short version

1. Open the app, **Start a new archive**, pick an empty folder.
2. **Add NFTs** → paste links or `0xADDRESS 1-50` → **Add … to the archive**.
3. **Health** → **Check all**. Anything red is urgent.
4. **Settings** → run the three commands to start your own IPFS node, and leave the
   `ipfs daemon` window open. Add a Pinata key if the DAO has one.
5. **Assets** → **Pin everything**. This is the step that stops it happening again.
6. **Export** → **Choose where to save…** → keep the `.car` in two places.
7. Share the fingerprint with the DAO.
