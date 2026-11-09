/**
 * Visual preview — renders the plugin's real UI in a real Chromium and writes
 * PNGs, so the panel can be checked at 2x instead of squinting at a status bar
 * that is 20 CSS px tall inside a 1456px screenshot.
 *
 * Usage:  node test/preview.mjs
 *
 * Everything (plugin + React + ReactDOM + the SDK stub) is bundled into ONE
 * ESM file: a single React instance is what makes hooks work, and a browser
 * cannot resolve bare specifiers or CJS without a bundler.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const depsRoot =
  process.env.HERMES_DEPS_ROOT || path.resolve(root, '..', 'AppData/Local/hermes/hermes-agent/node_modules')
const fromDeps = specifier => pathToFileURL(path.join(depsRoot, specifier)).href

const { build } = await import(fromDeps('esbuild/lib/main.js'))
// playwright-core's package entry is CJS; the ESM build is index.mjs.
const playwright = await import(fromDeps('playwright-core/index.mjs'))
const chromium = playwright.chromium ?? playwright.default?.chromium

const outDir = path.join(root, '.build')
const bundlePath = path.join(outDir, 'preview-bundle.mjs')
const entryPath = path.join(outDir, 'entry.js')
const pagePath = path.join(outDir, 'preview.html')

fs.rmSync(outDir, { recursive: true, force: true })
fs.mkdirSync(outDir, { recursive: true })

// The preview entry: mount the chip into a fake status bar, with a context that
// behaves like the host's (storage, files, i18n, contributions).
// A genuinely playable clip, generated here: a 0.4s 440Hz mono WAV. Embedding a
// real base64 blob would bloat the source and tie the test to one machine; a
// synthesised WAV decodes in any browser and is enough to prove playback.
function makeWavBase64(seconds = 0.4, rate = 22050, freq = 440) {
  const samples = Math.floor(seconds * rate)
  const buf = Buffer.alloc(44 + samples * 2)
  buf.write('RIFF', 0)
  buf.writeUInt32LE(36 + samples * 2, 4)
  buf.write('WAVE', 8)
  buf.write('fmt ', 12)
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20)
  buf.writeUInt16LE(1, 22)
  buf.writeUInt32LE(rate, 24)
  buf.writeUInt32LE(rate * 2, 28)
  buf.writeUInt16LE(2, 32)
  buf.writeUInt16LE(16, 34)
  buf.write('data', 36)
  buf.writeUInt32LE(samples * 2, 40)
  for (let i = 0; i < samples; i += 1) {
    const v = Math.sin((2 * Math.PI * freq * i) / rate) * 0.3 * 32767
    buf.writeInt16LE(Math.round(v), 44 + i * 2)
  }
  return buf.toString('base64')
}
// Prefer a real mp3 (matching what the import actually stores); fall back to a
// synthesised WAV so the suite still runs on a machine without ffmpeg.
async function makeMp3Base64() {
  const fsx = fs

  const { tmpdir } = await import('node:os')
  const dir = fsx.mkdtempSync(path.join(tmpdir(), 'sbclip-'))
  const wav = path.join(dir, 'a.wav')
  const mp3 = path.join(dir, 'a.mp3')
  try {
    fsx.writeFileSync(wav, Buffer.from(makeWavBase64(0.6), 'base64'))
    const { execFileSync } = await import('node:child_process')
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', wav, '-b:a', '64k', mp3], { stdio: 'ignore' })
    return fsx.readFileSync(mp3).toString('base64')
  } catch {
    return null
  } finally {
    fsx.rmSync(dir, { recursive: true, force: true })
  }
}
// Prefer the clip a real import produced on this machine: it is the artefact
// that failed. Falls back to a generated mp3, then a WAV, so the suite runs
// anywhere.
function realStoredClip() {
  try {
    const dir = path.join(process.env.APPDATA || '', 'Hermes/plugin-files/data/hermes-soundboard')
    if (!fs.existsSync(dir)) return null
    const b64 = fs.readdirSync(dir).filter(n => n.endsWith('.b64'))
    for (const name of b64) {
      const text = fs.readFileSync(path.join(dir, name), 'utf8').replace(/\s+/g, '')
      if (text.length > 2000) return text
    }
  } catch {}
  return null
}
const STORED = realStoredClip()
if (STORED) console.log(`test clip: real stored clip (${STORED.length} chars)`)
const MP3_B64 = STORED ?? (await makeMp3Base64())
const WAV_B64 = MP3_B64 ?? makeWavBase64()
console.log(`test clip: ${MP3_B64 ? 'real mp3' : 'synthesised wav'}`)

fs.writeFileSync(
  entryPath,
  `
import { createRoot } from 'react-dom/client'
import { jsx } from 'react/jsx-runtime'
import plugin from ${JSON.stringify(path.join(root, 'plugin.js').replace(/\\/g, '/'))}
import { registerPluginI18n } from ${JSON.stringify(path.join(here, 'sdk-stub.mjs').replace(/\\/g, '/'))}

// shell.exec is session-bound; stand in for an open chat.
window.__hermesTestSessionId = 'preview-session'
// A REAL 2.3s mp3 (base64), so the import's result can actually be played and
// not merely rendered. Fake bytes would make every playback assertion vacuous.
window.__realClip = ${JSON.stringify(WAV_B64)}
const memory = new Map()
// The plugin's data folder, emulated: path -> text/marker.
window.__files = new Map()
// plugin.js calls host.request from the SDK stub, which refuses unless a
// handler is registered here. Stand in for the gateway's shell door.
window.__shellCalls = []
window.__hermesHostRequest = async (method, params) => {
  const command = params?.command ?? ''
  if (/where ffmpeg/.test(command)) return { blocked: false, code: 0, stdout: 'ffmpeg=1\\nuvx=1\\n' }
  if (/--print duration/.test(command)) return { blocked: false, code: 0, stdout: '19\\n' }
  window.__shellCalls.push(command)
  return { blocked: false, code: 0, stdout: '' }
}
const contributions = {}
let settingsPage = null

const ctx = {
  source: 'plugin:hermes-soundboard',
  i18n: {
    // The host resolves usePluginI18n against the bundle registered here.
    register: bundle => registerPluginI18n(plugin.id, bundle),
    t: (key, ...args) => {
      const value = window.__locales && window.__locales.en && window.__locales.en[key]
      return typeof value === 'function' ? value(...args) : (value === undefined ? key : value)
    }
  },
  storage: {
    get: (key, fallback) => (memory.has(key) ? JSON.parse(memory.get(key)) : fallback),
    set: (key, value) => memory.set(key, JSON.stringify(value)),
    remove: key => memory.delete(key)
  },
  files: {
    dataFolder: 'data',
    readText: async (_folder, path) => {
      const job = window.__pendingJob
      if (job && path.endsWith('.status')) {
        job.tries += 1
        // Complete on the third poll (~1.4s), so the bar is visible first.
        if (job.tries >= 3) {
          window.__files.set(job.stem + '.mp3', 'FAKE')
          window.__pendingJob = null
          return { ok: true, text: 'ok', size: 2, mtimeMs: 0 }
        }
        return { ok: false, error: 'not-found', message: 'pending' }
      }
      return window.__files.has(path)
        ? { ok: true, text: window.__files.get(path), size: window.__files.get(path).length, mtimeMs: 0 }
        : { ok: false, error: 'not-found', message: 'no ' + path }
    },
    writeText: async (_folder, path, text) => {
      window.__files.set(path, text)
      // Stand in for the detached job: as soon as the script lands, produce the
      // mp3 and the status file it would write.
      if (path.endsWith('.cmd')) {
        const stem = path.replace(/^\./, '').replace(/\.cmd$/, '')
        window.__script = text
        // yt-dlp's real progress lines, so the poll loop has something to read.
        window.__files.set(path.replace(/\\.cmd$/, '.log'), '[download]  37.5% of 1.0MiB' + String.fromCharCode(10))
        // Hold the status back briefly: this is what makes the bar observable
        // instead of a single skipped frame.
        window.__pendingJob = { stem, tries: 0 }
      }
      return { ok: true, path, size: text.length, mtimeMs: 0 }
    },
    // Mirror the desktop host: mimeFor() only maps IMAGE extensions, so an .mp3
    // is labelled application/octet-stream. Returning 'audio/mpeg' here would
    // hide the bug that made an imported pad silent until a plugin reload.
    readDataUrl: async (_folder, path) =>
      path.endsWith('.mp3')
        ? { ok: true, url: 'data:application/octet-stream;base64,' + window.__realClip }
        : { ok: false, error: 'not-found', message: path },
    trash: async (_folder, path) => {
      window.__files.delete(path)
      return { ok: true }
    },
    folders: async () => [],
    requestFolder: async () => ({ ok: false, error: 'unavailable', message: 'preview' })
  },
  notify: opts => console.log('[notify]', opts && opts.message),
  // Gateway event stream, exposed so the suite can push a real event through.
  onEvent: (type, listener) => {
    window.__events ??= {}
    window.__events[type] ??= []
    window.__events[type].push(listener)
    return () => {}
  },
  onDispose: () => {},
  register: c => { contributions[c.id] = c },
  registerMany: list => { for (const c of list) contributions[c.id] = c },
  registerSettingsPage: page => { settingsPage = page },
  setTimeout, setInterval, addEventListener: () => () => {},
  os: {}, pet: { visible: false, say: () => () => {}, clear: () => {} }
}

const realRegister = ctx.i18n.register
ctx.i18n.register = bundle => { window.__locales = bundle; realRegister(bundle) }

plugin.register(ctx)
window.__contrib = contributions
window.__settingsPage = settingsPage

const chip = contributions.chip
createRoot(document.getElementById('chip')).render(jsx(chip.render, {}))

// The settings page renders in its own mount, opened on demand.
window.__mountSettings = () => {
  const host = document.getElementById('settings-host')
  host.hidden = false
  createRoot(host).render(settingsPage.render())
}
window.__ready = true
`
)

await build({
  absWorkingDir: root,
  entryPoints: [entryPath],
  outfile: bundlePath,
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['chrome110'],
  logLevel: 'silent',
  define: { 'process.env.NODE_ENV': '"production"' },
  alias: { '@hermes/plugin-sdk': path.join(here, 'sdk-stub.mjs') },
  nodePaths: [depsRoot]
})

// The app's own dark palette (ui-* + the chrome tokens this plugin touches),
// so what renders here is what the window shows.
const THEME = `
  :root{
    --ui-bg-editor:#17130f; --ui-bg-elevated:#231d18; --ui-bg-quaternary:#2b241e;
    --ui-base:#efe6d8;
    /* MIRROR THE REAL THEME. In apps/desktop/src/styles.css these are
       color-mix(accent N%, color-mix(base M%, transparent)) — and the inner
       'transparent' propagates, so the result is ~7-18% alpha, NOT a solid hex.
       Hardcoding an opaque value here is how a see-through dropdown shipped
       unnoticed: the preview looked correct while the app did not. */
    --ui-bg-tertiary:color-mix(in srgb, var(--ui-accent) 5%, color-mix(in srgb, var(--ui-base) 5%, transparent));
    --ui-bg-secondary:color-mix(in srgb, var(--ui-accent) 10%, color-mix(in srgb, var(--ui-base) 7%, transparent));
    --ui-text-primary:#efe6d8; --ui-text-secondary:#c3b6a4; --ui-text-tertiary:#948878;
    --ui-text-quaternary:#6f6558; --ui-accent:#dcae58; --ui-red:#e06a5b;
    --ui-stroke-secondary:#3b322a; --ui-stroke-tertiary:#2e271f;
    --chrome-action-hover:#332b23;
    --font-mono:ui-monospace,SFMono-Regular,Menlo,monospace;
    color-scheme: dark;
  }
  *{box-sizing:border-box}
  html,body{margin:0;height:100%}
  body{font-family:Inter,system-ui,-apple-system,"Segoe UI",sans-serif;background:var(--ui-bg-editor);color:var(--ui-text-primary)}
  #stage{position:relative;width:100%;height:100%}
  .fake-editor{position:absolute;inset:0 0 22px 0;display:flex;align-items:center;justify-content:center;
    color:var(--ui-text-quaternary);font-size:12px;letter-spacing:.04em}
  .fake-statusbar{position:absolute;left:0;right:0;bottom:0;height:22px;display:flex;align-items:center;
    justify-content:flex-end;gap:2px;padding:0 8px;background:var(--ui-bg-tertiary);
    border-top:1px solid var(--ui-stroke-tertiary);font-size:11px;color:var(--ui-text-tertiary)}
  .fake-item{display:inline-flex;align-items:center;gap:3px;padding:0 5px;height:100%;color:var(--ui-text-quaternary)}
  #settings-host{position:absolute;left:24px;top:24px;width:400px;padding:18px;border-radius:8px;
    background:var(--ui-bg-elevated);box-shadow:0 8px 30px #0008}
  /* Radix positions the popover in the app (side="top" align="end", portalled,
     collision-aware); the test stub renders it inline, so this reproduces that
     placement — pinned to the window's bottom-right like the real thing. */
  .hermes-sb-panel{position:fixed;right:8px;bottom:28px;width:308px;background:var(--ui-bg-elevated);
    border:1px solid var(--ui-stroke-secondary);border-radius:8px;padding:8px;
    box-shadow:0 10px 32px #0009;z-index:10;
    /* The real PopoverContent carries backdrop-blur-md. A backdrop-filter makes
       this element the CONTAINING BLOCK for position:fixed descendants, so any
       fixed-positioned child anchors here instead of the viewport. Reproducing
       it in the stub is what makes this harness able to catch that class of bug
       — without it a fixed menu measured correctly here and rendered off-screen
       in the app. */
    backdrop-filter:blur(12px)}
  svg{width:1em;height:1em;display:block}
  button{font:inherit;border:0;background:none;cursor:pointer;padding:0;color:inherit}
  input{font:inherit}
`

fs.writeFileSync(
  pagePath,
  `<!doctype html>
<html><head><meta charset="utf-8"><style>${THEME}</style></head>
<body><div id="stage">
  <div class="fake-editor" style="pointer-events:none">Hermes Desktop — status bar preview</div>
  <div id="settings-host" hidden></div>
  <div class="fake-statusbar">
    <span class="fake-item">VOX FM 128</span>
    <span id="chip"></span>
    <span class="fake-item">42%</span>
    <span class="fake-item">GPU 8% · 2G/12G</span>
    <span class="fake-item">v0.22.6+637</span>
  </div>
</div>
<script type="module">
import './preview-bundle.mjs'
</script>
</body></html>`
)

// The borrowed playwright-core asks for a chromium build that may not be the
// one present on this machine. Pick an installed chrome.exe and pass it
// explicitly; HERMES_CHROME overrides.
function findChrome() {
  if (process.env.HERMES_CHROME) return process.env.HERMES_CHROME
  const roots = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    path.join(process.env.LOCALAPPDATA ?? '', 'ms-playwright'),
    path.join(process.env.HOME ?? '', '.cache', 'ms-playwright')
  ].filter(Boolean)
  for (const base of roots) {
    if (!fs.existsSync(base)) continue
    // A full chromium build, never the headless shell: the shell has no
    // window chrome and its font stack differs.
    for (const dir of fs.readdirSync(base).filter(name => /^chromium-\d+$/.test(name))) {
      for (const candidate of [
        path.join(base, dir, 'chrome-win64', 'chrome.exe'),
        path.join(base, dir, 'chrome-linux', 'chrome'),
        path.join(base, dir, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium')
      ]) {
        if (fs.existsSync(candidate)) return candidate
      }
    }
  }
  return undefined
}

const browser = await chromium.launch({ executablePath: findChrome(), args: ['--force-color-profile=srgb'] })
const context = await browser.newContext({
  viewport: { width: 420, height: 560 },
  deviceScaleFactor: 2,
  colorScheme: 'dark',
  // The import pipeline branches on the platform (cmd / start / doubled %), so
  // the page must look like the machine it targets. Without this the UI hides
  // the feature and every import fails with "no plugin folder".
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
})
const page = await context.newPage()
page.on('console', message => {
  if (message.type() === 'error' || message.type() === 'warning') {
    console.log(`[page:${message.type()}] ${message.text()}`)
  }
})
page.on('pageerror', error => console.log(`[page:error] ${error.message}`))

// file:// pages cannot import ESM modules (CORS), so the preview is served from
// a throwaway loopback HTTP server on the .build folder.
const http = await import('node:http')
const MIME = { '.html': 'text/html', '.mjs': 'text/javascript', '.js': 'text/javascript', '.png': 'image/png' }
const server = http.createServer((request, response) => {
  const name = decodeURIComponent((request.url ?? '/').split('?')[0]).replace(/^\/+/, '') || 'preview.html'
  const file = path.join(outDir, name)
  if (!file.startsWith(outDir) || !fs.existsSync(file)) {
    response.writeHead(404).end('not found')
    return
  }
  response.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream' })
  fs.createReadStream(file).pipe(response)
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`

await page.goto(`${origin}/preview.html`)
await page.waitForSelector('#chip button', { timeout: 5000 })
await page.waitForTimeout(250)

const shot = async (name, options) => {
  const file = path.join(outDir, name)
  await page.screenshot({ path: file, ...options })
  console.log(`wrote ${file}`)
  return file
}

await shot('preview-statusbar.png', { clip: { x: 0, y: 480, width: 420, height: 80 } })

// Open the panel the way a user does: click the chip.
await page.click('#chip button')
await page.waitForSelector('.hermes-sb-panel', { timeout: 5000 })
await page.waitForTimeout(350)
await shot('preview-panel.png')

const pads = await page.$$eval('.hermes-sb-pad:has(.hermes-sb-pad-name)', nodes =>
  nodes.map(node => {
    const rect = node.getBoundingClientRect()
    return {
      name: node.querySelector('.hermes-sb-pad-name')?.textContent,
      meta: node.getAttribute('data-custom') ? 'file' : 'tone',
      key: node.querySelector('.hermes-sb-pad-key')?.textContent,
      box: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) }
    }
  })
)

const boxOf = selector =>
  page.$eval(selector, node => {
    const rect = node.getBoundingClientRect()
    return { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) }
  })

const chipBox = await boxOf('#chip button')
const panelBox = await boxOf('.hermes-sb-panel')
const gridBox = await boxOf('.hermes-sb-grid')
const titleBox = await boxOf('.hermes-sb-head-title')
const footBox = await boxOf('.hermes-sb-foot')
const sliderBox = await boxOf('.hermes-sb-foot input[type=range]')

console.log('\nchip  ', JSON.stringify(chipBox))
console.log('panel ', JSON.stringify(panelBox))
console.log('title ', JSON.stringify(titleBox))
const headBox = await boxOf('.hermes-sb-head')
console.log('head  ', JSON.stringify(headBox), 'panel x', panelBox.x)
const titleCS = await page.evaluate(() => {
  const el = document.querySelector('.hermes-sb-head-title')
  const cs = getComputedStyle(el)
  const head = getComputedStyle(document.querySelector('.hermes-sb-head'))
  return { pl: cs.paddingLeft, ml: cs.marginLeft, headPl: head.paddingLeft, headGap: head.columnGap }
})
console.log('title cs', JSON.stringify(titleCS))
console.log('grid  ', JSON.stringify(gridBox))
console.log('foot  ', JSON.stringify(footBox))
console.log('slider', JSON.stringify(sliderBox))

// Anchors: the title, the grid and the volume row must share a left edge. The
// title's RIGHT edge is not the panel's — the head's three icon buttons own
// that column, by design — so only the left edge is compared.
const leftGap = [titleBox, gridBox, footBox].map(box => box.x - panelBox.x)
const rightGap = [gridBox, footBox].map(box => panelBox.x + panelBox.w - (box.x + box.w))
console.log(`left insets  ${leftGap.join(' / ')}`)
console.log(`right insets ${rightGap.join(' / ')}`)
if (Math.max(...leftGap) - Math.min(...leftGap) > 4) console.log('!! left edges disagree by more than 4px')
if (Math.max(...rightGap) - Math.min(...rightGap) > 4) console.log('!! right edges disagree by more than 4px')
console.log(`pads  ${pads.length}`)
for (const pad of pads) {
  console.log(
    `  ${String(pad.key ?? '-').padEnd(2)} ${String(pad.name ?? '?').padEnd(10)} ${String(pad.meta ?? '').padEnd(8)} ${JSON.stringify(pad.box)}`
  )
}

// Layout facts from real geometry, not from reading a screenshot.
const columns = new Set(pads.map(pad => pad.box.x)).size
const rows = new Set(pads.map(pad => pad.box.y)).size
console.log(`grid: ${columns} columns x ${rows} rows`)
if (columns < 2) console.log('!! pads are NOT laid out in a grid')

const overflow = panelBox.x < 0 || panelBox.y < 0 || panelBox.x + panelBox.w > 420 || panelBox.y + panelBox.h > 560
if (overflow) console.log(`!! panel overflows the 420x560 viewport: ${JSON.stringify(panelBox)}`)

// ── the setup (export / import) row ─────────────────────────────────────
// Measured, not eyeballed: two controls that must share the volume row's left
// anchor, keep the panel's 21px control height, and stay INSIDE the panel.
const setupRow = await page.evaluate(() => {
  const panel = document.querySelector('.hermes-sb-panel')
  const box = document.querySelector('.hermes-sb-setup')
  if (!box) return null
  const p = panel.getBoundingClientRect()
  const b = box.getBoundingClientRect()
  const buttons = [...box.querySelectorAll('.hermes-sb-setup-btn')].map(n => {
    const r = n.getBoundingClientRect()
    return { label: n.textContent.trim(), w: Math.round(r.width), h: Math.round(r.height), y: Math.round(r.y) }
  })
  const foot = document.querySelector('.hermes-sb-foot')?.getBoundingClientRect()
  return {
    panel: { x: Math.round(p.x), y: Math.round(p.y), w: Math.round(p.width), h: Math.round(p.height) },
    box: { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) },
    buttons,
    footExportX: foot ? Math.round(foot.x) : null,
    note: document.querySelector('.hermes-sb-setup-note')?.textContent ?? '',
    noteInset: (() => {
      const note = document.querySelector('.hermes-sb-setup-note')
      if (!note) return null
      return Math.round(note.getBoundingClientRect().left - b.left)
    })(),
    noteLines: (() => {
      const note = document.querySelector('.hermes-sb-setup-note')
      if (!note) return 0
      const style = getComputedStyle(note)
      return Math.round(note.getBoundingClientRect().height / parseFloat(style.lineHeight))
    })(),
    gap: (() => {
      const note = document.querySelector('.hermes-sb-setup-note')
      if (!note) return null
      return Math.round(p.bottom - note.getBoundingClientRect().bottom)
    })(),
    // A control that paints past the panel edge is the geometry bug this
    // measurement exists to catch.
    inside: b.x >= p.x - 1 && b.x + b.width <= p.x + p.width + 1 && b.y + b.height <= p.y + p.height + 1
  }
})
console.log(`setup row: ${JSON.stringify(setupRow)}`)
if (!setupRow) console.log('!! the setup row is missing from the panel')
else {
  if (setupRow.buttons.length !== 2) console.log(`!! expected 2 setup buttons, got ${setupRow.buttons.length}`)
  if (new Set(setupRow.buttons.map(b => b.h)).size > 1) {
    console.log(`!! setup buttons disagree on height: ${setupRow.buttons.map(b => b.h)}`)
  }
  if (new Set(setupRow.buttons.map(b => b.y)).size > 1) {
    console.log(`!! setup buttons sit on different baselines: ${setupRow.buttons.map(b => b.y)}`)
  }
  if (!setupRow.inside) console.log('!! the setup row overflows the panel')
  if (!setupRow.note) console.log('!! the setup row has no hint line')
  // The hint sits on the same left axis as the row's label (2px inset + its own
  // 4px padding); more than that is a line floating on no axis at all.
  if (setupRow.noteInset !== null && (setupRow.noteInset < 0 || setupRow.noteInset > 6)) {
    console.log(`!! the hint line starts ${setupRow.noteInset}px from the row's left anchor`)
  }
  if (setupRow.noteLines > 1) console.log(`!! the hint wraps onto ${setupRow.noteLines} lines in a 308px panel`)
  if (setupRow.gap !== null && setupRow.gap < 2) console.log(`!! the hint has only ${setupRow.gap}px of bottom padding`)
}
// The plan is rendered by the component, so open it through the real input.
const planJson = await page.evaluate(() =>
  JSON.stringify({
    format: 'hermes-soundboard-setup',
    version: 1,
    settings: { volume: 55, showLabel: true, padsPerRow: 4, oneAtATime: false },
    sounds: [
      { name: 'Shared one', kind: 'synth', synth: 'pop', triggers: ['turn.complete'] },
      { name: 'Shared two', kind: 'synth', synth: 'ding', gain: 140 }
    ]
  })
)
fs.writeFileSync(path.join(outDir, 'shared.json'), planJson)
await page.locator('.hermes-sb-panel input[type=file][accept*="json"]').setInputFiles(
  path.join(outDir, 'shared.json')
)
await page.waitForSelector('.hermes-sb-setup-plan', { timeout: 4000 })
const planBox = await page.evaluate(() => {
  const panel = document.querySelector('.hermes-sb-panel').getBoundingClientRect()
  const plan = document.querySelector('.hermes-sb-setup-plan')
  const p = plan.getBoundingClientRect()
  const mode = document.querySelector('.hermes-sb-setup-mode')
  const primary = document.querySelector('.hermes-sb-setup-confirm button[data-primary="true"]')
  return {
    plan: { x: Math.round(p.x), y: Math.round(p.y), w: Math.round(p.width), h: Math.round(p.height) },
    panel: { h: Math.round(panel.height), bottom: Math.round(panel.bottom) },
    title: document.querySelector('.hermes-sb-setup-plan-title')?.textContent ?? '',
    modes: document.querySelectorAll('.hermes-sb-setup-mode').length,
    selected: document.querySelector('.hermes-sb-setup-mode[data-selected="true"]')?.textContent ?? '',
    primary: primary?.textContent ?? '',
    modeH: mode ? Math.round(mode.getBoundingClientRect().height) : null,
    // The checkbox and its label must be adjacent: a gap wide enough to read as
    // an orphaned control is the failure this measures.
    checkGap: (() => {
      const box = document.querySelector('.hermes-sb-setup-check input')
      const label = document.querySelector('.hermes-sb-setup-check span')
      if (!box || !label) return null
      return Math.round(label.getBoundingClientRect().left - box.getBoundingClientRect().right)
    })(),
    checkAlign: (() => {
      const label = document.querySelector('.hermes-sb-setup-check span')
      return label ? getComputedStyle(label).textAlign : null
    })(),
    // The legacy `align` attribute maps to text-align; the SDK stub must not
    // pass Radix's positioning props through to the DOM sitting under test.
    panelAlignAttr: document.querySelector('.hermes-sb-panel')?.getAttribute('align') ?? null,
    // Nothing is applied before the confirm button is pressed: the board must
    // still be the seven built-ins the page started with.
    padsBefore: [...document.querySelectorAll('.hermes-sb-pad-name')].map(n => n.textContent).length,
    inside: p.x >= panel.x - 1 && p.x + p.width <= panel.x + panel.width + 1 && p.bottom <= panel.bottom + 1
  }
})
console.log(`plan block: ${JSON.stringify(planBox)}`)
if (planBox.modes !== 2) console.log(`!! expected an add/replace choice, got ${planBox.modes} modes`)
if (!/Add to this board/.test(planBox.selected)) console.log(`!! the safe mode is not preselected (${planBox.selected})`)
if (!/^Add 2 pads/.test(planBox.primary)) console.log(`!! the confirm button misstates the count (${planBox.primary})`)
if (!planBox.inside) console.log('!! the plan block overflows the panel')
if (planBox.checkGap !== null && planBox.checkGap > 8) {
  console.log(`!! the settings checkbox is ${planBox.checkGap}px from its own label`)
}
if (planBox.checkAlign && planBox.checkAlign !== 'start') {
  console.log(`!! the settings label is ${planBox.checkAlign}-aligned, not flush with its box`)
}
if (planBox.panelAlignAttr) {
  console.log(`!! the popover stub leaked align="${planBox.panelAlignAttr}" into the DOM (text-align)` )
}
if (planBox.panel.bottom > 560) console.log(`!! the panel grows past the viewport with a plan open (bottom ${planBox.panel.bottom})`)
await shot('preview-setup.png')

// Dismissing the plan must change nothing on the board.
await page.click('.hermes-sb-setup-confirm button:not([data-primary])')
await page.waitForTimeout(150)
const dismissed = await page.evaluate(() => ({
  plan: Boolean(document.querySelector('.hermes-sb-setup-plan')),
  pads: [...document.querySelectorAll('.hermes-sb-pad-name')].length
}))
console.log(`plan dismissed: ${JSON.stringify(dismissed)}`)
if (dismissed.plan) console.log('!! the plan block stayed open after Cancel')
if (dismissed.pads !== planBox.padsBefore) console.log('!! cancelling an import changed the board')

// Manage mode.
await page.click('.hermes-sb-panel button[aria-label="Manage sounds"]')
await page.waitForTimeout(250)
await shot('preview-manage.png')
console.log(`manage rows: ${await page.$$eval('.hermes-sb-row', nodes => nodes.length)}`)

// ── triggers, measured in a real browser ────────────────────────────────
// The picker is an in-DOM button + menu, so unlike a native <select> its list
// CAN be measured and screenshotted. That is the whole reason it exists.
const pickers = await page.$$eval('.hermes-sb-picker', nodes =>
  nodes.map(node => ({
    label: node.getAttribute('aria-label'),
    text: node.textContent.trim(),
    expanded: node.getAttribute('aria-expanded'),
    box: (() => {
      const r = node.getBoundingClientRect()
      return { w: Math.round(r.width), h: Math.round(r.height), y: Math.round(r.y) }
    })()
  }))
)
console.log(`trigger pickers: ${pickers.length}`)
if (pickers.length) console.log(`  first: "${pickers[0].text}" ${pickers[0].box.w}x${pickers[0].box.h} @y${pickers[0].box.y}`)

// Open the first picker and measure the LIST itself.
await page.click('.hermes-sb-picker')
await page.waitForSelector('.hermes-sb-menu', { timeout: 3000 })
const menu = await page.evaluate(() => {
  const node = document.querySelector('.hermes-sb-menu')
  const row = node.querySelector('.hermes-sb-menu-row')
  const heading = node.querySelector('.hermes-sb-menu-heading')
  const style = getComputedStyle(node)
  const rowStyle = getComputedStyle(row)
  const headingStyle = getComputedStyle(heading)
  const r = node.getBoundingClientRect()
  return {
    rows: node.querySelectorAll('.hermes-sb-menu-row').length,
    headings: [...node.querySelectorAll('.hermes-sb-menu-heading')].map(h => ({
      text: h.textContent.trim(),
      h: Math.round(h.getBoundingClientRect().height),
      w: Math.round(h.getBoundingClientRect().width),
      fontSize: getComputedStyle(h).fontSize
    })),
    groups: node.querySelectorAll('.hermes-sb-menu-group').length,
    background: style.backgroundColor,
    border: style.borderColor,
    box: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
    row: { color: rowStyle.color, background: rowStyle.backgroundColor },
    heading: { color: headingStyle.color, background: headingStyle.backgroundColor }
  }
})
const luminance = css => {
  const parts = css.match(/[\d.]+/g)
  if (!parts || parts.length < 3) return null
  const [r, g, b] = parts.slice(0, 3).map(Number).map(v => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
const contrastOn = (fg, bg) => {
  const [a, b] = [luminance(fg), luminance(bg)].sort((x, y) => y - x)
  return a == null || b == null ? null : (a + 0.05) / (b + 0.05)
}
const menuRatio = contrastOn(menu.row.color, menu.background)
const headingRatio = contrastOn(menu.heading.color, menu.background)
console.log(`  menu bg ${menu.background} (${menu.box.w}x${menu.box.h} @ ${menu.box.x},${menu.box.y})`)
console.log(`  ${menu.rows} rows in ${menu.groups} groups`)
console.log(`  headings: ${JSON.stringify(menu.headings)}`)
console.log(`  row text ${menu.row.color} → ${menuRatio?.toFixed(2)}:1 on the menu surface`)
console.log(`  group label ${menu.heading.color} → ${headingRatio?.toFixed(2)}:1`)
if (!/^rgb/.test(menu.background) || menu.background.includes('rgba(0, 0, 0, 0)')) console.log('!! the menu has no opaque background')
if (menuRatio !== null && menuRatio < 4.5) console.log(`!! menu row text fails 4.5:1 (${menuRatio.toFixed(2)})`)
if (headingRatio !== null && headingRatio < 3) console.log(`!! group label fails 3:1 (${headingRatio.toFixed(2)})`)
if (menu.rows !== 14) console.log(`!! expected 14 trigger rows, got ${menu.rows}`)
if (menu.box.y + menu.box.h > 560) {
  // The menu is legitimately taller than the list's window now that it has no
  // inner scroll of its own; the LIST scrolls it. What must hold is that the
  // list can actually reach the menu's bottom.
  const reachable = await page.evaluate(() => {
    const list = document.querySelector('.hermes-sb-list')
    const node = document.querySelector('.hermes-sb-menu')
    if (!list || !node) return false
    return list.scrollHeight >= node.getBoundingClientRect().height
  })
  if (!reachable) console.log('!! the menu is taller than the list can scroll')
}
// The menu must be INSIDE the panel and on screen. A fixed-positioned menu
// anchored to a backdrop-filtered popover still reports a plausible width, so
// check containment in the panel's own box — this is what catches that bug.
const hostBox = await page.$eval('.hermes-sb-panel', node => {
  const r = node.getBoundingClientRect()
  return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
})
const escaped =
  menu.box.x < hostBox.x - 1 ||
  menu.box.x + menu.box.w > hostBox.x + hostBox.w + 1 ||
  menu.box.y < hostBox.y - 1
console.log(`  menu inside the panel (${hostBox.x},${hostBox.y} ${hostBox.w}x${hostBox.h}): ${!escaped}`)
if (escaped) console.log('!! the menu escapes the panel box — it is being re-anchored by an ancestor (backdrop-filter / transform)')
if (menu.box.w < 200) console.log(`!! the menu is only ${menu.box.w}px wide — it is confined to the picker's box, not the row's`)
await shot('preview-menu.png')

// ── a picker low in the list must still reach its last row ──────────────
// Reported: opening the trigger list on a row near the bottom left the menu
// unscrollable to its end. Cause was two nested scroll containers — the menu had
// its own max-height/overflow inside the manage list, and both set
// overscroll-behavior:contain, so the chain never passed outward.
const reach = await page.evaluate(async () => {
  const rows = [...document.querySelectorAll('.hermes-sb-row')]
  if (rows.length < 2) return { error: 'not enough rows to test the last one' }
  // Close whatever is open, then open the picker on the LAST row.
  const open = document.querySelector('.hermes-sb-menu')
  if (open) open.closest('.hermes-sb-when')?.querySelector('.hermes-sb-picker')?.click()
  const last = rows[rows.length - 1].querySelector('.hermes-sb-picker')
  last.click()
  await new Promise(r => setTimeout(r, 250))
  const menu = document.querySelector('.hermes-sb-menu')
  if (!menu) return { error: 'the menu did not open on the last row' }
  const style = getComputedStyle(menu)
  const list = document.querySelector('.hermes-sb-list')
  // Measure WITHOUT scrolling by hand: the picker must bring its own menu into
  // view, otherwise opening one low in the board reveals a menu below the fold.
  const autoBox = menu.getBoundingClientRect()
  const autoView = list.getBoundingClientRect()
  const autoTopVisible = autoBox.top >= autoView.top - 1
  // Then scroll the list to its end, as a wheel would, and require the whole
  // menu — including the conditional Never button — to be reachable.
  list.scrollTop = list.scrollHeight
  await new Promise(r => setTimeout(r, 250))
  const listBox = list.getBoundingClientRect()
  const items = [...menu.querySelectorAll('.hermes-sb-menu-row')]
  const final = items[items.length - 1]
  const finalBox = final.getBoundingClientRect()
  const clear = document.querySelector('.hermes-sb-menu-clear')
  const clearBox = clear ? clear.getBoundingClientRect() : null
  const menuBox = menu.getBoundingClientRect()
  return {
    innerScroll: style.overflowY,
    innerMaxHeight: style.maxHeight,
    items: items.length,
    autoTopVisible,
    // The final row must sit inside the list's visible window after scrolling.
    finalVisible: finalBox.bottom <= listBox.bottom + 1 && finalBox.top >= listBox.top - 1,
    clearVisible: clearBox ? clearBox.bottom <= listBox.bottom + 1 : null,
    // The whole menu, including the conditional "Never" button at its very
    // bottom, must be reachable by scrolling the list to its end.
    menuBottomVisible: menuBox.bottom <= listBox.bottom + 1,
    overflowBelow: Math.round(Math.max(0, menuBox.bottom - listBox.bottom))
  }
})
console.log(`last-row picker: ${JSON.stringify(reach)}`)
if (reach.error) console.log(`!! ${reach.error}`)
if (reach.innerScroll && reach.innerScroll !== 'visible') {
  console.log(`!! the menu scrolls itself (overflow-y:${reach.innerScroll}) inside a scrolling list — a nested scroller cannot be chained out of`)
}
if (reach.error === undefined && reach.autoTopVisible === false) {
  console.log('!! the menu opens below the fold — a picker low in the board must scroll its own menu into view')
}
if (reach.error === undefined && (reach.menuBottomVisible === false || reach.finalVisible === false)) {
  console.log(`!! the end of the menu stays ${reach.overflowBelow}px below the list's edge even when scrolled to the end`)
}
await shot('preview-menu-last-row.png')
// Leave the global state as the next section expects it: shut this menu so the
// multi-select test opens its own picker on the first row.
await page.evaluate(() => {
  document.querySelector('.hermes-sb-menu')?.closest('.hermes-sb-when')?.querySelector('.hermes-sb-picker')?.click()
})
await page.waitForTimeout(150)

// ── multi-select, in a real browser ─────────────────────────────────────
// Two triggers on ONE pad: click the first, then the second, without the menu
// closing — that is the whole feature, so it gets verified in Chromium and not
// only in jsdom.
// Open the first row's picker explicitly: the previous section now cleans up
// after itself, so the menu cannot be assumed to still be open.
await page.click('.hermes-sb-row .hermes-sb-picker')
await page.waitForSelector('.hermes-sb-menu', { timeout: 3000 })
await page.click('.hermes-sb-menu-row:has-text("Approval needed")')
await page.waitForTimeout(150)
const stillOpen = await page.$('.hermes-sb-menu')
console.log(`menu still open after one toggle: ${Boolean(stillOpen)}`)
if (!stillOpen) console.log('!! the menu closed on the first pick; multi-select needs it open')

await page.click('.hermes-sb-menu-row:has-text("Turn finishes")')
await page.waitForTimeout(150)
const afterTwo = await page.evaluate(() => {
  const menu = document.querySelector('.hermes-sb-menu')
  return {
    selected: [...menu.querySelectorAll('.hermes-sb-menu-row[data-selected="true"]')].map(
      row => row.querySelector('.hermes-sb-menu-text')?.textContent.trim()
    ),
    picker: document.querySelector('.hermes-sb-picker-label')?.textContent.trim()
  }
})
console.log(`selected in menu: ${JSON.stringify(afterTwo.selected)}`)
console.log(`picker reads "${afterTwo.picker}"`)
if (afterTwo.selected.length !== 2) console.log(`!! expected 2 selected rows, got ${afterTwo.selected.length}`)
if (afterTwo.picker !== '2 triggers') console.log(`!! the picker does not summarise the count (got "${afterTwo.picker}")`)
await shot('preview-multi.png')

// Close the menu and leave manage mode.
await page.click('.hermes-sb-picker')
await page.waitForTimeout(150)
await page.click('.hermes-sb-panel button[aria-label="Done"]')
await page.waitForTimeout(200)
const boundPads = await page.$$eval('.hermes-sb-pad[data-bound="true"]', nodes => nodes.length)
console.log(`bound pads after binding one pad to two triggers: ${boundPads}`)
if (boundPads !== 1) console.log(`!! expected exactly 1 bound pad, got ${boundPads}`)

await page.evaluate(() => {
  for (const listener of (window.__events['approval.request'] ?? [])) {
    listener({ type: 'approval.request', payload: { prompt_id: 'p1' } })
  }
})
await page.waitForTimeout(120)
const flashed = await page.$$eval('.hermes-sb-pad[data-active="true"]', nodes =>
  nodes.map(node => node.querySelector('.hermes-sb-pad-name')?.textContent)
)
console.log(`pads flashed by approval.request: ${JSON.stringify(flashed)}`)
if (flashed.length !== 1) console.log('!! the bound sound did not fire in a real browser')
await shot('preview-triggered.png')

// The SECOND trigger on the same pad must fire it too.
const eventKeys = await page.evaluate(() => Object.keys(window.__events ?? {}))
console.log(`subscribed events: ${JSON.stringify(eventKeys)}`)
await page.evaluate(() => {
  for (const listener of (window.__events['message.complete'] ?? [])) {
    listener({ type: 'message.complete', payload: { status: 'complete', text: 'done' } })
  }
})
await page.waitForTimeout(120)
const flashedAgain = await page.$$eval('.hermes-sb-pad[data-active="true"]', nodes =>
  nodes.map(node => node.querySelector('.hermes-sb-pad-name')?.textContent)
)
console.log(`pads flashed by message.complete: ${JSON.stringify(flashedAgain)}`)
if (flashedAgain.length !== 1) console.log('!! the second trigger did not fire the same pad')

// ── YouTube import, in a real browser ───────────────────────────────────
// The panel's header button opens a field; submitting runs the whole pipeline
// against the stubbed shell door and must land a pad.
await page.click('.hermes-sb-panel button[aria-label="Import from YouTube"]')
await page.waitForSelector('.hermes-sb-yt-input', { timeout: 3000 })
await page.fill('.hermes-sb-yt-input', 'https://www.youtube.com/watch?v=jNQXAC9IVRw')
await page.waitForTimeout(120)
await shot('preview-youtube.png')

// The trim fields must be present and consistent with the row above.
const trim = await page.evaluate(() => {
  const fields = [...document.querySelectorAll('.hermes-sb-yt-trim-input')]
  return {
    count: fields.length,
    types: fields.map(f => f.type),
    widths: fields.map(f => Math.round(f.getBoundingClientRect().width)),
    labels: [...document.querySelectorAll('.hermes-sb-yt-trim-label')].map(l => l.textContent)
  }
})
console.log(`trim fields: ${JSON.stringify(trim)}`)
const insets = await page.evaluate(() => {
  const url = document.querySelector('.hermes-sb-yt-input')?.getBoundingClientRect()
  const label = document.querySelector('.hermes-sb-yt-trim-label')?.getBoundingClientRect()
  const field = document.querySelector('.hermes-sb-yt-trim-input')?.getBoundingClientRect()
  return {
    urlLeft: url ? Math.round(url.left) : null,
    labelLeft: label ? Math.round(label.left) : null,
    fieldLeft: field ? Math.round(field.left) : null
  }
})
console.log(`left edges — url ${insets.urlLeft}, trim label ${insets.labelLeft}, trim field ${insets.fieldLeft}`)
if (insets.labelLeft !== null && insets.labelLeft > insets.urlLeft + 1) {
  console.log(`!! the trim row starts ${insets.labelLeft - insets.urlLeft}px right of the URL row`)
}
if (insets.labelLeft !== null && insets.labelLeft < insets.urlLeft - 2) {
  console.log('!! the trim row hangs past the URL row on the left (clipping risk)')
}
if (trim.count !== 2) console.log('!! expected two trim fields')

await page.click('.hermes-sb-yt-go')
// The bar must appear while the job runs — that is the whole point of it.
let sawProgress = false
let sawPercent = ''
for (let i = 0; i < 12; i += 1) {
  await page.waitForTimeout(180)
  const state = await page.evaluate(() => ({
    bar: Boolean(document.querySelector('.hermes-sb-yt-progress')),
    pct: document.querySelector('.hermes-sb-yt-pct')?.textContent ?? ''
  }))
  if (state.bar) {
    sawProgress = true
    if (/%/.test(state.pct)) sawPercent = state.pct
  }
  if (sawProgress && sawPercent) {
    // The fill animates (transition: width .25s), so measuring immediately
    // reads a mid-flight width and reports a disagreement that is not real.
    await page.waitForTimeout(400)
    const geom = await page.evaluate(() => {
      const track = document.querySelector('.hermes-sb-yt-bar')
      const fill = document.querySelector('.hermes-sb-yt-bar-fill')
      const t = track.getBoundingClientRect()
      const f = fill.getBoundingClientRect()
      return {
        trackW: Math.round(t.width),
        fillW: Math.round(f.width),
        ratio: t.width ? Math.round((f.width / t.width) * 100) : 0,
        label: document.querySelector('.hermes-sb-yt-pct')?.textContent
      }
    })
    console.log(`bar geometry: fill ${geom.fillW}/${geom.trackW}px = ${geom.ratio}% (label says ${geom.label})`)
    const want = Number((geom.label || '').replace('%', ''))
    if (want && Math.abs(geom.ratio - want) > 8) console.log(`!! the fill (${geom.ratio}%) disagrees with the label (${want}%)`)
    await shot('preview-youtube-progress.png')
    break
  }
}
console.log(`progress bar appeared while running: ${sawProgress}`)
console.log(`percentage read from the log: ${sawPercent || '(never became a number)'}`)
if (!sawProgress) console.log('!! no progress indicator while the job ran')
if (!sawPercent) console.log('!! the bar never showed a real percentage')
// The job poll is 700ms per tick; the stub answers on the first one.
await page.waitForFunction(() => {
  const pads = [...document.querySelectorAll('.hermes-sb-pad-name')].map(node => node.textContent)
  return pads.some(name => /^YouTube/.test(name))
}, null, { timeout: 8000 }).catch(() => {})
await page.waitForTimeout(400)

const ytState = await page.evaluate(() => ({
  pads: [...document.querySelectorAll('.hermes-sb-pad-name')].map(node => node.textContent),
  script: window.__script ?? '',
  shellCalls: window.__shellCalls ?? [],
  leftovers: [...window.__files.keys()].filter(name => /\.(cmd|log|status)$/.test(name)),
  error: document.querySelector('.hermes-sb-yt-note[data-error="true"]')?.textContent ?? ''
}))
const ytPad = ytState.pads.find(name => /^YouTube/.test(name))
console.log(`youtube pad added: ${ytPad ? JSON.stringify(ytPad) : 'NO'}`)
if (!ytPad) console.log(`!! the import did not add a pad (error: ${ytState.error || 'none'})`)
if (ytState.error) console.log(`!! the field reported: ${ytState.error}`)
if (!/uvx yt-dlp/.test(ytState.script)) console.log('!! no job script was written')
if (!/%%\(ext\)s/.test(ytState.script)) console.log('!! the output template is not batch-escaped')
if (ytState.leftovers.length) console.log(`!! job files left behind: ${ytState.leftovers.join(', ')}`)
console.log(`shell calls: ${ytState.shellCalls.length}`)
await shot('preview-youtube-done.png')

// ── the imported pad must actually PLAY ─────────────────────────────────
// The reported bug was "it appears but no sound", so appearing is not enough.
// This clicks the new pad in the real panel and waits for audio time to move.
const playState = await page.evaluate(async () => {
  const pads = [...document.querySelectorAll('.hermes-sb-pad')]
  const pad = pads.find(p => /^YouTube/.test(p.querySelector('.hermes-sb-pad-name')?.textContent ?? ''))
  if (!pad) return { error: 'no YouTube pad' }
  // Observe by monkey-patching the constructor to RETURN a plain Audio we keep
  // a handle on. Subclassing a media element is not guaranteed to preserve its
  // internal load behaviour, which is exactly the kind of test artefact that
  // produces a false failure.
  const made = []
  const Real = window.Audio
  window.Audio = function (src) {
    const a = new Real(src)
    made.push(a)
    window.__lastSrc = String(src)
    return a
  }
  pad.click()
  await new Promise(r => setTimeout(r, 700))
  window.Audio = Real
  const a = made[0]
  if (!a) return { error: 'no Audio constructed' }
  return {
    constructed: made.length,
    srcPrefix: (window.__lastSrc || '').slice(0, 44),
    srcLen: (window.__lastSrc || '').length,
    clipDefined: typeof window.__realClip,
    volume: a.volume,
    duration: a.duration,
    currentTime: a.currentTime,
    paused: a.paused,
    readyState: a.readyState,
    errorCode: a.error ? a.error.code : null
  }
})
console.log(`imported pad playback: ${JSON.stringify(playState)}`)
// The cached URL must be labelled as audio: the host labels an .mp3 as
// application/octet-stream, and a reload used to mask that by re-reading it.
if (playState.srcPrefix && !/^data:audio\/mpeg/.test(playState.srcPrefix)) {
  console.log(`!! the pad's source is mislabelled: ${playState.srcPrefix}`)
}
if (playState.error) console.log(`!! ${playState.error}`)
else if (!(playState.currentTime > 0)) console.log('!! the pad produced no audible progress')
else console.log(`  audible: advanced to ${playState.currentTime.toFixed(2)}s of ${(playState.duration || 0).toFixed(2)}s`)

// The field closes on success.
const fieldOpen = await page.$('.hermes-sb-yt-input')
console.log(`import field closed after success: ${!fieldOpen}`)
if (fieldOpen) console.log('!! the field stayed open')

// ── manage rows: the gain control ───────────────────────────────────────
await page.click('.hermes-sb-panel button[aria-label="Manage sounds"]')
await page.waitForTimeout(300)
const gainState = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('.hermes-sb-row')]
  return {
    rows: rows.length,
    gains: [...document.querySelectorAll('.hermes-sb-gain-value')].map(n => n.textContent),
    steps: document.querySelectorAll('.hermes-sb-gain .hermes-sb-gain-step').length,
    // Consistent control height is what makes a row look tidy.
    heights: [...document.querySelectorAll('.hermes-sb-row .hermes-sb-gain, .hermes-sb-row .hermes-sb-picker')].map(
      n => Math.round(n.getBoundingClientRect().height)
    )
  }
})
console.log(`gain controls: ${JSON.stringify(gainState)}`)
if (gainState.rows && gainState.steps !== gainState.rows * 2) {
  console.log(`!! expected 2 step buttons per row, got ${gainState.steps}`)
}
if (new Set(gainState.heights).size > 1) console.log(`!! control heights differ: ${gainState.heights}`)
await shot('preview-manage.png')
await page.click('.hermes-sb-panel button[aria-label="Done"]')
await page.waitForTimeout(200)

// The trim control must exist per file pad, open into a full-width panel, and
// keep every control on the row's 21px grid.
// Ensure manage mode is open (the block above closes it).
if (!(await page.$('.hermes-sb-row'))) {
  await page.click('.hermes-sb-panel button[aria-label="Manage sounds"]')
  await page.waitForTimeout(250)
}
const widths = await page.evaluate(() => {
  // Exclude the settings-page rows, which are deliberately wider.
  const row = [...document.querySelectorAll('.hermes-sb-row')]
    .find(r => !r.closest('.hermes-sb-settings-list'))
  if (!row) return null
  const w = sel => {
    const n = row.querySelector(sel)
    return n ? Math.round(n.getBoundingClientRect().width) : null
  }
  return {
    row: Math.round(row.getBoundingClientRect().width),
    play: w('.hermes-sb-rowbtn'),
    picker: w('.hermes-sb-picker'),
    name: w('.hermes-sb-row-name'),
    gain: w('.hermes-sb-gain'),
    total: [...row.children].reduce((sum, n) => sum + n.getBoundingClientRect().width, 0)
  }
})
console.log(`row widths: ${JSON.stringify(widths)}`)
// A name field narrower than its own text is the bug this measurement exists to
// catch: at 31px every label clipped mid-word.
if (widths && widths.name < 60) console.log(`!! the popover name field is only ${widths.name}px — names will clip`)
const nameFit = await page.evaluate(() => {
  const inputs = [...document.querySelectorAll('.hermes-sb-row-name')]
  return {
    total: inputs.length,
    // An input shows no ellipsis glyph, so "too long" is judged by overflow,
    // and the important thing is that the FIELD is wide enough to be usable.
    overflowing: inputs.filter(n => n.scrollWidth > n.clientWidth + 1).map(n => n.value)
  }
})
console.log(`  ${nameFit.total - nameFit.overflowing.length}/${nameFit.total} names fit their field`)
if (nameFit.overflowing.length) {
  console.log(`    longer than the field: ${JSON.stringify(nameFit.overflowing)}`)
}
const trimUi = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('.hermes-sb-row')]
  const trims = [...document.querySelectorAll('.hermes-sb-rowbtn[data-trim]')]
  // Only clips can be trimmed; synthesised cues must not offer it.
  const synthRows = rows.filter(r => !r.querySelector('.hermes-sb-rowbtn[data-trim]'))
  return { rows: rows.length, trimButtons: trims.length, rowsWithoutTrim: synthRows.length }
})
console.log(`trim buttons: ${JSON.stringify(trimUi)}`)
if (!trimUi.trimButtons) console.log('!! no trim control rendered')
else console.log(`  ${trimUi.trimButtons} of ${trimUi.rows} rows offer trimming (the rest are synthesised cues)`)

// Open the first one and measure the panel.
await page.click('.hermes-sb-rowbtn[data-trim]')
await page.waitForTimeout(250)
const panel = await page.evaluate(() => {
  const box = document.querySelector('.hermes-sb-trim')
  if (!box) return null
  const r = box.getBoundingClientRect()
  const row = box.closest('.hermes-sb-row').getBoundingClientRect()
  return {
    width: Math.round(r.width),
    rowWidth: Math.round(row.width),
    fields: [...box.querySelectorAll('.hermes-sb-trim-input')].length,
    hasCopy: Boolean(box.querySelector('.hermes-sb-trim-copy input')),
    goDisabled: box.querySelector('.hermes-sb-trim-go')?.disabled,
    clipped: r.right > row.right + 1 || r.left < row.left - 1
  }
})
console.log(`trim panel: ${JSON.stringify(panel)}`)
if (!panel) console.log('!! the trim panel did not open')
else {
  if (panel.fields !== 2) console.log(`!! expected 2 trim fields, got ${panel.fields}`)
  if (!panel.hasCopy) console.log('!! no keep-original option')
  if (!panel.goDisabled) console.log('!! Trim is enabled with an empty window')
  if (panel.clipped) console.log('!! the trim panel overflows its row')
}
await shot('preview-trim.png')
await page.click('.hermes-sb-rowbtn[data-trim]')
await page.waitForTimeout(150)

// ── one-at-a-time toggle renders in settings ────────────────────────────
await page.evaluate(() => window.__mountSettings())
await page.waitForTimeout(300)
const oneAtATime = await page.evaluate(() => {
  const labels = [...document.querySelectorAll('label')]
  const target = labels.find(l => /one sound at a time/i.test(l.textContent))
  if (!target) return { found: false }
  const box = target.querySelector('input[type=checkbox]')
  return { found: true, checked: box?.checked }
})
console.log(`one-at-a-time setting: ${JSON.stringify(oneAtATime)}`)
if (!oneAtATime.found) console.log('!! the one-at-a-time toggle is missing from settings')

// Settings page.
await page.evaluate(() => window.__mountSettings())
await page.waitForTimeout(300)
await shot('preview-settings.png')

// ── the settings page must manage sounds, not just preferences ──────────
const settingsManager = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('.hermes-sb-settings-list .hermes-sb-row')]
  const list = document.querySelector('.hermes-sb-settings-list')
  const nameWidths = [...document.querySelectorAll('.hermes-sb-settings-list .hermes-sb-row-name')]
    .map(n => Math.round(n.getBoundingClientRect().width))
  return {
    rows: rows.length,
    hasAdd: Boolean(document.querySelector('.hermes-sb-settings-add')),
    hasYt: Boolean([...document.querySelectorAll('.hermes-sb-settings-add')]
      .some(b => /youtube/i.test(b.textContent))),
    reorderButtons: document.querySelectorAll('.hermes-sb-reorder button').length,
    trims: document.querySelectorAll('.hermes-sb-settings-list .hermes-sb-rowbtn[data-trim]').length,
    minNameWidth: nameWidths.length ? Math.min(...nameWidths) : 0,
    // Full width on a settings page: no 308px popover budget.
    listWidth: list ? Math.round(list.getBoundingClientRect().width) : 0
  }
})
console.log(`settings manager: ${JSON.stringify(settingsManager)}`)
if (!settingsManager.rows) console.log('!! the settings page lists no sounds')
if (!settingsManager.hasAdd) console.log('!! no add-file control on the settings page')
if (!settingsManager.hasYt) console.log('!! no YouTube import on the settings page')
if (settingsManager.reorderButtons < settingsManager.rows * 2) console.log('!! reorder buttons missing')
if (settingsManager.listWidth < 320) console.log(`!! the manager is still popover-width (${settingsManager.listWidth}px)`)

// Reordering from settings must persist, since order drives the 1-9 keys.
const beforeOrder = await page.evaluate(() =>
  [...document.querySelectorAll('.hermes-sb-settings-list .hermes-sb-row-name')].map(n => n.value))
await page.click('.hermes-sb-settings-list .hermes-sb-row [data-move="down"]')
await page.waitForTimeout(250)
const afterOrder = await page.evaluate(() =>
  [...document.querySelectorAll('.hermes-sb-settings-list .hermes-sb-row-name')].map(n => n.value))
console.log(`reorder: ${JSON.stringify(beforeOrder.slice(0, 3))} -> ${JSON.stringify(afterOrder.slice(0, 3))}`)
if (JSON.stringify(beforeOrder) === JSON.stringify(afterOrder)) console.log('!! the move button did nothing')
else if (beforeOrder[0] !== afterOrder[1]) console.log('!! the moved pad did not land in the next slot')
await shot('preview-settings-manage.png')

// ── profiles: save, switch on the go, and the settings list ─────────────
const profileShape = await page.evaluate(() => {
  const btn = document.querySelector('.hermes-sb-profile-btn')
  const settingsRows = document.querySelectorAll('.hermes-sb-profile-row')
  const save = document.querySelector('[data-save-profile]')
  if (!btn) return { hasSwitcher: false }
  const box = btn.getBoundingClientRect()
  const head = document.querySelector('.hermes-sb-head').getBoundingClientRect()
  return {
    hasSwitcher: true,
    label: btn.textContent.trim(),
    inHeader: box.top >= head.top - 1 && box.bottom <= head.bottom + 1,
    btnHeight: Math.round(box.height),
    settingsRows: settingsRows.length,
    hasSave: Boolean(save)
  }
})
console.log(`profile switcher: ${JSON.stringify(profileShape)}`)
if (!profileShape.hasSwitcher) console.log('!! no profile switcher in the popover header')
if (profileShape.hasSwitcher && !profileShape.inHeader) console.log('!! the switcher is not inside the header row')
if (!profileShape.hasSave) console.log('!! settings has no save-board control')

// Save a board from settings, then switch to it from the popover.
const panelNamesBefore = await page.evaluate(() =>
  [...document.querySelectorAll('.hermes-sb-settings-list .hermes-sb-row-name')].map(n => n.value))
await page.fill('[aria-label="New profile name"]', 'Podcast')
await page.click('[data-save-profile]')
await page.waitForTimeout(300)
const saved = await page.evaluate(() =>
  [...document.querySelectorAll('.hermes-sb-profile-row')].map(r => ({
    name: r.querySelector('.hermes-sb-profile-rename')?.value,
    active: r.dataset.active === 'true'
  })))
console.log(`profiles after save: ${JSON.stringify(saved)}`)
if (!saved.length) console.log('!! saving did not create a profile row')
if (saved.length && !saved.some(p => p.active)) console.log('!! the saved profile is not marked active')

// Make a second profile, then switch away from it — the active row's button is
// disabled on purpose, so the click has to target an inactive one.
// We are on the settings page, so the edit happens there: reordering is a real
// change to the board and makes the live set differ from the saved profile.
await page.click('.hermes-sb-settings-list .hermes-sb-row [data-move="down"]')
await page.waitForTimeout(200)
await page.fill('[aria-label="New profile name"]', 'Gaming')
await page.click('[data-save-profile]')
await page.waitForTimeout(250)
const twoProfiles = await page.evaluate(() =>
  document.querySelectorAll('.hermes-sb-profile-row').length)
console.log(`profiles saved: ${twoProfiles}`)
if (twoProfiles < 2) console.log('!! saving under a new name did not add a profile')
await page.click('.hermes-sb-profile-row:not([data-active="true"]) .hermes-sb-profile-use')
await page.waitForTimeout(250)
await shot('preview-settings-profiles.png')
const boardAfterSwitch = await page.evaluate(() => {
  // Settings lists the live board, which is what the switch changed.
  return [...document.querySelectorAll('.hermes-sb-settings-list .hermes-sb-row-name')].map(n => n.value)
})
console.log(`board after switching: ${JSON.stringify(boardAfterSwitch.slice(0, 3))}`)
if (!boardAfterSwitch.length) console.log('!! switching left the live board empty')

// The popover switcher must offer both profiles.
await page.click('.hermes-sb-profile-btn')
await page.waitForTimeout(250)
const headBefore = await page.evaluate(() => {
  const h = document.querySelector('.hermes-sb-head')
  const g = document.querySelector('.hermes-sb-grid')
  return { head: Math.round(h.getBoundingClientRect().height), padTop: g ? Math.round(g.getBoundingClientRect().top) : null }
})
const profileMenu = await page.evaluate(() => {
  const el = document.querySelector('.hermes-sb-profile-menu')
  if (!el) return { open: false }
  const box = el.getBoundingClientRect()
  const boxOfMenu = box
  // Everything the screenshot complained about, measured rather than eyeballed.
  const panel = document.querySelector('.hermes-sb-panel')
  const panelBox = panel ? panel.getBoundingClientRect() : null
  const btn = document.querySelector('.hermes-sb-profile-btn').getBoundingClientRect()
  const head = document.querySelector('.hermes-sb-head').getBoundingClientRect()
  const item = el.querySelector('.hermes-sb-profile-item')
  const itemBox = item.getBoundingClientRect()
  const nameEl = item.querySelector('.hermes-sb-profile-item-name')
  const metaEl = item.querySelector('.hermes-sb-profile-item-meta')
  const tick = item.querySelector('.hermes-sb-profile-tick')
  const metaBox = metaEl.getBoundingClientRect()
  const tickBox = tick ? tick.getBoundingClientRect() : null
  const input = el.querySelector('.hermes-sb-profile-input')
  const saveBtn = el.querySelector('.hermes-sb-profile-savebtn')
  // Does the placeholder fit? Compare its rendered width to the field's.
  const probe = document.createElement('span')
  probe.style.cssText = 'position:absolute;visibility:hidden;white-space:nowrap;font:' + getComputedStyle(input).font
  probe.textContent = input.placeholder
  document.body.append(probe)
  const placeholderWidth = probe.getBoundingClientRect().width
  probe.remove()
  const selectOverhang = box.right - btn.right
  const headGrew = Math.round(head.height)
  return {
    open: true,
    items: [...el.querySelectorAll('.hermes-sb-profile-item')].map(i => i.textContent.trim()),
    width: Math.round(box.width),
    // In flow, so it must sit inside the popover rather than off-screen.
    withinViewport: box.left >= 0 && box.top >= 0 && box.right <= window.innerWidth,
    // The save field must be usable AND stay inside the menu: a field wider
    // than its container means the footer has burst out of the popup.
    saveFieldWidth: Math.round(input.getBoundingClientRect().width),
    btnWidth: Math.round(btn.width),
    btnRight: Math.round(btn.right),
    menuLeft: Math.round(box.left),
    menuRight: Math.round(box.right),
    panelRight: panelBox ? Math.round(panelBox.right) : null,
    overhangRight: Math.round(selectOverhang),
    labelIndentDelta: Math.round(nameEl.getBoundingClientRect().left - btn.left),
    metaToTickGap: tickBox ? Math.round(tickBox.left - metaBox.right) : null,
    countRightEdges: [...el.querySelectorAll('.hermes-sb-profile-item-meta')]
      .map(n => Math.round(n.getBoundingClientRect().right)),
    // Unrounded: a rounded 24 vs 24 can hide a 0.5px real mismatch.
    saveRowHeights: [input, saveBtn].map(n => +n.getBoundingClientRect().height.toFixed(2)),
    saveRowTops: [input, saveBtn].map(n => +n.getBoundingClientRect().top.toFixed(2)),
    saveRowBottoms: [input, saveBtn].map(n => +n.getBoundingClientRect().bottom.toFixed(2)),
    itemInnerWidth: Math.round(itemBox.width),
    headHeight: headGrew,
    panelBottom: panelBox ? Math.round(panelBox.bottom) : null,
    menuOverPanelBottom: panelBox ? Math.round(box.bottom - panelBox.bottom) : null,
    placeholderWidth: Math.round(placeholderWidth),
    placeholderFits: placeholderWidth <= input.getBoundingClientRect().width - 12,
    padTop: (() => {
      const g = document.querySelector('.hermes-sb-grid')
      return g ? Math.round(g.getBoundingClientRect().top) : null
    })(),
    footerFits: (() => {
      const scoped = document.querySelector('.hermes-sb-profile-menu')
      const field = scoped.querySelector('.hermes-sb-profile-input').getBoundingClientRect()
      const btn = scoped.querySelector('.hermes-sb-profile-savebtn').getBoundingClientRect()
      const menuBox = boxOfMenu
      return field.right <= menuBox.right + 1 && btn.right <= menuBox.right + 1
    })(),
    menuOverflows: box.right > document.querySelector('.hermes-sb-panel, [data-hermes-soundboard]')?.getBoundingClientRect().right ?? window.innerWidth,
    menuBg: getComputedStyle(el).backgroundColor,
    menuBackdrop: getComputedStyle(el).backdropFilter,
    menuOpacity: getComputedStyle(el).opacity,
    // Handle BOTH serialisations: legacy "rgba(r, g, b, a)" and the modern
    // "color(srgb r g b / a)" that color-mix() resolves to. Parsing only the
    // legacy form returned null for the translucent token and silenced the very
    // assertion meant to catch it.
    menuAlpha: (() => {
      const bg = getComputedStyle(el).backgroundColor
      const slash = bg.match(/\/\s*([\d.]+)\s*\)/)
      if (slash) return parseFloat(slash[1])
      const rgba = bg.match(/rgba\(([^)]+)\)/)
      if (rgba) {
        const parts = rgba[1].split(',').map(v => parseFloat(v))
        return parts.length === 4 ? parts[3] : 1
      }
      if (/^(rgb|color)\(/.test(bg)) return 1
      return null
    })(),
    // What actually paints behind the menu.
    ancestorBackdrop: (() => {
      let node = el.parentElement, out = []
      while (node && out.length < 6) {
        const cs = getComputedStyle(node)
        if (cs.backdropFilter && cs.backdropFilter !== 'none') out.push(node.className || node.tagName)
        node = node.parentElement
      }
      return out
    })(),
  }
})
console.log(`profile menu: ${JSON.stringify(profileMenu)}`)
if (!profileMenu.open) console.log('!! the profile menu did not open from the header')
if (profileMenu.open && !profileMenu.withinViewport) console.log('!! the profile menu rendered outside the window')
if (profileMenu.open && profileMenu.saveFieldWidth < 110) console.log(`!! the profile name field is only ${profileMenu.saveFieldWidth}px — its placeholder clips`)
if (profileMenu.open && !profileMenu.footerFits) console.log('!! the save row overflows the profile menu')
if (profileMenu.open && Math.abs(profileMenu.menuLeft - profileMenu.btnRight + profileMenu.btnWidth) > 3) {
  console.log(`!! the menu is not left-aligned to its trigger (menu ${profileMenu.menuLeft}, button left ${profileMenu.btnRight - profileMenu.btnWidth})`)
}
if (profileMenu.open && profileMenu.labelIndentDelta > 12) {
  console.log(`!! the menu label is indented ${profileMenu.labelIndentDelta}px from the trigger's label`)
}
if (profileMenu.open && profileMenu.metaToTickGap !== null && profileMenu.metaToTickGap < 2) {
  console.log(`!! the tick overlaps the pad count (gap ${profileMenu.metaToTickGap}px)`)
}
if (profileMenu.open && new Set(profileMenu.countRightEdges).size > 1) {
  console.log(`!! the pad counts do not form a column: right edges ${JSON.stringify(profileMenu.countRightEdges)}`)
}
if (profileMenu.open && new Set(profileMenu.saveRowHeights).size > 1) {
  console.log(`!! the save field and button are different heights: ${JSON.stringify(profileMenu.saveRowHeights)}`)
}
if (profileMenu.open && !profileMenu.placeholderFits) {
  console.log(`!! the placeholder needs ${profileMenu.placeholderWidth}px in a ${profileMenu.saveFieldWidth}px field`)
}
if (profileMenu.open && profileMenu.menuAlpha !== null && profileMenu.menuAlpha < 0.999) {
  console.log(`!! the profile menu is translucent (alpha ${profileMenu.menuAlpha}) — content shows through it`)
}
if (profileMenu.open && profileMenu.panelRight && profileMenu.menuRight > profileMenu.panelRight) {
  console.log(`!! the menu hangs past the panel's right edge (${profileMenu.menuRight} > ${profileMenu.panelRight})`)
}
const headAfter = await page.evaluate(() => {
  const h = document.querySelector('.hermes-sb-head')
  const g = document.querySelector('.hermes-sb-grid')
  return { head: Math.round(h.getBoundingClientRect().height), padTop: g ? Math.round(g.getBoundingClientRect().top) : null }
})
console.log(`header on open: ${JSON.stringify(headBefore)} -> ${JSON.stringify(headAfter)}`)
if (headAfter.head !== headBefore.head) console.log(`!! the header grew ${headAfter.head - headBefore.head}px when the menu opened — the board jumped`)
if (headBefore.padTop !== null && headAfter.padTop !== headBefore.padTop) console.log('!! the pads moved when the menu opened')
await shot('preview-profiles.png')
// Element screenshot: unambiguous, no coordinate guessing about what is on top.
const panelEl = await page.$('.hermes-sb-panel')
if (panelEl) await panelEl.screenshot({ path: path.join(outDir, 'preview-profiles-panel.png') })
const menuEl = await page.$('.hermes-sb-profile-menu')
if (menuEl) await menuEl.screenshot({ path: path.join(outDir, 'preview-profiles-menu.png') })

await browser.close()
server.close()
console.log('\npreview done')
