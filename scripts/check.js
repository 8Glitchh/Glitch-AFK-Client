'use strict'
/**
 * Project self-check: `npm run check`
 *
 *  1. Syntax-checks every source file.
 *  2. Unit-checks validation and the ring buffer.
 *  3. End-to-end: starts a throwaway LOCAL offline-mode server (via
 *     minecraft-protocol, which mineflayer already depends on) and drives the
 *     real BotManager + AfkController through connect → spawn → join commands
 *     → chat both ways → kick → auto-reconnect → AFK → disconnect, then checks
 *     no timers or bots were left behind.
 *
 * Nothing leaves your machine: the test server listens on 127.0.0.1 only.
 */
const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const assert = require('assert')

const root = path.join(__dirname, '..')
let failures = 0
const ok = msg => console.log(`  ✓ ${msg}`)
const fail = (msg, err) => { failures++; console.log(`  ✗ ${msg}${err ? `\n    ${err.stack || err}` : ''}`) }

function walk (dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(d =>
    d.isDirectory() ? walk(path.join(dir, d.name)) : d.name.endsWith('.js') ? [path.join(dir, d.name)] : [])
}

async function main () {
  console.log('1) Syntax')
  for (const f of [...walk(path.join(root, 'src')), ...walk(path.join(root, 'scripts'))]) {
    try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }); ok(path.relative(root, f)) } catch (e) { fail(path.relative(root, f), e.stderr.toString()) }
  }

  console.log('2) Units')
  const v = require('../src/main/validate')
  try {
    assert.strictEqual(v.validateHost('play.example.com'), null)
    assert.strictEqual(v.validateHost('127.0.0.1'), null)
    assert.strictEqual(v.validateHost('::1'), null)
    assert.ok(v.validateHost('http://x.com'))
    assert.ok(v.validateHost('bad host'))
    assert.ok(v.validateHost(''))
    assert.ok(v.validatePort(0)); assert.ok(v.validatePort(70000)); assert.strictEqual(v.validatePort(25565), null)
    assert.ok(v.validateUsername('way_too_long_username_x')); assert.ok(v.validateUsername('bad name'))
    const p = v.normalizeProfile({ host: ' mc.test ', port: '25565', username: 'Bot_1', joinCommands: [{ delaySec: 3, command: '/login {{password}}\n' }, { command: '' }] })
    assert.strictEqual(p.host, 'mc.test'); assert.strictEqual(p.version, 'auto'); assert.strictEqual(p.joinCommands.length, 1)
    assert.strictEqual(p.joinCommands[0].command, '/login {{password}}')
    assert.throws(() => v.normalizeProfile({ host: 'x', port: 1, username: '' }))
    ok('validation')
  } catch (e) { fail('validation', e) }
  try {
    const { RingBuffer } = require('../src/main/ringBuffer')
    const rb = new RingBuffer(3)
    for (let i = 1; i <= 5; i++) rb.push(i)
    assert.deepStrictEqual(rb.toArray(), [3, 4, 5])
    rb.resize(2); assert.deepStrictEqual(rb.toArray(), [4, 5])
    ok('ring buffer')
  } catch (e) { fail('ring buffer', e) }

  console.log('3) End-to-end against a local offline-mode server')
  try { await e2e(); } catch (e) { fail('end-to-end', e) }

  console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed.')
  process.exit(failures ? 1 : 0)
}

function waitFor (emitter, event, pred = () => true, ms = 20000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { emitter.removeListener(event, h); reject(new Error(`timeout waiting for ${event}`)) }, ms)
    function h (...a) { if (pred(...a)) { clearTimeout(t); emitter.removeListener(event, h); resolve(a) } }
    emitter.on(event, h)
  })
}

async function e2e () {
  const mc = require('minecraft-protocol')
  const { BotManager } = require('../src/main/botManager')
  const { AfkController } = require('../src/main/afk')
  const { normalizeProfile, normalizeSettings } = require('../src/main/validate')

  const VERSION = '1.8.8'
  const server = mc.createServer({ 'online-mode': false, host: '127.0.0.1', port: 0, version: VERSION, motd: 'check' })
  await new Promise(r => server.on('listening', r))
  const port = server.socketServer.address().port

  const received = [] // chat the server got from the client
  const serverEvents = new (require('events').EventEmitter)()
  let logins = 0
  server.on('login', client => {
    logins++
    client.on('error', () => {})
    client.write('login', { entityId: 1, gameMode: 0, dimension: 0, difficulty: 1, maxPlayers: 20, levelType: 'default', reducedDebugInfo: false })
    client.write('position', { x: 0.5, y: 64, z: 0.5, yaw: 0, pitch: 0, flags: 0 })
    client.write('update_health', { health: 18, food: 17, foodSaturation: 5 })
    client.write('chat', { message: JSON.stringify({ text: '', extra: [{ text: 'Welcome ', color: 'gold' }, { text: 'Bot' }] }), position: 0 })
    client.on('chat', p => { received.push(p.message); serverEvents.emit('chat', p.message, client) })
    client.on('arm_animation', () => serverEvents.emit('swing'))
    serverEvents.emit('login', client)
  })

  const settings = normalizeSettings({ debug: false })
  const mgr = new BotManager({ getSettings: () => settings })
  const afk = new AfkController(mgr)
  const chat = []
  const logs = []
  mgr.on('chat', e => chat.push(e))
  mgr.on('log', e => logs.push(e))
  mgr.on('online', () => { const p = mgr.profile; if (p.afk.autoStart) afk.start(p.afk) })

  const profile = normalizeProfile({
    host: '127.0.0.1', port, username: 'CheckBot', version: VERSION,
    reconnect: { enabled: true, mode: 'fixed', delaySec: 1 },
    afk: { autoStart: false, intervalSec: 5, jitterPct: 0, walk: true, rotate: true, swingArm: true },
    joinCommands: [{ delaySec: 0.3, command: '/login {{password}}' }, { delaySec: 0.6, command: '/s2' }, { delaySec: 0.2, command: '/x {{password}}', enabled: false }]
  })
  profile.id = 'check-profile-0001'

  try {
    // --- connect & spawn
    const online1 = waitFor(mgr, 'online')
    mgr.connect(profile, 's3cret-pw')
    await online1
    assert.strictEqual(mgr.state, 'online'); ok('connects in offline mode and spawns')

    // --- join commands with {{password}}, disabled one skipped
    await waitFor(serverEvents, 'chat', m => m === '/s2')
    assert.deepStrictEqual(received.slice(0, 2), ['/login s3cret-pw', '/s2']); ok('join commands sent in order, password substituted, disabled skipped')
    const echoed = chat.filter(e => e.kind === 'self').map(e => e.text).join('\n') + logs.map(l => l.text).join('\n')
    assert.ok(!echoed.includes('s3cret-pw'), 'password leaked into chat/log'); ok('password masked in chat echo and logs')

    // --- chat both ways
    assert.ok(chat.some(e => e.kind === 'chat' && e.text === 'Welcome Bot' && e.motd.includes('§6'))); ok('receives server chat with colour codes')
    mgr.sendChat('hello world')
    await waitFor(serverEvents, 'chat', m => m === 'hello world'); ok('sends chat typed by the user')

    // --- chat alerts: off by default, then ping words + own username; never our own echoed message
    assert.deepStrictEqual([settings.alertWords, settings.alertOnUsername], [[], false]); ok('no ping words and no username ping by default')
    settings.alertWords = ['diamond']
    settings.alertOnUsername = true
    const sc = Object.values(server.clients)[0]
    const say = t => sc.write('chat', { message: JSON.stringify({ text: t }), position: 0 })
    const pinged = []
    const onMention = e => pinged.push(e.text)
    mgr.on('mention', onMention)
    say('<CheckBot> hello CheckBot'); say('CheckBot joined the game'); say('<Alex> hey CheckBot'); say('<Alex> found a Diamond'); say('<Alex> diamonds')
    await waitFor(mgr, 'chat', e => e.text === '<Alex> diamonds')
    mgr.removeListener('mention', onMention)
    assert.deepStrictEqual(pinged, ['<Alex> hey CheckBot', '<Alex> found a Diamond']); ok('ping words + username mentions detected; own echo, "joined" line and partial words ignored')

    // --- info snapshot
    await new Promise(r => setTimeout(r, 300))
    const info = mgr.info()
    assert.strictEqual(info.health, 18); assert.strictEqual(info.food, 17); assert.strictEqual(info.serverVersion, VERSION)
    assert.ok(info.position && info.position.y === 64); ok(`info panel data (health ${info.health}, food ${info.food}, pos y ${info.position.y}, v${info.serverVersion})`)

    // --- AFK
    const swung = waitFor(serverEvents, 'swing', () => true, 12000)
    afk.start(profile.afk)
    assert.strictEqual(afk.status().state, 'active')
    await swung; ok('AFK cycle runs (arm swing reached the server)')

    // --- kick -> auto reconnect; AFK waits then resumes
    const kickedClient = Object.values(server.clients)[0]
    const online2 = waitFor(mgr, 'online')
    kickedClient.end('Server restarting') // the test server wraps this as {"text": ...}
    await waitFor(mgr, 'status', s => s.state === 'reconnecting')
    assert.strictEqual(afk.status().state, 'waiting'); ok('kick detected → reconnect scheduled; AFK waiting')
    assert.strictEqual(mgr.lastKick, 'Server restarting'); ok(`kick reason parsed to plain text: "${mgr.lastKick}"`)
    await online2
    assert.strictEqual(logins, 2); assert.strictEqual(afk.status().state, 'active'); ok('reconnected automatically; AFK resumed')

    // --- only ever one connection
    const online3 = waitFor(mgr, 'online')
    mgr.connect(profile, 's3cret-pw'); mgr.connect(profile, 's3cret-pw')
    await online3
    await new Promise(r => setTimeout(r, 500))
    assert.strictEqual(Object.keys(server.clients).length, 1, `server sees ${Object.keys(server.clients).length} clients`); ok('repeated connect() never leaves duplicate connections')

    // --- disconnect cleans up
    mgr.disconnect()
    await new Promise(r => setTimeout(r, 800))
    assert.strictEqual(mgr.state, 'idle'); assert.strictEqual(mgr.bot, null)
    assert.strictEqual(mgr.timers.size, 0); assert.strictEqual(mgr.reconnectTimer, null)
    assert.strictEqual(afk.subTimers.size, 0); assert.strictEqual(afk.cycleTimer, null)
    assert.strictEqual(Object.keys(server.clients).length, 0)
    ok('disconnect: no bot, no timers, no reconnect, server socket closed')
    afk.stop()

    // --- unreachable server reports a readable error
    const closedPort = port
    server.close()
    await new Promise(r => setTimeout(r, 300))
    const errLog = waitFor(mgr, 'log', l => l.level === 'error' && /refused/i.test(l.text))
    const idle = waitFor(mgr, 'status', s => s.state === 'idle')
    mgr.connect({ ...profile, port: closedPort, reconnect: { ...profile.reconnect, enabled: false } })
    await errLog
    await idle
    ok('connection refused → clear error, returns to idle (no reconnect when disabled)')
  } finally {
    await mgr.shutdown()
    try { server.close() } catch {}
  }
}

main()
