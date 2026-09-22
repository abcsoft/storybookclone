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

describe('Product Media Roles and Lantern Associations (Requirement 1)', () => {
  function setupMigratedDb() {
    const db = new DatabaseSync(':memory:')
    const migrationsDir = join(root, 'migrations')
    const files = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()
    for (const f of files.filter((f) => f < '0034')) {
      db.exec(readFileSync(join(migrationsDir, f), 'utf8'))
    }
    db.exec(readFileSync(join(root, 'seed.sql'), 'utf8'))
    db.exec(readFileSync(join(migrationsDir, '0034_cream_purple_assets.sql'), 'utf8'))
    db.exec(readFileSync(join(migrationsDir, '0035_repair_product_media_roles.sql'), 'utf8'))
    return { db, migrationsDir }
  }

  it('all five Lantern assets are present in media_assets with registered dimensions', () => {
    const { db } = setupMigratedDb()
    const paths = [
      '/static/assets/books/lantern.webp',
      '/static/assets/product/lantern-cover.webp',
      '/static/assets/product/open-book-feature.webp',
      '/static/assets/product/gallery-01.webp',
      '/static/assets/product/gallery-02.webp',
      '/static/assets/product/gallery-03.webp'
    ]
    for (const p of paths) {
      const asset = db.prepare('SELECT id, public_path, width, height, mime_type FROM media_assets WHERE public_path = ?').get(p) as any
      expect(asset, `Asset not found in media_assets: ${p}`).toBeDefined()
      expect(asset.width).toBeGreaterThan(0)
      expect(asset.height).toBeGreaterThan(0)
      expect(asset.mime_type).toBe('image/webp')
    }
  })

  it('cover association exists and points to /static/assets/books/lantern.webp', () => {
    const { db } = setupMigratedDb()
    const row = db.prepare(`
      SELECT pm.role, pm.sort_order, m.public_path
        FROM product_media pm
        JOIN products p ON p.id = pm.product_id
        JOIN media_assets m ON m.id = pm.media_id
       WHERE p.slug = 'the-lantern-and-the-long-night'
         AND pm.role = 'cover'
    `).get() as any

    expect(row).toBeDefined()
    expect(row.role).toBe('cover')
    expect(row.public_path).toBe('/static/assets/books/lantern.webp')
  })

  it('all intended gallery associations exist with valid role=gallery and correct sort_order', () => {
    const { db } = setupMigratedDb()
    const rows = db.prepare(`
      SELECT pm.role, pm.sort_order, m.public_path
        FROM product_media pm
        JOIN products p ON p.id = pm.product_id
        JOIN media_assets m ON m.id = pm.media_id
       WHERE p.slug = 'the-lantern-and-the-long-night'
         AND pm.role = 'gallery'
       ORDER BY pm.sort_order
    `).all() as any[]

    expect(rows.length).toBe(4)
    expect(rows[0]).toEqual({ role: 'gallery', sort_order: 1, public_path: '/static/assets/product/open-book-feature.webp' })
    expect(rows[1]).toEqual({ role: 'gallery', sort_order: 2, public_path: '/static/assets/product/gallery-01.webp' })
    expect(rows[2]).toEqual({ role: 'gallery', sort_order: 3, public_path: '/static/assets/product/gallery-02.webp' })
    expect(rows[3]).toEqual({ role: 'gallery', sort_order: 4, public_path: '/static/assets/product/gallery-03.webp' })
  })

  it('every inserted role satisfies the schema CHECK constraint and no row was silently ignored', () => {
    const { db } = setupMigratedDb()
    const roles = db.prepare('SELECT DISTINCT role FROM product_media').all() as any[]
    const allowed = new Set(['cover', 'gallery', 'video', 'demo'])
    for (const r of roles) {
      expect(allowed.has(r.role), `Invalid role found: ${r.role}`).toBe(true)
    }

    // Verify total associations for the lantern product: 1 cover + 4 gallery = 5
    const totalAssociations = db.prepare(`
      SELECT COUNT(*) AS n FROM product_media pm
       JOIN products p ON p.id = pm.product_id
      WHERE p.slug = 'the-lantern-and-the-long-night'
    `).get() as { n: number }
    expect(totalAssociations.n).toBe(5)
  })

  it('rerunning migration changes neither row counts nor associations (idempotence)', () => {
    const { db, migrationsDir } = setupMigratedDb()
    const beforeRows = db.prepare(`
      SELECT pm.product_id, pm.media_id, pm.role, pm.sort_order
        FROM product_media pm
       ORDER BY pm.product_id, pm.role, pm.sort_order
    `).all()

    // Re-apply 0034 and 0035
    db.exec(readFileSync(join(migrationsDir, '0034_cream_purple_assets.sql'), 'utf8'))
    db.exec(readFileSync(join(migrationsDir, '0035_repair_product_media_roles.sql'), 'utf8'))

    const afterRows = db.prepare(`
      SELECT pm.product_id, pm.media_id, pm.role, pm.sort_order
        FROM product_media pm
       ORDER BY pm.product_id, pm.role, pm.sort_order
    `).all()

    expect(afterRows).toEqual(beforeRows)
  })
})

describe('Protect Administrator-Customized Galleries (Requirement 2)', () => {
  function setupBaseDb() {
    const db = new DatabaseSync(':memory:')
    const migrationsDir = join(root, 'migrations')
    const files = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()
    for (const f of files.filter((f) => f < '0034')) {
      db.exec(readFileSync(join(migrationsDir, f), 'utf8'))
    }
    db.exec(readFileSync(join(root, 'seed.sql'), 'utf8'))
    return { db, migrationsDir }
  }

  it('Scenario 1: empty seed gallery installs approved Lantern gallery', () => {
    const { db, migrationsDir } = setupBaseDb()
    // Verify initially empty
    const before = db.prepare(`
      SELECT pg.image_url, pg.sort_order, pg.active
        FROM pdp_gallery pg JOIN products p ON p.id = pg.product_id
       WHERE p.slug = 'the-lantern-and-the-long-night'
       ORDER BY pg.sort_order
    `).all() as any[]
    expect(before.length).toBe(0)

    // Apply 0034
    db.exec(readFileSync(join(migrationsDir, '0034_cream_purple_assets.sql'), 'utf8'))

    const after = db.prepare(`
      SELECT pg.image_url, pg.sort_order, pg.active
        FROM pdp_gallery pg JOIN products p ON p.id = pg.product_id
       WHERE p.slug = 'the-lantern-and-the-long-night'
       ORDER BY pg.sort_order
    `).all() as any[]
    expect(after.length).toBe(5)
    expect(after[0].image_url).toBe('/static/assets/product/lantern-cover.webp')
    expect(after[1].image_url).toBe('/static/assets/product/open-book-feature.webp')
    expect(after[2].image_url).toBe('/static/assets/product/gallery-01.webp')
    expect(after[3].image_url).toBe('/static/assets/product/gallery-02.webp')
    expect(after[4].image_url).toBe('/static/assets/product/gallery-03.webp')
  })

  it('Scenario 2: known legacy gallery is safely upgraded', () => {
    const { db, migrationsDir } = setupBaseDb()
    // Seed a known legacy SVG gallery row
    db.exec(`
      INSERT INTO pdp_gallery (product_id, image_url, alt, sort_order, active)
      SELECT id, '/static/img/art/cover-the-lantern-and-the-long-night.svg', 'Legacy SVG', 1, 1
        FROM products WHERE slug = 'the-lantern-and-the-long-night'
    `)

    // Apply 0034
    db.exec(readFileSync(join(migrationsDir, '0034_cream_purple_assets.sql'), 'utf8'))

    const after = db.prepare(`
      SELECT pg.image_url, pg.sort_order, pg.active
        FROM pdp_gallery pg JOIN products p ON p.id = pg.product_id
       WHERE p.slug = 'the-lantern-and-the-long-night'
       ORDER BY pg.sort_order
    `).all() as any[]
    expect(after.length).toBe(5)
    expect(after.some((r) => r.image_url.includes('.svg'))).toBe(false)
    expect(after[0].image_url).toBe('/static/assets/product/lantern-cover.webp')
  })

  it('Scenario 3: fully custom gallery is preserved row-for-row and byte-for-byte', () => {
    const { db, migrationsDir } = setupBaseDb()
    // Admin authored custom gallery
    db.exec(`
      INSERT INTO pdp_gallery (product_id, image_url, alt, sort_order, active)
      SELECT id, '/uploads/admin-custom-lantern-1.webp', 'Custom Photo 1', 1, 1
        FROM products WHERE slug = 'the-lantern-and-the-long-night'
      UNION ALL
      SELECT id, '/uploads/admin-custom-lantern-2.webp', 'Custom Photo 2', 2, 1
        FROM products WHERE slug = 'the-lantern-and-the-long-night'
    `)

    const before = db.prepare(`
      SELECT pg.id, pg.product_id, pg.image_url, pg.alt, pg.sort_order, pg.active
        FROM pdp_gallery pg JOIN products p ON p.id = pg.product_id
       WHERE p.slug = 'the-lantern-and-the-long-night'
       ORDER BY pg.sort_order
    `).all()

    // Apply 0034 and 0035
    db.exec(readFileSync(join(migrationsDir, '0034_cream_purple_assets.sql'), 'utf8'))
    db.exec(readFileSync(join(migrationsDir, '0035_repair_product_media_roles.sql'), 'utf8'))

    const after = db.prepare(`
      SELECT pg.id, pg.product_id, pg.image_url, pg.alt, pg.sort_order, pg.active
        FROM pdp_gallery pg JOIN products p ON p.id = pg.product_id
       WHERE p.slug = 'the-lantern-and-the-long-night'
       ORDER BY pg.sort_order
    `).all()

    expect(after).toEqual(before)
  })

  it('Scenario 4: mixed custom gallery is preserved exactly', () => {
    const { db, migrationsDir } = setupBaseDb()
    db.exec(`
      INSERT INTO pdp_gallery (product_id, image_url, alt, sort_order, active)
      SELECT id, '/static/assets/product/lantern-cover.webp', 'Approved cover', 1, 1
        FROM products WHERE slug = 'the-lantern-and-the-long-night'
      UNION ALL
      SELECT id, '/uploads/admin-extra-spread.webp', 'Admin custom spread', 2, 1
        FROM products WHERE slug = 'the-lantern-and-the-long-night'
    `)

    const before = db.prepare(`
      SELECT pg.id, pg.product_id, pg.image_url, pg.alt, pg.sort_order, pg.active
        FROM pdp_gallery pg JOIN products p ON p.id = pg.product_id
       WHERE p.slug = 'the-lantern-and-the-long-night'
       ORDER BY pg.sort_order
    `).all()

    db.exec(readFileSync(join(migrationsDir, '0034_cream_purple_assets.sql'), 'utf8'))
    db.exec(readFileSync(join(migrationsDir, '0035_repair_product_media_roles.sql'), 'utf8'))

    const after = db.prepare(`
      SELECT pg.id, pg.product_id, pg.image_url, pg.alt, pg.sort_order, pg.active
        FROM pdp_gallery pg JOIN products p ON p.id = pg.product_id
       WHERE p.slug = 'the-lantern-and-the-long-night'
       ORDER BY pg.sort_order
    `).all()

    expect(after).toEqual(before)
  })

  it('Scenario 5: administrator deleting a default image does not cause it to reappear', () => {
    const { db, migrationsDir } = setupBaseDb()
    // Install default gallery first via 0034
    db.exec(readFileSync(join(migrationsDir, '0034_cream_purple_assets.sql'), 'utf8'))

    // Admin deliberately deletes the 5th image (gallery-03.webp)
    db.exec(`
      DELETE FROM pdp_gallery
       WHERE product_id = (SELECT id FROM products WHERE slug = 'the-lantern-and-the-long-night')
         AND image_url = '/static/assets/product/gallery-03.webp'
    `)

    const fourRows = db.prepare(`
      SELECT pg.image_url, pg.sort_order, pg.active
        FROM pdp_gallery pg JOIN products p ON p.id = pg.product_id
       WHERE p.slug = 'the-lantern-and-the-long-night'
       ORDER BY pg.sort_order
    `).all() as any[]
    expect(fourRows.length).toBe(4)

    // Re-apply migration 0034 & 0035
    db.exec(readFileSync(join(migrationsDir, '0034_cream_purple_assets.sql'), 'utf8'))
    db.exec(readFileSync(join(migrationsDir, '0035_repair_product_media_roles.sql'), 'utf8'))

    const afterReapply = db.prepare(`
      SELECT pg.image_url, pg.sort_order, pg.active
        FROM pdp_gallery pg JOIN products p ON p.id = pg.product_id
       WHERE p.slug = 'the-lantern-and-the-long-night'
       ORDER BY pg.sort_order
    `).all() as any[]
    expect(afterReapply).toEqual(fourRows)
  })

  it('Scenario 6: repeated bootstrap and repeated migration preserve custom gallery row-for-row', () => {
    const { db, migrationsDir } = setupBaseDb()
    db.exec(`
      INSERT INTO pdp_gallery (product_id, image_url, alt, sort_order, active)
      SELECT id, '/uploads/my-gallery-1.webp', 'Admin 1', 1, 1
        FROM products WHERE slug = 'the-lantern-and-the-long-night'
      UNION ALL
      SELECT id, '/uploads/my-gallery-2.webp', 'Admin 2', 2, 1
        FROM products WHERE slug = 'the-lantern-and-the-long-night'
    `)

    const initial = db.prepare(`
      SELECT pg.id, pg.product_id, pg.image_url, pg.alt, pg.sort_order, pg.active
        FROM pdp_gallery pg JOIN products p ON p.id = pg.product_id
       WHERE p.slug = 'the-lantern-and-the-long-night'
       ORDER BY pg.sort_order
    `).all()

    // Multiple passes of migration re-execution
    db.exec(readFileSync(join(migrationsDir, '0034_cream_purple_assets.sql'), 'utf8'))
    db.exec(readFileSync(join(migrationsDir, '0035_repair_product_media_roles.sql'), 'utf8'))
    db.exec(readFileSync(join(migrationsDir, '0034_cream_purple_assets.sql'), 'utf8'))
    db.exec(readFileSync(join(migrationsDir, '0035_repair_product_media_roles.sql'), 'utf8'))

    const final = db.prepare(`
      SELECT pg.id, pg.product_id, pg.image_url, pg.alt, pg.sort_order, pg.active
        FROM pdp_gallery pg JOIN products p ON p.id = pg.product_id
       WHERE p.slug = 'the-lantern-and-the-long-night'
       ORDER BY pg.sort_order
    `).all()

    expect(final).toEqual(initial)
  })
})

describe('Truthful Marketing and Factual Content (Requirement 3)', () => {
  it('storefront homepage contains zero ungrounded marketing claims', async () => {
    const res = await app.request('/', {}, env as never)
    expect(res.status).toBe(200)
    const html = await res.text()

    const prohibitedPhrases = [
      'Features the same photo and name as their story',
      'Premium durable matte-finish vinyl stickers',
      'Great for water bottles, lunchboxes and notebooks',
      'Archival Quality Keepsake',
      'Archival Quality',
      'Heavyweight paper and sturdy square binding',
      'Your uploaded photo is used solely to generate your preview',
      'Private & secure',
      'Curated catalogue',
      'Keepsake Quality',
      'Keepsake Add-on'
    ]

    for (const phrase of prohibitedPhrases) {
      expect(html, `Prohibited claim found on homepage: "${phrase}"`).not.toContain(phrase)
    }
  })

  it('storefront PDP contains zero ungrounded durability or keepsake claims', async () => {
    const res = await app.request('/books/the-lantern-and-the-long-night', {}, env as never)
    expect(res.status).toBe(200)
    const html = await res.text()

    const prohibitedPhrases = [
      'sturdy, vibrant, and made to last',
      'Water-resistant and built for kid hands',
      'Archival Quality'
    ]

    for (const phrase of prohibitedPhrases) {
      expect(html, `Prohibited claim found on PDP: "${phrase}"`).not.toContain(phrase)
    }
  })
})

describe('PDP Gallery Accessibility & Navigation (Requirement 6)', () => {
  it('renders PDP gallery thumbnail rail with tablist and tab accessibility attributes', async () => {
    const res = await app.request('/books/the-lantern-and-the-long-night', {}, env as never)
    expect(res.status).toBe(200)
    const html = await res.text()

    expect(html).toContain('role="tablist"')
    expect(html).toContain('aria-label="Image gallery thumbnails"')
    expect(html).toContain('role="tab"')
    expect(html).toContain('aria-selected="true"')
    expect(html).toContain('aria-current="true"')
    expect(html).toContain('tabindex="0"')
    expect(html).toContain('aria-selected="false"')
    expect(html).toContain('tabindex="-1"')
  })

  it('pdp.js supports keyboard arrow navigation and dynamic ARIA state updates', () => {
    const pdpJs = readFileSync(join(root, 'public', 'static', 'pdp.js'), 'utf8')
    expect(pdpJs).toContain('ArrowLeft')
    expect(pdpJs).toContain('ArrowRight')
    expect(pdpJs).toContain("setAttribute('aria-selected'")
    expect(pdpJs).toContain("setAttribute('aria-current'")
  })
})

