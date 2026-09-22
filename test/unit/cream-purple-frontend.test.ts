// Unit and integration tests for Cream-Purple Frontend design system & structural redesign.
import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { app, freshEnv, type TestEnv } from '../helpers/testApp'
import { COLOR_TOKENS } from '../../src/theme'

const root = join(__dirname, '..', '..')

let env: TestEnv

beforeEach(() => {
  env = freshEnv()
})

describe('Cream-Purple Design System Tokens', () => {
  it('storefront.css declares all expected color tokens', () => {
    const css = readFileSync(join(root, 'public', 'static', 'storefront.css'), 'utf8')
    for (const [key, value] of Object.entries(COLOR_TOKENS)) {
      expect(css).toContain(`${key}: ${value}`)
    }
  })

  it('theme.ts token values match the Cream-Purple palette specification', () => {
    expect(COLOR_TOKENS['--c-ink']).toBe('#11184b')
    expect(COLOR_TOKENS['--c-primary']).toBe('#6c2cf1')
    expect(COLOR_TOKENS['--c-bg']).toBe('#fff9f1')
    expect(COLOR_TOKENS['--c-surface-2']).toBe('#fff0e2')
    expect(COLOR_TOKENS['--c-sky']).toBe('#eaf6ff')
    expect(COLOR_TOKENS['--c-accent']).toBe('#ffb823')
    expect(COLOR_TOKENS['--c-berry']).toBe('#ff6478')
    expect(COLOR_TOKENS['--c-success']).toBe('#39c992')
    expect(COLOR_TOKENS['--c-ring']).toBe('#ffb823')
  })

  it('pdp.css maps input focus to the primary purple ring', () => {
    const pdpCss = readFileSync(join(root, 'public', 'static', 'pdp.css'), 'utf8')
    expect(pdpCss).toContain('--c-primary')
  })
})

describe('Asset safety, presence and loading', () => {
  it('ships required production assets in public/static/assets', () => {
    const requiredAssets = [
      'hero/open-book-boy.webp',
      'features/open-book-girl.webp',
      'personalization/child-photo.webp',
      'personalization/child-illustrated.webp',
      'personalization/large-cover-preview.webp',
      'extras/sticker-pack.webp',
      'categories/adventure.webp',
      'categories/bedtime.webp',
      'categories/animals.webp',
      'categories/friendship.webp',
      'books/lantern.webp',
      'books/moon-garden.webp',
      'books/snowy-friend.webp',
      'books/quiet-dream.webp',
      'books/forest.webp',
      'books/sunbeam-sea.webp',
      'books/vet.webp',
      'books/firefighter.webp',
      'books/pilot.webp',
      'books/chef.webp',
      'product/lantern-cover.webp',
      'product/open-book-feature.webp',
      'product/gallery-01.webp',
      'product/gallery-02.webp',
      'product/gallery-03.webp',
      'icons/book.svg',
      'icons/user.svg',
      'icons/edit.svg',
      'icons/gift.svg',
      'icons/upload.svg',
      'icons/check.svg',
      'icons/close.svg',
      'icons/shield.svg',
      'icons/star.svg'
    ]
    for (const rel of requiredAssets) {
      const fullPath = join(root, 'public', 'static', 'assets', rel)
      expect(existsSync(fullPath), `Asset missing: ${rel}`).toBe(true)
    }
  })

  it('does not ship banned reference-brand or prohibited directories', () => {
    const banned = [
      'assets/sections',
      'assets/reference-only',
      '01-homepage-desktop.png',
      '02-homepage-mobile.png'
    ]
    for (const item of banned) {
      expect(existsSync(join(root, 'public', item))).toBe(false)
      expect(existsSync(join(root, 'public', 'static', item))).toBe(false)
    }
  })
})

describe('Data-to-Asset Layer & Migration 0034 Invariants', () => {
  it('migrates a known untouched seed path to approved asset', () => {
    const db = new DatabaseSync(':memory:')
    const migrationsDir = join(root, 'migrations')
    const files = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()
    for (const f of files.filter((f) => f < '0034')) {
      db.exec(readFileSync(join(migrationsDir, f), 'utf8'))
    }
    db.exec(readFileSync(join(root, 'seed.sql'), 'utf8'))

    // Apply migration 0034
    db.exec(readFileSync(join(migrationsDir, '0034_cream_purple_assets.sql'), 'utf8'))

    // After migration 0034, untouched seeded products point to approved assets
    const product = db.prepare("SELECT image FROM products WHERE slug = 'the-lantern-and-the-long-night'").get() as { image: string }
    expect(product.image).toBe('/static/assets/books/lantern.webp')

    const collection = db.prepare("SELECT hero_image FROM collections WHERE slug = 'adventure-and-discovery'").get() as { hero_image: string }
    expect(collection.hero_image).toBe('/static/assets/categories/adventure.webp')
  })

  it('preserves an administrator-customized media path', () => {
    const db = new DatabaseSync(':memory:')
    const migrationsDir = join(root, 'migrations')
    const files = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()

    // Apply migrations up to 0033
    for (const f of files.filter((f) => f < '0034')) {
      db.exec(readFileSync(join(migrationsDir, f), 'utf8'))
    }
    db.exec(readFileSync(join(root, 'seed.sql'), 'utf8'))

    // Simulate an admin modifying the lantern product image
    db.exec("UPDATE products SET image = '/uploads/custom-art-by-admin.webp' WHERE slug = 'the-lantern-and-the-long-night'")

    // Apply migration 0034
    db.exec(readFileSync(join(migrationsDir, '0034_cream_purple_assets.sql'), 'utf8'))

    // The admin's customized image must be preserved without overwrite
    const p = db.prepare("SELECT image FROM products WHERE slug = 'the-lantern-and-the-long-night'").get() as { image: string }
    expect(p.image).toBe('/uploads/custom-art-by-admin.webp')
  })

  it('is idempotent: re-applying migration 0034 causes zero duplicate rows or unwanted mutations', () => {
    const db = new DatabaseSync(':memory:')
    const migrationsDir = join(root, 'migrations')
    const files = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()

    for (const f of files) {
      db.exec(readFileSync(join(migrationsDir, f), 'utf8'))
    }

    const count1 = db.prepare('SELECT COUNT(*) AS n FROM pdp_gallery').get() as { n: number }

    // Re-run migration 0034
    db.exec(readFileSync(join(migrationsDir, '0034_cream_purple_assets.sql'), 'utf8'))

    const count2 = db.prepare('SELECT COUNT(*) AS n FROM pdp_gallery').get() as { n: number }
    expect(count2.n).toBe(count1.n)
  })
})

describe('Storefront Structural Redesign (Homepage & PDP)', () => {
  it('serves the data-design-version="cream-purple-v2" marker in document body', async () => {
    const res = await app.request('/', {}, env as never)
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('data-design-version="cream-purple-v2"')
  })

  it('structurally redesigns at least six non-hero sections with new DOM compositions', async () => {
    const res = await app.request('/', {}, env as never)
    expect(res.status).toBe(200)
    const html = await res.text()

    // Non-Hero Redesigned Section 1: Shelf / Product Grid
    expect(html).toContain('shelf-section-redesigned')
    expect(html).toContain('book-card')
    expect(html).toContain('card-spine-accent')

    // Non-Hero Redesigned Section 2: Steps (How It Works)
    expect(html).toContain('steps-section-redesigned')
    expect(html).toContain('steps-modern')
    expect(html).toContain('step-card')
    expect(html).toContain('step-num-pill')
    expect(html).toContain('step-icon-bubble')

    // Non-Hero Redesigned Section 3: Photo Guidance
    expect(html).toContain('photo-guidance-redesigned')
    expect(html).toContain('photo-transformation-showcase')
    expect(html).toContain('photo-side-original')
    expect(html).toContain('photo-side-illustrated')
    expect(html).toContain('tips-cards-grid')

    // Non-Hero Redesigned Section 4: Collection Grid
    expect(html).toContain('collection-grid-redesigned')
    expect(html).toContain('collection-card-redesigned')
    expect(html).toContain('collection-cover-wrap')
    expect(html).toContain('collection-kind-badge')

    // Non-Hero Redesigned Section 5: Age Discovery Grid
    expect(html).toContain('age-section-redesigned')
    expect(html).toContain('age-discovery-grid')
    expect(html).toContain('age-tile-early')
    expect(html).toContain('age-tile-mid')
    expect(html).toContain('age-tile-older')

    // Non-Hero Redesigned Section 6: Sticker Cross-Sell
    expect(html).toContain('sticker-cross-sell-redesigned')
    expect(html).toContain('sticker-feature-card')
    expect(html).toContain('sticker-perks')

    // Non-Hero Redesigned Section 7: Large Editorial Feature
    expect(html).toContain('editorial-feature-redesigned')
    expect(html).toContain('editorial-feature-card')
    expect(html).toContain('editorial-points')

    // Non-Hero Redesigned Section 8: FAQ Preview
    expect(html).toContain('faq-preview-redesigned')
    expect(html).toContain('faq-accordion-container')
  })

  it('emits approved production assets on homepage', async () => {
    const res = await app.request('/', {}, env as never)
    expect(res.status).toBe(200)
    const html = await res.text()

    // Hero & Features
    expect(html).toContain('/static/assets/hero/open-book-boy.webp')
    expect(html).toContain('/static/assets/features/open-book-girl.webp')

    // Personalization guidance
    expect(html).toContain('/static/assets/personalization/child-photo.webp')
    expect(html).toContain('/static/assets/personalization/child-illustrated.webp')

    // Extras
    expect(html).toContain('/static/assets/extras/sticker-pack.webp')

    // Category banners
    expect(html).toContain('/static/assets/categories/adventure.webp')

    // Book covers from approved assets
    expect(html).toContain('/static/assets/books/lantern.webp')

    // Clean icons
    expect(html).toContain('/static/assets/icons/book.svg')
    expect(html).toContain('/static/assets/icons/upload.svg')
    expect(html).toContain('/static/assets/icons/edit.svg')
    expect(html).toContain('/static/assets/icons/gift.svg')
    expect(html).toContain('/static/assets/icons/check.svg')
    expect(html).toContain('/static/assets/icons/close.svg')
    expect(html).toContain('/static/assets/icons/shield.svg')
  })

  it('renders a fully redesigned PDP for the-lantern-and-the-long-night with approved product assets', async () => {
    const res = await app.request('/books/the-lantern-and-the-long-night', {}, env as never)
    expect(res.status).toBe(200)
    const html = await res.text()

    // PDP Hero title & gallery
    expect(html).toContain('The Lantern and the Long Night')
    expect(html).toContain('/static/assets/product/lantern-cover.webp')
    expect(html).toContain('/static/assets/product/open-book-feature.webp')
    expect(html).toContain('/static/assets/product/gallery-01.webp')
    expect(html).toContain('/static/assets/product/gallery-02.webp')
    expect(html).toContain('/static/assets/product/gallery-03.webp')

    // Personalisation steps with approved assets
    expect(html).toContain('/static/assets/personalization/child-photo.webp')
    expect(html).toContain('/static/assets/extras/sticker-pack.webp')
  })

  it('does not assign the lantern gallery to unrelated products', async () => {
    const res = await app.request('/books/captain-of-the-cardboard-sea', {}, env as never)
    expect(res.status).toBe(200)
    const html = await res.text()

    // Does not contain lantern product gallery items
    expect(html).not.toContain('/static/assets/product/lantern-cover.webp')
    expect(html).not.toContain('/static/assets/product/open-book-feature.webp')
    expect(html).not.toContain('/static/assets/product/gallery-01.webp')
  })

  it('all img elements in the storefront have explicit dimensions and useful alt text', async () => {
    const res = await app.request('/', {}, env as never)
    const html = await res.text()

    const imgs = html.match(/<img\b[^>]*>/g) || []
    expect(imgs.length).toBeGreaterThan(0)
    for (const img of imgs) {
      expect(img, `Missing width on ${img}`).toMatch(/\bwidth="\d+"/)
      expect(img, `Missing height on ${img}`).toMatch(/\bheight="\d+"/)
      expect(img, `Missing alt attribute on ${img}`).toMatch(/\balt="[^"]*"/)
    }
  })

  it('does not leak cross-origin resources', async () => {
    const res = await app.request('/', {}, env as never)
    const html = await res.text()
    const stripped = html
      .replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/g, '')
      .replace(/<link\s+[^>]*rel="(canonical|alternate)"[^>]*>/g, '')
    const remoteMatches = stripped.match(/(?:src|href)=["']https?:\/\/[^"']+/g) || []
    expect(remoteMatches).toEqual([])
  })
})
