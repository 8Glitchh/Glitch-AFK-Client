'use strict'
/**
 * Input validation for anything that becomes a network destination or is
 * persisted. Everything coming from the renderer is treated as untrusted and
 * normalised here before main-process code uses it.
 */
const net = require('net')

const HOSTNAME_RE = /^(?=.{1,253}$)(?!-)[A-Za-z0-9-]{1,63}(?<!-)(\.(?!-)[A-Za-z0-9-]{1,63}(?<!-))*\.?$/
// Offline-mode usernames: vanilla accepts 1-16 chars of [A-Za-z0-9_].
const USERNAME_RE = /^[A-Za-z0-9_]{1,16}$/
const VERSION_RE = /^\d+\.\d+(\.\d+)?$/

function validateHost (host) {
  if (typeof host !== 'string') return 'Server address is required.'
  const h = host.trim()
  if (!h) return 'Server address is required.'
  if (/[\s/\\@]/.test(h)) return 'Server address must be a hostname or IP address (no spaces, slashes, "@" or scheme).'
  if (net.isIP(h)) return null
  if (!HOSTNAME_RE.test(h)) return `"${h}" is not a valid hostname or IP address.`
  return null
}

function validatePort (port) {
  const n = Number(port)
  if (!Number.isInteger(n) || n < 1 || n > 65535) return 'Port must be a whole number between 1 and 65535.'
  return null
}

function validateUsername (name) {
  if (typeof name !== 'string' || !USERNAME_RE.test(name.trim())) {
    return 'Username must be 1–16 characters: letters, digits and underscore only.'
  }
  return null
}

function validateVersion (v) {
  if (v === 'auto' || v === '' || v == null) return null
  if (typeof v !== 'string' || !VERSION_RE.test(v)) return 'Version must be "auto" or look like 1.20.4.'
  return null
}

const clampInt = (v, min, max, dflt) => {
  const n = Math.round(Number(v))
  if (!Number.isFinite(n)) return dflt
  return Math.min(max, Math.max(min, n))
}
const clampNum = (v, min, max, dflt) => {
  const n = Number(v)
  if (!Number.isFinite(n)) return dflt
  return Math.min(max, Math.max(min, n))
}
const bool = (v, dflt) => (typeof v === 'boolean' ? v : dflt)
const str = (v, max, dflt = '') => (typeof v === 'string' ? v.slice(0, max) : dflt)

const DEFAULT_AFK = Object.freeze({
  autoStart: false,
  intervalSec: 45,
  jitterPct: 30,
  walk: true,
  walkMs: 400,
  rotate: true,
  rotateDeg: 25,
  jump: false,
  sneak: false,
  swingArm: true
})

function normalizeAfk (a = {}) {
  return {
    autoStart: bool(a.autoStart, DEFAULT_AFK.autoStart),
    intervalSec: clampInt(a.intervalSec, 5, 3600, DEFAULT_AFK.intervalSec),
    jitterPct: clampInt(a.jitterPct, 0, 90, DEFAULT_AFK.jitterPct),
    walk: bool(a.walk, DEFAULT_AFK.walk),
    walkMs: clampInt(a.walkMs, 100, 2000, DEFAULT_AFK.walkMs),
    rotate: bool(a.rotate, DEFAULT_AFK.rotate),
    rotateDeg: clampInt(a.rotateDeg, 1, 90, DEFAULT_AFK.rotateDeg),
    jump: bool(a.jump, DEFAULT_AFK.jump),
    sneak: bool(a.sneak, DEFAULT_AFK.sneak),
    swingArm: bool(a.swingArm, DEFAULT_AFK.swingArm)
  }
}

function normalizeJoinCommands (list) {
  if (!Array.isArray(list)) return []
  return list.slice(0, 50).map(c => ({
    delaySec: clampNum(c && c.delaySec, 0, 3600, 3),
    command: str(c && c.command, 256).replace(/[\r\n]/g, ' ').trim(),
    enabled: bool(c && c.enabled, true)
  })).filter(c => c.command.length > 0)
}

/**
 * Normalise a profile from the renderer. Throws an Error with a user-facing
 * message when a field is invalid. Never contains secrets.
 */
function normalizeProfile (p) {
  if (!p || typeof p !== 'object') throw new Error('Invalid profile.')
  const host = typeof p.host === 'string' ? p.host.trim() : ''
  const errs = [validateHost(host), validatePort(p.port), validateUsername(p.username), validateVersion(p.version)].filter(Boolean)
  if (errs.length) throw new Error(errs.join('\n'))
  const rc = p.reconnect || {}
  return {
    id: typeof p.id === 'string' && /^[a-f0-9-]{8,64}$/i.test(p.id) ? p.id : null,
    name: str(p.name, 64).trim() || host,
    host,
    port: Number(p.port),
    username: p.username.trim(),
    version: !p.version || p.version === 'auto' ? 'auto' : p.version,
    reconnect: {
      enabled: bool(rc.enabled, true),
      mode: rc.mode === 'fixed' ? 'fixed' : 'exponential',
      delaySec: clampInt(rc.delaySec, 1, 3600, 5),
      maxDelaySec: clampInt(rc.maxDelaySec, 1, 7200, 300),
      maxAttempts: clampInt(rc.maxAttempts, 0, 100000, 0),
      onKick: bool(rc.onKick, true)
    },
    afk: normalizeAfk(p.afk),
    joinCommands: normalizeJoinCommands(p.joinCommands)
  }
}

const DEFAULT_SETTINGS = Object.freeze({
  timestamps: true,
  maxChatLines: 1500,
  maxLogLines: 1500,
  showActionBar: false,
  showJoinLeave: true,
  debug: false,
  lowMemory: true,
  viewDistance: 'tiny',
  closeToTray: false,
  preventSleep: false,
  redactLoginCommands: true,
  alertWords: [],
  alertOnUsername: false,
  alertSound: true,
  alertVolume: 60,
  alertNotify: false
})

/** Ping words: trimmed, de-duplicated (case-insensitive), max 50 × 64 chars. */
function normalizeWords (list) {
  if (!Array.isArray(list)) return []
  const seen = new Set()
  const out = []
  for (const w of list) {
    if (typeof w !== 'string') continue
    const t = w.replace(/[\r\n\t]/g, ' ').trim().slice(0, 64)
    if (!t || seen.has(t.toLowerCase())) continue
    seen.add(t.toLowerCase())
    out.push(t)
    if (out.length >= 50) break
  }
  return out
}

function normalizeSettings (s = {}) {
  return {
    timestamps: bool(s.timestamps, DEFAULT_SETTINGS.timestamps),
    maxChatLines: clampInt(s.maxChatLines, 100, 20000, DEFAULT_SETTINGS.maxChatLines),
    maxLogLines: clampInt(s.maxLogLines, 100, 20000, DEFAULT_SETTINGS.maxLogLines),
    showActionBar: bool(s.showActionBar, DEFAULT_SETTINGS.showActionBar),
    showJoinLeave: bool(s.showJoinLeave, DEFAULT_SETTINGS.showJoinLeave),
    debug: bool(s.debug, DEFAULT_SETTINGS.debug),
    lowMemory: bool(s.lowMemory, DEFAULT_SETTINGS.lowMemory),
    viewDistance: ['tiny', 'short', 'normal', 'far'].includes(s.viewDistance) ? s.viewDistance : DEFAULT_SETTINGS.viewDistance,
    closeToTray: bool(s.closeToTray, DEFAULT_SETTINGS.closeToTray),
    preventSleep: bool(s.preventSleep, DEFAULT_SETTINGS.preventSleep),
    redactLoginCommands: bool(s.redactLoginCommands, DEFAULT_SETTINGS.redactLoginCommands),
    alertWords: normalizeWords(s.alertWords),
    alertOnUsername: bool(s.alertOnUsername, DEFAULT_SETTINGS.alertOnUsername),
    alertSound: bool(s.alertSound, DEFAULT_SETTINGS.alertSound),
    alertVolume: clampInt(s.alertVolume, 0, 100, DEFAULT_SETTINGS.alertVolume),
    alertNotify: bool(s.alertNotify, DEFAULT_SETTINGS.alertNotify)
  }
}

module.exports = {
  validateHost,
  validatePort,
  validateUsername,
  validateVersion,
  normalizeProfile,
  normalizeSettings,
  normalizeAfk,
  DEFAULT_AFK,
  DEFAULT_SETTINGS
}
