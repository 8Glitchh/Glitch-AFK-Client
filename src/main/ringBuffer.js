'use strict'
/**
 * Fixed-capacity circular buffer. Chat and log history use it so memory stays
 * flat no matter how many days the client runs.
 */
class RingBuffer {
  constructor (capacity) {
    this.capacity = capacity
    this.items = new Array(capacity)
    this.start = 0
    this.size = 0
  }

  push (item) {
    const idx = (this.start + this.size) % this.capacity
    this.items[idx] = item
    if (this.size < this.capacity) this.size++
    else this.start = (this.start + 1) % this.capacity
  }

  toArray () {
    const out = new Array(this.size)
    for (let i = 0; i < this.size; i++) out[i] = this.items[(this.start + i) % this.capacity]
    return out
  }

  clear () {
    this.items = new Array(this.capacity)
    this.start = 0
    this.size = 0
  }

  resize (capacity) {
    const keep = this.toArray().slice(-capacity)
    this.capacity = capacity
    this.clear()
    for (const it of keep) this.push(it)
  }
}

module.exports = { RingBuffer }
