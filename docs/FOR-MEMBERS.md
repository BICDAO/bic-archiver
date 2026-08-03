# Making a backup — a guide for DAO members

You do not need to know anything about IPFS to use this app. You need a contract
address or an OpenSea link, and about ten minutes.

By the end you will have one file that contains every picture and every description
for the NFTs you chose, and that anyone in the world can check is genuine.

---

## First, four words explained

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
- **Unreachable** — nobody has it and nobody will serve it. See the fourth word at the
  top of this page. This is the urgent one.

Unreachable items are listed first, in red, with a **Save a .car backup now** button
right there. Do that.

## 7. Export the .car

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

## 8. Put it somewhere safe — and somewhere online

A `.car` file sitting on your laptop protects the content from disappearing, but it
does **not** put it back on IPFS. Nobody else can fetch it while it is only on your
machine.

So do both:

1. **Keep a copy off your computer.** External drive, another member, the DAO's
   shared storage. Two copies in two places is the whole rule.
2. **Get it pinned.** Upload the `.car` to a pinning service — a company that keeps
   content available on IPFS for you. The Export screen has a button that opens
   **storacha.network**, which accepts `.car` files directly. You sign up with them
   yourself; this app never sees your account and never handles any payment.

Then tell the DAO the fingerprint from step 7, so anyone can verify the backup
without having to ask you for it.

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

**The window is blank, or says it could not reach the archiver.** Quit the app
completely and open it again. If it persists, reinstall it — your archive folder is
untouched by that, and reopening it restores everything.

---

## The short version

1. Open the app, **Start a new archive**, pick an empty folder.
2. **Add NFTs** → paste links or `0xADDRESS 1-50` → **Add … to the archive**.
3. **Health** → **Check all**. Anything red is urgent.
4. **Export** → **Choose where to save…** → keep the `.car` in two places and get it
   pinned.
5. Share the fingerprint with the DAO.
