'use strict'
/**
 * Local JSON persistence for profiles and settings.
 *
 * Files live in Electron's per-user data folder (on Windows:
 * %APPDATA%\Glitch AFK Client). Nothing here ever contains a password — secrets
 * are handled separately by secrets.js using OS-level encryption.
 *
 * Writes are atomic (write temp file, then rename) so a crash or power loss
 * during a multi-day session can't leave a half-written config behind.
 */
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { normalizeProfile, normalizeSettings } = require('./validate')

class JsonFile {
  constructor (file, fallback) {
    this.file = file
    this.fallback = fallback
  }

  read () {
    try {
      let raw = fs.readFileSync(this.file, 'utf8')
      if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1) // tolerate a BOM from hand edits
      return JSON.parse(raw)
    } catch (err) {
      if (err.code !== 'ENOENT') {
        // Keep the unreadable file for the user instead of silently overwriting it.
        try { fs.copyFileSync(this.file, this.file + '.corrupt-' + Date.now()) } catch {}
      }
      return structuredClone(this.fallback)
    }
  }

  write (data) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    const tmp = this.file + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
    fs.renameSync(tmp, this.file)
  }
}

class Store {
  constructor (dir) {
    this.dir = dir
    this.profilesFile = new JsonFile(path.join(dir, 'profiles.json'), { profiles: [] })
    this.settingsFile = new JsonFile(path.join(dir, 'settings.json'), {})
  }

  listProfiles () {
    const data = this.profilesFile.read()
    const out = []
    for (const p of Array.isArray(data.profiles) ? data.profiles : []) {
      try {
        const n = normalizeProfile(p)
        n.id = p.id
        out.push(n)
      } catch { /* skip entries that no longer validate */ }
    }
    return out
  }

  getProfile (id) {
    return this.listProfiles().find(p => p.id === id) || null
  }

  saveProfile (input) {
    const profile = normalizeProfile(input)
    const profiles = this.listProfiles()
    if (!profile.id) profile.id = crypto.randomUUID()
    const idx = profiles.findIndex(p => p.id === profile.id)
    if (idx >= 0) profiles[idx] = profile
    else profiles.push(profile)
    this.profilesFile.write({ profiles })
    return profile
  }

  deleteProfile (id) {
    const profiles = this.listProfiles().filter(p => p.id !== id)
    this.profilesFile.write({ profiles })
  }

  getSettings () {
    return normalizeSettings(this.settingsFile.read())
  }

  saveSettings (input) {
    const s = normalizeSettings(input)
    this.settingsFile.write(s)
    return s
  }
}

module.exports = { Store }
