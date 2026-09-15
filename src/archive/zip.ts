// A minimal, deterministic ZIP writer (STORE method, no compression).
//
// WHY: CUS-11 has to deliver a REAL file. Compressing the immutable, watermarked
// preview pages this application already produced is the only artifact this phase
// can honestly hand a customer — inventing a PDF (Phase 7's job) or a "digital
// copy" that does not exist would be a false capability claim.
//
// STORE (method 0) rather than DEFLATE on purpose: there is no compression
// dependency in a Worker, the bytes are already JPEGs (compressing them again
// buys almost nothing), and a store-only archive is byte-for-byte reproducible,
// which makes the checksum assertion in the tests meaningful.
//
// Only ever called with bytes the caller has already read from private storage.

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

export type ZipEntry = { name: string; bytes: Uint8Array }

/** DOS date/time pair. Deterministic for a given `at`, so an archive is reproducible. */
function dosDateTime(at: Date): { time: number; date: number } {
  const year = at.getUTCFullYear()
  const date = ((Math.max(0, year - 1980) & 0x7f) << 9) | ((at.getUTCMonth() + 1) << 5) | at.getUTCDate()
  const time = (at.getUTCHours() << 11) | (at.getUTCMinutes() << 5) | Math.floor(at.getUTCSeconds() / 2)
  return { time, date }
}

/** A safe, path-traversal-free entry name: no separators, no leading dots, bounded length. */
export function safeEntryName(name: string, fallback = 'file'): string {
  const cleaned = String(name || '')
    .replace(/[\\/]+/g, '_')
    .replace(/^\.+/, '')
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .slice(0, 100)
  return cleaned || fallback
}

export function buildZip(entries: ZipEntry[], at: Date = new Date()): Uint8Array {
  const { time, date } = dosDateTime(at)
  const encoder = new TextEncoder()
  const locals: Uint8Array[] = []
  const centrals: Uint8Array[] = []
  let offset = 0

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name)
    const crc = crc32(entry.bytes)
    const size = entry.bytes.length

    const local = new Uint8Array(30 + nameBytes.length + size)
    const lv = new DataView(local.buffer)
    lv.setUint32(0, 0x04034b50, true)
    lv.setUint16(4, 20, true) // version needed
    lv.setUint16(6, 0x0800, true) // UTF-8 names
    lv.setUint16(8, 0, true) // STORE
    lv.setUint16(10, time, true)
    lv.setUint16(12, date, true)
    lv.setUint32(14, crc, true)
    lv.setUint32(18, size, true)
    lv.setUint32(22, size, true)
    lv.setUint16(26, nameBytes.length, true)
    lv.setUint16(28, 0, true)
    local.set(nameBytes, 30)
    local.set(entry.bytes, 30 + nameBytes.length)
    locals.push(local)

    const central = new Uint8Array(46 + nameBytes.length)
    const cv = new DataView(central.buffer)
    cv.setUint32(0, 0x02014b50, true)
    cv.setUint16(4, 20, true) // version made by
    cv.setUint16(6, 20, true) // version needed
    cv.setUint16(8, 0x0800, true)
    cv.setUint16(10, 0, true)
    cv.setUint16(12, time, true)
    cv.setUint16(14, date, true)
    cv.setUint32(16, crc, true)
    cv.setUint32(20, size, true)
    cv.setUint32(24, size, true)
    cv.setUint16(28, nameBytes.length, true)
    cv.setUint16(30, 0, true)
    cv.setUint16(32, 0, true)
    cv.setUint16(34, 0, true)
    cv.setUint16(36, 0, true)
    cv.setUint32(38, 0, true)
    cv.setUint32(42, offset, true)
    central.set(nameBytes, 46)
    centrals.push(central)

    offset += local.length
  }

  const centralSize = centrals.reduce((n, c) => n + c.length, 0)
  const end = new Uint8Array(22)
  const ev = new DataView(end.buffer)
  ev.setUint32(0, 0x06054b50, true)
  ev.setUint16(4, 0, true)
  ev.setUint16(6, 0, true)
  ev.setUint16(8, entries.length, true)
  ev.setUint16(10, entries.length, true)
  ev.setUint32(12, centralSize, true)
  ev.setUint32(16, offset, true)
  ev.setUint16(20, 0, true)

  const total = offset + centralSize + end.length
  const out = new Uint8Array(total)
  let cursor = 0
  for (const part of locals) {
    out.set(part, cursor)
    cursor += part.length
  }
  for (const part of centrals) {
    out.set(part, cursor)
    cursor += part.length
  }
  out.set(end, cursor)
  return out
}
