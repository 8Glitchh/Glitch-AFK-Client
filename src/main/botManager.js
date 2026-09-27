'use strict'
/**
 * BotManager owns the (single) Mineflayer bot.
 *
 * Invariants that keep long AFK sessions healthy:
 *  - At most ONE live bot exists. Every connection gets a generation number;
 *    events from an older generation are ignored, and the old bot is torn down
 *    before a new one is created.
 *  - Every timer this class creates is tracked and cleared when the
 *    connection ends, and all listeners are removed from the dead bot.
 *  - Nothing received from the server is ever executed. Chat is turned into
 *    plain text / colour codes and handed to the UI as data.
 *
 * Authentication is always 'offline': only a username is sent. No Microsoft or
 * Mojang login is performed or supported.
 */
const { EventEmitter } = require('events')
const mineflayer = require('mineflayer')

const MASK = '••••••'
const CONNECT_TIMEOUT_MS = 45_000 // give up on a connection attempt that never spawns
const STABLE_AFTER_MS = 60_000 // reset reconnect back-off after this long online
const JOIN_LEAVE_GRACE_MS = 5_000 // the server sends the full tab list on join; don't spam it
const INFO_INTERVAL_MS = 1_000

// Mineflayer plugins nothing in this app depends on. Disabling them in
// low-memory mode drops their listeners and state entirely.
const LEAF_PLUGINS = [
  'anvil', 'bed', 'book', 'boss_bar', 'chest', 'command_block', 'craft', 'creative',
  'digging', 'enchantment_table', 'explosion', 'fishing', 'furnace', 'generic_place',
  'particle', 'place_block', 'place_entity', 'sound', 'title', 'villager'
]

// Very chatty packets that would drown the debug console.
const NOISY_PACKETS = new Set([
  'map_chunk', 'unload_chunk', 'light_update', 'chunk_batch_start', 'chunk_batch_finished',
  'chunk_biomes', 'rel_entity_move', 'entity_move_look', 'entity_look', 'entity_head_rotation',
  'entity_velocity', 'entity_teleport', 'entity_metadata', 'entity_update_attributes',
  'sync_entity_position', 'multi_block_change', 'block_change', 'update_time', 'keep_alive',
  'sound_effect', 'entity_sound_effect', 'world_particles', 'bundle_delimiter', 'entity_equipment',
  'ping', 'ping_response', 'damage_event', 'animation', 'hurt_animation', 'update_view_position'
])

class BotManager extends EventEmitter {
  constructor ({ getSettings }) {
    super()
    this.getSettings = getSettings
    this.bot = null
    this.gen = 0
    this.state = 'idle' // idle | connecting | online | reconnecting
    this.profile = null
    this.secret = null
    this.attempts = 0
    this.userStopped = true
    this.shuttingDown = false
    this.timers = new Set() // per-connection timers
    this.reconnectTimer = null
    this.reconnectAt = null
    this.lastError = null
    this.lastKick = null
    this.remote = null
    this.spawnedAt = null
    this.lastMessage = null
    this._lastInfoJson = ''
    this._packetListener = null
    this._packetBudget = { windowStart: 0, count: 0, dropped: 0 }
  }

  // ---------------------------------------------------------------- helpers

  log (level, text) { this.emit('log', { ts: Date.now(), level, text }) }

  chat (kind, text, motd, mention = false) {
    const entry = { ts: Date.now(), kind, text, motd: motd || null }
    if (mention) entry.mention = true
    this.emit('chat', entry)
    if (mention) this.emit('mention', entry)
  }

  /**
   * Chat alerts ("ping words"): true when someone else's message contains one
   * of the user's words, or the bot's username if that option is on. Matches
   * are case-insensitive whole words, so "al" doesn't fire on "all".
   * Our own messages never count — neither the 1.19+ signed sender nor the
   * "<Name> …" / "Name: …" prefix a server echoes back.
   */
  _isMention (text, sender, bot) {
    const s = this.getSettings()
    const words = [...s.alertWords]
    // Lines that start with our own name ("Name joined the game") are about us, not to us.
    const aboutUs = bot.username && new RegExp(`^${escapeRe(bot.username)}([^A-Za-z0-9_]|$)`, 'i').test(text)
    if (s.alertOnUsername && bot.username && !aboutUs) words.push(bot.username)
    if (!words.length) return false
    if (sender && bot.player && sender === bot.player.uuid) return false
    let body = text
    const own = bot.username ? bot.username.toLowerCase() : null
    // Drop a leading sender prefix like "<Name> ", "[Rank] Name: " or "Name » ".
    const m = /^(.{0,48}?)(?:>|:|»)\s/.exec(text)
    if (m) {
      if (own && new RegExp(`(^|[^A-Za-z0-9_])${escapeRe(own)}([^A-Za-z0-9_]|$)`, 'i').test(m[1])) return false
      body = text.slice(m[0].length)
    }
    return words.some(w => new RegExp(`(^|[^A-Za-z0-9_])${escapeRe(w)}([^A-Za-z0-9_]|$)`, 'i').test(body))
  }

  _timeout (fn, ms) {
    const t = setTimeout(() => { this.timers.delete(t); fn() }, ms)
    this.timers.add(t)
    return t
  }

  _interval (fn, ms) {
    const t = setInterval(fn, ms)
    this.timers.add(t)
    return t
  }

  _clearTimers () {
    for (const t of this.timers) { clearTimeout(t); clearInterval(t) }
    this.timers.clear()
  }

  _cancelReconnect () {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    this.reconnectAt = null
  }

  _setState (state) {
    this.state = state
    this.emit('status', this.status())
    this._pushInfo(true)
  }

  isOnline () { return this.state === 'online' && !!this.bot }

  /** Hide the stored secret and login-command arguments in anything we echo or log. */
  redact (text) {
    let t = String(text)
    if (this.secret) t = t.split(this.secret).join(MASK)
    if (this.getSettings().redactLoginCommands) {
      t = t.replace(/^(\/(?:login|log|l|register|reg|changepassword|changepass|cp)\s+)(.+)$/i,
        (_, cmd, args) => cmd + args.split(/\s+/).map(() => MASK).join(' '))
    }
    return t
  }

  status () {
    return {
      state: this.state,
      profileId: this.profile ? this.profile.id : null,
      profileName: this.profile ? this.profile.name : null,
      destination: this.profile ? `${this.profile.host}:${this.profile.port}` : null,
      remote: this.remote,
      attempts: this.attempts,
      reconnectAt: this.reconnectAt,
      lastError: this.lastError,
      lastKick: this.lastKick
    }
  }

  // ---------------------------------------------------------------- public API

  /** Start a fresh connection. Any existing connection is closed first. */
  connect (profile, secret) {
    if (this.shuttingDown) return
    this._cancelReconnect()
    this._teardown('Switching connection')
    this.profile = profile
    this.secret = secret || null
    this.attempts = 0
    this.userStopped = false
    this.lastError = null
    this.lastKick = null
    this._open()
  }

  /** Update settings of the active profile (AFK, reconnect, join commands) without reconnecting. */
  updateProfile (profile) {
    if (this.profile && profile.id === this.profile.id) this.profile = profile
  }

  setSecret (profileId, secret) {
    if (this.profile && this.profile.id === profileId) this.secret = secret || null
  }

  disconnect () {
    this.userStopped = true
    this._cancelReconnect()
    const had = !!this.bot
    this._teardown('Disconnected by user')
    this.attempts = 0
    if (had) this.log('info', 'Disconnected by user.')
    this._setState('idle')
  }

  reconnectNow () {
    if (!this.profile) throw new Error('No server selected.')
    this._cancelReconnect()
    this._teardown('Manual reconnect')
    this.userStopped = false
    this.attempts = 0
    this.log('info', 'Manual reconnect requested.')
    this._open()
  }

  sendChat (text) {
    if (!this.isOnline()) throw new Error('Not connected.')
    // Strip control characters (including § which vanilla rejects) and newlines.
    const msg = String(text).replace(/[\u0000-\u001f\u007f§]/g, '').trim()
    if (!msg) return
    if (msg.length > 256) throw new Error('Message is longer than 256 characters.')
    this.bot.chat(msg)
    // Local echo of what we sent; most servers will also broadcast it back as normal chat.
    this.chat('self', this.redact(msg))
  }

  setDebug (on) {
    if (!this.bot) return
    this._detachPacketDebug()
    if (on) this._attachPacketDebug(this.bot, this.gen)
  }

  /** Close everything; resolves once the socket is closed (or after a short timeout). */
  shutdown () {
    this.shuttingDown = true
    this.userStopped = true
    this._cancelReconnect()
    const bot = this.bot
    if (!bot) return Promise.resolve()
    return new Promise(resolve => {
      const done = setTimeout(resolve, 1500)
      bot.once('end', () => { clearTimeout(done); resolve() })
      this._teardown('Application closing')
    })
  }

  // ---------------------------------------------------------------- connection lifecycle

  _open () {
    const gen = ++this.gen
    const p = this.profile
    const settings = this.getSettings()
    this.remote = null
    this.spawnedAt = null
    this.lastMessage = null
    this.lastKick = null
    this._setState('connecting')
    this.log('info', `Connecting to ${p.host}:${p.port} as "${p.username}" (offline mode, version ${p.version})…`)

    const plugins = {}
    if (settings.lowMemory) for (const name of LEAF_PLUGINS) plugins[name] = false

    let bot
    try {
      bot = mineflayer.createBot({
        host: p.host,
        port: p.port,
        username: p.username,
        auth: 'offline', // never anything else
        version: p.version === 'auto' ? false : p.version,
        viewDistance: settings.viewDistance,
        hideErrors: true,
        logErrors: false,
        checkTimeoutInterval: 60_000,
        respawn: true,
        plugins
      })
    } catch (err) {
      this.log('error', `Could not start connection: ${err.message}`)
      this.lastError = err.message
      this._onEnded(gen, 'error')
      return
    }
    this.bot = bot

    // Abort attempts that hang (unreachable host, unsupported version, …).
    this._timeout(() => {
      if (gen === this.gen && this.state === 'connecting') {
        this.lastError = `No login within ${CONNECT_TIMEOUT_MS / 1000}s`
        this.log('error', `Connection attempt timed out after ${CONNECT_TIMEOUT_MS / 1000}s.`)
        try { bot.end('timeout') } catch {}
        try { bot._client.socket && bot._client.socket.destroy() } catch {}
        // If the socket never opened, 'end' might not fire. Emit it ourselves:
        // mineflayer's plugins (e.g. the 20 Hz physics loop) clean up on 'end'.
        this._timeout(() => { if (gen === this.gen) bot.emit('end', 'timeout') }, 2000)
      }
    }, CONNECT_TIMEOUT_MS)

    const live = fn => (...args) => { if (gen === this.gen) { try { fn(...args) } catch (err) { this.log('error', `Handler error: ${err.message}`) } } }

    bot._client.on('connect', live(() => {
      const s = bot._client.socket
      this.remote = s && s.remoteAddress ? `${s.remoteAddress}:${s.remotePort}` : null
      this.log('info', `TCP connected${this.remote ? ` to ${this.remote}` : ''}.`)
      this.emit('status', this.status())
    }))

    bot.once('login', live(() => {
      this.log('info', `Logged in as ${bot.username} — server version ${bot.version}.`)
    }))

    let firstSpawn = true
    bot.on('spawn', live(() => {
      if (!firstSpawn) { this.log('info', `Respawned / changed dimension (${bot.game && bot.game.dimension}).`); return }
      firstSpawn = false
      this.spawnedAt = Date.now()
      this.log('info', 'Spawned in world.')
      this.chat('info', `Connected to ${p.host}:${p.port} as ${bot.username}.`)
      this._setState('online')
      this._timeout(() => { this.attempts = 0 }, STABLE_AFTER_MS)
      this._interval(() => this._pushInfo(false), INFO_INTERVAL_MS)
      this._runJoinCommands(gen)
      if (this.getSettings().debug) this._attachPacketDebug(bot, gen)
      this.emit('online', bot)
    }))

    bot.on('message', live((jsonMsg, position, sender) => {
      const settings = this.getSettings()
      if (position === 'game_info' && !settings.showActionBar) return
      const text = jsonMsg.toString()
      if (!text.trim()) return
      let motd = null
      try { motd = jsonMsg.toMotd() } catch {}
      const kind = position === 'game_info' ? 'actionbar' : position === 'system' ? 'system' : 'chat'
      this.lastMessage = { ts: Date.now(), text: text.slice(0, 300) }
      const mention = kind !== 'actionbar' && this._isMention(text, sender, bot)
      this.chat(kind, text, motd, mention)
    }))

    bot.on('playerJoined', live(player => {
      if (!this.spawnedAt || Date.now() - this.spawnedAt < JOIN_LEAVE_GRACE_MS) return
      if (player.username === bot.username) return
      this.chat('join', `${player.username} joined (tab list)`)
    }))
    bot.on('playerLeft', live(player => {
      if (player.username === bot.username) return
      this.chat('leave', `${player.username} left (tab list)`)
    }))

    bot.on('death', live(() => {
      this.chat('error', 'You died. Respawning automatically.')
      this.log('warn', 'Bot died; auto-respawn requested.')
    }))

    bot.on('kicked', live((reason, loggedIn) => {
      const text = reasonToText(reason, bot)
      this.lastKick = text
      this.lastError = `Kicked: ${text}`
      this.log('error', `Kicked by server${loggedIn ? '' : ' during login'}: ${text}`)
      this.chat('error', `Kicked: ${text}`)
    }))

    bot.on('error', live(err => {
      const msg = describeError(err)
      this.lastError = msg
      this.log('error', msg)
    }))

    bot.on('end', live(reason => this._onEnded(gen, reason)))
  }

  /** Common path for every way a connection can finish. */
  _onEnded (gen, reason) {
    if (gen !== this.gen) return
    const bot = this.bot
    const wasOnline = this.state === 'online'
    this.gen++ // anything still in flight from this bot is now stale
    this._clearTimers()
    this._detachPacketDebug()
    this.bot = null
    if (bot) quiet(bot)
    this.spawnedAt = null
    this.emit('offline')

    const r = reason ? String(reason) : 'unknown'
    this.log(wasOnline ? 'warn' : 'error', `Connection ended (${r}).`)
    if (wasOnline) this.chat('error', `Disconnected (${this.lastKick ? 'kicked' : r}).`)

    if (this.userStopped || this.shuttingDown) { this._setState('idle'); return }

    const rc = this.profile.reconnect
    const kicked = !!this.lastKick
    if (!rc.enabled) { this._setState('idle'); return }
    if (kicked && !rc.onKick) {
      this.log('warn', 'Auto-reconnect skipped: "reconnect after kick" is off.')
      this._setState('idle'); return
    }
    if (rc.maxAttempts > 0 && this.attempts >= rc.maxAttempts) {
      this.log('error', `Auto-reconnect gave up after ${this.attempts} attempts.`)
      this._setState('idle'); return
    }
    this._scheduleReconnect()
  }

  _scheduleReconnect () {
    const rc = this.profile.reconnect
    this.attempts++
    let delay = rc.delaySec
    if (rc.mode === 'exponential') {
      delay = Math.min(rc.maxDelaySec, rc.delaySec * 2 ** (this.attempts - 1))
      delay *= 0.9 + Math.random() * 0.2 // ±10% jitter so many clients don't sync up
    }
    const ms = Math.round(delay * 1000)
    this.reconnectAt = Date.now() + ms
    this.log('info', `Reconnect attempt #${this.attempts} in ${(ms / 1000).toFixed(1)}s.`)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.reconnectAt = null
      if (!this.userStopped && !this.shuttingDown) this._open()
    }, ms)
    this._setState('reconnecting')
  }

  /** Stop the current bot (if any) without triggering auto-reconnect. */
  _teardown (reason) {
    const bot = this.bot
    if (!bot) return
    const wasOnline = this.state === 'online'
    this.gen++
    this._clearTimers()
    this._detachPacketDebug()
    this.bot = null
    this.spawnedAt = null
    this.emit('offline')
    const destroy = () => { try { bot._client.socket && bot._client.socket.destroy() } catch {} }
    try { bot.quit(reason) } catch {}
    // A graceful end doesn't complete mid-handshake, so a half-open attempt is
    // destroyed right away (and if its socket only appears later, e.g. after
    // the version-detect ping, as soon as it connects). Otherwise the server
    // would briefly see two logins for the same username.
    if (!wasOnline) {
      destroy()
      try { bot._client.once('connect', destroy) } catch {}
    }
    const force = setTimeout(destroy, wasOnline ? 1500 : 250)
    bot.once('end', () => { clearTimeout(force); quiet(bot) })
    // Swallow any late errors from the closing socket.
    bot.on('error', () => {})
  }

  // ---------------------------------------------------------------- features

  _runJoinCommands (gen) {
    const cmds = (this.profile.joinCommands || []).filter(c => c.enabled)
    for (const c of cmds) {
      this._timeout(() => {
        if (gen !== this.gen || !this.isOnline()) return
        let text = c.command
        if (text.includes('{{password}}')) {
          if (!this.secret) {
            this.log('warn', `Join command skipped — it uses {{password}} but no password is set: ${this.redact(text)}`)
            this.chat('error', `Skipped "${text}": no password set. Enter it in the server settings (tick "Remember securely" to keep it after restarts).`)
            return
          }
          text = text.split('{{password}}').join(this.secret)
        }
        try {
          this.sendChat(text)
          this.log('info', `Join command sent (+${c.delaySec}s): ${this.redact(text)}`)
        } catch (err) {
          this.log('error', `Join command failed: ${err.message}`)
        }
      }, c.delaySec * 1000)
    }
  }

  info () {
    const bot = this.bot
    const base = {
      state: this.state,
      destination: this.profile ? `${this.profile.host}:${this.profile.port}` : null,
      remote: this.remote,
      connectedSince: this.spawnedAt,
      lastMessage: this.lastMessage,
      attempts: this.attempts,
      reconnectAt: this.reconnectAt,
      lastError: this.lastError
    }
    if (!bot || this.state !== 'online') return base
    const pos = bot.entity && bot.entity.position
    return {
      ...base,
      serverVersion: bot.version || null,
      username: bot.username || null,
      health: typeof bot.health === 'number' ? Math.round(bot.health * 10) / 10 : null,
      food: typeof bot.food === 'number' ? bot.food : null,
      position: pos ? { x: Math.round(pos.x * 10) / 10, y: Math.round(pos.y * 10) / 10, z: Math.round(pos.z * 10) / 10 } : null,
      dimension: (bot.game && bot.game.dimension) || null,
      gameMode: (bot.game && bot.game.gameMode) || null,
      ping: bot.player && typeof bot.player.ping === 'number' ? bot.player.ping : null,
      players: bot.players ? Object.keys(bot.players).length : null
    }
  }

  /** Emit info only when something changed, so an idle AFK session sends nothing. */
  _pushInfo (force) {
    const info = this.info()
    const json = JSON.stringify(info)
    if (!force && json === this._lastInfoJson) return
    this._lastInfoJson = json
    this.emit('info', info)
  }

  _attachPacketDebug (bot, gen) {
    const budget = this._packetBudget
    this._packetListener = (data, meta) => {
      if (gen !== this.gen || NOISY_PACKETS.has(meta.name)) return
      const now = Date.now()
      if (now - budget.windowStart > 1000) {
        if (budget.dropped) this.log('debug', `… ${budget.dropped} packets not shown (rate limit)`)
        budget.windowStart = now; budget.count = 0; budget.dropped = 0
      }
      if (++budget.count > 25) { budget.dropped++; return }
      let body = ''
      try { body = JSON.stringify(data, (k, v) => typeof v === 'bigint' ? v.toString() : (v && v.type === 'Buffer' ? `<${v.data.length} bytes>` : v)) } catch { body = '<unserialisable>' }
      if (body.length > 300) body = body.slice(0, 300) + '…'
      this.log('debug', `⇐ ${meta.state}/${meta.name} ${body}`)
    }
    this._packetBot = bot
    bot._client.on('packet', this._packetListener)
    this.log('debug', 'Raw packet logging enabled (noisy packets filtered, 25/s max).')
  }

  _detachPacketDebug () {
    if (this._packetListener && this._packetBot) {
      try { this._packetBot._client.removeListener('packet', this._packetListener) } catch {}
    }
    this._packetListener = null
    this._packetBot = null
  }
}

/** Remove our listeners from a dead bot, keeping a no-op 'error' sink so late errors can't crash the app. */
function quiet (bot) {
  try {
    bot.removeAllListeners()
    bot.on('error', () => {})
    if (bot._client) {
      bot._client.removeAllListeners('packet')
      bot._client.on('error', () => {})
    }
  } catch {}
}

function escapeRe (s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }

function reasonToText (reason, bot) {
  try {
    if (reason == null) return 'no reason given'
    const ChatMessage = require('prismarine-chat')(bot.registry)
    return ChatMessage.fromNotch(reason).toString() || String(reason)
  } catch {
    return typeof reason === 'string' ? reason : JSON.stringify(reason)
  }
}

function describeError (err) {
  if (!err) return 'Unknown error'
  switch (err.code) {
    case 'ECONNREFUSED': return `Connection refused by ${err.address || 'server'}:${err.port || ''} — is the server running and the port correct?`
    case 'ENOTFOUND': return `Server address not found (DNS lookup failed for ${err.hostname || 'host'}).`
    case 'ETIMEDOUT': return 'Connection timed out — the server did not respond.'
    case 'ECONNRESET': return 'Connection reset by the server.'
    case 'EHOSTUNREACH': return 'Host unreachable.'
    default: return err.message || String(err)
  }
}

module.exports = { BotManager }
