/**
 * The archive, as pictures.
 *
 * Every other screen in this app talks about content IDs. This one is the
 * reason any of it matters: 20,808 files and 1.9 GB of rescued art are not a
 * table of hashes, they are a collection, and a member who can see it is a
 * member who will keep it alive. It is also the fastest honest way to answer
 * "what did we nearly lose?" — the tiles that carry a red or amber pill are the
 * ones nobody else on the network is holding.
 *
 * Three things drive how this file is built:
 *
 * 1. **`gallery:list` is not cheap the first time.** It walks the whole archive
 *    DAG, sniffing the first bytes of every image to find out what kind of file
 *    it is. So it is not run on mount — it is run the first time this screen is
 *    actually *on the screen*, which an `IntersectionObserver` on the root
 *    detects whether the shell mounts views lazily or keeps them all mounted
 *    behind `hidden`. The main process caches the result, so every later reload
 *    is close to instant.
 *
 * 2. **Hundreds of cards must stay smooth.** Typing filters through a debounce,
 *    every card is a `memo` with a stable `onOpen`, and the grid renders in
 *    pages of 60 with more added as the member scrolls. Nothing about a
 *    keystroke touches a tile that is already on the screen.
 *
 * 3. **A broken-image icon is never acceptable.** Roughly a third of what BIC
 *    rescued is not a PNG — there are .glb models, videos, and files whose type
 *    nothing ever recorded. Each of those gets a tile that says what it is. See
 *    `describeMedia` in `NftDetail.tsx`, which this file shares with the panel.
 *
 * Pictures reach the window over `bic-media://`, served straight from the
 * blockstore by the main process — see `src/main/community/mediaProtocol.ts`.
 *
 * Classes, all of them now carried by `styles.css`: `.gallery-controls`,
 * `.gallery-filter` (aliased there as `.gallery-search`), `.gallery-count`,
 * `.gallery-grid`, `.gallery-card`, `.gallery-card__open`,
 * `.gallery-card__media` (aliased as `.gallery-media`), `.gallery-card__img`,
 * `.gallery-card__body`, `.gallery-card__name`, `.gallery-card__foot` (aliased
 * as `.gallery-card__meta`), `.gallery-more`, and `.gallery-placeholder` with
 * its `__glyph` and `__label`, shared with `NftDetail.tsx`. Everything else —
 * `.card`, `.field`, `.switch`, `.btn`, `.pill`, `.small`, `.faint` — is the
 * vocabulary the rest of the app already uses.
 *
 * Note the shape of a tile: the `<li>` is only the grid cell and the `<button>`
 * is the card, because a button has to have its platform chrome undone before
 * it can look like one, and `.gallery-card` is where that is done.
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'

import type { GalleryItem } from '../../shared/community'
import { mediaUrl } from '../../shared/community'
import type { ArchiveSnapshot } from '../../preload'
import { getApi, useDebouncedValue } from '../hooks'
import {
  Banner,
  EmptyState,
  Pill,
  ViewHeader,
  formatBytes,
  formatCount,
  isCancellation
} from './Layout'
import {
  NftDetail,
  describeMedia,
  needsAttention,
  statusLook,
  useGalleryStyles
} from './NftDetail'

/** How long the member has to stop typing before the grid is filtered. */
const FILTER_DEBOUNCE_MS = 180

/** Tiles drawn to begin with, and added each time the member reaches the end. */
const PAGE_SIZE = 60

/**
 * How often to check whether this screen has been shown yet, as a backstop to
 * the `IntersectionObserver` below. Only runs before the first load, on one
 * element, and stops for good once it has fired.
 */
const VISIBILITY_POLL_MS = 250

/**
 * How long after the last health result arrives before the "there is newer
 * information" note appears. A sweep of a large archive emits thousands of
 * events; this collapses the burst into one.
 */
const HEALTH_SETTLE_MS = 1200

/* ========================================================================== */
/* Sorting and filtering                                                      */
/* ========================================================================== */

/**
 * Worst first. Unreachable, then at risk, then anything not checked, then the
 * healthy ones — the actionable set is what a member came here to find, and it
 * must be at the top without them having to sort anything.
 */
function compareItems(a: GalleryItem, b: GalleryItem): number {
  const byStatus = statusLook(a).rank - statusLook(b).rank
  if (byStatus !== 0) return byStatus
  return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
}

/**
 * One lowercase string per NFT holding everything the search box looks at.
 *
 * Built once per load rather than per keystroke: with several hundred NFTs and
 * a dozen traits each, re-reading the objects on every character is exactly the
 * work that makes a grid feel sticky.
 */
function buildHaystacks(items: readonly GalleryItem[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const item of items) {
    const parts: string[] = [item.name, item.folder]
    if (item.description !== undefined) parts.push(item.description)
    if (item.contract !== undefined) parts.push(item.contract)
    if (item.tokenId !== undefined) parts.push(item.tokenId)
    for (const attribute of item.attributes) {
      parts.push(attribute.label, attribute.value)
    }
    map.set(item.folder, parts.join(' \u0000 ').toLowerCase())
  }
  return map
}

/* ========================================================================== */
/* One tile                                                                   */
/* ========================================================================== */

interface GalleryCardProps {
  item: GalleryItem
  onOpen: (item: GalleryItem, opener: HTMLElement) => void
}

/**
 * A single NFT.
 *
 * `memo` plus a stable `onOpen` is what keeps typing cheap: the filtered list
 * changes identity on every keystroke, but the items inside it do not, so React
 * re-uses every tile that survived the filter and touches only the DOM that
 * actually moved.
 */
const GalleryCard = memo(function GalleryCard({ item, onOpen }: GalleryCardProps): ReactNode {
  const [failed, setFailed] = useState(false)
  const plan = describeMedia(item)
  const status = statusLook(item)
  const flagged = status.rank <= 1

  const imageCid = item.imageCid
  const showImage = plan.kind === 'image' && imageCid !== undefined && imageCid !== '' && !failed

  return (
    // The button *is* the card: `styles.css` carries a `button.gallery-card`
    // rule that undoes the browser's own button chrome, and the `<li>` around it
    // is only the grid cell.
    <li>
      <button
        type="button"
        className="gallery-card gallery-card__open"
        data-folder={item.folder}
        aria-label={`${item.name}${flagged ? `, ${status.label}` : ''}. Open the details.`}
        onClick={(event) => {
          onOpen(item, event.currentTarget)
        }}
      >
        <span className="gallery-media gallery-card__media">
          {showImage && imageCid !== undefined ? (
            /*
             * `loading="lazy"` matters here: a large collection is hundreds of
             * these, and without it every one is fetched and decoded the moment
             * the screen appears. `alt` is empty because the button around it
             * already carries the name — a screen reader should hear it once.
             */
            <img
              className="gallery-card__img"
              src={mediaUrl(imageCid)}
              alt=""
              loading="lazy"
              decoding="async"
              draggable={false}
              onError={() => {
                setFailed(true)
              }}
            />
          ) : (
            <span className="gallery-placeholder">
              <span className="gallery-placeholder__glyph" aria-hidden="true">
                {failed ? '!' : plan.glyph}
              </span>
              <span className="gallery-placeholder__label">
                {failed ? 'Picture could not be shown' : plan.label}
              </span>
            </span>
          )}
        </span>

        <span className="gallery-card__body">
          <span className="gallery-card__name" title={item.name}>
            {item.name}
          </span>
          <span className="gallery-card__meta">
            {flagged && <Pill tone={status.tone}>{status.label}</Pill>}
            <span>{formatBytes(item.sizeBytes)}</span>
          </span>
        </span>
      </button>
    </li>
  )
})

/* ========================================================================== */
/* The view                                                                   */
/* ========================================================================== */

export interface GalleryViewProps {
  /**
   * The open archive. Only its identity is used — a different folder, a new
   * root or a different number of tokens is what makes the grid reload.
   */
  snapshot?: ArchiveSnapshot | null
  /** Take the member to the Add NFTs screen. Without it, the offer is dropped. */
  onAddTokens?: () => void
  /** Take the member to the Health screen. */
  onCheckHealth?: () => void
  /** Alias of `onCheckHealth`, for a shell that prefers this name. */
  onOpenHealth?: () => void
  /**
   * Load immediately instead of waiting to be seen. Pass `true` when the shell
   * mounts this screen only while it is showing; leave it out when every screen
   * stays mounted behind `hidden`, and the first look will trigger the load.
   */
  active?: boolean
}

export function GalleryView({
  snapshot,
  onAddTokens,
  onCheckHealth,
  onOpenHealth,
  active
}: GalleryViewProps): ReactNode {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const moreRef = useRef<HTMLDivElement | null>(null)

  const [items, setItems] = useState<readonly GalleryItem[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [healthMoved, setHealthMoved] = useState(false)

  const [query, setQuery] = useState('')
  const [atRiskOnly, setAtRiskOnly] = useState(false)
  const [limit, setLimit] = useState(PAGE_SIZE)
  const [open, setOpen] = useState<{ folder: string; opener: HTMLElement | null } | null>(null)

  const debouncedQuery = useDebouncedValue(query, FILTER_DEBOUNCE_MS)
  const goToHealth = onCheckHealth ?? onOpenHealth

  useGalleryStyles()

  /* ---------------------------------------------------------------------- */
  /* Loading                                                                 */
  /* ---------------------------------------------------------------------- */

  /**
   * What "the same archive" means for reloading purposes. A new root CID or a
   * different number of tokens means the gallery on screen is out of date.
   */
  const archiveKey =
    snapshot === undefined || snapshot === null
      ? null
      : `${snapshot.dir}\u0000${snapshot.manifest.rootCid ?? ''}\u0000${String(
          snapshot.manifest.tokens.length
        )}`

  const attempted = useRef<string | null>(null)
  const runToken = useRef(0)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const load = useCallback(async (key: string | null, keepOld: boolean): Promise<void> => {
    runToken.current += 1
    const token = runToken.current
    attempted.current = key

    setLoading(true)
    setError(null)
    if (!keepOld) setItems(null)

    const result = await getApi().listGallery()

    // A member who switched archive mid-read must not be shown the answer to
    // the question they abandoned.
    if (!alive.current || token !== runToken.current) return

    setLoading(false)
    if (result.ok) {
      setItems(result.value)
      setHealthMoved(false)
    } else {
      setError(result.error)
    }
  }, [])

  /*
   * Load the first time this screen is genuinely visible.
   *
   * The shell keeps every screen mounted and hides the ones it is not showing
   * (`<div hidden>` in `App.tsx`), so "mounted" is not "looked at" — and
   * starting a full DAG walk when the app opens would make the whole app slow
   * for a member who never came here.
   *
   * Two independent signals, because this is the *only* thing that ever starts
   * the load and there is no button to fall back on: if it never fires, the
   * member clicks Gallery and gets a blank screen with no error and no way to
   * recover. `IntersectionObserver` is the precise one and answers instantly,
   * but its callbacks are delivered during a rendering update, so a window that
   * is not being rendered can simply never deliver them — measured, not
   * theorised: an element 1080×89 and squarely inside the viewport went two
   * full seconds without a single entry in a browser tab that was not painting.
   * So a cheap poll of `checkVisibility()` — which is false inside a `hidden`
   * subtree and true once it is shown — runs alongside it. Whichever notices
   * first wins, both stop the moment it has been seen, and neither does any
   * work afterwards.
   */
  const [seen, setSeen] = useState(false)
  useEffect(() => {
    if (seen) return undefined
    if (active === true) {
      setSeen(true)
      return undefined
    }
    const element = rootRef.current
    if (element === null) {
      setSeen(true)
      return undefined
    }

    const isShown = (): boolean =>
      typeof element.checkVisibility === 'function'
        ? element.checkVisibility()
        : element.getClientRects().length > 0

    if (isShown()) {
      setSeen(true)
      return undefined
    }

    let observer: IntersectionObserver | null = null
    if (typeof IntersectionObserver !== 'undefined') {
      observer = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setSeen(true)
            return
          }
        }
      })
      observer.observe(element)
    }

    const timer = setInterval(() => {
      if (isShown()) setSeen(true)
    }, VISIBILITY_POLL_MS)

    return () => {
      observer?.disconnect()
      clearInterval(timer)
    }
  }, [seen, active])

  useEffect(() => {
    if (!seen || archiveKey === null) return
    if (attempted.current === archiveKey) return
    const switching = attempted.current !== null
    void load(archiveKey, !switching)
  }, [seen, archiveKey, load])

  const reload = useCallback(() => {
    void load(archiveKey, true)
  }, [load, archiveKey])

  /*
   * Network verdicts are folded into the gallery by the main process at the
   * moment it is asked, so a sweep that finishes after this screen loaded
   * leaves the pills stale. Rather than subscribing to the health store — which
   * would re-render this component once per result, thousands of times during a
   * sweep — the raw channel is watched and collapsed into a single flag, and
   * the member is offered a reload instead of having the grid re-sort itself
   * underneath them.
   */
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const unsubscribe = getApi().onHealth(() => {
      if (timer !== null) return
      timer = setTimeout(() => {
        timer = null
        setHealthMoved(true)
      }, HEALTH_SETTLE_MS)
    })
    return () => {
      unsubscribe()
      if (timer !== null) clearTimeout(timer)
    }
  }, [])

  /* ---------------------------------------------------------------------- */
  /* Filtering                                                               */
  /* ---------------------------------------------------------------------- */

  const haystacks = useMemo(() => buildHaystacks(items ?? []), [items])

  const terms = useMemo(
    () =>
      debouncedQuery
        .toLowerCase()
        .split(/\s+/)
        .filter((term) => term !== ''),
    [debouncedQuery]
  )

  const filtered = useMemo(() => {
    const source = items ?? []
    const matched: GalleryItem[] = []
    for (const item of source) {
      if (atRiskOnly && !needsAttention(item)) continue
      if (terms.length > 0) {
        const hay = haystacks.get(item.folder) ?? ''
        // Every word must appear somewhere: "gigachad hat" finds the one NFT
        // rather than everything with a hat.
        if (!terms.every((term) => hay.includes(term))) continue
      }
      matched.push(item)
    }
    matched.sort(compareItems)
    return matched
  }, [items, atRiskOnly, terms, haystacks])

  // A changed filter means a changed list; start again from the top of it.
  useEffect(() => {
    setLimit(PAGE_SIZE)
  }, [terms, atRiskOnly, items])

  const visible = useMemo(() => filtered.slice(0, limit), [filtered, limit])

  /* More tiles as the member reaches the end of what is drawn. */
  useEffect(() => {
    if (filtered.length <= limit) return undefined
    const element = moreRef.current
    if (element === null || typeof IntersectionObserver === 'undefined') return undefined
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setLimit((previous) => previous + PAGE_SIZE)
            return
          }
        }
      },
      { rootMargin: '600px' }
    )
    observer.observe(element)
    return () => {
      observer.disconnect()
    }
  }, [filtered.length, limit])

  /* ---------------------------------------------------------------------- */
  /* The detail panel                                                        */
  /* ---------------------------------------------------------------------- */

  const openItem = useCallback((item: GalleryItem, opener: HTMLElement) => {
    setOpen({ folder: item.folder, opener })
  }, [])

  const closeItem = useCallback(() => {
    setOpen(null)
  }, [])

  /*
   * Held by folder name rather than by object, so a reload underneath an open
   * panel refreshes what it is showing instead of freezing it — and an NFT that
   * has genuinely gone from the archive closes the panel rather than leaving a
   * ghost of it on screen.
   */
  const openItemData = useMemo(() => {
    if (open === null || items === null) return null
    return items.find((candidate) => candidate.folder === open.folder) ?? null
  }, [open, items])

  useEffect(() => {
    if (open !== null && items !== null && openItemData === null) setOpen(null)
  }, [open, items, openItemData])

  /* ---------------------------------------------------------------------- */
  /* Counts                                                                  */
  /* ---------------------------------------------------------------------- */

  const total = items?.length ?? 0
  const flaggedCount = useMemo(() => {
    let count = 0
    for (const item of items ?? []) if (needsAttention(item)) count += 1
    return count
  }, [items])

  const filtering = terms.length > 0 || atRiskOnly
  const nothingChecked =
    items !== null && items.length > 0 && items.every((item) => item.network === 'unchecked')

  const clearFilters = useCallback(() => {
    setQuery('')
    setAtRiskOnly(false)
  }, [])

  /* ---------------------------------------------------------------------- */
  /* Render                                                                  */
  /* ---------------------------------------------------------------------- */

  return (
    <div className="view" ref={rootRef}>
      <ViewHeader
        title="Gallery"
        lead="Everything this archive holds, as it was meant to be seen. What carries a red or amber pill is what nobody else on the network is keeping — those are the ones worth acting on."
        actions={
          <button
            type="button"
            className="btn"
            onClick={reload}
            disabled={loading || archiveKey === null}
          >
            {loading ? 'Reading…' : 'Reload'}
          </button>
        }
      />

      {archiveKey === null ? (
        <EmptyState title="No archive is open">
          Open or create an archive first, and the NFTs inside it will show up here.
        </EmptyState>
      ) : (
        <>
          {error !== null && (
            <Banner
              tone={isCancellation(error) ? 'warn' : 'danger'}
              title={isCancellation(error) ? 'Stopped' : 'The gallery could not be read'}
              actions={
                <button type="button" className="btn btn-sm btn-primary" onClick={reload}>
                  Try again
                </button>
              }
            >
              {error}
            </Banner>
          )}

          {healthMoved && items !== null && (
            <Banner
              tone="info"
              title="There are newer health results"
              actions={
                <button type="button" className="btn btn-sm" onClick={reload}>
                  Reload the gallery
                </button>
              }
            >
              The network has been checked since this screen was filled in, so the pills below may be
              out of date.
            </Banner>
          )}

          {loading && items === null && (
            <div className="card row" aria-live="polite">
              <span className="spinner" aria-hidden="true" />
              <span className="grow">
                Reading the archive. Every picture in it is being looked at once to work out what
                kind of file it is — on a large collection this takes a few seconds. It is quick
                after that.
              </span>
            </div>
          )}

          {items !== null && items.length > 0 && (
            <section className="card stack" aria-label="Filter the gallery">
              {/* `.gallery-controls` is the toolbar row itself, not the card
                  around it — it is `display: flex`, so the count line below has
                  to sit outside it. */}
              <div className="gallery-controls">
                <label className="field gallery-search">
                  <span className="field-label" id="gallery-filter-label">
                    Search names, descriptions and traits
                  </span>
                  <input
                    className="input"
                    type="search"
                    value={query}
                    placeholder="GigaChad, blue background, #17…"
                    aria-labelledby="gallery-filter-label"
                    onChange={(event) => {
                      setQuery(event.target.value)
                    }}
                  />
                </label>

                {/* Same markup as the switches on the Settings screen, so it
                    looks and behaves identically. */}
                <label className="switch">
                  <input
                    type="checkbox"
                    className="switch__input"
                    checked={atRiskOnly}
                    onChange={(event) => {
                      setAtRiskOnly(event.target.checked)
                    }}
                  />
                  <span className="switch__track" aria-hidden="true">
                    <span className="switch__thumb" />
                  </span>
                  <span className="switch__text">
                    <span className="switch__label">Only what is at risk</span>
                    <span className="switch__hint">
                      {flaggedCount === 0
                        ? 'Nothing here is flagged at the moment.'
                        : `${formatCount(flaggedCount)} of ${formatCount(total)} ${
                            flaggedCount === 1 ? 'NFT is' : 'NFTs are'
                          } unreachable or at risk.`}
                    </span>
                  </span>
                </label>
              </div>

              <p className="small faint gallery-count" role="status" aria-live="polite">
                Showing {formatCount(visible.length)}
                {filtered.length > visible.length ? ` of ${formatCount(filtered.length)}` : ''}
                {filtering ? ` matching, out of ${formatCount(total)} in this archive` : ''}
                {!filtering && filtered.length <= visible.length
                  ? ` of ${formatCount(total)}`
                  : ''}
                .
                {filtering && (
                  <>
                    {' '}
                    <button type="button" className="btn-link" onClick={clearFilters}>
                      Clear the filters
                    </button>
                  </>
                )}
              </p>

              {atRiskOnly && nothingChecked && (
                <p className="small faint">
                  Nothing in this archive has been checked against the network yet, so nothing can be
                  flagged.{' '}
                  {goToHealth !== undefined && (
                    <button type="button" className="btn-link" onClick={goToHealth}>
                      Run a health check
                    </button>
                  )}
                </p>
              )}
            </section>
          )}

          {items !== null && items.length === 0 && (
            <EmptyState
              title="There is nothing in this archive yet"
              action={
                onAddTokens === undefined ? undefined : (
                  <button type="button" className="btn btn-primary btn-lg" onClick={onAddTokens}>
                    Add NFTs
                  </button>
                )
              }
            >
              Add some NFTs and the app will fetch their pictures, descriptions and traits into this
              archive — and they will appear here.
            </EmptyState>
          )}

          {items !== null && items.length > 0 && filtered.length === 0 && (
            <EmptyState
              title="Nothing matches"
              action={
                <button type="button" className="btn" onClick={clearFilters}>
                  Clear the filters
                </button>
              }
            >
              {atRiskOnly
                ? 'No NFT here is unreachable or at risk — for what has been checked, that is the good outcome.'
                : 'No NFT in this archive has that in its name, description or traits.'}
            </EmptyState>
          )}

          {visible.length > 0 && (
            <ul className="gallery-grid">
              {visible.map((item) => (
                <GalleryCard key={item.folder} item={item} onOpen={openItem} />
              ))}
            </ul>
          )}

          {filtered.length > visible.length && (
            <div className="gallery-more" ref={moreRef}>
              <button
                type="button"
                className="btn"
                onClick={() => {
                  setLimit((previous) => previous + PAGE_SIZE)
                }}
              >
                Show more ({formatCount(filtered.length - visible.length)} left)
              </button>
            </div>
          )}
        </>
      )}

      {openItemData !== null && (
        <NftDetail
          item={openItemData}
          onClose={closeItem}
          restoreFocusTo={open?.opener ?? null}
          {...(goToHealth === undefined ? {} : { onCheckHealth: goToHealth })}
        />
      )}
    </div>
  )
}

export default GalleryView
