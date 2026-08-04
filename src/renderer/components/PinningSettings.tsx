/**
 * Where the archive gets pinned — and why that is a different question from
 * where it is backed up.
 *
 * A .car file keeps the *bytes*. It does not keep a content ID *resolvable*. The
 * DAO's May 2026 backup proved the difference the hard way: 95% of it was still
 * being served by other people, and 428 content IDs were not — almost all of
 * them files BIC had rescued from Arweave or an ordinary website, where BIC was
 * the only party that ever pinned them. Twelve NFTs are now completely dark.
 *
 * That is why this screen exists, and why it is shaped the way it is:
 *
 *  • The local IPFS node comes first, not second. A pinning service can only
 *    fetch content somebody is still serving, so for content nobody serves any
 *    more a node of your own is not the DIY alternative — it is the only thing
 *    that makes the rescue possible at all. When the node is not running, the
 *    three commands that fix that are on screen, copyable, in order.
 *
 *  • Automatic pinning defaults to on, and the reason is stated rather than
 *    implied. Archiving without pinning is the exact sequence of events that
 *    lost the 428.
 *
 * SECURITY — the Pinata key.
 * The key is a bearer credential: anyone holding it can unpin the DAO's content
 * or spend its quota. It is typed into an uncontrolled input, read once on
 * submit, handed straight to the main process (which puts it in the operating
 * system's keychain) and the field is wiped immediately afterwards, success or
 * failure. It is never put in React state, never in a store, never in a URL,
 * never in `localStorage` or `sessionStorage`, and it is never read back — the
 * window only ever learns the boolean `hasToken`. If the computer has nowhere
 * safe to keep it, this screen says so plainly; there is deliberately no
 * "save it in a file anyway" option.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode
} from 'react'

import {
  DEFAULT_PINNING_SETTINGS,
  type PinTargetId,
  type PinTargetStatus,
  type PinningSettings as PinningSettingsValue
} from '../../shared/pinning'
import { getApi, useAsyncAction } from '../hooks'
import { Cid } from './Cid'
import { Banner, Card, Pill, ViewHeader } from './Layout'

/* ========================================================================== */
/* Small helpers                                                              */
/* ========================================================================== */

/** The three commands that get a working node on a Mac, in order. */
const KUBO_INSTALL = ['brew install kubo', 'ipfs init', 'ipfs daemon'].join('\n')

const KUBO_DOWNLOAD_URL = 'https://docs.ipfs.tech/install/command-line/'
const PINATA_KEYS_URL = 'https://app.pinata.cloud/developers/api-keys'

/**
 * Phrases the main process uses when this computer has nowhere safe to keep a
 * credential. Matching on them lets this screen answer in its own words rather
 * than repeating an explanation that mentions a "paste it each session" option
 * the window does not offer.
 */
const NO_SECURE_STORAGE_MARKERS = [
  'no secure place to keep the Pinata key',
  'not offering a real password store'
]

function isSecureStorageFailure(message: string | null | undefined): boolean {
  if (message === null || message === undefined) return false
  return NO_SECURE_STORAGE_MARKERS.some((marker) => message.includes(marker))
}

function findTarget(
  targets: PinTargetStatus[] | undefined,
  id: PinTargetId
): PinTargetStatus | null {
  if (targets === undefined) return null
  return targets.find((target) => target.target === id) ?? null
}

/**
 * Copy without assuming the async clipboard is there. Same belt-and-braces as
 * `Cid.tsx`: a dead copy button here would leave a member re-typing shell
 * commands by hand, which is how a typo becomes an hour of confusion.
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

/* ========================================================================== */
/* Building blocks                                                            */
/* ========================================================================== */

/** An address the window hands to the member's own browser. */
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

/** Commands to run in Terminal, with a button so nobody has to re-type them. */
function CommandBlock({ commands, label }: { commands: string; label: string }): ReactNode {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current)
    },
    []
  )

  const copy = useCallback(() => {
    void copyText(commands).then((ok) => {
      setState(ok ? 'copied' : 'failed')
      if (timer.current !== null) clearTimeout(timer.current)
      timer.current = setTimeout(() => {
        timer.current = null
        setState('idle')
      }, 1600)
    })
  }, [commands])

  return (
    <div className="codeblock">
      <pre className="codeblock__code" aria-label={label}>
        {commands}
      </pre>
      <div className="codeblock__foot">
        <button type="button" className="btn btn-sm" onClick={copy}>
          Copy these commands
        </button>
        <span className="small faint" role="status" aria-live="polite">
          {state === 'copied'
            ? 'Copied — paste them into Terminal.'
            : state === 'failed'
              ? 'Copying did not work. Select the text above and copy it.'
              : ''}
        </span>
      </div>
    </div>
  )
}

/** A labelled on/off switch. The whole row is the control. */
function Toggle({
  checked,
  onChange,
  label,
  hint,
  disabled = false
}: {
  checked: boolean
  onChange: (next: boolean) => void
  label: string
  hint?: ReactNode
  disabled?: boolean
}): ReactNode {
  return (
    <label className="switch">
      <input
        type="checkbox"
        className="switch__input"
        checked={checked}
        disabled={disabled}
        onChange={(event) => {
          onChange(event.target.checked)
        }}
      />
      <span className="switch__track" aria-hidden="true">
        <span className="switch__thumb" />
      </span>
      <span className="switch__text">
        <span className="switch__label">{label}</span>
        {hint !== undefined && <span className="switch__hint">{hint}</span>}
      </span>
    </label>
  )
}

/* ========================================================================== */
/* The view                                                                   */
/* ========================================================================== */

/** The fields this screen can change. Everything is optional in a patch. */
interface Draft {
  kuboEnabled: boolean
  kuboUrl: string
  pinataEnabled: boolean
  gateway: string
  pinOnImport: boolean
}

export default function PinningSettings(): ReactNode {
  /*
   * The form is held as separate fields rather than one settings object so a
   * save that lands while somebody is still typing cannot overwrite the box
   * under their cursor. Only the booleans and `hasToken` are taken from the
   * engine's reply; the two address fields are seeded once, on load.
   */
  const [kuboEnabled, setKuboEnabled] = useState(DEFAULT_PINNING_SETTINGS.kubo.enabled)
  const [kuboUrl, setKuboUrl] = useState(DEFAULT_PINNING_SETTINGS.kubo.apiUrl)
  const [pinataEnabled, setPinataEnabled] = useState(DEFAULT_PINNING_SETTINGS.pinata.enabled)
  const [gateway, setGateway] = useState('')
  const [pinOnImport, setPinOnImport] = useState(DEFAULT_PINNING_SETTINGS.pinOnImport)
  const [hasToken, setHasToken] = useState(false)

  const [loaded, setLoaded] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [tokenNotice, setTokenNotice] = useState<string | null>(null)

  const save = useAsyncAction((next: PinningSettingsValue) => getApi().saveSettings(next))
  const kuboProbe = useAsyncAction(() => getApi().pinTargets())
  const pinataProbe = useAsyncAction(() => getApi().pinTargets())
  const tokenSave = useAsyncAction((token: string) => getApi().setPinataToken(token))
  const tokenClear = useAsyncAction(() => getApi().clearPinataToken())

  /*
   * Uncontrolled on purpose. A controlled input would put the Pinata key into
   * React state on every keystroke, where it would sit until the component
   * re-rendered it away — and into any snapshot a dev tool or crash reporter
   * took in the meantime. This way the only copy is the DOM node's own value,
   * which is wiped the moment the key has been handed over.
   */
  const tokenField = useRef<HTMLInputElement | null>(null)
  const [tokenEntered, setTokenEntered] = useState(false)

  /* ---------------------------------------------------------------------- */
  /* Reading and writing the settings                                        */
  /* ---------------------------------------------------------------------- */

  const apply = useCallback((value: PinningSettingsValue, seedFields: boolean): void => {
    setKuboEnabled(value.kubo.enabled)
    setPinataEnabled(value.pinata.enabled)
    setPinOnImport(value.pinOnImport)
    setHasToken(value.pinata.hasToken)
    if (seedFields) {
      setKuboUrl(value.kubo.apiUrl)
      setGateway(value.pinata.gateway ?? '')
    }
  }, [])

  useEffect(() => {
    let alive = true
    void getApi()
      .getSettings()
      .then((result) => {
        if (!alive) return
        if (result.ok) apply(result.value, true)
        else setLoadError(result.error)
        setLoaded(true)
      })
    return () => {
      alive = false
    }
  }, [apply])

  /** Turn the form — plus whatever is being changed right now — into settings. */
  const compose = useCallback(
    (patch: Partial<Draft>): PinningSettingsValue => {
      const url = (patch.kuboUrl ?? kuboUrl).trim()
      const gatewayUrl = (patch.gateway ?? gateway).trim()
      const next: PinningSettingsValue = {
        kubo: {
          enabled: patch.kuboEnabled ?? kuboEnabled,
          apiUrl: url === '' ? DEFAULT_PINNING_SETTINGS.kubo.apiUrl : url
        },
        pinata: {
          enabled: patch.pinataEnabled ?? pinataEnabled,
          // Never sent from here — the engine recomputes it from the keychain
          // and its reply is what this screen believes.
          hasToken
        },
        pinOnImport: patch.pinOnImport ?? pinOnImport
      }
      if (gatewayUrl !== '') next.pinata.gateway = gatewayUrl
      return next
    },
    [gateway, hasToken, kuboEnabled, kuboUrl, pinOnImport, pinataEnabled]
  )

  /**
   * Change something and write it to disk.
   *
   * The switch moves first so the window feels immediate, and moves back if the
   * write fails — a control that shows "on" while the file on disk says "off"
   * is worse than a slow one.
   */
  const commit = useCallback(
    async (patch: Partial<Draft>): Promise<PinningSettingsValue | undefined> => {
      const before: Draft = { kuboEnabled, kuboUrl, pinataEnabled, gateway, pinOnImport }

      if (patch.kuboEnabled !== undefined) setKuboEnabled(patch.kuboEnabled)
      if (patch.kuboUrl !== undefined) setKuboUrl(patch.kuboUrl)
      if (patch.pinataEnabled !== undefined) setPinataEnabled(patch.pinataEnabled)
      if (patch.gateway !== undefined) setGateway(patch.gateway)
      if (patch.pinOnImport !== undefined) setPinOnImport(patch.pinOnImport)

      const result = await save.run(compose(patch))
      if (result === undefined) {
        setKuboEnabled(before.kuboEnabled)
        setKuboUrl(before.kuboUrl)
        setPinataEnabled(before.pinataEnabled)
        setGateway(before.gateway)
        setPinOnImport(before.pinOnImport)
        return undefined
      }
      apply(result, false)
      return result
    },
    [apply, compose, gateway, kuboEnabled, kuboUrl, pinOnImport, pinataEnabled, save]
  )

  /** Re-read `hasToken` from the keychain's own answer. */
  const refreshHasToken = useCallback(async (): Promise<void> => {
    const result = await getApi().getSettings()
    if (result.ok) apply(result.value, false)
  }, [apply])

  /* ---------------------------------------------------------------------- */
  /* Checking the two targets                                                */
  /* ---------------------------------------------------------------------- */

  /*
   * Both checks save first. `pin:targets` asks the engine, and the engine reads
   * the settings file — so checking without saving would test the address the
   * member had before they edited it, and report a confusing answer about a
   * node they are not pointing at.
   */
  const checkKubo = useCallback(async () => {
    const saved = await commit({})
    if (saved === undefined) return
    await kuboProbe.run()
  }, [commit, kuboProbe])

  const testPinata = useCallback(async () => {
    const saved = await commit({})
    if (saved === undefined) return
    await pinataProbe.run()
  }, [commit, pinataProbe])

  /* ---------------------------------------------------------------------- */
  /* The Pinata key                                                          */
  /* ---------------------------------------------------------------------- */

  const submitToken = useCallback(
    async (event: FormEvent<HTMLFormElement>): Promise<void> => {
      event.preventDefault()
      const field = tokenField.current
      if (field === null) return

      const entered = field.value.trim()
      if (entered === '') return

      setTokenNotice(null)
      tokenClear.reset()

      const result = await tokenSave.run(entered)

      /*
       * Wiped whatever happened. On success the engine has it; on failure the
       * failure is a computer that cannot keep a credential safely, which
       * re-pasting the same key will not fix. Either way, leaving a bearer
       * credential sitting in a DOM node is the one outcome worth avoiding.
       */
      field.value = ''
      setTokenEntered(false)

      if (result === undefined) return

      if (!pinataEnabled) {
        // Saving a key is an unambiguous "yes, use Pinata". Doing it silently
        // would be a surprise, so the confirmation says so out loud.
        setTokenNotice('Key saved, and Pinata has been switched on.')
        await commit({ pinataEnabled: true })
      } else {
        setTokenNotice('Key saved.')
        await refreshHasToken()
      }
    },
    [commit, pinataEnabled, refreshHasToken, tokenClear, tokenSave]
  )

  const removeToken = useCallback(async () => {
    setTokenNotice(null)
    tokenSave.reset()
    const result = await tokenClear.run()
    if (result === undefined) return
    setTokenNotice('The saved key has been removed from this computer.')
    await refreshHasToken()
  }, [refreshHasToken, tokenClear, tokenSave])

  /* ---------------------------------------------------------------------- */
  /* Render                                                                  */
  /* ---------------------------------------------------------------------- */

  const kuboStatus = findTarget(kuboProbe.value, 'kubo')
  const pinataStatus = findTarget(pinataProbe.value, 'pinata')
  const kuboUp = kuboStatus !== null && kuboStatus.available
  const nowhereToPin = !kuboEnabled && !pinataEnabled
  const secureStorageBroken = isSecureStorageFailure(tokenSave.error)

  return (
    <div className="view">
      <ViewHeader
        title="Settings"
        lead="A backup keeps the files. Pinning is what keeps them reachable — and the two are not the same thing. This is where you say who should be holding a copy."
      />

      {loadError !== null && (
        <Banner tone="danger" title="Your settings could not be read">
          {loadError} The choices below are the app's defaults until that is fixed.
        </Banner>
      )}

      {save.error !== null && (
        <Banner
          tone="danger"
          title="That setting was not saved"
          actions={
            <button type="button" className="btn btn-sm" onClick={save.reset}>
              Dismiss
            </button>
          }
        >
          {save.error}
        </Banner>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* Pin as you go                                                       */}
      {/* ------------------------------------------------------------------ */}

      <Card title="Pinning new content">
        <Toggle
          checked={pinOnImport}
          disabled={!loaded || save.pending}
          onChange={(next) => {
            void commit({ pinOnImport: next })
          }}
          label="Pin new content automatically"
          hint="Anything this app archives from now on is offered to the places switched on below, as it is archived."
        />

        <p className="muted">
          This is on by default, and the reason is not a preference. Of the 428 files this DAO has
          already lost, nearly every one was something BIC had rescued from Arweave or an ordinary
          website and saved to IPFS — content that nobody else on the network had any reason to
          keep. It was archived and never pinned, and one day it simply stopped answering. Twelve
          NFTs are now gone from the network entirely. Pinning as you go is what stops that
          happening a second time.
        </p>

        {nowhereToPin && (
          <Banner tone="warn" title="Nowhere to pin to yet">
            Both places below are switched off, so new content will be archived to this computer but
            not pinned anywhere. Switch on your own IPFS node — it needs no account and no key — or
            add a Pinata key.
          </Banner>
        )}
      </Card>

      {/* ------------------------------------------------------------------ */}
      {/* Kubo                                                                */}
      {/* ------------------------------------------------------------------ */}

      <Card title="Your own IPFS node">
        <Toggle
          checked={kuboEnabled}
          disabled={!loaded || save.pending}
          onChange={(next) => {
            void commit({ kuboEnabled: next })
          }}
          label="Keep a copy on a node running on this computer"
          hint="Free, needs no account, and it is the only route that can bring back content nothing else is serving."
        />

        <p className="muted">
          A pinning service can only fetch content that somebody is still offering, so when the last
          copy of a file has gone, a node of your own is the only thing that can put it back on the
          network for the service to collect.
        </p>

        <div className="field">
          <label className="field-label" htmlFor="kubo-api-url">
            Address of the node
          </label>
          <input
            id="kubo-api-url"
            className="input input-mono"
            type="text"
            inputMode="url"
            spellCheck={false}
            autoComplete="off"
            value={kuboUrl}
            placeholder={DEFAULT_PINNING_SETTINGS.kubo.apiUrl}
            disabled={!loaded}
            onChange={(event) => {
              setKuboUrl(event.target.value)
            }}
            onBlur={() => {
              void commit({})
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void checkKubo()
            }}
          />
          <p className="field-hint">
            {DEFAULT_PINNING_SETTINGS.kubo.apiUrl} is where a node on this computer normally listens.
            Change it only if you moved it, or if your node runs on another machine.
          </p>
        </div>

        <div className="row">
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => {
              void checkKubo()
            }}
            disabled={kuboProbe.pending || save.pending || !loaded}
          >
            {kuboProbe.pending ? 'Checking…' : 'Check connection'}
          </button>
          {kuboProbe.pending && <span className="spinner" aria-hidden="true" />}
        </div>

        <div aria-live="polite" className="stack stack-sm">
          {kuboProbe.error !== null && (
            <Banner tone="danger" title="The check could not run">
              {kuboProbe.error}
            </Banner>
          )}

          {kuboStatus !== null && kuboStatus.available && (
            <Banner tone="ok" title="Your node is running">
              <dl className="kv">
                <dt>Its name on the network</dt>
                <dd>
                  <Cid
                    value={kuboStatus.peerId ?? ''}
                    label="peer ID of your IPFS node"
                    head={12}
                    tail={6}
                  />
                </dd>
                <dt>Addresses others can reach it on</dt>
                <dd>
                  {kuboStatus.multiaddrs === undefined || kuboStatus.multiaddrs.length === 0 ? (
                    <span className="faint">
                      None that a pinning service could dial. Pinning to this node still works; a
                      service will not be able to fetch from it.
                    </span>
                  ) : (
                    <ul className="addr-list">
                      {kuboStatus.multiaddrs.map((addr) => (
                        <li key={addr} className="addr">
                          {addr}
                        </li>
                      ))}
                    </ul>
                  )}
                </dd>
              </dl>
              {kuboStatus.detail !== undefined && (
                <p className="small" style={{ marginTop: 10 }}>
                  {kuboStatus.detail}
                </p>
              )}
            </Banner>
          )}

          {kuboStatus !== null && !kuboStatus.available && (
            <Banner tone="warn" title="No node answered at that address">
              {kuboStatus.detail ??
                'Nothing responded there. The three commands below install a node and start it.'}
            </Banner>
          )}
        </div>

        {!kuboUp && (
          <div className="stack stack-sm">
            <p className="field-label">Getting a node running (macOS)</p>
            <CommandBlock
              commands={KUBO_INSTALL}
              label="Commands to install and start an IPFS node"
            />
            <p className="small muted">
              Run them in Terminal, one at a time. The last one keeps running — leave that window
              open while you pin, and the node is there again next time you run{' '}
              <code className="code-inline">ipfs daemon</code>. On Windows or Linux, download Kubo
              from <ExternalLink url={KUBO_DOWNLOAD_URL}>the IPFS install guide</ExternalLink> and
              then run <code className="code-inline">ipfs init</code> and{' '}
              <code className="code-inline">ipfs daemon</code>.
            </p>
          </div>
        )}
      </Card>

      {/* ------------------------------------------------------------------ */}
      {/* Pinata                                                              */}
      {/* ------------------------------------------------------------------ */}

      <Card title="Pinata">
        <Toggle
          checked={pinataEnabled}
          disabled={!loaded || save.pending}
          onChange={(next) => {
            void commit({ pinataEnabled: next })
          }}
          label="Keep a copy with Pinata as well"
          hint="A company that holds content on IPFS for you, so it stays reachable when this computer is off."
        />

        <p className="muted">
          Pinata fetches content from the network rather than from your disk, so on its own it
          cannot rescue anything that has already gone. Used together with the node above it can:
          the node puts the content back on the network, and Pinata collects it from there and keeps
          it. That pairing is what this app does for you.
        </p>

        {hasToken ? (
          <div className="stack stack-sm">
            <div className="row">
              <Pill tone="ok">A key is saved</Pill>
              <button
                type="button"
                className="btn btn-sm btn-danger"
                onClick={() => {
                  void removeToken()
                }}
                disabled={tokenClear.pending}
              >
                {tokenClear.pending ? 'Removing…' : 'Remove'}
              </button>
            </div>
            <p className="field-hint">
              The key itself is kept in this computer's keychain — never in the archive, never in
              this window, and never in any file you would send to another member. This app cannot
              read it back; it can only ask the operating system to use it or to forget it.
            </p>
          </div>
        ) : (
          <form className="stack stack-sm" onSubmit={(event) => void submitToken(event)}>
            <div className="field">
              <label className="field-label" htmlFor="pinata-token">
                Pinata access key (JWT)
              </label>
              <input
                id="pinata-token"
                ref={tokenField}
                className="input input-mono"
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder="Paste the key from Pinata"
                onChange={(event) => {
                  // Only whether the box has something in it is remembered.
                  // The key itself never leaves the input element.
                  setTokenEntered(event.target.value.trim() !== '')
                }}
              />
              <p className="field-hint">
                In Pinata, go to{' '}
                <ExternalLink url={PINATA_KEYS_URL}>API Keys</ExternalLink>, create a key, and copy
                the long <strong>JWT</strong> value. It goes straight into this computer's keychain —
                it is never written into the archive, and it never leaves this app.
              </p>
            </div>
            <div className="row">
              <button
                type="submit"
                className="btn btn-primary"
                disabled={!tokenEntered || tokenSave.pending}
              >
                {tokenSave.pending ? 'Saving…' : 'Save key'}
              </button>
            </div>
          </form>
        )}

        <div aria-live="polite" className="stack stack-sm">
          {tokenNotice !== null && (
            <Banner tone="ok" title="Done">
              {tokenNotice}
            </Banner>
          )}

          {secureStorageBroken && (
            <Banner tone="danger" title="This computer has nowhere safe to keep the key">
              Nothing has been saved. The key is a password to the DAO's Pinata account — anyone who
              could read it could unpin the DAO's content — so this app will not write it into an
              ordinary file, and there is no option to make it do so. On Linux this usually means
              your desktop's password store (GNOME Keyring or KWallet) is not running; starting it
              and trying again fixes it. In the meantime, pin to your own IPFS node instead: it needs
              no key at all.
            </Banner>
          )}

          {tokenSave.error !== null && !secureStorageBroken && (
            <Banner tone="danger" title="The key was not saved">
              {tokenSave.error}
            </Banner>
          )}

          {tokenClear.error !== null && (
            <Banner tone="danger" title="The key could not be removed">
              {tokenClear.error}
            </Banner>
          )}
        </div>

        <div className="field">
          <label className="field-label" htmlFor="pinata-gateway">
            Your Pinata gateway (optional)
          </label>
          <input
            id="pinata-gateway"
            className="input input-mono"
            type="text"
            inputMode="url"
            spellCheck={false}
            autoComplete="off"
            value={gateway}
            placeholder="https://yourname.mypinata.cloud"
            disabled={!loaded}
            onChange={(event) => {
              setGateway(event.target.value)
            }}
            onBlur={() => {
              void commit({})
            }}
          />
          <p className="field-hint">
            If your Pinata plan includes a gateway of your own, putting it here makes your pinned
            content load through it. Leave it empty otherwise — everything works without it.
          </p>
        </div>

        <div className="row">
          <button
            type="button"
            className="btn"
            onClick={() => {
              void testPinata()
            }}
            disabled={pinataProbe.pending || save.pending || !loaded}
          >
            {pinataProbe.pending ? 'Testing…' : 'Test'}
          </button>
          {pinataProbe.pending && <span className="spinner" aria-hidden="true" />}
        </div>

        <div aria-live="polite" className="stack stack-sm">
          {pinataProbe.error !== null && (
            <Banner tone="danger" title="The test could not run">
              {pinataProbe.error}
            </Banner>
          )}

          {pinataStatus !== null && pinataStatus.available && (
            <Banner tone="ok" title="Pinata accepted the key">
              {pinataStatus.detail ??
                'The key works. Content this app pins will be kept on the DAO’s Pinata account.'}
            </Banner>
          )}

          {pinataStatus !== null && !pinataStatus.available && (
            <Banner tone="warn" title="Pinata is not usable yet">
              {pinataStatus.detail ?? 'Pinata did not accept the key.'}
            </Banner>
          )}
        </div>
      </Card>

      {/* ------------------------------------------------------------------ */}
      {/* The short version                                                   */}
      {/* ------------------------------------------------------------------ */}

      <Card title="Why it takes both">
        <dl className="kv">
          <dt>Your own node</dt>
          <dd>
            Holds the actual bytes and announces to the network that it has them. This is what makes
            a dead content ID reachable again — nothing else can, because there is nothing left for
            anyone to fetch.
          </dd>
          <dt>Pinata</dt>
          <dd>
            Keeps a copy on machines that are always on, so the content stays reachable when your
            computer is asleep. It fetches from the network, which is why it needs your node running
            the first time a rescued file is pinned.
          </dd>
          <dt>Neither of them</dt>
          <dd>
            Is a substitute for the .car backup on the Export screen. The backup is the copy that
            survives an account being closed or a machine being wiped.
          </dd>
        </dl>
      </Card>
    </div>
  )
}
