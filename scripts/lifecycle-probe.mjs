/**
 * Verifies the window-lifecycle fix without putting anything on screen.
 *
 * Stubs BrowserWindow.prototype.show (so no window ever appears) and
 * dialog.showErrorBox (so a regression cannot pop a dialog on the user's
 * desktop the way the original bug did), then drives the real main process
 * through create -> ready-to-show -> close -> quit and reports any throw.
 */
import { app, BrowserWindow, dialog } from 'electron'

const failures = []

// Record instead of display.
dialog.showErrorBox = (title, content) => {
  failures.push(`showErrorBox: ${title} :: ${content}`)
}
BrowserWindow.prototype.show = function noopShow() {}

// Our own listener runs alongside the app's and captures the real error.
process.on('uncaughtException', (err) => {
  failures.push(`uncaughtException: ${err && err.message ? err.message : String(err)}`)
})

const hardStop = setTimeout(() => {
  failures.push('TIMEOUT: app never reached a clean quit')
  report()
  process.exit(1)
}, 25000)

function report() {
  clearTimeout(hardStop)
  console.log('PROBE_START')
  console.log(JSON.stringify({ ok: failures.length === 0, failures }, null, 2))
  console.log('PROBE_END')
}

// Load the real built main process.
await import('../out/main/index.js')

app.whenReady().then(async () => {
  // Give the app's own startup a moment to create its window.
  await new Promise((r) => setTimeout(r, 2500))

  const wins = BrowserWindow.getAllWindows()
  console.log(`windows created: ${wins.length}`)
  if (wins.length === 0) failures.push('the app created no window')

  // This is the path that crashed: closing fires 'closed', whose handler used
  // to read window.webContents on an already-destroyed object.
  for (const w of wins) w.close()

  await new Promise((r) => setTimeout(r, 1500))

  const left = BrowserWindow.getAllWindows().length
  console.log(`windows remaining after close: ${left}`)

  report()
  process.exit(failures.length === 0 ? 0 : 1)
})
