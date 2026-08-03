/**
 * A content ID (CID), shown the way a member can actually use it.
 *
 * The manual process this app replaces is full of copying hashes by hand out of
 * Etherscan and IPFS Desktop, and a hash pasted one character short is silently
 * wrong. So the value is never re-typed: the truncated form *is* the copy
 * button, the whole string is in the tooltip and read out to screen readers, and
 * the optional link opens the content in the member's own browser.
 *
 * Also used for plain `0x…` contract addresses — same problem, same
 * affordances — by passing `href` to point the link at a block explorer instead
 * of a gateway.
 *
 * Classes: `.cid`, `.cid__value`, `.cid__value--button`, `.cid__link`,
 * `.cid__status`, `.cid--empty`, `.cid__clipboard-holder`, plus
 * `[data-copied="yes"]` on the wrapper while the confirmation is showing.
 */

import { useCallback, useEffect, useRef, useState, type JSX } from 'react'
import { getApi } from '../hooks'

export interface CidProps {
  /** The CID, address, or `cid/path` to show. */
  cid?: string
  /** Alias of `cid`, for callers that prefer it. */
  value?: string
  /**
   * What this is, for the tooltip and screen readers — "archive fingerprint",
   * "contract address". Defaults to "content ID".
   */
  label?: string
  /** `lg` adds `cid--lg` for the one headline CID on a screen. */
  size?: 'sm' | 'lg'
  /** Characters kept at the start. Default 8, e.g. `bafybeid`. */
  head?: number
  /** Characters kept at the end. Default 4, e.g. `ilym`. */
  tail?: number
  /**
   * Gateway origin for an "Open" link, e.g. `https://ipfs.io`. Null (the
   * default) means no link: CIDs are usually listed densely, and a link on every
   * one of them is noise.
   */
  gateway?: string | null
  /** Overrides the link target entirely, e.g. an Etherscan address page. */
  href?: string
  /** Text of the link. Default "Open". */
  linkText?: string
  /** Tooltip on the link. Defaults to a sentence saying where it goes. */
  linkTitle?: string
  /** Set false for a plain, read-only value with no copying. Default true. */
  copyable?: boolean
  /** Extra classes on the wrapper. */
  className?: string
}

type CopyState = 'idle' | 'copied' | 'failed'

const COPY_RESET_MS = 1600

const IS_MAC =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/i.test(navigator.userAgent)

/** Middle-truncate: `bafybeid…ilym`. Short values are left whole. */
export function truncateCid(value: string, head = 8, tail = 4): string {
  const safeHead = Math.max(1, head)
  const safeTail = Math.max(0, tail)
  if (value.length <= safeHead + safeTail + 1) return value
  return `${value.slice(0, safeHead)}…${safeTail === 0 ? '' : value.slice(-safeTail)}`
}

/**
 * Copy without assuming the async clipboard is there. It normally is in
 * Electron, but a dead copy button would send a member back to copying hashes
 * out of a browser by hand — the very thing this app exists to stop.
 */
async function copyText(value: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard !== undefined) {
      await navigator.clipboard.writeText(value)
      return true
    }
  } catch {
    // Fall through to the old way.
  }
  try {
    const holder = document.createElement('textarea')
    holder.value = value
    holder.setAttribute('readonly', '')
    holder.className = 'cid__clipboard-holder'
    document.body.appendChild(holder)
    holder.select()
    const copied = document.execCommand('copy')
    document.body.removeChild(holder)
    return copied
  } catch {
    return false
  }
}

export function Cid(props: CidProps): JSX.Element {
  const {
    cid,
    value: valueProp,
    label = 'content ID',
    size = 'sm',
    head = 8,
    tail = 4,
    gateway = null,
    href,
    linkText = 'Open',
    linkTitle,
    copyable = true,
    className
  } = props

  const [state, setState] = useState<CopyState>('idle')
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current)
    },
    []
  )

  const raw = cid ?? valueProp ?? ''
  const full = typeof raw === 'string' ? raw.trim() : ''

  const copy = useCallback(() => {
    void copyText(full).then((ok) => {
      setState(ok ? 'copied' : 'failed')
      if (timer.current !== null) clearTimeout(timer.current)
      timer.current = setTimeout(() => {
        timer.current = null
        setState('idle')
      }, COPY_RESET_MS)
    })
  }, [full])

  if (full === '') {
    return <span className={classes('cid', 'cid--empty', className)}>not known yet</span>
  }

  const shown = truncateCid(full, head, tail)
  const url =
    href ?? (gateway === null ? null : `${gateway.replace(/\/+$/, '')}/ipfs/${encodePath(full)}`)

  return (
    <span
      className={classes('cid', size === 'lg' ? 'cid--lg' : undefined, className)}
      data-copied={state === 'copied' ? 'yes' : undefined}
    >
      {copyable ? (
        <button
          type="button"
          className="cid__value cid__value--button"
          title={`${full}\n\nClick to copy this ${label} in full.`}
          aria-label={`Copy ${label} ${full}`}
          onClick={copy}
        >
          {shown}
        </button>
      ) : (
        <>
          {/* The short form is for eyes; the full value is what a screen reader
              gets, because half a content ID is worthless. */}
          <span className="cid__value" title={full} aria-hidden="true">
            {shown}
          </span>
          <span className="sr-only">{`${label}: ${full}`}</span>
        </>
      )}

      {url === null ? null : (
        <a
          className="cid__link"
          href={url}
          title={linkTitle ?? `Open this ${label} in your web browser (${url})`}
          onClick={(event) => {
            // The window is the app; it must never navigate away from itself.
            // The main process hands the address to the member's own browser.
            event.preventDefault()
            void getApi().openExternal(url)
          }}
        >
          {linkText}
        </a>
      )}

      {copyable ? (
        <span className="cid__status" role="status" aria-live="polite">
          {state === 'copied' ? 'Copied' : state === 'failed' ? failedHint() : ''}
        </span>
      ) : null}
    </span>
  )
}

function failedHint(): string {
  return IS_MAC ? 'Press ⌘C' : 'Press Ctrl+C'
}

/** `cid/path/inside` — the CID is safe as-is, path segments may not be. */
function encodePath(value: string): string {
  return value
    .split('/')
    .map((segment, index) => (index === 0 ? segment : encodeURIComponent(segment)))
    .join('/')
}

function classes(...parts: Array<string | undefined>): string {
  return parts.filter((part): part is string => part !== undefined && part !== '').join(' ')
}

export default Cid
