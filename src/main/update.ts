/**
 * The update check itself.
 *
 * One GET to a constant address, a version string read out of the answer, and a
 * sentence. See `src/shared/update.ts` for why this reports rather than
 * installs, and for the rule that the release link is our own constant and never
 * a field of the reply.
 *
 * Never throws. A member who is offline, behind a proxy, or being rate-limited
 * by GitHub gets "could not check" — which is true — instead of an error dialog
 * over a question they asked idly.
 */

import { UPDATE_SOURCE, UPDATE_TIMEOUT_MS, isNewer, type UpdateCheck } from '../shared/update.js'

const USER_AGENT = 'bic-archiver (update check)'

/** Ceiling on the reply we will read. A release body can be long; this is ample. */
const MAX_REPLY_BYTES = 1024 * 1024

/**
 * Has a newer version been published?
 *
 * @param current the running version, from `app.getVersion()`.
 */
export async function checkForUpdate(current: string, signal?: AbortSignal): Promise<UpdateCheck> {
  const base: UpdateCheck = {
    current,
    latest: null,
    newer: false,
    summary: '',
    url: UPDATE_SOURCE.releases
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), UPDATE_TIMEOUT_MS)
  if (typeof timer === 'object' && 'unref' in timer) timer.unref()
  const onAbort = (): void => controller.abort()
  signal?.addEventListener('abort', onAbort, { once: true })

  try {
    const response = await fetch(UPDATE_SOURCE.latest, {
      method: 'GET',
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': USER_AGENT
      },
      signal: controller.signal
    })

    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined)
      return {
        ...base,
        summary:
          response.status === 404
            ? 'No release has been published yet, so there is nothing newer to fetch.'
            : 'The list of releases could not be reached just now. Try again in a minute.'
      }
    }

    const text = await readCapped(response)
    if (text === null) {
      return { ...base, summary: 'The reply from GitHub was too large to read, so nothing changed.' }
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return { ...base, summary: 'The reply from GitHub could not be read, so nothing changed.' }
    }

    // Untrusted text from here down. One field is read, and it has to match a
    // strict version pattern before it is believed or shown.
    const tag =
      typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)['tag_name']
        : undefined

    if (typeof tag !== 'string' || tag.trim() === '') {
      return { ...base, summary: 'GitHub did not say which version is newest, so nothing changed.' }
    }

    const latest = tag.trim().replace(/^v/, '')
    if (!/^[\w.+-]{1,40}$/.test(latest)) {
      return { ...base, summary: 'GitHub named a version this app could not read, so nothing changed.' }
    }

    if (isNewer(latest, current)) {
      return {
        ...base,
        latest,
        newer: true,
        summary: `Version ${latest} is available. You are running ${current}.`
      }
    }

    return {
      ...base,
      latest,
      summary: `You are running ${current}, which is the newest version.`
    }
  } catch (err) {
    const stopped = signal?.aborted === true
    return {
      ...base,
      summary: stopped
        ? 'The check was stopped.'
        : err instanceof Error && err.name === 'AbortError'
          ? 'GitHub did not answer in time. Try again in a minute.'
          : 'The check could not run — this computer may be offline. Try again in a minute.'
    }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

/** Read a reply, refusing to buffer more than {@link MAX_REPLY_BYTES}. */
async function readCapped(response: Response): Promise<string | null> {
  const body = response.body
  if (body === null) return ''

  const chunks: Uint8Array[] = []
  let total = 0

  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    total += chunk.length
    if (total > MAX_REPLY_BYTES) {
      await body.cancel().catch(() => undefined)
      return null
    }
    chunks.push(chunk)
  }

  return Buffer.concat(chunks).toString('utf8')
}
