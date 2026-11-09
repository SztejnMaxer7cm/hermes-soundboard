# hermes-soundboard

A soundboard for the **Hermes Desktop** app, docked in the bottom bar.

Click the chip at the right end of the status bar and a popover of pads opens
above it: seven built-in cues synthesized with WebAudio (no assets, no
network), plus any audio files you add. Names, order, volume and a "manage"
mode all persist per machine.

```
┌──────────────────────────────────────────────────┐
│  … status bar …              ≋ Soundboard  42%  │  ← chip
└──────────────────────────────────────────────────┘
                       ▲
        ┌──────────────────────────────┐
        │ SOUNDBOARD           ■  +  ✎ │
        │ ┌────┐ ┌────┐ ┌────┐ ┌────┐  │
        │ │1Pop│ │2Dng│ │3Bep│ │4Con│  │  ← 1–9 = keys
        │ └────┘ └────┘ └────┘ └────┘  │
        │ ┌────┐ ┌────┐ ┌────┐ ┌────┐  │
        │ │5Lsr│ │6Whs│ │7Bng│ │ +  │  │  ← + adds a file
        │ └────┘ └────┘ └────┘ └────┘  │
        │ ──────────────────────────── │
        │ 🔊 ▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬   80% │
        └──────────────────────────────┘
```

## What it does

- **Bottom-bar controls.** The whole soundboard is a status-bar chip and a
  popover — no pane, no page, no window to manage.
- **Built-in sounds.** Pop, Ding, Beep, Coin, Laser, Whoosh, Boing. Each is a
  handful of oscillator/noise nodes with an exponential envelope, so they are
  instant and cost nothing on disk. Delete them and they can be restored from
  the manage list or the settings page.
- **Custom sounds.** `+` opens a file picker (`audio/*`, multi-select), or drop
  audio files straight onto the panel. Each file is copied into the plugin's
  private data folder as base64 and read back into a `data:` URL on first play,
  so a custom pad survives restarts without the original file staying put.
- **YouTube import.** The link button takes a YouTube URL (or a bare video id)
  and adds it as an mp3 pad, through `yt-dlp` + `ffmpeg`. See
  [YouTube import](#youtube-import).
- **Manage mode.** The pencil button lists every pad with a preview button, a
  **"play when" trigger dropdown**, an inline rename field (Enter or blur
  commits, Escape reverts) and delete. Deleting a custom pad also trashes its
  stored clip.
- **Triggers — the board plays itself.** Any pad can be bound to a live Hermes
  event, so it fires on its own: the turn finishing (split by success / failure
  / interruption), an approval or a question that has the agent blocked, a
  warning notice, risky tool output, a session error, a subagent finishing,
  context compaction, a heartbeat, a wake phrase, or affection detected in your
  message. Bound pads carry a dot in the grid; the panel footer names the last
  trigger that actually fired. See [Triggers](#triggers).
- **Profiles.** Save the whole board — pads, volume, one-at-a-time — under a
  name, then switch between saved boards from the popover header (change board
  mid-conversation) or from Settings, where you can also rename and delete them.
- **One at a time.** An optional *Play one sound at a time* mode stops whatever
  is still sounding before the next pad starts, so clips never stack — useful if
  you fire pads quickly and the overlap turns to mush. Applies to clicks and to
  triggered cues alike.
- **Volume + mute.** One master volume, persisted. `■` stops everything and
  suspends the audio context. Each pad also has its own **gain trim** (0-200%,
  stepped with −/+) for the one clip that is still too loud or quiet — the
  master slider stays a single global control.
- **Trim an existing clip.** Any imported or uploaded pad gets a trim button in
  manage mode: two fields (from / length, in seconds) and an optional *keep
  original*. Trimming is destructive — the stored bytes are replaced — so the
  checkbox on by default cuts a copy instead, leaving the pad you already have
  untouched. Synthesised cues have no trim button: there are no bytes to cut.
- **Drag to reorder.** Pads drag by their body; a line marks where the drop
  lands. Order matters because `1`-`9` fire by position, so dragging is also how
  you choose which key hits which pad.
- **Share a whole setup.** One `Export` writes the entire board — every pad,
  its clip, its gain, its trigger bindings, the order and the settings that shape
  the panel — into a single `.json`. `Import` reads one back and shows you what it
  would do first: how many pads, whether they fit, which ones would be skipped,
  and whether to add them to the board or start fresh from the file. See
  [Sharing a setup](#sharing-a-setup).
- **Keyboard.** While the panel is focused, `1`–`9` fire the first nine pads and
  `Escape` closes it.
- **⌘K command.** "Open Soundboard" from the command palette.
- **Settings → Plugins → Soundboard.** The full manager lives here too, not
  only in the popover: add a file, import from YouTube, and per pad the preview,
  trigger picker, rename, reorder (↑/↓), gain, trim and delete — plus the master
  volume, the label toggle, one-at-a-time and padding preferences.

## YouTube import

Paste a link, get a pad. The link button in the panel header opens a one-field
row; Enter or the arrow button starts the conversion, and the pad appears when
it finishes — typically a few seconds for a short clip.

- **An open chat is required.** `shell.exec` is session-bound: the gateway runs
  the command in the focused chat's cwd under that session's policy, and refuses
  with `invalid_params` if the call names no live session. So the import needs a
  chat open, and says so plainly instead of surfacing that code.
- **What it needs.** `yt-dlp` and `ffmpeg`. yt-dlp is fetched on demand by
  `uvx`, which ships with Hermes, so in practice only **ffmpeg** has to be on
  `PATH`. Both are probed before the field is offered, and a missing one is
  named in the error rather than failing silently.
- **Trim it.** Two optional fields beneath the URL take a start time and a
  length in seconds, so you grab the one 2-second sound you wanted instead of
  the opening of the video. ffmpeg cuts the window after the download.
- **Loudness-normalised.** The same ffmpeg pass runs `loudnorm` to about -16 LUFS,
  which matters: a YouTube clip is routinely 8-10 dB quieter than a hand-made
  one, and a pad that plays at half the volume of its neighbours reads as broken.
  A measured import went from **-30.7 dB mean / -11.3 dB peak** to **-19.1 /
  -4.3**.
- **30-second cap.** A soundboard cue wants seconds, not a track. The duration
  is checked before downloading anything; a longer video is refused with its
  length in the message.
- **3 MB cap** still applies (base64 in `ctx.files` doubles nothing, but
  inflates by 4/3 against a 4 MiB text limit).

### Why the job is a detached script

The only process door a plugin has is `host.request('shell.exec')`, and it kills
its child at 30 seconds. A conversion can take longer, so the plugin writes a
`.cmd` script into its own data folder, launches it detached, and watches a
status file. Three details are load-bearing and each was a real failure first:

| Detail | Why |
|---|---|
| Every path is **relative**, anchored by `%~dp0` | Batch needs `%%` for a literal `%`, so an env-var path like `%APPDATA%` written through the same escaper became the literal text `%%APPDATA%%` — the script could not `cd`, exited 0, and wrote **no status file**, so the plugin waited out its whole budget on a job that had already died |
| The script takes **no arguments** | `start /b cmd /c "script.cmd" "arg"` silently drops arguments — four forms were probed, all arrived empty. Every path is baked into the script instead |
| The trim/normalise step is **parenthesised** | `a && b >> log` redirects only `b`, and a trailing `>nul` collides with it — the whole post-process silently vanished. `( a && b ) >> log` covers the chain |
| A stored clip is trimmed through **PowerShell** | The stored form is base64 text, and the plugin has no Node runtime: PowerShell decodes it to a temp mp3, ffmpeg cuts, PowerShell re-encodes back over the `.b64`. Verified end to end: 2.28s → 1.200s in place |
| `%` is **doubled** | `-o out.%(ext)s` — an unescaped `%` makes cmd refuse to parse the whole file (`File Not Found`), running no line at all |
| Duration is probed **in the foreground** | `--match-filter "duration <= 30"` puts `<`/`>` in the command, which cmd eats as redirection even inside quotes; yt-dlp then reports "You must provide at least one URL" |

The status file is the only channel back — `shell.exec` captures output at
launch and the child is gone by then — so the job writes `ok`/`fail` when it
finishes, and the plugin polls it. Because a status file only appears at the
END, the plugin also reads yt-dlp's log as the job runs and turns its
`[download] 42.3%` lines into the progress bar. Every failure path raises a host
toast as well as the inline note, since the panel is often shut by then.

## Triggers

A binding is `pad → triggers`, plural. The picker is grouped and **multi-select**:
each click toggles one trigger and leaves the menu open, so a single pad can
answer to a whole family of events — one sound for "the agent needs me", bound
to approvals, questions and warnings alike. With nothing bound the control reads
*Never*; with one binding it names that trigger; with several it reads *3
triggers* and a tooltip lists them all. *Clear all triggers* empties the list.

Each entry maps to one real gateway event with a filter, so a pad reacts to "the
turn finished successfully", not "every `message.complete` frame".

Random choice is uniform, but with three or more candidates it will not pick
the same pad twice in a row — plain uniform random repeats half the time with
two pads, which listeners read as "not random". Every remaining pad stays
equally likely, so the pick is still unbiased.

Stored shape is `triggers: ["turn.complete", …]`. A save written by an earlier
version holds a single `trigger: "id"` string; it is migrated to a one-entry list
on load, and unknown or duplicate ids are dropped.

| Group | Trigger | Underlying event | Fires when |
|---|---|---|---|
| Turn | Turn finishes | `message.complete` | status is not `error` / `interrupted` |
| Turn | Turn fails | `message.complete` | status `error`, or `error` is set |
| Turn | Turn interrupted | `message.complete` | status `interrupted` |
| Turn | Turn starts | `message.start` | you send a message — **not** the turn chained after one ends |
| Attention | Approval needed | `approval.request` | the agent is blocked on approval |
| Attention | Question asked | `clarify.request` | the agent is blocked on a question |
| Attention | Warning notice | `notification.show` | level `warn` or `error` |
| Attention | Risky tool output | `tool.output_risk` | injection / secret findings |
| Attention | Session error | `error` | failure outside a turn |
| Work | Subagent finishes | `subagent.complete` | a delegated child is done |
| Work | Context compacted | `status.update` | kind `compacted` |
| Ambient | Heartbeat fires | `status.update` | kind `heartbeat` |
| Ambient | Wake phrase | `wake.detected` | your wake phrase fired |
| Ambient | Affection detected | `reaction` | "good bot", "ily", a heart |

Only the events the table names are subscribed — one listener per event, shared
by every pad bound to it. A binding is validated on read, so a stale id in
storage degrades to "never" instead of throwing.

Hermes emits 88 named events in total (78 backend + 10 client-local); this
plugin deliberately exposes the 14 that are worth interrupting a human for. The
full set is the generated `GATEWAY_EVENT_TYPES` in
`apps/shared/src/gateway-contract.generated.ts`.

**Why the picker is not a `<select>`.** It was one, and the list came up as a
near-white sheet under this theme's cream text — roughly 1.1:1, unreadable. A
native option list is not a DOM node: the browser draws it from the page's
`color-scheme`, so no page CSS can restyle it. The picker is now a button plus
an in-DOM list, so every pixel of the menu is ours and it inherits the theme.
Rows assert at **8.12:1** and group headers at **4.80:1**.

**Why the menu is in flow, not positioned.** Three attempts, three failures, and
the last two were only visible in the real app:

| Approach | What happened |
|---|---|
| `position: absolute` | Clipped by the manage list's `overflow-y: auto` |
| `position: fixed` | Anchored to the *popover*, not the viewport — `PopoverContent` carries `backdrop-blur-md`, and a backdrop-filter makes that element the containing block for fixed descendants. The menu rendered far off-screen; the picker looked dead |
| in flow (`flex: 0 0 100%` on a wrapping row) | Correct |

The wrapper carries `display: contents` so the picker and menu become direct
children of the row's flex layout; the menu then wraps onto its own full-width
line beneath the row. Nothing to clip, nothing to re-anchor.

That lesson is now enforced by the harness: the stub popover mirrors the real
one's `backdrop-filter`, and the suite asserts the menu is inside the panel box
and at least 200px wide. Both assertions were verified to fail on a
deliberately reverted build.

**On "Turn starts" after a turn ends.** `message.start` carries **no payload**
from the gateway (`_emit("message.start", sid)`), so `display_kind` is always
undefined there and a filter on it is dead code — the automatic follow-up turn
was indistinguishable from you pressing send. The engine instead remembers when
the last turn completed: a start arriving within 1.5s of a completion is the
chained continuation and does not fire. A genuine send a moment later does.

**On playback failures.** `playFile` used to swallow everything: the pad
flashed, nothing was audible, and no message appeared — indistinguishable from
"the file is broken", "autoplay was blocked" or "the volume is at zero". It now
raises a host toast naming which of those it was (decode error code, blocked
playback, or a zero volume), because silence with no explanation is a bug in its
own right.

**On autoplay.** A triggered sound plays while the window may be unfocused, so
the WebAudio context can be suspended by the browser's autoplay policy. Every
trigger attempts a resume; if the platform refuses, the pad still lights up, so
the cue is never silently lost.

## Profiles

A profile is a snapshot of the **pads plus the global settings**, because those
only mean anything together — a "podcast" board is as much about the volume and
one-at-a-time as about which clips are on it.

Switching lives in the popover header, because that is the on-the-go surface: you
change board mid-conversation, not mid-settings. The menu is an overlay, anchored
to its trigger — in flow it grew the header by ~100px and shoved the pad grid
down every time it opened, so the board jumped under your finger. Settings lists the same profiles
with rename and delete, which need a text field per row.

Two behaviours worth knowing:

- **Overwrite instead of accumulating.** Each saved profile has an **Overwrite**
  button in Settings: it replaces that profile's board with the live one, keeping
  its name. One click arms it ("Replace?"), the second replaces — a saved board
  is worth protecting from a slip. Typing an existing profile's name into the
  save field does the same thing, so a tweaked setup updates its profile instead
  of becoming "Studio 2".
- **Save in place vs. save as new.** Saving under the active profile's name
  overwrites it — the common case is "I tweaked my board". Typing a genuinely
  new name creates a second profile instead of renaming the open one.
- **Switching away from an unsaved board keeps it**, saved as "Previous board"
  the first time. Switching is otherwise a silent way to lose work.

Clips are **not** copied into profiles. They stay in the data folder keyed by
sound id, so two profiles can share one clip — which is why deleting a pad only
trashes its blob when no profile still references it.

## Sharing a setup

`Export` at the foot of the panel (and on the settings page) collects the whole
board into one file and hands it to the app's save dialog, defaulting to
Downloads:

```
soundboard-setup-2026-11-05.json
```

Everything a setup *is* travels in it — pad order, names, per-pad gain, trigger
bindings, the embedded clips themselves, and master volume / label / pads-per-row
/ one-at-a-time. Clips ride along as base64, the same form the plugin already
stores them in, so a shared setup is one attachment with no folder of loose mp3s
to keep beside it.

`Import` runs in two steps, because a setup file is someone else's data:

1. **Pick the file.** Nothing is written yet. The panel shows a plan: how many
   pads the file holds, a checkbox for *also apply its settings*, and a warning
   for anything it had to leave out (a clip that is missing, or not base64, or
   over the 3 MB per-pad cap).
2. **Confirm.** `Add to this board` (the default) appends the file's pads after
   yours, skipping any that would pass 40; `Start fresh` replaces the board
   entirely, moving the clips it displaces to the OS trash.

Two things an import never does: it never reuses a pad id from the file (ids are
minted on the machine doing the import, so a file cannot overwrite or address an
existing pad), and it never adds a pad whose clip it could not decode — a silent
pad is worse than a reported skip. Everything read back goes through the same
sanitizer storage uses, so a hand-edited or truncated file can only produce pads
this build already understands.

A setup file is plain JSON and diffable by eye:

```json
{
  "format": "hermes-soundboard-setup",
  "version": 1,
  "exportedAt": "2026-11-05T18:12:04.881Z",
  "settings": { "volume": 65, "showLabel": true, "padsPerRow": 4, "oneAtATime": false },
  "sounds": [
    { "name": "Pop", "kind": "synth", "synth": "pop" },
    { "name": "Turn done", "kind": "file", "mime": "audio/mpeg", "gain": 150,
      "triggers": ["turn.complete"], "audio": "SUQzBAAAAAAA…" }
  ]
}
```

## Screenshots

![The soundboard popover](shots/preview-panel.png)

![The trigger picker open](shots/preview-menu.png)

![Two triggers on one pad](shots/preview-multi.png)

![Importing from YouTube](shots/preview-youtube.png)

![Converting, with progress](shots/preview-youtube-progress.png)

| | |
|---|---|
| ![Manage mode](shots/preview-manage.png) | ![Settings page](shots/preview-settings.png) |
| Manage mode — rename, preview, delete | Settings → Plugins → Soundboard |

![An imported setup, before it is applied](shots/preview-setup.png)

All of these are produced by `npm run test:ui`, not by hand.

## Install

Hermes Desktop loads plugins from `$HERMES_HOME/desktop-plugins/<id>/plugin.js`
and the folder name must equal the plugin `id` (`hermes-soundboard`).

```bash
git clone https://github.com/SztejnMaxer7cm/hermes-soundboard.git
cp -r hermes-soundboard ~/.hermes/desktop-plugins/hermes-soundboard
```

On Windows that is typically:

```powershell
git clone https://github.com/SztejnMaxer7cm/hermes-soundboard.git
xcopy /E /I hermes-soundboard "%LOCALAPPDATA%\hermes\desktop-plugins\hermes-soundboard"
```

Or just copy `plugin.js` into that folder — it is the whole plugin. Then run
**Reload desktop plugins** from ⌘K (the app also hot-reloads every save of the
file). The plugin is enabled by default; it stays off if you toggle it off in
**Capabilities → Plugins**.

## Limits, on purpose

- 40 sounds maximum, 3 MB per audio file. `ctx.files` refuses text beyond 4 MiB
  and base64 inflates by 4/3, so 3 MB is the largest clip that reliably fits.
- Soundboard clips are meant to be short. Anything long belongs in a player, not
  a pad.
- A setup file carries every clip, so it is roughly the size of the board's audio
  (base64 costs another third). The importer refuses anything over 96 MB, which
  is more than a full 40-pad board can ever weigh.

## How it is built

**One scroll container per surface.** The trigger menu is a block in flow inside
the manage list, and the list does the scrolling. Giving the menu its own
`max-height`/`overflow` made two nested scrollers, and because both set
`overscroll-behavior: contain` the chain never passed outward — a picker opened
near the bottom of the board could not reach its last rows at all. The list also
grows its viewport while a menu is open (`:has(.hermes-sb-menu)`), and the picker
scrolls its own menu into view when it opens below the fold.

One plain-ESM file, no build step, no dependencies — the two things the Desktop
loader resolves at runtime are `@hermes/plugin-sdk` and `react/jsx-runtime`:

| Surface | API |
|---|---|
| Bottom bar | `ctx.register({ area: STATUSBAR_AREAS.right })` + `Popover` |
| Command palette | `ctx.register({ area: PALETTE_AREA })` |
| Settings page | `ctx.registerSettingsPage({...})` |
| Persistence | `ctx.storage` (sounds + settings + profiles + activeProfile) |
| Clips | `ctx.files.writeText('data', '<id>.b64', base64)` / `readText` / `trash` |
| Sound | WebAudio (`OscillatorNode`, `AudioBufferSourceNode`) and `Audio` |
| Text | `ctx.i18n.register({ en, pl })` + `usePluginI18n` |

Custom clips are stored base64 rather than as binary because `ctx.files` is the
only file door a plugin gets, and it is text (plus `readDataUrl`) oriented. No
`window.hermesDesktop` calls, no DOM reach into the app, no hardcoded colours —
all of it is theme variables, so the pads follow whatever skin is active.

Everything read back out of storage is rebuilt field by field before use, so a
hand-edited or half-written JSON blob degrades to the built-ins instead of
throwing inside a render.

## Test

Four suites, all runnable with `npm test`:

```bash
npm test            # all four
npm run test:unit   # jsdom harness, 72 assertions
npm run test:picker # real file picker in Chromium, 8 assertions
npm run test:ui     # render + geometry + a fired trigger in Chromium
npm run test:setup  # export / import round trip in Chromium, 33 assertions
```

**`test/harness.mjs`** bundles
for a stub with the same shapes, mounts every contribution in jsdom and drives
them the way a user would — click a pad, press a number key, add a file, drop a
file, refuse an oversized one, rename, delete, stop-all, Escape, then reload the
plugin and corrupt the stored JSON, then bind pads to gateway events and emit
real ones to prove only the right pad fires. 38 assertions.

**`test/picker.mjs`** drives a **real** `<input type="file">` with real `File`
objects in Chromium: one mp3, the same mp3 twice, two at once, a 4 MB file, a
`.txt`, then delete. 8 assertions.

It exists because the jsdom harness could not have caught the bug it now guards.
`input.files` is a **live `FileList`**: the plugin resets `input.value` after a
pick (otherwise the same file cannot be chosen twice), and that reset empties
`input.files`. Reading `event.target.files` straight into a variable therefore
handed `addFile` an empty list, every time — the picker appeared to do nothing at
all. jsdom let the harness assign `files` as a plain static property, so the
suite passed while the shipped plugin was broken. The suite was confirmed to
fail (5 checks, 4 failures) against the unfixed code before the fix was restored.

**`test/setup.mjs`** exports a real board through the browser's download path,
adds a real WAV clip, gives it a gain and a binding, exports again, and imports
the file back — then asserts the imported **clip actually decodes and plays**
(`currentTime` advanced, `readyState` past `HAVE_CURRENT_DATA`), not merely that a
pad appeared. It also covers every refusal path (a `.txt`, foreign JSON, a newer
format version, a bundle whose clip is not base64, a full board) and checks that
each one names itself and writes nothing. 33 assertions, and it was confirmed to
go red against three separate reverted fixes: the per-clip size guard, the
settings assignment, and byte-exact clip embedding.

**`test/preview.mjs`** renders the same plugin in a real Chromium against the
app's theme variables and measures the result: pad count, grid columns, and
whether the header, grid and volume row share one left and one right edge. It
writes `preview-statusbar.png`, `preview-panel.png`, `preview-manage.png`,
`preview-setup.png` and `preview-settings.png` to `.build/`. The setup row and
its import plan are measured the same way — button heights, shared baselines,
containment in the panel, the hint's own left axis. That is what catches a layout that reads
fine in code and wrong on screen — the padding asymmetry and the orphaned grid
cell in this plugin were both found that way, not by reading the CSS.

All four borrow `esbuild`, `jsdom`, `react`, `react-dom` and `playwright-core`
from an installed Hermes (`HERMES_DEPS_ROOT` points elsewhere if needed),
precisely because the plugin itself declares no dependencies and this repository
has no `node_modules`.

Passing these proves the plugin evaluates, registers, renders, persists, lays
out, and handles a real file pick. They do not replace looking at it: a status
bar chip is 15 CSS px tall, and the final judgement of a popover is still the
eye.

## License

MIT
