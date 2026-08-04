/**
 * Electron main process.
 *
 * Creates the one window the app has, locks that window down (context
 * isolation on, Node off, a Content-Security-Policy that forbids anything
 * remote), and registers the IPC handlers that carry the archive engine's work
 * across to it.
 *
 * The window itself has no network access and no filesystem access. Every CID
 * fetch, every gateway call and every byte written to disk happens here, in the
 * main process, behind the typed bridge in `src/preload/index.ts`.
 */

import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { app, BrowserWindow, dialog, nativeTheme, session, shell, type WebContents } from 'electron'

import { MEDIA_SCHEME } from '../shared/community'
import { installMediaProtocol, registerMediaScheme } from './community/mediaProtocol'
import {
  cancelOperationsForWebContents,
  currentArchiveStore,
  registerIpcHandlers,
  shutdownIpc
} from './ipc'

const mainDir = fileURLToPath(new URL('.', import.meta.url))

/**
 * Without this, any uncaught throw in a main-process event handler pops
 * Electron's built-in error dialog — a raw stack trace and a file:// path — on
 * the member's desktop. That is precisely the thing this app is not supposed to
 * do to a non-technical user. Install before anything else so early failures
 * are covered too.
 *
 * Deliberately non-fatal: the app is a collection of discrete operations, so a
 * failed handler should cost the member that one operation, not the whole
 * session and whatever archive progress was in memory.
 */
function installCrashGuards(): void {
  process.on('uncaughtException', (error: unknown) => {
    console.error('[bic-archiver] uncaught exception in the main process:', error)
    if (!app.isReady()) return
    dialog.showErrorBox(
      'BIC Archiver hit a problem',
      'Something went wrong inside the app. The archive on disk has not been ' +
        'damaged, and you can carry on working.\n\nIf this keeps happening, ' +
        'please report it along with what you were doing at the time.'
    )
  })

  process.on('unhandledRejection', (reason: unknown) => {
    console.error('[bic-archiver] unhandled promise rejection:', reason)
  })
}

installCrashGuards()

/**
 * `bic-media://` has to be declared *before* the app is ready — Electron reads
 * the privileged-scheme list once, during startup, and a later call silently does
 * nothing. That is why this sits at module scope rather than inside
 * `whenReady()`: get it wrong and every picture in the gallery is a broken image
 * with no error to explain it.
 *
 * The handler that answers those requests is installed after ready, below.
 */
registerMediaScheme()

/** electron-vite sets this while `npm run dev` is running. */
const devServerUrl = process.env['ELECTRON_RENDERER_URL']
const isDev = devServerUrl !== undefined && devServerUrl !== '' && !app.isPackaged

/**
 * The one scheme the window is allowed to load pictures and video from, besides
 * its own bundle.
 *
 * The renderer has no filesystem and no Node, so it cannot read the archive's
 * blockstore; the main process serves those bytes over `bic-media://` and the
 * window just puts the URL in a `src`. Without this in `img-src` and `media-src`
 * every thumbnail is blocked — silently, as a console message the member will
 * never see.
 *
 * It is not remote. Requests on this scheme never leave the process: they are
 * answered from blocks already on this disk, by the handler in
 * `community/mediaProtocol.ts`, which serves nothing but a valid CID out of the
 * open archive. Nothing else in either policy is relaxed to accommodate it — in
 * particular `connect-src` is untouched, so the window still cannot `fetch()`
 * anything, and the handler sets its own `default-src 'none'; sandbox` policy on
 * every response so an SVG out of an NFT cannot run.
 */
const MEDIA_SRC = `${MEDIA_SCHEME}:`

/**
 * Kept in step with the `<meta http-equiv="Content-Security-Policy">` tag that
 * `electron.vite.config.ts` writes into `src/renderer/index.html` — including
 * `bic-media:` in `img-src` and `media-src`, which both policies need. The meta
 * tag is what protects the packaged app (`file://` responses never reach
 * `webRequest`); this header covers the dev server, where Vite's client and
 * React Fast Refresh need inline scripts and a websocket.
 */
const DEV_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  `img-src 'self' data: blob: ${MEDIA_SRC}`,
  `media-src 'self' data: blob: ${MEDIA_SRC}`,
  "font-src 'self' data:",
  "connect-src 'self' ws: wss: http://localhost:* http://127.0.0.1:*",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "frame-src 'none'",
  "base-uri 'none'",
  "form-action 'none'"
].join('; ')

const PROD_CSP = [
  "default-src 'none'",
  "script-src 'self' file:",
  "style-src 'self' file: 'unsafe-inline'",
  `img-src 'self' file: data: blob: ${MEDIA_SRC}`,
  `media-src 'self' file: data: blob: ${MEDIA_SRC}`,
  "font-src 'self' file: data:",
  "connect-src 'self' data: blob:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "frame-src 'none'",
  "base-uri 'none'",
  "form-action 'none'"
].join('; ')

let mainWindow: BrowserWindow | null = null
let shuttingDown = false

/* -------------------------------------------------------------------------- */
/* Hardening                                                                  */
/* -------------------------------------------------------------------------- */

function isInternalUrl(target: string): boolean {
  if (target.startsWith('file://')) return true
  if (devServerUrl === undefined || devServerUrl === '') return false
  try {
    return new URL(target).origin === new URL(devServerUrl).origin
  } catch {
    return false
  }
}

/**
 * The app never intends to open a browser by itself. Anything that tries is
 * either a link a member clicked or something unexpected; the first is worth
 * honouring for http(s), the second must not become a second Electron window
 * with a preload attached.
 */
function openExternalIfSafe(target: string): void {
  let parsed: URL
  try {
    parsed = new URL(target)
  } catch {
    return
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:' && parsed.protocol !== 'mailto:') return
  void shell.openExternal(parsed.toString()).catch((err: unknown) => {
    console.error('[bic-archiver] could not open a link in the browser', err)
  })
}

function hardenWebContents(contents: WebContents): void {
  contents.setWindowOpenHandler(({ url }) => {
    openExternalIfSafe(url)
    return { action: 'deny' }
  })

  contents.on('will-navigate', (event, url) => {
    if (isInternalUrl(url)) return
    event.preventDefault()
    openExternalIfSafe(url)
  })

  // Nothing in this app embeds anything, so an unexpected <webview> is a bug at
  // best and an escape hatch at worst.
  contents.on('will-attach-webview', (event) => {
    event.preventDefault()
  })

  contents.on('render-process-gone', (_event, details) => {
    console.error('[bic-archiver] the window stopped unexpectedly:', details.reason)
  })
}

function installSessionPolicies(): void {
  const defaultSession = session.defaultSession

  defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const headers: Record<string, string[]> = {}
    for (const [key, value] of Object.entries(details.responseHeaders ?? {})) {
      // Drop any CSP the dev server set so ours is the only one in play.
      if (key.toLowerCase() === 'content-security-policy') continue
      headers[key] = value
    }
    headers['Content-Security-Policy'] = [isDev ? DEV_CSP : PROD_CSP]
    callback({ responseHeaders: headers })
  })

  // A local archiving tool has no use for the camera, the microphone, the
  // clipboard or notifications. Refusing by default means a compromised
  // renderer cannot ask for them either.
  defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => {
    callback(false)
  })
  defaultSession.setPermissionCheckHandler(() => false)
  defaultSession.setDevicePermissionHandler(() => false)
}

/* -------------------------------------------------------------------------- */
/* The window                                                                 */
/* -------------------------------------------------------------------------- */

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 940,
    minHeight: 620,
    show: false,
    title: 'BIC Archiver',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#16181d' : '#f6f7f9',
    autoHideMenuBar: process.platform !== 'darwin',
    webPreferences: {
      preload: join(mainDir, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webviewTag: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false
    }
  })

  hardenWebContents(window.webContents)

  // Captured while the window is alive. The 'closed' handler below runs *after*
  // the native window and its webContents have been destroyed, so reading
  // `window.webContents` there throws "Object has been destroyed" — which, being
  // an uncaught throw in a main-process event handler, surfaces to the user as a
  // JavaScript error dialog on their desktop.
  const webContentsId = window.webContents.id

  // Showing only once the renderer has painted avoids the white flash that
  // makes a desktop app feel broken before it has even started.
  window.once('ready-to-show', () => {
    // Quitting during startup destroys the window before it ever paints; the
    // queued event still fires and show() would throw on the dead object.
    if (window.isDestroyed()) return
    window.show()
  })

  window.webContents.on('did-fail-load', (_event, code, description, url) => {
    console.error(`[bic-archiver] the window failed to load ${url}: ${description} (${code})`)
  })

  window.on('closed', () => {
    cancelOperationsForWebContents(webContentsId)
    if (mainWindow === window) mainWindow = null
  })

  if (isDev && devServerUrl !== undefined) {
    void window.loadURL(devServerUrl)
  } else {
    void window.loadFile(join(mainDir, '../renderer/index.html'))
  }

  return window
}

function showWindow(): void {
  if (mainWindow !== null && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
    return
  }
  mainWindow = createWindow()
}

/* -------------------------------------------------------------------------- */
/* Lifecycle                                                                  */
/* -------------------------------------------------------------------------- */

// A second copy of the app would open the same archive folder from a second
// process and both would write the manifest. One instance only.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    showWindow()
  })

  app.on('web-contents-created', (_event, contents) => {
    hardenWebContents(contents)
  })

  void app.whenReady().then(() => {
    app.setAppUserModelId('org.bic.archiver')
    installSessionPolicies()
    registerIpcHandlers()

    // Serves the gallery's pictures and video over `bic-media://`, straight out
    // of whichever archive is open. A getter rather than a store, so opening a
    // different archive needs no re-registration and a request that arrives with
    // none open is answered honestly instead of reading from a closed blockstore.
    installMediaProtocol(currentArchiveStore)

    showWindow()

    // macOS keeps the app running with no windows; clicking the dock icon
    // brings it back.
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) showWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  // Quitting mid-archive must not leave a half-written manifest or a locked
  // blockstore behind, so the close is awaited before the process exits.
  app.on('before-quit', (event) => {
    if (shuttingDown) return
    shuttingDown = true
    event.preventDefault()
    void shutdownIpc()
      .catch((err: unknown) => {
        console.error('[bic-archiver] could not shut down cleanly', err)
      })
      .finally(() => {
        app.exit(0)
      })
  })
}
