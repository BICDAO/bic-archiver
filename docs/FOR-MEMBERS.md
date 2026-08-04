# A guide for DAO members

You do not need to know anything about IPFS to use this app, and you will never
have to open a terminal.

There are two things you can do here, and they are worth telling apart.

**Help keep BIC's archive alive.** One button. Your computer takes a copy of
everything BIC has rescued and starts offering it to other people, so the
collection no longer depends on one person's hard drive. Ten minutes of your
attention, about 2 GB of disk, and then it looks after itself. **This is the one
that matters most, and sections 3 to 6 are all of it.**

**Make a backup of your own.** Paste a contract address or an OpenSea link and
get one file containing every picture and every description for the NFTs you
chose — one that anyone in the world can check is genuine. Sections 7 onwards.

Do the first. Do the second if you want to.

---

## First, a few words explained

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

**A node** is the small free program that does the offering. When people say "run
a node", they mean "leave a program running that hands your files to anyone who
asks for them". It is not a website, there is no account, it costs nothing, and
you do not have to understand it — **this app installs it, starts it and looks
after it for you.** A node is simply the difference between having a file and
being somewhere other people can get it.

**Mirroring** is taking your own copy of BIC's whole archive and offering it too.
Not a duplicate for the sake of it: every member who mirrors is one more place
the collection survives. It is the button on the first screen.

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

## 3. The big button

The first screen has one obvious thing on it, and pressing it is the most useful
thing you can do in this app:

> **Set up IPFS and copy the archive**

Here is what it does, and it tells you the size before you commit to anything:
well under 100 MB for the IPFS program itself, then about **1.8 GB and 20,808
files** for BIC's archive. On a normal connection, tea-and-a-biscuit long.

You get one progress bar with real numbers on it (*65.7 MB of 80.1 MB*), and one
**Stop** button that works immediately. Stopping loses nothing — everything
already downloaded stays, and pressing the button again carries on from there
rather than starting the 1.8 GB again.

When it finishes it tells you one of two things, and the difference is the whole
point of this app:

> **This computer is now serving the archive to other people.**

That is the good one. You are now a place the collection can be fetched from.

> **Saved to this computer — but not shared with anyone yet.** Nobody can fetch
> these files from you until this computer runs IPFS.

That is honest rather than disappointing: the files are safe on your disk, but
saving files and offering them to other people are two different things, and the
app will never let a green tick pretend otherwise. Underneath there is a button
that fixes it — **Set up IPFS so people can fetch it from you** — which is
section 4.

**If it says you already have it,** you get a calm green *In sync*, a count of how
many computers are sharing the archive right now, and **no copy button at all**.
The app will not offer to make you download 1.8 GB you already have.

**Why this matters,** briefly. When BIC's real backup was checked in May 2026 it
held 10,762 files. **10,270 were fine. 428 were already gone**, and 64 more were
hanging on in a single server's memory with nobody actually keeping them. The
dead ones were not random: they were nearly all things BIC had rescued from
somewhere else, which meant BIC was the only one keeping them. Of the files
rescued from Arweave, 96 out of 100 were dead; from ordinary websites, 89 out of
100; of ordinary IPFS content that other people also keep, fewer than 1 in 100.
**Twelve NFTs had lost every single file.** Nobody deleted anything — we just
stopped offering them, and after a while there was nobody left to ask.

Your copy is the fix. Not a metaphor: one more member mirroring is literally one
more place each of those files exists.

## 4. Your own IPFS node

This used to be the scary part of the guide, with three terminal commands in it.
It is not any more. **Press the button and wait.**

You will find it on the first screen, and in **Settings** under *Your own IPFS
node*. The app then, by itself:

- downloads the IPFS program (about **80 MB**) from its official home;
- **checks it is genuinely the right file** before running any of it — a
  fingerprint check, and if it does not match, the download is deleted and
  nothing is run;
- sets up its storage;
- starts it, and checks it really answers rather than just assuming;
- and sets it to start again whenever you log in, so your computer keeps helping
  after you close the app, shut the lid, or restart.

There is nothing to sign up for and nothing to pay. If you already run IPFS
yourself, the app notices, uses it, and leaves it completely alone — it will not
change your settings or remove your node.

**What it costs you:** about 80 MB to download, around 2 GB of disk for the
archive, and a little upload bandwidth when somebody actually fetches a file from
you. No monthly anything.

**One honest note about privacy.** Running a node means the computers you
exchange files with can see your IP address — the same as with any file-sharing
program, or a video call. If your home router does not let people dial in
directly, your node works through other computers that pass traffic on its
behalf, and your address is then not published in IPFS's public directory. But it
is still visible to the computers you are actually talking to. It is not
anonymity, and this app will not pretend it is. If that is not something you want
on your home connection, tell the DAO and let somebody else mirror — that is a
perfectly reasonable answer.

**Settings** shows what your node is doing: whether it is running, its name on
the network, how much disk it is using, **Start the node** / **Stop the node**,
and a switch called **Keep running when I close the app**. Leave that switch on
if you can. A node that only runs when you happen to have the app open is not
much of a promise.

If you ever want it gone, **Remove the node program** at the bottom of that
section does it. It deliberately leaves your copy of the archive on the disk —
removing the program and deleting 2 GB of rescued NFTs are two different
requests, and one button should not do both.

The longer version of all of this — including what to do when something goes
wrong — is in [`RUNNING-A-NODE.md`](RUNNING-A-NODE.md).

## 5. The gallery

Click **Gallery** in the left-hand column to actually *look* at what you are
keeping.

It is a grid of the artwork, and it loads as you scroll rather than all at once.
Under each picture is its name, its size, and a small coloured label saying
whether it is healthy, at risk, or unreachable. **Anything at risk is sorted to
the front**, because the whole point is to notice.

- **Search** by name, and the count underneath tells you what you are looking at
  (*Showing 80 of 240*).
- **Only what is at risk** is a switch that hides everything that is fine. Under
  it, a line tells you how many of your NFTs are flagged.
- More tiles appear as you reach the bottom. If they do not, there is a **Show
  more** button that does the same thing.
- Some things cannot be drawn as a picture — a 3D model, a video, a PDF, an
  audio file, a format browsers do not know. Those get a labelled tile saying
  what they are (*3D model (.glb)*, *Audio (.mp3)*) rather than a broken image.
  Nothing is missing; it just cannot be shown as a thumbnail.

**Click any piece** to open it properly: the artwork full size, its description,
its traits, every content ID it is made of, and the raw metadata if you want it.
The panel checks each piece against the network while it is open and tells you in
words — *"3 computers offer it"*, *"nobody is offering it"*. Press **Escape** or
click outside to close.

If the gallery is empty, there is nothing in this archive yet — that is section
7.

## 6. If a warning appears at the top of the screen

BIC's archive grows. When new NFTs are rescued, the archive changes, and the copy
you made in May is quietly last month's copy. **Nothing on the internet tells you
this** — which is precisely the problem this whole app exists to fix — so the app
checks for you.

You may see one of these:

**A red notice: "BIC has published a newer version."** Your copy is out of date.
Press **Update my copy**. It only fetches what changed, so it is much quicker
than the first time. This is the only one that is urgent, and it is the only one
shown in red.

**A quiet grey line saying the check could not run.** You are offline, or
something between you and the internet is being unhelpful. **This is not a
problem with your copy** and it is deliberately not alarming — the app will never
tell you your archive is stale just because it could not reach the network.

**Nothing at all.** Either your copy is current, or you have not made one yet. In
both cases there is nothing to warn you about.

## 7. Make an archive of your own

Everything from here on is the second job: building your own backup of NFTs you
choose. It is entirely optional, and independent of everything above.

The first screen asks what you want to do. Choose **Start a new archive**.

- Give it a name — *DAO archive* is fine. It is only used for the folder listing and
  the backup file name.
- Click **Choose an empty folder…** and pick, or create, an empty folder. Your
  Documents folder is a good home.

An archive is just that folder on your computer. Everything downloaded goes inside
it, so you can close the app at any time and pick up exactly where you left off by
choosing **Open an archive you made earlier** and pointing at the same folder.

## 8. Paste the NFTs you want to keep

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

## 9. Wait

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

## 10. Check what is still alive

Click **Health**, then **Check all**.

The app asks the network two separate questions about every content ID in your
archive: *is anybody offering this?* and *will any public server actually hand it
over right now?* It gives one of three answers:

- **Healthy** — copies exist and servers will serve it.
- **At risk** — a server still has it cached, but nobody is announcing that they hold
  it. That is "fine today, gone next month".
- **Unreachable** — nobody has it and nobody will serve it. See *"Unreachable"* at the
  top of this page. This is the urgent one, and section 11 is what you do about it.

Unreachable items are listed first, in red, with a **Save a .car backup now** button
right there. Do that.

## 11. Keep them alive — pin them

Making the backup is half the job. **Pinning** — being a place people can fetch
it from — is the other half, and it is the half the DAO skipped last time. The
numbers in section 3 are what skipping it looks like two years later.

Click **Assets** in the left-hand column. It lists everything in your archive and
who, if anyone, is holding on to it.

### You need somewhere to keep things

**Your own IPFS node — this is the answer.** If you have already done section 4,
you have one and there is nothing else to do. If not, go and do it: **Settings ▸
Your own IPFS node**, press the button, wait. A node is the *only* thing that can
bring back a file that has already gone quiet, because for those files the only
copy left in the world is the one on your disk, and a node is what puts it back
in front of everyone else.

**Pinata — optional, and probably not for you.** Pinata is a company that keeps
files available on machines that never sleep. Two honest caveats, both measured
rather than guessed:

- Asking Pinata to pin something by its content ID is a **paid feature**. On a
  free account it simply refuses, and no amount of making new keys will change
  that — it is a limit of the plan.
- The free allowance is 1 GB and 500 files. The archive is 1.9 GB and 20,808
  files. It does not fit, and it is not close.

So unless you are the person holding the DAO's paid Pinata account, ignore it.
Your node does the job, and it costs nothing. In the app, Pinata is tucked into a
collapsed section of Settings for exactly this reason.

And Pinata could never have rescued the dead files anyway: it works by going and
*fetching* what you ask for, and a file nobody is offering cannot be fetched. It
can only fetch from somebody — which, for BIC's rescued content, means from your
node.

### If you do have a Pinata key

In Settings, open the Pinata section, follow the link to its **API Keys** page,
create a key, copy the long **JWT** value, paste it in, and press **Save key**.

That key is a password to the DAO's Pinata account, so the app puts it straight
into your computer's keychain — the same place your browser keeps passwords. It
never goes into the archive, never into a `.car` file, and never into anything you
would send to another member. The app cannot even read it back afterwards; it can
only ask your computer to use it or to forget it.

### Now pin

Go to **Assets** and press **Pin everything**. Or press **Pin only what is at risk**,
which skips the files other people are already keeping and concentrates on the ones
nobody is.

You will see it work through the stages: copying the archive into your node, and —
if a Pinata key is set — asking Pinata to fetch it from you and then checking that
it really arrived. That last stage matters: the app does not tell you something is
pinned because a service said "OK", only when it can see it in the list of what is
actually being kept.

When it finishes you get a count of what was pinned, what is still being fetched, and
what failed with the reason for each one in plain English.

**If it says Pinata will not do this on a free account:** that is the paid-feature
limit above. Nothing is wrong with your key. Use your own node instead.

**If it says Pinata could not find something:** the file has gone from the network,
so there is nothing out there for Pinata to fetch. Make sure your own node is
running and press **Pin everything** again — that gives Pinata somewhere to get it
from.

**If it says your node cannot be reached from outside:** your internet connection is
not letting anyone dial in. Your own copy is still fine, but a cloud service cannot
collect from you. Wait a minute and try again first — a node that has just started
often has not sorted itself out. If it keeps saying it, ask in the DAO; someone on a
friendlier connection can do the pinning.

More detail, if you want it: [`PINNING.md`](PINNING.md) and
[`RUNNING-A-NODE.md`](RUNNING-A-NODE.md).

## 12. Export the .car

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

## 13. Put it somewhere safe — and somewhere online

A `.car` file sitting on your laptop protects the content from disappearing, but it
does **not** put it back on IPFS. Nobody else can fetch it while it is only on your
machine. That is what section 11 was for. Both halves matter:

1. **Keep a copy off your computer.** External drive, another member, the DAO's
   shared Drive folder. Two copies in two places is the whole rule.
2. **Keep it pinned.** Section 11. If you skipped it, go back — a backup nobody
   is offering is exactly how we lost 428 files last time.

Then tell the DAO the fingerprint from the top of the Export screen, so anyone
can verify the backup without having to ask you for it.

> **A note on Storacha.** Older versions of this guide, and the Export screen, told you
> to upload the `.car` to **storacha.network**. Don't — that service is gone. Its
> addresses no longer exist at all, and the main one now redirects somewhere else
> entirely. Use section 11 instead: your own node, and — only if the DAO has a
> paid account — Pinata.

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

**"No node answered at that address."** Your node is not running — it was stopped,
or the computer slept and has not caught up yet. Go to **Settings ▸ Your own IPFS
node** and press **Start the node**. Nothing you pinned earlier is lost; the node
picks it all up again. If it refuses to start and does not say why, that is a
known IPFS quirk with a known fix, and the app clears it for you on the next
attempt — press it once more. (The detail, if you are curious, is the stale
`repo.lock` section of [`RUNNING-A-NODE.md`](RUNNING-A-NODE.md).)

**"Pinata could not find this content anywhere on the network."** The file has gone
from IPFS, so there is nothing out there for Pinata to collect. Make sure your own
node is running and press **Pin everything** again; see section 11.

**The window is blank, or says it could not reach the archiver.** Quit the app
completely and open it again. If it persists, reinstall it — your archive folder is
untouched by that, and reopening it restores everything.

---

## The short version

**To help BIC — this is the one that matters:**

1. Open the app. Press **Set up IPFS and copy the archive**. Wait.
2. Check it says *This computer is now serving the archive to other people.* If
   it says *saved but not shared*, press the button underneath that fixes it.
3. In **Settings**, leave **Keep running when I close the app** switched on.
4. If a red notice appears weeks later, press **Update my copy**. A grey one is
   not a problem and needs nothing.

That is the whole job. No terminal, no account, no payment.

**To make a backup of your own, as well:**

5. **Start a new archive**, pick an empty folder.
6. **Add NFTs** → paste links or `0xADDRESS 1-50` → **Add … to the archive**.
7. **Health** → **Check all**. Anything red is urgent.
8. **Assets** → **Pin everything**. This is the step that stops it happening
   again — and it works because of step 1, not because of a pinning service.
9. **Export** → **Choose where to save…** → keep the `.car` in two places.
10. Share the fingerprint with the DAO.
