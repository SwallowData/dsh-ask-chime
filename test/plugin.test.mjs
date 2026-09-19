/**
 * Behaviour tests for dsh-ask-chime.
 *
 * The plugin is driven through its test seams — `install()` with a fake context
 * and a fake player, `buildCommands()` with an explicit platform — so the suite
 * never spawns a process and never depends on the machine it runs on.
 *
 *   node --test test/
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { apply, buildCommands, inject, install, name, playAlert, resolveOptions } from '../lib/index.js'

/** The questions seam as the harness really shapes it: `ask` lives on the prototype. */
class FakeUserQuestions {
  constructor() {
    this.calls = []
  }

  ask(request) {
    this.calls.push(request)
    return { answers: [], request }
  }
}

/** The agent registry as `install` reads it: root identity, never serialization. */
function fakeAgents() {
  const roots = []
  return {
    roots: () => roots,
    promote: (agent) => roots.push(agent),
  }
}

/** A minimal cordis context: `get`, `on`, and `effect` are all `install` reaches for. */
function fakeContext(service = new FakeUserQuestions()) {
  const listeners = new Map()
  const disposers = []
  const agents = fakeAgents()
  return {
    service,
    agents,
    listeners,
    ctx: {
      get(serviceName) {
        if (serviceName === 'userQuestions') return service
        if (serviceName === 'agents') return agents
        return undefined
      },
      on(event, listener) {
        listeners.set(event, listener)
        return () => listeners.delete(event)
      },
      effect(callback) {
        disposers.push(callback())
        return () => {}
      },
    },
    disposeAll() {
      for (const dispose of disposers) dispose()
    },
  }
}

/** Options as `apply` would resolve them, with the tone tail on. */
const OPTIONS = resolveOptions(undefined)

test('the plugin module declares its cordis identity', () => {
  assert.equal(name, 'ask-chime')
  assert.deepEqual(inject, ['userQuestions'])
})

test('resolveOptions defaults every field to on, with no sound override', () => {
  assert.deepEqual(resolveOptions(undefined), {
    enabled: true,
    questions: true,
    approvals: true,
    completed: true,
    tones: true,
    questionSound: null,
    approvalSound: null,
    completedSound: null,
    minTurnMs: 0,
  })
})

test('resolveOptions honours explicit switches and rejects blank overrides', () => {
  const options = resolveOptions({ enabled: false, approvals: false, tones: false, questionSound: '', approvalSound: 'C:\\sounds\\ping.wav' })
  assert.equal(options.enabled, false)
  assert.equal(options.approvals, false)
  assert.equal(options.tones, false)
  assert.equal(options.questionSound, null)
  assert.equal(options.approvalSound, 'C:\\sounds\\ping.wav')
})

test('windows plays the wav through powershell.exe, then the tone tail', () => {
  const commands = buildCommands('question', { platform: 'win32', ...OPTIONS })
  assert.equal(commands[0].file, 'powershell.exe')
  assert.equal(commands[1].file, 'pwsh.exe')
  const script = commands[0].args[commands[0].args.length - 1]
  assert.match(script, /System\.Media\.SoundPlayer/)
  assert.match(script, /PlaySync\(\)/)
  assert.match(script, /chimes\.wav/)
  assert.match(script, /\[console\]::beep\(1046,150\)/)
  assert.match(script, /SystemSounds\]::Asterisk/)
})

test('windows reports a silent run through its exit code', () => {
  const script = buildCommands('question', { platform: 'win32', ...OPTIONS })[0].args.at(-1)
  assert.match(script, /if\(\$ok\)\{exit 0\}else\{exit 1\}$/)
})

test('a partial options object still resolves the platform default sound', () => {
  // Regression: `buildCommands` is public API, so it must not depend on the
  // caller having gone through `resolveOptions` first — neither for the sound
  // file nor for the tone tail.
  const script = buildCommands('question', { platform: 'win32' })[0].args.at(-1)
  assert.match(script, /'chimes\.wav'/)
  assert.doesNotMatch(script, /undefined/)
  assert.match(script, /\[console\]::beep\(1046,150\)/)
  assert.deepEqual(buildCommands('question', { platform: 'darwin' })[0].args, ['/System/Library/Sounds/Glass.aiff'])
})

test('the tone tail is still dropped when tones is explicitly false', () => {
  const script = buildCommands('question', { platform: 'win32', tones: false })[0].args.at(-1)
  assert.doesNotMatch(script, /beep/)
  assert.match(script, /'chimes\.wav'/)
})

test('windows drops the tone tail when tones is disabled', () => {
  const script = buildCommands('approval', { platform: 'win32', ...OPTIONS, tones: false })[0].args.at(-1)
  assert.doesNotMatch(script, /beep/)
  assert.match(script, /Windows Notify Calendar\.wav/)
})

test('the two alert kinds use different tones', () => {
  const question = buildCommands('question', { platform: 'win32', ...OPTIONS })[0].args.at(-1)
  const approval = buildCommands('approval', { platform: 'win32', ...OPTIONS })[0].args.at(-1)
  assert.match(question, /beep\(1046,150\)/)
  assert.match(approval, /beep\(784,150\)/)
})

test('macOS plays a system sound with afplay', () => {
  const commands = buildCommands('question', { platform: 'darwin', ...OPTIONS })
  assert.deepEqual(commands, [{ file: 'afplay', args: ['/System/Library/Sounds/Glass.aiff'] }])
})

test('linux tries its players in order against the theme directories', () => {
  const commands = buildCommands('question', { platform: 'linux', ...OPTIONS })
  assert.equal(commands[0].file, 'paplay')
  assert.equal(commands[0].args[0], '/usr/share/sounds/freedesktop/stereo/dialog-question.oga')
  assert.ok(commands.length >= 3)
  assert.ok(commands.every((command) => command.args[0].endsWith('dialog-question.oga')))
})

test('an absolute sound override is used as-is instead of being re-rooted', () => {
  const absolute = '/opt/sounds/custom.oga'
  for (const command of buildCommands('question', { platform: 'linux', ...OPTIONS, questionSound: absolute })) {
    assert.equal(command.args[0], absolute)
  }
  assert.equal(buildCommands('question', { platform: 'darwin', ...OPTIONS, questionSound: absolute })[0].args[0], absolute)

  const windows = buildCommands('question', { platform: 'win32', ...OPTIONS, questionSound: 'D:\\sounds\\mine.wav' })[0].args.at(-1)
  assert.match(windows, /\$p='D:\\sounds\\mine\.wav'/)
  assert.match(windows, /IsPathRooted\(\$p\)/)
  assert.doesNotMatch(windows, /chimes\.wav/)
})

test('a quote in a sound name cannot escape the PowerShell literal', () => {
  const script = buildCommands('question', { platform: 'win32', ...OPTIONS, questionSound: "it's.wav" })[0].args.at(-1)
  assert.match(script, /'it''s\.wav'/)
})

test('playAlert falls through to the next candidate and reports total failure', async () => {
  const tried = []
  const spawn = (command, done) => {
    tried.push(command.file)
    done(command.file === 'paplay' ? new Error('ENOENT') : null)
  }
  const failures = await playAlert('question', { platform: 'linux', ...OPTIONS }, spawn)
  assert.equal(failures, null)
  assert.deepEqual(tried.slice(0, 2), ['paplay', 'pw-play'])

  const allFail = await playAlert('question', { platform: 'linux', ...OPTIONS }, (_command, done) => done(new Error('nope')))
  assert.equal(allFail.length, 6)
  assert.match(allFail[0], /^paplay: nope$/)
})

test('installing chimes once per question and forwards the call untouched', () => {
  const { ctx, service } = fakeContext()
  const played = []
  install(ctx, OPTIONS, (kind) => {
    played.push(kind)
    return null
  })

  const request = { questions: [] }
  const result = service.ask(request)

  assert.deepEqual(played, ['question'])
  assert.deepEqual(service.calls, [request])
  assert.deepEqual(result, { answers: [], request })
})

test('installing chimes on an approval and delegates the waterfall', () => {
  const { ctx, listeners } = fakeContext()
  const played = []
  install(ctx, OPTIONS, (kind) => {
    played.push(kind)
    return null
  })

  let delegated = false
  const listener = listeners.get('approval/request')
  assert.equal(typeof listener, 'function')
  listener({}, () => {
    delegated = true
    return 'allowed'
  })

  assert.deepEqual(played, ['approval'])
  assert.equal(delegated, true)
})

test('a broken sound can never break the question it announced', () => {
  const { ctx, service } = fakeContext()
  install(ctx, OPTIONS, () => {
    throw new Error('no audio device')
  })

  assert.deepEqual(service.ask({ questions: [] }), { answers: [], request: { questions: [] } })
  assert.deepEqual(service.calls.length, 1)
})

test('a rejected player promise is contained, not left unhandled', async () => {
  const { ctx, service } = fakeContext()
  install(ctx, OPTIONS, () => Promise.reject(new Error('player died')))

  assert.equal(service.ask({ questions: [] }).answers.length, 0)
  await new Promise((resolve) => setImmediate(resolve))
})

test('disposing restores the prototype method and stops the chime', () => {
  const { ctx, service, disposeAll } = fakeContext()
  const played = []
  install(ctx, OPTIONS, (kind) => {
    played.push(kind)
    return null
  })

  disposeAll()
  assert.equal(Object.hasOwn(service, 'ask'), false)

  service.ask({ questions: [] })
  assert.deepEqual(played, [])
})

test('disposing leaves a later wrapper in place', () => {
  const { ctx, service, disposeAll } = fakeContext()
  install(ctx, OPTIONS, () => null)

  const replacement = () => 'replacement'
  service.ask = replacement
  disposeAll()

  assert.equal(service.ask, replacement)
})

test('a second install over the same service does not stack wrappers', () => {
  const { ctx, service } = fakeContext()
  const played = []
  install(ctx, OPTIONS, (kind) => {
    played.push(kind)
    return null
  })
  const wrapped = service.ask
  install(ctx, OPTIONS, (kind) => {
    played.push(kind)
    return null
  })

  assert.equal(service.ask, wrapped)
  service.ask({ questions: [] })
  assert.deepEqual(played, ['question'])
})

test('config can silence one kind without touching the other', () => {
  const { ctx, listeners, service } = fakeContext()
  const played = []
  install(ctx, resolveOptions({ approvals: false }), (kind) => {
    played.push(kind)
    return null
  })

  service.ask({ questions: [] })
  assert.deepEqual(played, ['question'])
  assert.equal(listeners.has('approval/request'), false)
})

test('apply with enabled:false installs nothing at all', () => {
  const { ctx, listeners, service } = fakeContext()
  apply(ctx, { enabled: false })

  assert.equal(Object.hasOwn(service, 'ask'), false)
  assert.equal(listeners.size, 0)
})

test('apply arms both hooks with the default config', () => {
  const { ctx, listeners, service } = fakeContext()
  apply(ctx, undefined)

  assert.equal(typeof service.ask, 'function')
  assert.equal(service.ask.__askChime, true)
  assert.equal(listeners.has('approval/request'), true)
})

test('apply warns instead of throwing when the questions seam is missing', () => {
  const ctx = { get: () => undefined, on: () => () => {}, effect: () => () => {} }
  assert.doesNotThrow(() => apply(ctx, undefined))
})

test('a finished turn chimes once, for a root agent', () => {
  const { ctx, agents, listeners } = fakeContext()
  const played = []
  install(ctx, OPTIONS, (kind) => {
    played.push(kind)
    return null
  })

  const agent = { id: 'session-1' }
  agents.promote(agent)
  const status = listeners.get('agent/status')
  assert.equal(typeof status, 'function')

  status({ agent, status: 'running' })
  assert.deepEqual(played, [], 'starting work is not a finished turn')

  status({ agent, status: 'idle' })
  assert.deepEqual(played, ['done'])
})

test('a subagent settling does not chime', () => {
  const { ctx, listeners } = fakeContext()
  const played = []
  install(ctx, OPTIONS, (kind) => {
    played.push(kind)
    return null
  })

  const subagent = { id: 'sub-1' } // deliberately never promoted to a root
  listeners.get('agent/status')({ agent: subagent, status: 'running' })
  listeners.get('agent/status')({ agent: subagent, status: 'idle' })
  assert.deepEqual(played, [])
})

test('a malformed status payload is ignored rather than thrown', () => {
  const { ctx, listeners } = fakeContext()
  const played = []
  install(ctx, OPTIONS, (kind) => {
    played.push(kind)
    return null
  })

  const status = listeners.get('agent/status')
  for (const payload of [undefined, null, {}, { agent: null, status: 'idle' }, { agent: { id: 'x' } }]) {
    assert.doesNotThrow(() => status(payload))
  }
  assert.deepEqual(played, [])
})

test('completed:false silences the finished-turn chime only', () => {
  const { ctx, listeners, service } = fakeContext()
  const played = []
  install(ctx, resolveOptions({ completed: false }), (kind) => {
    played.push(kind)
    return null
  })

  assert.equal(listeners.has('agent/status'), false)
  service.ask({ questions: [] })
  assert.deepEqual(played, ['question'])
})

test('minTurnMs suppresses a turn shorter than the gate', () => {
  const gated = fakeContext()
  const played = []
  // A gate far beyond this suite's own runtime: every turn is "too short".
  install(gated.ctx, resolveOptions({ minTurnMs: 60000 }), (kind) => {
    played.push(kind)
    return null
  })

  const agent = { id: 'session-2' }
  gated.agents.promote(agent)
  gated.listeners.get('agent/status')({ agent, status: 'running' })
  gated.listeners.get('agent/status')({ agent, status: 'idle' })
  assert.deepEqual(played, [])

  // With the gate off, the same sequence chimes.
  const open = fakeContext()
  const replayed = []
  install(open.ctx, OPTIONS, (kind) => {
    replayed.push(kind)
    return null
  })

  const other = { id: 'session-3' }
  open.agents.promote(other)
  open.listeners.get('agent/status')({ agent: other, status: 'running' })
  open.listeners.get('agent/status')({ agent: other, status: 'idle' })
  assert.deepEqual(replayed, ['done'])
})

test('the done alert is a distinct sound and a three-note arpeggio', () => {
  const windows = buildCommands('done', { platform: 'win32', ...OPTIONS })[0].args.at(-1)
  assert.match(windows, /Windows Print complete\.wav/)
  assert.match(windows, /beep\(784,150\)/)
  assert.match(windows, /beep\(988,150\)/)
  assert.match(windows, /beep\(1319,320\)/)

  assert.deepEqual(buildCommands('done', { platform: 'darwin', ...OPTIONS })[0].args, ['/System/Library/Sounds/Hero.aiff'])
  assert.equal(buildCommands('done', { platform: 'linux', ...OPTIONS })[0].args[0], '/usr/share/sounds/freedesktop/stereo/complete.oga')
})

test('the three alerts never share a sound on any platform', () => {
  for (const platform of ['win32', 'darwin', 'linux']) {
    const sounds = ['question', 'approval', 'done'].map((kind) => buildCommands(kind, { platform, ...OPTIONS })[0].args.at(-1))
    assert.equal(new Set(sounds).size, 3, platform + ' must not reuse a sound across alerts')
  }
})

test('an unknown alert kind falls back to the question alert', () => {
  assert.deepEqual(
    buildCommands('nonsense', { platform: 'darwin', ...OPTIONS })[0].args,
    buildCommands('question', { platform: 'darwin', ...OPTIONS })[0].args,
  )
})
