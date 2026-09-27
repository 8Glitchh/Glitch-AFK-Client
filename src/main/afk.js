'use strict'
/**
 * Anti-AFK behaviour, independent of the connection itself.
 *
 * "Enabled" is a user intent that survives disconnects: while enabled and
 * connected the controller is ACTIVE, while enabled and offline it is WAITING
 * and resumes automatically on the next spawn.
 *
 * Each cycle does a tiny, self-cancelling routine (step forward then back,
 * small look, optional jump / sneak / arm swing) so the bot stays roughly in
 * place. One timer drives the cycle; every sub-timer is tracked and cleared
 * on stop or disconnect, and control states are always released.
 *
 * Only enable this on servers whose rules allow AFK prevention.
 */
const { EventEmitter } = require('events')
const { normalizeAfk } = require('./validate')

const rand = (min, max) => min + Math.random() * (max - min)
const DEG = Math.PI / 180

class AfkController extends EventEmitter {
  constructor (manager) {
    super()
    this.manager = manager
    this.enabled = false
    this.config = normalizeAfk({})
    this.cycleTimer = null
    this.subTimers = new Set()
    this.lastActionAt = null
    this.cycles = 0
    this.nextAt = null

    manager.on('online', () => this._sync())
    manager.on('offline', () => this._halt())
  }

  status () {
    const online = this.manager.isOnline()
    return {
      enabled: this.enabled,
      state: !this.enabled ? 'off' : online ? 'active' : 'waiting',
      lastActionAt: this.lastActionAt,
      nextAt: this.nextAt,
      cycles: this.cycles
    }
  }

  start (config) {
    if (config) this.config = normalizeAfk(config)
    if (!this.enabled) this.manager.log('info', 'AFK automation started.')
    this.enabled = true
    this._halt()
    this._sync()
  }

  stop () {
    if (this.enabled) this.manager.log('info', 'AFK automation stopped.')
    this.enabled = false
    this._halt()
    this._emit()
  }

  setConfig (config) {
    this.config = normalizeAfk(config)
    if (this.enabled) { this._halt(); this._sync() }
  }

  _emit () { this.emit('status', this.status()) }

  _sync () {
    if (this.enabled && this.manager.isOnline() && !this.cycleTimer) this._schedule()
    this._emit()
  }

  /** Stop timers and release every held key; keeps `enabled` as-is. */
  _halt () {
    if (this.cycleTimer) clearTimeout(this.cycleTimer)
    this.cycleTimer = null
    this.nextAt = null
    for (const t of this.subTimers) clearTimeout(t)
    this.subTimers.clear()
    const bot = this.manager.bot
    if (bot) { try { bot.clearControlStates() } catch {} }
    this._emit()
  }

  _schedule () {
    const { intervalSec, jitterPct } = this.config
    const j = jitterPct / 100
    const ms = Math.max(2000, intervalSec * 1000 * rand(1 - j, 1 + j))
    this.nextAt = Date.now() + ms
    this.cycleTimer = setTimeout(() => {
      this.cycleTimer = null
      this._cycle()
      if (this.enabled && this.manager.isOnline()) this._schedule()
      this._emit()
    }, ms)
  }

  _after (ms, fn) {
    const t = setTimeout(() => {
      this.subTimers.delete(t)
      if (!this.enabled || !this.manager.isOnline()) return
      try { fn() } catch (err) { this.manager.log('warn', `AFK action failed: ${err.message}`) }
    }, ms)
    this.subTimers.add(t)
  }

  _cycle () {
    const bot = this.manager.bot
    if (!bot || !bot.entity) return
    const c = this.config
    const done = []
    let t = 0 // running offset (ms) so actions don't overlap

    if (c.rotate) {
      const yaw = bot.entity.yaw + rand(-c.rotateDeg, c.rotateDeg) * DEG
      const pitch = Math.max(-0.6, Math.min(0.6, rand(-c.rotateDeg, c.rotateDeg) * DEG / 2))
      bot.look(yaw, pitch, false).catch(() => {})
      done.push('look')
      t += 250
    }
    if (c.swingArm) {
      this._after(t, () => bot.swingArm('right'))
      done.push('swing')
      t += 200
    }
    if (c.walk) {
      // Step forward, then the same distance back, so the bot doesn't drift.
      this._after(t, () => bot.setControlState('forward', true))
      this._after(t + c.walkMs, () => bot.setControlState('forward', false))
      this._after(t + c.walkMs + 150, () => bot.setControlState('back', true))
      this._after(t + 2 * c.walkMs + 150, () => bot.setControlState('back', false))
      done.push('walk')
      t += 2 * c.walkMs + 300
    }
    if (c.jump) {
      this._after(t, () => bot.setControlState('jump', true))
      this._after(t + 300, () => bot.setControlState('jump', false))
      done.push('jump')
      t += 500
    }
    if (c.sneak) {
      this._after(t, () => bot.setControlState('sneak', true))
      this._after(t + 700, () => bot.setControlState('sneak', false))
      done.push('sneak')
    }

    this.cycles++
    this.lastActionAt = Date.now()
    if (this.manager.getSettings().debug) this.manager.log('debug', `AFK cycle #${this.cycles}: ${done.join(', ') || 'nothing enabled'}`)
  }
}

module.exports = { AfkController }
