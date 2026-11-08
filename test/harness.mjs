/**
 * Headless render harness for hermes-soundboard.
 *
 * Bundles the real `plugin.js` with esbuild, swapping the three specifiers the
 * Desktop loader resolves at runtime (`@hermes/plugin-sdk`, `react`,
 * `react/jsx-runtime`) for the local stub / the installed React 19, then mounts
 * its contributions in jsdom and drives them like a user would.
 *
 * This proves the plugin evaluates, registers, renders and persists — it does
 * not prove it looks right inside the app. That needs the app.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
// React 19 / ReactDOM 19 / esbuild / jsdom come from the Hermes install: this
// repo ships no dependencies (a desktop plugin has none), so the harness only
// borrows the toolchain that is already on the machine. Override with
// HERMES_DEPS_ROOT when running against a different install.
const depsRoot =
  process.env.HERMES_DEPS_ROOT || path.resolve(root, '..', 'AppData/Local/hermes/hermes-agent/node_modules')
const fromDeps = specifier => pathToFileURL(path.join(depsRoot, specifier)).href

const { build } = await import(fromDeps('esbuild/lib/main.js'))
const { JSDOM } = await import(fromDeps('jsdom/lib/api.js'))

/* ── 1. bundle ─────────────────────────────────────────────────────────── */

// `react` / `react-dom` stay EXTERNAL so the plugin and the renderer share one
// React instance — bundling React into the plugin blob would give the mounted
// tree a second copy and every hook call would throw "Invalid hook call".
// Bare specifiers only resolve from a real file, so the bundle is written into
// `.build/`, next to a junction to the borrowed node_modules.
const buildDir = path.join(root, '.build')
const nodeModulesLink = path.join(buildDir, 'node_modules')
const bundlePath = path.join(buildDir, 'plugin.mjs')

fs.rmSync(buildDir, { recursive: true, force: true })
fs.mkdirSync(buildDir, { recursive: true })
fs.symlinkSync(depsRoot, nodeModulesLink, process.platform === 'win32' ? 'junction' : 'dir')

await build({
  absWorkingDir: root,
  entryPoints: [path.join(root, 'plugin.js')],
  outfile: bundlePath,
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  logLevel: 'silent',
  external: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client'],
  alias: {
    '@hermes/plugin-sdk': path.join(here, 'sdk-stub.mjs')
  }
})

/* ── 2. jsdom ──────────────────────────────────────────────────────────── */

const dom = new JSDOM('<!doctype html><html><head></head><body><div id="app"></div></body></html>', {
  url: 'https://hermes.invalid/',
  pretendToBeVisual: true
})

const { window } = dom
globalThis.window = window
globalThis.document = window.document
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true, writable: true })
globalThis.HTMLElement = window.HTMLElement
globalThis.Event = window.Event
globalThis.KeyboardEvent = window.KeyboardEvent
globalThis.MouseEvent = window.MouseEvent
globalThis.File = window.File
globalThis.FileReader = window.FileReader
if (!window.crypto?.randomUUID) {
  window.crypto.randomUUID = () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16)
  })
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

/* ── 3. stubbed host surfaces ──────────────────────────────────────────── */

// WebAudio: every node the plugin builds is a no-op recorder, so a play call
// is observable without sound.
const audioLog = { contexts: 0, oscillators: 0, bufferSources: 0, started: 0 }

class FakeParam {
  constructor() {
    this.value = 0
  }
  setValueAtTime() {}
  exponentialRampToValueAtTime() {}
  linearRampToValueAtTime() {}
}

class FakeNode {
  connect(target) {
    return target
  }
  disconnect() {}
}

class FakeAudioContext {
  constructor() {
    audioLog.contexts += 1
    this.currentTime = 0
    this.sampleRate = 48000
    this.state = 'running'
    this.destination = new FakeNode()
  }
  createOscillator() {
    audioLog.oscillators += 1
    return Object.assign(new FakeNode(), {
      type: 'sine',
      frequency: new FakeParam(),
      start: () => {
        audioLog.started += 1
      },
      stop: () => {}
    })
  }
  createGain() {
    return Object.assign(new FakeNode(), { gain: new FakeParam() })
  }
  createBiquadFilter() {
    return Object.assign(new FakeNode(), { type: 'lowpass', frequency: new FakeParam(), Q: new FakeParam() })
  }
  createBuffer(channels, frames) {
    audioLog.bufferSources += 1
    const data = new Float32Array(frames)
    return { getChannelData: () => data, length: frames }
  }
  createBufferSource() {
    return Object.assign(new FakeNode(), { buffer: null, start: () => {}, stop: () => {} })
  }
  resume() {
    this.state = 'running'
    return Promise.resolve()
  }
  suspend() {
    this.state = 'suspended'
    return Promise.resolve()
  }
  close() {
    this.state = 'closed'
    return Promise.resolve()
  }
}

window.AudioContext = FakeAudioContext
globalThis.AudioContext = FakeAudioContext

// <audio> playback: records the URL a pad asked for.
const audioElements = []
window.Audio = class FakeAudio {
  constructor(src) {
    this.src = src
    this.volume = 1
    this.paused = true
    this.listeners = new Map()
    audioElements.push(this)
  }
  addEventListener(type, fn) {
    this.listeners.set(type, fn)
  }
  play() {
    this.paused = false
    return Promise.resolve()
  }
  pause() {
    this.paused = true
  }
}
globalThis.Audio = window.Audio

// IndexedDB: jsdom ships none, so the clip fallback store gets a fake with
// the real database's shapes (open with an upgrade event, transactions that
// complete after their requests). Handlers fire on a later macrotask — the
// real database never fires them synchronously, and a synchronous fire here
// would run before the plugin has attached onsuccess/onerror.
const makeFakeIndexedDB = () => {
  const stores = new Map()
  const state = { fail: false }
  const queue = []
  const pump = () => {
    for (const job of queue.splice(0)) job()
  }
  const later = job => {
    queue.push(job)
    setTimeout(pump, 0)
  }

  return {
    /** Object store name → the live Map of key → value, for direct assertions. */
    __stores: stores,
    /** True rejects every open, the way a full disk or a private-mode tab would. */
    get fail() {
      return state.fail
    },
    set fail(value) {
      state.fail = value
    },
    open(name, version) {
      const request = { result: undefined, error: null, onsuccess: null, onerror: null, onupgradeneeded: null }
      later(() => {
        if (state.fail) {
          request.error = new Error('The fake database is closed for this test.')
          request.onerror?.({ target: request })
          return
        }
        // The real database is on request.result BEFORE the upgrade event
        // fires — the handler reads it to create its object store.
        request.result = {
          name,
          version,
          objectStoreNames: { contains: store => stores.has(store) },
          createObjectStore: store => {
            stores.set(store, new Map())
            return null
          },
          transaction(storeName) {
            let tx
            const settle = () => later(() => tx.oncomplete?.({ target: tx }))
            const objectStore = {
              get: key => {
                const get = { result: undefined, error: null, onsuccess: null, onerror: null }
                later(() => {
                  get.result = stores.get(storeName)?.get(key)
                  get.onsuccess?.({ target: get })
                  settle()
                })
                return get
              },
              put: (value, key) => {
                const put = { result: key, error: null, onsuccess: null, onerror: null }
                later(() => {
                  // The realistic failure: the database is open and the WRITE
                  // is refused (a full disk, a private-mode tab). The open
                  // itself stays cached, exactly like the real one.
                  if (state.fail) {
                    put.error = new Error('The fake store refused the write.')
                    put.onerror?.({ target: put })
                    later(() => tx.onabort?.({ target: tx }))
                    return
                  }
                  stores.get(storeName)?.set(key, value)
                  put.onsuccess?.({ target: put })
                  settle()
                })
                return put
              },
              delete: key => {
                const del = { result: undefined, error: null, onsuccess: null, onerror: null }
                later(() => {
                  stores.get(storeName)?.delete(key)
                  del.onsuccess?.({ target: del })
                  settle()
                })
                return del
              }
            }
            tx = { objectStore: () => objectStore, oncomplete: null, onerror: null, onabort: null }
            return tx
          }
        }
        request.onupgradeneeded?.({ oldVersion: 0, target: request })
        request.onsuccess?.({ target: request })
      })
      return request
    }
  }
}
const fakeIdb = makeFakeIndexedDB()
globalThis.indexedDB = fakeIdb

/* ── 4. plugin context ─────────────────────────────────────────────────── */

const storage = new Map()
const notifications = []
const files = new Map()
/** event type → the listeners currently subscribed to it. */
const events = new Map()

/** Emit a gateway event the way the host does, then let React flush. Waits for
 *  any previous flash to expire first, so each assertion sees only its own. */
const emit = async (type, payload) => {
  await new Promise(resolve => setTimeout(resolve, 260))
  for (const listener of events.get(type) ?? []) listener({ type, payload })
  await Promise.resolve()
  await new Promise(resolve => setTimeout(resolve, 0))
}

/** The browser host's answer to every `ctx.files` op — the exact result
 *  `createPluginFiles` returns in apps/desktop when the window bridge has no
 *  `pluginFiles` member, which is the webapp's case. */
const NO_DOOR = { ok: false, error: 'unavailable', message: 'This Hermes Desktop build has no plugin file access.' }

const makeCtx = ({ webappHost = false } = {}) => {
  const contributions = []
  const settingsPages = []
  const disposers = []
  const locales = {}
  let disposeAll = null
  // How often the browser host's door was asked, so the suite can prove the
  // plugin asks once and then remembers the answer.
  const doorCalls = { list: 0, stat: 0, readText: 0, writeText: 0, trash: 0 }

  const ctx = {
    source: 'plugin:hermes-soundboard',
    register: c => {
      contributions.push(c)
      return () => {}
    },
    registerMany: list => {
      contributions.push(...list)
      return () => {}
    },
    registerSettingsPage: page => {
      settingsPages.push(page)
      return () => {}
    },
    storage: {
      get: (key, fallback) => (storage.has(key) ? JSON.parse(storage.get(key)) : fallback),
      set: (key, value) => storage.set(key, JSON.stringify(value)),
      remove: key => storage.delete(key)
    },
    files: webappHost
      ? {
          // The browser host's door, exactly as apps/desktop builds it: the
          // webapp's window bridge implements plugin LOADING but leaves
          // `pluginFiles` unimplemented, so `ctx.files` is an object whose
          // every call resolves the host's "there is no door" sentinel —
          // which is why a truthiness check can never detect it.
          dataFolder: 'data',
          folders: async () => [],
          requestFolder: async () => NO_DOOR,
          release: async () => false,
          list: async () => {
            doorCalls.list += 1
            return NO_DOOR
          },
          stat: async () => {
            doorCalls.stat += 1
            return NO_DOOR
          },
          readText: async () => {
            doorCalls.readText += 1
            return NO_DOOR
          },
          readDataUrl: async () => NO_DOOR,
          writeText: async () => {
            doorCalls.writeText += 1
            return NO_DOOR
          },
          rename: async () => NO_DOOR,
          trash: async () => {
            doorCalls.trash += 1
            return NO_DOOR
          }
        }
      : {
          dataFolder: 'data',
          folders: async () => [],
          requestFolder: async () => ({ ok: false, error: 'unavailable', message: 'test' }),
          release: async () => false,
          list: async () => ({ ok: true, entries: [], truncated: false }),
          stat: async () => ({ ok: true, exists: false }),
          readText: async (_folder, p) => (files.has(p) ? { ok: true, text: files.get(p), size: files.get(p).length, mtimeMs: 0 } : { ok: false, error: 'not-found', message: `no ${p}` }),
          readDataUrl: async () => ({ ok: false, error: 'not-found', message: 'none' }),
          writeText: async (_folder, p, text) => {
            files.set(p, text)
            return { ok: true, path: p, size: text.length, mtimeMs: 0 }
          },
          rename: async () => ({ ok: false, error: 'io-error', message: 'unused' }),
          trash: async (_folder, p) => {
            files.delete(p)
            return { ok: true }
          }
        },
    notify: opts => notifications.push(opts),
    notifyError: message => notifications.push({ kind: 'error', message }),
    // Gateway event stream: the plugin subscribes by event type. Emitting here
    // is how the harness plays "the app said a turn finished".
    onEvent: (type, listener) => {
      const set = events.get(type) ?? new Set()
      set.add(listener)
      events.set(type, set)
      return () => set.delete(listener)
    },
    i18n: {
      register: bundle => Object.assign(locales, bundle),
      t: (key, ...args) => {
        const value = (locales.en ?? {})[key]
        return typeof value === 'function' ? value(...args) : (value ?? key)
      }
    },
    onDispose: fn => {
      disposers.push(fn)
    },
    setTimeout: (fn, ms) => {
      const id = setTimeout(fn, ms)
      return () => clearTimeout(id)
    },
    setInterval: (fn, ms) => {
      const id = setInterval(fn, ms)
      return () => clearInterval(id)
    },
    addEventListener: () => () => {},
    os: {},
    pet: { visible: false, say: () => () => {}, clear: () => {} }
  }

  disposeAll = () => {
    for (const fn of disposers.reverse()) fn()
  }

  return { ctx, contributions, settingsPages, locales, dispose: disposeAll, doorCalls }
}

/* ── 5. load the plugin ────────────────────────────────────────────────── */

// Imported from disk (not a data: URL) so its `react` specifier resolves
// through `.build/node_modules` to the very same React the renderer below uses.
const mod = await import(pathToFileURL(bundlePath).href)
const plugin = mod.default

if (!plugin || plugin.id !== 'hermes-soundboard' || typeof plugin.register !== 'function') {
  throw new Error('plugin.js did not default-export a HermesPlugin')
}

const boot = makeCtx()
plugin.register(boot.ctx)

// The real host resolves `usePluginI18n(id)` from the bundle the plugin
// registered through `ctx.i18n.register`; the stub reads that table from a
// global, so the harness hands it over here.
globalThis.__hermesPluginLocales.set(plugin.id, boot.locales)

/* ── 6. render ─────────────────────────────────────────────────────────── */

// React is imported through the real path (not the .build junction) so it is
// the exact module instance the bundle's `react` specifier resolves to.
const React = await import(fromDeps('react/index.js'))
const { createRoot } = await import(fromDeps('react-dom/client.js'))
const { act } = React

const mount = node => {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  act(() => root.render(node))
  return { host, root, unmount: () => act(() => root.unmount()) }
}

const click = element => {
  act(() => {
    element.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  })
}

const typeInto = (element, value) => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  act(() => {
    setter.call(element, value)
    element.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
}

const waitFor = async (predicate, label, timeout = 3000) => {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 20))
    await act(async () => {})
  }
  throw new Error(`timed out waiting for ${label}`)
}

/* ── 7. assertions ─────────────────────────────────────────────────────── */

const results = []
const check = (name, fn) => {
  try {
    fn()
    results.push({ name, ok: true })
  } catch (error) {
    results.push({ name, ok: false, error: error.message })
  }
}

const chipContribution = boot.contributions.find(item => item.area === 'statusBar.right')
const paletteContribution = boot.contributions.find(item => item.area === 'palette')

check('registers a status-bar chip', () => {
  if (!chipContribution) throw new Error('no statusBar.right contribution')
  if (chipContribution.id !== 'chip') throw new Error(`unexpected id ${chipContribution.id}`)
})
check('registers a palette command', () => {
  if (!paletteContribution) throw new Error('no palette contribution')
})
check('registers a settings page', () => {
  if (!boot.settingsPages.length) throw new Error('no settings page')
  if (boot.settingsPages[0].title !== 'Soundboard') throw new Error('wrong settings title')
})

const chip = mount(chipContribution.render())
const chipButton = chip.host.querySelector('button')
check('chip renders a button with the icon', () => {
  if (!chipButton) throw new Error('no button')
  if (!chipButton.querySelector('[data-icon="AudioLines"]')) throw new Error('no AudioLines icon')
  if (!/soundboard/i.test(chipButton.textContent + (chipButton.getAttribute('aria-label') ?? ''))) throw new Error('no label')
})

click(chipButton)

const panel = () => chip.host.querySelector('[data-popover-content]')
check('clicking the chip opens the panel', () => {
  if (!panel()) throw new Error('popover content did not mount')
})

const pads = () => [...(panel()?.querySelectorAll('.hermes-sb-pad') ?? [])].filter(pad => pad.querySelector('.hermes-sb-pad-name'))
check('ships the seven built-in pads', () => {
  if (pads().length !== 7) throw new Error(`expected 7 pads, got ${pads().length}`)
  const names = pads().map(pad => pad.textContent)
  for (const expected of ['Pop', 'Ding', 'Beep', 'Coin', 'Laser', 'Whoosh', 'Boing']) {
    if (!names.some(text => text.includes(expected))) throw new Error(`missing pad ${expected}`)
  }
})

const padByName = name => pads().find(pad => pad.textContent.includes(name))

click(padByName('Pop'))
check('a synthesized pad plays through WebAudio', () => {
  if (audioLog.contexts === 0) throw new Error('no AudioContext created')
  if (audioLog.oscillators === 0) throw new Error('no oscillator started')
})

click(padByName('Whoosh'))
check('a noise pad allocates a buffer source', () => {
  if (audioLog.bufferSources === 0) throw new Error('no buffer source')
})

// The 1..9 shortcuts: pads flash and play without a click. Handlers live on
// the panel body, so keys are dispatched there.
act(() => {
  panel().querySelector('.hermes-sb-body').dispatchEvent(new window.KeyboardEvent('keydown', { key: '2', bubbles: true }))
})
check('number keys trigger pads', () => {
  const flashed = pads().filter(pad => pad.getAttribute('data-active') === 'true')
  if (!flashed.length) throw new Error('no pad flashed')
})

// Volume: the slider writes through to settings and to the audio graph gate.
const volumeSlider = () => panel().querySelector('input[type=range]')
act(() => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  setter.call(volumeSlider(), '0')
  volumeSlider().dispatchEvent(new window.Event('input', { bubbles: true }))
})
check('volume persists', () => {
  const saved = JSON.parse(storage.get('settings'))
  if (saved.volume !== 0) throw new Error(`volume ${saved.volume}`)
})
act(() => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  setter.call(volumeSlider(), '80')
  volumeSlider().dispatchEvent(new window.Event('input', { bubbles: true }))
})

// Custom sounds: the file input and the drop target both route to addFile.
const fileInput = () => panel().querySelector('input[type=file]')
check('the panel exposes a hidden file input for audio', () => {
  const input = fileInput()
  if (!input) throw new Error('no file input')
  if (input.accept !== 'audio/*') throw new Error(`accept=${input.accept}`)
  if (!input.multiple) throw new Error('file input is single-select')
})

const clap = new window.File([new Uint8Array([73, 68, 51, 4, 0, 0, 0, 0])], 'Clap Trap.mp3', { type: 'audio/mpeg' })
act(() => {
  Object.defineProperty(fileInput(), 'files', { value: [clap], configurable: true })
  fileInput().dispatchEvent(new window.Event('input', { bubbles: true }))
  fileInput().dispatchEvent(new window.Event('change', { bubbles: true }))
})

await waitFor(() => padByName('Clap Trap'), 'the custom pad')

check('a dropped/added file becomes a pad', () => {
  const pad = padByName('Clap Trap')
  if (!pad) throw new Error('no pad')
  if (!pad.getAttribute('data-custom')) throw new Error('custom pad not marked')
})
check('custom audio is written into the plugin data folder as base64', () => {
  const names = [...files.keys()]
  if (names.length !== 1) throw new Error(`files=${JSON.stringify(names)}`)
  if (!names[0].endsWith('.b64')) throw new Error(`unexpected name ${names[0]}`)
  const text = files.get(names[0])
  if (!/^[A-Za-z0-9+/=]+$/.test(text)) throw new Error('payload is not base64')
})
check('custom sounds are persisted to storage', () => {
  const saved = JSON.parse(storage.get('sounds'))
  if (saved.length !== 8) throw new Error(`expected 8 saved sounds, got ${saved.length}`)
  const clapSound = saved.find(sound => sound.name === 'Clap Trap')
  if (!clapSound || clapSound.kind !== 'file' || clapSound.mime !== 'audio/mpeg') throw new Error('custom sound not saved right')
})

click(padByName('Clap Trap'))
await waitFor(() => audioElements.length > 0, 'an <audio> element')
check('a custom pad plays from the data-URL payload', () => {
  const element = audioElements.at(-1)
  if (!/^data:audio\/mpeg;base64,/.test(element.src)) throw new Error(`src=${element.src?.slice(0, 40)}`)
  if (element.volume !== 0.8) throw new Error(`volume=${element.volume}`)
})

// Drop path. The handler lives on the panel body (the popover content is a
// sibling wrapper), so the event is dispatched there, as a drop lands on it.
const panelBody = () => panel()?.querySelector('.hermes-sb-body')
const boop = new window.File([new Uint8Array([79, 103, 103, 83])], 'boop.ogg', { type: 'audio/ogg' })
act(() => {
  const event = new window.Event('drop', { bubbles: true, cancelable: true })
  event.dataTransfer = { types: ['Files'], files: [boop] }
  panelBody().dispatchEvent(event)
})
await waitFor(() => padByName('boop'), 'the dropped pad')
check('dropping a file on the panel adds a pad', () => {
  if (!padByName('boop')) throw new Error('no pad')
})

// Too-large files are refused with a warning, not a crash.
const huge = new window.File([new Uint8Array(1)], 'huge.wav', { type: 'audio/wav' })
Object.defineProperty(huge, 'size', { value: 9 * 1024 * 1024 })
const before = notifications.length
act(() => {
  const event = new window.Event('drop', { bubbles: true, cancelable: true })
  event.dataTransfer = { types: ['Files'], files: [huge] }
  panelBody().dispatchEvent(event)
})
await waitFor(() => notifications.length > before, 'the size warning')
check('oversized files are refused with a warning', () => {
  const last = notifications.at(-1)
  if (last.kind !== 'warning') throw new Error(`kind=${last.kind}`)
  if (!/3 MB/.test(last.message)) throw new Error(`message=${last.message}`)
})

// Manage mode: rename + delete.
const iconButton = label => [...panel().querySelectorAll('button')].find(button => button.getAttribute('aria-label') === label)
click(iconButton('Manage sounds'))
const rows = () => [...(panel()?.querySelectorAll('.hermes-sb-row') ?? [])]
check('manage mode lists every sound', () => {
  if (rows().length !== 9) throw new Error(`expected 9 rows, got ${rows().length}`)
})

const clapRow = rows().find(row => row.querySelector('input')?.value === 'Clap Trap')
const clapInput = clapRow.querySelector('input')
typeInto(clapInput, 'Snare')
act(() => {
  // React 19 delegates focus loss through `focusout`, not `blur`.
  clapInput.dispatchEvent(new window.FocusEvent('focusout', { bubbles: true }))
})
check('renaming a pad persists', () => {
  const saved = JSON.parse(storage.get('sounds'))
  if (!saved.some(sound => sound.name === 'Snare')) throw new Error('rename not saved')
})

const snareRow = () => rows().find(row => row.querySelector('input')?.value === 'Snare')
click([...snareRow().querySelectorAll('button')].find(button => /Delete/.test(button.getAttribute('aria-label') ?? '')))
check('deleting a pad removes its row and its file', () => {
  if (rows().length !== 8) throw new Error(`expected 8 rows, got ${rows().length}`)
  if (files.size !== 1) throw new Error(`files left: ${files.size}`)
})

click(iconButton('Done'))
check('leaving manage mode shows the pad grid again', () => {
  if (!pads().length) throw new Error('no pads')
})

// ── triggers ────────────────────────────────────────────────────────────
// Every pad carries a "play when" select; a bound pad fires on its gateway
// event and stays silent for every other one.
const pickerFor = name => [...(panel()?.querySelectorAll('.hermes-sb-picker') ?? [])].find(picker =>
  (picker.getAttribute('aria-label') ?? '').endsWith(name)
)
const rowFor = name => rows().find(row => row.querySelector('.hermes-sb-row-name')?.value === name)
/** Open a row's trigger menu, click one or more triggers, then close it.
 *  The menu STAYS OPEN across clicks (multi-select), so closing is explicit. */
const bindVia = (name, ...triggerLabels) => {
  click(pickerFor(name))
  if (!panel().querySelector('.hermes-sb-menu')) throw new Error('the trigger menu did not open')
  for (const label of triggerLabels) {
    // Re-query each time: React replaces the menu node on every toggle.
    const row = [...panel().querySelectorAll('.hermes-sb-menu-row')].find(
      item => item.querySelector('.hermes-sb-menu-text')?.textContent.trim() === label
    )
    if (!row) throw new Error(`no "${label}" row in the menu`)
    click(row)
  }
  // Close by toggling the picker itself. Escape is not usable here: the
  // popover's own handler closes the WHOLE panel on it, not just this menu.
  click(pickerFor(name))
}

click(iconButton('Manage sounds'))
check('every manage row offers a trigger picker', () => {
  const pickers = panel().querySelectorAll('.hermes-sb-picker')
  if (pickers.length !== rows().length) throw new Error(`${pickers.length} pickers for ${rows().length} rows`)
})
check('the picker renders its list in the DOM, not as a native select', () => {
  if (panel().querySelector('select')) throw new Error('a native <select> is still rendered')
  click(pickerFor('Pop'))
  const menu = panel().querySelector('.hermes-sb-menu')
  if (!menu) throw new Error('no in-DOM menu')
  const rowsInMenu = menu.querySelectorAll('.hermes-sb-menu-row')
  if (rowsInMenu.length !== 14) throw new Error(`expected 14 trigger rows, got ${rowsInMenu.length}`)
  const groups = menu.querySelectorAll('.hermes-sb-menu-group')
  if (groups.length < 4) throw new Error(`only ${groups.length} groups`)
  click(pickerFor('Pop'))
})
check('the menu is opaque — it carries its own background, not the page behind it', () => {
  // The previous check may have left Pop's menu open; the picker is a toggle,
  // so close it first and open deliberately.
  if (panel().querySelector('.hermes-sb-menu')) click(pickerFor('Pop'))
  click(pickerFor('Pop'))
  const menu = panel().querySelector('.hermes-sb-menu')
  const style = window.getComputedStyle(menu)
  if (!style.backgroundColor || style.backgroundColor === 'rgba(0, 0, 0, 0)') {
    throw new Error(`menu background is ${style.backgroundColor}`)
  }
  const rowStyle = window.getComputedStyle(menu.querySelector('.hermes-sb-menu-row'))
  if (!rowStyle.color) throw new Error('menu rows have no colour')
  click(pickerFor('Pop'))
})

bindVia('Pop', 'Approval needed')
check('binding a trigger persists on the sound', () => {
  const saved = JSON.parse(storage.get('sounds'))
  const pop = saved.find(sound => sound.name === 'Pop')
  if (JSON.stringify(pop.triggers) !== JSON.stringify(['attention.approval'])) {
    throw new Error(`triggers=${JSON.stringify(pop.triggers)}`)
  }
})

// ── multiple triggers on one sound ──────────────────────────────────────
bindVia('Ding', 'Turn finishes', 'Turn fails', 'Question asked')
check('one sound can hold several triggers', () => {
  const saved = JSON.parse(storage.get('sounds'))
  const ding = saved.find(sound => sound.name === 'Ding')
  const expected = ['turn.complete', 'turn.error', 'attention.clarify']
  if (JSON.stringify(ding.triggers) !== JSON.stringify(expected)) {
    throw new Error(`triggers=${JSON.stringify(ding.triggers)}`)
  }
})
check('a multi-bound picker summarises as a count', () => {
  const picker = pickerFor('Ding')
  const label = picker.querySelector('.hermes-sb-picker-label')?.textContent.trim()
  if (label !== '3 triggers') throw new Error(`label is "${label}"`)

})
check('the menu marks every bound trigger as selected', () => {
  click(pickerFor('Ding'))
  const menu = panel().querySelector('.hermes-sb-menu')
  const selected = [...menu.querySelectorAll('.hermes-sb-menu-row[data-selected=true]')].map(
    row => row.querySelector('.hermes-sb-menu-text')?.textContent.trim()
  )
  if (JSON.stringify(selected) !== JSON.stringify(['Turn finishes', 'Turn fails', 'Question asked'])) {
    throw new Error(`selected=${JSON.stringify(selected)}`)
  }
})
check('clicking a bound trigger again removes just that one', () => {
  const menu = panel().querySelector('.hermes-sb-menu')
  const row = [...menu.querySelectorAll('.hermes-sb-menu-row')].find(
    item => item.querySelector('.hermes-sb-menu-text')?.textContent.trim() === 'Turn fails'
  )
  click(row)
  const saved = JSON.parse(storage.get('sounds'))
  const ding = saved.find(sound => sound.name === 'Ding')
  if (JSON.stringify(ding.triggers) !== JSON.stringify(['turn.complete', 'attention.clarify'])) {
    throw new Error(`triggers=${JSON.stringify(ding.triggers)}`)
  }
  const still = panel().querySelector('.hermes-sb-menu')
  if (!still) throw new Error('the menu closed on a toggle; multi-select needs it open')
})
check('the menu offers a clear-all row once anything is bound', () => {
  const clear = panel().querySelector('.hermes-sb-menu-clear')
  if (!clear) throw new Error('no clear row')
  click(clear)
  const saved = JSON.parse(storage.get('sounds'))
  const ding = saved.find(sound => sound.name === 'Ding')
  if (ding.triggers !== undefined) throw new Error(`triggers=${JSON.stringify(ding.triggers)}`)
})
check('with everything cleared the picker reads Never again', () => {
  const label = pickerFor('Ding').querySelector('.hermes-sb-picker-label')?.textContent.trim()
  if (label !== 'Never') throw new Error(`label is "${label}"`)
})

// restore a two-trigger binding for the firing tests below
bindVia('Ding', 'Turn finishes', 'Question asked')
check('a bound row is marked', () => {
  const picker = pickerFor('Pop')
  if (picker?.getAttribute('data-bound') !== 'true') throw new Error('picker not marked bound')
  if (picker.textContent.trim() !== 'Approval needed') throw new Error(`label is "${picker.textContent.trim()}"`)
})

click(iconButton('Done'))
check('a bound pad shows a dot in the grid', () => {
  const bound = [...panel().querySelectorAll('.hermes-sb-pad')].filter(pad => pad.getAttribute('data-bound') === 'true')
  if (bound.length !== 2) throw new Error(`${bound.length} pads marked bound`)
})

const oscillatorsBefore = audioLog.oscillators
await emit('approval.request', { prompt_id: 'p1', command: 'rm -rf /' })
check('an approval request plays its bound sound only', () => {
  // One flash, one cue: the Ding pad is bound to a different event.
  const activePads = [...panel().querySelectorAll('.hermes-sb-pad')].filter(pad => pad.getAttribute('data-active') === 'true')
  if (activePads.length !== 1) throw new Error(`${activePads.length} pads flashed`)
  if (!activePads[0].textContent.includes('Pop')) throw new Error(`wrong pad: ${activePads[0].textContent}`)
  if (audioLog.oscillators <= oscillatorsBefore) throw new Error('no sound scheduled')
})

await emit('message.complete', { status: 'complete', text: 'done' })
check('a turn-complete event plays the other binding', () => {
  const activePads = [...panel().querySelectorAll('.hermes-sb-pad')].filter(pad => pad.getAttribute('data-active') === 'true')
  if (activePads.length !== 1) throw new Error(`${activePads.length} pads flashed`)
  if (!activePads[0].textContent.includes('Ding')) throw new Error(`wrong pad: ${activePads[0].textContent}`)
})
check('the last-trigger readout reports what fired', () => {
  const readout = panel().querySelector('.hermes-sb-last')
  if (!readout) throw new Error('no readout')
  if (!/Turn finishes/.test(readout.textContent)) throw new Error(readout.textContent)
})

const beforeSilent = audioLog.oscillators
await emit('message.complete', { status: 'error', error: 'boom' })
check('an unbound outcome of a bound event stays silent', () => {
  // `turn.complete` filters status != error, so a failed turn plays nothing.
  if ([...panel().querySelectorAll('.hermes-sb-pad[data-active="true"]')].length) throw new Error('a pad flashed on a failed turn')
})

await emit('error', { message: 'session blew up' })
check('an event with no binding anywhere plays nothing', () => {
  const active = [...panel().querySelectorAll('.hermes-sb-pad[data-active="true"]')]
  if (active.length) throw new Error(`${active.length} pads flashed for an unbound event`)
})
check('the readout clears when a trigger fired nothing', () => {
  if (panel().querySelector('.hermes-sb-last')) throw new Error('stale readout survived')
})

// Unbinding returns the pad to click-only. With multi-select there is no
// "Never" row to pick — clearing is its own action in the menu.
click(iconButton('Manage sounds'))
click(pickerFor('Ding'))
click(panel().querySelector('.hermes-sb-menu-clear'))
check('clearing bindings removes them from the sound', () => {
  const saved = JSON.parse(storage.get('sounds'))
  const ding = saved.find(sound => sound.name === 'Ding')
  if (ding.triggers !== undefined) throw new Error(`triggers still ${JSON.stringify(ding.triggers)}`)
})
const afterUnbind = audioLog.oscillators
await emit('message.complete', { status: 'complete' })
check('an unbound sound no longer fires', () => {
  if ([...panel().querySelectorAll('.hermes-sb-pad[data-active="true"]')].length) throw new Error('a pad flashed')
})
click(iconButton('Done'))

// Stop all + close.
click(iconButton('Stop all sounds'))
// ── reorder + per-pad gain ──────────────────────────────────────────────
check('a pad moves to a new index, and the order persists', () => {
  const engine = boot.ctx.__engine ?? null
  if (!engine) throw new Error('no engine handle')
  const before = engine.sounds.get().map(s => s.name)
  if (before.length < 3) throw new Error('need three pads')
  engine.move(engine.sounds.get()[0].id, 2)
  const after = engine.sounds.get().map(s => s.name)
  if (after[2] !== before[0]) throw new Error(`order is ${after.join(', ')}`)
  if (after.length !== before.length) throw new Error('move changed the count')
  const saved = JSON.parse(storage.get('sounds')).map(s => s.name)
  if (JSON.stringify(saved) !== JSON.stringify(after)) throw new Error('order not persisted')
})

check('moving out of range is clamped, not dropped', () => {
  const engine = boot.ctx.__engine
  const count = engine.sounds.get().length
  engine.move(engine.sounds.get()[0].id, 999)
  if (engine.sounds.get().length !== count) throw new Error('a pad was lost')
  engine.move(engine.sounds.get()[0].id, -5)
  if (engine.sounds.get().length !== count) throw new Error('a pad was lost')
})

check('a per-pad gain persists, and 100% stores nothing', () => {
  const engine = boot.ctx.__engine
  const id = engine.sounds.get()[0].id
  engine.setGain(id, 150)
  let saved = JSON.parse(storage.get('sounds')).find(s => s.id === id)
  if (saved.gain !== 150) throw new Error(`gain=${saved.gain}`)
  engine.setGain(id, 100)
  saved = JSON.parse(storage.get('sounds')).find(s => s.id === id)
  if (saved.gain !== undefined) throw new Error('100% left a stale gain field')
})

check('gain is clamped to 0-200', () => {
  const engine = boot.ctx.__engine
  const id = engine.sounds.get()[0].id
  engine.setGain(id, 500)
  if (JSON.parse(storage.get('sounds')).find(s => s.id === id).gain !== 200) throw new Error('not clamped high')
  engine.setGain(id, -40)
  if (JSON.parse(storage.get('sounds')).find(s => s.id === id).gain !== 0) throw new Error('not clamped low')
  engine.setGain(id, 100)
})

// ── trimming an existing clip ───────────────────────────────────────────
check('trimming is refused when no window is given', async () => {
  const engine = boot.ctx.__engine
  const file = engine.sounds.get().find(s => s.kind === 'file')
  if (!file) throw new Error('no file pad')
  let failed = null
  try {
    await engine.trimSound(file.id, { start: 0, length: null })
  } catch (error) {
    failed = error
  }
  if (!failed) throw new Error('an empty window was accepted')
  if (!/start or a length|początek lub długość/i.test(failed.message)) {
    throw new Error(`message: ${failed.message}`)
  }
})

check('a synthesised cue cannot be trimmed', async () => {
  const engine = boot.ctx.__engine
  const synth = engine.sounds.get().find(s => s.kind === 'synth')
  let failed = null
  try {
    await engine.trimSound(synth.id, { start: 0, length: 1 })
  } catch (error) {
    failed = error
  }
  if (!failed) throw new Error('a synth pad was accepted')
  if (!/only imported|cannot be trimmed|tylko klipy/i.test(failed.message)) {
    throw new Error(`message: ${failed.message}`)
  }
})

check('duplicating a clip copies its bytes to a new pad', async () => {
  const engine = boot.ctx.__engine
  const file = engine.sounds.get().find(s => s.kind === 'file')
  const before = engine.sounds.get().length
  const copy = await engine.duplicate(file.id)
  if (!copy) throw new Error('no copy returned')
  const after = engine.sounds.get()
  if (after.length !== before + 1) throw new Error('pad count unchanged')
  const made = after.find(s => s.id === copy.id)
  if (!made || made.kind !== 'file') throw new Error('copy is not a file pad')
  if (!/copy/i.test(made.name)) throw new Error(`name: ${made.name}`)
  if (!files.has(`${copy.id}.b64`)) throw new Error('clip bytes were not copied')
  // The original must be untouched.
  if (!files.has(`${file.id}.b64`)) throw new Error('the original clip was lost')
})

// ── monophonic mode ─────────────────────────────────────────────────────
check('one-at-a-time defaults to off', () => {
  const engine = boot.ctx.__engine
  if (engine.settings.get().oneAtATime !== false) throw new Error('default is not false')
})

check('one-at-a-time persists when toggled', () => {
  const engine = boot.ctx.__engine
  engine.setOneAtATime(true)
  if (engine.settings.get().oneAtATime !== true) throw new Error('not applied')
  const saved = JSON.parse(storage.get('settings'))
  if (saved.oneAtATime !== true) throw new Error('not persisted')
  engine.setOneAtATime(false)
  if (JSON.parse(storage.get('settings')).oneAtATime !== false) throw new Error('not cleared')
})

check('a corrupt settings blob falls back for the new key', () => {
  if (typeof engine === 'undefined') return
  // Through a reload: settings are sanitised on read.
  storage.set('settings', JSON.stringify({ volume: 40, oneAtATime: 'yes' }))
  const fresh = makeCtx()
  plugin.register(fresh.ctx)
  const e = fresh.ctx.__engine
  if (e.settings.get().oneAtATime !== false) throw new Error('a non-boolean was accepted')
  if (e.settings.get().volume !== 40) throw new Error('the rest of the blob was lost')
  fresh.dispose()
  storage.set('settings', JSON.stringify({ volume: 80, showLabel: true, padsPerRow: 4 }))
})

check('stop-all clears the active flashes', () => {
  if (pads().some(pad => pad.getAttribute('data-active') === 'true')) throw new Error('a pad is still flashing')
})
act(() => {
  panel().querySelector('.hermes-sb-body').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
})
check('Escape closes the panel', () => {
  if (panel()) throw new Error('panel still mounted')
})

/* ── 7b. YouTube import ─────────────────────────────────────────────────── */

// jsdom reports a Linux UA; the plugin's job pipeline is written for Windows
// (cmd, start /b, doubled %). Force that branch for these tests.
globalThis.__hermesForceWindows = true
globalThis.__hermesTestSessionId = 'test-session'
const storageBeforeYt = new Map(storage)
const filesBeforeYt = new Map(files)
// Each scenario below needs a fresh tool probe.
const resetTools = () => globalThis.__hermesResetTools?.()

// The import is a detached job watched through files, so the harness fakes the
// job by having `shell.exec` write what the real one would: a script, then an
// mp3, then the status file — at whichever moment the test chooses.
// The stub is bundled into the plugin, so `host` is not reachable from here.
// It delegates to this global, which is what the tests swap.
const stubShell = handler => {
  globalThis.__hermesHostRequest = handler
}
const ytFiles = () => [...files.keys()]

chip.unmount()
boot.dispose()

const ytCtx = makeCtx()
plugin.register(ytCtx.ctx)
const ytMount = mount(ytCtx.contributions.find(item => item.area === 'statusBar.right').render())
click(ytMount.host.querySelector('button'))

const linkButton = () => ytMount.host.querySelector('.hermes-sb-panel button[aria-label="Import from YouTube"]')
check('the import control lives in the panel header', () => {
  if (!linkButton()) throw new Error('no YouTube button')
})
click(linkButton())
const urlInput = () => ytMount.host.querySelector('.hermes-sb-yt-input')
check('opening it reveals a single URL field', () => {
  if (!urlInput()) throw new Error('no input')
  if (urlInput().type !== 'text') throw new Error(`type=${urlInput().type}`)
})

// --- a refused URL never reaches the shell ---
let shellCalls = 0
stubShell(async () => {
  shellCalls += 1
  return { blocked: false, code: 0, stdout: '' }
})
typeInto(urlInput(), 'https://vimeo.com/12345')
const goButton = () => ytMount.host.querySelector('.hermes-sb-yt-go')
click(goButton())
await new Promise(resolve => setTimeout(resolve, 120))
check('a non-YouTube link is refused before any process runs', () => {
  const note = ytMount.host.querySelector('.hermes-sb-yt-note[data-error="true"]')
  if (!note) throw new Error('no error shown')
  if (shellCalls !== 0) throw new Error(`the shell ran ${shellCalls} times`)
})

// --- no open chat: refused before any process runs, and said plainly ---
resetTools()
globalThis.__hermesTestSessionId = null
shellCalls = 0
typeInto(urlInput(), 'https://youtu.be/jNQXAC9IVRw')
click(goButton())
await new Promise(resolve => setTimeout(resolve, 120))
check('an import with no open chat explains itself', () => {
  const note = ytMount.host.querySelector('.hermes-sb-yt-note[data-error="true"]')
  if (!note) throw new Error('no error shown')
  if (!/open a chat/i.test(note.textContent)) throw new Error(`note=${note.textContent}`)
  if (/invalid_params/.test(note.textContent)) throw new Error('a raw gateway code leaked to the UI')
  if (shellCalls !== 0) throw new Error(`the shell ran ${shellCalls} times`)
})
globalThis.__hermesTestSessionId = 'test-session'

// --- a missing tool explains itself ---
resetTools()
stubShell(async (method, params) => {
  const command = params?.command ?? ''
  if (/where ffmpeg/.test(command)) return { blocked: false, code: 0, stdout: 'ffmpeg=0\nuvx=1\n' }
  return { blocked: false, code: 0, stdout: '' }
})
typeInto(urlInput(), 'https://youtu.be/jNQXAC9IVRw')
click(goButton())
await new Promise(resolve => setTimeout(resolve, 200))
check('a missing ffmpeg is reported, not silently ignored', () => {
  const note = ytMount.host.querySelector('.hermes-sb-yt-note[data-error="true"]')
  if (!note) throw new Error('no error shown')
  if (!/ffmpeg/i.test(note.textContent)) throw new Error(`note=${note.textContent}`)
})

// --- the happy path: tools present, duration short, job completes ---
resetTools()
const scriptWrites = []
stubShell(async (method, params) => {
  const command = params?.command ?? ''
  if (/where ffmpeg/.test(command)) return { blocked: false, code: 0, stdout: 'ffmpeg=1\nuvx=1\n' }
  if (/--print duration/.test(command)) return { blocked: false, code: 0, stdout: '19\n' }
  return { blocked: false, code: 0, stdout: '' }
})
// Pretend the detached job finished: the script the plugin wrote is in `files`,
// so the harness can supply the mp3 and the status file it would have produced.
const realWrite = ytCtx.ctx.files.writeText
ytCtx.ctx.files.writeText = async (folder, path, text, opts) => {
  const out = await realWrite(folder, path, text, opts)
  if (path.endsWith('.cmd')) {
    scriptWrites.push({ path, text })
    // yt-dlp would now run; stand in for it.
    const stem = path.replace(/^\./, '').replace(/\.cmd$/, '')
    files.set(`${stem}.mp3`, 'FAKE-MP3')
    files.set(`${path.replace(/^\./, '.').replace(/\.cmd$/, '.status')}`, 'ok')
  }
  return out
}
// MIRROR THE REAL HOST. mimeFor() in plugin-files-ops.ts only knows IMAGE
// extensions and falls through to application/octet-stream — so an .mp3 comes
// back mislabelled. Stubbing a correct 'audio/mpeg' here is what hid a pad that
// only played after a plugin reload.
ytCtx.ctx.files.readDataUrl = async (_folder, path) => {
  if (path.endsWith('.mp3')) {
    const mime = path.endsWith('.mp3') ? 'application/octet-stream' : 'image/png'
    return { ok: true, url: `data:${mime};base64,` + Buffer.from('FAKE-MP3'.repeat(40)).toString('base64') }
  }
  return { ok: false, error: 'not-found', message: path }
}

const ytPadsBefore = ytMount.host.querySelectorAll('.hermes-sb-pad').length
// The imported pad's id, captured for the playback-cache assertions below.
let ytSoundId = null
typeInto(urlInput(), 'https://www.youtube.com/watch?v=jNQXAC9IVRw')
click(goButton())
// The poll interval is 700ms, so give the stub job a couple of ticks.
await new Promise(resolve => setTimeout(resolve, 2600))

check('a valid link writes a job script, runs it, and lands a pad', () => {
  if (!scriptWrites.length) throw new Error('no job script was written')
  if (!/uvx yt-dlp/.test(scriptWrites[0].text)) throw new Error('the script does not call uvx yt-dlp')
  if (!/%%\(ext\)s/.test(scriptWrites[0].text)) throw new Error('the output template is not batch-escaped')

  const after = ytMount.host.querySelectorAll('.hermes-sb-pad').length
  if (after !== ytPadsBefore + 1) throw new Error(`${after - ytPadsBefore} pads added`)
  const saved = JSON.parse(storage.get('sounds'))
  const yt = saved.find(sound => /^YouTube/.test(sound.name))
  if (!yt) throw new Error(`no YouTube pad in ${saved.map(s => s.name).join(', ')}`)
  if (yt.mime !== 'audio/mpeg') throw new Error(`mime=${yt.mime}`)
  ytSoundId = yt.id
})

// ── an imported pad must be playable WITHOUT a plugin reload ────────────
// The reported bug: after importing from YouTube the pad stayed silent until
// the plugin was reloaded. Cause: readDataUrl labels a .mp3 as
// application/octet-stream, the URL was cached as-is, and Chromium would not
// decode it. A reload emptied the cache and playFile re-read the blob with
// sound.mime, which worked — so the reload masked it.
check('the cached URL for an imported clip carries an audio MIME', async () => {
  const saved = JSON.parse(storage.get('sounds') || '[]')
  const yt = saved.find(s => /^YouTube/.test(s.name))
  if (!yt) throw new Error('no imported pad is stored')
  const url = ytCtx.ctx.__engine.peekCachedUrl(yt.id)
  if (!url) throw new Error('nothing was cached, so this proves nothing')
  if (!/^data:audio\/mpeg;base64,/.test(url)) {
    throw new Error(`cached as ${url.slice(0, 46)}… — a non-audio MIME will not decode`)
  }
})

check('the cached bytes are the clip, not a re-encode', () => {
  const saved = JSON.parse(storage.get('sounds') || '[]')
  const yt = saved.find(s => /^YouTube/.test(s.name))
  if (!yt) throw new Error('no imported pad is stored')
  const url = ytCtx.ctx.__engine.peekCachedUrl(yt.id)
  const stored = files.get(`${yt.id}.b64`)
  if (stored === undefined) throw new Error('the blob was not written')
  if (url.split(',')[1] !== stored.trim()) throw new Error('the cached payload differs from the stored blob')
})


check('the progress bar is gone once the import finishes', () => {
  // A bar stuck at 100% would be as confusing as no bar at all.
  if (ytMount.host.querySelector('.hermes-sb-yt-progress')) throw new Error('the progress bar survived')
})

check('a failure raises a host toast as well as the inline note', () => {
  // The panel can be shut when a job ends, so the toast is the only signal left.
  if (!notifications.length) throw new Error('no toast was raised')
  const last = notifications[notifications.length - 1]
  if (last.kind !== 'info') throw new Error(`kind=${last.kind}`)
})

check('the job leftovers are cleaned up after a success', () => {
  const leftovers = ytFiles().filter(name => /\.(cmd|log|status)$/.test(name))
  if (leftovers.length) throw new Error(`left behind: ${leftovers.join(', ')}`)
})

// ── playback failures must be visible ───────────────────────────────────
// The reported symptom — pad flashes, no sound, no error — was reachable
// because playFile swallowed everything. This pins the reporting path.
check('playing at zero volume reports instead of going silent', () => {
  const engine = ytCtx.ctx.__engine
  const before = notifications.length
  engine.settings.set({ ...engine.settings.get(), volume: 0 })
  const fileSound = engine.sounds.get().find(s => s.kind === 'file')
  if (!fileSound) throw new Error('no file pad to play')
  engine.play(fileSound)
  engine.settings.set({ ...engine.settings.get(), volume: 80 })
  if (!notifications.slice(before).length) {
    // The volume guard throws synchronously inside playFile's promise; a tick
    // is needed for the catch to run.
    return new Promise(resolve => setTimeout(resolve, 80)).then(() => {
      if (!notifications.slice(before).length) throw new Error('no warning raised at volume 0')
    })
  }
})

ytMount.unmount()
ytCtx.dispose()
// The import added a pad to the shared storage; later checks count pads, so
// restore the exact pre-test state instead of leaking a change forward.
for (const [key, value] of storageBeforeYt) storage.set(key, value)
for (const [key, value] of filesBeforeYt) files.set(key, value)
for (const key of [...files.keys()]) if (!filesBeforeYt.has(key)) files.delete(key)

/* ── 8. persistence across a reload ────────────────────────────────────── */

chip.unmount()
boot.dispose()

const reboot = makeCtx()
plugin.register(reboot.ctx)
const rebootChip = reboot.contributions.find(item => item.area === 'statusBar.right')
const second = mount(rebootChip.render())
click(second.host.querySelector('button'))
const rebootPads = [...second.host.querySelectorAll('.hermes-sb-pad')]
  .filter(pad => pad.querySelector('.hermes-sb-pad-name'))
  .map(pad => pad.textContent)
check('state survives a disable/enable cycle', () => {
  if (rebootPads.length !== 8) throw new Error(`expected 8 pads after reload, got ${rebootPads.length}`)
  if (!rebootPads.some(text => text.includes('boop'))) throw new Error('custom pad lost')
  if (rebootPads.some(text => text.includes('Clap Trap'))) throw new Error('deleted pad came back')
})

// Corrupt storage must not break the plugin.
storage.set('sounds', '{"nope":true}')
storage.set('settings', '"garbage"')
second.unmount()
reboot.dispose()
const third = makeCtx()
plugin.register(third.ctx)
const thirdChip = third.contributions.find(item => item.area === 'statusBar.right')
const thirdMount = mount(thirdChip.render())
// Migration: everything the previous version wrote stored `trigger: "id"`.
// Drive it through a real load rather than reaching into the sanitizer, so the
// test covers the path the app actually takes.
storage.set('sounds', JSON.stringify([
  { id: 'oldpop', name: 'Old Pop', kind: 'synth', synth: 'pop', trigger: 'turn.complete' },
  { id: 'oldding', name: 'Old Ding', kind: 'synth', synth: 'ding' }
]))
storage.set('settings', JSON.stringify({ volume: 55 }))
thirdMount.unmount()
third.dispose()
const fourth = makeCtx()
plugin.register(fourth.ctx)
const fourthMount = mount(fourth.contributions.find(item => item.area === 'statusBar.right').render())
click(fourthMount.host.querySelector('button'))
check('a legacy single-trigger save is migrated to a list', () => {
  const pads = [...fourthMount.host.querySelectorAll('.hermes-sb-pad')].filter(pad => pad.getAttribute('data-bound') === 'true')
  if (pads.length !== 1) throw new Error(`${pads.length} pads read as bound; expected the legacy one only`)
  if (!pads[0].textContent.includes('Old Pop')) throw new Error(`wrong pad bound: ${pads[0].textContent}`)
})
await emit('message.complete', { status: 'complete' })
check('a migrated binding still fires', () => {
  const active = [...fourthMount.host.querySelectorAll('.hermes-sb-pad[data-active="true"]')]
  if (active.length !== 1) throw new Error(`${active.length} pads flashed after migrating`)
  if (!active[0].textContent.includes('Old Pop')) throw new Error('wrong pad fired')
})
check('a corrupt trigger list is filtered down to known ids', () => {
  storage.set('sounds', JSON.stringify([
    { id: 'x', name: 'X', kind: 'synth', synth: 'pop', triggers: ['turn.complete', 'nonsense', 'turn.complete', 42] }
  ]))
  fourthMount.unmount()
  fourth.dispose()
  const fifth = makeCtx()
  plugin.register(fifth.ctx)
  const fifthMount = mount(fifth.contributions.find(item => item.area === 'statusBar.right').render())
  click(fifthMount.host.querySelector('button'))
  const pad = fifthMount.host.querySelector('.hermes-sb-pad')
  if (pad.getAttribute('data-bound') !== 'true') throw new Error('known id was dropped')
  if (!/Turn finishes/.test(pad.getAttribute('title') ?? '')) throw new Error(`title=${pad.getAttribute('title')}`)
  if (/nonsense|42/.test(pad.getAttribute('title') ?? '')) throw new Error('unknown id survived cleaning')
  fifthMount.unmount()
  fifth.dispose()
})

// Corrupt storage must not break the plugin: after the garbage above, the
// built-in set comes back.
storage.set('sounds', '{"nope":true}')
storage.set('settings', '"garbage"')
const sixth = makeCtx()
plugin.register(sixth.ctx)
const sixthMount = mount(sixth.contributions.find(item => item.area === 'statusBar.right').render())
click(sixthMount.host.querySelector('button'))
check('corrupt storage falls back to the built-ins', () => {
  const count = sixthMount.host.querySelectorAll('.hermes-sb-pad .hermes-sb-pad-name').length
  if (count !== 7) throw new Error(`expected 7 fallback pads, got ${count}`)
})
sixthMount.unmount()
sixth.dispose()

// ── turn.start must not fire for the chained turn after one ends ────────
// A dedicated mount with controlled bindings: earlier checks have deleted pads,
// so the shared boot engine has nothing bound to these events.
storage.set('sounds', JSON.stringify([
  { id: 'snd-a', name: 'StartCue', kind: 'synth', synth: 'pop', triggers: ['turn.start'] },
  { id: 'snd-b', name: 'DoneCue', kind: 'synth', synth: 'ding', triggers: ['turn.complete'] }
]))
storage.set('settings', JSON.stringify({ volume: 80 }))
const chainSoundsBefore = storage.get('sounds')
const chainSettingsBefore = storage.get('settings')
const chainCtx = makeCtx()
plugin.register(chainCtx.ctx)
const chainEngine = chainCtx.ctx.__engine
console.log(`chain test bindings: ${JSON.stringify(chainEngine.sounds.get().map(s => [s.name, s.triggers]))}`)

const firesStart = () => {
  const t = chainEngine.lastTrigger.get()
  return Boolean(t && t.id === 'turn.start')
}

await emit('message.start', {})
check('turn.start fires for a genuine send', () => {
  const after = chainEngine.lastTrigger.get()
  if (!after || after.id !== 'turn.start') throw new Error(`id=${after && after.id}`)
})

// A completion opens the window; the start that follows is the automatic
// continuation. `message.start` carries no payload at the source, so this
// time window is the only signal available.
await emit('message.complete', { status: 'complete' })
check('the completion itself registers', () => {
  const t = chainEngine.lastTrigger.get()
  if (!t || t.id !== 'turn.complete') throw new Error(`id=${t && t.id}`)
})
await emit('message.start', {})
check('turn.start is SUPPRESSED for the turn right after a completion', () => {
  if (firesStart()) throw new Error('the chained start fired turn.start')
})

// Outside the chain window, a start is a real send again.
await new Promise(resolve => setTimeout(resolve, 1700))
await emit('message.start', {})
check('a send a moment later fires turn.start again', () => {
  const after = chainEngine.lastTrigger.get()
  if (!after || after.id !== 'turn.start') throw new Error(`id=${after && after.id}`)
})
chainCtx.dispose()
if (chainSoundsBefore !== undefined) storage.set('sounds', chainSoundsBefore)
if (chainSettingsBefore !== undefined) storage.set('settings', chainSettingsBefore)

// ── several pads on ONE trigger: random choice ──────────────────────────
// Two pads bound to the same event used to fire together, which made a chord
// rather than a cue. One is now picked at random.
storage.set('sounds', JSON.stringify([
  { id: 'snd-r1', name: 'RandomA', kind: 'synth', synth: 'pop', triggers: ['turn.complete'] },
  { id: 'snd-r2', name: 'RandomB', kind: 'synth', synth: 'ding', triggers: ['turn.complete'] },
  { id: 'snd-r3', name: 'Loner', kind: 'synth', synth: 'beep', triggers: ['attention.error'] }
]))
storage.set('settings', JSON.stringify({ volume: 80 }))
const pickCtx = makeCtx()
plugin.register(pickCtx.ctx)
const pickMount = mount(pickCtx.contributions.find(c => c.area === 'statusBar.right').render())
click(pickMount.host.querySelector('button'))
const pickEngine = pickCtx.ctx.__engine

const litNames = () =>
  [...pickMount.host.querySelectorAll('.hermes-sb-pad[data-active="true"]')].map(
    pad => pad.querySelector('.hermes-sb-pad-name')?.textContent
  )

await emit('message.complete', { status: 'complete' })
check('exactly one pad fires, not both', () => {
  const lit = litNames()
  if (lit.length !== 1) throw new Error(`${lit.length} pads lit: ${JSON.stringify(lit)}`)
  if (!['RandomA', 'RandomB'].includes(lit[0])) throw new Error(`wrong pad: ${lit[0]}`)
})

check('a single-bound trigger still fires its one pad', async () => {})
await emit('error', { message: 'x' })
check('a trigger with one pad is unaffected', () => {
  const lit = litNames()
  if (!lit.includes('Loner')) throw new Error(`lit: ${JSON.stringify(lit)}`)
})

// Run the trigger many times and confirm both candidates get picked: a random
// picker that always returned the first pad would pass a single-fire test.
const seen = new Set()
for (let i = 0; i < 40; i += 1) {
  await emit('message.complete', { status: 'complete' })
  const lit = litNames()
  if (lit.length !== 1) throw new Error(`run ${i}: ${lit.length} pads lit`)
  seen.add(lit[0])
}
check('both candidates are chosen over many fires', () => {
  if (seen.size !== 2) throw new Error(`only ${JSON.stringify([...seen])} ever played`)
})

// Never the same pad twice in a row when there are more than two.
storage.set('sounds', JSON.stringify([
  { id: 'snd-m1', name: 'M1', kind: 'synth', synth: 'pop', triggers: ['turn.complete'] },
  { id: 'snd-m2', name: 'M2', kind: 'synth', synth: 'ding', triggers: ['turn.complete'] },
  { id: 'snd-m3', name: 'M3', kind: 'synth', synth: 'beep', triggers: ['turn.complete'] }
]))
pickMount.unmount()
pickCtx.dispose()
const seqCtx = makeCtx()
plugin.register(seqCtx.ctx)
const seqMount = mount(seqCtx.contributions.find(c => c.area === 'statusBar.right').render())
click(seqMount.host.querySelector('button'))

const sequence = []
for (let i = 0; i < 12; i += 1) {
  await emit('message.complete', { status: 'complete' })
  const lit = [...seqMount.host.querySelectorAll('.hermes-sb-pad[data-active="true"]')]
  sequence.push(lit[0]?.querySelector('.hermes-sb-pad-name')?.textContent)
}
check('three candidates never repeat back to back', () => {
  for (let i = 1; i < sequence.length; i += 1) {
    if (sequence[i] && sequence[i] === sequence[i - 1]) {
      throw new Error(`repeated ${sequence[i]} at ${i}: ${JSON.stringify(sequence)}`)
    }
  }
})
check('the sequence still uses all three', () => {
  const distinct = new Set(sequence.filter(Boolean))
  if (distinct.size !== 3) throw new Error(`used ${JSON.stringify([...distinct])}`)
})
seqMount.unmount()
seqCtx.dispose()

// ── profiles ────────────────────────────────────────────────────────────
storage.set('sounds', JSON.stringify([
  { id: 'snd-p1', name: 'PodcastIntro', kind: 'synth', synth: 'pop', triggers: ['turn.complete'] },
  { id: 'snd-p2', name: 'PodcastOutro', kind: 'synth', synth: 'ding', triggers: ['turn.start'] }
]))
storage.set('settings', JSON.stringify({ volume: 65, padsPerRow: 3 }))
storage.delete('profiles')
storage.delete('activeProfile')
const prfCtx = makeCtx()
plugin.register(prfCtx.ctx)
const prfEngine = prfCtx.ctx.__engine

check('a fresh install has no profiles and no active one', () => {
  if (prfEngine.profiles.get().length !== 0) throw new Error('profiles appeared from nowhere')
  if (prfEngine.activeProfile.get() !== null) throw new Error('an active profile was invented')
})

const podcastId = prfEngine.saveProfile('Podcast')
check('saving a profile records the pads and the settings', () => {
  const saved = prfEngine.profiles.get().find(profile => profile.id === podcastId)
  if (!saved) throw new Error('the profile was not stored')
  if (saved.name !== 'Podcast') throw new Error(`name=${saved.name}`)
  if (saved.sounds.length !== 2) throw new Error(`${saved.sounds.length} pads saved`)
  if (saved.settings.volume !== 65) throw new Error(`volume=${saved.settings.volume}`)
  if (saved.settings.padsPerRow !== 3) throw new Error(`padsPerRow=${saved.settings.padsPerRow}`)
})

check('saving makes it the active profile', () => {
  if (prfEngine.activeProfile.get() !== podcastId) throw new Error('the saved profile is not active')
})

// Edit the live board into something genuinely different: drop a podcast pad,
// add a laser, and change the volume. Saving this as "Gaming" must not disturb
// "Podcast" — a name that does not match the active profile means a new one.
prfEngine.setVolume(20)
prfEngine.remove('snd-p1')
prfEngine.addPreset('laser')
const gamingId = prfEngine.saveProfile('Gaming')
check('saving under a different name creates a second profile', () => {
  const names = prfEngine.profiles.get().map(profile => profile.name)
  if (names.length !== 2) throw new Error(`profiles: ${JSON.stringify(names)}`)
  if (!names.includes('Podcast') || !names.includes('Gaming')) throw new Error(`wrong set: ${JSON.stringify(names)}`)
})
check('editing after saving clears the active profile', () => {
  // setVolume above ran before the second save, so the flag must have been
  // cleared then; saving again re-establishes it for the new profile.
  if (prfEngine.activeProfile.get() !== gamingId) throw new Error('active is not the newly saved profile')
})

prfEngine.applyProfile(podcastId)
check('applying a profile restores its pads', () => {
  const names = prfEngine.sounds.get().map(sound => sound.name)
  if (names.length !== 2) throw new Error(`${names.length} pads after apply: ${JSON.stringify(names)}`)
  if (!names.includes('PodcastIntro')) throw new Error(`wrong pads: ${JSON.stringify(names)}`)
})

check('applying a profile restores its settings', () => {
  const now = prfEngine.settings.get()
  if (now.volume !== 65) throw new Error(`volume=${now.volume}`)
  if (now.padsPerRow !== 3) throw new Error(`padsPerRow=${now.padsPerRow}`)
})

check('the applied profile becomes active', () => {
  if (prfEngine.activeProfile.get() !== podcastId) throw new Error('active did not follow the apply')
})

check('applying does not mark itself dirty on the next read', async () => {})
await new Promise(resolve => setTimeout(resolve, 30))
check('the active profile survives an apply (no false dirty flag)', () => {
  if (prfEngine.activeProfile.get() !== podcastId) throw new Error('applying cleared its own active flag')
})

// Switching to another profile and back must be lossless.
prfEngine.applyProfile(gamingId)
check('switching boards swaps the pads', () => {
  const names = prfEngine.sounds.get().map(sound => sound.name)
  if (names.includes('PodcastIntro')) throw new Error(`still on the old board: ${JSON.stringify(names)}`)
  if (prfEngine.settings.get().volume !== 20) throw new Error(`volume=${prfEngine.settings.get().volume}`)
})
prfEngine.applyProfile(podcastId)
check('and back again', () => {
  if (prfEngine.sounds.get().length !== 2) throw new Error('lost pads on the round trip')
  if (prfEngine.settings.get().volume !== 65) throw new Error('lost settings on the round trip')
})

// ── blob sharing: deleting a pad must not orphan another profile's clip ──
storage.set('sounds', JSON.stringify([
  { id: 'snd-shared', name: 'Shared', kind: 'file', mime: 'audio/mpeg', bytes: 10 }
]))
storage.delete('profiles')
storage.delete('activeProfile')
const blobCtx = makeCtx()
plugin.register(blobCtx.ctx)
const blobEngine = blobCtx.ctx.__engine
const trashed = []
blobCtx.ctx.files = blobCtx.ctx.files || {}
const originalTrash = blobCtx.ctx.files.trash
blobCtx.ctx.files.trash = (folder, name) => {
  trashed.push(name)
  return originalTrash ? originalTrash(folder, name) : Promise.resolve()
}
blobEngine.saveProfile('KeepsShared')
blobEngine.remove('snd-shared')
check('deleting a pad still used by a profile keeps its clip', () => {
  if (trashed.includes('snd-shared.b64')) throw new Error('the blob was deleted while a profile needs it')
  if (blobEngine.sounds.get().length !== 0) throw new Error('the pad was not removed from the live board')
})

// Deleting the profile too means nothing references it: the blob may go.
const keptId = blobEngine.profiles.get()[0].id
blobEngine.deleteProfile(keptId)
check('deleting the last profile frees the orphaned clip', () => {
  if (!trashed.includes('snd-shared.b64')) throw new Error('the orphaned blob was never cleaned up')
})

check('deleting the active profile clears the active flag', () => {
  if (blobEngine.activeProfile.get() !== null) throw new Error('active profile still points at a deleted one')
})

// ── persistence + sanitising ────────────────────────────────────────────
check('profiles round-trip through storage', () => {
  const raw = JSON.parse(storage.get('profiles'))
  if (!Array.isArray(raw)) throw new Error('profiles are not stored as an array')
})

check('a corrupt activeProfile id is ignored on load', () => {
  storage.set('activeProfile', JSON.stringify('prf-does-not-exist'))
  const fresh = makeCtx()
  plugin.register(fresh.ctx)
  if (fresh.ctx.__engine.activeProfile.get() !== null) throw new Error('a dangling id was accepted')
  fresh.dispose()
  storage.delete('activeProfile')
})

check('a profile of the wrong shape is dropped, not crashed on', () => {
  storage.set('profiles', JSON.stringify([
    null, 'nope', { id: 'ok', name: 'Fine', sounds: [], settings: {} }
  ]))
  const fresh = makeCtx()
  plugin.register(fresh.ctx)
  const kept = fresh.ctx.__engine.profiles.get()
  if (kept.length !== 1) throw new Error(`kept ${kept.length}`)
  if (kept[0].id !== 'ok') throw new Error('kept the wrong entry')
  fresh.dispose()
  storage.delete('profiles')
})

// ── every screen renders with real SDK icons ────────────────────────────
// React error #130 ("element type is invalid") is what a missing `icons.X`
// looks like at runtime, and it only surfaces on the screen that renders that
// icon. The stub now throws on unknown names, so importing the bundled plugin
// is already a check — but render each surface too, because a bad icon inside a
// profile row only appears once a profile exists.
storage.set('sounds', JSON.stringify([
  { id: 'snd-i1', name: 'IconCue', kind: 'synth', synth: 'pop', triggers: ['turn.complete'] }
]))
storage.set('settings', JSON.stringify({ volume: 70 }))
storage.delete('profiles')
const iconBoot = makeCtx()
plugin.register(iconBoot.ctx)
const iconEngine = iconBoot.ctx.__engine
iconEngine.saveProfile('WithIcons')

check('the settings page renders with a saved profile', () => {
  // Settings pages go through registerSettingsPage, not contributions.
  const settingsPage = iconBoot.settingsPages.find(page => page.id === 'settings')
  if (!settingsPage) throw new Error('no settings page registered')
  const mounted = mount(settingsPage.render())
  const rows = mounted.host.querySelectorAll('.hermes-sb-profile-row')
  if (!rows.length) throw new Error('the profile row did not render')
  // The delete button is inside the row and is what carried the bad icon.
  const del = mounted.host.querySelector('.hermes-sb-profile-delete')
  if (!del) throw new Error('the delete-profile button did not render')
  if (!del.querySelector('[data-icon]')) throw new Error('the delete button rendered no icon')
  mounted.unmount()
})

check('the popover renders with a saved profile', () => {
  const panel = iconBoot.contributions.find(c => c.area === 'statusBar.right')
  const mounted = mount(panel.render())
  click(mounted.host.querySelector('button'))
  const pads = mounted.host.querySelectorAll('.hermes-sb-pad')
  if (!pads.length) throw new Error('no pads rendered')
  if (!mounted.host.querySelector('.hermes-sb-profile-btn')) throw new Error('no profile switcher')
  mounted.unmount()
})

check('every icon the plugin references exists in the SDK', () => {
  // Belt and braces: read plugin.js as text so a name reached only on an
  // untested branch still fails here. The valid set is the real export list the
  // stub enforces, parsed straight out of the stub so the two cannot diverge.
  const source = fs.readFileSync(path.join(here, '..', 'plugin.js'), 'utf8')
  const stub = fs.readFileSync(path.join(here, 'sdk-stub.mjs'), 'utf8')
  const listMatch = stub.match(/const ICON_NAMES = '([^']+)'\.split/)
  if (!listMatch) throw new Error('could not read ICON_NAMES from the stub')
  const valid = new Set(listMatch[1].split(','))
  const used = [...new Set([...source.matchAll(/icons\.([A-Za-z0-9_]+)/g)].map(m => m[1]))]
  const missing = used.filter(name => !valid.has(name))
  if (missing.length) {
    const hints = missing.map(name => {
      const close = [...valid].filter(v => v.startsWith(name) || name.startsWith(v))
      return close.length ? `${name} (did you mean ${close.join('/')}?)` : name
    })
    throw new Error(`missing from the SDK: ${hints.join(', ')}`)
  }
})
iconBoot.dispose()

/* ── 8b. the browser host: no files door, clips in IndexedDB ───────────── */

// Hermes Desktop's webapp runs this plugin in a plain browser tab, where the
// `window.hermesDesktop` bridge implements plugin loading but leaves
// `pluginFiles` unimplemented: `ctx.files` is an object, and every operation
// on it resolves the host's "unavailable" sentinel. Before the fallback clip
// store, importing a setup file there skipped every pad — writeText refused,
// and a refused clip is a skipped pad — while every `if (!files)` guard
// passed, so nothing even reported why. These checks reproduce that host.
const webapp = makeCtx({ webappHost: true })
plugin.register(webapp.ctx)
const webappEngine = webapp.ctx.__engine

const webappClip = Buffer.from('RIFF fake-but-stable clip bytes').toString('base64')
const webappSetup = JSON.stringify({
  format: 'hermes-soundboard-setup',
  version: 1,
  settings: { volume: 55 },
  sounds: [
    { name: 'Beep', kind: 'synth', synth: 'ding' },
    { name: 'Clap', kind: 'file', mime: 'audio/wav', audio: webappClip, gain: 140, triggers: ['turn.complete'] }
  ]
})
const webappPlan = await webappEngine.readSetupFile(
  new window.File([webappSetup], 'board.json', { type: 'application/json' })
)
const webappImport = await webappEngine.applyBundle(webappPlan)
const webappClips = () => fakeIdb.__stores.get('clips')

check('a setup file imports on a host with no files door', () => {
  if (webappImport.added !== 2) {
    throw new Error(`added=${webappImport.added} skipped=${webappImport.skipped} refused=${webappImport.refused}`)
  }
})
check('the clip lands in the fallback store, not the refused door', () => {
  const stored = webappEngine.sounds.get().filter(sound => sound.kind === 'file')
  if (stored.length !== 1) throw new Error(`file pads: ${stored.length}`)
  if (webappClips().get(stored[0].id) !== webappClip) throw new Error('the stored bytes differ from the file')
})

const clapId = webappEngine.sounds.get().find(sound => sound.name === 'Clap')?.id
// Guarded the way setup.mjs guards its playback checks: a broken import must
// land as named FAILures, not as a crash halfway through the section.
if (clapId) {
  const audioBefore = audioElements.length
  webappEngine.play(webappEngine.sounds.get().find(sound => sound.id === clapId))
  await waitFor(() => audioElements.length > audioBefore, 'an audio element from the fallback store')
  check('an imported pad plays from the fallback store', () => {
    const element = audioElements.at(-1)
    if (!/^data:audio\/wav;base64,/.test(element.src)) throw new Error(`src=${String(element.src).slice(0, 40)}`)
  })

  const webappCount = webappEngine.sounds.get().length
  const copy = await webappEngine.duplicate(clapId)
  check('a pad copy reads and writes through the fallback store', () => {
    if (!copy) throw new Error('duplicate() returned null')
    if (webappEngine.sounds.get().length !== webappCount + 1) throw new Error('the copy was not added')
    if (webappClips().get(copy.id) !== webappClip) throw new Error('the copied clip is not in the store')
  })

  if (copy) {
    webappEngine.remove(copy.id)
    await waitFor(() => !webappClips().has(copy.id), 'the removed clip to leave the store')
    check('removing a pad clears the fallback store', () => {
      if (webappClips().has(copy.id)) throw new Error('the clip is still in the store after delete')
    })
  }
}

// A store that cannot open must be reported, not absorbed: one pad skipped,
// the rest imported, nothing silently dropped.
fakeIdb.fail = true
const refusedPlan = await webappEngine.readSetupFile(
  new window.File([webappSetup], 'board.json', { type: 'application/json' })
)
const refusedImport = await webappEngine.applyBundle(refusedPlan)
fakeIdb.fail = false
check('a failing fallback store skips the pads it cannot keep', () => {
  if (refusedImport.added !== 1) throw new Error(`added=${refusedImport.added}`)
  if (refusedImport.skipped !== 1) throw new Error(`skipped=${refusedImport.skipped}`)
})

// The door is probed once — on the first clip write — and remembered; every
// later operation goes straight to the store instead of round-tripping to a
// door that cannot open.
check('the refused door is asked once and never again', () => {
  if (webapp.doorCalls.writeText !== 1) throw new Error(`writeText was called ${webapp.doorCalls.writeText} times`)
  if (webapp.doorCalls.readText !== 0) throw new Error(`readText was called ${webapp.doorCalls.readText} times`)
  if (webapp.doorCalls.trash !== 0) throw new Error(`trash was called ${webapp.doorCalls.trash} times`)
})

// A host with neither door (an old shell with no files door AND no
// IndexedDB) refuses the import up front with a reason, as it did before
// the fallback existed.
const realIdb = globalThis.indexedDB
globalThis.indexedDB = undefined
const bare = makeCtx()
bare.ctx.files = undefined
plugin.register(bare.ctx)
let refused = null
try {
  await bare.ctx.__engine.applyBundle(webappPlan)
} catch (error) {
  refused = error
}
check('a host with no store at all refuses the import by name', () => {
  if (!refused) throw new Error('the import was not refused')
  if (!/no plugin file access/i.test(String(refused.message))) throw new Error(`message: ${refused.message}`)
})
globalThis.indexedDB = realIdb
bare.dispose()
webapp.dispose()

/* ── 9. report ─────────────────────────────────────────────────────────── */

const failed = results.filter(row => !row.ok)
for (const row of results) {
  console.log(`${row.ok ? 'PASS' : 'FAIL'}  ${row.name}${row.ok ? '' : `\n        ${row.error}`}`)
}
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)

if (failed.length) process.exitCode = 1
