/**
 * hermes-soundboard — a soundboard in the Hermes Desktop bottom bar.
 *
 * Controls live in the status bar (`statusBar.right`): a chip opens a popover
 * of pads. Pads are either synthesized (WebAudio, no files needed) or the
 * user's own audio files, which are copied into the plugin's private data
 * folder through `ctx.files` (base64 text, ≤ 4 MiB each) so they survive a
 * restart without touching the user's disk anywhere else.
 *
 * Disk plugin contract: plain ESM, loaded uncompiled, so UI is `jsx()` calls
 * and the only imports are `@hermes/plugin-sdk`, `react`, `react/jsx-runtime`.
 */

import {
  atom,
  Button,
  haptic,
  host,
  icons,
  Input,
  PALETTE_AREA,
  Popover,
  PopoverContent,
  PopoverTrigger,
  STATUSBAR_AREAS,
  Tip,
  usePluginI18n,
  useValue
} from '@hermes/plugin-sdk'
import { useCallback, useEffect, useRef, useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

const ID = 'hermes-soundboard'

/** `ctx.files.writeText` refuses more than 4 MiB; base64 inflates by 4/3. */
const MAX_FILE_BYTES = 3 * 1024 * 1024
const MAX_NAME_LEN = 24
const MAX_SOUNDS = 40
const MAX_PROFILES = 12
const FLASH_MS = 220

// ── youtube import ────────────────────────────────────────────────────────
// A YouTube link is converted to mp3 by yt-dlp (which needs ffmpeg for the
// transcode). Neither ships with Hermes, so both are probed before the field
// is offered — a URL box that always fails is worse than no URL box.
//
// The conversion runs as a DETACHED child, because the only process door a
// plugin has is `host.request('shell.exec')` and it kills anything at 30s —
// a 4-minute song takes longer than that. So the command starts the job and
// returns in ~2s, and the plugin watches the job's status file. That file is
// the only channel back: shell.exec captures output at launch and is gone.
const YT_MAX_SECONDS = 30
const YT_POLL_MS = 700
const YT_TIMEOUT_MS = 180000

// `oneAtATime` is the monophonic mode: starting a sound stops whatever is still
// playing, so overlapping clips never stack.
const DEFAULT_SETTINGS = { volume: 80, showLabel: true, padsPerRow: 4, oneAtATime: false }

// ── synths ────────────────────────────────────────────────────────────────
// Short, distinct, gesture-free cues. Every one is a few oscillator/noise
// nodes with an exponential envelope — no assets, no network, instant.

const SYNTHS = [
  {
    id: 'pop',
    name: 'Pop',
    play(ac, out, gain) {
      const t = ac.currentTime
      const osc = ac.createOscillator()
      const g = ac.createGain()
      osc.type = 'sine'
      osc.frequency.setValueAtTime(560, t)
      osc.frequency.exponentialRampToValueAtTime(180, t + 0.09)
      g.gain.setValueAtTime(0.0001, t)
      g.gain.exponentialRampToValueAtTime(Math.max(0.0001, 0.75 * gain), t + 0.008)
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.13)
      osc.connect(g).connect(out)
      osc.start(t)
      osc.stop(t + 0.16)
    }
  },
  {
    id: 'ding',
    name: 'Ding',
    play(ac, out, gain) {
      const t = ac.currentTime
      for (const [freq, level] of [[1046.5, 0.34], [1568, 0.16]]) {
        const osc = ac.createOscillator()
        const g = ac.createGain()
        osc.type = 'sine'
        osc.frequency.setValueAtTime(freq, t)
        g.gain.setValueAtTime(0.0001, t)
        g.gain.exponentialRampToValueAtTime(Math.max(0.0001, level * gain), t + 0.01)
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.9)
        osc.connect(g).connect(out)
        osc.start(t)
        osc.stop(t + 0.95)
      }
    }
  },
  {
    id: 'beep',
    name: 'Beep',
    play(ac, out, gain) {
      const t = ac.currentTime
      const osc = ac.createOscillator()
      const g = ac.createGain()
      osc.type = 'square'
      osc.frequency.setValueAtTime(880, t)
      g.gain.setValueAtTime(0.0001, t)
      g.gain.exponentialRampToValueAtTime(Math.max(0.0001, 0.22 * gain), t + 0.006)
      g.gain.setValueAtTime(Math.max(0.0001, 0.22 * gain), t + 0.09)
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.13)
      osc.connect(g).connect(out)
      osc.start(t)
      osc.stop(t + 0.15)
    }
  },
  {
    id: 'coin',
    name: 'Coin',
    play(ac, out, gain) {
      const t = ac.currentTime
      const osc = ac.createOscillator()
      const g = ac.createGain()
      osc.type = 'square'
      osc.frequency.setValueAtTime(987.77, t)
      osc.frequency.setValueAtTime(1318.5, t + 0.06)
      g.gain.setValueAtTime(0.0001, t)
      g.gain.exponentialRampToValueAtTime(Math.max(0.0001, 0.2 * gain), t + 0.006)
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.30)
      osc.connect(g).connect(out)
      osc.start(t)
      osc.stop(t + 0.32)
    }
  },
  {
    id: 'laser',
    name: 'Laser',
    play(ac, out, gain) {
      const t = ac.currentTime
      const osc = ac.createOscillator()
      const g = ac.createGain()
      const lp = ac.createBiquadFilter()
      lp.type = 'lowpass'
      lp.frequency.setValueAtTime(2400, t)
      lp.frequency.exponentialRampToValueAtTime(420, t + 0.3)
      osc.type = 'sawtooth'
      osc.frequency.setValueAtTime(1600, t)
      osc.frequency.exponentialRampToValueAtTime(140, t + 0.3)
      g.gain.setValueAtTime(Math.max(0.0001, 0.32 * gain), t)
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.32)
      osc.connect(lp).connect(g).connect(out)
      osc.start(t)
      osc.stop(t + 0.34)
    }
  },
  {
    id: 'whoosh',
    name: 'Whoosh',
    play(ac, out, gain) {
      const t = ac.currentTime
      const frames = Math.max(1, Math.floor(ac.sampleRate * 0.5))
      const buffer = ac.createBuffer(1, frames, ac.sampleRate)
      const data = buffer.getChannelData(0)
      for (let i = 0; i < frames; i += 1) {
        // Decaying white noise: the envelope lives in the buffer so one
        // source node is enough.
        data[i] = (Math.random() * 2 - 1) * (1 - i / frames)
      }
      const src = ac.createBufferSource()
      const bp = ac.createBiquadFilter()
      const g = ac.createGain()
      src.buffer = buffer
      bp.type = 'bandpass'
      bp.Q.value = 1.4
      bp.frequency.setValueAtTime(320, t)
      bp.frequency.exponentialRampToValueAtTime(2600, t + 0.4)
      g.gain.setValueAtTime(Math.max(0.0001, 0.5 * gain), t)
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.5)
      src.connect(bp).connect(g).connect(out)
      src.start(t)
      src.stop(t + 0.5)
    }
  },
  {
    id: 'boing',
    name: 'Boing',
    play(ac, out, gain) {
      const t = ac.currentTime
      const osc = ac.createOscillator()
      const g = ac.createGain()
      const lfo = ac.createOscillator()
      const lfoGain = ac.createGain()
      osc.type = 'triangle'
      osc.frequency.setValueAtTime(340, t)
      osc.frequency.exponentialRampToValueAtTime(190, t + 0.45)
      lfo.type = 'sine'
      lfo.frequency.setValueAtTime(16, t)
      lfo.frequency.linearRampToValueAtTime(7, t + 0.45)
      lfoGain.gain.value = 22
      lfo.connect(lfoGain).connect(osc.frequency)
      g.gain.setValueAtTime(Math.max(0.0001, 0.5 * gain), t)
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.5)
      osc.connect(g).connect(out)
      osc.start(t)
      lfo.start(t)
      osc.stop(t + 0.52)
      lfo.stop(t + 0.52)
    }
  }
]

const SYNTH_BY_ID = new Map(SYNTHS.map(synth => [synth.id, synth]))

const DEFAULT_SOUNDS = SYNTHS.map(synth => ({
  id: `builtin-${synth.id}`,
  name: synth.name,
  kind: 'synth',
  synth: synth.id
}))

// ── triggers ──────────────────────────────────────────────────────────────
// Every entry is a real gateway event from the generated contract in
// apps/shared/src/gateway-contract.generated.ts (or a host-state transition).
// `when(payload, event)` narrows a noisy event to the case worth a sound, so a
// binding means "this event, in this situation" rather than "every frame".
//
// `shows` are the filter chips a pad gets while this trigger is selected:
// each one is a further narrowing, so the dropdown stays short.

const TRIGGERS = [
  {
    id: 'turn.complete',
    event: 'message.complete',
    group: 'Turn',
    label: 'Turn finishes',
    detail: 'any outcome',
    when: payload => payload?.status !== 'error' && payload?.status !== 'interrupted'
  },
  {
    id: 'turn.error',
    event: 'message.complete',
    group: 'Turn',
    label: 'Turn fails',
    detail: 'status = error',
    when: payload => payload?.status === 'error' || Boolean(payload?.error)
  },
  {
    id: 'turn.interrupted',
    event: 'message.complete',
    group: 'Turn',
    label: 'Turn interrupted',
    detail: 'status = interrupted',
    when: payload => payload?.status === 'interrupted'
  },
  {
    id: 'turn.start',
    event: 'message.start',
    group: 'Turn',
    label: 'Turn starts',
    detail: 'you send a message — not the turn after one ends',
    // `display_kind` CANNOT be used here. The gateway's emitters call
    // `_emit("message.start", sid)` with no payload at all, so the field is
    // always undefined and a filter on it is dead code (the same turn echoed
    // straight after `message.complete` looked exactly like a fresh send).
    // Instead the engine tracks whether a turn just ended: a `message.start`
    // within CHAIN_WINDOW_MS of a completion is the chained follow-up, not you.
    when: (payload, event, engine) =>
      payload?.display_kind !== 'auto_continue' && !engine?.isChainedStart?.(event)
  },
  {
    id: 'attention.approval',
    event: 'approval.request',
    group: 'Attention',
    label: 'Approval needed',
    detail: 'agent is blocked',
    when: () => true
  },
  {
    id: 'attention.clarify',
    event: 'clarify.request',
    group: 'Attention',
    label: 'Question asked',
    detail: 'agent is blocked',
    when: () => true
  },
  {
    id: 'attention.warning',
    event: 'notification.show',
    group: 'Attention',
    label: 'Warning notice',
    detail: 'level warn/error',
    when: payload => payload?.level === 'warn' || payload?.level === 'error'
  },
  {
    id: 'attention.risk',
    event: 'tool.output_risk',
    group: 'Attention',
    label: 'Risky tool output',
    detail: 'injection / secrets found',
    when: () => true
  },
  {
    id: 'attention.error',
    event: 'error',
    group: 'Attention',
    label: 'Session error',
    detail: 'outside a turn',
    when: () => true
  },
  {
    id: 'task.subagent',
    event: 'subagent.complete',
    group: 'Work',
    label: 'Subagent finishes',
    detail: 'a delegated child is done',
    when: () => true
  },
  {
    id: 'task.compacted',
    event: 'status.update',
    group: 'Work',
    label: 'Context compacted',
    detail: 'status kind = compacted',
    when: payload => payload?.kind === 'compacted'
  },
  {
    id: 'life.heartbeat',
    event: 'status.update',
    group: 'Ambient',
    label: 'Heartbeat fires',
    detail: 'status kind = heartbeat',
    when: payload => payload?.kind === 'heartbeat'
  },
  {
    id: 'life.wake',
    event: 'wake.detected',
    group: 'Ambient',
    label: 'Wake phrase',
    detail: 'you said the phrase',
    when: () => true
  },
  {
    id: 'life.reaction',
    event: 'reaction',
    group: 'Ambient',
    label: 'Affection detected',
    detail: '"good bot", "ily", a heart',
    when: () => true
  }
]

const TRIGGER_BY_ID = new Map(TRIGGERS.map(trigger => [trigger.id, trigger]))
const TRIGGER_GROUPS = [...new Set(TRIGGERS.map(trigger => trigger.group))]

function cleanTrigger(value) {
  return typeof value === 'string' && TRIGGER_BY_ID.has(value) ? value : null
}

/** A pad's trigger list, normalised.
 *
 * Storage holds an ARRAY, but anything written by an earlier version holds a
 * single string — so both are accepted here and a bare string becomes a
 * one-entry list. Unknown ids are dropped, duplicates collapse, and order
 * follows TRIGGERS rather than insertion so the row's chips read the same way
 * every time.
 */
function cleanTriggers(value) {
  const list = Array.isArray(value) ? value : typeof value === 'string' ? [value] : []
  const wanted = new Set(list.map(cleanTrigger).filter(Boolean))

  return TRIGGERS.filter(trigger => wanted.has(trigger.id)).map(trigger => trigger.id)
}


// ── youtube helpers ───────────────────────────────────────────────────────
// Everything here is deliberately Windows-first but degrades to a clear error
// rather than a silent no-op: the process door, the path separator, and the
// detach syntax are all platform-specific, so each is chosen explicitly.

/** The 11-character id out of any of YouTube's URL shapes, or null. */
function parseYoutube(value) {
  const text = String(value ?? '').trim()
  if (!text) return null
  // A bare id is accepted, so pasting just the code works.
  if (/^[A-Za-z0-9_-]{11}$/.test(text)) return text
  let url
  try {
    url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`)
  } catch {
    return null
  }
  const host = url.hostname.replace(/^www\./, '').toLowerCase()
  if (host === 'youtu.be') {
    return /^[A-Za-z0-9_-]{11}$/.test(url.pathname.slice(1)) ? url.pathname.slice(1) : null
  }
  if (host !== 'youtube.com' && host !== 'm.youtube.com' && host !== 'music.youtube.com') return null
  const v = url.searchParams.get('v')
  if (v && /^[A-Za-z0-9_-]{11}$/.test(v)) return v
  // /shorts/<id>, /embed/<id>, /live/<id>
  const m = url.pathname.match(/^\/(?:shorts|embed|live|v)\/([A-Za-z0-9_-]{11})/)
  return m ? m[1] : null
}

/** Cached tool probe. Reset by the test harness through `__hermesResetTools`. */
let toolsProbe = null

class ImportError extends Error {
  /** `code` is a stable machine token; `message`, when given, is already the
   *  sentence a person should read. `details` carries the numbers a caller
   *  needs to build that sentence itself (a version, a count). */
  constructor(code, message = '', details = null) {
    super(message || code)
    this.code = code
    this.details = details
  }
}

// navigator.platform is deprecated and EMPTY in jsdom, and Electron does not
// guarantee it either — so fall back to the UA, which both set. A plain
// `navigator.platform` check silently reported "not Windows" under test and
// every import failed with "no plugin folder", which reads like a permissions
// problem rather than a platform probe that never matched.
const IS_WINDOWS =
  typeof navigator !== 'undefined' &&
  /win/i.test(navigator.userAgentData?.platform || navigator.platform || navigator.userAgent || '')

/** jsdom reports "linux" and has no plugin-files bridge, so the harness sets
 *  this to exercise the Windows path it was written for. Production code never
 *  touches it. */
function windowsHost() {
  return IS_WINDOWS || globalThis.__hermesForceWindows === true
}

function joinNative(dir, name) {
  return `${dir}${IS_WINDOWS ? '\\' : '/'}${name}`
}

/** `%APPDATA%\<ProductName>\plugin-files\data\<id>` — Electron's userData is
 *  the app-name folder under Roaming on Windows, and `main` names it the
 *  plugin id verbatim when the id is already lowercase (which it is).
 *
 *  Nothing exposes this path to a plugin: `ctx.files` speaks in relative
 *  paths by design. We do not need the plugin's own path — we need the
 *  POSITION of that folder, which is derivable, and the job writes only
 *  inside the folder the plugin already has access to. */
function dataDir() {
  if (!windowsHost()) return null
  // `%APPDATA%` is expanded by cmd inside the detached command, so the plugin
  // never needs to know a real absolute path — and never gets one, since
  // ctx.files speaks relative paths by design.
  return `%APPDATA%\\Hermes\\plugin-files\\data\\${ID}`
}

/** Forget the cached probe. Only the test harness calls this, so a suite can
 *  exercise "tools missing" and "tools present" in one process. */
globalThis.__hermesResetTools = () => {
  toolsProbe = null
}

/** Are the two tools this needs actually available? Probed once per session.
 *
 *  yt-dlp is not checked directly: `uvx yt-dlp` resolves and caches the
 *  package on demand, so `uvx` being present IS yt-dlp being available — and
 *  probing it by running it would cost a download inside a 30s shell door.
 *  ffmpeg is checked because yt-dlp shells out to it for the mp3 transcode and
 *  there is no equivalent on-demand story. */
async function probeTools() {
  if (toolsProbe) return toolsProbe
  const script = windowsHost()
    ? 'where ffmpeg>nul 2>&1 && echo ffmpeg=1 || echo ffmpeg=0 & where uvx>nul 2>&1 && echo uvx=1 || echo uvx=0'
    : 'command -v ffmpeg >/dev/null 2>&1 && echo ffmpeg=1 || echo ffmpeg=0; command -v uvx >/dev/null 2>&1 && echo uvx=1 || echo uvx=0'
  toolsProbe = (async () => {
    const text = await runShell(script, { capture: true })
    const found = String(text || '')
    return { ytdlp: /uvx=1/.test(found), ffmpeg: /ffmpeg=1/.test(found) }
  })()
  return toolsProbe
}

/** Run one command through the gateway's shell door. Returns captured stdout
 *  when `capture` is set, else a boolean "it launched".
 *
 *  `shell.exec` is SESSION-BOUND: the gateway's handler refuses with
 *  `invalid_params` unless the call carries a `session_id` naming a live local
 *  chat, because it runs the command in that session's frozen cwd behind the
 *  same policy as a user's `!cmd`. Omitting it was the whole bug — the RPC layer
 *  rejected the call before any command ran, and the raw code surfaced in the
 *  panel. There is no session-less variant to fall back to, so the focused
 *  chat's runtime id is the door, and "no chat open" is reported as such
 *  instead of as a converter failure. */
function activeSessionId() {
  try {
    return host.state?.activeSessionId?.get?.() ?? null
  } catch {
    return null
  }
}

async function runShell(command, { capture = false } = {}) {
  const sessionId = activeSessionId()
  // Defensive only: importYoutube checks this first so the user gets a
  // localised message. Reaching here without a session means it appeared to
  // have one and then lost it.
  if (!sessionId) throw new ImportError('noSession', 'Open a chat first — the converter runs inside a session.')

  const result = await host.request('shell.exec', { command, session_id: sessionId })
  const stdout = result?.stdout ?? ''
  const code = result?.code ?? 0
  return capture ? stdout : code === 0 || Boolean(stdout)
}

/** Quote a VALUE for a batch command line (no percent escaping — the post step
 *  uses fixed names, and jobScript does its own escaping for its arguments). */
function q0(value) {
  return `"${String(value).replace(/"/g, '')}"`
}

/** The job is a SCRIPT FILE, not a command line.
 *
 * `shell.exec` takes one string with `shell=True`, so an argument list has to
 * survive two levels of quoting (the shell, then cmd's own `start`), and the
 * first attempt at that produced `cmd /c "uvx yt-dlp "-x" …` where the inner
 * quotes closed the outer — the job never started.
 *
 * Every path inside the script is RELATIVE, anchored by `%~dp0` (the script's
 * own folder, which is the plugin's data folder). That is not tidiness: batch
 * needs `%%` for a literal `%`, so any env-var path like `%APPDATA%` written
 * through the same escaper became the literal text `%%APPDATA%%` — the script
 * then could not `cd` anywhere, exited 0, wrote no status file, and the poll
 * loop waited FOREVER on a job that had already died. Keeping the argument list
 * relative leaves `%` doubling needed only for yt-dlp's own `%(ext)s` template.
 */
function jobScript({ exe, args, out, log, status, mp3, post }) {
  // Double the percent for batch — yt-dlp's template is `%(ext)s`, and cmd
  // refuses to parse the WHOLE file on a lone one ("File Not Found", zero lines
  // run). Quotes are stripped, never escaped: a path never legitimately holds
  // one, and escaping invites breakout.
  const q = value =>
    `"${String(value).replace(/"/g, '').replace(/%(?![%~])/g, '%%')}"`
  const run = [exe, ...args.map(q)].join(' ')
  const lines = [
    '@echo off',
    'setlocal',
    // %~dp0 is this script's own folder, with a trailing backslash.
    `cd /d ${q(out ?? '%~dp0')}`,
    `rem ${run}`,
    `${run} > ${q(log)} 2>&1`,
    'set "RC=%ERRORLEVEL%"'
  ]

  // POST-PROCESS: trim to the chosen window and normalise loudness. Runs as a
  // separate step so the download's own exit code stays meaningful, and appends
  // to the same log. The result replaces the original, and `mp3` names the file
  // the status check looks for — so a failed post-process leaves the raw file
  // (still playable) and reports ok, rather than losing the download.
  if (post) {
    // Parenthesised: `a && b >> log` applies the redirect to `b` only, and a
    // trailing `>nul` in the chain collides with it. Grouping makes the whole
    // step write to the same log.
    lines.push(`rem post: ${post}`)
    lines.push(`( ${post} ) >> ${q(log)} 2>&1`)
  }

  lines.push(
    // Written in EVERY case, including a failed cd: a status file is the only
    // way the plugin learns the job ended at all.
    `if exist ${q(mp3)} (echo ok> ${q(status)}) else (echo fail> ${q(status)})`,
    'endlocal',
    'exit /b %RC%'
  )
  return lines.join('\r\n') + '\r\n'
}

/** Script that re-cuts an ALREADY STORED clip.
 *
 * The stored form is base64 text (`<id>.b64`), so the round trip is:
 * PowerShell decodes it to a temp mp3, ffmpeg cuts the window, PowerShell
 * re-encodes the result, and the new text replaces the old file. PowerShell is
 * used rather than a Node helper because the plugin has no Node runtime and its
 * only file door is text-oriented.
 *
 * Every path is relative to `%~dp0` for the same reason as the download script:
 * a batch `%` escape would otherwise mangle any env-var path into literal text.
 */
function trimScript({ id, start, length, tmp, out }) {
  const lines = [
    '@echo off',
    'setlocal',
    'cd /d "%~dp0"',
    `rem decode ${id}.b64`,
    `powershell -NoProfile -Command "$b=[IO.File]::ReadAllText('%~dp0${id}.b64').Trim(); [IO.File]::WriteAllBytes('%~dp0${tmp}',[Convert]::FromBase64String($b))"`,
    `rem trim`,
    `ffmpeg -hide_banner -loglevel error -y ${start > 0 ? `-ss ${start} ` : ''}${length ? `-t ${length} ` : ''}-i "${tmp}" -b:a 128k "${out}"`,
    `if not exist "${out}" (echo fail> ".${id}.trimstatus" & endlocal & exit /b 1)`,
    `rem re-encode`,
    `powershell -NoProfile -Command "$b=[Convert]::ToBase64String([IO.File]::ReadAllBytes('%~dp0${out}')); [IO.File]::WriteAllText('%~dp0${id}.b64',$b)"`,
    `echo ok> ".${id}.trimstatus"`,
    'endlocal',
    'exit /b 0'
  ]

  return lines.join('\r\n') + '\r\n'
}

/** The one-line command that launches the job script and returns at once.
 *
 * The script takes NO arguments — every path is baked into it — which matters:
 * `start /b cmd /c "script.cmd" "arg"` silently DROPS the arguments (probed
 * here: four start-based forms all arrived with none, while a plain call
 * received both), and a job that never starts looks exactly like a bad URL.
 * `start /b` is kept only as the detach mechanism: the script itself exits
 * immediately after spawning, so the shell door returns in well under 30s.
 */
function detachedCommand(scriptPath) {
  if (windowsHost()) return `start "" /b ${`"${scriptPath}"`}`
  return `nohup sh "${scriptPath}" >/dev/null 2>&1 &`
}

/** Length of the video in seconds, or null when YouTube will not say.
 *  Runs in the foreground because it is fast (~2s) and because the answer
 *  decides whether the job runs at all. */
async function probeDuration(videoId) {
  const out = await runShell(
    `uvx yt-dlp --print duration --skip-download https://www.youtube.com/watch?v=${videoId}`,
    { capture: true }
  )
  const match = String(out || '').match(/(\d+(?:\.\d+)?)\s*$/m)
  const seconds = match ? Number(match[1]) : NaN
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null
}

/** Watch for the job's status file: 'ok' | 'fail' | 'timeout'.
 *
 * The status file is written once, at the END, so a job that never starts and a
 * job that is merely slow look identical from here — which is exactly how a
 * broken script became "waited a few minutes, nothing happened". So the log is
 * read as the job runs: yt-dlp prints `[download]  42.3% of …`, and that is
 * surfaced as real progress. A job that dies before writing anything still ends
 * quietly, so the caller's budget is what turns that into a visible failure. */
async function waitForStatus(files, statusPath, budgetMs, { logPath, onProgress } = {}) {
  const until = Date.now() + budgetMs
  while (Date.now() < until) {
    await sleep(YT_POLL_MS)
    const read = await files.readText(files.dataFolder, statusPath)
    if (read.ok) {
      const text = (read.text || '').trim()
      if (text) return text === 'ok' ? 'ok' : 'fail'
    }
    if (logPath && onProgress) {
      const log = await files.readText(files.dataFolder, logPath)
      if (log.ok) {
        // Take the LAST percentage, not the first: the log grows.
        const matches = String(log.text || '').match(/(\d{1,3}(?:\.\d+)?)%/g)
        if (matches?.length) {
          const percent = Number(matches[matches.length - 1].replace('%', ''))
          if (Number.isFinite(percent)) onProgress(Math.max(0, Math.min(100, Math.round(percent))))
        }
      }
    }
  }
  return 'timeout'
}

/** The tail of the job's log, so a failure explains itself. */
async function readLogTail(files, logPath) {
  const read = await files.readText(files.dataFolder, logPath)
  if (!read.ok) return ''
  const lines = String(read.text || '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .filter(line => !/^\[download\]\s+\d/.test(line))
  return lines.slice(-2).join(' ').slice(0, 240)
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// ── data hygiene ──────────────────────────────────────────────────────────
// Everything read back from storage is user-editable JSON, so each entry is
// rebuilt from scratch; anything unrecognised is dropped rather than trusted.

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/
const MIME_RE = /^audio\/[a-z0-9.+-]{1,40}$/i

function cleanName(value, fallback) {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''

  return (text || fallback).slice(0, MAX_NAME_LEN)
}

function cleanSound(raw) {
  if (!raw || typeof raw !== 'object') return null
  if (typeof raw.id !== 'string' || !ID_RE.test(raw.id)) return null
  const name = cleanName(raw.name, '')
  if (!name) return null
  // A binding rides on the sound, so any sound can be a trigger — a synthesized
  // cue or the user's own clip alike. Stored as a list since a pad may answer
  // to several events at once.
  const triggers = cleanTriggers(raw.triggers ?? raw.trigger)
  const bound = triggers.length ? { triggers } : {}
  // Per-pad trim, 0-200%. 100 (or absent) is the neutral default, so the field
  // is dropped rather than stored as noise.
  const gainValue = Number(raw.gain)
  const gain = Number.isFinite(gainValue) && gainValue >= 0 && gainValue <= 200 && Math.round(gainValue) !== 100
    ? Math.round(gainValue)
    : null
  const trimmed = gain === null ? bound : { ...bound, gain }
  if (raw.kind === 'synth') {
    return SYNTH_BY_ID.has(raw.synth) ? { id: raw.id, name, kind: 'synth', synth: raw.synth, ...trimmed } : null
  }
  if (raw.kind === 'file' && typeof raw.mime === 'string' && MIME_RE.test(raw.mime)) {
    return {
      id: raw.id,
      name,
      kind: 'file',
      mime: raw.mime,
      bytes: Number.isFinite(raw.bytes) && raw.bytes > 0 ? Math.round(raw.bytes) : 0,
      ...trimmed
    }
  }

  return null
}

function cleanSounds(raw) {
  if (!Array.isArray(raw)) return DEFAULT_SOUNDS.map(sound => ({ ...sound }))
  const seen = new Set()
  const out = []

  for (const entry of raw.slice(0, MAX_SOUNDS)) {
    const sound = cleanSound(entry)
    if (sound && !seen.has(sound.id)) {
      seen.add(sound.id)
      out.push(sound)
    }
  }

  return out
}

function cleanSettings(raw) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const volume = Number(source.volume)

  return {
    volume: Number.isFinite(volume) ? Math.max(0, Math.min(100, Math.round(volume))) : DEFAULT_SETTINGS.volume,
    showLabel: typeof source.showLabel === 'boolean' ? source.showLabel : DEFAULT_SETTINGS.showLabel,
    padsPerRow: [3, 4, 5].includes(source.padsPerRow) ? source.padsPerRow : DEFAULT_SETTINGS.padsPerRow,
    oneAtATime: typeof source.oneAtATime === 'boolean' ? source.oneAtATime : DEFAULT_SETTINGS.oneAtATime
  }
}

/** A profile is a frozen snapshot of the working set: the pads plus the global
 *  settings. Clips are NOT copied — they stay in the data folder under their
 *  sound id, so two profiles can share one file. That is why deleting a pad has
 *  to check whether any other profile still references its blob. */
function cleanProfiles(raw) {
  if (!Array.isArray(raw)) return []
  const seen = new Set()
  const out = []

  for (const entry of raw.slice(0, MAX_PROFILES)) {
    if (!entry || typeof entry !== 'object') continue
    const id = typeof entry.id === 'string' && entry.id.trim() ? entry.id.trim() : null
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push({
      id,
      name: cleanName(entry.name, 'Profile'),
      sounds: cleanSounds(entry.sounds),
      settings: cleanSettings(entry.settings),
      createdAt: Number.isFinite(entry.createdAt) ? entry.createdAt : Date.now()
    })
  }

  return out
}

/** An active-profile id is only meaningful if that profile still exists. */
function cleanActiveId(raw, list) {
  const id = typeof raw === 'string' ? raw.trim() : ''

  return id && list.some(profile => profile.id === id) ? id : null
}

/** Rebuild a data URL with a MIME we know, keeping the bytes.
 *
 * `ctx.files.readDataUrl` stamps the URL with a MIME it derives from the file
 * extension — but the desktop host's table only covers IMAGE types
 * (`mimeFor()` in plugin-files-ops.ts falls through to
 * `application/octet-stream`). So an .mp3 comes back as
 * `data:application/octet-stream;base64,...`, and Chromium refuses to decode it.
 * The result is a pad that is silently dead until the plugin is reloaded, at
 * which point the cache is empty and playFile re-reads the blob as text and
 * builds the URL with `sound.mime` — which is why reloading "fixed" it.
 */
function withMime(url, mime) {
  const comma = String(url).indexOf(',')

  return comma < 0 ? url : `data:${mime};base64,${String(url).slice(comma + 1)}`
}

function newId() {
  const uuid = typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2)

  return `snd-${uuid.replace(/[^A-Za-z0-9]/g, '').slice(0, 20)}`
}

function uniqueName(desired, taken) {
  const base = cleanName(desired, 'Sound')
  const names = new Set(taken.map(name => name.toLowerCase()))

  if (!names.has(base.toLowerCase())) return base

  for (let n = 2; n < 100; n += 1) {
    const candidate = `${base.slice(0, MAX_NAME_LEN - 4)} ${n}`
    if (!names.has(candidate.toLowerCase())) return candidate
  }

  return base
}

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error('Could not read that file.'))
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '')
    reader.readAsDataURL(file)
  })
}

const EXT_MIME = {
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  flac: 'audio/flac',
  webm: 'audio/webm'
}

function mimeOf(file, header) {
  const declared = String(header || '').split(';')[0].trim().toLowerCase()

  if (MIME_RE.test(declared)) return declared
  const ext = String(file.name || '').split('.').pop()?.toLowerCase() ?? ''

  return EXT_MIME[ext] ?? ''
}

function baseName(fileName) {
  return String(fileName || 'Sound').replace(/\.[^.]+$/, '')
}

// ── setup files: export / import a whole board ────────────────────────────
// One JSON file holds the pads — names, gains, trigger bindings, order — plus
// the settings that shape the panel. Audio rides along as base64, which is what
// the plugin already stores, so a shared setup is a single mail-able file with
// no second folder to keep beside it.
//
// Nothing is trusted coming back in: an imported record goes through the SAME
// `cleanSound`/`cleanSettings` sanitisers storage does, ids are minted fresh on
// this machine (a file never dictates one), and every clip is size- and
// alphabet-checked before it is written. A bundle therefore cannot carry a pad
// whose clip would not decode, or a trigger id this build does not know.
const BUNDLE_FORMAT = 'hermes-soundboard-setup'
const BUNDLE_VERSION = 1
/** Parsed whole in the renderer, so it is capped: a corrupt or hostile file
 *  must not lock the window up. The cap is derived from what this app can
 *  itself produce — 40 pads × the 3 MiB clip limit, base64-inflated by 4/3 —
 *  so a board can never export a file its own importer would refuse. */
const MAX_IMPORT_BYTES = Math.ceil(MAX_SOUNDS * MAX_FILE_BYTES * (4 / 3)) + 2 * 1024 * 1024
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/

/** Decoded byte count of a base64 string, or -1 when it is not base64. */
function b64Bytes(text) {
  if (typeof text !== 'string' || !text || text.length % 4 !== 0 || !B64_RE.test(text)) return -1
  const padding = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0

  return (text.length * 3) / 4 - padding
}

function dayStamp(date = new Date()) {
  const pad = value => String(value).padStart(2, '0')

  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** The setup file's shape. Deliberately NO ids: an id is a local address, not
 *  part of a setup, and carrying one across machines only invites a collision
 *  with a pad that already lives there. */
function buildBundle({ sounds, settings, audio }) {
  return {
    format: BUNDLE_FORMAT,
    version: BUNDLE_VERSION,
    app: 'Soundboard',
    exportedAt: new Date().toISOString(),
    settings: cleanSettings(settings),
    sounds: sounds.map(sound => {
      const entry = { name: sound.name, kind: sound.kind }
      if (sound.kind === 'synth') entry.synth = sound.synth
      else {
        entry.mime = sound.mime
        entry.audio = audio.get(sound.id) ?? null
      }
      // 100% is the neutral default and is stored as an ABSENT field, exactly
      // as it is in storage, so an exported board matches the board it came
      // from field for field.
      if (Number.isFinite(sound.gain) && sound.gain !== 100) entry.gain = sound.gain
      if (sound.triggers?.length) entry.triggers = [...sound.triggers]
      return entry
    })
  }
}

function hasSettings(raw) {
  if (!raw || typeof raw !== 'object') return false

  return ['volume', 'showLabel', 'padsPerRow', 'oneAtATime'].some(key => key in raw)
}

/** Validate a setup file. Every sound comes back sanitised with its clip's
 *  byte count measured; anything unplayable is counted, never stored mute.
 *  Throws an ImportError carrying a code (never a code shown to a person). */
function parseBundle(text) {
  let data
  try {
    data = JSON.parse(String(text ?? ''))
  } catch {
    throw new ImportError('notJson')
  }
  if (!data || typeof data !== 'object' || data.format !== BUNDLE_FORMAT) throw new ImportError('notBundle')
  const version = Number(data.version)
  if (!Number.isFinite(version) || version < 1) throw new ImportError('notBundle')
  if (version > BUNDLE_VERSION) throw new ImportError('newer', '', { version })

  const list = Array.isArray(data.sounds) ? data.sounds : []
  const sounds = []
  let skippedNoAudio = 0

  for (const raw of list.slice(0, MAX_SOUNDS * 2)) {
    if (!raw || typeof raw !== 'object') continue
    // Same sanitiser storage uses, so a hand-edited file cannot smuggle in a
    // field this build does not understand.
    const clean = cleanSound({
      id: 'imported',
      name: raw.name,
      kind: raw.kind,
      synth: raw.synth,
      mime: raw.mime,
      gain: raw.gain,
      triggers: raw.triggers
    })
    if (!clean) continue
    if (clean.kind === 'synth') {
      sounds.push({ ...clean, id: null })
      continue
    }
    const audio = String(raw.audio ?? '').replace(/\s+/g, '')
    const bytes = b64Bytes(audio)
    // Empty, not base64, or over the per-pad cap: the pad could never make a
    // sound here, so it is reported as skipped rather than added silent.
    if (bytes <= 0 || bytes > MAX_FILE_BYTES) {
      skippedNoAudio += 1
      continue
    }
    sounds.push({ ...clean, id: null, bytes, audio })
  }

  if (!sounds.length) throw new ImportError('empty', '', { skippedNoAudio })

  return {
    exportedAt: typeof data.exportedAt === 'string' ? data.exportedAt : null,
    settings: hasSettings(data.settings) ? cleanSettings(data.settings) : null,
    sounds,
    skippedNoAudio
  }
}

/** What an import WOULD do, so the user confirms a plan rather than a guess.
 *  `total` counts every playable pad in the file (including ones a full board
 *  could not take), and `taken` is this board's pad count at parse time — the
 *  caller compares the two, so an overflow is visible instead of arriving as a
 *  quietly shorter board. */
function planImport(text, taken) {
  const bundle = parseBundle(text)
  const entries = bundle.sounds.slice(0, MAX_SOUNDS)

  return {
    exportedAt: bundle.exportedAt,
    settings: bundle.settings,
    entries,
    taken: Math.max(0, Math.round(Number(taken) || 0)),
    total: bundle.sounds.length,
    tooManyForBoard: bundle.sounds.length - entries.length,
    skippedNoAudio: bundle.skippedNoAudio,
    fileName: ''
  }
}

/** Hand a file to the browser's own download path. Electron's main process
 *  answers with the app's save dialog (defaulting to Downloads), which is the
 *  only export door that lands somewhere the user can find and mail. Returns
 *  false rather than throwing when the door is unavailable, so the caller can
 *  fall back to the folder it definitely can write. */
function downloadFile(fileName, text) {
  try {
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }))
    const link = document.createElement('a')
    link.href = url
    link.download = fileName
    link.rel = 'noopener'
    link.style.display = 'none'
    document.body.append(link)
    link.click()
    link.remove()
    // Revoking in the same tick cancels the transfer in some Chromium builds.
    setTimeout(() => URL.revokeObjectURL(url), 60000)

    return true
  } catch {
    return false
  }
}

function readAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error('Could not read that file.'))
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '')
    reader.readAsText(file)
  })
}

// ── engine ────────────────────────────────────────────────────────────────
// All playback, persistence and file I/O lives here; components only read
// atoms and call verbs. Handlers read atoms imperatively (`.get()`), never
// through a render closure.

function createEngine(ctx) {
  const t = ctx.i18n.t
  const sounds = atom(cleanSounds(ctx.storage.get('sounds', null)))
  const settings = atom(cleanSettings(ctx.storage.get('settings', {})))
  /** Saved snapshots of the pads + settings. The live set is what you edit;
   *  a profile is what you restore. */
  const profiles = atom(cleanProfiles(ctx.storage.get('profiles', null)))
  /** Which profile the live set came from, or null for an unsaved set. Cleared
   *  as soon as anything is edited, so the chip never claims you are on a
   *  profile whose contents have since changed. */
  const activeProfile = atom(cleanActiveId(ctx.storage.get('activeProfile', null), profiles.get()))
  const open = atom(false)
  const active = atom({})
  const saving = atom(false)
  /** The most recent trigger that actually fired, for the panel's readout. */
  const lastTrigger = atom(null)
  /** Live YouTube job state: null or {stage, id, percent, at}. */
  const ytJob = atom(null)

  // pad id -> its one pending flash timer.
  const timers = new Map()
  const urls = new Map()
  const playing = new Set()
  let audioContext = null
  let disposed = false

  /** True while a profile is being applied: the writes in applyProfile are not
   *  user edits, so they must not clear the active profile that is being set. */
  let applyingProfile = false

  const persistSounds = next => {
    sounds.set(next)
    ctx.storage.set('sounds', next)
    if (!applyingProfile) leaveProfile()
  }

  const persistSettings = patch => {
    const next = cleanSettings({ ...settings.get(), ...patch })
    settings.set(next)
    ctx.storage.set('settings', next)
    if (!applyingProfile) leaveProfile()
  }

  // One pending flash timer per pad, not per flash. Two triggers bound to the
  // same pad (or a pad played twice quickly) otherwise leave two timers running,
  // and whichever expires first clears the flag the second one just set — so the
  // pad goes dark early, or an assertion right after the second fire sees
  // nothing at all.
  /** When the last turn COMPLETED — used to tell a chained follow-up turn apart
   *  from the user pressing send. `message.start` carries no payload, so the
   *  gateway gives no other signal: a start arriving within this window of a
   *  completion is the automatic continuation, not a user action. */
  let lastCompleteAt = 0
  const CHAIN_WINDOW_MS = 1500

  function isChainedStart() {
    return Date.now() - lastCompleteAt < CHAIN_WINDOW_MS
  }

  /** Most recent pick per trigger, so a random choice does not immediately
   *  repeat itself. With only two candidates, plain uniform random plays the
   *  same sound twice in a row half the time, which does not read as random to
   *  the person listening. Skipping the previous pick keeps every remaining
   *  sound equally likely, so it is still uniform — just without the echo. */
  const lastPick = new Map()

  function pickOne(candidates, triggerId) {
    if (candidates.length === 1) return candidates[0]
    const previous = lastPick.get(triggerId)
    const pool = candidates.length > 2 && previous
      ? candidates.filter(sound => sound.id !== previous)
      : candidates
    const chosen = pool[Math.floor(Math.random() * pool.length)]
    lastPick.set(triggerId, chosen.id)

    return chosen
  }

  /** Master volume × this pad's own trim, clamped to something playable. */
  function gainFor(sound) {
    const master = settings.get().volume / 100
    const trim = Number.isFinite(sound?.gain) ? sound.gain / 100 : 1

    return Math.max(0, Math.min(1, master * trim))
  }

  function flash(id) {
    const previous = timers.get(id)
    if (previous) clearTimeout(previous)
    active.set({ ...active.get(), [id]: true })
    const timer = setTimeout(() => {
      timers.delete(id)
      if (disposed) return
      const next = { ...active.get() }
      delete next[id]
      active.set(next)
    }, FLASH_MS)
    timers.set(id, timer)
  }

  function context() {
    if (!audioContext) {
      const Ctor = typeof AudioContext !== 'undefined' ? AudioContext : typeof webkitAudioContext !== 'undefined' ? webkitAudioContext : null
      if (!Ctor) return null
      audioContext = new Ctor()
    }
    if (audioContext.state === 'suspended') void audioContext.resume().catch(() => {})

    return audioContext
  }

  function playSynth(synthId, gain) {
    const synth = SYNTH_BY_ID.get(synthId)
    const ac = context()
    if (!synth || !ac || gain <= 0) return
    const master = ac.createGain()
    master.gain.value = 1
    master.connect(ac.destination)
    try {
      synth.play(ac, master, gain)
    } catch {
      // A closed or suspended context must never surface as a broken pad.
    }
  }

  async function playFile(sound, gain) {
    let url = urls.get(sound.id)
    if (!url) {
      const files = ctx.files
      if (!files) throw new Error(t('noFileAccess'))
      const read = await files.readText(files.dataFolder, `${sound.id}.b64`)
      if (!read.ok) throw new Error(read.message || t('missingAudio'))
      url = `data:${sound.mime};base64,${String(read.text).replace(/\s+/g, '')}`
      urls.set(sound.id, url)
    }
    const audio = new Audio(url)
    audio.volume = Math.max(0, Math.min(1, gain))
    playing.add(audio)

    // Every failure below used to be swallowed: the pad flashed (so it looked
    // like it played), nothing was audible, and nothing was reported. A clip
    // that fails to decode must say so — that is the only way the difference
    // between "broken file", "blocked autoplay" and "volume at zero" is even
    // visible to the person clicking.
    const failed = new Promise(resolve => {
      audio.addEventListener('error', () => {
        const err = audio.error
        resolve(
          new Error(
            err ? t('playError').replace('{code}', String(err.code)) : t('playError').replace('{code}', '?')
          )
        )
      }, { once: true })
      audio.addEventListener('ended', () => resolve(null), { once: true })
      // A clip that never even reaches canplay is its own failure, and silence
      // would otherwise last forever.
      setTimeout(() => resolve(audio.readyState === 0 ? new Error(t('decodeFailed')) : null), 4000)
    })

    const release = () => {
      playing.delete(audio)
      audio.src = ''
    }
    audio.addEventListener('ended', release, { once: true })
    audio.addEventListener('error', release, { once: true })

    if (gain <= 0) throw new Error(t('volumeZero'))

    try {
      await audio.play()
    } catch (error) {
      release()
      throw new Error(
        error?.name === 'NotAllowedError'
          ? t('blockedAutoplay')
          : `${t('decodeFailed')} (${error?.name || 'error'})`
      )
    }

    const problem = await failed
    if (problem) throw problem
  }

  function play(sound) {
    if (disposed || !sound) return
    // Monophonic mode: a new pad cuts whatever is still sounding, so two clips
    // never overlap. `stopAll` also suspends the context, which would mute the
    // sound we are about to start — so only the players are stopped here.
    if (settings.get().oneAtATime) stopVoices()
    flash(sound.id)
    const gain = gainFor(sound)
    if (sound.kind === 'synth') playSynth(sound.synth, gain)
    else {
      void playFile(sound, gain).catch(error =>
        ctx.notify?.({ kind: 'error', message: String(error?.message || error) })
      )
    }
  }

  // Triggered playback is different from a click: the window is usually NOT
  // focused, so the AudioContext may be suspended by the browser's autoplay
  // policy and a resumed context is not guaranteed. Every trigger attempts a
  // resume; if the context refuses, the pad still flashes so the cue is not
  // silently lost, and the panel shows the last trigger.
  const bound = () => sounds.get().filter(sound => sound.triggers?.length)

  function fire(triggerId, event) {
    if (disposed) return
    const trigger = TRIGGER_BY_ID.get(triggerId)
    if (!trigger) return
    let payload = null
    try {
      payload = event?.payload ?? null
      if (!trigger.when(payload, event, { isChainedStart })) return
    } catch {
      // A malformed payload must never take the event stream down.
      return
    }
    // A completion opens the chained-follow-up window; the start that follows it
    // is the automatic continuation rather than a send.
    if (trigger.event === 'message.complete') lastCompleteAt = Date.now()
    lastTrigger.set({ id: triggerId, at: Date.now() })
    // A triggered cue is monophonic under the same setting: whatever else is
    // still sounding stops before this one starts.
    if (settings.get().oneAtATime) stopVoices()
    const candidates = bound().filter(sound => sound.triggers.includes(triggerId))
    if (!candidates.length) {
      // A trigger with no pad bound to it is not "the last trigger" — the
      // readout should name something that actually made a sound.
      lastTrigger.set(null)
      return
    }

    // ONE pad per trigger, chosen at random. Several pads can answer to the
    // same event, and playing them all at once turned those into a chord —
    // which is rarely what a soundboard is for. The pick also decides which pad
    // flashes, so the lit pad is always the one you heard.
    const sound = pickOne(candidates, triggerId)
    flash(sound.id)
    const gain = gainFor(sound)
    if (gain > 0) {
      if (sound.kind === 'synth') playSynth(sound.synth, gain)
      else void playFile(sound, gain).catch(() => {})
    }
  }

  // One subscription per distinct event, not per binding: several pads can hang
  // off `message.complete` and the stream only needs to be read once.
  for (const eventName of new Set(TRIGGERS.map(trigger => trigger.event))) {
    ctx.onEvent?.(eventName, event => {
      for (const trigger of TRIGGERS) {
        if (trigger.event === eventName) fire(trigger.id, event)
      }
    })
  }

  /** Add or remove ONE trigger on a pad, leaving its other bindings alone. */
  function toggleTrigger(soundId, triggerId) {
    const next = cleanTrigger(triggerId)
    if (!next) return
    persistSounds(
      sounds.get().map(sound => {
        if (sound.id !== soundId) return sound
        const current = sound.triggers ?? []
        const list = current.includes(next) ? current.filter(id => id !== next) : [...current, next]
        const { triggers: _drop, ...rest } = sound
        const ordered = cleanTriggers(list)

        return ordered.length ? { ...rest, triggers: ordered } : rest
      })
    )
  }

  /** Clear every binding on a pad. */
  function clearTriggers(soundId) {
    persistSounds(
      sounds.get().map(sound => {
        if (sound.id !== soundId) return sound
        const { triggers: _drop, ...rest } = sound

        return rest
      })
    )
  }

  /** Import one YouTube URL as an mp3 pad.
   *
   * Returns a promise that settles when the detached job writes its status
   * file, so the caller can await it from a click handler. Everything the job
   * writes lives in the plugin's OWN data folder, so `ctx.files` can read the
   * result back without needing an absolute path anywhere else.
   */
  async function importYoutube(input, { onStage, start = 0, length = null } = {}) {
    const files = ctx.files
    if (!files) throw new ImportError('noFileAccess', t('noFileAccess'))
    const videoId = parseYoutube(input)
    if (!videoId) throw new ImportError('badUrl', t('ytBadUrl'))
    // `shell.exec` runs inside a live local chat (its cwd and policy come from
    // that session), so there is nothing to run in without one. Say so plainly
    // rather than surfacing the gateway's `invalid_params`.
    if (!activeSessionId()) throw new ImportError('noSession', t('ytNoSession'))
    if (sounds.get().length >= MAX_SOUNDS) throw new ImportError('tooMany', t('tooMany'))

    const dir = await dataDir()
    if (!dir) throw new ImportError('noPath', t('ytNoPath'))

    const tools = await probeTools(dir)
    if (!tools.ytdlp) throw new ImportError('noYtdlp', t('ytNoYtdlp'))
    if (!tools.ffmpeg) throw new ImportError('noFfmpeg', t('ytNoFfmpeg'))

    const id = newId()
    const stem = `yt-${id}`
    const statusPath = `.${stem}.status`
    const logPath = `.${stem}.log`
    const mp3Path = `${stem}.mp3`

    // Clean any stale files from a previous attempt with the same id.
    await files.trash?.(files.dataFolder, statusPath)
    await files.trash?.(files.dataFolder, logPath)

    // Duration is probed FIRST, in the foreground, and the job then carries no
    // comparison operator at all. That is not a style choice: `--match-filter
    // "duration <= 30"` puts `<` and `>` in the command, cmd.exe eats them as
    // redirects even inside quotes, and yt-dlp then reports "You must provide
    // at least one URL" — a failure that looks like a bad URL, not a quoting
    // bug. `--print duration` costs ~2s and fits inside the 30s shell door.
    onStage?.('checking')
    const seconds = await probeDuration(videoId)
    if (seconds !== null && seconds > YT_MAX_SECONDS) {
      throw new ImportError('tooLong', t('ytTooLong').replace('{secs}', String(Math.round(seconds))))
    }

    const args = [
      '-x',
      '--audio-format', 'mp3',
      '--audio-quality', '5',
      '--no-playlist',
      '-o', `${stem}.%(ext)s`,
      `https://www.youtube.com/watch?v=${videoId}`
    ]

    // ffmpeg rewrites the downloaded file in place: trim the window, then
    // normalise to a broadcast-ish level. Every pad then plays at a comparable
    // volume — a YouTube clip is routinely 8-10 dB quieter than a hand-made one,
    // which reads as "this pad doesn't work".
    const from = Math.max(0, Number(start) || 0)
    const span = length === null ? null : Math.max(0.2, Number(length) || 0)
    const post = [
      'ffmpeg',
      '-hide_banner', '-loglevel', 'error',
      ...(from > 0 ? ['-ss', String(from)] : []),
      ...(span ? ['-t', String(span)] : []),
      '-i', q0(`${stem}.mp3`),
      '-af', q0('loudnorm=I=-16:TP=-1.5:LRA=11'),
      '-b:a', '128k',
      '-y', q0(`${stem}.out.mp3`),
      `&& move /y ${q0(`${stem}.out.mp3`)} ${q0(`${stem}.mp3`)}`
    ].join(' ')

    const scriptPath = `.${stem}.cmd`
    // Relative names only — see jobScript. The script anchors to its own folder,
    // so nothing here needs an absolute path or an env var.
    const script = jobScript({
      exe: 'uvx yt-dlp',
      args,
      out: '%~dp0',
      log: `.${stem}.log`,
      status: `.${stem}.status`,
      mp3: `${stem}.mp3`,
      post
    })
    const wroteScript = await files.writeText(files.dataFolder, scriptPath, script)
    if (!wroteScript.ok) throw new ImportError('failed', wroteScript.message || t('saveFailed'))

    onStage?.('downloading')
    const started = await runShell(detachedCommand(joinNative(dir, scriptPath)))
    if (!started) throw new ImportError('noShell', t('ytNoShell'))

    // Publish progress while the job runs: the panel renders this, so a long
    // download shows movement instead of looking dead.
    ytJob.set({ stage: 'downloading', id, percent: 0, at: Date.now() })
    const outcome = await waitForStatus(files, statusPath, YT_TIMEOUT_MS, {
      files,
      logPath,
      onProgress: percent => ytJob.set({ stage: 'downloading', id, percent, at: Date.now() })
    })
    if (outcome === 'timeout') {
      // A job that produced no status file at all died before its first line —
      // say that, rather than blaming a slow conversion.
      const detail = await readLogTail(files, logPath)
      ytJob.set(null)
      throw new ImportError('timeout', detail || t('ytTimeout'))
    }
    if (outcome !== 'ok') {
      const detail = await readLogTail(files, logPath)
      throw new ImportError('failed', detail || t('ytFailed'))
    }

    const audio = await files.readDataUrl(files.dataFolder, mp3Path)
    if (!audio.ok) throw new ImportError('failed', audio.message || t('ytFailed'))
    const size = Math.round((audio.url.length - audio.url.indexOf(',') - 1) * 0.75)
    if (size > MAX_FILE_BYTES) {
      await files.trash?.(files.dataFolder, mp3Path)
      throw new ImportError('tooLarge', t('tooLarge'))
    }

    const sound = {
      id,
      name: uniqueName(`YouTube ${videoId.slice(0, 6)}`, sounds.get().map(item => item.name)),
      kind: 'file',
      mime: 'audio/mpeg',
      bytes: size
    }

    // Re-encode the mp3 into the plugin's usual base64 blob so playback and
    // deletion follow exactly the same path as an uploaded file.
    const comma = audio.url.indexOf(',')
    const written = await files.writeText(files.dataFolder, `${id}.b64`, audio.url.slice(comma + 1))
    if (!written.ok) throw new ImportError('failed', written.message || t('saveFailed'))

    for (const name of [mp3Path, statusPath, logPath, scriptPath]) {
      await files.trash?.(files.dataFolder, name)
    }

    // NOT audio.url directly: readDataUrl labels an .mp3 as
    // application/octet-stream, which will not decode.
    urls.set(id, withMime(audio.url, 'audio/mpeg'))
    persistSounds([...sounds.get(), sound])
    onStage?.('done')
    ytJob.set(null)
    haptic('tap')
    return sound
  }

  /** Copy a clip to a new pad, so a destructive trim can leave the original be. */
  async function duplicate(soundId) {
    const files = ctx.files
    const sound = sounds.get().find(item => item.id === soundId)
    if (!sound || !files) return null
    if (sounds.get().length >= MAX_SOUNDS) {
      notify({ kind: 'warning', message: t('tooMany') })
      return null
    }
    const id = newId()
    if (sound.kind === 'file') {
      const read = await files.readText(files.dataFolder, `${sound.id}.b64`)
      if (!read.ok) {
        notify({ kind: 'error', message: read.message || t('missingAudio') })
        return null
      }
      const written = await files.writeText(files.dataFolder, `${id}.b64`, read.text)
      if (!written.ok) {
        notify({ kind: 'error', message: written.message || t('saveFailed') })
        return null
      }
    }
    const copy = {
      ...sound,
      id,
      name: uniqueName(`${sound.name} copy`, sounds.get().map(item => item.name))
    }
    persistSounds([...sounds.get(), copy])
    haptic('tap')

    return copy
  }

  /** Re-cut one stored clip in place.
   *
   * Trimming is destructive — the original bytes are gone — because keeping a
   * pristine copy would double the storage for a feature whose whole point is
   * "this pad is too long". The pad's name, triggers and gain are untouched.
   */
  async function trimSound(soundId, { start = 0, length = null } = {}) {
    const files = ctx.files
    if (!files) throw new ImportError('noFileAccess', t('noFileAccess'))
    const sound = sounds.get().find(item => item.id === soundId)
    // Validate what the USER controls first: a bad window or an unsuitable pad is
    // their mistake, and reporting "open a chat" instead would be misleading.
    if (!sound || sound.kind !== 'file') throw new ImportError('notFile', t('trimOnlyFiles'))

    const from = Math.max(0, Number(start) || 0)
    const span = length === null || length === '' ? null : Math.max(0.2, Number(length) || 0)
    if (!from && !span) throw new ImportError('noWindow', t('trimNeedsWindow'))

    if (!activeSessionId()) throw new ImportError('noSession', t('ytNoSession'))

    const tools = await probeTools()
    if (!tools.ffmpeg) throw new ImportError('noFfmpeg', t('ytNoFfmpeg'))

    const id = sound.id
    const scriptPath = `.${id}.trim.cmd`
    const statusPath = `.${id}.trimstatus`
    const tmp = `.${id}.trim-in.mp3`
    const out = `.${id}.trim-out.mp3`

    for (const name of [statusPath, scriptPath, tmp, out]) {
      await files.trash?.(files.dataFolder, name)
    }

    const wrote = await files.writeText(
      files.dataFolder,
      scriptPath,
      trimScript({ id, start: from, length: span, tmp, out })
    )
    if (!wrote.ok) throw new ImportError('failed', wrote.message || t('saveFailed'))

    const started = await runShell(detachedCommand(joinNative(await dataDir() ?? '.', scriptPath)))
    if (!started) throw new ImportError('noShell', t('ytNoShell'))

    const outcome = await waitForStatus(files, statusPath, YT_TIMEOUT_MS)
    for (const name of [scriptPath, tmp, out]) await files.trash?.(files.dataFolder, name)
    if (outcome !== 'ok') {
      await files.trash?.(files.dataFolder, statusPath)
      throw new ImportError('failed', t('trimFailed'))
    }
    await files.trash?.(files.dataFolder, statusPath)

    // The cached data URL is now stale; the next play re-reads the file.
    urls.delete(id)
    const read = await files.readText(files.dataFolder, `${id}.b64`)
    if (read.ok) {
      persistSounds(
        sounds.get().map(item =>
          item.id === id ? { ...item, bytes: Math.round(String(read.text).length * 0.75) } : item
        )
      )
    }
    haptic('tap')
    return true
  }

  /** Host toast, hoisted so UI code never needs `ctx` itself. */
  function notify(message) {
    try {
      ctx.notify?.(message)
    } catch {
      // A toast must never take down the caller.
    }
  }

  /** Stop every sounding voice but keep the AudioContext alive. */
  function stopVoices() {
    for (const audio of playing) {
      audio.pause()
      audio.currentTime = 0
      audio.src = ''
    }
    playing.clear()
    for (const timer of timers.values()) clearTimeout(timer)
    timers.clear()
    // A cut pad must not stay lit: the flash flag is visual state for a sound
    // that is no longer playing.
    active.set({})
  }

  function stopAll() {
    for (const audio of playing) {
      audio.pause()
      audio.src = ''
    }
    playing.clear()
    active.set({})
    if (audioContext && audioContext.state === 'running') void audioContext.suspend().catch(() => {})
  }

  async function addFile(file) {
    const files = ctx.files
    if (!files) {
      ctx.notify?.({ kind: 'error', message: t('noFileAccess') })
      return
    }
    if (!file) return
    if (file.size > MAX_FILE_BYTES) {
      ctx.notify?.({ kind: 'warning', message: t('tooLarge') })
      return
    }
    if (sounds.get().length >= MAX_SOUNDS) {
      ctx.notify?.({ kind: 'warning', message: t('tooMany') })
      return
    }
    saving.set(true)
    try {
      const dataUrl = await readAsDataUrl(file)
      const comma = dataUrl.indexOf(',')
      const mime = mimeOf(file, comma > 0 ? dataUrl.slice(5, comma) : '')
      if (comma < 0 || !mime) {
        ctx.notify?.({ kind: 'warning', message: t('notAudio') })
        return
      }
      const base64 = dataUrl.slice(comma + 1)
      const sound = {
        id: newId(),
        name: uniqueName(baseName(file.name), sounds.get().map(item => item.name)),
        kind: 'file',
        mime,
        bytes: file.size
      }
      const written = await files.writeText(files.dataFolder, `${sound.id}.b64`, base64)
      if (!written.ok) {
        ctx.notify?.({ kind: 'error', message: written.message || t('saveFailed') })
        return
      }
      urls.set(sound.id, dataUrl)
      persistSounds([...sounds.get(), sound])
      haptic('tap')
    } catch (error) {
      ctx.notify?.({ kind: 'error', message: error instanceof Error ? error.message : String(error) })
    } finally {
      if (!disposed) saving.set(false)
    }
  }

  function addPreset(synthId) {
    const synth = SYNTH_BY_ID.get(synthId)
    if (!synth || sounds.get().length >= MAX_SOUNDS) return
    const sound = {
      id: `synth-${synth.id}-${Date.now().toString(36)}`,
      name: uniqueName(synth.name, sounds.get().map(item => item.name)),
      kind: 'synth',
      synth: synth.id
    }
    persistSounds([...sounds.get(), sound])
    play(sound)
  }

  /** True when a clip blob is still wanted by some profile. Deleting a pad in
   *  the live set must not take the file with it if a saved profile holds the
   *  same pad — profiles share blobs by sound id, they do not copy them. */
  function blobInUse(soundId) {
    if (sounds.get().some(item => item.id === soundId)) return true

    return profiles.get().some(profile => profile.sounds.some(item => item.id === soundId))
  }

  function remove(soundId) {
    const target = sounds.get().find(item => item.id === soundId)
    if (!target) return
    const files = ctx.files
    // Remove from the live set BEFORE deciding about the blob, so the check
    // sees the post-delete world.
    persistSounds(sounds.get().filter(item => item.id !== soundId))
    if (target.kind === 'file' && !blobInUse(soundId) && files) {
      void files.trash(files.dataFolder, `${target.id}.b64`).catch(() => {})
      urls.delete(target.id)
    }
  }

  // ── profiles ────────────────────────────────────────────────────────────
  // A profile stores the pads and the global settings together, because they
  // only make sense as a pair: a "podcast" profile is as much about the volume
  // and one-at-a-time as about which clips are on the board.

  const persistProfiles = next => {
    profiles.set(next)
    ctx.storage.set('profiles', next)
  }

  const setActive = id => {
    activeProfile.set(id)
    ctx.storage.set('activeProfile', id)
  }

  /** Any edit to the live set means it no longer matches the profile it came
   *  from. Rather than diff, just forget the association — "modified" would
   *  need a saved hash and would drift anyway. */
  function leaveProfile() {
    if (!activeProfile.get()) return
    activeProfile.set(null)
    ctx.storage.set('activeProfile', null)
  }

  const snapshot = () => ({
    sounds: sounds.get().map(sound => ({ ...sound })),
    settings: { ...settings.get() }
  })

  /** Save the current board under a name. Saving over the active profile is
   *  the common case ("I tweaked my podcast board"), so it updates in place
   *  instead of piling up near-duplicates. */
  function saveProfile(rawName, { overwriteId = null } = {}) {
    const name = cleanName(rawName, 'Profile')
    const active = activeProfile.get()
    const existing = profiles.get()
    const snapshotValue = snapshot()

    // Save-in-place when the name still matches the open profile.
    const activeEntry = existing.find(profile => profile.id === active)
    const sameName = activeEntry && activeEntry.name.toLowerCase() === name.toLowerCase()
    // Typing the name of a profile that already exists OVERWRITES it. This used
    // to append " 2" via uniqueName, so every tweak left another near-copy —
    // exactly the sprawl the Overwrite button exists to prevent.
    const explicit = overwriteId ? existing.find(profile => profile.id === overwriteId) : null
    const named = existing.find(profile => profile.name.toLowerCase() === name.toLowerCase())

    const target = explicit ?? (sameName ? activeEntry : named) ?? null

    if (target) {
      const next = existing.map(profile =>
        profile.id === target.id
          // An explicit overwrite keeps the profile's own name: the button means
          // "save this board into THAT profile", not "rename it".
          ? { ...profile, ...snapshotValue, name: explicit ? profile.name : name }
          : profile
      )
      persistProfiles(next)
      setActive(target.id)

      return target.id
    }

    if (existing.length >= MAX_PROFILES) {
      throw new Error(t('profilesFull'))
    }

    const profile = {
      id: `prf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      name: uniqueName(name, existing.map(item => item.name)),
      ...snapshotValue,
      createdAt: Date.now()
    }
    persistProfiles([...existing, profile])
    setActive(profile.id)

    return profile.id
  }

  /** Save the live board INTO an existing profile, keeping that profile's name.
   *  This is the direct answer to "one profile per tweak": you pick which saved
   *  board to replace instead of typing a new name and accumulating copies. */
  function overwriteProfile(profileId) {
    const profile = profiles.get().find(item => item.id === profileId)
    if (!profile) return null

    return saveProfile(profile.name, { overwriteId: profileId })
  }

  /** Switch the live board to a saved profile. The previous unsaved board is
   *  kept as a profile named "Previous" the first time you switch away from an
   *  unsaved set — switching is otherwise a silent way to lose work. */
  function applyProfile(profileId) {
    const profile = profiles.get().find(item => item.id === profileId)
    if (!profile) return

    if (!activeProfile.get() && sounds.get().length) {
      const autoName = t('previousProfile')
      const taken = profiles.get().map(item => item.name.toLowerCase())
      if (!taken.includes(autoName.toLowerCase()) && profiles.get().length < MAX_PROFILES) {
        persistProfiles([
          ...profiles.get(),
          {
            id: `prf-${Date.now().toString(36)}-auto`,
            name: autoName,
            ...snapshot(),
            createdAt: Date.now()
          }
        ])
      }
    }

    stopVoices()
    applyingProfile = true
    try {
      sounds.set(profile.sounds.map(sound => ({ ...sound })))
      ctx.storage.set('sounds', sounds.get())
      settings.set(cleanSettings(profile.settings))
      ctx.storage.set('settings', settings.get())
    } finally {
      applyingProfile = false
    }
    setActive(profile.id)
    urls.clear()
  }

  function renameProfile(profileId, rawName) {
    const next = profiles.get().map(profile =>
      profile.id === profileId ? { ...profile, name: cleanName(rawName, profile.name) } : profile
    )
    persistProfiles(next)
  }

  /** Deleting a profile drops its pads, so any clip blob only it used is now
   *  garbage. Sweep those, and only those. */
  function deleteProfile(profileId) {
    const target = profiles.get().find(profile => profile.id === profileId)
    if (!target) return
    persistProfiles(profiles.get().filter(profile => profile.id !== profileId))
    if (activeProfile.get() === profileId) setActive(null)

    const files = ctx.files
    if (!files) return
    for (const sound of target.sounds) {
      if (sound.kind !== 'file') continue
      if (blobInUse(sound.id)) continue
      void files.trash(files.dataFolder, `${sound.id}.b64`).catch(() => {})
      urls.delete(sound.id)
    }
  }

  /** Move a pad to a new index. Order is what the 1-9 keys address, so this is
   *  also how you choose which pad each key fires. */
  function move(soundId, toIndex) {
    const current = sounds.get()
    const from = current.findIndex(item => item.id === soundId)
    if (from < 0) return
    const to = Math.max(0, Math.min(current.length - 1, Math.round(toIndex)))
    if (to === from) return
    const next = [...current]
    const [moved] = next.splice(from, 1)
    next.splice(to, 0, moved)
    persistSounds(next)
  }

  /** A per-pad gain multiplier, 0-200%. The master volume is global; this is
   *  for the one clip that is still too loud or too quiet after normalisation. */
  function setGain(soundId, percent) {
    const value = Math.max(0, Math.min(200, Math.round(Number(percent) || 0)))
    persistSounds(
      sounds.get().map(sound => {
        if (sound.id !== soundId) return sound
        const { gain: _drop, ...rest } = sound
        return value === 100 ? rest : { ...rest, gain: value }
      })
    )
  }

  function rename(soundId, name) {
    const cleaned = cleanName(name, '')
    const current = sounds.get()
    const existing = current.find(item => item.id === soundId)
    if (!existing) return
    if (!cleaned) {
      // An empty field is a cancelled rename, not a nameless pad.
      persistSounds([...current])
      return
    }
    const others = current.filter(item => item.id !== soundId)
    persistSounds(current.map(item => (item.id === soundId ? { ...item, name: uniqueName(cleaned, others.map(other => other.name)) } : item)))
  }

  function restorePresets() {
    const present = new Set(sounds.get().filter(item => item.kind === 'synth').map(item => item.synth))
    const missing = DEFAULT_SOUNDS.filter(sound => !present.has(sound.synth))
    if (!missing.length) return
    persistSounds([...sounds.get(), ...missing.map(sound => ({ ...sound, id: `synth-${sound.synth}-${Date.now().toString(36)}` }))])
  }

  /** Collect every pad's clip, then write one setup file.
   *
   *  Two doors, tried in this order: the browser's download path (Electron
   *  turns it into the app's save dialog, defaulting to Downloads) and, when
   *  that is unavailable, the plugin's own data folder — always writable, so an
   *  export never ends in "nothing happened". A clip that cannot be read is
   *  counted and named rather than silently left out: a setup missing a sound
   *  is worse than one that says so.
   */
  async function exportBundle({ toFolder = false } = {}) {
    const files = ctx.files
    const current = sounds.get()
    const audio = new Map()
    const missing = []

    for (const sound of current) {
      if (sound.kind !== 'file') continue
      if (!files) {
        missing.push(sound.name)
        continue
      }
      const read = await files.readText(files.dataFolder, `${sound.id}.b64`)
      const text = read.ok ? String(read.text ?? '').replace(/\s+/g, '') : ''
      if (!text) {
        missing.push(sound.name)
        continue
      }
      audio.set(sound.id, text)
    }

    const bundle = buildBundle({ sounds: current, settings: settings.get(), audio })
    const text = JSON.stringify(bundle, null, 1)
    const fileName = `soundboard-setup-${dayStamp()}.json`
    const size = new TextEncoder().encode(text).length

    let savedTo = null
    let path = null
    if (toFolder) {
      if (!files) throw new ImportError('noFileAccess', t('noFileAccess'))
      const written = await files.writeText(files.dataFolder, fileName, text)
      if (!written.ok) throw new ImportError('saveFailed', written.message || t('saveFailed'))
      savedTo = 'folder'
      path = written.path || fileName
    } else if (downloadFile(fileName, text)) {
      savedTo = 'download'
    } else if (files) {
      // No download door (an older shell): the data folder is still a real
      // place on disk, and the toast names the file.
      const written = await files.writeText(files.dataFolder, fileName, text)
      if (written.ok) {
        savedTo = 'folder'
        path = written.path || fileName
      }
    }

    if (!savedTo) throw new ImportError('saveFailed', t('exportFailed'))
    haptic('tap')

    return { fileName, path, size, pads: bundle.sounds.length, missing, savedTo }
  }

  /** Parse a setup file and report the plan without touching anything. The
   *  caller shows it, the user confirms, then `applyBundle` writes it. */
  function inspectBundle(text) {
    return planImport(text, sounds.get().length)
  }

  /** Read a chosen file and return its plan. Split from `inspectBundle` so the
   *  FileReader (which needs a real DOM) stays in one place. */
  async function readSetupFile(file) {
    if (!file) throw new ImportError('noFile')
    if (file.size > MAX_IMPORT_BYTES) throw new ImportError('tooBig', t('importTooBig'))
    let text
    try {
      text = await readAsText(file)
    } catch {
      throw new ImportError('unreadable', t('importUnreadable'))
    }

    return { ...inspectBundle(text), fileName: String(file.name || '') }
  }

  /** Write a confirmed plan: clips first, then the pads, then the settings.
   *
   *  Ids are minted here, never taken from the file, and names are made unique
   *  against what the board already holds — an import ADDS to a board rather
   *  than replacing it, so nobody loses their own pads to someone else's file.
   *  `mode: 'replace'` is the deliberate exception: the imported set becomes the
   *  board, and the clips it displaces go to the OS trash (recoverable) instead
   *  of being left as orphans in the data folder.
   *
   *  If a clip write fails the pad is not added at all: a pad that cannot play
   *  is worse than a pad that was reported as skipped.
   */
  async function applyBundle(plan, { includeSettings = true, mode = 'add' } = {}) {
    const files = ctx.files
    const entries = Array.isArray(plan?.entries) ? plan.entries : []
    if (!entries.length) return { added: 0, skipped: 0, removed: 0 }
    if (entries.some(entry => entry.kind === 'file') && !files) {
      throw new ImportError('noFileAccess', t('noFileAccess'))
    }
    const replace = mode === 'replace'
    const existing = sounds.get()
    // ADD mode can only take what is left of the board's 40-pad budget; the
    // rest is reported back rather than dropped in silence. REPLACE mode has the
    // whole budget (the file was capped at MAX_SOUNDS when it was planned).
    const room = replace ? MAX_SOUNDS : Math.max(0, MAX_SOUNDS - existing.length)
    const wanted = entries.slice(0, room)
    if (!wanted.length) return { added: 0, skipped: 0, removed: 0, refused: entries.length }

    const added = []
    let skipped = 0
    for (const entry of wanted) {
      const id = newId()
      if (entry.kind === 'file') {
        const written = await files.writeText(files.dataFolder, `${id}.b64`, entry.audio)
        if (!written.ok) {
          skipped += 1
          continue
        }
      }
      const sound = {
        id,
        name: uniqueName(entry.name, (replace ? added : [...existing, ...added]).map(item => item.name)),
        kind: entry.kind
      }
      if (entry.kind === 'synth') sound.synth = entry.synth
      else {
        sound.mime = entry.mime
        sound.bytes = entry.bytes
      }
      if (Number.isFinite(entry.gain) && entry.gain !== 100) sound.gain = entry.gain
      if (entry.triggers?.length) sound.triggers = entry.triggers
      added.push(sound)
    }

    let removed = 0
    if (replace) {
      for (const sound of existing) {
        if (sound.kind === 'file' && files) {
          void files.trash(files.dataFolder, `${sound.id}.b64`).catch(() => {})
        }
        urls.delete(sound.id)
        removed += 1
      }
      if (added.length) persistSounds(added)
      else removed = 0
    } else if (added.length) {
      persistSounds([...existing, ...added])
    }

    if (includeSettings && plan.settings) persistSettings(plan.settings)
    haptic('tap')

    return { added: added.length, skipped, removed: replace ? removed : 0, refused: entries.length - wanted.length }
  }

  ctx.onDispose(() => {
    disposed = true
    for (const timer of timers.values()) clearTimeout(timer)
    timers.clear()
    for (const audio of playing) {
      audio.pause()
      audio.src = ''
    }
    playing.clear()
    urls.clear()
    if (audioContext) void audioContext.close().catch(() => {})
    audioContext = null
  })

  return {
    sounds,
    settings,
    open,
    active,
    saving,
    lastTrigger,
    play,
    stopAll,
    addFile,
    addPreset,
    remove,
    profiles,
    activeProfile,
    /** Test seam: the cached playback URL for a pad, or null. Read-only. */
    peekCachedUrl: soundId => urls.get(soundId) ?? null,
    saveProfile,
    overwriteProfile,
    applyProfile,
    renameProfile,
    deleteProfile,
    rename,
    bind: toggleTrigger,
    toggleTrigger,
    clearTriggers,
    trimSound,
    duplicate,
    move,
    setGain,
    importYoutube,
    ytJob,
    notify,
    restorePresets,
    exportBundle,
    inspectBundle,
    readSetupFile,
    applyBundle,
    setVolume: volume => persistSettings({ volume }),
    setShowLabel: showLabel => persistSettings({ showLabel }),
    setPadsPerRow: padsPerRow => persistSettings({ padsPerRow }),
    setOneAtATime: oneAtATime => persistSettings({ oneAtATime })
  }
}

// ── styles ────────────────────────────────────────────────────────────────
// A disk plugin is not scanned by Tailwind, so layout lives in its own
// stylesheet and every colour comes from a theme variable.

const CSS = `
.hermes-sb-bar{display:flex;align-items:center;height:100%;gap:2px}
.hermes-sb-chip{display:inline-flex;align-items:center;gap:4px;height:100%;padding:0 5px;font-size:11px;color:var(--ui-text-tertiary)}
.hermes-sb-chip:hover{color:var(--ui-text-primary)}
.hermes-sb-chip[data-open=true]{color:var(--ui-accent)}
.hermes-sb-chip-label{max-width:96px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.hermes-sb-panel{width:308px;max-width:calc(100vw - 24px);outline:none}
.hermes-sb-head{display:flex;align-items:center;gap:2px;padding:0 0 6px}
.hermes-sb-head-title{flex:0 0 auto;min-width:0;font-size:10px;line-height:14px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--ui-text-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.hermes-sb-iconbtn{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:4px;color:var(--ui-text-tertiary);background:transparent;flex-shrink:0}
.hermes-sb-iconbtn:hover{background:var(--chrome-action-hover);color:var(--ui-text-primary)}
.hermes-sb-iconbtn[data-on=true]{color:var(--ui-accent)}
.hermes-sb-iconbtn:focus-visible{outline:1px solid var(--ui-accent);outline-offset:-1px}
.hermes-sb-iconbtn:disabled{cursor:default;opacity:.5}
/* No reserved scrollbar gutter: a stable gutter reserves ~15px on the right
   only, which made the grid visibly right-heavy against its 4px left inset.
   The pads shrink slightly once a tenth sound makes the list scroll; that is a
   better trade than a permanent asymmetry. */
.hermes-sb-grid{display:grid;gap:6px;max-height:min(46vh,300px);overflow-y:auto;overscroll-behavior:contain;padding:2px;scrollbar-width:thin}
/* A pad needs a boundary of its own: the fill delta against the popover is
   ~1.1:1 and reads as text on a surface rather than seven press targets. An
   inset hairline (a shadow, not a border — nothing reflows) fixes that. */
.hermes-sb-pad{position:relative;display:flex;flex-direction:column;align-items:center;justify-content:center;height:42px;min-width:0;padding:0 5px;border-radius:5px;background:var(--ui-bg-quaternary);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--ui-stroke-secondary) 70%,transparent);color:var(--ui-text-primary);transition:background-color .1s,box-shadow .1s}
.hermes-sb-pad:hover{background:var(--chrome-action-hover);box-shadow:inset 0 0 0 1px var(--ui-stroke-secondary)}
.hermes-sb-pad:focus-visible{outline:1px solid var(--ui-accent);outline-offset:-1px}
.hermes-sb-pad[data-active=true]{background:color-mix(in srgb,var(--ui-accent) 22%,var(--ui-bg-quaternary));box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--ui-accent) 70%,transparent)}
/* A custom pad gets a hairline underscore so "my file" and "built-in tone"
   differ without a second line of text in every tile. */
.hermes-sb-pad[data-custom=true]::after{content:"";position:absolute;left:50%;bottom:4px;width:10px;height:1px;transform:translateX(-50%);background:color-mix(in srgb,var(--ui-text-primary) 30%,transparent)}
.hermes-sb-pad[data-active=true][data-custom=true]::after{background:var(--ui-accent)}
/* A bound pad carries a small dot top-right: the binding is invisible in the
   grid otherwise, and a user needs to know which pads will fire on their own. */
.hermes-sb-pad[data-bound=true]::before{content:"";position:absolute;top:4px;right:4px;width:4px;height:4px;
  border-radius:50%;background:var(--ui-accent);opacity:.75}
.hermes-sb-pad[data-bound=true][data-active=true]::before{opacity:1}
.hermes-sb-pad-name{max-width:100%;font-size:11px;line-height:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.hermes-sb-pad-key{position:absolute;top:2px;left:4px;font-size:9px;line-height:10px;color:var(--ui-text-tertiary);font-variant-numeric:tabular-nums}
.hermes-sb-pad[data-active=true] .hermes-sb-pad-key{color:var(--ui-accent)}
/* The trailing "+" tile: the same footprint as a pad so the grid stays even,
   dashed and quieter so it never reads as a sound. */
.hermes-sb-add{align-items:center;justify-content:center;background:transparent;box-shadow:inset 0 0 0 1px var(--ui-stroke-tertiary);color:var(--ui-text-tertiary)}
.hermes-sb-add:hover{background:var(--chrome-action-hover);box-shadow:inset 0 0 0 1px var(--ui-stroke-secondary);color:var(--ui-text-primary)}
.hermes-sb-add:disabled{opacity:.5;cursor:default}
.hermes-sb-empty{padding:18px 8px;text-align:center;font-size:11px;line-height:16px;color:var(--ui-text-tertiary)}
.hermes-sb-list{display:flex;flex-direction:column;gap:2px;max-height:min(42vh,268px);overflow-y:auto;overscroll-behavior:contain;padding:2px;scrollbar-gutter:stable}
/* An open picker needs vertical room. Without this the 14-row menu is much
   taller than the list's 268px window, so you can only ever see a slice of it
   and have to scroll the whole board to reach the rest. The list still scrolls;
   it just gets a taller viewport while a menu is open. */
.hermes-sb-list:has(.hermes-sb-menu){max-height:min(66vh,460px)}
.hermes-sb-row{display:flex;align-items:center;gap:4px;flex-wrap:wrap}
.hermes-sb-row .hermes-sb-row-name{flex:1;min-width:0;font-size:11px;text-overflow:ellipsis}
/* The trigger picker is a button + an in-DOM menu, NOT a native <select>.
   A native option list is a browser-drawn popup coloured from the page's
   color-scheme property; inside this popover it came up as a near-white sheet
   under cream text (~1.1:1) and no page CSS could reach it. Owning the list
   means owning its background — the menu paints on --ui-bg-elevated with
   primary text, and the panel's own popover is opaque enough to sit behind it. */
/* The wrapper DISSOLVES (display: contents) so the picker and the menu become
   direct children of the row's flex layout. Without it the wrapper is a
   124x22 box and the menu, however wide it is told to be, can only render
   inside that box — which is why it came out 124px wide and unreadable. */
.hermes-sb-when{display:contents}
/* Width budget for a manage row inside a 308px panel (271 usable after the
   list's padding): play 22 + picker + name + gain 56 + trim 22 + delete 22, plus
   4px gaps between six children. The picker used to claim 124px, which left the
   name field 31px — a name nobody can read. It now claims 92px and the name
   takes the remainder, which is the field a person actually types in. */
.hermes-sb-row .hermes-sb-picker{flex:0 0 92px;width:92px}
.hermes-sb-picker{flex:0 0 124px;width:124px;height:21px;box-sizing:border-box;margin:0;display:flex;align-items:center;gap:2px;
  padding:0 4px;border-radius:3px;text-align:left;
  font-size:10px;line-height:13px;color:var(--ui-text-secondary);
  background-color:var(--ui-bg-tertiary);border:1px solid var(--ui-stroke-secondary);outline:none}
.hermes-sb-picker:hover{border-color:var(--ui-stroke-primary);color:var(--ui-text-primary)}
.hermes-sb-picker:focus-visible{outline:1px solid var(--ui-accent);outline-offset:-1px}
.hermes-sb-picker[data-open=true]{border-color:var(--ui-accent);color:var(--ui-text-primary)}
.hermes-sb-picker[data-bound=true]{color:var(--ui-accent);border-color:color-mix(in srgb,var(--ui-accent) 45%,var(--ui-stroke-secondary))}
.hermes-sb-picker-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.hermes-sb-picker-caret{flex-shrink:0;width:0;height:0;margin-top:1px;
  border-left:3px solid transparent;border-right:3px solid transparent;border-top:4px solid var(--ui-text-tertiary)}
.hermes-sb-picker[data-open=true] .hermes-sb-picker-caret{transform:rotate(180deg)}
/* Opaque, themed, and layered above the row it belongs to. max-height keeps a
   14-row grouped list inside a popover that is already near the viewport top. */
/* The menu is a normal flex item that wraps onto its own line: the row is
   flex-wrap: wrap and this is flex: 0 0 100%. Deliberately NOT positioned —
   absolute got clipped by the manage list's scroll container, and fixed
   re-anchored to the popover (whose backdrop-filter makes it the containing
   block), which is why the picker looked dead in the app while passing tests. */
/* NO INNER SCROLL. This is a block in flow, and the manage list around it is
   already a scroll container. Giving the menu its own max-height and overflow
   made two nested scrollers, and because both set overscroll-behavior:contain
   the chain never passed from the inner one to the outer one — so a picker
   opened low in the list could not be scrolled to its last rows at all. One
   container: the list scrolls, the menu is just tall. */
.hermes-sb-menu{flex:0 0 100%;width:100%;margin-top:2px;
  padding:3px;border-radius:5px;
  background-color:var(--ui-bg-elevated);border:1px solid var(--ui-stroke-secondary);
  box-shadow:0 10px 26px rgba(0,0,0,.55)}
.hermes-sb-menu-group{display:flex;flex-direction:column}
.hermes-sb-menu-heading{padding:5px 6px 2px;font-size:9px;line-height:11px;font-weight:600;
  letter-spacing:.06em;text-transform:uppercase;color:var(--ui-text-tertiary);background-color:var(--ui-bg-elevated)}
.hermes-sb-menu-row{display:flex;align-items:center;gap:5px;width:100%;padding:3px 6px;border-radius:3px;text-align:left;
  font-size:11px;line-height:15px;color:var(--ui-text-primary);background-color:transparent}
.hermes-sb-menu-row:hover,.hermes-sb-menu-row[data-cursor=true]{background-color:var(--chrome-action-hover)}
.hermes-sb-menu-row[data-selected=true]{color:var(--ui-accent);font-weight:600}
/* A fixed-width check gutter keeps every label on one left edge whether or not
   its row is bound — a multi-select list that shifts text as you tick items is
   unreadable while you are ticking them. */
.hermes-sb-menu-check{flex:0 0 10px;font-size:10px;line-height:15px;color:var(--ui-accent)}
.hermes-sb-menu-text{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.hermes-sb-menu-clear{display:block;width:100%;margin-top:3px;padding:4px 6px;border-radius:3px;text-align:left;
  font-size:10px;line-height:14px;color:var(--ui-text-tertiary);
  border-top:1px solid var(--ui-stroke-secondary)}
.hermes-sb-menu-clear:hover{color:var(--ui-text-primary);background-color:var(--chrome-action-hover)}
/* Per-pad trim: three tiny cells, aligned to the row's 21px control height. */
/* The trim row takes a full line inside the manage row (flex-wrap is on). */
/* Settings-page manager: full width, always visible, no popover budget. */
.hermes-sb-settings-list{display:flex;flex-direction:column;gap:3px;max-height:none}
.hermes-sb-settings-add{height:24px;padding:0 10px;border-radius:4px;font-size:11px;line-height:14px;
  color:var(--ui-text-secondary);background-color:var(--ui-bg-tertiary);
  border:1px solid var(--ui-stroke-secondary)}
.hermes-sb-settings-add:hover:not(:disabled){border-color:var(--ui-accent);color:var(--ui-text-primary)}
.hermes-sb-settings-add[data-on=true]{border-color:var(--ui-accent);color:var(--ui-accent)}
.hermes-sb-settings-add:disabled{opacity:.45;cursor:default}
.hermes-sb-settings-yt{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.hermes-sb-settings-yt .hermes-sb-yt-input{flex:1;min-width:180px}
.hermes-sb-settings-go{height:24px;padding:0 10px;border-radius:4px;font-size:11px;line-height:14px;
  color:var(--ui-text-secondary);background-color:var(--ui-bg-tertiary);
  border:1px solid var(--ui-stroke-secondary)}
.hermes-sb-settings-go:hover:not(:disabled){border-color:var(--ui-accent);color:var(--ui-text-primary)}
.hermes-sb-settings-go:disabled{opacity:.45;cursor:default}
/* A settings page has room, so the name field stops competing with the picker. */
.hermes-sb-settings-list .hermes-sb-picker{flex:0 0 132px;width:132px}
.hermes-sb-settings-list .hermes-sb-row .hermes-sb-row-name{min-width:90px}
/* Reorder arrows are for the settings page. The 271px popover row cannot hold
   them without squeezing the name field to ~43px, and dragging already reorders
   there — so they are hidden in the popover and shown where the width exists. */
.hermes-sb-reorder{display:none;align-items:center;gap:0;flex:0 0 auto;height:21px}
.hermes-sb-settings-list .hermes-sb-reorder{display:flex}
/* ── profiles ──────────────────────────────────────────────────────────
   The switcher sits in the popover header, so it has to survive a 271px row
   next to the title and three icon buttons: the name truncates, the caret
   never does. */
.hermes-sb-head-gap{flex:1 1 auto;min-width:2px}
.hermes-sb-profile{position:relative;flex:0 1 auto;min-width:0;max-width:118px;margin-right:2px}
.hermes-sb-profile-btn{display:flex;align-items:center;gap:3px;width:100%;height:20px;padding:0 4px;
  border-radius:4px;font-size:10px;line-height:14px;color:var(--ui-text-secondary);
  background-color:var(--ui-bg-tertiary);border:1px solid var(--ui-stroke-secondary)}
.hermes-sb-profile-btn:hover{border-color:var(--ui-accent);color:var(--ui-text-primary)}
.hermes-sb-profile-btn[data-on=true]{color:var(--ui-accent);border-color:var(--ui-accent)}
.hermes-sb-profile-btn:focus-visible{outline:1px solid var(--ui-accent);outline-offset:-1px}
.hermes-sb-profile-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:left}
.hermes-sb-profile-caret{flex:0 0 auto;font-size:8px;color:var(--ui-text-tertiary)}
/* In flow, not absolutely positioned — the same reason as the trigger picker:
   a 308px popover with a backdrop filter breaks fixed positioning. */
/* OVERLAY, not in flow. In flow the menu grew the header by ~100px and shoved
   the pad grid down every time it opened — the board jumped. The earlier
   in-flow decision was forced by the manage list's overflow-y:auto clipping an
   absolute child; the header has no such clipping ancestor, so absolute works
   here and the board stays put. */
/* OPAQUE. --ui-bg-secondary is NOT a solid colour in the real theme: it is
   color-mix(accent N%, color-mix(base 7%, transparent)), and that inner
   'transparent' propagates, leaving the composite at ~12-18% alpha. A dropdown
   painted with it let the pad grid show straight through. --ui-bg-elevated is
   opaque by construction (both its inputs are solid), so it is the correct base
   for a floating surface; the shadow and border carry the separation that the
   translucent fill used to fake. */
.hermes-sb-profile-menu{position:absolute;top:100%;left:0;z-index:40;
  display:flex;flex-direction:column;gap:2px;margin-top:4px;padding:6px;width:184px;
  border-radius:5px;
  background-color:var(--ui-bg-elevated, var(--theme-neutral-card, Canvas));
  border:1px solid var(--ui-stroke-secondary);
  box-shadow:0 12px 32px rgba(0,0,0,.55), 0 2px 6px rgba(0,0,0,.4),
             0 1px 0 rgba(255,255,255,.06) inset}
.hermes-sb-profile-item{display:flex;align-items:center;gap:6px;width:100%;height:22px;padding:0 5px;
  border-radius:4px;font-size:11px;text-align:left;color:var(--ui-text-secondary);background:transparent}
.hermes-sb-profile-item:hover{background-color:var(--chrome-action-hover)}
.hermes-sb-profile-item[aria-selected=true]{color:var(--ui-accent);
  background-color:color-mix(in srgb, var(--ui-accent) 12%, transparent)}
.hermes-sb-profile-item[aria-selected=true] .hermes-sb-profile-item-meta{color:var(--ui-text-secondary)}
.hermes-sb-profile-item-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.hermes-sb-profile-item-meta{flex:0 0 auto;font-size:10px;color:var(--ui-text-tertiary);margin-left:auto}
.hermes-sb-profile-item[aria-selected=false] .hermes-sb-profile-tick{visibility:hidden}
.hermes-sb-profile-tick{flex:0 0 10px;width:10px;text-align:center;font-size:10px;color:var(--ui-accent)}
.hermes-sb-profile-empty{padding:4px;font-size:11px;color:var(--ui-text-tertiary)}
.hermes-sb-profile-save{display:flex;align-items:center;gap:5px;padding-top:6px;margin-top:4px;
  border-top:1px solid var(--ui-stroke-secondary)}
.hermes-sb-profile-input{flex:1;min-width:0;height:24px;padding:0 5px;border-radius:4px;font-size:11px;
  color:var(--ui-text-primary);background-color:var(--ui-bg-primary);
  border:1px solid var(--ui-stroke-secondary)}
.hermes-sb-profile-input::placeholder{color:var(--ui-text-tertiary)}
.hermes-sb-profile-savebtn{flex:0 0 auto;height:24px;padding:0 9px;border-radius:4px;
  display:inline-flex;align-items:center;justify-content:center;font-size:10px;line-height:1;white-space:nowrap;
  color:var(--ui-accent);background-color:color-mix(in srgb, var(--ui-accent) 14%, transparent);
  border:1px solid color-mix(in srgb, var(--ui-accent) 55%, transparent)}
.hermes-sb-profile-savebtn:hover{background-color:color-mix(in srgb, var(--ui-accent) 24%, transparent)}
/* Settings rows: full width, so the action leads and the count trails. */
.hermes-sb-profile-rows{display:flex;flex-direction:column;gap:3px}
.hermes-sb-profile-row{display:flex;align-items:center;gap:5px;height:24px}
.hermes-sb-profile-use{flex:0 0 auto;height:21px;padding:0 7px;border-radius:4px;font-size:10px;
  color:var(--ui-text-secondary);background-color:var(--ui-bg-tertiary);
  border:1px solid var(--ui-stroke-secondary)}
.hermes-sb-profile-use:hover:not(:disabled){color:var(--ui-text-primary);border-color:var(--ui-accent)}
.hermes-sb-profile-use:disabled{color:var(--ui-accent);border-color:var(--ui-accent);cursor:default;opacity:1}
.hermes-sb-profile-rename{flex:1;min-width:80px;height:21px;padding:0 5px;border-radius:4px;font-size:11px;
  color:var(--ui-text-primary);background:transparent;border:1px solid transparent}
.hermes-sb-profile-row[data-active=true] .hermes-sb-profile-rename{color:var(--ui-accent)}
.hermes-sb-profile-rename:hover{background-color:var(--ui-bg-tertiary)}
.hermes-sb-profile-rename:focus{background-color:var(--ui-bg-primary);border-color:var(--ui-accent);
  outline:none}
.hermes-sb-profile-count{flex:0 0 auto;font-size:10px;color:var(--ui-text-tertiary)}
/* Overwrite: a text button, because a bare icon cannot say "replace this saved
   board". Fixed width because the armed label ("Replace?") is a different length
   from the resting one, and a control you must click twice in the same place
   must not move between those clicks. */
.hermes-sb-profile-overwrite{flex:0 0 auto;min-width:66px;height:21px;padding:0 7px;border-radius:4px;
  font-size:10px;line-height:14px;text-align:center;color:var(--ui-text-tertiary);
  background-color:transparent;border:1px solid var(--ui-stroke-secondary)}
.hermes-sb-profile-overwrite:hover{color:var(--ui-text-primary);border-color:var(--ui-accent)}
/* Armed: weight carries the danger as well as colour, so it is not signalled by
   hue alone. */
.hermes-sb-profile-overwrite[data-armed=true]{color:var(--ui-text-primary);font-weight:600;
  border-color:var(--ui-red);background-color:color-mix(in srgb, var(--ui-red) 20%, transparent)}
.hermes-sb-trim{flex:0 0 100%;display:flex;align-items:center;gap:5px;flex-wrap:wrap;
  margin:3px 0 2px;padding:5px 4px;border-radius:4px;
  background-color:var(--ui-bg-tertiary);border:1px solid var(--ui-stroke-secondary)}
.hermes-sb-trim-field{display:flex;align-items:center;gap:3px;flex:0 0 auto}
.hermes-sb-trim-label{font-size:9px;line-height:11px;color:var(--ui-text-tertiary);white-space:nowrap}
.hermes-sb-trim-input{width:44px;height:19px;box-sizing:border-box;padding:0 4px;border-radius:3px;
  font:inherit;font-size:10px;color:var(--ui-text-primary);background-color:var(--ui-bg-secondary);
  border:1px solid var(--ui-stroke-secondary);outline:none}
.hermes-sb-trim-input:focus{border-color:var(--ui-accent)}
.hermes-sb-trim-input::-webkit-inner-spin-button,
.hermes-sb-trim-input::-webkit-outer-spin-button{-webkit-appearance:none;margin:0}
.hermes-sb-trim-copy{display:flex;align-items:center;gap:3px;font-size:9px;line-height:11px;
  color:var(--ui-text-tertiary);white-space:nowrap;cursor:pointer}
.hermes-sb-trim-copy input{margin:0;accent-color:var(--ui-accent)}
.hermes-sb-trim-go{margin-left:auto;height:19px;padding:0 7px;border-radius:3px;font-size:9px;line-height:11px;
  color:var(--ui-text-secondary);background-color:var(--ui-bg-secondary);
  border:1px solid var(--ui-stroke-secondary)}
.hermes-sb-trim-go:hover:not(:disabled){border-color:var(--ui-accent);color:var(--ui-text-primary)}
.hermes-sb-trim-go:disabled{opacity:.45;cursor:default}
.hermes-sb-trim-error{flex:0 0 100%;padding:2px 4px 0;font-size:9px;line-height:12px;
  color:var(--ui-text-secondary)}
.hermes-sb-gain{display:flex;align-items:center;gap:1px;flex:0 0 auto;height:21px}
.hermes-sb-gain-step{width:12px;height:21px;border-radius:3px;font-size:11px;line-height:1;
  color:var(--ui-text-tertiary);background:transparent}
.hermes-sb-gain-step:hover{background:var(--chrome-action-hover);color:var(--ui-text-primary)}
.hermes-sb-gain-value{min-width:22px;text-align:center;font-size:9px;line-height:11px;
  font-variant-numeric:tabular-nums;color:var(--ui-text-quaternary)}
.hermes-sb-gain-value[data-off=true]{color:var(--ui-accent)}
/* Dragging: the source dims, and a pad the drag would land before gets a line
   on its leading edge so the drop position is visible, not guessed. */
.hermes-sb-pad[data-dragging=true]{opacity:.4}
.hermes-sb-pad[data-drop-before=true]{box-shadow:inset 2px 0 0 0 var(--ui-accent)}
.hermes-sb-pad[draggable=true]{cursor:grab}
.hermes-sb-pad[draggable=true]:active{cursor:grabbing}
.hermes-sb-rowbtn{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;flex-shrink:0;border-radius:4px;color:var(--ui-text-tertiary)}
.hermes-sb-rowbtn:hover{background:var(--chrome-action-hover);color:var(--ui-text-primary)}
.hermes-sb-rowbtn[data-destructive=true]{color:var(--ui-text-secondary)}
.hermes-sb-rowbtn[data-destructive=true]:hover{background:color-mix(in srgb,var(--ui-red) 18%,transparent);color:var(--ui-red)}
.hermes-sb-section{padding:8px 4px 2px;font-size:9px;line-height:12px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--ui-text-quaternary)}
.hermes-sb-presets{display:flex;flex-wrap:wrap;gap:4px;padding:2px}
.hermes-sb-preset{padding:2px 7px;border-radius:999px;background:var(--ui-bg-quaternary);font-size:11px;line-height:16px;color:var(--ui-text-secondary)}
.hermes-sb-preset:hover{background:var(--chrome-action-hover);color:var(--ui-text-primary)}
/* Volume row: same 4px inner inset and the same right column width as the grid
   above, so the two rows share one left and one right anchor. */
.hermes-sb-foot{display:flex;align-items:center;gap:6px;padding:7px 6px 1px;margin-top:6px;border-top:1px solid var(--ui-stroke-secondary)}
.hermes-sb-foot-icon{display:inline-flex;flex-shrink:0;color:var(--ui-text-quaternary);cursor:pointer;border-radius:3px}
.hermes-sb-foot-icon:hover{color:var(--ui-text-secondary)}
.hermes-sb-foot input[type=range]{flex:1;min-width:0;height:3px;accent-color:var(--ui-accent);cursor:pointer}
.hermes-sb-foot-value{width:30px;flex-shrink:0;text-align:right;font-size:10px;line-height:12px;font-variant-numeric:tabular-nums;color:var(--ui-text-quaternary)}
.hermes-sb-last{padding:4px 6px 0;font-size:9px;line-height:12px;color:var(--ui-text-quaternary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.hermes-sb-drop{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;border-radius:8px;background:color-mix(in srgb,var(--ui-bg-elevated) 90%,transparent);box-shadow:inset 0 0 0 2px var(--ui-accent);font-size:11px;color:var(--ui-accent);z-index:5}
.hermes-sb-yt{display:flex;align-items:center;gap:4px;margin-top:6px}
.hermes-sb-yt-input{flex:1;min-width:0;height:22px;box-sizing:border-box;padding:0 6px;border-radius:4px;
  font:inherit;font-size:11px;color:var(--ui-text-primary);background-color:var(--ui-bg-tertiary);
  border:1px solid var(--ui-stroke-secondary);outline:none}
.hermes-sb-yt-input:focus{border-color:var(--ui-accent)}
.hermes-sb-yt-input:disabled{opacity:.6}
/* The submit button is a CONTROL, not a call to action: it sits inside a row of
   quiet header buttons and a bordered field, so a solid accent block read as a
   stray yellow square. It now uses the same shape as its neighbours — bordered,
   tertiary fill, secondary glyph — and only the accent BORDER marks it as the
   one that commits, which is how the trigger picker already signals state. */
.hermes-sb-yt-go{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;flex-shrink:0;
  border-radius:4px;color:var(--ui-text-secondary);background-color:var(--ui-bg-tertiary);
  border:1px solid var(--ui-stroke-secondary)}
.hermes-sb-yt-go:hover{border-color:var(--ui-accent);color:var(--ui-text-primary)}
.hermes-sb-yt-go:active{background-color:var(--chrome-action-hover)}
.hermes-sb-yt-go:focus-visible{outline:1px solid var(--ui-accent);outline-offset:-1px}
.hermes-sb-yt-go:disabled{opacity:.45;cursor:default;border-color:var(--ui-stroke-tertiary);color:var(--ui-text-quaternary)}
.hermes-sb-yt-go:disabled:hover{border-color:var(--ui-stroke-tertiary);color:var(--ui-text-quaternary)}
/* Same 6px side padding as the URL row and the panel's own content inset, so
   the two rows share one left guide — without it "from" clipped at the edge. */
.hermes-sb-yt-trim{display:flex;align-items:center;gap:6px;margin-top:4px;padding:0 1px}
.hermes-sb-yt-trim-field{display:flex;align-items:center;gap:3px;flex:0 0 auto}
.hermes-sb-yt-trim-label{font-size:9px;line-height:11px;color:var(--ui-text-tertiary);white-space:nowrap}
.hermes-sb-yt-trim-input{width:46px;height:19px;box-sizing:border-box;padding:0 5px;border-radius:3px;
  font:inherit;font-size:10px;color:var(--ui-text-primary);background-color:var(--ui-bg-tertiary);
  border:1px solid var(--ui-stroke-secondary);outline:none}
.hermes-sb-yt-trim-input:focus{border-color:var(--ui-accent)}
.hermes-sb-yt-trim-input:disabled{opacity:.5}
/* Numbers are the point here, so keep the spinner out of a 46px field. */
.hermes-sb-yt-trim-input::-webkit-inner-spin-button,
.hermes-sb-yt-trim-input::-webkit-outer-spin-button{-webkit-appearance:none;margin:0}
.hermes-sb-yt-trim-hint{flex:1;min-width:0;font-size:9px;line-height:11px;color:var(--ui-text-quaternary);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:right;padding-right:2px}
.hermes-sb-yt-progress{display:flex;align-items:center;gap:6px;margin-top:6px}
.hermes-sb-yt-bar{flex:1;min-width:0;height:4px;border-radius:2px;overflow:hidden;background-color:var(--ui-bg-tertiary)}
.hermes-sb-yt-bar-fill{height:100%;border-radius:2px;background-color:var(--ui-accent);
  transition:width .25s ease-out}
.hermes-sb-yt-pct{flex:0 0 auto;font-size:9px;line-height:11px;font-variant-numeric:tabular-nums;
  color:var(--ui-text-tertiary);white-space:nowrap}
.hermes-sb-yt-note{padding:5px 2px 0;font-size:10px;line-height:14px;color:var(--ui-text-tertiary)}
/* An error is the one thing in this row the user MUST read, so it gets normal
   secondary text, a warning glyph via the marker, and a wrapped line — not the
   dimmest 9px tone it used to have. */
.hermes-sb-yt-note[data-error=true]{color:var(--ui-text-secondary);padding-left:12px;position:relative}
.hermes-sb-yt-note[data-error=true]::before{content:"!";position:absolute;left:2px;top:5px;
  width:8px;height:8px;border-radius:50%;text-align:center;
  font-size:7px;line-height:8px;font-weight:700;
  color:var(--ui-bg-primary);background-color:var(--ui-text-tertiary)}
.hermes-sb-body{position:relative}
/* Setup export / import. A quiet row at the foot of the panel: two bordered
   buttons the same height as the panel's other controls, no accent fill — the
   accent appears only on the plan's committing button and on hover. */
.hermes-sb-setup{margin-top:6px;padding-top:6px;border-top:1px solid var(--ui-stroke-secondary)}
.hermes-sb-setup-row{display:flex;align-items:center;gap:4px;padding:0 2px}
.hermes-sb-setup-title{font-size:9px;line-height:12px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--ui-text-quaternary);white-space:nowrap}
.hermes-sb-setup-spacer{flex:1;min-width:0}
.hermes-sb-setup-btn{display:inline-flex;align-items:center;gap:3px;height:20px;box-sizing:border-box;flex-shrink:0;
  padding:0 6px;border-radius:3px;font:inherit;font-size:10px;line-height:13px;
  color:var(--ui-text-secondary);background-color:var(--ui-bg-tertiary);
  border:1px solid var(--ui-stroke-secondary)}
.hermes-sb-setup-btn:hover:not(:disabled){border-color:var(--ui-stroke-primary);color:var(--ui-text-primary)}
.hermes-sb-setup-btn:focus-visible{outline:1px solid var(--ui-accent);outline-offset:-1px}
.hermes-sb-setup-btn:disabled{opacity:.5;cursor:default}
.hermes-sb-setup-btn[data-primary=true]{border-color:var(--ui-accent);color:var(--ui-accent)}
.hermes-sb-setup-btn[data-primary=true]:hover:not(:disabled){color:var(--ui-text-primary);
  background-color:color-mix(in srgb,var(--ui-accent) 16%,var(--ui-bg-tertiary))}
.hermes-sb-setup-note{padding:4px 4px 0;font-size:9px;line-height:12px;color:var(--ui-text-quaternary)}
/* The plan a picked file would apply. Opaque and inset like the trim row, so it
   reads as a confirmation block rather than another line of chrome. */
.hermes-sb-setup-plan{margin:5px 2px 0;padding:5px 6px;border-radius:4px;
  background-color:var(--ui-bg-tertiary);border:1px solid var(--ui-stroke-secondary)}
.hermes-sb-setup-plan-title{font-size:10px;line-height:14px;color:var(--ui-text-primary);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.hermes-sb-setup-plan-warn{padding-top:3px;font-size:10px;line-height:13px;color:var(--ui-text-secondary)}
.hermes-sb-setup-plan-warn::before{content:"! ";color:var(--ui-accent);font-weight:700}
/* Add / replace: two quiet radio buttons, the chosen one marked by the accent
   BORDER rather than a fill — a filled block in a 271px panel reads as a
   button that has already been pressed. */
.hermes-sb-setup-modes{display:flex;align-items:center;gap:3px;flex-wrap:wrap;padding-top:4px}
.hermes-sb-setup-mode{display:inline-flex;align-items:center;height:18px;box-sizing:border-box;
  padding:0 6px;border-radius:999px;font:inherit;font-size:9px;line-height:11px;
  color:var(--ui-text-tertiary);background-color:transparent;
  border:1px solid var(--ui-stroke-secondary)}
.hermes-sb-setup-mode:hover:not(:disabled){color:var(--ui-text-primary);border-color:var(--ui-stroke-primary)}
.hermes-sb-setup-mode[data-selected=true]{color:var(--ui-text-primary);border-color:var(--ui-accent)}
.hermes-sb-setup-mode[data-selected=true][data-destructive=true]{color:var(--ui-red);
  border-color:color-mix(in srgb,var(--ui-red) 65%,var(--ui-stroke-secondary))}
.hermes-sb-setup-mode:disabled{opacity:.5;cursor:default}
.hermes-sb-setup-check{display:flex;align-items:flex-start;gap:5px;padding-top:4px;
  font-size:10px;line-height:13px;color:var(--ui-text-tertiary);cursor:pointer}
.hermes-sb-setup-check input{margin:1px 0 0;flex-shrink:0;accent-color:var(--ui-accent)}
/* The label is the widest text in the block and will wrap at this width; it
   wraps as a paragraph under its own checkbox instead of being squeezed to the
   right, which is what made an orphaned fragment sit away from the box. */
.hermes-sb-setup-check span{flex:1;min-width:0}
.hermes-sb-setup-confirm{display:flex;align-items:center;gap:4px;padding-top:5px}
/* Same rule as every other row status: a failure is the most readable thing in
   its block, wrapped, with a marker — never the dimmest 9px tone. */
.hermes-sb-setup-error{margin:5px 2px 0;padding:4px 6px 4px 16px;border-radius:4px;position:relative;
  font-size:10px;line-height:14px;color:var(--ui-text-secondary);white-space:normal;
  background-color:color-mix(in srgb,var(--ui-red) 12%,transparent)}
.hermes-sb-setup-error::before{content:"!";position:absolute;left:5px;top:6px;
  width:8px;height:8px;border-radius:50%;text-align:center;
  font-size:7px;line-height:8px;font-weight:700;
  color:var(--ui-bg-primary);background-color:var(--ui-red)}
/* On the settings page the same component sits in a normal flow column, not a
   308px popover, so it loses the hairline and gains a readable body size. */
.hermes-sb-setup[data-page=true]{margin-top:0;padding-top:0;border-top:0;max-width:420px}
.hermes-sb-setup[data-page=true] .hermes-sb-setup-title{font-size:11px;letter-spacing:.04em;color:var(--ui-text-secondary)}
.hermes-sb-setup[data-page=true] .hermes-sb-setup-btn{height:24px;font-size:11px;padding:0 9px}
.hermes-sb-setup[data-page=true] .hermes-sb-setup-note,
.hermes-sb-setup[data-page=true] .hermes-sb-setup-plan-title,
.hermes-sb-setup[data-page=true] .hermes-sb-setup-plan-warn,
.hermes-sb-setup[data-page=true] .hermes-sb-setup-check,
.hermes-sb-setup[data-page=true] .hermes-sb-setup-error{font-size:12px;line-height:16px}
`

// ── UI ────────────────────────────────────────────────────────────────────

function Pad({ sound, index, engine, dragging, dragTarget, onDragStart, onDragOver, onDrop, onDragEnd }) {
  const active = useValue(engine.active)
  return jsxs('button', {
    type: 'button',
    className: 'hermes-sb-pad',
    draggable: true,
    'data-active': Boolean(active[sound.id]),
    'data-dragging': dragging === sound.id,
    // A pad the dragged one would land in front of: one line marks the seam,
    // so the drop position is visible while dragging rather than guessed.
    'data-drop-before': dragTarget === index && dragging && dragging !== sound.id,
    onDragStart: event => {
      event.dataTransfer.effectAllowed = 'move'
      // Some Electron builds require data to be set for a drag to start.
      event.dataTransfer.setData('text/plain', sound.id)
      onDragStart?.(sound.id)
    },
    onDragOver: event => {
      if (!dragging) return
      event.preventDefault()
      event.dataTransfer.dropEffect = 'move'
      onDragOver?.(index)
    },
    onDrop: event => {
      event.preventDefault()
      onDrop?.(index)
    },
    onDragEnd: () => onDragEnd?.(),
    // Present only on a custom pad: React renders boolean `data-*` as the
    // string "false", and an always-present attribute would read as truthy.
    ...(sound.kind === 'file' ? { 'data-custom': 'true' } : {}),
    ...(sound.triggers?.length ? { 'data-bound': 'true' } : {}),
    title: sound.triggers?.length
      ? `${sound.name} — ${sound.triggers.map(id => `“${TRIGGER_BY_ID.get(id)?.label}”`).join(', ')}`
      : sound.kind === 'file' ? `${sound.name} — your audio file` : `${sound.name} — built-in tone`,
    'aria-label': sound.name,
    onClick: () => {
      haptic('tap')
      engine.play(sound)
    },
    children: [
      index < 9 ? jsx('span', { className: 'hermes-sb-pad-key', 'aria-hidden': true, children: String(index + 1) }) : null,
      jsx('span', { className: 'hermes-sb-pad-name', children: sound.name })
    ]
  }, sound.id)
}

/** A multi-trigger picker rendered INSIDE the popover's own DOM.
 *
 * A native <select> was the obvious choice and the wrong one: its option list
 * is not a DOM node, it is a popup the browser draws from the page's
 * `color-scheme`, and inside the Desktop's nested popover it came up as a
 * near-white sheet under cream text — unreadable, and no CSS of ours could
 * reach it. This is a plain button + list, so every pixel is ours.
 *
 * MULTI-SELECT: clicking a trigger TOGGLES it and leaves the menu open, so one
 * pad can answer to several events. The menu closes on Escape, on a click
 * outside, or on the "Done" row — a checkbox list that shuts after every click
 * would make binding three events three round trips.
 *
 * Keyboard: Enter/Space opens, arrows move, Enter toggles, Escape closes —
 * handled on the trigger so it does not steal the panel's own key downs.
 */
function TriggerSelect({ sound, engine }) {
  const t = usePluginI18n(ID)
  const [open, setOpen] = useState(false)
  const [cursor, setCursor] = useState(-1)
  const boxRef = useRef(null)
  const menuRef = useRef(null)
  const boundIds = sound.triggers ?? []
  const boundTriggers = boundIds.map(id => TRIGGER_BY_ID.get(id)).filter(Boolean)

  // Flat list of selectable rows in render order, so the cursor can move over
  // a grouped list without knowing about the groups.
  const flat = TRIGGERS.map(trigger => trigger)

  useEffect(() => {
    if (!open) return
    // Bring the menu into view inside the board's list. Opening a picker on one
    // of the lower rows otherwise reveals a menu that starts below the fold, so
    // it looked like the list was cut off with no way to reach the rest.
    // Scrolls ONLY the list (not scrollIntoView, which would also move the
    // popover): a minimal nudge to make the menu fully visible.
    const node = menuRef.current
    const scroller = node?.closest('.hermes-sb-list')
    if (!node || !scroller) return
    const menuBox = node.getBoundingClientRect()
    const viewBox = scroller.getBoundingClientRect()
    if (menuBox.height > viewBox.height) {
      // Taller than the window: aligning its top is the only honest position,
      // then the list scrolls through the rest.
      scroller.scrollTop += menuBox.top - viewBox.top
    } else if (menuBox.bottom > viewBox.bottom) {
      scroller.scrollTop += menuBox.bottom - viewBox.bottom + 4
    } else if (menuBox.top < viewBox.top) {
      scroller.scrollTop -= viewBox.top - menuBox.top + 4
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onDown = event => {
      if (!boxRef.current?.contains(event.target)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const onKeyDown = event => {
    if (event.key === 'Escape' && open) {
      event.stopPropagation()
      setOpen(false)
      return
    }
    if (!open) {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        event.stopPropagation()
        setOpen(true)
        setCursor(0)
      }
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      event.stopPropagation()
      const step = event.key === 'ArrowDown' ? 1 : -1
      setCursor(index => Math.min(flat.length - 1, Math.max(0, (index < 0 ? 0 : index) + step)))
    } else if (event.key === 'Enter') {
      event.preventDefault()
      event.stopPropagation()
      if (cursor >= 0) engine.toggleTrigger(sound.id, flat[cursor].id)
    } else if (event.key === 'Tab') {
      setOpen(false)
    }
  }

  // What the closed control says: nothing, one label, or "N triggers".
  const summary = boundTriggers.length === 0
    ? t('whenNever')
    : boundTriggers.length === 1
      ? boundTriggers[0].label
      : t('whenCount').replace('{n}', String(boundTriggers.length))
  const detail = boundTriggers.length
    ? boundTriggers.map(trigger => `${trigger.label} — ${trigger.detail}`).join('\n')
    : t('whenNever')

  let rowIndex = -1

  // THE LIST IS IN FLOW, not positioned. Two separate attempts to float it
  // failed against the real app while passing every test:
  //   - `position: absolute` was clipped by the manage list's `overflow-y:auto`;
  //   - `position: fixed` anchored to the POPOVER, not the viewport, because
  //     PopoverContent carries `backdrop-blur-md` and a backdrop-filter makes an
  //     element the containing block for fixed children — the menu then landed
  //     far off-screen and the picker appeared dead.
  // A wrapper with `display: contents` dissolves into the row's flex layout, so
  // the picker sits in its cell and the menu — `flex: 0 0 100%` — wraps onto its
  // own full-width line beneath. Nothing to clip, nothing to re-anchor.
  return jsxs('div', {
    ref: boxRef,
    className: 'hermes-sb-when',
    onKeyDown,
    children: [
      jsx('button', {
        type: 'button',
        className: 'hermes-sb-picker',
        'data-open': open,
        'data-bound': boundTriggers.length > 0,
        'aria-haspopup': 'listbox',
        'aria-expanded': open,
        'aria-label': `${t('when')}: ${sound.name}`,
        title: detail,
        onClick: () => {
          haptic('tap')
          setOpen(value => !value)
        },
        children: [
          jsx('span', { className: 'hermes-sb-picker-label', children: summary }),
          jsx('span', { className: 'hermes-sb-picker-caret', 'aria-hidden': true })
        ]
      }),

      open
        ? jsx('div', {
            className: 'hermes-sb-menu',
            ref: menuRef,
            role: 'listbox',
            'aria-multiselectable': 'true',
            'aria-label': t('when'),
            children: [
              ...TRIGGER_GROUPS.map(group =>
                jsxs(
                  'div',
                  {
                    className: 'hermes-sb-menu-group',
                    children: [
                      jsx('div', { className: 'hermes-sb-menu-heading', children: group }),
                      ...TRIGGERS.filter(trigger => trigger.group === group).map(trigger => {
                        const on = boundIds.includes(trigger.id)
                        rowIndex += 1
                        const at = rowIndex

                        return jsx(
                          'button',
                          {
                            type: 'button',
                            className: 'hermes-sb-menu-row',
                            'data-selected': on,
                            'data-cursor': cursor === at,
                            // role/state that a screen reader can follow as the
                            // list stays open across toggles.
                            role: 'option',
                            'aria-selected': on,
                            title: trigger.detail,
                            onClick: () => {
                              haptic('tap')
                              engine.toggleTrigger(sound.id, trigger.id)
                            },
                            onMouseEnter: () => setCursor(at),
                            children: [
                              jsx('span', { className: 'hermes-sb-menu-check', 'aria-hidden': true, children: on ? '✓' : '' }),
                              jsx('span', { className: 'hermes-sb-menu-text', children: trigger.label })
                            ]
                          },
                          trigger.id
                        )
                      })
                    ]
                  },
                  group
                )
              ),
              boundIds.length
                ? jsx('button', {
                    type: 'button',
                    className: 'hermes-sb-menu-clear',
                    onClick: () => {
                      engine.clearTriggers(sound.id)
                      setOpen(false)
                    },
                    children: t('whenClear')
                  }, '__clear')
                : null
            ]
          })
        : null
    ]
  })
}

function ManageRow({ sound, engine, index = 0 }) {
  const t = usePluginI18n(ID)
  const [draft, setDraft] = useState(sound.name)
  // Trimming is destructive, so it opens on demand rather than sitting in every
  // row's tab order — and is only offered for clips, never for a synthesised cue.
  const [trimOpen, setTrimOpen] = useState(false)
  const [trimStart, setTrimStart] = useState('')
  const [trimLength, setTrimLength] = useState('')
  const [trimBusy, setTrimBusy] = useState(false)
  const [trimError, setTrimError] = useState('')
  const [trimCopy, setTrimCopy] = useState(true)

  const doTrim = async () => {
    if (trimBusy) return
    setTrimBusy(true)
    setTrimError('')
    try {
      const target = trimCopy ? await engine.duplicate(sound.id) : null
      const id = target?.id ?? sound.id
      await engine.trimSound(id, {
        start: trimStart.trim() ? Number(trimStart) : 0,
        length: trimLength.trim() ? Number(trimLength) : null
      })
      setTrimOpen(false)
      setTrimStart('')
      setTrimLength('')
      engine.notify({ kind: 'info', message: t('trimDone') })
    } catch (error) {
      setTrimError(error instanceof Error ? error.message : String(error))
    } finally {
      setTrimBusy(false)
    }
  }

  useEffect(() => {
    setDraft(sound.name)
  }, [sound.name])

  const commit = () => {
    if (draft.trim() && draft.trim() !== sound.name) engine.rename(sound.id, draft)
    else setDraft(sound.name)
  }

  return jsxs('div', {
    className: 'hermes-sb-row',
    'data-bound': Boolean(sound.triggers?.length),
    children: [
      jsx(Tip, {
        label: t('preview'),
        children: jsx('button', {
          type: 'button',
          className: 'hermes-sb-rowbtn',
          'aria-label': `${t('preview')}: ${sound.name}`,
          onClick: () => engine.play(sound),
          children: jsx(icons.Play, { size: 11 })
        })
      }),
      jsx(TriggerSelect, { sound, engine }),
      jsx(Input, {
        className: 'hermes-sb-row-name',
        size: 'xs',
        value: draft,
        'aria-label': t('name'),
        spellCheck: false,
        onChange: event => setDraft(event.target.value),
        onBlur: commit,
        onKeyDown: event => {
          if (event.key === 'Enter') {
            event.preventDefault()
            commit()
            event.currentTarget.blur()
          } else if (event.key === 'Escape') {
            setDraft(sound.name)
            event.currentTarget.blur()
          }
        }
      }),
      // Per-pad trim. Steps by 25% so a full 0-200% range is reachable with
      // four clicks of the arrows; the value reads at a glance without a
      // popover. Blank input means 100%.
      jsx('div', {
        className: 'hermes-sb-gain',
        children: [
          jsx('button', {
            type: 'button',
            className: 'hermes-sb-gain-step',
            'aria-label': `${t('gainDown')}: ${sound.name}`,
            onClick: () => engine.setGain(sound.id, (sound.gain ?? 100) - 25),
            children: '−'
          }),
          jsx('span', {
            className: 'hermes-sb-gain-value',
            'data-off': sound.gain !== undefined && sound.gain !== 100,
            title: t('gainHint'),
            children: `${sound.gain ?? 100}%`
          }),
          jsx('button', {
            type: 'button',
            className: 'hermes-sb-gain-step',
            'aria-label': `${t('gainUp')}: ${sound.name}`,
            onClick: () => engine.setGain(sound.id, (sound.gain ?? 100) + 25),
            children: '+'
          })
        ]
      }),
      jsx('div', {
        className: 'hermes-sb-reorder',
        children: [
          jsx('button', {
            type: 'button',
            className: 'hermes-sb-gain-step',
            'aria-label': `${t('moveUp')}: ${sound.name}`,
            'data-move': 'up',
            onClick: () => engine.move(sound.id, index - 1),
            children: '↑'
          }),
          jsx('button', {
            type: 'button',
            className: 'hermes-sb-gain-step',
            'aria-label': `${t('moveDown')}: ${sound.name}`,
            'data-move': 'down',
            onClick: () => engine.move(sound.id, index + 1),
            children: '↓'
          })
        ]
      }),
      sound.kind === 'file'
        ? jsx(Tip, {
            label: t('trim'),
            children: jsx('button', {
              type: 'button',
              className: 'hermes-sb-rowbtn',
              'data-trim': 'true',
              'data-on': trimOpen,
              'aria-expanded': trimOpen,
              'aria-label': `${t('trim')}: ${sound.name}`,
              onClick: () => {
                setTrimOpen(value => !value)
                setTrimError('')
              },
              children: jsx(icons.Clock, { size: 11 })
            })
          })
        : null,
      jsx(Tip, {
        label: `${t('delete')}: ${sound.name}`,
        children: jsx('button', {
          type: 'button',
          className: 'hermes-sb-rowbtn',
          'data-destructive': 'true',
          'aria-label': `${t('delete')}: ${sound.name}`,
          onClick: () => engine.remove(sound.id),
          children: jsx(icons.Trash2, { size: 11 })
        })
      }),
      trimOpen
        ? jsxs('div', {
            className: 'hermes-sb-trim',
            children: [
              jsx('label', {
                className: 'hermes-sb-trim-field',
                children: [
                  jsx('span', { className: 'hermes-sb-trim-label', children: t('ytStart') }),
                  jsx('input', {
                    type: 'number', min: '0', step: '0.1', placeholder: '0',
                    className: 'hermes-sb-trim-input', value: trimStart,
                    disabled: trimBusy, 'aria-label': t('ytStart'),
                    onChange: event => setTrimStart(event.target.value)
                  })
                ]
              }),
              jsx('label', {
                className: 'hermes-sb-trim-field',
                children: [
                  jsx('span', { className: 'hermes-sb-trim-label', children: t('ytLength') }),
                  jsx('input', {
                    type: 'number', min: '0.2', step: '0.1', placeholder: 'all',
                    className: 'hermes-sb-trim-input', value: trimLength,
                    disabled: trimBusy, 'aria-label': t('ytLength'),
                    onChange: event => setTrimLength(event.target.value)
                  })
                ]
              }),
              jsx('label', {
                className: 'hermes-sb-trim-copy',
                title: t('trimCopyHint'),
                children: [
                  jsx('input', {
                    type: 'checkbox', checked: trimCopy, disabled: trimBusy,
                    onChange: event => setTrimCopy(event.target.checked)
                  }),
                  jsx('span', { children: t('trimCopy') })
                ]
              }),
              jsx('button', {
                type: 'button',
                className: 'hermes-sb-trim-go',
                disabled: trimBusy || (!trimStart.trim() && !trimLength.trim()),
                onClick: () => void doTrim(),
                children: trimBusy ? t('ytWorking') : t('trimApply')
              })
            ]
          })
        : null,
      trimError ? jsx('div', { className: 'hermes-sb-trim-error', children: trimError }) : null
    ]
  }, sound.id)
}

// ── setup export / import ─────────────────────────────────────────────────
// The board is one file: pads, gains, bindings and the settings that shape the
// panel. That is what makes a setup shareable — one attachment, no folder of
// loose mp3s to keep beside it.

/** A setup failure is either a localised ImportError (already a sentence) or
 *  something unexpected. Either way the user gets words, never a bare code. */
function describeSetupError(error, t) {
  const code = error?.code
  if (code === 'notJson') return t('importNotJson')
  if (code === 'notBundle') return t('importNotBundle')
  if (code === 'newer') return t('importNewer', error?.details?.version ?? '?')
  if (code === 'empty') return t('importEmpty')
  if (code === 'tooBig') return t('importTooBig')
  if (code === 'unreadable') return t('importUnreadable')
  if (code === 'noFile') return t('importUnreadable')
  if (code === 'noFileAccess') return t('noFileAccess')
  if (code === 'saveFailed') return t('exportFailed')
  if (code === 'noSession') return t('ytNoSession')

  return error instanceof Error && error.message && error.message !== code
    ? error.message
    : t('setupFailed')
}

function SetupBar({ engine, page = false }) {
  const t = usePluginI18n(ID)
  const sounds = useValue(engine.sounds)
  const [plan, setPlan] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [withSettings, setWithSettings] = useState(true)
  const [mode, setMode] = useState('add')
  const fileRef = useRef(null)

  const run = async action => {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      await action()
    } catch (failure) {
      const message = describeSetupError(failure, t)
      setError(message)
      // Also a toast: exporting usually closes the panel on the way out.
      engine.notify({ kind: 'error', message })
    } finally {
      setBusy(false)
    }
  }

  const doExport = () =>
    run(async () => {
      const result = await engine.exportBundle()
      // Two doors, two honest sentences: the download path leaves the save
      // decision with the user (they can still cancel that dialog), while the
      // folder path has already written the file and can name it.
      const message = result.savedTo === 'folder'
        ? t('exportedTo', result.path || result.fileName)
        : t('exportedAsk', result.fileName)
      const warning = result.missing.length ? ` ${t('exportMissing', result.missing.length, result.missing.join(', '))}` : ''
      engine.notify({ kind: result.missing.length ? 'warning' : 'info', message: `${message}${warning}` })
    })

  const takeSetup = file => {
    if (!file) return
    void run(async () => {
      const found = await engine.readSetupFile(file)
      setPlan(found)
      setWithSettings(Boolean(found.settings))
      setMode('add')
    })
  }

  const doImport = () =>
    run(async () => {
      const result = await engine.applyBundle(plan, {
        includeSettings: withSettings && Boolean(plan.settings),
        mode
      })
      setPlan(null)
      const parts = [t('imported', result.added)]
      if (result.removed) parts.push(t('importReplaced', result.removed))
      // A pad the file carried but this board could not take is reported AFTER
      // the fact too: the plan is gone by then, and "1 pad added" out of a file
      // that held two is a silent loss without this line.
      if (plan.skippedNoAudio) parts.push(t('importNoAudio', plan.skippedNoAudio))
      if (result.skipped) parts.push(t('importWriteFailed', result.skipped))
      if (result.refused) parts.push(t('importRefused', result.refused))
      const kind = result.skipped || result.refused || plan.skippedNoAudio || !result.added ? 'warning' : 'info'
      engine.notify({ kind, message: parts.join(' ') })
    })

  const startingNow = plan ? plan.taken : sounds.length
  const room = Math.max(0, MAX_SOUNDS - startingNow)
  const fits = mode === 'replace' ? plan?.entries.length ?? 0 : Math.min(room, plan?.entries.length ?? 0)
  const overflow = (plan?.entries.length ?? 0) - fits

  return jsxs('div', {
    className: 'hermes-sb-setup',
    'data-page': page ? 'true' : undefined,
    children: [
      jsxs('div', {
        className: 'hermes-sb-setup-row',
        children: [
          jsx('span', { className: 'hermes-sb-setup-title', children: t('setup') }),
          jsx('span', { className: 'hermes-sb-setup-spacer' }),
          jsx('button', {
            type: 'button',
            className: 'hermes-sb-setup-btn',
            'aria-label': t('exportSetup'),
            title: t('exportHint'),
            disabled: busy,
            onClick: () => void doExport(),
            children: [
              jsx(icons.Upload, { size: 10, 'aria-hidden': true }),
              jsx('span', { children: busy ? t('working') : t('exportSetup') })
            ]
          }),
          jsx('button', {
            type: 'button',
            className: 'hermes-sb-setup-btn',
            'aria-label': t('importSetup'),
            title: t('importHint'),
            disabled: busy,
            onClick: () => fileRef.current?.click(),
            children: [
              jsx(icons.Download, { size: 10, 'aria-hidden': true }),
              jsx('span', { children: t('importSetup') })
            ]
          })
        ]
      }),
      jsx('input', {
        ref: fileRef,
        type: 'file',
        accept: 'application/json,.json',
        style: { display: 'none' },
        'aria-label': t('importSetup'),
        onChange: event => {
          // `input.files` is LIVE: snapshot before clearing `value`, or picking
          // the same setup twice never fires `change`.
          const [file] = [...event.target.files]
          event.target.value = ''
          takeSetup(file)
        }
      }),
      plan
        ? jsxs('div', {
            className: 'hermes-sb-setup-plan',
            role: 'group',
            'aria-label': t('importSetup'),
            children: [
              jsx('div', {
                className: 'hermes-sb-setup-plan-title',
                children: t('importPlan', plan.fileName || t('thisFile'), plan.total)
              }),
              // Where the pads go. ADD is the safe default and is preselected;
              // REPLACE has to be chosen on purpose, and says what it costs.
              jsxs('div', {
                className: 'hermes-sb-setup-modes',
                role: 'radiogroup',
                'aria-label': t('importMode'),
                children: [
                  jsx('button', {
                    type: 'button',
                    role: 'radio',
                    'aria-checked': mode === 'add',
                    'data-selected': mode === 'add',
                    className: 'hermes-sb-setup-mode',
                    disabled: busy,
                    onClick: () => setMode('add'),
                    children: t('importModeAdd', sounds.length)
                  }),
                  jsx('button', {
                    type: 'button',
                    role: 'radio',
                    'aria-checked': mode === 'replace',
                    'data-selected': mode === 'replace',
                    'data-destructive': 'true',
                    className: 'hermes-sb-setup-mode',
                    disabled: busy,
                    onClick: () => setMode('replace'),
                    children: t('importModeReplace', sounds.length)
                  })
                ]
              }),
              overflow > 0
                ? jsx('div', {
                    className: 'hermes-sb-setup-plan-warn',
                    children: t('importOverflow', overflow, MAX_SOUNDS)
                  })
                : null,
              plan.skippedNoAudio > 0
                ? jsx('div', {
                    className: 'hermes-sb-setup-plan-warn',
                    children: t('importNoAudio', plan.skippedNoAudio)
                  })
                : null,
              plan.settings
                ? jsxs('label', {
                    className: 'hermes-sb-setup-check',
                    children: [
                      jsx('input', {
                        type: 'checkbox',
                        checked: withSettings,
                        disabled: busy,
                        onChange: event => setWithSettings(event.target.checked)
                      }),
                      jsx('span', { children: t('importSettings', plan.settings.volume, plan.settings.padsPerRow) })
                    ]
                  })
                : null,
              jsxs('div', {
                className: 'hermes-sb-setup-confirm',
                children: [
                  jsx('button', {
                    type: 'button',
                    className: 'hermes-sb-setup-btn',
                    'data-primary': 'true',
                    disabled: busy || !fits,
                    onClick: () => void doImport(),
                    children: t('importAdd', fits)
                  }),
                  jsx('button', {
                    type: 'button',
                    className: 'hermes-sb-setup-btn',
                    disabled: busy,
                    onClick: () => {
                      setPlan(null)
                      setError('')
                    },
                    children: t('cancel')
                  })
                ]
              })
            ]
          })
        : null,
      error ? jsx('div', { className: 'hermes-sb-setup-error', role: 'alert', children: error }) : null,
      !plan && !error
        ? jsx('div', {
            className: 'hermes-sb-setup-note',
            children: t('setupHint')
          })
        : null
    ]
  })
}

function Panel({ engine }) {
  const t = usePluginI18n(ID)
  const sounds = useValue(engine.sounds)
  const settings = useValue(engine.settings)
  const saving = useValue(engine.saving)
  const last = useValue(engine.lastTrigger)
  const ytJob = useValue(engine.ytJob)
  const [manage, setManage] = useState(false)
  const [dragging, setDragging] = useState(false)
  // Which pad is being dragged, and which gap it would drop into.
  const [dragId, setDragId] = useState(null)
  const [dragIndex, setDragIndex] = useState(null)
  // YouTube import: the field is behind a button, the job is fire-and-watch.
  const [ytOpen, setYtOpen] = useState(false)
  const [ytUrl, setYtUrl] = useState('')
  const [ytBusy, setYtBusy] = useState(false)
  // Optional trim window. Blank start = from the beginning; blank length = the
  // whole (already capped) clip.
  const [ytStart, setYtStart] = useState('')
  const [ytLength, setYtLength] = useState('')
  const [ytError, setYtError] = useState('')
  const panelRef = useRef(null)
  const fileRef = useRef(null)

  useEffect(() => {
    panelRef.current?.focus()
  }, [])

  const take = useCallback(
    async files => {
      // Snapshot immediately: a FileList handed over from an <input> can be
      // emptied by the caller resetting it, and `await` gives that a chance.
      const list = [...(files || [])]
      for (const file of list.slice(0, 8)) await engine.addFile(file)
    },
    [engine]
  )

  const importFromYoutube = useCallback(async () => {
    const value = ytUrl.trim()
    if (!value || ytBusy) return
    setYtBusy(true)
    setYtError('')
    try {
      const sound = await engine.importYoutube(value, {
        start: ytStart.trim() ? Number(ytStart) : 0,
        length: ytLength.trim() ? Number(ytLength) : null
      })
      setYtUrl('')
      setYtStart('')
      setYtLength('')
      setYtOpen(false)
      // The toast goes through the engine: `ctx` is only in scope inside
      // register(), and reaching for it from the panel threw a ReferenceError
      // AFTER the pad had already been added — so the import worked but the
      // user saw an error.
      engine.notify({ kind: 'info', message: t('ytAdded').replace('{name}', sound.name) })
    } catch (error) {
      // The engine throws localised ImportErrors; anything else is shown raw.
      const message = error instanceof Error ? error.message : String(error)
      setYtError(message)
      // Also as a toast: the panel may be shut by then, and a conversion that
      // failed silently is the thing this whole path exists to avoid.
      engine.notify({ kind: 'error', message: `${t('ytFailed')} ${message}` })
    } finally {
      setYtBusy(false)
    }
  }, [engine, ytUrl, ytBusy, t])

  const onKeyDown = event => {
    if (event.key === 'Escape') {
      // Escape closes the import row before it closes the whole panel —
      // otherwise typing a URL and changing your mind shuts everything.
      if (ytOpen) {
        setYtOpen(false)
        setYtError('')
        return
      }
      engine.open.set(false)
      return
    }
    if (manage || event.metaKey || event.ctrlKey || event.altKey) return
    const index = Number(event.key)
    if (!Number.isInteger(index) || index < 1 || index > 9) return
    const sound = sounds[index - 1]
    if (!sound) return
    event.preventDefault()
    engine.play(sound)
  }

  const presentSynths = new Set(sounds.filter(sound => sound.kind === 'synth').map(sound => sound.synth))
  const missing = SYNTHS.filter(synth => !presentSynths.has(synth.id))
  const volume = settings.volume

  return jsxs('div', {
    ref: panelRef,
    tabIndex: -1,
    className: 'hermes-sb-body',
    role: 'group',
    'aria-label': t('title'),
    onKeyDown,
    onDragOver: event => {
      if (!Array.from(event.dataTransfer?.types || []).includes('Files')) return
      event.preventDefault()
      setDragging(true)
    },
    onDragLeave: event => {
      if (event.currentTarget.contains(event.relatedTarget)) return
      setDragging(false)
    },
    onDrop: event => {
      event.preventDefault()
      setDragging(false)
      if (event.dataTransfer?.files?.length) void take(event.dataTransfer.files)
    },
    children: [
      jsxs('div', {
        className: 'hermes-sb-head',
        children: [
          jsx('span', { className: 'hermes-sb-head-title', children: t('title') }),
          jsx(ProfilePicker, { engine }),
          jsx('span', { className: 'hermes-sb-head-gap', 'aria-hidden': 'true' }),
          jsx(Tip, {
            label: t('stopAll'),
            children: jsx('button', {
              type: 'button',
              className: 'hermes-sb-iconbtn',
              'aria-label': t('stopAll'),
              onClick: () => engine.stopAll(),
              children: jsx(icons.StopFilled, { size: 11 })
            })
          }),
          jsx(Tip, {
            label: t('addSound'),
            children: jsx('button', {
              type: 'button',
              className: 'hermes-sb-iconbtn',
              'aria-label': t('addSound'),
              disabled: saving,
              onClick: () => fileRef.current?.click(),
              children: saving ? jsx(icons.Loader2, { size: 11 }) : jsx(icons.Plus, { size: 12 })
            })
          }),
          jsx(Tip, {
            label: t('ytOpen'),
            children: jsx('button', {
              type: 'button',
              className: 'hermes-sb-iconbtn',
              'data-on': ytOpen,
              'aria-expanded': ytOpen,
              'aria-label': t('ytOpen'),
              onClick: () => {
                haptic('tap')
                setYtOpen(value => !value)
              },
              children: jsx(icons.Link, { size: 11 })
            })
          }),
          jsx(Tip, {
            label: manage ? t('done') : t('manage'),
            children: jsx('button', {
              type: 'button',
              className: 'hermes-sb-iconbtn',
              'data-on': manage,
              'aria-pressed': manage,
              'aria-label': manage ? t('done') : t('manage'),
              onClick: () => setManage(value => !value),
              children: jsx(icons.Pencil, { size: 11 })
            })
          })
        ]
      }),

      jsx('input', {
        ref: fileRef,
        type: 'file',
        accept: 'audio/*',
        multiple: true,
        style: { display: 'none' },
        onChange: event => {
          // `input.files` is a LIVE FileList: clearing `value` (which is what
          // makes the same file pickable twice) empties it. Snapshot the files
          // into a real array first, or nothing is ever added.
          const files = [...event.target.files]
          event.target.value = ''
          void take(files)
        }
      }),

      ytOpen
        ? jsxs('div', {
            className: 'hermes-sb-yt',
            children: [
              jsx('input', {
                type: 'text',
                className: 'hermes-sb-yt-input',
                // Not type=url: yt-dlp accepts ids and short links, and a
                // browser URL validator would refuse both.
                placeholder: t('ytPlaceholder'),
                value: ytUrl,
                autoFocus: true,
                spellCheck: false,
                disabled: ytBusy,
                'aria-label': t('ytPlaceholder'),
                onChange: event => setYtUrl(event.target.value),
                onKeyDown: event => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    void importFromYoutube()
                  }
                }
              }),
              jsx('button', {
                type: 'button',
                className: 'hermes-sb-yt-go',
                'aria-label': t('ytImport'),
                disabled: ytBusy || !ytUrl.trim(),
                onClick: () => void importFromYoutube(),
                children: ytBusy
                  ? jsx(icons.Loader2, { size: 11 })
                  : jsx(icons.Download, { size: 11 })
              })
            ]
          })
        : null,

      ytOpen
        ? jsxs('div', {
            className: 'hermes-sb-yt-trim',
            children: [
              jsx('label', {
                className: 'hermes-sb-yt-trim-field',
                children: [
                  jsx('span', { className: 'hermes-sb-yt-trim-label', children: t('ytStart') }),
                  jsx('input', {
                    type: 'number',
                    min: '0',
                    step: '0.1',
                    className: 'hermes-sb-yt-trim-input',
                    placeholder: '0',
                    value: ytStart,
                    disabled: ytBusy,
                    'aria-label': t('ytStart'),
                    onChange: event => setYtStart(event.target.value)
                  })
                ]
              }),
              jsx('label', {
                className: 'hermes-sb-yt-trim-field',
                children: [
                  jsx('span', { className: 'hermes-sb-yt-trim-label', children: t('ytLength') }),
                  jsx('input', {
                    type: 'number',
                    min: '0.2',
                    step: '0.1',
                    max: '30',
                    className: 'hermes-sb-yt-trim-input',
                    placeholder: 'all',
                    value: ytLength,
                    disabled: ytBusy,
                    'aria-label': t('ytLength'),
                    onChange: event => setYtLength(event.target.value)
                  })
                ]
              }),
              jsx('span', { className: 'hermes-sb-yt-trim-hint', children: t('ytTrimHint') })
            ]
          })
        : null,

      ytBusy
        ? jsxs('div', {
            className: 'hermes-sb-yt-progress',
            role: 'progressbar',
            'aria-valuemin': 0,
            'aria-valuemax': 100,
            'aria-valuenow': ytJob?.percent ?? 0,
            'aria-label': t('ytWorking'),
            children: [
              jsx('div', { className: 'hermes-sb-yt-bar', children: jsx('div', {
                className: 'hermes-sb-yt-bar-fill',
                style: { width: `${Math.max(4, ytJob?.percent ?? 0)}%` }
              }) }),
              jsx('span', {
                className: 'hermes-sb-yt-pct',
                children: ytJob?.percent ? `${ytJob.percent}%` : t('ytWorking')
              })
            ]
          })
        : null,
      ytError ? jsx('div', { className: 'hermes-sb-yt-note', 'data-error': 'true', children: ytError }) : null,

      manage
        ? jsxs('div', {
            children: [
              sounds.length
                ? jsx('div', { className: 'hermes-sb-list', children: sounds.map((sound, i) => jsx(ManageRow, { sound, engine, index: i }, sound.id)) })
                : jsx('div', { className: 'hermes-sb-empty', children: t('empty') }),
              missing.length
                ? jsxs('div', {
                    children: [
                      jsx('div', { className: 'hermes-sb-section', children: t('builtins') }),
                      jsx('div', {
                        className: 'hermes-sb-presets',
                        children: missing.map(synth =>
                          jsx('button', {
                            type: 'button',
                            className: 'hermes-sb-preset',
                            onClick: () => engine.addPreset(synth.id),
                            children: synth.name
                          }, synth.id)
                        )
                      })
                    ]
                  })
                : null
            ]
          })
        : sounds.length
          ? jsx('div', {
              className: 'hermes-sb-grid',
              style: { gridTemplateColumns: `repeat(${settings.padsPerRow}, minmax(0, 1fr))` },
              children: [
                ...sounds.slice(0, 24).map((sound, index) =>
                  jsx(
                    Pad,
                    {
                      sound,
                      index,
                      engine,
                      dragging: dragId,
                      dragTarget: dragIndex,
                      onDragStart: id => {
                        setDragId(id)
                        setDragIndex(index)
                      },
                      onDragOver: target => setDragIndex(target),
                      onDrop: target => {
                        // Dropping ON a pad means "take that pad's place"; the
                        // engine clamps and reorders from the id, so the index
                        // is all it needs.
                        if (dragId) engine.move(dragId, target)
                        setDragId(null)
                        setDragIndex(null)
                      },
                      onDragEnd: () => {
                        setDragId(null)
                        setDragIndex(null)
                      }
                    },
                    sound.id
                  )
                ),
                // The insertion point lives where the list ends, and it fills
                // the short last row a 7-pad board would otherwise leave empty.
                sounds.length < MAX_SOUNDS
                  ? jsx('button', {
                      type: 'button',
                      className: 'hermes-sb-pad hermes-sb-add',
                      title: t('addSound'),
                      'aria-label': t('addSound'),
                      disabled: saving,
                      onClick: () => fileRef.current?.click(),
                      children: jsx(icons.Plus, { size: 13, 'aria-hidden': true })
                    }, 'add')
                  : null
              ]
            })
          : jsxs('div', {
              className: 'hermes-sb-empty',
              children: [
                jsx('div', { children: t('empty') }),
                jsx('button', {
                  type: 'button',
                  className: 'hermes-sb-preset',
                  style: { marginTop: '8px' },
                  onClick: () => engine.restorePresets(),
                  children: t('restore')
                })
              ]
            }),

      jsxs('div', {
        className: 'hermes-sb-foot',
        children: [
          jsx('button', {
            type: 'button',
            className: 'hermes-sb-foot-icon',
            'aria-label': volume ? t('mute') : t('unmute'),
            title: volume ? t('mute') : t('unmute'),
            onClick: () => engine.setVolume(volume ? 0 : 80),
            children: jsx(volume ? icons.Volume2 : icons.VolumeX, { size: 11, 'aria-hidden': true })
          }),
          jsx('input', {
            type: 'range',
            min: 0,
            max: 100,
            step: 1,
            value: volume,
            'aria-label': t('volume'),
            onChange: event => engine.setVolume(Number(event.target.value))
          }),
          jsx('span', { className: 'hermes-sb-foot-value', children: `${volume}%` })
        ]
      }),

      // A binding firing while the panel happens to be open is otherwise
      // invisible: the pads are shut away behind the popover trigger.
      last && TRIGGER_BY_ID.has(last.id)
        ? jsx('div', {
            className: 'hermes-sb-last',
            role: 'status',
            children: t('lastTrigger', TRIGGER_BY_ID.get(last.id).label)
          })
        : null,

      jsx(SetupBar, { engine }),

      dragging ? jsx('div', { className: 'hermes-sb-drop', children: t('dropHere') }) : null
    ]
  })
}

function Chip({ engine }) {
  const t = usePluginI18n(ID)
  const open = useValue(engine.open)
  const settings = useValue(engine.settings)

  return jsx('div', {
    className: 'hermes-sb-bar',
    children: jsx(Popover, {
      open,
      onOpenChange: value => engine.open.set(value),
      children: [
        jsx(PopoverTrigger, {
          asChild: true,
          children: jsx(Button, {
            variant: 'ghost',
            size: 'micro',
            className: 'hermes-sb-chip',
            'data-open': open,
            'aria-label': t('open'),
            title: t('open'),
            onPointerDown: () => haptic('tap'),
            children: [
              jsx(icons.AudioLines, { size: 12, 'aria-hidden': true }),
              settings.showLabel ? jsx('span', { className: 'hermes-sb-chip-label', children: 'Soundboard' }) : null
            ]
          })
        }),
        jsx(PopoverContent, {
          side: 'top',
          align: 'end',
          className: 'hermes-sb-panel',
          'aria-label': t('title'),
          children: jsx(Panel, { engine })
        })
      ]
    })
  })
}

/** The profile switcher. Lives in the popover header because that is the
 *  "on the go" surface: you change board mid-conversation, not mid-settings.
 *  Deliberately a button + in-DOM list, same reason as the trigger picker — a
 *  native <select> popup is drawn by the OS and cannot be styled or captured. */
function ProfilePicker({ engine }) {
  const t = usePluginI18n(ID)
  const profiles = useValue(engine.profiles)
  const activeId = useValue(engine.activeProfile)
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const boxRef = useRef(null)
  const active = profiles.find(profile => profile.id === activeId)

  useEffect(() => {
    if (!open) return
    const onDown = event => {
      if (boxRef.current && !boxRef.current.contains(event.target)) setOpen(false)
    }
    const onKey = event => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey, true)

    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [open])

  const choose = id => {
    engine.applyProfile(id)
    setOpen(false)
  }

  const save = () => {
    const wanted = draft.trim() || active?.name || t('newProfile')
    // Naming an existing profile replaces it, so say that rather than "saved" —
    // the user needs to know a saved board was just overwritten.
    const replaced = profiles.find(profile => profile.name.toLowerCase() === wanted.toLowerCase())
    engine.saveProfile(wanted)
    setDraft('')
    engine.notify({
      kind: 'info',
      message: replaced ? t('profileOverwritten').replace('{name}', replaced.name) : t('profileSaved')
    })
  }

  return jsxs('div', {
    className: 'hermes-sb-profile',
    ref: boxRef,
    children: [
      jsxs('button', {
        type: 'button',
        className: 'hermes-sb-profile-btn',
        'aria-haspopup': 'listbox',
        'aria-expanded': open,
        'data-on': Boolean(active),
        onClick: () => setOpen(value => !value),
        children: [
          jsx('span', { className: 'hermes-sb-profile-name', children: active ? active.name : t('noProfile') }),
          jsx('span', { className: 'hermes-sb-profile-caret', 'aria-hidden': 'true', children: '▾' })
        ]
      }),

      open
        ? jsxs('div', {
            className: 'hermes-sb-profile-menu',
            role: 'listbox',
            'aria-label': t('profiles'),
            children: [
              profiles.length
                ? profiles.map(profile =>
                    jsxs('button', {
                      key: profile.id,
                      type: 'button',
                      role: 'option',
                      'aria-selected': profile.id === activeId,
                      className: 'hermes-sb-profile-item',
                      onClick: () => choose(profile.id),
                      children: [
                        jsx('span', { className: 'hermes-sb-profile-item-name', children: profile.name }),
                        jsx('span', {
                          className: 'hermes-sb-profile-item-meta',
                          children: t('padCount', profile.sounds.length)
                        }),
                        jsx('span', {
                          className: 'hermes-sb-profile-tick',
                          'aria-hidden': profile.id === activeId ? 'false' : 'true',
                          children: profile.id === activeId ? '✓' : ''
                        })
                      ]
                    }, profile.id)
                  )
                : jsx('div', { className: 'hermes-sb-profile-empty', children: t('noProfilesYet') }),

              jsxs('div', {
                className: 'hermes-sb-profile-save',
                children: [
                  jsx('input', {
                    type: 'text',
                    className: 'hermes-sb-profile-input',
                    placeholder: active ? t('saveOver') : t('profileName'),
                    value: draft,
                    'aria-label': t('profileName'),
                    onChange: event => setDraft(event.target.value),
                    onKeyDown: event => {
                      if (event.key === 'Enter') {
                        event.preventDefault()
                        save()
                      }
                    }
                  }),
                  jsx('button', {
                    type: 'button',
                    className: 'hermes-sb-profile-savebtn',
                    'aria-label': active ? t('saveToProfile') : t('saveProfile'),
                    title: active ? t('saveToProfile') : t('saveProfile'),
                    onClick: save,
                    children: profiles.some(
                      profile => profile.name.toLowerCase() === draft.trim().toLowerCase()
                    ) ? t('overwrite') : t('saveShort')
                  })
                ]
              })
            ]
          })
        : null
    ]
  })
}

/** Settings-page profile list: pick, rename, delete, and save the current
 *  board. The popover switcher covers "choose on the go"; this covers editing
 *  the set of profiles, which needs a text field per row. */
function ProfileManager({ engine }) {
  const t = usePluginI18n(ID)
  const profiles = useValue(engine.profiles)
  const activeId = useValue(engine.activeProfile)
  const [draft, setDraft] = useState('')
  // Which profile's Overwrite button is armed. One click arms, the second
  // replaces: overwriting a saved board is destructive and must not be a slip.
  const [armed, setArmed] = useState(null)

  return jsxs('div', {
    style: { display: 'flex', flexDirection: 'column', gap: '6px' },
    children: [
      jsx('div', { className: 'hermes-sb-profile-rows', children: profiles.length
        ? profiles.map(profile =>
            jsxs('div', {
              key: profile.id,
              className: 'hermes-sb-profile-row',
              'data-active': profile.id === activeId,
              children: [
                jsx('button', {
                  type: 'button',
                  className: 'hermes-sb-profile-use',
                  disabled: profile.id === activeId,
                  'data-use': profile.id,
                  onClick: () => engine.applyProfile(profile.id),
                  children: profile.id === activeId ? t('activeProfile') : t('useProfile')
                }),
                jsx('input', {
                  type: 'text',
                  className: 'hermes-sb-profile-rename',
                  defaultValue: profile.name,
                  'aria-label': `${t('renameProfile')}: ${profile.name}`,
                  onBlur: event => {
                    const value = event.target.value.trim()
                    if (value && value !== profile.name) engine.renameProfile(profile.id, value)
                  },
                  onKeyDown: event => {
                    if (event.key === 'Enter') event.target.blur()
                  }
                }),
                jsx('span', {
                  className: 'hermes-sb-profile-count',
                  children: t('padCount', profile.sounds.length)
                }),
                // Overwrite: replaces this saved board with the live one, so a
                // tweaked setup updates the profile instead of adding another.
                jsx('button', {
                  type: 'button',
                  className: 'hermes-sb-profile-overwrite',
                  'data-overwrite': profile.id,
                  'data-armed': armed === profile.id,
                  'aria-label': `${t('overwriteProfile')}: ${profile.name}`,
                  onClick: () => {
                    if (armed !== profile.id) {
                      setArmed(profile.id)

                      return
                    }
                    setArmed(null)
                    engine.overwriteProfile(profile.id)
                    engine.notify({
                      kind: 'info',
                      message: t('profileOverwritten').replace('{name}', profile.name)
                    })
                  },
                  children: armed === profile.id ? t('overwriteConfirm') : t('overwrite')
                }),
                jsx('button', {
                  type: 'button',
                  className: 'hermes-sb-rowbtn hermes-sb-profile-delete',
                  'data-destructive': 'true',
                  'data-delete': profile.id,
                  'aria-label': `${t('deleteProfile')}: ${profile.name}`,
                  onClick: () => {
                    engine.deleteProfile(profile.id)
                    engine.notify({ kind: 'info', message: t('profileDeleted').replace('{name}', profile.name) })
                  },
                  children: jsx(icons.Trash2, { size: 11 })
                })
              ]
            }, profile.id)
          )
        : jsx('div', { className: 'hermes-sb-profile-empty', children: t('noProfilesYet') })
      }),

      jsxs('div', {
        style: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' },
        children: [
          jsx('input', {
            type: 'text',
            className: 'hermes-sb-profile-input',
            placeholder: activeId ? t('saveOver') : t('profileName'),
            value: draft,
            'aria-label': t('profileName'),
            onChange: event => setDraft(event.target.value),
            onKeyDown: event => {
              if (event.key === 'Enter') {
                event.preventDefault()
                engine.saveProfile(draft.trim() || t('newProfile'))
                setDraft('')
              }
            }
          }),
          jsx('button', {
            type: 'button',
            className: 'hermes-sb-settings-add',
            'data-save-profile': 'true',
            disabled: profiles.length >= MAX_PROFILES && !activeId,
            onClick: () => {
              engine.saveProfile(draft.trim() || t('newProfile'))
              setDraft('')
              engine.notify({ kind: 'info', message: t('profileSaved') })
            },
            children: activeId ? t('saveToProfile') : t('saveProfile')
          })
        ]
      })
    ]
  })
}

/** The full pad manager, for the Settings page.
 *
 * The panel is 308px wide and shows this only while "manage" is toggled; on a
 * settings page there is no such constraint and no reason to hide anything, so
 * this renders the same rows always-open, at full width, with the add controls
 * beside them. `ManageRow` is shared deliberately: two divergent editors for the
 * same data would drift the moment either gained a field.
 */
function SoundboardManager({ engine }) {
  const t = usePluginI18n(ID)
  const sounds = useValue(engine.sounds)
  const saving = useValue(engine.saving)
  const fileRef = useRef(null)
  const [ytOpen, setYtOpen] = useState(false)
  const [ytUrl, setYtUrl] = useState('')
  const [ytStart, setYtStart] = useState('')
  const [ytLength, setYtLength] = useState('')
  const [ytBusy, setYtBusy] = useState(false)
  const [ytError, setYtError] = useState('')
  const ytJob = useValue(engine.ytJob)

  const take = useCallback(
    async files => {
      // A FileList handed over from an <input> can be emptied by the caller
      // resetting it, and `await` gives that a chance — snapshot first.
      const list = [...(files || [])]
      for (const file of list.slice(0, 8)) await engine.addFile(file)
    },
    [engine]
  )

  const importFromYoutube = useCallback(async () => {
    if (!ytUrl.trim() || ytBusy) return
    setYtBusy(true)
    setYtError('')
    try {
      const sound = await engine.importYoutube(ytUrl.trim(), {
        start: ytStart.trim() ? Number(ytStart) : 0,
        length: ytLength.trim() ? Number(ytLength) : null
      })
      setYtUrl('')
      setYtStart('')
      setYtLength('')
      setYtOpen(false)
      engine.notify({ kind: 'info', message: t('ytAdded').replace('{name}', sound.name) })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setYtError(message)
      engine.notify({ kind: 'error', message: `${t('ytFailed')} ${message}` })
    } finally {
      setYtBusy(false)
    }
  }, [engine, ytUrl, ytStart, ytLength, ytBusy, t])

  const presentSynths = new Set(sounds.filter(sound => sound.kind === 'synth').map(sound => sound.synth))
  const missing = SYNTHS.filter(synth => !presentSynths.has(synth.id))

  return jsxs('div', {
    style: { display: 'flex', flexDirection: 'column', gap: '10px' },
    children: [
      jsxs('div', {
        style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
        children: [
          jsx('button', {
            type: 'button',
            className: 'hermes-sb-settings-add',
            disabled: saving || sounds.length >= MAX_SOUNDS,
            onClick: () => fileRef.current?.click(),
            children: saving ? t('saving') : t('addSound')
          }),
          jsx('button', {
            type: 'button',
            className: 'hermes-sb-settings-add',
            'data-on': ytOpen,
            'aria-expanded': ytOpen,
            onClick: () => setYtOpen(value => !value),
            children: t('ytOpen')
          }),
          jsx('span', {
            style: { fontSize: '11px', color: 'var(--ui-text-tertiary)' },
            children: t('stats', sounds.length, sounds.filter(sound => sound.kind === 'file').length)
          })
        ]
      }),

      jsx('input', {
        ref: fileRef,
        type: 'file',
        accept: 'audio/*',
        multiple: true,
        style: { display: 'none' },
        onChange: event => {
          const files = [...event.target.files]
          event.target.value = ''
          void take(files)
        }
      }),

      ytOpen
        ? jsxs('div', {
            className: 'hermes-sb-settings-yt',
            children: [
              jsx('input', {
                type: 'text',
                className: 'hermes-sb-yt-input',
                placeholder: t('ytPlaceholder'),
                value: ytUrl,
                spellCheck: false,
                disabled: ytBusy,
                'aria-label': t('ytPlaceholder'),
                onChange: event => setYtUrl(event.target.value),
                onKeyDown: event => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    void importFromYoutube()
                  }
                }
              }),
              jsx('input', {
                type: 'number', min: '0', step: '0.1', placeholder: t('ytStart'),
                className: 'hermes-sb-yt-trim-input', value: ytStart, disabled: ytBusy,
                'aria-label': t('ytStart'), onChange: event => setYtStart(event.target.value)
              }),
              jsx('input', {
                type: 'number', min: '0.2', step: '0.1', placeholder: t('ytLength'),
                className: 'hermes-sb-yt-trim-input', value: ytLength, disabled: ytBusy,
                'aria-label': t('ytLength'), onChange: event => setYtLength(event.target.value)
              }),
              jsx('button', {
                type: 'button',
                className: 'hermes-sb-settings-go',
                disabled: ytBusy || !ytUrl.trim(),
                onClick: () => void importFromYoutube(),
                children: ytBusy ? t('ytWorking') : t('ytImport')
              })
            ]
          })
        : null,

      ytBusy
        ? jsx('div', {
            className: 'hermes-sb-yt-progress',
            role: 'progressbar',
            'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': ytJob?.percent ?? 0,
            children: [
              jsx('div', { className: 'hermes-sb-yt-bar', children: jsx('div', {
                className: 'hermes-sb-yt-bar-fill',
                style: { width: `${Math.max(4, ytJob?.percent ?? 0)}%` }
              }) }),
              jsx('span', {
                className: 'hermes-sb-yt-pct',
                children: ytJob?.percent ? `${ytJob.percent}%` : t('ytWorking')
              })
            ]
          })
        : null,
      ytError ? jsx('div', { className: 'hermes-sb-yt-note', 'data-error': 'true', children: ytError }) : null,

      sounds.length
        ? jsx('div', { className: 'hermes-sb-settings-list', children: sounds.map((sound, i) => jsx(ManageRow, { sound, engine, index: i }, sound.id)) })
        : jsx('div', { className: 'hermes-sb-empty', children: t('empty') }),

      missing.length
        ? jsxs('div', {
            children: [
              jsx('div', { className: 'hermes-sb-section', children: t('builtins') }),
              jsx('div', {
                className: 'hermes-sb-presets',
                children: missing.map(synth =>
                  jsx('button', {
                    type: 'button',
                    className: 'hermes-sb-preset',
                    disabled: sounds.length >= MAX_SOUNDS,
                    onClick: () => engine.addPreset(synth.id),
                    children: synth.name
                  }, synth.id)
                )
              })
            ]
          })
        : null,
      // Drag to reorder is a pointer affordance; on a settings page a keyboard
      // path matters more, so each row also gets move buttons.
      sounds.length > 1
        ? jsx('div', {
            style: { fontSize: '11px', color: 'var(--ui-text-tertiary)' },
            children: t('reorderHint')
          })
        : null
    ]
  })
}

function SoundboardSettings({ engine }) {
  const t = usePluginI18n(ID)
  const settings = useValue(engine.settings)
  const sounds = useValue(engine.sounds)
  const custom = sounds.filter(sound => sound.kind === 'file').length

  return jsxs('div', {
    style: { display: 'flex', flexDirection: 'column', gap: '18px' },
    children: [
      jsxs('label', {
        style: { display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '12px', color: 'var(--ui-text-secondary)' },
        children: [
          jsx('span', { children: t('volume') }),
          jsxs('div', {
            style: { display: 'flex', alignItems: 'center', gap: '8px', maxWidth: '320px' },
            children: [
              jsx('input', {
                type: 'range',
                min: 0,
                max: 100,
                step: 1,
                value: settings.volume,
                style: { flex: 1, height: '3px', accentColor: 'var(--ui-accent)' },
                onChange: event => engine.setVolume(Number(event.target.value))
              }),
              jsx('span', { style: { width: '34px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }, children: `${settings.volume}%` })
            ]
          })
        ]
      }),
      jsxs('label', {
        style: { display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', color: 'var(--ui-text-secondary)' },
        children: [
          jsx('input', {
            type: 'checkbox',
            checked: settings.showLabel,
            onChange: event => engine.setShowLabel(event.target.checked)
          }),
          jsx('span', { children: t('showLabel') })
        ]
      }),
      jsxs('label', {
        style: { display: 'flex', alignItems: 'flex-start', gap: '8px', fontSize: '12px', color: 'var(--ui-text-secondary)' },
        children: [
          jsx('input', {
            type: 'checkbox',
            checked: settings.oneAtATime,
            style: { marginTop: '2px' },
            onChange: event => engine.setOneAtATime(event.target.checked)
          }),
          jsxs('span', {
            style: { display: 'flex', flexDirection: 'column', gap: '2px' },
            children: [
              jsx('span', { children: t('oneAtATime') }),
              jsx('span', { style: { fontSize: '11px', color: 'var(--ui-text-tertiary)' }, children: t('oneAtATimeHint') })
            ]
          })
        ]
      }),
      // Profiles: save the whole board (pads + volume + prefs) and switch
      // between saved ones. Same data as the popover's switcher, but with
      // rename and delete, which need room for a text field per row.
      jsxs('div', {
        style: { display: 'flex', flexDirection: 'column', gap: '8px' },
        children: [
          jsx('div', {
            style: {
              fontSize: '11px',
              fontWeight: 600,
              letterSpacing: '.06em',
              textTransform: 'uppercase',
              color: 'var(--ui-text-tertiary)'
            },
            children: t('profiles')
          }),
          jsx(ProfileManager, { engine })
        ]
      }),

      // The pads themselves, managed here as well as in the popover. A settings
      // page is where people look for "manage my sounds"; hiding it behind a
      // toggle inside a 308px popover was the only way before.
      jsxs('div', {
        style: { display: 'flex', flexDirection: 'column', gap: '8px' },
        children: [
          jsx('div', {
            style: {
              fontSize: '11px',
              fontWeight: 600,
              letterSpacing: '.06em',
              textTransform: 'uppercase',
              color: 'var(--ui-text-tertiary)'
            },
            children: t('manage')
          }),
          jsx(SoundboardManager, { engine })
        ]
      }),
      jsxs('div', {
        style: { fontSize: '12px', color: 'var(--ui-text-tertiary)' },
        children: [
          jsx('div', { children: t('stats', sounds.length, custom) }),
          jsx('button', {
            type: 'button',
            className: 'hermes-sb-preset',
            style: { marginTop: '8px' },
            onClick: () => engine.restorePresets(),
            children: t('restore')
          })
        ]
      }),
      // The same control the panel carries, in full width: a setup is something
      // you back up or share once in a while, which is where people look for it.
      jsx(SetupBar, { engine, page: true })
    ]
  })
}

// ── plugin ────────────────────────────────────────────────────────────────

const LOCALES = {
  en: {
    title: 'Soundboard',
    open: 'Open the soundboard',
    stopAll: 'Stop all sounds',
    addSound: 'Add a sound file',
    manage: 'Manage sounds',
    done: 'Done',
    preview: 'Preview',
    name: 'Sound name',
    delete: 'Delete',
    volume: 'Volume',
    mute: 'Mute',
    unmute: 'Unmute',
    when: 'Play this sound when',
    whenNever: 'Never',
    whenCount: '{n} triggers',
    ytOpen: 'Import from YouTube',
    ytPlaceholder: 'YouTube link or video id',
    ytImport: 'Convert to mp3',
    ytStart: 'from',
    ytLength: 'length',
    ytTrimHint: 'seconds — blank = whole clip',
    gainUp: 'Raise volume for',
    gainDown: 'Lower volume for',
    gainHint: 'This pad\'s own volume, relative to the master slider',
    trim: 'Trim clip',
    trimApply: 'Trim',
    trimCopy: 'keep original',
    trimCopyHint: 'Trim a copy, so the current pad stays as it is',
    trimDone: 'Clip trimmed.',
    trimFailed: 'The trim did not complete.',
    trimNeedsWindow: 'Give a start or a length — otherwise nothing would change.',
    trimOnlyFiles: 'Only imported or uploaded clips can be trimmed.',
    profiles: 'Profiles',
    profileName: 'New profile name',
    saveProfile: 'Save board',
    saveShort: 'Save',
    saveToProfile: 'Save to profile',
    saveOver: 'Name for a new profile',
    noProfile: 'Unsaved',
    noProfilesYet: 'No profiles saved yet.',
    padCount: (n) => `${n} ${n === 1 ? 'pad' : 'pads'}`,
    activeProfile: 'Active',
    useProfile: 'Use',
    renameProfile: 'Rename',
    deleteProfile: 'Delete profile',
    profileSaved: 'Profile saved.',
    overwrite: 'Overwrite',
    overwriteConfirm: 'Replace?',
    overwriteProfile: 'Overwrite profile',
    profileOverwritten: 'Updated profile {name}.',
    profileDeleted: 'Deleted profile {name}.',
    previousProfile: 'Previous board',
    newProfile: 'Profile',
    profilesFull: 'You have the maximum number of profiles.',

    moveUp: 'Move up',
    moveDown: 'Move down',
    reorderHint: 'Order sets which pad each of the 1-9 keys fires.',
    ytWorking: 'Converting…',
    ytAdded: 'Added “{name}”.',
    ytBadUrl: 'That is not a YouTube link.',
    ytNoPath: 'This build does not expose a plugin folder, so a download has nowhere to land.',
    ytNoYtdlp: 'yt-dlp is not available. Install uv (it is bundled with Hermes) and try again.',
    ytNoFfmpeg: 'ffmpeg was not found on PATH — yt-dlp needs it to make an mp3.',
    ytNoShell: 'Hermes refused to run the converter.',
    ytNoSession: 'Open a chat first — the converter runs inside the session that is currently open.',
    playError: 'That clip could not be decoded (audio error {code}).',
    decodeFailed: 'That clip did not start playing.',
    blockedAutoplay: 'Hermes blocked the audio. Click the pad again.',
    volumeZero: 'Volume is at 0 — turn the slider up.',
    ytTooLong: 'That video is {secs}s long. Soundboard clips are capped at 30s — pick a shorter one.',
    ytTimeout: 'The converter stopped without reporting back. Check that ffmpeg is on PATH, then try again.',
    ytFailed: 'The conversion failed.',
    whenClear: 'Clear all triggers',
    lastTrigger: trigger => `Last trigger: ${trigger}`,
    showLabel: 'Show the Soundboard label in the status bar',
    oneAtATime: 'Play one sound at a time',
    oneAtATimeHint: 'A new pad stops whatever is still playing, so clips never overlap.',
    empty: 'No sounds yet. Add an audio file, or drop one here.',
    restore: 'Restore built-in sounds',
    builtins: 'Built-in sounds',
    dropHere: 'Drop audio files to add them',
    noFileAccess: 'This Hermes Desktop build has no plugin file access, so custom sounds cannot be saved.',
    tooLarge: 'That file is larger than 3 MB. Soundboard clips should be short.',
    tooMany: 'The soundboard holds 40 sounds. Delete one to add another.',
    notAudio: 'That file is not an audio file.',
    saveFailed: 'That sound could not be saved.',
    missingAudio: 'That sound file is missing from the plugin folder.',
    stats: (total, custom) => `${total} pads · ${custom} custom file${custom === 1 ? '' : 's'}`,
    // ── setup export / import ──
    setup: 'Setup',
    setupHint: 'Share this board as one file, or load someone else’s.',
    exportSetup: 'Export',
    exportHint: 'Save every pad, its clip and its settings as one file you can share',
    importSetup: 'Import',
    importHint: 'Load a setup file someone shared with you',
    working: 'Working…',
    exportedTo: name => `Setup saved as “${name}”.`,
    exportedAsk: name => `“${name}” is ready — save it from the dialog.`,
    exportMissing: (n, names) =>
      `${n} clip${n === 1 ? '' : 's'} could not be read, so ${n === 1 ? 'it is' : 'they are'} missing from the file: ${names}.`,
    exportFailed: 'The setup file could not be saved.',
    thisFile: 'this file',
    importPlan: (name, pads) => `“${name}” holds ${pads} pad${pads === 1 ? '' : 's'}`,
    importMode: 'Where the pads go',
    importModeAdd: n => `Add to this board (${n} now)`,
    importModeReplace: n => (n ? `Start fresh (drops ${n})` : 'Start fresh'),
    importOverflow: (n, max) => `${n} pad${n === 1 ? '' : 's'} will not fit: a board holds ${max}.`,
    importNoAudio: n => `${n} pad${n === 1 ? '' : 's'} will be skipped — the clip is missing or too large.`,
    importSettings: (volume, perRow) => `Apply its settings too — ${volume}% volume, ${perRow} per row`,
    importAdd: n => `Add ${n} pad${n === 1 ? '' : 's'}`,
    cancel: 'Cancel',
    imported: n => `Added ${n} pad${n === 1 ? '' : 's'} to this board.`,
    importReplaced: n => `${n} previous pad${n === 1 ? '' : 's'} replaced.`,
    importRefused: n => `${n} pad${n === 1 ? '' : 's'} did not fit — use “Start fresh” to take them all.`,
    importWriteFailed: n =>
      `${n} clip${n === 1 ? '' : 's'} could not be saved, so ${n === 1 ? 'that pad was' : 'those pads were'} skipped.`,
    importNotJson: 'That file is not a setup file — it does not contain valid JSON.',
    importNotBundle: 'That JSON file is not a Soundboard setup.',
    importNewer: version => `That setup was made by a newer Soundboard (format ${version}). Update Hermes to import it.`,
    importEmpty: 'That setup has no pads this Soundboard can play.',
    importTooBig: 'That setup file is too large to read (over 64 MB).',
    importUnreadable: 'That file could not be read.',
    setupFailed: 'The setup could not be applied.'
  },
  pl: {
    title: 'Soundboard',
    open: 'Otwórz soundboard',
    stopAll: 'Zatrzymaj wszystkie dźwięki',
    addSound: 'Dodaj plik dźwiękowy',
    manage: 'Zarządzaj dźwiękami',
    done: 'Gotowe',
    preview: 'Odsłuchaj',
    name: 'Nazwa dźwięku',
    delete: 'Usuń',
    volume: 'Głośność',
    mute: 'Wycisz',
    unmute: 'Wyłącz wyciszenie',
    when: 'Odtwórz ten dźwięk gdy',
    whenNever: 'Nigdy',
    whenCount: '{n} wyzwalaczy',
    ytOpen: 'Importuj z YouTube',
    ytPlaceholder: 'Link do YouTube lub id filmu',
    ytImport: 'Konwertuj do mp3',
    ytStart: 'od',
    ytLength: 'długość',
    ytTrimHint: 'sekundy — puste = cały klip',
    gainUp: 'Podgłoś',
    gainDown: 'Ścisz',
    gainHint: 'Głośność tej podkładki względem głównego suwaka',
    trim: 'Przytnij klip',
    trimApply: 'Przytnij',
    trimCopy: 'zachowaj oryginał',
    trimCopyHint: 'Przytnij kopię, aby obecna podkładka została bez zmian',
    trimDone: 'Klip przycięty.',
    trimFailed: 'Przycinanie nie powiodło się.',
    trimNeedsWindow: 'Podaj początek lub długość — inaczej nic się nie zmieni.',
    trimOnlyFiles: 'Przycinać można tylko klipy zaimportowane lub wgrane.',
    profiles: 'Profile',
    profileName: 'Nazwa nowego profilu',
    saveProfile: 'Zapisz planszę',
    saveShort: 'Zapisz',
    saveToProfile: 'Zapisz w profilu',
    saveOver: 'Nazwa nowego profilu',
    noProfile: 'Niezapisana',
    noProfilesYet: 'Nie ma jeszcze żadnych profili.',
    padCount: (n) => `${n} ${n === 1 ? 'podkładka' : 'podkładek'}`,
    activeProfile: 'Aktywny',
    useProfile: 'Użyj',
    renameProfile: 'Zmień nazwę',
    deleteProfile: 'Usuń profil',
    profileSaved: 'Profil zapisany.',
    overwrite: 'Nadpisz',
    overwriteConfirm: 'Zastąpić?',
    overwriteProfile: 'Nadpisz profil',
    profileOverwritten: 'Zaktualizowano profil {name}.',
    profileDeleted: 'Usunięto profil {name}.',
    previousProfile: 'Poprzednia plansza',
    newProfile: 'Profil',
    profilesFull: 'Osiągnięto limit profili.',

    moveUp: 'W górę',
    moveDown: 'W dół',
    reorderHint: 'Kolejność decyduje, którą podkładkę uruchamia każdy z klawiszy 1-9.',
    ytWorking: 'Pobieranie i konwersja… to może chwilę potrwać.',
    ytAdded: 'Dodano „{name}”.',
    ytBadUrl: 'To nie jest link do YouTube.',
    ytNoPath: 'Ta wersja nie udostępnia folderu wtyczki, więc pobranie nie ma gdzie trafić.',
    ytNoYtdlp: 'yt-dlp jest niedostępny. Zainstaluj uv (jest w zestawie z Hermes) i spróbuj ponownie.',
    ytNoFfmpeg: 'Nie znaleziono ffmpeg w PATH — yt-dlp potrzebuje go do mp3.',
    ytNoShell: 'Hermes odmówił uruchomienia konwertera.',
    ytNoSession: 'Najpierw otwórz czat — konwerter działa w obrębie otwartej sesji.',
    playError: 'Nie udało się zdekodować klipu (błąd audio {code}).',
    decodeFailed: 'Klip nie zaczął się odtwarzać.',
    blockedAutoplay: 'Hermes zablokował dźwięk. Kliknij podkładkę jeszcze raz.',
    volumeZero: 'Głośność jest na 0 — podnieś suwak.',
    ytTooLong: 'Ten film ma {secs}s. Klipy dźwiękowe są ograniczone do 30s — wybierz krótszy.',
    ytTimeout: 'Konwerter zatrzymał się bez odpowiedzi. Sprawdź, czy ffmpeg jest w PATH, i spróbuj ponownie.',
    ytFailed: 'Konwersja nie powiodła się.',
    whenClear: 'Wyczyść wszystkie wyzwalacze',
    lastTrigger: trigger => `Ostatni wyzwalacz: ${trigger}`,
    showLabel: 'Pokazuj podpis Soundboard na pasku stanu',
    empty: 'Brak dźwięków. Dodaj plik audio albo przeciągnij go tutaj.',
    restore: 'Przywróć dźwięki wbudowane',
    builtins: 'Dźwięki wbudowane',
    dropHere: 'Upuść pliki audio, aby je dodać',
    noFileAccess: 'Ta wersja Hermes Desktop nie daje wtyczkom dostępu do plików, więc własnych dźwięków nie da się zapisać.',
    tooLarge: 'Ten plik jest większy niż 3 MB. Klipy do soundboardu powinny być krótkie.',
    tooMany: 'Soundboard mieści 40 dźwięków. Usuń któryś, aby dodać kolejny.',
    notAudio: 'To nie jest plik audio.',
    saveFailed: 'Nie udało się zapisać tego dźwięku.',
    missingAudio: 'Brakuje tego pliku dźwiękowego w folderze wtyczki.',
    stats: (total, custom) => `${total} padów · ${custom} własnych plików`,
    // ── setup: eksport / import ──
    setup: 'Zestaw',
    setupHint: 'Udostępnij tę tablicę jako jeden plik albo wczytaj cudzą.',
    exportSetup: 'Eksportuj',
    exportHint: 'Zapisz wszystkie pady, ich klipy i ustawienia w jednym pliku do udostępnienia',
    importSetup: 'Importuj',
    importHint: 'Wczytaj zestaw, który ktoś Ci przesłał',
    working: 'Pracuję…',
    exportedTo: name => `Zestaw zapisany jako „${name}”.`,
    exportedAsk: name => `„${name}” jest gotowy — zapisz go w oknie dialogowym.`,
    exportMissing: (n, names) => `Nie udało się odczytać ${n} klipu/klipów, więc brakuje ich w pliku: ${names}.`,
    exportFailed: 'Nie udało się zapisać pliku zestawu.',
    thisFile: 'ten plik',
    importPlan: (name, pads) => `„${name}” zawiera ${pads} padów`,
    importMode: 'Gdzie trafią pady',
    importModeAdd: n => `Dodaj do tej tablicy (teraz ${n})`,
    importModeReplace: n => (n ? `Zacznij od nowa (usuwa ${n})` : 'Zacznij od nowa'),
    importOverflow: (n, max) => `${n} padów się nie zmieści: tablica mieści ${max}.`,
    importNoAudio: n => `${n} padów zostanie pominiętych — brakuje klipu albo jest za duży.`,
    importSettings: (volume, perRow) => `Zastosuj też ustawienia — głośność ${volume}%, ${perRow} w rzędzie`,
    importAdd: n => `Dodaj ${n} padów`,
    cancel: 'Anuluj',
    imported: n => `Dodano ${n} padów do tej tablicy.`,
    importReplaced: n => `Zastąpiono ${n} wcześniejszych padów.`,
    importRefused: n => `${n} padów się nie zmieściło — użyj „Zacznij od nowa”, aby wziąć wszystkie.`,
    importWriteFailed: n => `Nie udało się zapisać ${n} klipu/klipów, więc te pady pominięto.`,
    importNotJson: 'To nie jest plik zestawu — nie zawiera poprawnego JSON-a.',
    importNotBundle: 'Ten plik JSON nie jest zestawem Soundboardu.',
    importNewer: version => `Ten zestaw pochodzi z nowszego Soundboardu (format ${version}). Zaktualizuj Hermesa, aby go zaimportować.`,
    importEmpty: 'Ten zestaw nie ma padów, które ten Soundboard potrafi odtworzyć.',
    importTooBig: 'Ten plik zestawu jest za duży do odczytu (ponad 64 MB).',
    importUnreadable: 'Nie udało się odczytać tego pliku.',
    setupFailed: 'Nie udało się zastosować zestawu.'
  }
}

export default {
  id: ID,
  name: 'Soundboard',
  description: 'A soundboard in the bottom bar: synthesized cues plus your own audio files as pads.',
  defaultEnabled: true,
  register(ctx) {
    ctx.i18n.register(LOCALES)

    const style = document.createElement('style')
    style.textContent = CSS
    document.head.append(style)
    ctx.onDispose(() => style.remove())

    const engine = createEngine(ctx)
    // Test hook: lets the harness drive the engine directly (playback failure
    // reporting is unreachable from the DOM when the stub Audio never emits).
    ctx.__engine = engine

    ctx.register({ id: 'chip', area: STATUSBAR_AREAS.right, order: 20, render: () => jsx(Chip, { engine }) })

    ctx.register({
      id: 'open',
      area: PALETTE_AREA,
      data: {
        id: 'soundboard.open',
        label: 'Open Soundboard',
        keywords: ['sound', 'soundboard', 'audio', 'pad', 'sfx'],
        run: () => engine.open.set(true)
      }
    })

    ctx.registerSettingsPage?.({
      id: 'settings',
      title: 'Soundboard',
      icon: 'unmute',
      render: () => jsx(SoundboardSettings, { engine })
    })
  }
}
