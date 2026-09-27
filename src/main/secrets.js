'use strict'
/**
 * Optional per-profile secret storage (e.g. an AuthMe /login password).
 *
 * Secrets are NEVER written in plaintext. They are encrypted with Electron's
 * safeStorage API, which delegates to the operating system:
 *   - Windows: DPAPI (bound to your Windows user account)
 *   - macOS:   Keychain
 *   - Linux:   libsecret / kwallet
 * Only the encrypted blob is stored in secrets.json. If OS encryption is not
 * available we refuse to store anything rather than fall back to plaintext.
 *
 * The decrypted value never leaves the main process: the renderer can only ask
 * "is there a saved secret?", set one, or delete one.
 */
const fs = require('fs')
const path = require('path')
const { safeStorage } = require('electron')

class SecretStore {
  constructor (dir) {
    this.file = path.join(dir, 'secrets.json')
  }

  available () {
    try { return safeStorage.isEncryptionAvailable() } catch { return false }
  }

  _read () {
    try { return JSON.parse(fs.readFileSync(this.file, 'utf8')) || {} } catch { return {} }
  }

  _write (data) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    const tmp = this.file + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(data), 'utf8')
    fs.renameSync(tmp, this.file)
  }

  has (profileId) {
    return typeof this._read()[profileId] === 'string'
  }

  set (profileId, secret) {
    if (!this.available()) throw new Error('OS secure storage is not available on this system, so the secret was not saved. It will be kept in memory for this session only.')
    if (typeof secret !== 'string' || !secret) throw new Error('Secret is empty.')
    const data = this._read()
    data[profileId] = safeStorage.encryptString(secret).toString('base64')
    this._write(data)
  }

  get (profileId) {
    const enc = this._read()[profileId]
    if (typeof enc !== 'string' || !this.available()) return null
    try { return safeStorage.decryptString(Buffer.from(enc, 'base64')) } catch { return null }
  }

  delete (profileId) {
    const data = this._read()
    if (profileId in data) {
      delete data[profileId]
      this._write(data)
    }
  }
}

module.exports = { SecretStore }
