'use strict'
/**
 * Formatting helpers. Server text is ALWAYS inserted with textContent, never
 * innerHTML, so nothing a server sends can inject markup or script.
 */
window.Fmt = (() => {
  const COLORS = '0123456789abcdef'
  const STYLES = { l: 'mc-l', o: 'mc-o', n: 'mc-n', m: 'mc-m' } // k (obfuscated) is shown as plain text

  /** Append Minecraft §-formatted text to `parent` as styled spans. */
  function appendMotd (parent, motd) {
    let color = null
    let styles = []
    const parts = String(motd).split('§')
    const push = text => {
      if (!text) return
      if (!color && styles.length === 0) { parent.appendChild(document.createTextNode(text)); return }
      const span = document.createElement('span')
      span.className = [color ? `mc-${color}` : '', ...styles].filter(Boolean).join(' ')
      span.textContent = text
      parent.appendChild(span)
    }
    push(parts[0])
    for (let i = 1; i < parts.length; i++) {
      const code = parts[i].charAt(0).toLowerCase()
      const rest = parts[i].slice(1)
      if (COLORS.includes(code) && code) { color = code; styles = [] } else if (STYLES[code]) { if (!styles.includes(STYLES[code])) styles.push(STYLES[code]) } else if (code === 'r') { color = null; styles = [] }
      push(rest)
    }
  }

  const pad = n => String(n).padStart(2, '0')
  const time = ts => { const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` }

  function duration (ms) {
    if (ms == null || ms < 0) return '—'
    const s = Math.floor(ms / 1000)
    const d = Math.floor(s / 86400)
    const h = Math.floor((s % 86400) / 3600)
    const m = Math.floor((s % 3600) / 60)
    return (d ? `${d}d ` : '') + `${pad(h)}:${pad(m)}:${pad(s % 60)}`
  }

  return { appendMotd, time, duration }
})()
