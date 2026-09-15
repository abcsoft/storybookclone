// V2 Phase 2 — the local development seed and the TypeScript catalogue fixture
// must describe the SAME original products.
//
// `seed.sql` is applied by `npm run db:reset`; `src/data.ts` is what the
// application's idempotent bootstrap inserts when the catalogue is empty (a
// fresh install with no seed step). Two copies of the same fixture is exactly
// the kind of drift the Phase-1 C/D registries were full of, so this test
// freezes them together.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { products } from '../../src/data'

const root = process.cwd()

type SeedRow = { slug: string; title: string; price: number; priceMinor: number; image: string; reviews: number; rating: number; category: string }

/** Parses the single INSERT ... VALUES statement in seed.sql. */
function parseSeed(): SeedRow[] {
  const sql = readFileSync(join(root, 'seed.sql'), 'utf8')
  const start = sql.indexOf('INSERT OR IGNORE INTO products')
  expect(start, 'seed.sql must contain the products INSERT').toBeGreaterThan(-1)
  const valuesStart = sql.indexOf('VALUES', start) + 'VALUES'.length
  const body = sql.slice(valuesStart, sql.lastIndexOf(';'))
  const rows: SeedRow[] = []
  // Each row is a parenthesised tuple of SQL literals.
  const regex = /\(([^()]*)\)/g
  let match: RegExpExecArray | null
  while ((match = regex.exec(body))) {
    const fields = match[1].split(/,(?=(?:[^']*'[^']*')*[^']*$)/).map((f) => f.trim())
    const unquote = (v: string) => v.replace(/^'|'$/g, '').replace(/''/g, "'")
    rows.push({
      slug: unquote(fields[0]),
      title: unquote(fields[1]),
      price: Number(fields[5]),
      image: unquote(fields[7]),
      category: unquote(fields[9]),
      reviews: Number(fields[14]),
      rating: Number(fields[15]),
      priceMinor: Number(fields[21])
    })
  }
  return rows
}

describe('seed.sql and src/data.ts describe the same original catalogue', () => {
  const seed = parseSeed()

  it('has the same products in the same order', () => {
    expect(seed.map((r) => r.slug)).toEqual(products.map((p) => p.slug))
  })

  it('agrees on title, price (major and minor) and cover art', () => {
    expect(seed.length).toBe(products.length)
    for (let i = 0; i < products.length; i++) {
      const p = products[i]
      const s = seed[i]
      expect(s.title, s.slug).toBe(p.title)
      expect(s.price, s.slug).toBeCloseTo(p.price, 2)
      expect(s.priceMinor, s.slug).toBe(Math.round(p.price * 100))
      expect(s.image, s.slug).toBe(p.image)
      expect(s.category, s.slug).toBe(p.category)
    }
  })

  it('carries no invented review aggregate in either copy', () => {
    for (const s of seed) {
      expect(s.reviews, `${s.slug} has a review count with no review rows`).toBe(0)
      expect(s.rating, `${s.slug} has a rating with no review rows`).toBe(0)
    }
    for (const p of products) {
      expect(p.reviews, `${p.slug} has a review count with no review rows`).toBe(0)
      expect(p.rating, `${p.slug} has a rating with no review rows`).toBe(0)
    }
  })

  it('uses only ORIGINAL titles (no reference-catalogue title survives)', () => {
    // The reference catalogue's titles that this project shipped before Phase 2.
    const referenceTitles = [
      "The Portugal's New Legend",
      'Princess Girl, the One We All Needed',
      'Happy Birthday Girl',
      'Happy Birthday Boy',
      "Princess! We've Been Waiting for You",
      "Boy's Smile",
      'Vroom Vroom, The Boy Wins the Race'
    ]
    const seedText = readFileSync(join(root, 'seed.sql'), 'utf8')
    const dataText = readFileSync(join(root, 'src', 'data.ts'), 'utf8')
    for (const t of referenceTitles) {
      expect(seedText, `seed.sql still carries the reference title "${t}"`).not.toContain(t)
      expect(dataText, `data.ts still carries the reference title "${t}"`).not.toContain(t)
    }
  })

  it('every seeded image points at generated original art', () => {
    for (const s of seed) {
      expect(s.image.startsWith('/static/img/art/cover-'), s.slug).toBe(true)
      expect(s.image.endsWith('.svg'), s.slug).toBe(true)
    }
  })
})
