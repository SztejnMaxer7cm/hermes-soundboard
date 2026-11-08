/**
 * Export / import of a whole setup, end to end in a real Chromium.
 *
 * This path lives almost entirely in the browser: a blob anchor download, a
 * REAL `<input type=file>` holding a REAL .json, `FileReader`, and — the part
 * no jsdom stub can be trusted with — whether an imported clip actually
 * DECODES AND PLAYS. So every assertion here is on an effect (bytes on disk, a
 * pad's stored fields, `currentTime` advancing), never on an element existing.
 *
 * Usage:  node test/setup.mjs
 */

import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const depsRoot =
  process.env.HERMES_DEPS_ROOT || path.resolve(root, '..', 'AppData/Local/hermes/hermes-agent/node_modules')
const fromDeps = specifier => pathToFileURL(path.join(depsRoot, specifier)).href

const { build } = await import(fromDeps('esbuild/lib/main.js'))
const playwright = await import(fromDeps('playwright-core/index.mjs'))
const chromium = playwright.chromium ?? playwright.default?.chromium

const outDir = path.join(root, '.build')
const entryPath = path.join(outDir, 'setup-entry.js')
const bundlePath = path.join(outDir, 'setup-bundle.mjs')
const pagePath = path.join(outDir, 'setup.html')
const downloadsDir = path.join(outDir, 'downloads')

fs.rmSync(outDir, { recursive: true, force: true })
fs.mkdirSync(downloadsDir, { recursive: true })

/** A genuinely playable 0.4s tone. The import must be proved to produce audio,
 *  so fake bytes are useless here. */
function makeWav(seconds = 0.4, rate = 22050, freq = 440) {
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
    buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * 0.3 * 32767), 44 + i * 2)
  }
  return buf
}

const wav = makeWav()
const wavB64 = wav.toString('base64')
fs.writeFileSync(path.join(outDir, 'clap.wav'), wav)
fs.writeFileSync(path.join(outDir, 'notes.txt'), Buffer.from('this is not a setup'))
fs.writeFileSync(path.join(outDir, 'plain.json'), JSON.stringify({ hello: 'world' }))
fs.writeFileSync(
  path.join(outDir, 'future.json'),
  JSON.stringify({ format: 'hermes-soundboard-setup', version: 99, sounds: [{ name: 'x', kind: 'synth', synth: 'pop' }] })
)
// One good synth pad and one file pad whose clip is not base64 at all.
fs.writeFileSync(
  path.join(outDir, 'badclip.json'),
  JSON.stringify({
    format: 'hermes-soundboard-setup',
    version: 1,
    settings: { volume: 44 },
    sounds: [
      { name: 'Kept', kind: 'synth', synth: 'ding' },
      { name: 'Broken', kind: 'file', mime: 'audio/wav', audio: '!!! not base64 !!!' }
    ]
  })
)

fs.writeFileSync(
  entryPath,
  `
import { createRoot } from 'react-dom/client'
import { jsx } from 'react/jsx-runtime'
import plugin from ${JSON.stringify(path.join(root, 'plugin.js').replace(/\\\\/g, '/'))}
import { registerPluginI18n } from ${JSON.stringify(path.join(here, 'sdk-stub.mjs').replace(/\\\\/g, '/'))}

// Every Audio the plugin makes, so playback can be MEASURED rather than assumed.
const RealAudio = window.Audio
window.__audios = []
window.Audio = function (src) {
  const audio = new RealAudio(src)
  window.__audios.push(audio)
  return audio
}
window.Audio.prototype = RealAudio.prototype

const memory = new Map()
const written = {}
const notices = []
const contributions = {}
let settingsPage = null

const ctx = {
  source: 'plugin:hermes-soundboard',
  i18n: {
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
    readText: async (_f, p) => (written[p] !== undefined
      ? { ok: true, text: written[p], size: written[p].length, mtimeMs: 0 }
      : { ok: false, error: 'not-found', message: 'missing ' + p }),
    writeText: async (_f, p, text) => {
      if (new TextEncoder().encode(text).length > 4 * 1024 * 1024) {
        return { ok: false, error: 'too-large', message: 'Text is larger than 4 MiB.' }
      }
      written[p] = text
      return { ok: true, path: p, size: text.length, mtimeMs: 0 }
    },
    trash: async (_f, p) => { delete written[p]; return { ok: true } },
    folders: async () => [],
    requestFolder: async () => ({ ok: false, error: 'unavailable', message: 'test' })
  },
  notify: opts => notices.push(opts),
  onEvent: () => () => {},
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
window.__engine = ctx.__engine
window.__contrib = contributions
window.__settingsPage = settingsPage
createRoot(document.getElementById('chip')).render(jsx(contributions.chip.render, {}))

window.__state = () => ({
  sounds: JSON.parse(memory.get('sounds') || 'null'),
  settings: JSON.parse(memory.get('settings') || 'null'),
  written: Object.keys(written),
  notices: notices.slice()
})
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

// The browser host's twin of the entry above: same plugin, same UI, but the
// ctx the webapp would give it — every `ctx.files` call resolves the host's
// "unavailable" sentinel (apps/desktop's browser bridge implements plugin
// loading, not `pluginFiles`), and `ctx.storage` is localStorage, which is
// what the real host backs plugin storage with (src/contrib/plugin.ts →
// readKey/writeKey). Real IndexedDB, the same one the fallback store uses,
// comes with the browser itself.
const webappEntryPath = path.join(outDir, 'webapp-entry.js')
const webappBundlePath = path.join(outDir, 'webapp-bundle.mjs')

fs.writeFileSync(
  webappEntryPath,
  `
import { createRoot } from 'react-dom/client'
import { jsx } from 'react/jsx-runtime'
import plugin from ${JSON.stringify(path.join(root, 'plugin.js').replace(/\\\\/g, '/'))}
import { registerPluginI18n } from ${JSON.stringify(path.join(here, 'sdk-stub.mjs').replace(/\\\\/g, '/'))}

const RealAudio = window.Audio
window.__audios = []
window.Audio = function (src) {
  const audio = new RealAudio(src)
  window.__audios.push(audio)
  return audio
}
window.Audio.prototype = RealAudio.prototype

// The door every op refuses — the exact result createPluginFiles returns
// when the window bridge has no pluginFiles member.
const NO_DOOR = { ok: false, error: 'unavailable', message: 'This Hermes Desktop build has no plugin file access.' }

// The real host's plugin storage: namespaced localStorage keys.
const scoped = key => 'hermes.plugin.' + plugin.id + '.' + key

const notices = []
const contributions = {}
let settingsPage = null

const ctx = {
  source: 'plugin:hermes-soundboard',
  i18n: {
    register: bundle => { window.__locales = bundle; registerPluginI18n(plugin.id, bundle) },
    t: (key, ...args) => {
      const value = window.__locales && window.__locales.en && window.__locales.en[key]
      return typeof value === 'function' ? value(...args) : (value === undefined ? key : value)
    }
  },
  storage: {
    get: (key, fallback) => {
      const raw = window.localStorage.getItem(scoped(key))
      if (raw === null) return fallback
      try { return JSON.parse(raw) } catch { return fallback }
    },
    set: (key, value) => window.localStorage.setItem(scoped(key), JSON.stringify(value)),
    remove: key => window.localStorage.removeItem(scoped(key))
  },
  files: {
    dataFolder: 'data',
    folders: async () => [],
    requestFolder: async () => NO_DOOR,
    release: async () => false,
    list: async () => NO_DOOR,
    stat: async () => NO_DOOR,
    readText: async () => NO_DOOR,
    readDataUrl: async () => NO_DOOR,
    writeText: async () => NO_DOOR,
    rename: async () => NO_DOOR,
    trash: async () => NO_DOOR
  },
  notify: opts => notices.push(opts),
  onEvent: () => () => {},
  onDispose: () => {},
  register: c => { contributions[c.id] = c },
  registerMany: list => { for (const c of list) contributions[c.id] = c },
  registerSettingsPage: page => { settingsPage = page },
  setTimeout, setInterval, addEventListener: () => () => {},
  os: {}, pet: { visible: false, say: () => () => {}, clear: () => {} }
}

plugin.register(ctx)
window.__engine = ctx.__engine
window.__contrib = contributions
window.__settingsPage = settingsPage
createRoot(document.getElementById('chip')).render(jsx(contributions.chip.render, {}))

// Read the fallback store's keys straight out of the browser's own IndexedDB,
// so the assertions are on the real database, not a stub. A database with no
// clip store reads as "no clips" (opening a name that never existed creates
// an empty one), so a host that stored nothing fails checks, not the suite.
window.__clipKeys = async () => {
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open('hermes-soundboard')
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  if (![...db.objectStoreNames].includes('clips')) return []
  return await new Promise((resolve, reject) => {
    const tx = db.transaction('clips', 'readonly')
    const request = tx.objectStore('clips').getAllKeys()
    tx.oncomplete = () => resolve(request.result)
    tx.onerror = () => reject(tx.error)
  })
}

window.__state = () => ({
  sounds: JSON.parse(window.localStorage.getItem(scoped('sounds')) || 'null'),
  settings: JSON.parse(window.localStorage.getItem(scoped('settings')) || 'null'),
  notices: notices.slice()
})
window.__ready = true
`
)

await build({
  absWorkingDir: root,
  entryPoints: [webappEntryPath],
  outfile: webappBundlePath,
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['chrome110'],
  logLevel: 'silent',
  define: { 'process.env.NODE_ENV': '"production"' },
  alias: { '@hermes/plugin-sdk': path.join(here, 'sdk-stub.mjs') },
  nodePaths: [depsRoot]
})

fs.writeFileSync(
  pagePath,
  `<!doctype html><html><head><meta charset="utf-8"><style>
  body{margin:0;background:#17130f;font-family:Inter,system-ui,sans-serif;color:#efe6d8}
  #statusbar{position:fixed;bottom:0;left:0;right:0;height:22px;display:flex;justify-content:flex-end;align-items:center;padding:0 8px;background:#1d1814}
  .hermes-sb-panel{position:fixed;right:8px;bottom:28px;width:308px;background:#231d18;border:1px solid #3b322a;border-radius:8px;padding:8px}
  button{font:inherit;border:0;background:none;cursor:pointer;color:inherit}
  input{font:inherit}
  </style></head>
  <body><div id="statusbar"><span id="chip"></span></div>
  <script type="module" src="./setup-bundle.mjs"></script></body></html>`
)

const webappPagePath = path.join(outDir, 'webapp.html')
fs.writeFileSync(
  webappPagePath,
  fs
    .readFileSync(pagePath, 'utf8')
    .replace('setup-bundle.mjs', 'webapp-bundle.mjs')
)

function findChrome() {
  if (process.env.HERMES_CHROME) return process.env.HERMES_CHROME
  const base = path.join(process.env.LOCALAPPDATA ?? '', 'ms-playwright')
  if (!fs.existsSync(base)) return undefined
  for (const dir of fs.readdirSync(base).filter(name => /^chromium-\d+$/.test(name))) {
    for (const exe of [path.join(base, dir, 'chrome-win64', 'chrome.exe'), path.join(base, dir, 'chrome-linux', 'chrome')]) {
      if (fs.existsSync(exe)) return exe
    }
  }
  return undefined
}

const MIME = { '.html': 'text/html', '.mjs': 'text/javascript', '.wav': 'audio/wav', '.json': 'application/json', '.txt': 'text/plain' }
const server = http.createServer((request, response) => {
  const name = decodeURIComponent((request.url ?? '/').split('?')[0]).replace(/^\/+/, '') || 'setup.html'
  const file = path.join(outDir, name)
  if (!file.startsWith(outDir) || !fs.existsSync(file)) return void response.writeHead(404).end('no')
  response.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream' })
  fs.createReadStream(file).pipe(response)
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))

const browser = await chromium.launch({
  executablePath: findChrome(),
  // A click is the gesture, but headless Chromium is stricter than the app.
  args: ['--autoplay-policy=no-user-gesture-required']
})
const context = await browser.newContext({ viewport: { width: 520, height: 780 }, deviceScaleFactor: 2, acceptDownloads: true })
const page = await context.newPage()
page.on('pageerror', error => console.log(`[page:error] ${error.message}`))

await page.goto(`http://127.0.0.1:${server.address().port}/setup.html`)
await page.waitForFunction(() => window.__ready === true)
await page.click('#chip button')
await page.waitForSelector('.hermes-sb-panel')

const results = []
const check = (name, fn) => {
  try {
    fn()
    results.push({ name, ok: true })
  } catch (error) {
    results.push({ name, ok: false, error: error.message })
  }
}
const settle = async (predicate, label, timeout = 6000) => {
  try {
    await page.waitForFunction(predicate, { timeout })
    return true
  } catch {
    console.log(`FAIL  ${label} (timed out)`)
    return false
  }
}

const state = () => page.evaluate(() => window.__state())
const padNames = () => page.$$eval('.hermes-sb-pad .hermes-sb-pad-name', nodes => nodes.map(n => n.textContent))
const setupInput = () => page.locator('.hermes-sb-panel input[type=file][accept*="json"]')
const audioInput = () => page.locator('.hermes-sb-panel input[type=file][accept*="audio"]')
const errorText = () => page.$eval('.hermes-sb-setup-error', n => n.textContent).catch(() => '')
const notices = async () => (await state()).notices

/** Click Export and return the file it produced: the browser's download, read
 *  back from disk. A no-op export is the failure this catches. */
async function exportOnce(label) {
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 15000 }),
    page.click('.hermes-sb-panel button[aria-label="Export"]')
  ])
  const target = path.join(downloadsDir, `${label}.json`)
  await download.saveAs(target)
  return { target, name: download.suggestedFilename(), text: fs.readFileSync(target, 'utf8') }
}

// ── 1. export a stock board ──────────────────────────────────────────────
const first = await exportOnce('first')
const downloadName = first.name
check('export produces a file through the download door', () => {
  if (!first.text.trim()) throw new Error('the downloaded file is empty')
})
check('the file is named after the board and the day', () => {
  // The download event carries Chromium's chosen name, which the anchor set.
  if (!/^soundboard-setup-\d{4}-\d{2}-\d{2}\.json$/.test(downloadName)) {
    throw new Error(`filename: ${downloadName}`)
  }
})
let bundle1 = null
check('the file is a versioned setup bundle with every built-in pad', () => {
  bundle1 = JSON.parse(first.text)
  if (bundle1.format !== 'hermes-soundboard-setup') throw new Error(`format: ${bundle1.format}`)
  if (bundle1.version !== 1) throw new Error(`version: ${bundle1.version}`)
  if (!Array.isArray(bundle1.sounds) || bundle1.sounds.length !== 7) {
    throw new Error(`sounds: ${JSON.stringify(bundle1.sounds?.length)}`)
  }
  if (bundle1.sounds.some(sound => sound.kind !== 'synth')) throw new Error('a built-in is not a synth pad')
  if (bundle1.sounds[0].name !== 'Pop') throw new Error(`first pad: ${bundle1.sounds[0].name}`)
})
check('the settings travel with the board', () => {
  if (!bundle1?.settings) throw new Error('no settings in the file')
  if (bundle1.settings.volume !== 80) throw new Error(`volume: ${bundle1.settings.volume}`)
  if (bundle1.settings.padsPerRow !== 4) throw new Error(`padsPerRow: ${bundle1.settings.padsPerRow}`)
})
check('no stored id leaks into the file', () => {
  if (bundle1?.sounds?.some(sound => 'id' in sound)) throw new Error('an id was exported')
})

// ── 2. a real clip, with its gain, binding and settings ───────────────────
await audioInput().setInputFiles(path.join(outDir, 'clap.wav'))
const arrived = await settle(
  `(window.__state().sounds || []).length === 8`,
  'the wav becomes a pad'
)
const clipId = await page.evaluate(() => {
  const state = window.__state()
  return (state.sounds || []).find(sound => sound.name === 'clap')?.id ?? null
})
check('the clip pad exists with a stored blob', () => {
  if (!arrived) throw new Error('no pad appeared')
  if (!clipId) throw new Error('clap pad has no id')
})
await page.evaluate(id => {
  window.__engine.setGain(id, 150)
  window.__engine.toggleTrigger(id, 'turn.complete')
  window.__engine.setVolume(65)
}, clipId)

const second = await exportOnce('second')
let bundle2 = null
await page.waitForTimeout(120)
check('the clip is embedded, byte for byte, with its gain and binding', () => {
  bundle2 = JSON.parse(second.text)
  const entry = bundle2.sounds.find(sound => sound.name === 'clap')
  if (!entry) throw new Error(`pads: ${bundle2.sounds.map(s => s.name).join(',')}`)
  if (entry.kind !== 'file') throw new Error(`kind: ${entry.kind}`)
  if (entry.mime !== 'audio/wav') throw new Error(`mime: ${entry.mime}`)
  const decoded = Buffer.from(String(entry.audio), 'base64')
  if (!decoded.equals(wav)) throw new Error(`bytes differ (${decoded.length} vs ${wav.length})`)
  if (entry.gain !== 150) throw new Error(`gain: ${entry.gain}`)
  if (JSON.stringify(entry.triggers) !== '["turn.complete"]') throw new Error(`triggers: ${JSON.stringify(entry.triggers)}`)
  if (bundle2.settings.volume !== 65) throw new Error(`volume: ${bundle2.settings.volume}`)
  if (bundle2.sounds.length !== 8) throw new Error(`pads: ${bundle2.sounds.length}`)
})

// ── 3. import it back as a REPLACEMENT, into the same board ───────────────
const exportedPath = path.join(outDir, 'roundtrip.json')
fs.writeFileSync(exportedPath, second.text)
await setupInput().setInputFiles(exportedPath)
const planned = await settle('!!document.querySelector(".hermes-sb-setup-plan")', 'the plan appears')
const planTitle = await page.$eval('.hermes-sb-setup-plan-title', n => n.textContent).catch(() => '')
check('the plan states the pad count from the file', () => {
  if (!planned) throw new Error('no plan rendered')
  if (!/8/.test(planTitle)) throw new Error(`title: ${planTitle}`)
  if (!/roundtrip\.json/.test(planTitle)) throw new Error(`title does not name the file: ${planTitle}`)
})
const beforeApply = await state()
check('choosing a file does not touch the board', () => {
  if ((beforeApply.sounds || []).length !== 8) throw new Error(`pads: ${beforeApply.sounds?.length}`)
})

await page.click('.hermes-sb-setup-mode[data-destructive="true"]')
const modeSelected = await page.$eval('.hermes-sb-setup-mode[data-destructive="true"]', n => n.getAttribute('data-selected'))
check('replace mode reads as selected once clicked', () => {
  if (modeSelected !== 'true') throw new Error(`data-selected=${modeSelected}`)
})

await page.click('.hermes-sb-setup-confirm button[data-primary="true"]')
const replaced = await settle('!document.querySelector(".hermes-sb-setup-plan")', 'the plan closes after import')
await page.waitForTimeout(200)
const afterImport = await state()

check('the imported board is the exported board, pad for pad', () => {
  if (!replaced) throw new Error('the plan never closed')
  const sounds = afterImport.sounds || []
  if (sounds.length !== 8) throw new Error(`pads: ${sounds.length}`)
  const expected = bundle2.sounds.map(sound => sound.name)
  const actual = sounds.map(sound => sound.name)
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`order/name mismatch\n  expected ${expected.join(',')}\n  actual   ${actual.join(',')}`)
  }
  const clip = sounds.find(sound => sound.name === 'clap')
  if (clip.kind !== 'file' || clip.mime !== 'audio/wav') throw new Error(`clip: ${JSON.stringify(clip)}`)
  if (clip.gain !== 150) throw new Error(`gain: ${clip.gain}`)
  if (JSON.stringify(clip.triggers) !== '["turn.complete"]') throw new Error(`triggers: ${JSON.stringify(clip.triggers)}`)
  if (!clip.bytes || clip.bytes < 1000) throw new Error(`bytes: ${clip.bytes}`)
})
check('the imported pad gets an id minted here, not the file’s', () => {
  const clip = (afterImport.sounds || []).find(sound => sound.name === 'clap')
  if (!clip) throw new Error('no clap pad')
  if (clip.id === clipId) throw new Error('the original id was reused from the file')
  if (!/^snd-/.test(clip.id)) throw new Error(`odd id: ${clip.id}`)
})
check('the imported settings were applied', () => {
  if (afterImport.settings?.volume !== 65) throw new Error(`volume: ${afterImport.settings?.volume}`)
})
check('the imported clip was written into the data folder', () => {
  const clip = (afterImport.sounds || []).find(sound => sound.name === 'clap')
  const file = `${clip?.id}.b64`
  if (!afterImport.written.includes(file)) throw new Error(`written: ${afterImport.written.join(',')}`)
})

// ── 4. the imported clip PLAYS (the effect, not the artefact) ─────────────
const importedClipId = (afterImport.sounds || []).find(sound => sound.name === 'clap')?.id
if (importedClipId) {
  await page.evaluate(id => {
    const sound = window.__state().sounds.find(item => item.id === id)
    window.__engine.play(sound)
  }, importedClipId)
  const played = await settle(
    'window.__audios.some(a => a.currentTime > 0.02)',
    'the imported clip decodes and starts playing'
  )
  check('an imported clip actually plays', () => {
    if (!played) throw new Error('no Audio element advanced past 0.02s')
  })
  // readyState >= 2 means metadata AND some data decoded.
  const readyState = await page.evaluate(() => window.__audios.at(-1)?.readyState ?? 0)
  check('the imported clip decoded past HAVE_CURRENT_DATA', () => {
    if (readyState < 2) throw new Error(`readyState: ${readyState}`)
  })
}

// ── 5. refusals: each failure names itself, and none of them writes ───────
const countNow = async () => ((await state()).sounds || []).length
const baseCount = await countNow()

await setupInput().setInputFiles(path.join(outDir, 'notes.txt'))
await settle('!!document.querySelector(".hermes-sb-setup-error")', 'a .txt file is refused')
const txtError = await errorText()
check('a non-JSON file is refused with a readable reason', () => {
  if (!txtError) throw new Error('no error line')
  if (!/[Jj][Ss][Oo][Nn]/.test(txtError)) throw new Error(`error: ${txtError}`)
})
{
  const now = await countNow()
  check('a refused file adds no pads', () => {
    if (now !== baseCount) throw new Error(`pads: ${now} (was ${baseCount})`)
  })
}

await setupInput().setInputFiles(path.join(outDir, 'plain.json'))
await settle(`!!document.querySelector(".hermes-sb-setup-error")`, 'foreign JSON is refused')
const jsonError = await errorText()
check('valid JSON that is not a setup is refused', () => {
  if (!/Soundboard/i.test(jsonError)) throw new Error(`error: ${jsonError}`)
})

await setupInput().setInputFiles(path.join(outDir, 'future.json'))
await settle(`!!document.querySelector(".hermes-sb-setup-error")`, 'a newer format is refused')
const newerError = await errorText()
check('a newer format version is named, not silently applied', () => {
  if (!/99/.test(newerError)) throw new Error(`error: ${newerError}`)
  if (!/newer|Update/i.test(newerError)) throw new Error(`error: ${newerError}`)
})
{
  const now = await countNow()
  check('the board survived every refusal intact', () => {
    if (now !== baseCount) throw new Error(`pads: ${now} (was ${baseCount})`)
  })
}

// ── 6. a bundle with an unplayable clip: reported, not stored silent ──────
// In the SAME session: a reload would re-read the settings the last import
// applied, and the pad count below must be the one this test just measured.
const emptyBase = await countNow()

await setupInput().setInputFiles(path.join(outDir, 'badclip.json'))
await settle('!!document.querySelector(".hermes-sb-setup-plan")', 'the plan appears for a mixed bundle')
const warnText = await page.$$eval('.hermes-sb-setup-plan-warn', nodes => nodes.map(n => n.textContent).join(' | '))
check('a pad whose clip is unusable is announced before importing', () => {
  if (!/skip/i.test(warnText)) throw new Error(`warnings: ${warnText}`)
})
await page.click('.hermes-sb-setup-confirm button[data-primary="true"]')
await settle('!document.querySelector(".hermes-sb-setup-plan")', 'the mixed bundle imports')
await page.waitForTimeout(200)
const mixed = await state()
check('only the playable pad is added', () => {
  const sounds = mixed.sounds || []
  if (sounds.length !== emptyBase + 1) throw new Error(`pads: ${sounds.length} (was ${emptyBase})`)
  if (!sounds.some(sound => sound.name === 'Kept')) throw new Error(`names: ${sounds.map(s => s.name).join(',')}`)
  if (sounds.some(sound => sound.name === 'Broken')) throw new Error('the broken pad was added anyway')
})
check('the import reports the pad it skipped', () => {
  const last = mixed.notices.at(-1)
  if (!last || !/skip/i.test(last.message)) throw new Error(`notice: ${JSON.stringify(last)}`)
})
check('settings from a setup with one usable pad still apply', () => {
  if (mixed.settings?.volume !== 44) throw new Error(`volume: ${mixed.settings?.volume}`)
})

// ── 7. a full board: add refuses, replace takes everything ────────────────
const filled = await page.evaluate(() => {
  const engine = window.__engine
  for (let i = 0; i < 60; i += 1) engine.addPreset('pop')
  return (window.__state().sounds || []).length
})
check('the board can be filled to its cap', () => {
  if (filled !== 40) throw new Error(`pads: ${filled}`)
})

await setupInput().setInputFiles(exportedPath)
await settle('!!document.querySelector(".hermes-sb-setup-plan")', 'the plan appears for a full board')
const fullTitle = await page.$eval('.hermes-sb-setup-plan-title', n => n.textContent).catch(() => '')
check('the plan states the file’s own pad count', () => {
  if (!/8/.test(fullTitle)) throw new Error(`title: ${fullTitle}`)
})
const disabled = await page.$eval('.hermes-sb-setup-confirm button[data-primary="true"]', n => n.disabled)
check('add is disabled when nothing fits, instead of importing zero', () => {
  if (!disabled) throw new Error('the confirm button was enabled with no room')
})
const fullWarn = await page.$$eval('.hermes-sb-setup-plan-warn', nodes => nodes.map(n => n.textContent).join(' | '))
check('the overflow is stated in pads and in the cap', () => {
  if (!/8/.test(fullWarn)) throw new Error(`warnings: ${fullWarn}`)
  if (!/40/.test(fullWarn)) throw new Error(`warnings: ${fullWarn}`)
})

await page.click('.hermes-sb-setup-mode[data-destructive="true"]')
const enabledAfter = await page.$eval('.hermes-sb-setup-confirm button[data-primary="true"]', n => n.disabled)
check('replace makes the same file importable', () => {
  if (enabledAfter) throw new Error('confirm stayed disabled in replace mode')
})
await page.click('.hermes-sb-setup-confirm button[data-primary="true"]')
await settle('!document.querySelector(".hermes-sb-setup-plan")', 'replace imports over a full board')
await page.waitForTimeout(250)
const finalState = await state()
check('replace leaves exactly the file’s pads', () => {
  const sounds = finalState.sounds || []
  if (sounds.length !== 8) throw new Error(`pads: ${sounds.length}`)
  if (sounds[0].name !== 'Pop') throw new Error(`first pad: ${sounds[0].name}`)
})
check('replace trashes the clips it displaced', () => {
  // Only .b64 blobs are left that belong to the new board.
  const blobs = finalState.written.filter(name => name.endsWith('.b64'))
  if (blobs.length !== 1) throw new Error(`stored clips: ${blobs.join(',')}`)
})
check('names are made unique rather than duplicated', () => {
  const names = (finalState.sounds || []).map(sound => sound.name)
  if (new Set(names).size !== names.length) throw new Error(`duplicates in ${names.join(',')}`)
})

// ── 8. the browser host: no files door, IndexedDB clips, a real reload ────
// Hermes Desktop is also served as a web app, where this same renderer runs
// in a browser tab with a window bridge that implements plugin loading but
// NOT `pluginFiles`: `ctx.files` is an object whose every call resolves
// "unavailable", plugin storage is localStorage, and IndexedDB is the
// browser's real one. A fresh context gives the page a clean origin state,
// the way a first visit would. Import used to skip every pad there.
const webappContext = await browser.newContext({
  viewport: { width: 520, height: 780 },
  deviceScaleFactor: 2,
  acceptDownloads: true
})
const webappPage = await webappContext.newPage()
webappPage.on('pageerror', error => console.log(`[webapp:error] ${error.message}`))

await webappPage.goto(`http://127.0.0.1:${server.address().port}/webapp.html`)
await webappPage.waitForFunction(() => window.__ready === true)
await webappPage.click('#chip button')
await webappPage.waitForSelector('.hermes-sb-panel')

const webappState = () => webappPage.evaluate(() => window.__state())
const webappSettle = async (predicate, label, timeout = 8000) => {
  try {
    await webappPage.waitForFunction(predicate, { timeout })
    return true
  } catch {
    console.log(`FAIL  ${label} (timed out)`)
    return false
  }
}
const webappSetupInput = () => webappPage.locator('.hermes-sb-panel input[type=file][accept*="json"]')

// Import the round-trip file — the one carrying the real WAV — as a
// REPLACEMENT, exactly the way section 3 imports it on the desktop host.
await webappSetupInput().setInputFiles(exportedPath)
await webappPage.waitForSelector('.hermes-sb-setup-plan')
await webappPage.click('.hermes-sb-setup-mode[data-destructive="true"]')
await webappPage.click('.hermes-sb-setup-confirm button[data-primary="true"]')
const webappImported = await webappSettle(
  '!document.querySelector(".hermes-sb-setup-plan") && (window.__state().sounds || []).length === 8',
  'the browser-host import lands all 8 pads'
)
const webappAfterImport = await webappState()
const webappClap = (webappAfterImport.sounds || []).find(sound => sound.name === 'clap')
check('a setup file imports on the browser host', () => {
  if (!webappImported) throw new Error('the import did not produce 8 pads')
  if (!webappClap) throw new Error(`pads: ${(webappAfterImport.sounds || []).map(sound => sound.name).join(',')}`)
})

const webappKeys = await webappPage.evaluate(() => window.__clipKeys())
check('the imported clip lives in the browser’s IndexedDB', () => {
  if (!webappKeys.includes(webappClap?.id)) throw new Error(`keys: ${JSON.stringify(webappKeys)}`)
})

if (webappClap) {
  await webappPage.evaluate(id => {
    const sound = window.__state().sounds.find(item => item.id === id)
    window.__engine.play(sound)
  }, webappClap.id)
  const webappPlayed = await webappSettle(
    'window.__audios.some(a => a.currentTime > 0.02)',
    'the browser-host clip plays'
  )
  check('the imported clip decodes and plays on the browser host', () => {
    if (!webappPlayed) throw new Error('no Audio element advanced past 0.02s')
  })
  const webappReady = await webappPage.evaluate(() => window.__audios.at(-1)?.readyState ?? 0)
  check('the browser-host clip decoded past HAVE_CURRENT_DATA', () => {
    if (webappReady < 2) throw new Error(`readyState: ${webappReady}`)
  })
}

// A reload is the real "does it persist" test: a fresh engine, an empty
// playback cache, pads from localStorage — and the clip from IndexedDB.
await webappPage.reload()
await webappPage.waitForFunction(() => window.__ready === true)
await webappPage.click('#chip button')
await webappPage.waitForSelector('.hermes-sb-panel')
const webappReloaded = await webappState()
check('the board survives a reload on the browser host', () => {
  const sounds = webappReloaded.sounds || []
  if (sounds.length !== 8) throw new Error(`pads: ${sounds.length}`)
  if (!sounds.some(sound => sound.name === 'clap')) throw new Error('the clip pad did not survive the reload')
})

if (webappClap) {
  await webappPage.evaluate(id => {
    const sound = window.__state().sounds.find(item => item.id === id)
    window.__engine.play(sound)
  }, webappClap.id)
  const webappReplayed = await webappSettle(
    'window.__audios.some(a => a.currentTime > 0.02)',
    'the reloaded clip plays from IndexedDB'
  )
  check('the clip still plays after a reload (empty cache, IndexedDB read)', () => {
    if (!webappReplayed) throw new Error('no Audio element advanced past 0.02s after reload')
  })
  const webappReReady = await webappPage.evaluate(() => window.__audios.at(-1)?.readyState ?? 0)
  check('the reloaded clip decoded past HAVE_CURRENT_DATA', () => {
    if (webappReReady < 2) throw new Error(`readyState: ${webappReReady}`)
  })
}

// Exporting must read the clips back out of the store the import wrote them
// into, or the file would ship pads with no audio.
const [webappDownload] = await Promise.all([
  webappPage.waitForEvent('download', { timeout: 15000 }),
  webappPage.click('.hermes-sb-panel button[aria-label="Export"]')
])
const webappTarget = path.join(downloadsDir, 'webapp-roundtrip.json')
await webappDownload.saveAs(webappTarget)
check('the browser-host export embeds the clip byte for byte', () => {
  const bundle = JSON.parse(fs.readFileSync(webappTarget, 'utf8'))
  const entry = bundle.sounds.find(sound => sound.name === 'clap')
  if (!entry) throw new Error(`pads: ${bundle.sounds.map(sound => sound.name).join(',')}`)
  const decoded = Buffer.from(String(entry.audio), 'base64')
  if (!decoded.equals(wav)) throw new Error(`bytes differ (${decoded.length} vs ${wav.length})`)
})

if (webappClap) {
  await webappPage.evaluate(id => window.__engine.remove(id), webappClap.id)
  const webappRemoved = await webappPage
    .waitForFunction(id => window.__clipKeys().then(keys => !keys.includes(id)), webappClap.id, { timeout: 5000 })
    .then(() => true, () => false)
  const webappAfterRemove = await webappState()
  check('removing a pad clears the browser store', () => {
    if ((webappAfterRemove.sounds || []).length !== 7) throw new Error(`pads: ${webappAfterRemove.sounds?.length}`)
    if (!webappRemoved) throw new Error('the clip is still in IndexedDB')
  })
}

await webappContext.close()

// ── report ───────────────────────────────────────────────────────────────
const failed = results.filter(row => !row.ok)
for (const row of results) console.log(`${row.ok ? 'PASS' : 'FAIL'}  ${row.name}${row.ok ? '' : `\n        ${row.error}`}`)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)

await browser.close()
server.close()
if (failed.length) process.exitCode = 1
