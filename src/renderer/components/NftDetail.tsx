/**
 * One NFT, up close.
 *
 * The gallery grid answers "what is in here?"; this panel answers "what exactly
 * do we hold, and is it still out there?". It is deliberately the only screen in
 * the app that shows a picture at full size next to the content IDs of the very
 * bytes on this disk — because that pairing is the whole claim the archive
 * makes: *this* image is *that* hash, and here is what the network says about it
 * today.
 *
 * Everything shown comes from the `GalleryItem` the grid already has. It does
 * not call `gallery:item`, and that is on purpose: on a cache miss that channel
 * walks the entire archive DAG to answer a question about one folder, which
 * would put a multi-second pause behind a click that should feel instant. The
 * grid reloads, the panel follows.
 *
 * Keyboard behaviour is not decoration. A modal that traps a member with no way
 * back to the keyboard is worse than no modal, so: Escape closes, Tab cycles
 * inside the panel, the app behind it is made `inert` while it is open, and
 * focus goes back to the exact card that opened it.
 *
 * This file also owns the two small vocabularies both gallery screens share —
 * {@link describeMedia} (what kind of file is this, and can the window show it?)
 * and {@link statusLook} (what does this NFT's network verdict mean, in words a
 * member can act on). They live here rather than in `GalleryView` so the import
 * only ever points one way: grid → panel.
 *
 * Classes: `.nft-overlay`, `.nft-panel`, `.nft-panel__head`,
 * `.nft-panel__title`, `.nft-panel__sub`, `.nft-panel__body`,
 * `.nft-panel__foot`, `.nft-media` with `__img` / `__video` / `__audio`,
 * `.nft-section` and `.nft-section__title`, `.nft-description`, `.nft-traits`
 * with `.nft-trait` / `__label` / `__value`, `.nft-cids`, `.nft-json` and
 * `.nft-json__code`, plus `.gallery-placeholder` and its `__glyph` / `__label`,
 * shared with the grid. All of them are carried by `styles.css`.
 *
 * They were not always. For a while `styles.css` had no overlay, backdrop or
 * dialog rules at all — the gallery had been styled on the assumption that the
 * detail screen was an inline page — and a portalled panel with no rules is not
 * merely plain, it is *invisible*: `body` is `height: 100%`, so an unpositioned
 * div after `#root` lands below the window with nothing to scroll it into view,
 * and clicking a tile looks like nothing happening at all. That is why
 * {@link GALLERY_FALLBACK_CSS} exists. It carries the structural minimum that
 * makes a dialog a dialog and nothing else, and it is *prepended* to `<head>`
 * so it loses every specificity tie: `styles.css` now overrides all of it, and
 * this is only a floor under the panel if those rules ever go away again.
 * Deleting the constant and {@link useGalleryStyles} together is safe whenever
 * that stops being a worry.
 */

import {
  useEffect,
  useId,
  useInsertionEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react'
import { createPortal } from 'react-dom'

import type { GalleryItem } from '../../shared/community'
import { mediaUrl } from '../../shared/community'
import type { HealthResult } from '../../shared/types'
import { useHealth } from '../hooks'
import { Cid } from './Cid'
import { Pill, formatBytes, formatCount, formatWhen, type Tone } from './Layout'

/* ========================================================================== */
/* The structural minimum, for the parts styles.css does not cover            */
/* ========================================================================== */

/**
 * Layout the two gallery screens cannot do without, for class names
 * `styles.css` does not define. See the note at the top of this file: this is a
 * floor, not a theme, and it is prepended to `<head>` so that any rule later
 * written in `styles.css` beats it on document order alone.
 *
 * Everything here is either positioning or the existing design tokens. If you
 * are the person who owns `styles.css`, lift these rules into it verbatim and
 * delete the constant — nothing else has to change.
 */
export const GALLERY_FALLBACK_CSS = `
.nft-overlay {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  overflow-y: auto;
  background: rgb(8 11 17 / 62%);
}

.nft-panel {
  display: flex;
  flex-direction: column;
  width: min(920px, 100%);
  max-height: min(88vh, 100%);
  min-height: 0;
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
}

/* The panel takes focus so the keyboard starts inside it; a ring around the
   whole dialog would read as an error rather than as a starting point. */
.nft-panel:focus {
  outline: none;
}

.nft-panel__head {
  display: flex;
  flex: none;
  gap: 12px;
  align-items: flex-start;
  padding: 16px 18px;
  border-bottom: 1px solid var(--border);
}

.nft-panel__sub {
  margin-top: 2px;
}

.nft-panel__body {
  display: flex;
  flex-direction: column;
  gap: 18px;
  min-height: 0;
  padding: 18px;
  overflow-y: auto;
}

.nft-panel__foot {
  display: flex;
  flex: none;
  gap: 10px;
  align-items: center;
  padding: 12px 18px;
  border-top: 1px solid var(--border);
}

.nft-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}

.nft-section__title {
  font-size: 12px;
  font-weight: 650;
  color: var(--text-faint);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

/* Long metadata is common — some collections inline a whole picture as text —
   so this scrolls in place instead of making the panel a mile long. */
.nft-json__code {
  max-height: 320px;
  overflow: auto;
}

.gallery-placeholder__glyph {
  display: block;
  font-size: 26px;
  line-height: 1.15;
  opacity: 0.75;
}

.gallery-placeholder__label {
  display: block;
  margin-top: 6px;
}

.gallery-more {
  justify-content: center;
}
`

const STYLE_ID = 'bic-gallery-fallback'

/**
 * Put {@link GALLERY_FALLBACK_CSS} in the document once.
 *
 * Prepended rather than appended: `styles.css` arrives as a `<link>` in the
 * built app and as injected `<style>` tags in dev, and in both cases going in
 * first is what makes these rules lose every tie.
 */
export function ensureGalleryStyles(): void {
  if (typeof document === 'undefined') return
  if (document.getElementById(STYLE_ID) !== null) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = GALLERY_FALLBACK_CSS
  document.head.prepend(style)
}

/** {@link ensureGalleryStyles}, before the browser has laid anything out. */
export function useGalleryStyles(): void {
  useInsertionEffect(() => {
    ensureGalleryStyles()
  }, [])
}

/* ========================================================================== */
/* What kind of file is this?                                                 */
/* ========================================================================== */

export type MediaKind = 'image' | 'video' | 'audio' | 'model' | 'document' | 'unknown' | 'none'

export interface MediaPlan {
  kind: MediaKind
  /** Two or three words, for the placeholder tile in a grid card. */
  label: string
  /** A full sentence, for the detail panel. */
  note: string
  /** Decorative glyph for the placeholder. Never the only thing that is said. */
  glyph: string
}

/**
 * The types an `<img>` in Chromium will actually draw.
 *
 * An allow-list, not a block-list: `image/tiff` and `image/heic` are perfectly
 * good pictures that this window cannot render, and the difference between a
 * labelled placeholder and a broken-image icon is the difference between "the
 * app is telling me something" and "the app is broken".
 */
const RENDERABLE_IMAGE_TYPES: ReadonlySet<string> = new Set([
  'image/png',
  'image/apng',
  'image/jpeg',
  'image/pjpeg',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/svg+xml',
  'image/bmp',
  'image/x-icon',
  'image/vnd.microsoft.icon'
])

interface NamedType {
  kind: MediaKind
  label: string
  glyph: string
}

/** Types worth naming properly, because a member will recognise the words. */
const NAMED_TYPES: ReadonlyMap<string, NamedType> = new Map<string, NamedType>([
  ['model/gltf-binary', { kind: 'model', label: '3D model (.glb)', glyph: '◈' }],
  ['model/gltf+json', { kind: 'model', label: '3D model (.gltf)', glyph: '◈' }],
  ['video/mp4', { kind: 'video', label: 'Video (.mp4)', glyph: '▶' }],
  ['video/webm', { kind: 'video', label: 'Video (.webm)', glyph: '▶' }],
  ['video/quicktime', { kind: 'video', label: 'Video (.mov)', glyph: '▶' }],
  ['video/x-matroska', { kind: 'video', label: 'Video (.mkv)', glyph: '▶' }],
  ['audio/mpeg', { kind: 'audio', label: 'Audio (.mp3)', glyph: '♪' }],
  ['audio/wav', { kind: 'audio', label: 'Audio (.wav)', glyph: '♪' }],
  ['audio/x-wav', { kind: 'audio', label: 'Audio (.wav)', glyph: '♪' }],
  ['audio/ogg', { kind: 'audio', label: 'Audio (.ogg)', glyph: '♪' }],
  ['audio/flac', { kind: 'audio', label: 'Audio (.flac)', glyph: '♪' }],
  ['application/pdf', { kind: 'document', label: 'PDF document', glyph: '▤' }],
  ['text/html', { kind: 'document', label: 'Web page', glyph: '▤' }],
  ['application/xml', { kind: 'document', label: 'XML file', glyph: '▤' }],
  ['application/json', { kind: 'document', label: 'JSON file', glyph: '▤' }],
  ['text/plain', { kind: 'document', label: 'Text file', glyph: '▤' }],
  ['image/tiff', { kind: 'unknown', label: 'TIFF picture', glyph: '▩' }],
  ['image/heic', { kind: 'unknown', label: 'HEIC picture', glyph: '▩' }],
  ['image/heif', { kind: 'unknown', label: 'HEIF picture', glyph: '▩' }],
  ['image/jxl', { kind: 'unknown', label: 'JPEG XL picture', glyph: '▩' }],
  ['application/octet-stream', { kind: 'unknown', label: 'File of an unknown kind', glyph: '▩' }]
])

/** `video/x-flv` → `Video (X-FLV)`, so an unmapped type still reads as English. */
function fallbackName(contentType: string): NamedType {
  const slash = contentType.indexOf('/')
  const family = (slash === -1 ? contentType : contentType.slice(0, slash)).toLowerCase()
  const rest = slash === -1 ? '' : contentType.slice(slash + 1).replace(/;.*$/, '')
  const shown = rest === '' ? '' : ` (${rest.toUpperCase()})`

  switch (family) {
    case 'video':
      return { kind: 'video', label: `Video${shown}`, glyph: '▶' }
    case 'audio':
      return { kind: 'audio', label: `Audio${shown}`, glyph: '♪' }
    case 'model':
      return { kind: 'model', label: `3D model${shown}`, glyph: '◈' }
    case 'image':
      return { kind: 'unknown', label: `Picture${shown}`, glyph: '▩' }
    case 'text':
    case 'application':
      return { kind: 'document', label: `File${shown}`, glyph: '▤' }
    default:
      return { kind: 'unknown', label: 'File of an unknown kind', glyph: '▩' }
  }
}

/**
 * What this NFT's main file is, and whether the window can show it.
 *
 * `imageContentType` is sniffed from the first bytes of the file itself by
 * `buildGallery`, not guessed from a file name, so it is trustworthy even for
 * the many archived assets that arrived with no extension at all.
 */
export function describeMedia(
  item: Pick<GalleryItem, 'imageCid' | 'imageContentType' | 'animationCid'>
): MediaPlan {
  if (item.imageCid === undefined || item.imageCid === '') {
    return item.animationCid === undefined || item.animationCid === ''
      ? {
          kind: 'none',
          label: 'No picture saved',
          note: 'No picture was saved for this NFT. That is normal for tokens whose description file never pointed at one.',
          glyph: '○'
        }
      : {
          kind: 'none',
          label: 'Animation only',
          note: 'This NFT has no still picture — only an animation file, listed below with its own content ID.',
          glyph: '▶'
        }
  }

  const contentType = (item.imageContentType ?? '').toLowerCase().trim()

  if (contentType === '') {
    return {
      kind: 'unknown',
      label: 'File of an unknown kind',
      note: 'The archive holds this file, but nothing recorded what kind of file it is, so the window will not try to show it.',
      glyph: '▩'
    }
  }

  if (RENDERABLE_IMAGE_TYPES.has(contentType)) {
    return { kind: 'image', label: 'Picture', note: '', glyph: '▩' }
  }

  const named = NAMED_TYPES.get(contentType) ?? fallbackName(contentType)

  switch (named.kind) {
    case 'video':
      return {
        kind: 'video',
        label: named.label,
        note: 'This is a video. It plays in the panel; the file itself is held in the archive.',
        glyph: named.glyph
      }
    case 'audio':
      return {
        kind: 'audio',
        label: named.label,
        note: 'This is a sound file. It plays in the panel; the file itself is held in the archive.',
        glyph: named.glyph
      }
    case 'model':
      return {
        kind: 'model',
        label: named.label,
        note: 'This is a 3D model. This window cannot show 3D models, but the file is safely in the archive and will open in any glTF viewer.',
        glyph: named.glyph
      }
    case 'document':
      return {
        kind: 'document',
        label: named.label,
        note: 'The archive holds this file. This window does not open documents — deliberately, since an archived web page is somebody else’s code.',
        glyph: named.glyph
      }
    default:
      return {
        kind: 'unknown',
        label: named.label,
        note: 'The archive holds this file, but this window cannot display that kind of picture. The bytes are safe and any picture viewer will open them.',
        glyph: named.glyph
      }
  }
}

/* ========================================================================== */
/* What does the network say?                                                 */
/* ========================================================================== */

export interface StatusLook {
  tone: Tone
  /** Two words for a pill. */
  label: string
  /** Sort key: 0 is the most urgent, 3 is nothing to do. */
  rank: number
  /** A sentence that says what it means and what to do about it. */
  note: string
}

/**
 * One NFT's worst verdict, in words.
 *
 * `network` is the worst of this NFT's own content IDs and `atRisk` is set when
 * *nobody* was announcing one of them, so the two are read together: an NFT that
 * a gateway still serves out of a cache while no computer admits to holding it
 * is at risk, whatever else was said about it.
 *
 * Unchecked sorts *above* healthy on purpose. "We have not looked" is closer to
 * bad news than to good, and a member scrolling from the top should meet
 * everything unresolved before anything settled.
 */
export function statusLook(item: Pick<GalleryItem, 'network' | 'atRisk'>): StatusLook {
  if (item.network === 'unreachable') {
    return {
      tone: 'danger',
      label: 'Unreachable',
      rank: 0,
      note: 'Nobody on the IPFS network is offering these files and no public gateway would hand them over. If this archive holds the bytes, they may be the last copy anywhere — save a .car backup and get it pinned.'
    }
  }
  if (item.network === 'at-risk' || item.atRisk) {
    return {
      tone: 'warn',
      label: 'At risk',
      rank: 1,
      note: 'A gateway still serves this, but nobody is announcing that they hold a copy — usually a sign that what you are seeing is one gateway’s cache. Caches clear. Pin this, or save a .car backup.'
    }
  }
  if (item.network === 'unchecked') {
    return {
      tone: 'neutral',
      label: 'Not checked yet',
      rank: 2,
      note: 'Nothing has asked the network about this NFT in this session. Run a health check to find out whether it is still out there.'
    }
  }
  return {
    tone: 'ok',
    label: 'Online',
    rank: 3,
    note: 'Computers on the network say they hold this, and a public gateway handed it over when asked. Nothing to do.'
  }
}

/** Unreachable or at risk: the set a member can actually do something about. */
export function needsAttention(item: Pick<GalleryItem, 'network' | 'atRisk'>): boolean {
  return statusLook(item).rank <= 1
}

const VERDICT_LOOK: Record<HealthResult['verdict'], { tone: Tone; label: string }> = {
  unreachable: { tone: 'danger', label: 'Unreachable' },
  'at-risk': { tone: 'warn', label: 'At risk' },
  healthy: { tone: 'ok', label: 'Online' }
}

/* ========================================================================== */
/* Focus                                                                      */
/* ========================================================================== */

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'summary',
  'video[controls]',
  'audio[controls]',
  '[tabindex]:not([tabindex="-1"])'
].join(', ')

/**
 * Is this element actually rendered?
 *
 * `getClientRects()` is the usual answer and it is wrong here. Chromium keeps a
 * closed `<details>` collapsed with `content-visibility: hidden`, and its
 * contents still report a client rect — measured on the raw-metadata block:
 * closed, invisible, and still 856×320. Trusting that put a tab stop on a
 * `<pre>` nobody could see, which is precisely the "where did my focus go?"
 * moment a trap is supposed to prevent.
 *
 * `checkVisibility()` gets it right — false for that `<pre>`, true for the
 * `<summary>` beside it, which sits in the same closed `<details>` and must stay
 * reachable. It is Chromium 105+, so it is always there in Electron; the rect
 * check stays as the fallback for any other engine.
 */
function isRendered(element: HTMLElement): boolean {
  if (typeof element.checkVisibility === 'function') return element.checkVisibility()
  return element.getClientRects().length > 0
}

/** Everything inside the panel a Tab press could reach, in document order. */
function focusableWithin(panel: HTMLElement): HTMLElement[] {
  const out: HTMLElement[] = []
  for (const element of panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)) {
    if (element.hasAttribute('disabled')) continue
    if (element.getAttribute('aria-hidden') === 'true') continue
    if (element.tabIndex < 0) continue
    if (!isRendered(element)) continue
    out.push(element)
  }
  return out
}

/* ========================================================================== */
/* The panel                                                                  */
/* ========================================================================== */

export interface NftDetailProps {
  /** The NFT to show. Everything drawn here comes from this object. */
  item: GalleryItem
  /** Close the panel. Called on Escape, the Close button and a backdrop click. */
  onClose: () => void
  /**
   * The card that opened this, so focus can go back to it.
   *
   * Optional: with nothing passed, whatever had focus when the panel opened is
   * used instead, which in practice is the same element.
   */
  restoreFocusTo?: HTMLElement | null
  /** Take the member to the Health screen. Omitted, the offer is not made. */
  onCheckHealth?: () => void
}

export function NftDetail({
  item,
  onClose,
  restoreFocusTo,
  onCheckHealth
}: NftDetailProps): ReactNode {
  const panelRef = useRef<HTMLDivElement | null>(null)
  const titleId = useId()
  const health = useHealth()
  const [mediaFailed, setMediaFailed] = useState(false)

  useGalleryStyles()

  /*
   * Read at unmount, not at render, so the effects below can stay `[]` and run
   * exactly once — starting the panel over because a parent re-rendered would
   * steal focus back from wherever the member had put it.
   */
  const latest = useRef({ onClose, restoreFocusTo })
  latest.current = { onClose, restoreFocusTo }

  const plan = describeMedia(item)
  const status = statusLook(item)

  useEffect(() => {
    setMediaFailed(false)
  }, [item.imageCid])

  /*
   * Escape and Tab.
   *
   * Declared *before* the focus effect below, because React runs cleanups in
   * the order the effects were written: these listeners must come off before
   * that one hands focus back to the card, or the `focusin` guard would snatch
   * it straight back into a panel that is being taken off the screen.
   *
   * Capture phase, so the panel sees Escape before anything underneath it.
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const panel = panelRef.current
      if (panel === null) return

      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        latest.current.onClose()
        return
      }

      if (event.key !== 'Tab') return

      const stops = focusableWithin(panel)
      const first = stops[0]
      const last = stops[stops.length - 1]
      if (first === undefined || last === undefined) {
        // Nothing to land on: keep the ring on the panel itself.
        event.preventDefault()
        panel.focus()
        return
      }

      const active = document.activeElement
      const inside = active instanceof HTMLElement && panel.contains(active)
      if (!inside) {
        event.preventDefault()
        ;(event.shiftKey ? last : first).focus()
        return
      }
      if (event.shiftKey && (active === first || active === panel)) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && active === last) {
        event.preventDefault()
        first.focus()
      }
    }

    const onFocusIn = (event: FocusEvent): void => {
      const panel = panelRef.current
      if (panel === null || !panel.isConnected) return
      if (event.target instanceof Node && panel.contains(event.target)) return
      panel.focus()
    }

    document.addEventListener('keydown', onKeyDown, true)
    document.addEventListener('focusin', onFocusIn)
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      document.removeEventListener('focusin', onFocusIn)
    }
  }, [])

  /*
   * Take focus, shut the rest of the window out of the tab order and the
   * accessibility tree, and give focus back on the way out.
   *
   * `inert` is what makes this a real trap rather than a polite one: the Tab
   * handler above cannot see a press that Chromium routes to browser chrome,
   * but an inert subtree has nothing focusable in it at all.
   */
  useEffect(() => {
    const opener =
      latest.current.restoreFocusTo ??
      (document.activeElement instanceof HTMLElement ? document.activeElement : null)

    // The window's own root. The panel is portalled to <body>, so it is a
    // sibling of this element and stays interactive.
    const appRoot = document.getElementById('root')
    const alreadyInert = appRoot !== null && appRoot.hasAttribute('inert')
    const previousAriaHidden = appRoot === null ? null : appRoot.getAttribute('aria-hidden')

    if (appRoot !== null && !alreadyInert) {
      appRoot.setAttribute('inert', '')
      appRoot.setAttribute('aria-hidden', 'true')
    }

    panelRef.current?.focus()

    return () => {
      if (appRoot !== null && !alreadyInert) {
        appRoot.removeAttribute('inert')
        if (previousAriaHidden === null) appRoot.removeAttribute('aria-hidden')
        else appRoot.setAttribute('aria-hidden', previousAriaHidden)
      }
      // Only if it is still on the screen: a card can disappear under the panel
      // when the gallery reloads, and focusing a detached node loses focus to
      // <body>, which is worse than leaving it where it is.
      if (opener !== null && opener.isConnected) opener.focus()
    }
  }, [])

  const rawJson = useMemo(() => {
    if (item.metadata === undefined) return null
    try {
      return JSON.stringify(item.metadata, null, 2)
    } catch {
      return null
    }
  }, [item.metadata])

  const cidRows = useMemo(() => {
    const rows: Array<{ key: string; label: string; cid: string; hint: string }> = []
    if (item.metadataCid !== undefined && item.metadataCid !== '') {
      rows.push({
        key: 'metadata',
        label: 'Description file',
        cid: item.metadataCid,
        hint: 'the JSON that names this NFT and lists its traits'
      })
    }
    if (item.imageCid !== undefined && item.imageCid !== '') {
      rows.push({
        key: 'image',
        label: plan.kind === 'image' ? 'Picture' : plan.label,
        cid: item.imageCid,
        hint: 'the main file'
      })
    }
    if (item.animationCid !== undefined && item.animationCid !== '') {
      rows.push({
        key: 'animation',
        label: 'Animation or video',
        cid: item.animationCid,
        hint: 'the moving version'
      })
    }
    return rows
  }, [item.metadataCid, item.imageCid, item.animationCid, plan.kind, plan.label])

  const imageCid = item.imageCid
  const showMedia = imageCid !== undefined && imageCid !== '' && !mediaFailed
  const mediaSrc = imageCid === undefined || imageCid === '' ? null : mediaUrl(imageCid)

  const panel = (
    <div
      className="nft-overlay"
      onMouseDown={(event) => {
        // Only a press that both starts and ends on the backdrop closes it, so
        // a text selection dragged out of the panel does not.
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        className="nft-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        ref={panelRef}
      >
        <header className="nft-panel__head">
          <div className="grow">
            <h2 className="nft-title" id={titleId}>
              {item.name}
            </h2>
            <p className="nft-panel__sub small faint">
              Saved in this archive as <span className="code-inline">{item.folder}</span> ·{' '}
              {formatBytes(item.sizeBytes)}
            </p>
          </div>
          <button
            type="button"
            className="btn btn-sm"
            onClick={onClose}
            title="Close this panel (Escape)"
          >
            Close
          </button>
        </header>

        <div className="nft-panel__body">
          {/* ---------------------------------------------------------- */}
          {/* The thing itself                                            */}
          {/* ---------------------------------------------------------- */}

          <div className="nft-media">
            {showMedia && mediaSrc !== null && plan.kind === 'image' ? (
              <img
                className="nft-media__img"
                src={mediaSrc}
                alt={`${item.name}, as saved in this archive`}
                decoding="async"
                draggable={false}
                onError={() => {
                  setMediaFailed(true)
                }}
              />
            ) : showMedia && mediaSrc !== null && plan.kind === 'video' ? (
              <video
                className="nft-media__video"
                src={mediaSrc}
                controls
                preload="metadata"
                onError={() => {
                  setMediaFailed(true)
                }}
              />
            ) : showMedia && mediaSrc !== null && plan.kind === 'audio' ? (
              <div className="gallery-placeholder">
                <span className="gallery-placeholder__glyph" aria-hidden="true">
                  {plan.glyph}
                </span>
                <span className="gallery-placeholder__label">{plan.label}</span>
                <audio
                  className="nft-media__audio"
                  src={mediaSrc}
                  controls
                  preload="metadata"
                  onError={() => {
                    setMediaFailed(true)
                  }}
                />
              </div>
            ) : (
              <div className="gallery-placeholder">
                <span className="gallery-placeholder__glyph" aria-hidden="true">
                  {mediaFailed ? '!' : plan.glyph}
                </span>
                <span className="gallery-placeholder__label">
                  {mediaFailed ? 'This file could not be shown' : plan.label}
                </span>
              </div>
            )}
          </div>

          {mediaFailed ? (
            <p className="small faint">
              The archive lists this file, but the window could not read it back. That usually means
              the bytes were never saved into this archive — only the address of them was.
            </p>
          ) : plan.note === '' ? null : (
            <p className="small faint">{plan.note}</p>
          )}

          {/* ---------------------------------------------------------- */}
          {/* Where it stands                                             */}
          {/* ---------------------------------------------------------- */}

          <section className="nft-section">
            <h3 className="nft-section__title">On the network</h3>
            <p className="row">
              <Pill tone={status.tone}>{status.label}</Pill>
            </p>
            <p className="small">{status.note}</p>
            {item.network === 'unchecked' && onCheckHealth !== undefined && (
              <p>
                <button type="button" className="btn btn-sm" onClick={onCheckHealth}>
                  Check this archive against the network
                </button>
              </p>
            )}
          </section>

          {/* ---------------------------------------------------------- */}
          {/* What it says about itself                                   */}
          {/* ---------------------------------------------------------- */}

          {item.description !== undefined && item.description !== '' && (
            <section className="nft-section">
              <h3 className="nft-section__title">Description</h3>
              <p className="nft-description">{item.description}</p>
            </section>
          )}

          <section className="nft-section">
            <h3 className="nft-section__title">Traits</h3>
            {item.attributes.length === 0 ? (
              <p className="small faint">
                The description file for this NFT lists no traits. Plenty of collections never had
                any.
              </p>
            ) : (
              /*
                Still a definition list — a trait is a term and its value — but
                each pair is wrapped in the `<div>` that HTML allows inside a
                `<dl>`, because `.nft-traits` in `styles.css` is a grid of
                `.nft-trait` cards rather than two columns of bare `dt`/`dd`.
                Semantics for the screen reader, the app's own look for
                everyone else.
              */
              <dl className="nft-traits">
                {item.attributes.map((attribute, index) => (
                  <div className="nft-trait" key={`${attribute.label}-${String(index)}`}>
                    <dt className="nft-trait__label">{attribute.label}</dt>
                    <dd className="nft-trait__value">{attribute.value}</dd>
                  </div>
                ))}
              </dl>
            )}
          </section>

          {/* ---------------------------------------------------------- */}
          {/* The addresses of the actual bytes                           */}
          {/* ---------------------------------------------------------- */}

          <section className="nft-section">
            <h3 className="nft-section__title">Content IDs</h3>
            {cidRows.length === 0 ? (
              <p className="small faint">
                No content IDs were recorded for this NFT, which means nothing of it was saved into
                this archive.
              </p>
            ) : (
              <div className="table-wrap">
                <table className="table nft-cids">
                  <caption className="sr-only">
                    Every file saved for {item.name}, its content ID, and what the last health check
                    said about it.
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">File</th>
                      <th scope="col">Content ID</th>
                      <th scope="col">On the network</th>
                    </tr>
                  </thead>
                  <tbody>
                    {cidRows.map((row) => {
                      /*
                       * Per-file verdicts come from this session's health sweep,
                       * which is keyed by the exact content ID. A miss is not a
                       * failure — it means this file was not part of the last
                       * sweep — so it falls back to saying nothing rather than
                       * to guessing from the NFT's overall verdict.
                       */
                      const result = health.byCid.get(row.cid)
                      const look = result === undefined ? null : VERDICT_LOOK[result.verdict]
                      return (
                        <tr key={row.key}>
                          <th scope="row">{row.label}</th>
                          <td>
                            <Cid
                              cid={row.cid}
                              label={`content ID of the ${row.label.toLowerCase()} — ${row.hint}`}
                              head={10}
                              tail={6}
                            />
                          </td>
                          <td>
                            {look === null || result === undefined ? (
                              <span className="faint small">Not checked yet</span>
                            ) : (
                              <span className="stack stack-sm">
                                <Pill tone={look.tone}>{look.label}</Pill>
                                <span className="small faint">
                                  {result.providers === 0
                                    ? 'nobody is offering it'
                                    : `${formatCount(result.providers)} ${
                                        result.providers === 1 ? 'computer offers' : 'computers offer'
                                      } it`}
                                  , checked {formatWhen(result.checkedAt)}
                                </span>
                              </span>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* ---------------------------------------------------------- */}
          {/* Where it came from                                          */}
          {/* ---------------------------------------------------------- */}

          {(item.contract !== undefined || item.tokenId !== undefined) && (
            <section className="nft-section">
              <h3 className="nft-section__title">The token</h3>
              <dl className="kv">
                {item.contract !== undefined && item.contract !== '' && (
                  <>
                    <dt>Contract</dt>
                    <dd>
                      <Cid value={item.contract} label="contract address" head={6} tail={4} />
                    </dd>
                  </>
                )}
                {item.tokenId !== undefined && item.tokenId !== '' && (
                  <>
                    <dt>Token ID</dt>
                    <dd className="tabular">{item.tokenId}</dd>
                  </>
                )}
              </dl>
            </section>
          )}

          {/* ---------------------------------------------------------- */}
          {/* The file, exactly as it was saved                           */}
          {/* ---------------------------------------------------------- */}

          {/*
            A native `<details>`: the keyboard, the screen reader, and
            find-in-page opening a closed section when a member searches for a
            word inside it all come free that way. `styles.css` dresses
            `.nft-json > summary` directly, so the summary stays a plain one
            rather than borrowing the app's `.disclosure` markup.
          */}
          <details className="nft-json">
            <summary>Show the description file exactly as it was saved</summary>
            {rawJson === null ? (
              <p className="small faint">
                {item.metadataCid === undefined
                  ? 'No description file was saved for this NFT.'
                  : 'The description file was too large to hold open here — some NFTs store their whole picture inside it as text. The file itself is in the archive, at the content ID listed above.'}
              </p>
            ) : (
              /*
               * Focusable on purpose. A box that only a mouse wheel can scroll
               * is unreachable from the keyboard, and the raw metadata is
               * exactly the thing a member gets asked to read out when
               * something has gone wrong.
               */
              <pre
                className="nft-json__code codeblock__code"
                tabIndex={0}
                role="region"
                aria-label={`The description file for ${item.name}, exactly as it was saved`}
              >
                {rawJson}
              </pre>
            )}
          </details>
        </div>

        <footer className="nft-panel__foot">
          <span className="small faint grow">Press Escape to close.</span>
          <button type="button" className="btn btn-sm btn-primary" onClick={onClose}>
            Close
          </button>
        </footer>
      </div>
    </div>
  )

  /*
   * Portalled to <body> so the panel is not a descendant of the app root it
   * makes inert, and so no `overflow`, `transform` or `hidden` on a screen
   * container can clip a fixed overlay.
   */
  return createPortal(panel, document.body)
}

export default NftDetail
