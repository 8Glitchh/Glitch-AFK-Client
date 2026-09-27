'use strict'
/**
 * Generates assets/icon.png (256×256): a dark rounded tile with a green ">_"
 * prompt and a magenta/cyan "glitch" offset. Pure Node (zlib), no image libraries. electron-builder converts it
 * to the Windows .ico automatically. Run: node scripts/make-icon.js
 */
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

const N = 256
const px = Buffer.alloc(N * N * 4)

const clamp = (v, a, b) => Math.max(a, Math.min(b, v))
function segDist (x, y, ax, ay, bx, by) {
  const dx = bx - ax; const dy = by - ay
  const t = clamp(((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy), 0, 1)
  return Math.hypot(x - (ax + t * dx), y - (ay + t * dy))
}
function roundRectDist (x, y, x0, y0, x1, y1, r) {
  const cx = clamp(x, x0 + r, x1 - r); const cy = clamp(y, y0 + r, y1 - r)
  return Math.hypot(x - cx, y - cy) - r
}
const mix = (a, b, t) => a + (b - a) * t

for (let y = 0; y < N; y++) {
  for (let x = 0; x < N; x++) {
    const i = (y * N + x) * 4
    const fx = x + 0.5; const fy = y + 0.5
    const tile = roundRectDist(fx, fy, 8, 8, 248, 248, 48)
    const aTile = clamp(0.5 - tile, 0, 1)
    if (aTile <= 0) continue
    // background: subtle vertical gradient
    const g = fy / N
    let r = mix(30, 16, g); let gg = mix(36, 19, g); let b = mix(48, 26, g)
    // border
    const border = clamp(1 - Math.abs(tile + 3) / 2, 0, 1)
    r = mix(r, 58, border * 0.8); gg = mix(gg, 66, border * 0.8); b = mix(b, 84, border * 0.8)
    // "Glitch" look: magenta and cyan copies of the glyph offset sideways, green on top.
    const glyphAt = (gx, gy) => {
      const chev = Math.min(segDist(gx, gy, 70, 84, 124, 128), segDist(gx, gy, 124, 128, 70, 172)) - 13
      const under = segDist(gx, gy, 142, 176, 192, 176) - 12
      return clamp(0.5 - Math.min(chev, under), 0, 1)
    }
    const mag = glyphAt(fx + 7, fy); const cyan = glyphAt(fx - 7, fy)
    r = mix(r, 255, mag * 0.85); gg = mix(gg, 43, mag * 0.85); b = mix(b, 214, mag * 0.85)
    r = mix(r, 34, cyan * 0.85); gg = mix(gg, 230, cyan * 0.85); b = mix(b, 255, cyan * 0.85)
    const glyph = glyphAt(fx, fy)
    r = mix(r, 62, glyph); gg = mix(gg, 207, glyph); b = mix(b, 142, glyph)
    px[i] = r; px[i + 1] = gg; px[i + 2] = b; px[i + 3] = Math.round(aTile * 255)
  }
}

// ---- PNG encoding
const crcTable = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c })
const crc32 = buf => { let c = -1; for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0 }
function chunk (type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type), data])
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}
const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(N, 0); ihdr.writeUInt32BE(N, 4)
ihdr[8] = 8; ihdr[9] = 6 // 8-bit RGBA
const raw = Buffer.alloc(N * (N * 4 + 1))
for (let y = 0; y < N; y++) px.copy(raw, y * (N * 4 + 1) + 1, y * N * 4, (y + 1) * N * 4)
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0))
])
const out = path.join(__dirname, '..', 'assets', 'icon.png')
fs.mkdirSync(path.dirname(out), { recursive: true })
fs.writeFileSync(out, png)
console.log('wrote', out, png.length, 'bytes')
