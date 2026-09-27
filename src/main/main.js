'use strict'
/**
 * Electron main process: window, tray, IPC and app lifecycle.
 *
 * Security posture:
 *  - Renderer is sandboxed with contextIsolation and no Node access; it talks
 *    to us only through the small API in preload.js.
 *  - All renderer input is validated in validate.js before use.
 *  - Navigation, new windows and permission requests are all denied.
 *  - No analytics, telemetry or update checks. The only network connection
 *    this app makes is to the Minecraft server you choose.
 */
const path = require('path')
const {
  app, BrowserWindow, ipcMain, dialog, clipboard, shell, Tray, Menu, nativeImage,
  powerSaveBlocker, session, Notification
} = require('electron')
const fs = require('fs')
const mineflayer = require('mineflayer')
const { Store } = require('./store')
const { SecretStore } = require('./secrets')
const { BotManager } = require('./botManager')
const { AfkController } = require('./afk')
const { RingBuffer } = require('./ringBuffer')

const DEV = process.argv.includes('--dev')
const ICON = path.join(__dirname, '..', '..', 'assets', 'icon.png')

// The UI is flat HTML — the GPU buys nothing, so leave it alone.
app.disableHardwareAcceleration()

// One instance only: two copies could log the same account in twice.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  run()
}

/**
 * The app was first released as "MC AFK Console". Carry saved servers and
 * settings over once. (Remembered passwords can't move: they're encrypted with
 * a key tied to the old data folder, so they need to be entered again.)
 */
function migrateFromOldName (dataDir) {
  try {
    const oldDir = path.join(path.dirname(dataDir), 'MC AFK Console')
    if (fs.existsSync(path.join(dataDir, 'profiles.json')) || !fs.existsSync(oldDir)) return
    fs.mkdirSync(dataDir, { recursive: true })
    for (const f of ['profiles.json', 'settings.json']) {
      const src = path.join(oldDir, f)
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dataDir, f))
    }
  } catch { /* best effort */ }
}

function run () {
  let win = null
  let tray = null
  let quitting = false
  let sleepBlockId = null

  const dataDir = app.getPath('userData')
  migrateFromOldName(dataDir)
  const store = new Store(dataDir)
  const secrets = new SecretStore(dataDir)
  let settings = store.getSettings()

  const chatHistory = new RingBuffer(settings.maxChatLines)
  const logHistory = new RingBuffer(settings.maxLogLines)
  const sessionSecrets = new Map() // profileId -> secret typed this session (memory only)

  const manager = new BotManager({ getSettings: () => settings })
  const afk = new AfkController(manager)

  // ---------------------------------------------------------- push to renderer
  // Events are batched and flushed at most every 100 ms so a chat flood or
  // debug packet storm can't saturate IPC.
  let pending = null
  let flushTimer = null
  function queue (key, value) {
    if (!pending) pending = { chat: [], logs: [] }
    if (key === 'chat' || key === 'logs') pending[key].push(value)
    else pending[key] = value
    if (!flushTimer) flushTimer = setTimeout(flush, 100)
  }
  function flush () {
    flushTimer = null
    const batch = pending
    pending = null
    if (batch && win && !win.isDestroyed()) win.webContents.send('push', batch)
  }

  const addLog = entry => { logHistory.push(entry); queue('logs', entry) }
  const log = (level, text) => addLog({ ts: Date.now(), level, text })

  manager.on('log', addLog)
  manager.on('chat', entry => { chatHistory.push(entry); queue('chat', entry) })
  manager.on('status', s => { queue('status', s); updateTray(); updateSleepBlock() })
  manager.on('info', i => queue('info', i))
  afk.on('status', s => { queue('afk', s); updateTray() })

  manager.on('online', () => {
    const p = manager.profile
    if (p && p.afk.autoStart && !afk.enabled) afk.start(p.afk)
  })

  // Anything unexpected is logged instead of killing a multi-day session.
  // Windows notification for chat alerts, only while the window isn't focused.
  manager.on('mention', entry => {
    if (!settings.alertNotify || (win && win.isVisible() && win.isFocused()) || !Notification.isSupported()) return
    const n = new Notification({ title: 'Glitch AFK Client — mentioned', body: entry.text.slice(0, 200), silent: true, icon: fs.existsSync(ICON) ? ICON : undefined })
    n.on('click', showWindow)
    n.show()
  })

  process.on('uncaughtException', err => log('error', `Unexpected error: ${err && err.stack ? err.stack.split('\n').slice(0, 3).join(' | ') : err}`))
  process.on('unhandledRejection', err => log('error', `Unhandled promise rejection: ${err && err.message ? err.message : err}`))

  // ---------------------------------------------------------- window
  function createWindow () {
    win = new BrowserWindow({
      width: 1280,
      height: 800,
      minWidth: 900,
      minHeight: 560,
      backgroundColor: '#0f1115',
      title: 'Glitch AFK Client',
      icon: fs.existsSync(ICON) ? ICON : undefined,
      show: false,
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
        backgroundThrottling: true,
        devTools: DEV
      }
    })
    win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'))
    win.once('ready-to-show', () => win.show())
    if (DEV) win.webContents.openDevTools({ mode: 'detach' })

    win.webContents.on('will-navigate', e => e.preventDefault())
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

    win.on('close', e => {
      if (!quitting && settings.closeToTray && tray) {
        e.preventDefault()
        win.hide()
      }
    })
    win.on('closed', () => { win = null })
  }

  function showWindow () {
    if (!win) createWindow()
    else { if (win.isMinimized()) win.restore(); win.show(); win.focus() }
  }

  // ---------------------------------------------------------- tray
  function ensureTray () {
    if (!settings.closeToTray) {
      if (tray) { tray.destroy(); tray = null }
      return
    }
    if (tray) return
    const img = fs.existsSync(ICON) ? nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 }) : nativeImage.createEmpty()
    tray = new Tray(img)
    tray.on('click', showWindow)
    updateTray()
  }

  function updateTray () {
    if (!tray) return
    const s = manager.status()
    const a = afk.status()
    tray.setToolTip(`Glitch AFK Client — ${s.state}${s.destination ? ` (${s.destination})` : ''}${a.enabled ? `, AFK ${a.state}` : ''}`)
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Show', click: showWindow },
      { label: 'Disconnect', enabled: s.state !== 'idle', click: () => manager.disconnect() },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() }
    ]))
  }

  // Keep Windows from suspending the process during long sessions (opt-in).
  function updateSleepBlock () {
    const want = settings.preventSleep && manager.state !== 'idle'
    if (want && sleepBlockId === null) sleepBlockId = powerSaveBlocker.start('prevent-app-suspension')
    else if (!want && sleepBlockId !== null) { powerSaveBlocker.stop(sleepBlockId); sleepBlockId = null }
  }

  // ---------------------------------------------------------- IPC
  // Every handler returns { ok, data } or { ok: false, error } so the UI can
  // show a readable message instead of an opaque rejection.
  function handle (channel, fn) {
    ipcMain.handle(channel, async (event, ...args) => {
      if (!win || event.sender !== win.webContents) return { ok: false, error: 'Unknown sender.' }
      try { return { ok: true, data: await fn(...args) } } catch (err) { return { ok: false, error: err && err.message ? err.message : String(err) } }
    })
  }

  const profilesWithFlags = () => store.listProfiles().map(p => ({ ...p, hasSecret: secrets.has(p.id) || sessionSecrets.has(p.id), secretSaved: secrets.has(p.id) }))

  handle('app:bootstrap', () => {
    // The snapshot below already contains everything queued so far; drop the
    // queue so the renderer doesn't receive those entries twice.
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null }
    pending = null
    return bootstrapSnapshot()
  })

  const bootstrapSnapshot = () => ({
    profiles: profilesWithFlags(),
    settings,
    status: manager.status(),
    info: manager.info(),
    afk: afk.status(),
    afkConfig: afk.config,
    chat: chatHistory.toArray(),
    logs: logHistory.toArray(),
    versions: [...mineflayer.testedVersions].reverse(),
    secureStorage: secrets.available(),
    dataDir,
    appVersion: app.getVersion()
  })

  handle('profiles:save', input => {
    const p = store.saveProfile(input)
    manager.updateProfile(p)
    if (afk.enabled && manager.profile && manager.profile.id === p.id) afk.setConfig(p.afk)
    return { profile: p, profiles: profilesWithFlags() }
  })

  handle('profiles:delete', id => {
    if (manager.profile && manager.profile.id === id && manager.state !== 'idle') throw new Error('Disconnect before deleting the active server.')
    store.deleteProfile(id)
    secrets.delete(id)
    sessionSecrets.delete(id)
    return profilesWithFlags()
  })

  handle('settings:save', input => {
    const prevDebug = settings.debug
    settings = store.saveSettings(input)
    chatHistory.resize(settings.maxChatLines)
    logHistory.resize(settings.maxLogLines)
    if (prevDebug !== settings.debug) manager.setDebug(settings.debug)
    ensureTray()
    updateSleepBlock()
    return settings
  })

  // Secrets: the renderer can set/forget, never read.
  handle('secret:set', (profileId, secret, persist) => {
    if (typeof profileId !== 'string' || typeof secret !== 'string' || !secret) throw new Error('Invalid secret.')
    if (secret.length > 256) throw new Error('Secret is too long.')
    sessionSecrets.set(profileId, secret)
    manager.setSecret(profileId, secret)
    if (persist) secrets.set(profileId, secret)
    return profilesWithFlags()
  })

  handle('secret:delete', profileId => {
    secrets.delete(profileId)
    sessionSecrets.delete(profileId)
    manager.setSecret(profileId, null)
    return profilesWithFlags()
  })

  handle('bot:connect', profileId => {
    const p = store.getProfile(profileId)
    if (!p) throw new Error('Server profile not found. Save it first.')
    const secret = sessionSecrets.get(p.id) || secrets.get(p.id)
    if (afk.enabled) afk.setConfig(p.afk)
    manager.connect(p, secret)
    return manager.status()
  })

  handle('bot:disconnect', () => { manager.disconnect(); return manager.status() })
  handle('bot:reconnect', () => { manager.reconnectNow(); return manager.status() })
  handle('bot:chat', text => {
    if (typeof text !== 'string') throw new Error('Invalid message.')
    manager.sendChat(text)
  })

  handle('afk:start', config => { afk.start(config); return afk.status() })
  handle('afk:stop', () => { afk.stop(); return afk.status() })

  const formatLine = (e, withTs) => `${withTs ? `[${new Date(e.ts).toLocaleString()}] ` : ''}${e.level ? `${e.level.toUpperCase()} ` : ''}${e.text}`

  handle('chat:clear', () => { chatHistory.clear() })
  // Copy/export follow what's visible: join/leave lines are left out while that toggle is off.
  const visibleChat = () => chatHistory.toArray().filter(e => settings.showJoinLeave || (e.kind !== 'join' && e.kind !== 'leave'))
  handle('chat:copy', () => { clipboard.writeText(visibleChat().map(e => formatLine(e, settings.timestamps)).join('\r\n')) })
  handle('chat:export', () => exportText('chat', visibleChat()))
  handle('logs:clear', () => { logHistory.clear() })
  handle('logs:export', () => exportText('log', logHistory.toArray()))
  handle('app:openDataDir', () => shell.openPath(dataDir))

  async function exportText (kind, entries) {
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
    const res = await dialog.showSaveDialog(win, {
      title: `Export ${kind}`,
      defaultPath: path.join(app.getPath('documents'), `glitch-afk-${kind}-${stamp}.txt`),
      filters: [{ name: 'Text', extensions: ['txt'] }]
    })
    if (res.canceled || !res.filePath) return null
    await fs.promises.writeFile(res.filePath, entries.map(e => formatLine(e, true)).join('\r\n') + '\r\n', 'utf8')
    return res.filePath
  }

  // ---------------------------------------------------------- lifecycle
  app.on('second-instance', showWindow)

  app.whenReady().then(() => {
    Menu.setApplicationMenu(null)
    session.defaultSession.setPermissionRequestHandler((wc, perm, cb) => cb(false))
    createWindow()
    ensureTray()
    log('info', `Glitch AFK Client ${app.getVersion()} started. Data folder: ${dataDir}`)
    if (!secrets.available()) log('warn', 'OS secure storage is unavailable — passwords can only be kept for the current session.')
  })

  // Close the Minecraft connection cleanly before exiting.
  app.on('before-quit', e => {
    if (quitting) return
    e.preventDefault()
    quitting = true
    afk.stop()
    manager.shutdown().finally(() => {
      if (sleepBlockId !== null) powerSaveBlocker.stop(sleepBlockId)
      if (tray) tray.destroy()
      app.exit(0)
    })
  })

  app.on('window-all-closed', () => {
    if (!settings.closeToTray) app.quit()
  })
}
