/**
 * Captures the app's UI to PNG without ever putting a window on screen.
 *
 * BrowserWindow.prototype.show is stubbed, so the window stays hidden while
 * still rendering; capturePage() then grabs the composited frame. Useful for
 * docs and for eyeballing the GUI without interrupting whoever is at the
 * keyboard.
 *
 *   npm run build && npx electron scripts/screenshot.mjs [outDir]
 */
import { writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { app, BrowserWindow, dialog } from 'electron'

const outDir = process.argv[2] ?? 'screenshots'

dialog.showErrorBox = (t, c) => console.error(`[suppressed dialog] ${t}: ${c}`)
BrowserWindow.prototype.show = function noopShow() {}

process.on('uncaughtException', (e) => console.error('uncaught:', e))

await import('../out/main/index.js')

const VIEWS = ['add', 'archive', 'health', 'export']

app.whenReady().then(async () => {
  await mkdir(outDir, { recursive: true })
  await new Promise((r) => setTimeout(r, 3000))

  const win = BrowserWindow.getAllWindows()[0]
  if (!win) {
    console.error('no window was created')
    process.exit(1)
  }

  // The app opens on a welcome screen; the sidebar views only exist once an
  // archive is open. Calling window.api.createArchive directly is no good — the
  // React tree only updates when the UI itself initiates — so stub the native
  // folder picker and click the real button, exercising the genuine path.
  const archiveDir = join(outDir, 'demo-archive')
  await mkdir(archiveDir, { recursive: true })
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [archiveDir] })
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: join(outDir, 'demo.car') })

  const started = await win.webContents.executeJavaScript(
    `(() => {
       const name = document.querySelector('input[type="text"], input:not([type])');
       if (name) {
         const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
         setter.call(name, 'Demo archive');
         name.dispatchEvent(new Event('input', { bubbles: true }));
       }
       const btn = [...document.querySelectorAll('button')]
         .find(b => /choose an empty folder/i.test(b.textContent || ''));
       if (!btn) return 'button not found';
       btn.click();
       return 'clicked';
     })()`
  )
  console.log('start archive ->', started)
  await new Promise((r) => setTimeout(r, 2500))

  for (const view of VIEWS) {
    // Drive the sidebar by clicking the nav item whose text matches.
    const clicked = await win.webContents
      .executeJavaScript(
        `(() => {
           const wanted = ${JSON.stringify(view)};
           const els = [...document.querySelectorAll('button, a, [role="tab"], nav *')];
           const hit = els.find(e => (e.textContent || '').trim().toLowerCase().includes(wanted));
           if (hit) { hit.click(); return hit.textContent.trim(); }
           return null;
         })()`
      )
      .catch(() => null)
    console.log(`  ${view} -> nav hit: ${clicked ?? 'NONE'}`)

    await new Promise((r) => setTimeout(r, 900))
    const img = await win.webContents.capturePage()
    const file = join(outDir, `${view}.png`)
    await writeFile(file, img.toPNG())
    console.log(`wrote ${file}`)
  }

  process.exit(0)
})
