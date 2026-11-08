// Unit-test the YouTube plumbing in isolation: URL parsing and the detached
// command string. These are the parts that fail silently in the app (a bad
// regex makes the button do nothing), so they get real cases.
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'

// Resolved from this file, not a hardcoded checkout path, so the suite runs
// from any clone on any platform (it was born pointing at C:/Users/user).
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const src = fs.readFileSync(path.join(root, 'plugin.js'), 'utf8')

// Pull the pure helpers out of the module source and evaluate them alone —
// the module itself imports the SDK and cannot run under plain Node.
function grab(name, endMarker) {
  const start = src.indexOf(name)
  if (start < 0) throw new Error(`${name} not found`)
  const end = src.indexOf(endMarker, start)
  return src.slice(start, end)
}

const chunk = [
  grab('function parseYoutube', '\nclass ImportError'),
  grab('function jobScript', '\n/** Script that re-cuts an ALREADY STORED clip'),
  grab('function trimScript', '/** The one-line command'),
  grab('function detachedCommand', '\n/** Length of the video in seconds'),

  // The extracted slice references the platform helper; the unit test is about
  // the Windows shape, so it says so.
  'const IS_WINDOWS = true\nconst windowsHost = () => true\n'
].join('\n')

const mod = await import(
  'data:text/javascript;base64,' + Buffer.from(chunk + '\nexport { parseYoutube, jobScript, trimScript, detachedCommand }').toString('base64')
)

let pass = 0
let fail = 0
const check = (name, fn) => {
  try {
    fn()
    console.log(`PASS  ${name}`)
    pass++
  } catch (error) {
    console.log(`FAIL  ${name}\n      ${error.message}`)
    fail++
  }
}
const eq = (a, b, label = '') => {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${label} got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`)
}

const { parseYoutube, jobScript, trimScript, detachedCommand } = mod

check('a bare 11-char id is accepted', () => eq(parseYoutube('jNQXAC9IVRw'), 'jNQXAC9IVRw'))
check('a watch URL is parsed', () => eq(parseYoutube('https://www.youtube.com/watch?v=jNQXAC9IVRw'), 'jNQXAC9IVRw'))
check('a watch URL with extra params is parsed', () =>
  eq(parseYoutube('https://www.youtube.com/watch?v=jNQXAC9IVRw&t=42s&list=PLx'), 'jNQXAC9IVRw'))
check('a youtu.be short link is parsed', () => eq(parseYoutube('https://youtu.be/jNQXAC9IVRw'), 'jNQXAC9IVRw'))
check('a youtu.be link with a query is parsed', () => eq(parseYoutube('https://youtu.be/jNQXAC9IVRw?t=10'), 'jNQXAC9IVRw'))
check('a /shorts/ link is parsed', () => eq(parseYoutube('https://youtube.com/shorts/jNQXAC9IVRw'), 'jNQXAC9IVRw'))
check('an /embed/ link is parsed', () => eq(parseYoutube('https://www.youtube.com/embed/jNQXAC9IVRw'), 'jNQXAC9IVRw'))
check('a /live/ link is parsed', () => eq(parseYoutube('https://www.youtube.com/live/jNQXAC9IVRw'), 'jNQXAC9IVRw'))
check('music.youtube.com is parsed', () => eq(parseYoutube('https://music.youtube.com/watch?v=jNQXAC9IVRw'), 'jNQXAC9IVRw'))
check('m.youtube.com is parsed', () => eq(parseYoutube('https://m.youtube.com/watch?v=jNQXAC9IVRw'), 'jNQXAC9IVRw'))
check('a scheme-less URL is parsed', () => eq(parseYoutube('youtube.com/watch?v=jNQXAC9IVRw'), 'jNQXAC9IVRw'))
check('a trimmed URL with whitespace is parsed', () => eq(parseYoutube('  https://youtu.be/jNQXAC9IVRw  '), 'jNQXAC9IVRw'))

check('an unrelated host is refused', () => eq(parseYoutube('https://vimeo.com/12345'), null))
check('a lookalike host is refused', () => eq(parseYoutube('https://notyoutube.com/watch?v=jNQXAC9IVRw'), null))
check('an empty string is refused', () => eq(parseYoutube(''), null))
check('null is refused', () => eq(parseYoutube(null), null))
check('a watch URL without v is refused', () => eq(parseYoutube('https://www.youtube.com/watch'), null))
check('a too-short id is refused', () => eq(parseYoutube('https://youtu.be/abc'), null))
check('an over-long id is refused', () => eq(parseYoutube('https://youtu.be/jNQXAC9IVRwXXXX'), null))
check('a channel URL is refused', () => eq(parseYoutube('https://www.youtube.com/@someone'), null))

// ── the job script ──────────────────────────────────────────────────────
const script = jobScript({
  exe: 'uvx yt-dlp',
  args: ['-x', '--audio-format', 'mp3', '-o', 'yt-1.%(ext)s', 'https://www.youtube.com/watch?v=jNQXAC9IVRw'],
  out: '%~dp0',
  log: '.yt-1.log',
  status: '.yt-1.status',
  mp3: 'yt-1.mp3'
})

check('the script anchors to its own folder', () => {
  const first = script.split('\r\n').find(line => /^cd /.test(line))
  if (first !== 'cd /d "%~dp0"') throw new Error(first)
})
check('no path carries an env var that batch would mangle', () => {
  // `%APPDATA%` run through the percent escaper became the LITERAL `%%APPDATA%%`,
  // so `cd` failed, the script exited 0 and wrote no status file — the plugin
  // then waited forever on a job that had already died.
  if (/%APPDATA%/i.test(script)) throw new Error('an env var leaked into the script')
  if (/%%[A-Z]/.test(script)) throw new Error('a double-escaped variable name')
})
check('it runs yt-dlp through uvx', () => {
  if (!script.includes('uvx yt-dlp "-x" "--audio-format" "mp3"')) throw new Error(script)
})
check('the output template is escaped exactly once', () => {
  const template = script.match(/"-o" "([^"]+)"/)
  if (!template) throw new Error('no -o argument')
  if (template[1] !== 'yt-1.%%(ext)s') throw new Error(`template is ${template[1]}`)
})
check('every percent in an argument is doubled', () => {
  const args = [...script.matchAll(/"(-{1,2}[^"]*)"/g)]
  for (const [, value] of args) {
    if (/(?<!%)%(?!%)/.test(value)) throw new Error(`unescaped % in ${value}`)
  }
})
check('the log gets both streams', () => {
  if (!script.includes('> ".yt-1.log" 2>&1')) throw new Error(script)
})
check('success and failure both write the status file', () => {
  if (!/if exist "yt-1\.mp3" \(echo ok> "\.yt-1\.status"\)/.test(script)) throw new Error('no ok branch')
  if (!/else \(echo fail> "\.yt-1\.status"\)/.test(script)) throw new Error('no fail branch')
})
check('the status branch runs even if yt-dlp never starts', () => {
  // The `if exist` is a separate line, not chained with && or || — otherwise a
  // failure to launch skips it and the plugin waits out its whole budget.
  const lines = script.split('\r\n')
  const runIdx = lines.findIndex(line => line.startsWith('uvx yt-dlp'))
  const statusIdx = lines.findIndex(line => line.startsWith('if exist'))
  if (statusIdx < runIdx) throw new Error('the status line precedes the command')
  if (lines[runIdx].includes('&&') || lines[runIdx].includes('||')) throw new Error('the run line is chained')
})
check('the script has CRLF line endings (cmd needs them)', () => {
  if (/[^\r]\n/.test(script)) throw new Error('bare LF found')
})
check('an argument containing a quote cannot break out', () => {
  const evil = jobScript({ exe: 'uvx yt-dlp', args: ['-o', 'x" & shutdown /s & "'], out: '%~dp0', log: 'l', status: 's', mp3: 'm' })
  if (evil.includes('"x" & shutdown')) throw new Error('quote survived')
  if (!evil.includes('"x & shutdown /s & "')) throw new Error(evil)
})

// ── trim + normalise (the ffmpeg post step) ─────────────────────────────
const trimmed = jobScript({
  exe: 'uvx yt-dlp',
  args: ['-o', 'a.%(ext)s', 'x'],
  out: '%~dp0',
  log: '.a.log',
  status: '.a.status',
  mp3: 'a.mp3',
  post: 'ffmpeg -ss 0.5 -t 1.2 -i "a.mp3" -af "loudnorm=I=-16" -y "a.out.mp3" && move /y "a.out.mp3" "a.mp3"'
})

check('the post step runs after the download', () => {
  const lines = trimmed.split('\r\n')
  const dl = lines.findIndex(l => l.startsWith('uvx yt-dlp'))
  const post = lines.findIndex(l => l.startsWith('( ffmpeg'))
  if (post < dl) throw new Error('post step precedes the download')
})
check('the post step is GROUPED so one redirect covers the whole chain', () => {
  // `a && b >> log` redirects only b, and a trailing `>nul` in the chain
  // collides with it — that combination silently swallowed the whole step.
  const exec = trimmed.split('\r\n').find(l => l.startsWith('( ffmpeg'))
  if (!exec || !/^\( ffmpeg .* \) >> "\.a\.log" 2>&1$/.test(exec)) throw new Error(String(exec))
})
check('the post step never uses >nul inside a redirected chain', () => {
  const line = trimmed.split('\r\n').find(l => l.startsWith('( ffmpeg')) ?? ''
  if (/>nul/.test(line)) throw new Error(line)
})
check('the status check looks for the FINAL mp3', () => {
  const line = trimmed.split('\r\n').find(l => l.startsWith('if exist')) ?? ''
  if (!line.includes('a.mp3')) throw new Error(line)
  if (line.includes('out.mp3')) throw new Error('status checks the pre-normalise file')
})
check('a script without a post step omits it entirely', () => {
  const plain = jobScript({ exe: 'uvx yt-dlp', args: ['x'], out: '%~dp0', log: '.b.log', status: '.b.status', mp3: 'b.mp3' })
  if (/ffmpeg/.test(plain)) throw new Error('ffmpeg leaked into a plain job')
})

// ── trimming an EXISTING clip ────────────────────────────────────────────
const trimOut = trimScript({ id: 'snd-abc', start: 0.5, length: 1.2, tmp: '.in.mp3', out: '.out.mp3' })

check('the trim script decodes the stored base64 first', () => {
  if (!/FromBase64String/.test(trimOut)) throw new Error('no decode step')
  if (!/ReadAllText\('%~dp0snd-abc\.b64'\)/.test(trimOut)) throw new Error(trimOut.split('\r\n')[3])
})
check('it cuts with ffmpeg using the requested window', () => {
  if (!/-ss 0\.5 -t 1\.2/.test(trimOut)) throw new Error('window missing')
  if (!/-b:a 128k/.test(trimOut)) throw new Error('no output encoding')
})
check('it re-encodes the result back into the .b64', () => {
  if (!/ToBase64String/.test(trimOut)) throw new Error('no encode step')
  if (!/WriteAllText\('%~dp0snd-abc\.b64'/.test(trimOut)) throw new Error('does not replace the original')
})
check('a failed cut reports fail instead of claiming ok', () => {
  if (!/if not exist "\.out\.mp3" \(echo fail>/.test(trimOut)) throw new Error('no failure branch')
  const lines = trimOut.split('\r\n')
  const failAt = lines.findIndex(l => l.includes('echo fail>'))
  const okAt = lines.findIndex(l => l.startsWith('echo ok>'))
  if (okAt < failAt) throw new Error('the ok line can run after a failure')
})
check('a from-0 window omits the -ss flag', () => {
  const zero = trimScript({ id: 'x', start: 0, length: 1, tmp: '.i', out: '.o' })
  if (/-ss/.test(zero)) throw new Error('emitted a pointless -ss 0')
})
check('the trim script anchors to %~dp0 and escapes no env var', () => {
  if (!trimOut.includes('cd /d "%~dp0"')) throw new Error('no anchor')
  if (/%APPDATA%/i.test(trimOut)) throw new Error('env var leaked')
})

// ── the launch command ──────────────────────────────────────────────────
const D = 'C:\\data dir'
const launch = detachedCommand(`${D}\\.yt-1.cmd`)
check('the launch is a single detached start', () => {
  if (launch !== `start "" /b "${D}\\.yt-1.cmd"`) throw new Error(launch)
})
check('the launch passes NO arguments', () => {
  // `start /b cmd /c "script.cmd" "arg"` drops every argument (verified here:
  // four forms arrived with none), so a script that needed one would silently
  // run with a bad path. The script bakes its paths in for exactly this reason.
  const after = launch.replace(`start "" /b "${D}\\.yt-1.cmd"`, '')
  if (after.trim()) throw new Error(`extra tokens: ${after}`)
})

console.log(`\n${pass}/${pass + fail} checks passed`)
if (fail) process.exitCode = 1
