/**
 * Build configuration for the three bundles this app is made of.
 *
 *   main     — the archive engine. Node, Electron and every IPFS library live
 *              here, and nowhere else.
 *   preload  — the typed bridge. CommonJS, because Electron's sandbox (which
 *              stays on) only loads CommonJS preload scripts.
 *   renderer — the window. React and nothing else; a guard plugin fails the
 *              build if anything from the main process tries to sneak in.
 */

import { builtinModules } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import type { Plugin } from 'vite'

const projectRoot = fileURLToPath(new URL('.', import.meta.url))
const rendererRoot = resolve(projectRoot, 'src/renderer')

/* -------------------------------------------------------------------------- */
/* Content-Security-Policy                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The packaged window loads over `file://`, which `session.webRequest` never
 * sees, so the policy has to travel in the HTML itself. `src/main/index.ts`
 * sets a matching header for the dev server; keep the two in step.
 *
 * `file:` is listed alongside `'self'` because a `file://` document has an
 * opaque origin, and `'self'` alone is not reliably matched against it across
 * Chromium versions. Everything remote is still refused, which is the point:
 * the window never talks to the network — the main process does.
 */
const PROD_CSP = [
  "default-src 'none'",
  "script-src 'self' file:",
  "style-src 'self' file: 'unsafe-inline'",
  "img-src 'self' file: data: blob:",
  "media-src 'self' file: data: blob:",
  "font-src 'self' file: data:",
  "connect-src 'self' data: blob:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "frame-src 'none'",
  "base-uri 'none'",
  "form-action 'none'"
].join('; ')

/** Vite's client and React Fast Refresh need inline scripts and a websocket. */
const DEV_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' ws: wss: http://localhost:* http://127.0.0.1:*",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "frame-src 'none'",
  "base-uri 'none'",
  "form-action 'none'"
].join('; ')

/** Swaps the `%CSP%` placeholder in index.html for the right policy. */
function cspPlugin(): Plugin {
  return {
    name: 'bic:csp',
    transformIndexHtml: {
      order: 'pre',
      handler(html, ctx) {
        return html.replace('%CSP%', ctx.server === undefined ? PROD_CSP : DEV_CSP)
      }
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Renderer isolation                                                         */
/* -------------------------------------------------------------------------- */

const NODE_BUILTINS = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)])

/** Packages that must never reach the window. */
const MAIN_ONLY_PACKAGES = [
  'electron',
  '@ipld/car',
  '@ipld/dag-pb',
  'blockstore-core',
  'blockstore-fs',
  'interface-blockstore',
  'ipfs-unixfs',
  'ipfs-unixfs-exporter',
  'ipfs-unixfs-importer',
  'multiformats'
]

/**
 * The renderer is supposed to reach the engine only through `window.api`. It is
 * very easy to break that by accident — dropping the `type` keyword off an
 * `import type { ArchiverApi } from '../preload'` is enough to drag Electron
 * into the browser bundle, where it silently fails at runtime.
 *
 * This turns that class of mistake into a build error naming the exact import.
 */
function rendererIsolationPlugin(): Plugin {
  const explain = (what: string, importer: string | undefined): string =>
    `The window bundle tried to include ${what}${importer !== undefined ? ` (imported by ${importer})` : ''}. ` +
    'Renderer code must reach the archive engine through window.api only. ' +
    'If this came from a type, write `import type { … }` so it is erased at build time.'

  return {
    name: 'bic:renderer-isolation',
    enforce: 'pre',
    resolveId(source, importer) {
      if (source.startsWith('\0')) return null
      const bare = source.split('?')[0] ?? source
      if (NODE_BUILTINS.has(bare)) {
        throw new Error(explain(`the Node built-in "${bare}"`, importer))
      }
      if (MAIN_ONLY_PACKAGES.some((name) => bare === name || bare.startsWith(`${name}/`))) {
        throw new Error(explain(`the main-process package "${bare}"`, importer))
      }
      return null
    },
    transform(_code, id) {
      const file = (id.split('?')[0] ?? id).replace(/\\/g, '/')
      if (file.includes('/src/main/')) {
        throw new Error(explain(`main-process source (${file})`, undefined))
      }
      return null
    }
  }
}

/* -------------------------------------------------------------------------- */

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: resolve(projectRoot, 'out/main'),
      rollupOptions: {
        input: { index: resolve(projectRoot, 'src/main/index.ts') },
        output: {
          // package.json is "type": "module" and points at out/main/index.js,
          // so the entry name is pinned rather than left to Vite's lib naming.
          format: 'es',
          entryFileNames: '[name].js',
          chunkFileNames: 'chunks/[name]-[hash].js'
        }
      }
    }
  },

  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: resolve(projectRoot, 'out/preload'),
      rollupOptions: {
        input: { index: resolve(projectRoot, 'src/preload/index.ts') },
        output: {
          // Electron's sandbox stays enabled, and a sandboxed preload script
          // can only be CommonJS. The `.cjs` extension is required because the
          // package is an ES module.
          format: 'cjs',
          entryFileNames: '[name].cjs',
          chunkFileNames: 'chunks/[name]-[hash].cjs'
        }
      }
    }
  },

  renderer: {
    root: rendererRoot,
    plugins: [react(), cspPlugin(), rendererIsolationPlugin()],
    build: {
      outDir: resolve(projectRoot, 'out/renderer'),
      emptyOutDir: true,
      rollupOptions: {
        input: { index: resolve(rendererRoot, 'index.html') }
      }
    }
  }
})
