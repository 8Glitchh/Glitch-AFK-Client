'use strict';
/**
 * Renderer UI. Plain DOM, no framework — keeps the window light.
 * All actions go through window.api (preload.js); every call returns
 * { ok, data } or { ok: false, error }.
 */
(() => {
  const $ = id => document.getElementById(id)
  const api = window.api

  const S = {
    profiles: [],
    selectedId: null, // server highlighted in the sidebar
    editingId: null, // server open in the editor (null = new)
    settings: {},
    status: { state: 'idle' },
    info: {},
    afk: { state: 'off', enabled: false },
    afkConfig: null,
    versions: [],
    secureStorage: false,
    view: 'chat',
    chatHistory: [], // sent-message history for ↑/↓
    chatHistoryPos: -1
  }

  // ------------------------------------------------------------ utilities

  function toast (msg, kind = 'info', ms = 4000) {
    const el = document.createElement('div')
    el.className = `toast ${kind}`
    el.textContent = msg
    $('toasts').appendChild(el)
    setTimeout(() => el.remove(), ms)
  }

  /** Call the API; show errors as toasts. Returns data or undefined. */
  async function call (fn, ...args) {
    let res
    try { res = await fn(...args) } catch (err) { res = { ok: false, error: err.message } }
    if (!res || !res.ok) { toast((res && res.error) || 'Something went wrong.', 'error', 6000); return undefined }
    return res.data === undefined ? true : res.data
  }

  const profileById = id => S.profiles.find(p => p.id === id) || null
  const activeProfile = () => profileById(S.status.profileId)
  const isBusy = () => S.status.state !== 'idle'

  // ------------------------------------------------------------ views

  function showView (view) {
    S.view = view
    document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === `view-${view}`))
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.view === view))
    if (view === 'chat') scrollChatToBottom()
    if (view === 'logs') renderLogs()
    if (view === 'afk') fillAfkForm()
  }

  document.querySelectorAll('.nav-btn').forEach(b => b.addEventListener('click', () => showView(b.dataset.view)))

  // ------------------------------------------------------------ top bar & status

  const STATE_LABEL = { idle: 'Disconnected', connecting: 'Connecting…', online: 'Connected', reconnecting: 'Reconnecting' }

  function renderStatus () {
    const st = S.status
    const pill = $('statusPill')
    const errState = st.state === 'idle' && st.lastError
    pill.dataset.state = errState ? 'error' : st.state
    let label = STATE_LABEL[st.state] || st.state
    if (st.state === 'reconnecting' && st.reconnectAt) label += ` in ${Math.max(0, Math.ceil((st.reconnectAt - Date.now()) / 1000))}s (#${st.attempts})`
    if (errState) label = 'Disconnected (error)'
    $('statusText').textContent = label
    pill.title = st.lastError || ''

    const sel = profileById(S.selectedId)
    const dest = st.state !== 'idle' ? st.destination : sel ? `${sel.host}:${sel.port}` : null
    const showRemote = st.remote && st.state !== 'idle' && st.remote !== st.destination
    $('destText').textContent = dest ? `→ ${dest}${showRemote ? `  (${st.remote})` : ''}` : 'No server selected'

    const switching = sel && st.state !== 'idle' && st.profileId !== sel.id
    $('btnConnect').disabled = !sel || (st.state !== 'idle' && !switching)
    $('btnConnect').textContent = switching ? `Switch to ${sel.name}` : 'Connect'
    $('btnDisconnect').disabled = st.state === 'idle'
    $('btnReconnect').disabled = !st.profileId

    const online = st.state === 'online'
    $('chatInput').disabled = !online
    $('btnSend').disabled = !online
    $('chatInput').placeholder = online ? 'Type a message or /command and press Enter' : 'Connect to a server to chat. Commands start with /'
    renderServerList()
  }

  function renderAfk () {
    const a = S.afk
    const labels = { off: 'AFK off', active: 'AFK active', waiting: 'AFK waiting' }
    for (const [pill, text] of [['afkPill', 'afkText'], ['afkPill2', 'afkText2']]) {
      $(pill).dataset.state = a.state
      $(text).textContent = labels[a.state] || a.state
    }
    $('afkPill').title = a.state === 'waiting' ? 'AFK is on and will resume after the next spawn' : ''
    $('btnAfkToggle').textContent = a.enabled ? 'Stop AFK' : 'Start AFK'
    $('btnAfkToggle').classList.toggle('primary', !a.enabled)
    $('btnAfkToggle').classList.toggle('danger', a.enabled)
    renderAfkStats()
  }

  function renderAfkStats () {
    const a = S.afk
    const now = Date.now()
    const items = [
      ['Status', a.state],
      ['Cycles', a.cycles || 0],
      ['Last action', a.lastActionAt ? `${Fmt.duration(now - a.lastActionAt)} ago` : '—'],
      ['Next action', a.nextAt ? `in ${Math.max(0, Math.ceil((a.nextAt - now) / 1000))}s` : '—']
    ]
    const box = $('afkStats')
    box.replaceChildren(...items.map(([k, v]) => {
      const d = document.createElement('div')
      const s = document.createElement('span'); s.textContent = k
      const b = document.createElement('b'); b.textContent = v
      d.append(s, b)
      return d
    }))
  }

  $('btnConnect').addEventListener('click', async () => {
    const sel = profileById(S.selectedId)
    if (!sel) return
    if (isBusy() && S.status.profileId !== sel.id && !confirm(`Disconnect from ${S.status.profileName} and connect to ${sel.name}?`)) return
    const st = await call(api.connect, sel.id)
    if (st) { S.status = st; renderStatus(); showView('chat') }
  })
  $('btnDisconnect').addEventListener('click', async () => {
    const st = await call(api.disconnect)
    if (st) { S.status = st; renderStatus() }
  })
  $('btnReconnect').addEventListener('click', async () => {
    const st = await call(api.reconnect)
    if (st) { S.status = st; renderStatus() }
  })

  // ------------------------------------------------------------ server list

  function renderServerList () {
    const ul = $('serverList')
    if (!S.profiles.length) {
      const li = document.createElement('div')
      li.className = 'server-empty'
      li.textContent = 'No servers yet. Click ＋ to add one.'
      ul.replaceChildren(li)
      return
    }
    ul.replaceChildren(...S.profiles.map(p => {
      const li = document.createElement('li')
      li.dataset.id = p.id
      li.dataset.state = S.status.profileId === p.id ? S.status.state : 'idle'
      li.classList.toggle('selected', p.id === S.selectedId)
      li.title = 'Click to select, double-click to connect'
      const dot = document.createElement('span'); dot.className = 'sdot'
      const name = document.createElement('span'); name.className = 'sname'; name.textContent = p.name
      const edit = document.createElement('button'); edit.className = 'icon-btn edit'; edit.textContent = '✎'; edit.title = 'Edit server'
      const addr = document.createElement('span'); addr.className = 'saddr'; addr.textContent = `${p.username} @ ${p.host}:${p.port}`
      li.append(dot, name, edit, addr)
      li.addEventListener('click', e => {
        S.selectedId = p.id
        if (e.target === edit) openEditor(p.id)
        renderStatus()
        if (S.view === 'afk') fillAfkForm()
      })
      li.addEventListener('dblclick', e => { if (e.target !== edit && !isBusy()) $('btnConnect').click() })
      return li
    }))
  }

  $('btnNewProfile').addEventListener('click', () => openEditor(null))

  // ------------------------------------------------------------ profile editor

  function fillVersionSelect (current) {
    const sel = $('pVersion')
    const opts = ['auto', ...S.versions]
    if (current && !opts.includes(current)) opts.push(current)
    sel.replaceChildren(...opts.map(v => {
      const o = document.createElement('option')
      o.value = v
      o.textContent = v === 'auto' ? 'Auto detect' : v
      return o
    }))
    sel.value = current || 'auto'
  }

  function addJoinRow (cmd = { delaySec: 3, command: '', enabled: true }) {
    const row = document.createElement('div')
    row.className = 'join-row'
    const en = document.createElement('input'); en.type = 'checkbox'; en.checked = cmd.enabled !== false; en.title = 'Enabled'; en.className = 'en'
    const delayWrap = document.createElement('span'); delayWrap.className = 'delay'
    const delay = document.createElement('input'); delay.type = 'number'; delay.min = '0'; delay.max = '3600'; delay.step = '0.5'; delay.value = cmd.delaySec; delay.className = 'dl'
    delayWrap.append(delay, 's')
    const text = document.createElement('input'); text.className = 'cmd'; text.maxLength = 256; text.placeholder = '/login {{password}}'; text.value = cmd.command
    const del = document.createElement('button'); del.type = 'button'; del.className = 'icon-btn'; del.textContent = '✕'; del.title = 'Remove'
    del.addEventListener('click', () => row.remove())
    row.append(en, delayWrap, text, del)
    $('joinList').appendChild(row)
  }

  function openEditor (id) {
    S.editingId = id
    const p = id ? profileById(id) : null
    $('serverTitle').textContent = p ? `Edit — ${p.name}` : 'New server'
    $('btnDeleteProfile').classList.toggle('hidden', !p)
    $('pName').value = p ? p.name : ''
    $('pHost').value = p ? p.host : ''
    $('pPort').value = p ? p.port : 25565
    $('pUsername').value = p ? p.username : ''
    fillVersionSelect(p ? p.version : 'auto')
    const rc = p ? p.reconnect : { enabled: true, onKick: true, mode: 'exponential', delaySec: 5, maxDelaySec: 300, maxAttempts: 0 }
    $('rcEnabled').checked = rc.enabled
    $('rcOnKick').checked = rc.onKick
    $('rcMode').value = rc.mode
    $('rcDelay').value = rc.delaySec
    $('rcMaxDelay').value = rc.maxDelaySec
    $('rcMaxAttempts').value = rc.maxAttempts
    $('joinList').replaceChildren()
    for (const c of p ? p.joinCommands : []) addJoinRow(c)
    $('pSecret').value = ''
    $('pSecretRemember').checked = false
    $('pSecretRemember').disabled = !S.secureStorage
    renderSecretState(p)
    $('profileError').textContent = ''
    document.querySelectorAll('#profileForm .invalid').forEach(el => el.classList.remove('invalid'))
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'))
    document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === 'view-server'))
    S.view = 'server'
    $('pHost').focus()
  }

  function renderSecretState (p) {
    let text
    if (!S.secureStorage) text = 'OS secure storage is unavailable, so the password is kept in memory for this session only.'
    else if (p && p.secretSaved) text = '✓ A password is saved, encrypted with your Windows account (DPAPI). Leave blank to keep it.'
    else if (p && p.hasSecret) text = 'A password is set for this session only (not saved to disk).'
    else text = 'Not saved by default. Tick “Remember securely” to store it encrypted with your Windows account (DPAPI), never as plaintext.'
    $('secretState').textContent = text
    $('btnForgetSecret').classList.toggle('hidden', !(p && p.hasSecret))
  }

  $('btnAddJoin').addEventListener('click', () => addJoinRow())

  function readProfileForm () {
    const existing = S.editingId ? profileById(S.editingId) : null
    return {
      id: S.editingId || undefined,
      name: $('pName').value.trim(),
      host: $('pHost').value.trim(),
      port: Number($('pPort').value),
      username: $('pUsername').value.trim(),
      version: $('pVersion').value,
      reconnect: {
        enabled: $('rcEnabled').checked,
        onKick: $('rcOnKick').checked,
        mode: $('rcMode').value,
        delaySec: Number($('rcDelay').value),
        maxDelaySec: Number($('rcMaxDelay').value),
        maxAttempts: Number($('rcMaxAttempts').value)
      },
      afk: existing ? existing.afk : undefined,
      joinCommands: [...document.querySelectorAll('#joinList .join-row')].map(r => ({
        enabled: r.querySelector('.en').checked,
        delaySec: Number(r.querySelector('.dl').value),
        command: r.querySelector('.cmd').value
      }))
    }
  }

  /** Mirror of the main-process validation so problems show next to the field. */
  function validateForm (p) {
    const errs = []
    const mark = (id, bad) => $(id).classList.toggle('invalid', bad)
    const hostOk = /^[A-Za-z0-9.:\-[\]]+$/.test(p.host) && p.host.length > 0
    mark('pHost', !hostOk); if (!hostOk) errs.push('Enter a valid server address (hostname or IP, without port).')
    const portOk = Number.isInteger(p.port) && p.port >= 1 && p.port <= 65535
    mark('pPort', !portOk); if (!portOk) errs.push('Port must be 1–65535.')
    const userOk = /^[A-Za-z0-9_]{1,16}$/.test(p.username)
    mark('pUsername', !userOk); if (!userOk) errs.push('Username: 1–16 letters, digits or _.')
    const secret = $('pSecret').value
    for (const c of p.joinCommands) {
      if (secret && c.command.includes(secret)) errs.push('A join command contains your password in plain text. Use {{password}} instead.')
    }
    return errs
  }

  async function saveProfile () {
    const input = readProfileForm()
    const errs = validateForm(input)
    $('profileError').textContent = errs.join('\n')
    if (errs.length) return null
    const res = await call(api.saveProfile, input)
    if (!res) return null
    S.profiles = res.profiles
    const p = res.profile
    const secret = $('pSecret').value
    if (secret) {
      const persist = $('pSecretRemember').checked
      const updated = await call(api.setSecret, p.id, secret, persist)
      if (updated) S.profiles = updated
      $('pSecret').value = ''
    }
    S.selectedId = p.id
    S.editingId = p.id
    renderSecretState(profileById(p.id))
    $('serverTitle').textContent = `Edit — ${p.name}`
    $('btnDeleteProfile').classList.remove('hidden')
    renderStatus()
    toast(`Saved “${p.name}”.`, 'ok', 2000)
    return p
  }

  $('profileForm').addEventListener('submit', e => { e.preventDefault(); saveProfile() })
  $('btnSaveConnect').addEventListener('click', async () => {
    const p = await saveProfile()
    if (!p) return
    if (isBusy() && S.status.profileId !== p.id && !confirm(`Disconnect from ${S.status.profileName} and connect to ${p.name}?`)) return
    if (isBusy() && S.status.profileId === p.id) {
      if (!confirm('Reconnect now to apply the new settings?')) return
    }
    const st = await call(api.connect, p.id)
    if (st) { S.status = st; renderStatus(); showView('chat') }
  })

  $('btnDeleteProfile').addEventListener('click', async () => {
    const p = profileById(S.editingId)
    if (!p || !confirm(`Delete server “${p.name}”? Any saved password for it is deleted too.`)) return
    const list = await call(api.deleteProfile, p.id)
    if (!list) return
    S.profiles = list
    if (S.selectedId === p.id) S.selectedId = S.profiles[0] ? S.profiles[0].id : null
    showView('chat')
    renderStatus()
  })

  $('btnForgetSecret').addEventListener('click', async () => {
    if (!S.editingId) return
    const list = await call(api.deleteSecret, S.editingId)
    if (list) { S.profiles = list; renderSecretState(profileById(S.editingId)); toast('Password forgotten.', 'ok', 2000) }
  })

  // ------------------------------------------------------------ chat

  const chatLog = $('chatLog')
  const nearBottom = el => el.scrollHeight - el.scrollTop - el.clientHeight < 40
  function scrollChatToBottom () { chatLog.scrollTop = chatLog.scrollHeight; $('btnJumpBottom').classList.add('hidden') }

  const TAGS = { system: 'sys', actionbar: 'bar', join: '+', leave: '−', self: 'sent »' }

  function chatLine (e) {
    const div = document.createElement('div')
    div.className = `line ${e.kind}${e.mention ? ' mention' : ''}`
    const ts = document.createElement('span'); ts.className = 'ts'; ts.textContent = Fmt.time(e.ts)
    div.appendChild(ts)
    if (TAGS[e.kind]) { const t = document.createElement('span'); t.className = 'tag'; t.textContent = TAGS[e.kind]; div.appendChild(t) }
    if (e.motd) Fmt.appendMotd(div, e.motd)
    else div.appendChild(document.createTextNode(e.text))
    return div
  }

  // ---- ping sound: a short two-tone "ding" synthesised with Web Audio (no sound files).
  let audioCtx = null
  let lastDing = 0
  function ding (force = false) {
    const vol = (S.settings.alertVolume ?? 60) / 100
    if (!vol || (!force && Date.now() - lastDing < 1200)) return // don't machine-gun during chat spam
    lastDing = Date.now()
    try {
      audioCtx = audioCtx || new AudioContext()
      const t = audioCtx.currentTime
      for (const [freq, start] of [[988, 0], [1319, 0.1]]) {
        const osc = audioCtx.createOscillator()
        const gain = audioCtx.createGain()
        osc.type = 'sine'
        osc.frequency.value = freq
        gain.gain.setValueAtTime(0.0001, t + start)
        gain.gain.exponentialRampToValueAtTime(0.4 * vol, t + start + 0.01)
        gain.gain.exponentialRampToValueAtTime(0.0001, t + start + 0.7)
        osc.connect(gain).connect(audioCtx.destination)
        osc.start(t + start)
        osc.stop(t + start + 0.75)
      }
    } catch { /* no audio device */ }
  }

  function appendChat (entries, live = true) {
    if (!entries.length) return
    if (live && S.settings.alertSound && entries.some(e => e.mention)) ding()
    const stick = nearBottom(chatLog)
    const frag = document.createDocumentFragment()
    for (const e of entries) frag.appendChild(chatLine(e))
    chatLog.appendChild(frag)
    // Cap DOM size so a multi-day session doesn't grow without bound.
    const max = S.settings.maxChatLines || 1500
    while (chatLog.childElementCount > max) chatLog.firstElementChild.remove()
    if (stick) chatLog.scrollTop = chatLog.scrollHeight
    else if (S.view === 'chat') $('btnJumpBottom').classList.remove('hidden')
  }

  chatLog.addEventListener('scroll', () => { if (nearBottom(chatLog)) $('btnJumpBottom').classList.add('hidden') })
  $('btnJumpBottom').addEventListener('click', scrollChatToBottom)

  $('chatForm').addEventListener('submit', async e => {
    e.preventDefault()
    const input = $('chatInput')
    const text = input.value.trim()
    if (!text) return
    const ok = await call(api.sendChat, text)
    if (ok) {
      if (S.chatHistory[S.chatHistory.length - 1] !== text) S.chatHistory.push(text)
      if (S.chatHistory.length > 50) S.chatHistory.shift()
      S.chatHistoryPos = -1
      input.value = ''
      updateCounter()
      scrollChatToBottom()
    }
  })

  $('chatInput').addEventListener('keydown', e => {
    const h = S.chatHistory
    if (!h.length || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return
    e.preventDefault()
    if (e.key === 'ArrowUp') S.chatHistoryPos = S.chatHistoryPos < 0 ? h.length - 1 : Math.max(0, S.chatHistoryPos - 1)
    else S.chatHistoryPos = S.chatHistoryPos < 0 ? -1 : S.chatHistoryPos + 1
    if (S.chatHistoryPos >= h.length) S.chatHistoryPos = -1
    e.target.value = S.chatHistoryPos < 0 ? '' : h[S.chatHistoryPos]
    updateCounter()
  })

  function updateCounter () { $('chatCounter').textContent = `${$('chatInput').value.length}/256` }
  $('chatInput').addEventListener('input', updateCounter)

  $('chkTimestamps').addEventListener('change', async e => {
    const s = await call(api.saveSettings, { ...S.settings, timestamps: e.target.checked })
    if (s) applySettings(s)
  })
  $('chkJoinLeave').addEventListener('change', async e => {
    const s = await call(api.saveSettings, { ...S.settings, showJoinLeave: e.target.checked })
    if (s) { applySettings(s); if (nearBottom(chatLog)) scrollChatToBottom() }
  })
  $('btnClearChat').addEventListener('click', async () => { if (await call(api.clearChat)) chatLog.replaceChildren() })
  $('btnCopyChat').addEventListener('click', async () => { if (await call(api.copyChat)) toast('Chat copied to clipboard.', 'ok', 2000) })
  $('btnExportChat').addEventListener('click', async () => {
    const file = await call(api.exportChat)
    if (typeof file === 'string') toast(`Chat exported to ${file}`, 'ok')
  })

  // ------------------------------------------------------------ logs

  const logBuffer = []
  const LEVEL_RANK = { debug: 0, info: 1, warn: 2, error: 3 }

  function logPasses (e) {
    const f = $('logLevel').value
    if (f === 'all') return true
    if (f === 'debug') return e.level === 'debug'
    return (LEVEL_RANK[e.level] ?? 1) >= LEVEL_RANK[f]
  }

  function logLine (e) {
    const div = document.createElement('div')
    div.className = `line l-${e.level}`
    const ts = document.createElement('span'); ts.className = 'ts'; ts.textContent = Fmt.time(e.ts)
    const lvl = document.createElement('span'); lvl.className = 'lvl'; lvl.textContent = e.level.toUpperCase()
    div.append(ts, lvl, document.createTextNode(e.text))
    return div
  }

  function renderLogs () {
    const view = $('logView')
    const frag = document.createDocumentFragment()
    for (const e of logBuffer) if (logPasses(e)) frag.appendChild(logLine(e))
    view.replaceChildren(frag)
    view.scrollTop = view.scrollHeight
  }

  function appendLogs (entries) {
    const max = S.settings.maxLogLines || 1500
    logBuffer.push(...entries)
    if (logBuffer.length > max) logBuffer.splice(0, logBuffer.length - max)
    if (S.view !== 'logs') return // rendered lazily when the tab opens
    const view = $('logView')
    const stick = nearBottom(view)
    const frag = document.createDocumentFragment()
    for (const e of entries) if (logPasses(e)) frag.appendChild(logLine(e))
    view.appendChild(frag)
    while (view.childElementCount > max) view.firstElementChild.remove()
    if (stick) view.scrollTop = view.scrollHeight
  }

  $('logLevel').addEventListener('change', renderLogs)
  $('chkDebug').addEventListener('change', async e => {
    const s = await call(api.saveSettings, { ...S.settings, debug: e.target.checked })
    if (s) applySettings(s)
  })
  $('btnClearLogs').addEventListener('click', async () => { if (await call(api.clearLogs)) { logBuffer.length = 0; renderLogs() } })
  $('btnExportLogs').addEventListener('click', async () => {
    const file = await call(api.exportLogs)
    if (typeof file === 'string') toast(`Logs exported to ${file}`, 'ok')
  })

  // ------------------------------------------------------------ AFK

  /** The AFK page edits the selected server's settings (falls back to the connected one). */
  function afkTarget () { return profileById(S.selectedId) || activeProfile() }

  function fillAfkForm () {
    const p = afkTarget()
    const a = (p && p.afk) || S.afkConfig || {}
    $('afkProfileName').textContent = p ? p.name : 'no server selected'
    $('aAutoStart').checked = !!a.autoStart
    $('aInterval').value = a.intervalSec ?? 45
    $('aJitter').value = a.jitterPct ?? 30
    $('aWalk').checked = a.walk ?? true
    $('aWalkMs').value = a.walkMs ?? 400
    $('aRotate').checked = a.rotate ?? true
    $('aRotateDeg').value = a.rotateDeg ?? 25
    $('aJump').checked = !!a.jump
    $('aSneak').checked = !!a.sneak
    $('aSwing').checked = a.swingArm ?? true
    $('btnAfkSave').disabled = !p
    $('afkError').textContent = ''
  }

  function readAfkForm () {
    return {
      autoStart: $('aAutoStart').checked,
      intervalSec: Number($('aInterval').value),
      jitterPct: Number($('aJitter').value),
      walk: $('aWalk').checked,
      walkMs: Number($('aWalkMs').value),
      rotate: $('aRotate').checked,
      rotateDeg: Number($('aRotateDeg').value),
      jump: $('aJump').checked,
      sneak: $('aSneak').checked,
      swingArm: $('aSwing').checked
    }
  }

  $('btnAfkToggle').addEventListener('click', async () => {
    const st = S.afk.enabled ? await call(api.stopAfk) : await call(api.startAfk, readAfkForm())
    if (st) { S.afk = st; renderAfk() }
  })

  $('btnAfkSave').addEventListener('click', async () => {
    const p = afkTarget()
    if (!p) return
    const res = await call(api.saveProfile, { ...p, afk: readAfkForm() })
    if (res) { S.profiles = res.profiles; toast(`AFK settings saved to “${p.name}”.`, 'ok', 2000) }
  })

  // ------------------------------------------------------------ settings

  function applySettings (s) {
    S.settings = s
    chatLog.classList.toggle('no-ts', !s.timestamps)
    chatLog.classList.toggle('no-joinleave', !s.showJoinLeave)
    $('chkJoinLeave').checked = s.showJoinLeave
    $('btnPing').textContent = s.alertSound ? '🔔 Ping on' : '🔕 Ping off'
    $('btnPing').classList.toggle('muted-btn', !s.alertSound)
    $('sAlertWords').value = s.alertWords.join('\n')
    $('sAlertUser').checked = s.alertOnUsername
    $('sAlertSound').checked = s.alertSound
    $('sAlertVolume').value = s.alertVolume
    $('sAlertNotify').checked = s.alertNotify
    $('chkTimestamps').checked = s.timestamps
    $('chkDebug').checked = s.debug
    $('sTimestamps').checked = s.timestamps
    $('sJoinLeave').checked = s.showJoinLeave
    $('sActionBar').checked = s.showActionBar
    $('sRedact').checked = s.redactLoginCommands
    $('sMaxChat').value = s.maxChatLines
    $('sMaxLog').value = s.maxLogLines
    $('sLowMem').checked = s.lowMemory
    $('sView').value = s.viewDistance
    $('sTray').checked = s.closeToTray
    $('sSleep').checked = s.preventSleep
  }

  $('btnSaveSettings').addEventListener('click', async () => {
    const s = await call(api.saveSettings, {
      ...S.settings,
      timestamps: $('sTimestamps').checked,
      showJoinLeave: $('sJoinLeave').checked,
      showActionBar: $('sActionBar').checked,
      redactLoginCommands: $('sRedact').checked,
      maxChatLines: Number($('sMaxChat').value),
      maxLogLines: Number($('sMaxLog').value),
      lowMemory: $('sLowMem').checked,
      viewDistance: $('sView').value,
      closeToTray: $('sTray').checked,
      preventSleep: $('sSleep').checked,
      alertWords: $('sAlertWords').value.split(/[\n,]/),
      alertOnUsername: $('sAlertUser').checked,
      alertSound: $('sAlertSound').checked,
      alertVolume: Number($('sAlertVolume').value),
      alertNotify: $('sAlertNotify').checked
    })
    if (s) { applySettings(s); toast('Settings saved.', 'ok', 2000) }
  })
  $('btnPing').addEventListener('click', async () => {
    const s = await call(api.saveSettings, { ...S.settings, alertSound: !S.settings.alertSound })
    if (s) { applySettings(s); if (s.alertSound) ding(true) }
  })
  $('btnTestDing').addEventListener('click', () => {
    const prev = S.settings.alertVolume
    S.settings.alertVolume = Number($('sAlertVolume').value) // preview the slider before saving
    ding(true)
    S.settings.alertVolume = prev
  })
  $('btnOpenData').addEventListener('click', () => call(api.openDataDir))

  // ------------------------------------------------------------ info panel

  function kv (dl, rows) {
    dl.replaceChildren(...rows.flatMap(([k, v, cls]) => {
      const dt = document.createElement('dt'); dt.textContent = k
      const dd = document.createElement('dd'); dd.textContent = v ?? '—'; dd.title = v ?? ''
      if (cls) { dd.className = cls; return [dd] }
      return [dt, dd]
    }))
  }

  function renderInfo () {
    const i = S.info || {}
    const online = i.state === 'online'
    const rows = [
      ['Status', STATE_LABEL[i.state] || i.state || '—'],
      ['Server', i.destination],
      ['Resolved IP', i.remote],
      ['Version', i.serverVersion],
      ['Ping', online && i.ping != null ? `${i.ping} ms` : null],
      ['Players online', online ? i.players : null],
      ['Connected for', i.connectedSince ? Fmt.duration(Date.now() - i.connectedSince) : null]
    ]
    if (i.state === 'reconnecting' && i.reconnectAt) rows.push(['Reconnect in', `${Math.max(0, Math.ceil((i.reconnectAt - Date.now()) / 1000))}s (attempt #${i.attempts})`])
    if (i.lastError && i.state !== 'online') rows.push(['Last error', i.lastError, 'err'])
    kv($('infoConn'), rows)

    const pos = i.position
    kv($('infoPlayer'), [
      ['Username', i.username],
      ['Game mode', i.gameMode],
      ['Dimension', i.dimension],
      ['Position', pos ? `${pos.x}, ${pos.y}, ${pos.z}` : null]
    ])

    const hp = online && i.health != null ? i.health : null
    const food = online && i.food != null ? i.food : null
    $('barHealth').style.width = `${hp == null ? 0 : Math.min(100, hp / 20 * 100)}%`
    $('valHealth').textContent = hp == null ? '—' : hp
    $('barFood').style.width = `${food == null ? 0 : Math.min(100, food / 20 * 100)}%`
    $('valFood').textContent = food == null ? '—' : food

    $('lastMsg').textContent = i.lastMessage ? `[${Fmt.time(i.lastMessage.ts)}] ${i.lastMessage.text}` : '—'
  }

  // A 1 s tick only for clocks (uptime / countdowns); skipped while hidden.
  setInterval(() => {
    if (document.hidden) return
    if (S.info.connectedSince || S.info.reconnectAt) renderInfo()
    if (S.status.state === 'reconnecting') renderStatus()
    if (S.view === 'afk' && S.afk.enabled) renderAfkStats()
  }, 1000)

  // ------------------------------------------------------------ push events from main

  api.onPush(batch => {
    if (batch.status) { S.status = batch.status; renderStatus() }
    if (batch.info) { S.info = batch.info; renderInfo() }
    if (batch.afk) { S.afk = batch.afk; renderAfk() }
    if (batch.chat && batch.chat.length) appendChat(batch.chat)
    if (batch.logs && batch.logs.length) appendLogs(batch.logs)
  })

  // ------------------------------------------------------------ startup

  async function init () {
    const d = await call(api.bootstrap)
    if (!d) return
    S.profiles = d.profiles
    S.status = d.status
    S.info = d.info
    S.afk = d.afk
    S.afkConfig = d.afkConfig
    S.versions = d.versions
    S.secureStorage = d.secureStorage
    S.selectedId = d.status.profileId || (d.profiles[0] && d.profiles[0].id) || null
    $('dataDir').textContent = d.dataDir
    $('appVersion').textContent = `v${d.appVersion} · offline-mode only`
    applySettings(d.settings)
    appendChat(d.chat, false)
    appendLogs(d.logs)
    renderStatus()
    renderInfo()
    renderAfk()
    if (!d.profiles.length) openEditor(null)
  }

  init()
})()
