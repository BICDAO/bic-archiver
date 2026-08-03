/**
 * "Which NFTs do you want to keep?" — the whole of steps 5–8 of the old manual
 * instructions, in one box.
 *
 * Those steps had a member open OpenSea, click into the NFT, expand "Blockchain
 * details", click through to the token ID, then copy a hash without the
 * slashes. Here they paste whatever they already have — an OpenSea link, an
 * Etherscan link, or just the contract address and some token numbers — and the
 * app says, before they commit to anything, exactly what it read:
 * "12 tokens from 2 contracts".
 *
 * The second, deliberately quieter half folds a backup someone made earlier
 * into this archive by its content ID. It offers the DAO's own October 2025
 * backup as the example, with an honest warning that this particular backup
 * appears to be gone — which is the reason this app exists at all.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react'
import type { HealthResult, TokenInputSpec } from '../../shared/types'
import type { AddTokensResult, ArchiveSnapshot, MergeExistingResult } from '../../preload'
import {
  failUnfinishedProgress,
  getApi,
  setArchiveSnapshot,
  useArchive,
  useAsyncAction,
  useDebouncedValue
} from '../hooks'
import { Banner, Card, Pill, ViewHeader } from './Layout'
import { Cid } from './Cid'
import { ProgressList } from './ProgressList'

/* -------------------------------------------------------------------------- */
/* Facts about the world                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The DAO's October 2025 backup. Every gateway returns 504 for it and delegated
 * routing reports no providers, so pasting it here cannot work.
 *
 * The content itself is *not* lost: as of May 2026 the DAO keeps its backups as
 * `.car` files in Google Drive rather than relying on the IPFS network to hold
 * them. So this ID is shown as a caution, not as something to try — the working
 * route is Export ▸ "Read a backup someone sent you" with the `.car` from Drive.
 */
const OCT_2025_CID = 'bafybeidgu3wl7p6lggejzxcvzcbnwrbcatbgktcvk6aqfe3ficuhxwilym'

/** Matches the engine's own limit, so a member hears about it before waiting. */
const MAX_TOKENS_PER_RUN = 1000

/** How long after the last keystroke before the preview is worked out. */
const PREVIEW_DEBOUNCE_MS = 300

const CHAIN_NAMES: Record<number, string> = {
  1: 'Ethereum',
  10: 'Optimism',
  137: 'Polygon',
  8217: 'Klaytn',
  8453: 'Base',
  42161: 'Arbitrum',
  43114: 'Avalanche'
}

const EXPLORERS: Record<number, string> = {
  1: 'https://etherscan.io/address/',
  10: 'https://optimistic.etherscan.io/address/',
  137: 'https://polygonscan.com/address/',
  8217: 'https://kaiascan.io/account/',
  8453: 'https://basescan.org/address/',
  42161: 'https://arbiscan.io/address/',
  43114: 'https://snowtrace.io/address/'
}

/** Bored Ape Yacht Club — a real, live contract, so every example works. */
const EXAMPLE_CONTRACT = '0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d'

interface Example {
  text: string
  explains: string
}

const EXAMPLES: readonly Example[] = [
  {
    text: `https://opensea.io/assets/ethereum/${EXAMPLE_CONTRACT}/1`,
    explains: 'An OpenSea item link, copied straight out of your browser.'
  },
  {
    text: `https://etherscan.io/token/${EXAMPLE_CONTRACT}?a=1`,
    explains: 'An Etherscan link — the token number can be the ?a=1 on the end.'
  },
  {
    text: `${EXAMPLE_CONTRACT} 1-50`,
    explains: 'A contract address and a range: tokens 1 to 50, all fifty of them.'
  },
  {
    text: `${EXAMPLE_CONTRACT} 1, 2, 7-9`,
    explains: 'Single numbers and ranges together, separated by spaces or commas.'
  },
  {
    text: `${EXAMPLE_CONTRACT}/7`,
    explains: 'Contract and token number with a slash — or a colon — between them.'
  },
  {
    text: `polygon/${EXAMPLE_CONTRACT}/7`,
    explains:
      'Not on Ethereum? Put the network first: polygon, base, arbitrum, optimism, klaytn or avalanche.'
  }
]

/* -------------------------------------------------------------------------- */
/* Component                                                                  */
/* -------------------------------------------------------------------------- */

export interface AddTokensViewProps {
  /** The open archive. Left out, the one the engine reports is used. */
  snapshot?: ArchiveSnapshot
  /** Called with a fresh snapshot every time this screen changes the archive. */
  onSnapshot?: (snapshot: ArchiveSnapshot) => void
  /**
   * Somewhere to send a member once a run has finished — offered as a button
   * rather than taken automatically, so nobody is yanked away from a list of
   * problems they have not read yet.
   */
  onDone?: () => void
  /** Called after a run finishes, with what was archived. */
  onAdded?: (result: AddTokensResult) => void
  /** Called after an older backup has been folded in. */
  onMerged?: (result: MergeExistingResult) => void
  /**
   * Show the live progress panel inside this screen. Turn it off if the window
   * puts `<ProgressList />` somewhere else: both read the same event stream, so
   * both would work, but two lists is one too many.
   */
  showProgress?: boolean
  /** Offered as a button when no archive is open yet. */
  onNeedArchive?: () => void
  className?: string
}

type Preview =
  | { kind: 'empty' }
  | { kind: 'checking' }
  | { kind: 'error'; message: string }
  | {
      kind: 'ok'
      specs: TokenInputSpec[]
      tokenCount: number
      contractCount: number
      /** Set when it parsed but cannot be archived as it stands. */
      blocker: string | null
    }

export function AddTokensView(props: AddTokensViewProps): JSX.Element {
  const {
    snapshot,
    onSnapshot,
    onDone,
    onAdded,
    onMerged,
    showProgress = true,
    onNeedArchive,
    className
  } = props

  const archive = useArchive()
  const open = snapshot ?? archive.snapshot
  const hasArchive = open !== null

  const [text, setText] = useState('')
  const debouncedText = useDebouncedValue(text, PREVIEW_DEBOUNCE_MS)
  const [preview, setPreview] = useState<Preview>({ kind: 'empty' })
  const [opId, setOpId] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)

  const onSnapshotRef = useRef(onSnapshot)
  onSnapshotRef.current = onSnapshot
  const onAddedRef = useRef(onAdded)
  onAddedRef.current = onAdded
  const onMergedRef = useRef(onMerged)
  onMergedRef.current = onMerged

  /** Everything that changes the archive goes through here. */
  const publish = useCallback((next: ArchiveSnapshot) => {
    setArchiveSnapshot(next)
    onSnapshotRef.current?.(next)
  }, [])

  // Keep the shared store in step with the snapshot handed down, so the
  // progress rows can label themselves with real token names.
  useEffect(() => {
    if (snapshot !== undefined && snapshot !== archive.snapshot) setArchiveSnapshot(snapshot)
  }, [snapshot, archive.snapshot])

  /* --- live preview ------------------------------------------------------ */

  useEffect(() => {
    const trimmed = debouncedText.trim()
    if (trimmed === '') {
      setPreview({ kind: 'empty' })
      return undefined
    }

    let dropped = false
    setPreview({ kind: 'checking' })

    void getApi()
      .parseInput(trimmed)
      .then((result) => {
        if (dropped) return
        setPreview(result.ok ? summarize(result.value) : { kind: 'error', message: result.error })
      })

    return () => {
      dropped = true
    }
  }, [debouncedText])

  /** True while the member is still typing and the preview is out of date. */
  const settling = text.trim() !== '' && text !== debouncedText
  const readySpecs = preview.kind === 'ok' && preview.blocker === null ? preview.specs : null

  /* --- archiving --------------------------------------------------------- */

  const add = useAsyncAction(
    async (specs: TokenInputSpec[]) => {
      const api = getApi()
      const id = api.newOperationId()
      setOpId(id)
      try {
        return await api.addTokens(specs, id)
      } finally {
        setOpId(null)
      }
    },
    {
      onSuccess: (value) => {
        publish(value.snapshot)
        onAddedRef.current?.(value)
      },
      onError: (message) => {
        // The run ended without the engine closing its rows out — a cancelled
        // run never gets the chance. Say so rather than leave them spinning.
        failUnfinishedProgress(message)
        void archive.refresh()
      }
    }
  )

  const submit = useCallback(() => {
    if (readySpecs === null) return
    void add.run(readySpecs)
  }, [add, readySpecs])

  const insertExample = useCallback((example: string) => {
    setText((current) =>
      current.trim() === '' ? example : `${current.replace(/\s+$/, '')}\n${example}`
    )
    textareaRef.current?.focus()
  }, [])

  /* --- an older backup --------------------------------------------------- */

  const [mergeText, setMergeText] = useState('')
  const mergeInput = useMemo(() => readBackupCid(mergeText), [mergeText])

  const merge = useAsyncAction(
    async (cid: string) => {
      const api = getApi()
      const id = api.newOperationId()
      setOpId(id)
      try {
        return await api.mergeExisting(cid, id)
      } finally {
        setOpId(null)
      }
    },
    {
      onSuccess: (value) => {
        publish(value.snapshot)
        onMergedRef.current?.(value)
      },
      onError: (message) => {
        failUnfinishedProgress(message)
      }
    }
  )

  const probe = useAsyncAction(async (cid: string) => {
    const api = getApi()
    return api.checkHealth([{ cid, label: `Older backup ${shorten(cid)}` }], api.newOperationId())
  })

  const probeVerdict = probe.value?.results[0] ?? null
  const busy = add.pending || merge.pending || probe.pending

  /* --- render ------------------------------------------------------------ */

  return (
    <div className={classes('view', 'add-tokens', className)}>
      <ViewHeader
        title="Add NFTs"
        lead="Paste whatever you already have — an OpenSea link, an Etherscan link, or just the contract address and the token numbers. There is nothing to look up: the app reads the token's details straight from the blockchain, follows them to wherever the files live, and keeps a copy that can be checked later."
      />

      {archive.ready && !hasArchive ? (
        <Banner
          tone="info"
          title="Choose a folder first"
          actions={
            onNeedArchive !== undefined ? (
              <button type="button" className="btn btn-sm" onClick={onNeedArchive}>
                Choose a folder
              </button>
            ) : undefined
          }
        >
          An archive is a folder on this computer. Everything downloaded is kept inside it, so
          nothing can be archived until you have picked one.
        </Banner>
      ) : null}

      <Card
        title="What would you like to keep?"
        lead="One per line, or all on one line — as many collections at once as you like."
      >
        <div className="field">
          <label className="field-label" htmlFor="add-tokens-input">
            Paste links, contract addresses or token numbers
          </label>
          <textarea
            id="add-tokens-input"
            ref={textareaRef}
            className="textarea input-mono add-tokens__input"
            value={text}
            rows={7}
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="off"
            placeholder={`https://opensea.io/assets/ethereum/${EXAMPLE_CONTRACT}/1\n${EXAMPLE_CONTRACT} 1-50`}
            aria-describedby="add-tokens-preview"
            aria-invalid={preview.kind === 'error' ? true : undefined}
            onChange={(event) => {
              setText(event.target.value)
            }}
          />
          <div id="add-tokens-preview" className="stack stack-sm add-tokens__preview" role="status" aria-live="polite">
            <PreviewMessage preview={preview} settling={settling} />
          </div>
        </div>

        <div className="row">
          <button
            type="button"
            className="btn btn-primary btn-lg"
            disabled={readySpecs === null || !hasArchive || busy || settling}
            onClick={submit}
          >
            {add.pending
              ? 'Archiving…'
              : preview.kind === 'ok' && preview.blocker === null
                ? `Add ${plural(preview.tokenCount, 'NFT')} to the archive`
                : 'Add to archive'}
          </button>

          {text !== '' && !busy ? (
            <button
              type="button"
              className="btn"
              onClick={() => {
                setText('')
                add.reset()
              }}
            >
              Clear
            </button>
          ) : null}

          {add.pending ? (
            <span className="small muted">
              You can leave this screen — it keeps going, and you can stop it at any time.
            </span>
          ) : null}
        </div>

        {add.error !== null ? (
          <Banner
            tone={add.error.startsWith('Stopped at your request.') ? 'warn' : 'danger'}
            title={add.error.startsWith('Stopped at your request.') ? 'Stopped' : 'That did not work'}
            actions={
              <button type="button" className="btn btn-sm" onClick={add.reset}>
                Dismiss
              </button>
            }
          >
            {add.error}
          </Banner>
        ) : null}

        {add.value !== undefined && !add.pending ? (
          <Banner
            tone={add.value.failedCount > 0 ? 'warn' : 'ok'}
            title={add.value.failedCount > 0 ? 'Finished, with problems' : 'Done'}
            actions={
              <>
                {onDone !== undefined ? (
                  <button type="button" className="btn btn-sm" onClick={onDone}>
                    See what was archived
                  </button>
                ) : null}
                <button type="button" className="btn btn-sm" onClick={add.reset}>
                  Dismiss
                </button>
              </>
            }
          >
            {describeRun(add.value)}
          </Banner>
        ) : null}

        <details className="card card-quiet stack stack-sm add-tokens__help">
          <summary className="card-title">What can I paste?</summary>
          <p className="small muted">
            Any of these, mixed freely. Lines starting with <code>#</code> or <code>//</code> are
            ignored, so you can leave yourself notes.
          </p>
          <ul className="stack stack-sm add-tokens__examples">
            {EXAMPLES.map((example) => (
              <li key={example.text} className="row row-between add-tokens__example">
                <span className="grow">
                  <code className="input-mono">{example.text}</code>
                  <span className="small muted"> — {example.explains}</span>
                </span>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => {
                    insertExample(example.text)
                  }}
                >
                  Try it
                </button>
              </li>
            ))}
          </ul>
          <p className="small muted">
            A contract address is <code>0x</code> followed by 40 letters and numbers. An ENS name
            like <code>feistydao.eth</code> is not one — paste the <code>0x…</code> address from the
            collection&rsquo;s OpenSea or Etherscan page instead.
          </p>
          <p className="small muted">
            Up to {MAX_TOKENS_PER_RUN.toLocaleString('en-US')} NFTs at a time. For more than that,
            do it in batches: everything already archived stays archived.
          </p>
        </details>
      </Card>

      {showProgress ? (
        <ProgressList opId={opId} running={add.pending || merge.pending} title="What’s happening" />
      ) : null}

      {/* ---------------------------------------------------------------- */}
      {/* Secondary: fold in a backup somebody made earlier                 */}
      {/* ---------------------------------------------------------------- */}

      <section className="card card-quiet stack add-tokens__merge">
        <div>
          <h2 className="card-title">Already have an older backup?</h2>
          <p className="card-lead">
            If someone made a backup before — you will have a long content ID starting{' '}
            <code>bafy</code> or <code>Qm</code> — it can be folded into this archive, so one file
            holds everything.
          </p>
        </div>

        <Banner tone="warn" title="Older BIC content IDs will not work here">
          <>
            The DAO&rsquo;s October 2025 backup,{' '}
            <Cid cid={OCT_2025_CID} label="that backup's content ID" />, is no longer on the IPFS
            network — no computer is offering it and no public gateway will serve it — so pasting
            it here just fails after a minute or two of trying.
            <br />
            <br />
            <strong>The files themselves are safe.</strong> Since May 2026 the DAO keeps its
            backups as <code>.car</code> files in Google Drive instead of relying on the network to
            hold them. To fold an older backup in, download the newest <code>.car</code> from that
            folder, then go to <strong>Export</strong> ▸ <strong>Restore from a backup</strong> ▸{' '}
            <strong>Choose a .car file…</strong>. Content IDs are only worth pasting here when
            somebody is actively keeping that content online.
          </>
        </Banner>

        <div className="field">
          <label className="field-label" htmlFor="add-tokens-merge">
            Backup content ID
          </label>
          <input
            id="add-tokens-merge"
            className="input input-mono add-tokens__merge-input"
            type="text"
            value={mergeText}
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="off"
            placeholder={OCT_2025_CID}
            aria-invalid={mergeInput.error !== null ? true : undefined}
            onChange={(event) => {
              setMergeText(event.target.value)
            }}
          />
          <p className="field-hint">
            A gateway address or an <code>ipfs://…</code> link works too — the ID is taken out of
            it.
          </p>
          {mergeInput.error !== null ? (
            <p className="small">{mergeInput.error}</p>
          ) : null}
        </div>

        <div className="row">
          <button
            type="button"
            className="btn"
            disabled={mergeInput.cid === null || busy}
            onClick={() => {
              if (mergeInput.cid !== null) void probe.run(mergeInput.cid)
            }}
          >
            {probe.pending ? 'Checking…' : 'Check whether it is still online'}
          </button>

          <button
            type="button"
            className="btn"
            disabled={mergeInput.cid === null || !hasArchive || busy}
            onClick={() => {
              if (mergeInput.cid !== null) void merge.run(mergeInput.cid)
            }}
          >
            {merge.pending ? 'Adding the older backup…' : 'Add this backup to the archive'}
          </button>

          {probeVerdict !== null && !probe.pending ? (
            <Pill tone={verdictTone(probeVerdict)}>{VERDICT_LABEL[probeVerdict.verdict]}</Pill>
          ) : null}
        </div>

        {probe.error !== null ? (
          <Banner tone="danger" title="That check did not work">
            {probe.error}
          </Banner>
        ) : null}

        {probeVerdict !== null && !probe.pending ? (
          <Banner
            tone={verdictTone(probeVerdict)}
            title={VERDICT_TITLE[probeVerdict.verdict]}
            actions={
              <button type="button" className="btn btn-sm" onClick={probe.reset}>
                Dismiss
              </button>
            }
          >
            {describeVerdict(probeVerdict)}
          </Banner>
        ) : null}

        {merge.pending ? (
          <p className="small muted">
            Looking for that backup on the IPFS network. This can take a couple of minutes, and you
            can press Stop at any time.
          </p>
        ) : null}

        {merge.error !== null ? (
          <Banner
            tone="danger"
            title="That backup could not be added"
            actions={
              <button type="button" className="btn btn-sm" onClick={merge.reset}>
                Dismiss
              </button>
            }
          >
            {merge.error}
          </Banner>
        ) : null}

        {merge.value !== undefined && !merge.pending ? (
          <Banner tone="ok" title="Added">
            <>
              That backup is now part of this archive. Its fingerprint is now{' '}
              <Cid cid={merge.value.rootCid} label="this archive's fingerprint" />.
            </>
          </Banner>
        ) : null}
      </section>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Preview                                                                    */
/* -------------------------------------------------------------------------- */

function PreviewMessage(props: { preview: Preview; settling: boolean }): JSX.Element | null {
  const { preview, settling } = props

  if (preview.kind === 'empty') {
    return <p className="small muted">Nothing pasted yet.</p>
  }
  if (preview.kind === 'checking' || settling) {
    return <p className="small muted">Reading what you pasted…</p>
  }
  if (preview.kind === 'error') {
    return (
      <Banner tone="danger" title="I could not read that">
        {preview.message}
      </Banner>
    )
  }

  return (
    <>
      <div className="row">
        <Pill tone="info">
          {plural(preview.tokenCount, 'token')} from {plural(preview.contractCount, 'contract')}
        </Pill>
        {preview.blocker === null ? (
          <span className="small muted">Ready to archive.</span>
        ) : null}
      </div>

      <ul className="stack stack-sm">
        {preview.specs.map((spec) => (
          <li key={`${String(spec.chainId)}:${spec.contract}`} className="row">
            <Cid
              cid={spec.contract}
              label="the contract address"
              head={6}
              tail={4}
              href={explorerUrl(spec.chainId, spec.contract)}
              linkText="View contract"
              linkTitle="Open this contract in your web browser"
            />
            <span className="small muted">{chainName(spec.chainId)}</span>
            <span className="small">{describeIds(spec.tokenIds)}</span>
          </li>
        ))}
      </ul>

      {preview.blocker !== null ? (
        <Banner tone="warn" title="Almost — one thing missing">
          {preview.blocker}
        </Banner>
      ) : null}
    </>
  )
}

function summarize(specs: TokenInputSpec[]): Preview {
  let tokenCount = 0
  const missing: TokenInputSpec[] = []
  for (const spec of specs) {
    tokenCount += spec.tokenIds.length
    if (spec.tokenIds.length === 0) missing.push(spec)
  }

  let blocker: string | null = null
  const first = missing[0]
  if (first !== undefined) {
    blocker =
      missing.length === 1
        ? `Which token numbers from ${shorten(first.contract)} should be archived? Add them after the address — for example "${first.contract} 1-25".`
        : `${String(missing.length)} of those contracts have no token numbers yet. Add the numbers after each address — for example "${first.contract} 1-25".`
  } else if (tokenCount > MAX_TOKENS_PER_RUN) {
    blocker =
      `That is ${tokenCount.toLocaleString('en-US')} NFTs in one go, which is more than this app ` +
      `will archive at once. Do it in batches of up to ${MAX_TOKENS_PER_RUN.toLocaleString('en-US')} — ` +
      'everything you archive is kept, so you can carry on where you left off.'
  }

  return { kind: 'ok', specs, tokenCount, contractCount: specs.length, blocker }
}

function describeIds(tokenIds: readonly string[]): string {
  if (tokenIds.length === 0) return 'no token numbers yet'
  if (tokenIds.length <= 6) return `#${tokenIds.join(', #')}`
  const first = tokenIds[0]
  const last = tokenIds[tokenIds.length - 1]
  const range = first !== undefined && last !== undefined ? ` (#${first} to #${last})` : ''
  return `${tokenIds.length.toLocaleString('en-US')} tokens${range}`
}

/* -------------------------------------------------------------------------- */
/* The older-backup box                                                       */
/* -------------------------------------------------------------------------- */

interface BackupCidInput {
  /** The cleaned-up content ID, or null when there is nothing usable yet. */
  cid: string | null
  /** A plain-English problem to show, or null. */
  error: string | null
}

/**
 * Accept what a member is likely to have on the clipboard — `bafy…`,
 * `ipfs://bafy…/`, or a gateway address — and reduce it to the content ID. The
 * engine does the real validation; this only catches an obvious slip before a
 * minute of waiting.
 */
function readBackupCid(raw: string): BackupCidInput {
  const trimmed = raw.trim()
  if (trimmed === '') return { cid: null, error: null }

  let value = trimmed
  const gateway = /^https?:\/\/[^/]+\/ipfs\/(.+)$/i.exec(value)
  if (gateway !== null && gateway[1] !== undefined) value = gateway[1]
  value = value.replace(/^ipfs:\/\//i, '').replace(/^\/?ipfs\//i, '')
  value = value.replace(/[?#].*$/, '').replace(/\/+$/, '')

  const head = value.split('/')[0] ?? ''
  if (head === '') {
    return {
      cid: null,
      error:
        'I could not find a content ID in that. A content ID is one long run of letters and numbers, usually starting with "bafy" or "Qm".'
    }
  }
  if (!/^[A-Za-z0-9]+$/.test(head)) {
    return {
      cid: null,
      error: `"${shorten(head)}" is not a content ID. They are one long run of letters and numbers, with no spaces or punctuation in them.`
    }
  }
  if (head.length < 46) {
    return {
      cid: null,
      error: `"${head}" is too short to be a content ID. They are usually 46 characters or more, and start with "bafy" or "Qm".`
    }
  }

  return { cid: head, error: null }
}

const VERDICT_LABEL: Record<HealthResult['verdict'], string> = {
  healthy: 'Still online',
  'at-risk': 'At risk',
  unreachable: 'Cannot be found'
}

const VERDICT_TITLE: Record<HealthResult['verdict'], string> = {
  healthy: 'That backup is still out there',
  'at-risk': 'That backup is hanging on by a thread',
  unreachable: 'That backup cannot be found'
}

function verdictTone(result: HealthResult): 'ok' | 'warn' | 'danger' {
  if (result.verdict === 'healthy') return 'ok'
  if (result.verdict === 'at-risk') return 'warn'
  return 'danger'
}

function describeVerdict(result: HealthResult): string {
  const serving = result.gateways.filter((gateway) => gateway.ok).length

  if (result.verdict === 'healthy') {
    const who =
      result.providers > 0
        ? `${plural(result.providers, 'computer')} on the IPFS network ${result.providers === 1 ? 'is' : 'are'} offering it`
        : `${plural(serving, 'public gateway')} still ${serving === 1 ? 'has' : 'have'} it`
    return `${who}. Adding it to this archive should work.`
  }

  if (result.verdict === 'at-risk') {
    return (
      `${plural(serving, 'public gateway')} still ${serving === 1 ? 'has' : 'have'} this backup, but no computer on the ` +
      'IPFS network is announcing it any more. Add it now, while it is still there.'
    )
  }

  return (
    'No computer on the IPFS network is offering this backup, and no public gateway would serve ' +
    'it. Adding it will almost certainly fail. If a member still has the files, ask them to add ' +
    'and pin them again, or to send you their .car file so it can be imported directly instead.'
  )
}

/* -------------------------------------------------------------------------- */
/* Wording helpers                                                            */
/* -------------------------------------------------------------------------- */

function describeRun(result: AddTokensResult): string {
  const total = result.okCount + result.partialCount + result.failedCount
  if (total === 0) return 'Nothing was archived.'
  if (result.failedCount === 0 && result.partialCount === 0) {
    return `${plural(result.okCount, 'NFT')} archived, with everything they point at.`
  }

  const parts: string[] = []
  if (result.okCount > 0) parts.push(`${plural(result.okCount, 'NFT')} archived`)
  if (result.partialCount > 0) parts.push(`${String(result.partialCount)} archived with problems`)
  if (result.failedCount > 0) parts.push(`${String(result.failedCount)} could not be archived`)
  return `${parts.join(', ')}. The list below says what happened to each one.`
}

function chainName(chainId: number): string {
  return CHAIN_NAMES[chainId] ?? `Network ${String(chainId)}`
}

function explorerUrl(chainId: number, contract: string): string | undefined {
  const base = EXPLORERS[chainId]
  return base === undefined ? undefined : `${base}${contract}`
}

function plural(count: number, noun: string): string {
  return `${count.toLocaleString('en-US')} ${noun}${count === 1 ? '' : 's'}`
}

function shorten(value: string): string {
  return value.length <= 14 ? value : `${value.slice(0, 8)}…${value.slice(-4)}`
}

function classes(...parts: Array<string | undefined>): string {
  return parts.filter((part): part is string => part !== undefined && part !== '').join(' ')
}

export default AddTokensView
