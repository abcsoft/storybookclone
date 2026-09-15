// Generic pixel-level barcode primitives shared by the deterministic
// illustration generator (identity/scene marker) and the watermarker
// (provenance marker).
//
// The payload is written as two luminance levels in square blocks, sized
// relative to the image so the bits survive a quality-78 JPEG round trip. A
// reader therefore recovers the payload from the REAL decoded pixels of the
// bytes it was handed — which is what makes "is this image watermarked?" and
// "how many children does this image actually show?" verifiable rather than
// asserted.
export const BITS_PER_ROW = 16

const DARK_LEVEL = 24
const BRIGHT_LEVEL = 232

export function blockSizeFor(width: number, height: number): number {
  return Math.max(2, Math.floor(Math.min(width, height) / 24))
}

export function bytesToBits(bytes: number[]): number[] {
  const bits: number[] = []
  for (const byte of bytes) for (let bit = 7; bit >= 0; bit--) bits.push((byte >> bit) & 1)
  return bits
}

/** Writes `bytes` as a block grid whose top-left corner is (originX, originY). */
export function writeBarcode(data: Uint8Array, width: number, height: number, bytes: number[], originX: number, originY: number, block: number): void {
  const bits = bytesToBits(bytes)
  const rows = Math.ceil(bits.length / BITS_PER_ROW)
  for (let index = 0; index < bits.length; index++) {
    const row = Math.floor(index / BITS_PER_ROW)
    const col = index % BITS_PER_ROW
    const level = bits[index] ? BRIGHT_LEVEL : DARK_LEVEL
    for (let dy = 0; dy < block; dy++) {
      const y = originY + row * block + dy
      if (y < 0 || y >= height) break
      for (let dx = 0; dx < block; dx++) {
        const x = originX + col * block + dx
        if (x < 0 || x >= width) break
        const i = (y * width + x) * 4
        data[i] = level
        data[i + 1] = level
        data[i + 2] = level
        data[i + 3] = 255
      }
    }
  }
  // A bright quiet-zone frame above and below the grid makes the block rows
  // findable after JPEG smoothing.
  const quietRows = [originY - 1, originY + rows * block]
  for (const y of quietRows) {
    if (y < 0 || y >= height) continue
    for (let dx = -1; dx <= BITS_PER_ROW * block; dx++) {
      const x = originX + dx
      if (x < 0 || x >= width) continue
      const i = (y * width + x) * 4
      data[i] = 255
      data[i + 1] = 255
      data[i + 2] = 255
    }
  }
}

/** Reads `byteCount` bytes back from the block grid at (originX, originY), or null when the grid is unreadable. */
export function readBarcode(data: Uint8Array, width: number, height: number, byteCount: number, originX: number, originY: number, block: number): number[] | null {
  const rows = Math.ceil((byteCount * 8) / BITS_PER_ROW)
  if (originX + BITS_PER_ROW * block > width || originY + rows * block > height) return null
  if (originX < 0 || originY < 0) return null
  const bits: number[] = []
  const inset = Math.floor(block / 4)
  const span = Math.max(1, block - inset * 2)
  for (let index = 0; index < byteCount * 8; index++) {
    const row = Math.floor(index / BITS_PER_ROW)
    const col = index % BITS_PER_ROW
    let total = 0
    let count = 0
    for (let dy = inset; dy < inset + span; dy++) {
      const y = originY + row * block + dy
      if (y < 0 || y >= height) return null
      for (let dx = inset; dx < inset + span; dx++) {
        const x = originX + col * block + dx
        if (x < 0 || x >= width) return null
        const i = (y * width + x) * 4
        total += (data[i] + data[i + 1] + data[i + 2]) / 3
        count++
      }
    }
    if (!count) return null
    bits.push(total / count > 128 ? 1 : 0)
  }
  const out: number[] = []
  for (let i = 0; i < byteCount; i++) {
    let value = 0
    for (let b = 0; b < 8; b++) value = (value << 1) | (bits[i * 8 + b] ?? 0)
    out.push(value)
  }
  return out
}

/** Computes where a barcode of `byteCount` bytes should start so it sits inset from a corner. */
export function barcodeOrigin(width: number, height: number, byteCount: number, corner: 'top-left' | 'bottom-right'): { x: number; y: number; block: number } {
  const block = blockSizeFor(width, height)
  const rows = Math.ceil((byteCount * 8) / BITS_PER_ROW)
  if (corner === 'top-left') return { x: block, y: block, block }
  return { x: Math.max(0, width - block * (BITS_PER_ROW + 1)), y: Math.max(0, height - block * (rows + 1)), block }
}
