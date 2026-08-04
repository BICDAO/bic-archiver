/**
 * The manual, in the app, for someone who has never heard of IPFS.
 *
 * Three rules shaped this file.
 *
 * 1. **It answers questions, it does not lecture.** Every section heading is a
 *    thing a member might actually wonder ("Why did that file disappear?"), and
 *    every section is short enough to read standing up. The contents list at the
 *    side is the whole point: nobody reads a manual front to back, they arrive
 *    with one question and need to land on it.
 *
 * 2. **The numbers are real.** 10,762 content IDs checked, 428 already
 *    unreachable, 12 NFTs surviving as a single file in one Google Drive folder.
 *    A member who is being asked to give up 2 GB of disk deserves the actual
 *    measurement rather than "content can be lost".
 *
 * 3. **The limits are stated as plainly as the features.** An unsigned build
 *    that warns on first open, a gateway that answers from a cache and proves
 *    nothing, volunteers who can switch their gateway off tomorrow — those are
 *    in here, at the same size as everything else. This app's whole argument is
 *    that quiet failure is the enemy, so it cannot be quiet about its own.
 *
 * No engine calls except `openExternal`, which hands a link to the member's own
 * browser. This screen reads.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'

import { BIC_ARCHIVE } from '../../shared/community'
import { getApi } from '../hooks'
import { Card, Pill, ViewHeader, formatBytes, formatCount } from './Layout'

/* ========================================================================== */
/* The section list                                                           */
/* ========================================================================== */

interface Section {
  id: string
  /** What a member would call it. */
  title: string
  /** One line under the heading in the contents list. */
  blurb: string
}

const SECTIONS: readonly Section[] = [
  { id: 'what-this-is', title: 'What this app is for', blurb: 'The short version' },
  { id: 'ipfs', title: 'What IPFS is', blurb: 'And what it is not' },
  { id: 'cids', title: 'Content IDs', blurb: 'A fingerprint, not an address' },
  { id: 'pinning', title: 'Pinning', blurb: 'Why unpinned things vanish' },
  { id: 'car-vs-tar', title: '.car files vs folders', blurb: 'Which one to keep' },
  { id: 'screens', title: 'Every screen', blurb: 'And when to use it' },
  { id: 'verdicts', title: 'Online, At risk, Unreachable', blurb: 'What to do about each' },
  { id: 'mirroring', title: 'Mirroring the archive', blurb: 'What the big button does' },
  { id: 'node', title: 'Running your own node', blurb: 'Roughly 2 GB of disk' },
  { id: 'limits', title: 'Honest limits', blurb: 'What this app cannot promise' }
]

/* ========================================================================== */
/* Small pieces                                                               */
/* ========================================================================== */

const IPFS_DOCS_URL = 'https://docs.ipfs.tech/concepts/what-is-ipfs/'

/** An address handed to the member's own browser; the window has no network. */
function ExternalLink({ url, children }: { url: string; children: ReactNode }): ReactNode {
  return (
    <button
      type="button"
      className="btn-link"
      title={`Open ${url} in your web browser`}
      onClick={() => {
        void getApi().openExternal(url)
      }}
    >
      {children}
    </button>
  )
}

/** A term being defined, so the eye can find it again when scanning back. */
function Term({ children }: { children: ReactNode }): ReactNode {
  return <strong className="help-term">{children}</strong>
}

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}

/* ========================================================================== */
/* The view                                                                   */
/* ========================================================================== */

export function Help(): ReactNode {
  const firstSection = SECTIONS[0]
  const [active, setActive] = useState<string>(firstSection === undefined ? '' : firstSection.id)
  const bodyRef = useRef<HTMLDivElement | null>(null)

  /*
   * Which section is on screen, so the contents list can mark it. Purely a
   * nicety — every link works whether or not this runs — so it is wrapped in
   * every guard that lets it fail silently rather than take the screen down.
   */
  useEffect(() => {
    const body = bodyRef.current
    if (body === null) return undefined
    if (typeof IntersectionObserver === 'undefined') return undefined

    const seen = new Map<string, number>()
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = entry.target.id
          if (id === '') continue
          seen.set(id, entry.isIntersecting ? entry.intersectionRatio : 0)
        }
        // The topmost visible section wins, so scrolling down never highlights
        // a heading that has already left the top of the window.
        for (const section of SECTIONS) {
          const ratio = seen.get(section.id) ?? 0
          if (ratio > 0) {
            setActive(section.id)
            return
          }
        }
      },
      { rootMargin: '-72px 0px -55% 0px', threshold: [0, 0.01, 0.25] }
    )

    for (const section of SECTIONS) {
      const element = body.querySelector(`#${section.id}`)
      if (element !== null) observer.observe(element)
    }
    return () => {
      observer.disconnect()
    }
  }, [])

  /**
   * Jump to a section and move the keyboard there too.
   *
   * Scrolling alone would leave a keyboard user's focus back in the contents
   * list, so the next Tab would take them to the *next link* rather than into
   * what they just asked to read. The headings carry `tabIndex={-1}` for this.
   */
  const goTo = useCallback((id: string): void => {
    const target = document.getElementById(id)
    if (target === null) return
    target.scrollIntoView({
      behavior: prefersReducedMotion() ? 'auto' : 'smooth',
      block: 'start'
    })
    target.focus({ preventScroll: true })
    setActive(id)
  }, [])

  return (
    <div className="view help">
      <ViewHeader
        title="How this works"
        lead="Everything this app does, explained for someone who has never heard of IPFS. Nothing here assumes you know what a hash is, and nothing here is hiding bad news."
      />

      <div className="help-layout">
        {/* ---------------------------------------------------------------- */}
        {/* Contents                                                          */}
        {/* ---------------------------------------------------------------- */}

        <nav className="help-toc" aria-label="Contents">
          <p className="help-toc__label">Contents</p>
          <ul className="help-toc__list">
            {SECTIONS.map((section) => (
              <li key={section.id}>
                <button
                  type="button"
                  className="help-toc__link"
                  aria-current={active === section.id ? 'true' : undefined}
                  onClick={() => {
                    goTo(section.id)
                  }}
                >
                  <span className="help-toc__title">{section.title}</span>
                  <span className="help-toc__blurb">{section.blurb}</span>
                </button>
              </li>
            ))}
          </ul>
        </nav>

        {/* ---------------------------------------------------------------- */}
        {/* Sections                                                          */}
        {/* ---------------------------------------------------------------- */}

        <div className="help-body" ref={bodyRef}>
          {/* -------------------------------------------------------------- */}

          <Card>
            <h2 className="help-heading" id="what-this-is" tabIndex={-1}>
              What this app is for
            </h2>
            <p>
              BIC Archiver keeps a real copy of the DAO&rsquo;s NFTs — the pictures, the videos and
              the description files, not just the token numbers — on your own computer, in a form
              that can be checked later by anyone. It then asks the network which of those files are
              still out there, tells you which have quietly gone, and gives you the tools to put
              them back. The whole point is that the art survives even if every marketplace, website
              and hosting company involved shuts down.
            </p>
            <p className="muted">
              That is not a hypothetical. When BIC&rsquo;s own May-2026 backup was checked —{' '}
              {formatCount(10762)} content IDs, {formatBytes(BIC_ARCHIVE.approxBytes)} of files —{' '}
              {formatCount(10270)} were still reachable, 64 were hanging on by a thread, and{' '}
              <strong>{formatCount(428)} had already gone</strong>. Twelve NFTs existed nowhere on
              earth except one file in one person&rsquo;s Google Drive folder.
            </p>
          </Card>

          {/* -------------------------------------------------------------- */}

          <Card>
            <h2 className="help-heading" id="ipfs" tabIndex={-1}>
              What IPFS is
            </h2>
            <p>
              <Term>IPFS</Term> is a way for computers to share files by describing{' '}
              <em>what the file is</em> rather than <em>which website it sits on</em>. There is no
              company running it and no central server: it is just a lot of ordinary computers, each
              holding some files and willing to hand them to anyone who asks for them by name.
            </p>
            <p>
              That has one enormous advantage and one enormous catch. The advantage is that no
              single company can take the art down, change it, or go out of business and take it
              with them — if any computer anywhere still has the file, you can get it. The catch is
              the other half of the same sentence: <strong>if no computer has it, it is gone.</strong>{' '}
              IPFS is not storage. Nothing about putting a file on IPFS makes anyone keep it.
            </p>
            <p className="muted">
              People sometimes assume IPFS is &ldquo;permanent&rdquo; the way a blockchain is. It is
              not, and that misunderstanding is exactly how the {formatCount(428)} files above were
              lost — they were put on IPFS years ago, everyone assumed that was that, and one by one
              the computers holding them were switched off.{' '}
              <ExternalLink url={IPFS_DOCS_URL}>The IPFS project explains it too</ExternalLink>, in
              more detail.
            </p>
          </Card>

          {/* -------------------------------------------------------------- */}

          <Card>
            <h2 className="help-heading" id="cids" tabIndex={-1}>
              Content IDs: a fingerprint, not an address
            </h2>
            <p>
              Everything on IPFS is named by a <Term>content ID</Term> — a CID — which looks like{' '}
              <code className="code-inline">bafybeigd…</code> and is calculated from the file&rsquo;s
              own contents. Feed the same file into IPFS on two different computers on two different
              continents and you get precisely the same CID. Change one pixel and you get a
              completely different one.
            </p>
            <p>
              So a CID is a fingerprint, not an address. A web address like{' '}
              <code className="code-inline">example.com/ape.png</code> says <em>where to go</em>, and
              whoever controls that address decides what you get when you arrive — they can swap the
              picture, or let the domain lapse, and nothing about the link tells you. A CID says{' '}
              <em>what you are looking for</em>. You can ask any computer on the network for it,
              check the bytes that come back against the fingerprint yourself, and know for certain
              that you got the real thing.
            </p>
            <div className="help-callout">
              <p>
                <strong>What a CID does not tell you</strong> is whether anybody still has the file.
                It is a fingerprint, and a fingerprint on file does not mean the person is still in
                the building. Every dead content ID in BIC&rsquo;s archive is still a perfectly
                valid CID; there is simply nothing left behind it.
              </p>
            </div>
          </Card>

          {/* -------------------------------------------------------------- */}

          <Card>
            <h2 className="help-heading" id="pinning" tabIndex={-1}>
              Pinning, and why unpinned things disappear
            </h2>
            <p>
              When a computer on IPFS fetches a file, it usually keeps a copy for a while so it can
              pass it on. That copy is a cache, and caches get cleaned out — that is what a cache is
              for. <Term>Pinning</Term> is telling a computer: this one is not a cache, keep it for
              good, never clear it out.
            </p>
            <p>
              A file survives on IPFS for exactly as long as at least one computer is pinning it and
              switched on. Nothing warns you when the last one goes away. There is no bounce message
              and no error email — one day the picture just stops loading, and by then the machine
              that had it has usually been wiped or sold.
            </p>
            <p className="muted">
              This is the whole reason the app nags. Of the {formatCount(428)} files BIC has already
              lost, almost every one was something BIC had rescued from Arweave or an ordinary
              website and saved onto IPFS — content nobody else on the network had any reason to
              keep. It was archived and never pinned, so nobody was keeping it, so it went. Files
              that were on IPFS natively, where the original minters were still pinning them, died
              at a rate of 0.7%. The rescued ones died at 96.5%.
            </p>
          </Card>

          {/* -------------------------------------------------------------- */}

          <Card>
            <h2 className="help-heading" id="car-vs-tar" tabIndex={-1}>
              .car files and ordinary folders
            </h2>
            <p>
              The Export screen offers two kinds of backup, and they are not two flavours of the
              same thing.
            </p>
            <dl className="kv help-kv">
              <dt>
                <span className="help-tag help-tag--keep">Keep this</span> .car file
              </dt>
              <dd>
                A <Term>.car</Term> holds the content exactly as IPFS built it: not just the
                finished files, but how each file was cut into blocks, in what order, and how those
                blocks were linked together. Those details are part of the fingerprint calculation,
                so reading a .car back gives you the <em>same content IDs you started with</em> —
                the ones written into the NFTs, the manifest and the DAO&rsquo;s records. It is the
                copy that can prove it is the real thing.
              </dd>
              <dt>
                <span className="help-tag">Nice to have</span> .tar or a plain folder
              </dt>
              <dd>
                An ordinary folder — or a .tar, which is just a folder squashed into one file —
                holds the finished pictures and nothing else. The files themselves are perfect: you
                can double-click them, and anyone can open them without special software. But the
                blocking and linking are gone, so adding them back to IPFS re-does that step with
                whatever settings the tool uses that day, and one different setting produces a
                different CID. The art is fine; the fingerprints in the DAO&rsquo;s records no
                longer point at it.
              </dd>
            </dl>
            <p className="muted">
              In one line: <strong>the .car is the backup, the folder is the convenience copy.</strong>{' '}
              Export the folder when you want to look through the art, hand it to somebody
              non-technical, or put it on a USB stick. Keep the .car for the day it has to be proved
              genuine or put back on the network.
            </p>
          </Card>

          {/* -------------------------------------------------------------- */}

          <Card>
            <h2 className="help-heading" id="screens" tabIndex={-1}>
              Every screen, and when to use it
            </h2>
            <dl className="kv help-kv">
              <dt>Add NFTs</dt>
              <dd>
                Paste whatever you already have — an OpenSea link, an Etherscan link, or a contract
                address and some token numbers — and the app reads the token&rsquo;s details from
                the blockchain, follows them to wherever the files actually live, and downloads
                every one. <em>Use it</em> when new work is minted, or when you are bringing a
                collection into the archive for the first time.
              </dd>

              <dt>Archive</dt>
              <dd>
                Everything the archive currently holds, NFT by NFT, plus the single root content ID
                that stands for all of it at once. <em>Use it</em> to see what you have, to get the
                root CID to send to another member, or after adding tokens to confirm they landed.
              </dd>

              <dt>Gallery</dt>
              <dd>
                The archive as pictures rather than rows: thumbnails, names, traits, and how each
                NFT is doing on the network. <em>Use it</em> to browse, to find one particular piece,
                or to show somebody what the DAO has saved without explaining a single technical
                word.
              </dd>

              <dt>Assets</dt>
              <dd>
                Every individual file in the archive — thousands of rows — with filters, sorting,
                and the ability to pin a selection. This is where you act on <em>files</em> rather
                than on NFTs. <em>Use it</em> to find everything that is unpinned, everything that
                came from Arweave, or everything that failed, and then do something about it.
              </dd>

              <dt>Health</dt>
              <dd>
                Asks the network, content ID by content ID, whether anyone is still offering each
                file. <em>Use it</em> right after archiving something new, and then every few weeks
                — this is the check that catches a file going dark while there is still time to
                react.
              </dd>

              <dt>Export</dt>
              <dd>
                Writes a .car backup, or a browsable folder, or reads a .car another member sent you
                and folds it into your archive. <em>Use it</em> after any significant change, before
                trusting anything to a single computer, and whenever a member asks you for a copy.
              </dd>

              <dt>Settings</dt>
              <dd>
                Your own IPFS node — installing it, starting it, keeping it running — plus whether
                new content is pinned automatically, and an optional Pinata account.{' '}
                <em>Use it</em> once, early, to set your node up; after that you should rarely need
                to.
              </dd>
            </dl>
          </Card>

          {/* -------------------------------------------------------------- */}

          <Card>
            <h2 className="help-heading" id="verdicts" tabIndex={-1}>
              Online, At risk, Unreachable
            </h2>
            <p>
              The Health and Gallery screens give every file one of three verdicts. They are not
              shades of the same thing — each one has a different action attached.
            </p>
            <dl className="kv help-kv">
              <dt>
                <Pill tone="ok">Online</Pill>
              </dt>
              <dd>
                Computers on the network say they hold this, and a public gateway handed it over
                when asked. <strong>Do nothing.</strong> It is worth re-checking every few weeks,
                because &ldquo;online&rdquo; is a statement about today.
              </dd>

              <dt>
                <Pill tone="warn">At risk</Pill>
              </dt>
              <dd>
                A gateway still serves it, but <em>nobody is announcing that they keep a copy</em>.
                That usually means you are looking at a cache, and a cache expires.{' '}
                <strong>Act now, while the file can still be fetched:</strong> make sure the archive
                holds it, then pin it to your own node. Once the cache clears there may be nothing
                left to fetch.
              </dd>

              <dt>
                <Pill tone="danger">Unreachable</Pill>
              </dt>
              <dd>
                Nobody is offering it and no gateway would serve it. In practice every copy has gone
                offline. <strong>If your archive already holds the file</strong>, pin it to your own
                node — that is what puts it back on the network for everybody, and it is the only
                thing that can.{' '}
                <strong>If your archive does not hold it</strong>, ask around the DAO before
                anything else: another member&rsquo;s computer may still have it, and they can send
                you a .car file to import. That is how the twelve darkest NFTs were saved — one file
                in one Google Drive folder, found by asking.
              </dd>
            </dl>
            <p className="small muted">
              One caution on Unreachable: a check that runs while you are offline, or while the
              public gateways are having a bad day, can report Unreachable for files that are
              perfectly fine. Re-run it later before you panic — and treat a whole archive going red
              at once as a problem with the connection rather than with the art.
            </p>
          </Card>

          {/* -------------------------------------------------------------- */}

          <Card>
            <h2 className="help-heading" id="mirroring" tabIndex={-1}>
              Mirroring BIC&rsquo;s archive
            </h2>
            <p>
              The big Mirror button copies BIC&rsquo;s entire published archive —{' '}
              {formatBytes(BIC_ARCHIVE.approxBytes)} across {formatCount(BIC_ARCHIVE.approxFiles)}{' '}
              files — onto your computer, checking every block against its fingerprint as it
              arrives. Nothing that fails that check is kept, so what you end up with is either
              provably the real archive or nothing at all.
            </p>
            <p>
              Then there is the part that matters most, and it is easy to miss:
            </p>
            <dl className="kv help-kv">
              <dt>A copy on your disk</dt>
              <dd>
                Protects the bytes. If everything else burns down, the art still exists — on your
                machine, where only you can reach it.
              </dd>
              <dt>Actually serving it</dt>
              <dd>
                Means a node on your computer is announcing to the network &ldquo;I have these
                files, ask me&rdquo; and handing them over when anyone does. That is what makes the
                content <em>reachable</em> again rather than merely <em>saved</em>. It needs a node
                running — see the next section — and it is the difference between backing the
                archive up and keeping it alive.
              </dd>
            </dl>
            <p>
              Which is why more members mirroring makes the whole thing safer, in a way that is
              almost embarrassingly simple. Most of what BIC has rescued has exactly{' '}
              <strong>one</strong> provider today. One machine, one person&rsquo;s power bill, one
              laptop lid. Ten members mirroring is ten independent copies in ten places, with no
              subscription, no account, and nothing anyone can switch off — and each one costs its
              member a click and some disk space.
            </p>
            <p className="muted">
              BIC republishes the archive as it grows, so the app also checks whether the copy you
              are serving is still the current one. If a banner tells you your copy is behind, run
              the mirror again: it fetches only what is new.
            </p>
          </Card>

          {/* -------------------------------------------------------------- */}

          <Card>
            <h2 className="help-heading" id="node" tabIndex={-1}>
              Running your own node
            </h2>
            <p>
              A <Term>node</Term> is a small program that joins the IPFS network on your behalf. It
              holds the files you have asked it to keep, tells the network it has them, and hands
              them to anyone who asks. That is the entire job, and it is the one thing that cannot
              be outsourced: a hosted service can only fetch content that somebody is still serving,
              so for a file that nothing else has, your node is not the do-it-yourself option — it
              is the only option there is.
            </p>
            <p>
              <strong>The app can set this up for you.</strong> On the Settings screen, one button
              downloads the official IPFS software, checks its fingerprint before running a single
              byte of it, sets it up, starts it, and adds it to the things your computer starts when
              you log in. There is no terminal, nothing to configure, and nothing to remember.
            </p>
            <dl className="kv help-kv">
              <dt>It keeps running</dt>
              <dd>
                after you close this app, and it comes back when you restart your computer. That is
                deliberate and it is the point — a node that only runs while a window is open stops
                serving the archive the first time somebody shuts their laptop, and nothing
                announces that it has. You can turn that off with one switch if you would rather.
              </dd>
              <dt>What it costs</dt>
              <dd>
                About <strong>2 GB of disk</strong> for the archive as it stands today, plus around
                90 MB for the program itself. It uses a little bandwidth when another member fetches
                something from you, and essentially no processor time when it is idle. The app sets
                a 20 GB ceiling so the archive has room to grow, but it only ever uses what it is
                actually holding.
              </dd>
              <dt>If you already have one</dt>
              <dd>
                The app will find it, use it, and leave it completely alone — it will not
                reconfigure, restart or remove a node it did not install. Yours stays yours.
              </dd>
            </dl>
          </Card>

          {/* -------------------------------------------------------------- */}

          <Card>
            <h2 className="help-heading" id="limits" tabIndex={-1}>
              Honest limits
            </h2>
            <p className="muted">
              Things this app genuinely cannot do, or cannot promise. They are here because quiet
              failure is the problem this whole project exists to fix, and it would be absurd to be
              quiet about our own.
            </p>
            <dl className="kv help-kv">
              <dt>Your computer will warn you when you first open this app</dt>
              <dd>
                The builds are not signed with a paid developer certificate, so macOS says it cannot
                check the app for malicious software and Windows shows a blue &ldquo;unrecognised
                app&rdquo; screen. On a Mac, right-click the app and choose <em>Open</em>; on
                Windows, choose <em>More info</em> and then <em>Run anyway</em>. Do that only for a
                copy you got from BIC directly — the warning is annoying, but it is not meaningless.
              </dd>

              <dt>A gateway handing you a file is not proof the file is safe</dt>
              <dd>
                A public gateway may be serving it out of its own cache, in which case what you are
                seeing is a copy that will vanish when the cache clears, and nobody is keeping the
                original. That is precisely what <Pill tone="warn">At risk</Pill> means. Checking the
                bytes against the content ID proves you got the <em>right</em> file; only somebody
                announcing that they keep it proves it will still be there tomorrow. Those are two
                different questions and this app asks both.
              </dd>

              <dt>Public gateways are run by volunteers</dt>
              <dd>
                They are free, they are not owed to us, and they can rate-limit you, get slow, or
                disappear tomorrow. Nothing in the archive depends on one staying up — but a health
                check does talk to them, so an outage can make healthy files look unreachable. If a
                lot of rows go red at once, suspect the gateway before the art.
              </dd>

              <dt>Paid services are not a plan on their own</dt>
              <dd>
                Two have already failed this archive. Storacha, which the earlier tooling was built
                around, was decommissioned outright — its addresses do not resolve at all any more.
                Pinata still works, but pinning by content ID is a paid feature, and its free tier
                holds 1 GB and 500 files against an archive of{' '}
                {formatBytes(BIC_ARCHIVE.approxBytes)} and{' '}
                {formatCount(BIC_ARCHIVE.approxFiles)} files. Use one if the DAO wants to pay for
                one. Do not let it be the only copy.
              </dd>

              <dt>This app archives what it can find</dt>
              <dd>
                If a token points at a website that is already gone, there is nothing left to
                download and no software can invent it. That is why the checks matter now rather
                than later, and why a member finding an old file on a hard drive is a genuinely
                valuable contribution — the Export screen will read it back in.
              </dd>
            </dl>
          </Card>
        </div>
      </div>
    </div>
  )
}

export default Help
