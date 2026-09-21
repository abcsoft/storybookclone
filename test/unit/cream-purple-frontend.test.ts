// Unit tests for Cream-Purple Frontend design system integration.
import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { app, freshEnv, type TestEnv } from '../helpers/testApp'
import { COLOR_TOKENS, DESIGN_TOKENS } from '../../src/theme'

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

describe('Asset safety and presence', () => {
  it('ships required production assets in public/static/assets', () => {
    const requiredAssets = [
      'hero/open-book-boy.webp',
      'features/open-book-girl.webp',
      'personalization/child-photo.webp',
      'personalization/child-illustrated.webp',
      'icons/book.svg',
      'icons/user.svg',
      'icons/edit.svg',
      'icons/gift.svg'
    ]
    for (const rel of requiredAssets) {
      const fullPath = join(root, 'public', 'static', 'assets', rel)
      expect(existsSync(fullPath), `Asset missing: ${rel}`).toBe(true)
    }
  })

  it('does not ship banned reference-brand or removed assets', () => {
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

describe('Storefront markup & accessibility contracts', () => {
  it('renders hero note, step icons, photo pair and nav CTA on homepage', async () => {
    const res = await app.request('/', {}, env as never)
    expect(res.status).toBe(200)
    const html = await res.text()

    // Hero note & hero image
    expect(html).toContain('Meaningful gifts · Personal stories · Shared storytime')
    expect(html).toContain('/static/assets/hero/open-book-boy.webp')

    // Steps icons
    expect(html).toContain('/static/assets/icons/book.svg')
    expect(html).toContain('/static/assets/icons/user.svg')
    expect(html).toContain('/static/assets/icons/edit.svg')
    expect(html).toContain('/static/assets/icons/gift.svg')

    // Photo pair
    expect(html).toContain('/static/assets/personalization/child-photo.webp')
    expect(html).toContain('/static/assets/personalization/child-illustrated.webp')

    // Nav CTA
    expect(html).toContain('Create your book')
    expect(html).toContain('class="nav-cta"')
    expect(html).toContain('class="mobile-drawer-cta"')

    // Mobile drawer accessible controls
    expect(html).toContain('aria-controls="mobile-drawer"')
    expect(html).toContain('id="menu-toggle"')
    expect(html).toContain('id="mobile-drawer"')

    // Every img element has width and height
    const imgs = html.match(/<img\b[^>]*>/g) || []
    expect(imgs.length).toBeGreaterThan(0)
    for (const img of imgs) {
      expect(img, `image tag without width: ${img}`).toMatch(/\bwidth="\d+"/)
      expect(img, `image tag without height: ${img}`).toMatch(/\bheight="\d+"/)
    }
  })

  it('renders zero cross-origin resources', async () => {
    const res = await app.request('/', {}, env as never)
    const html = await res.text()
    // Find any href/src starting with http:// or https:// (except schema.org in jsonld or rel=canonical/alternate)
    const stripped = html
      .replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/g, '')
      .replace(/<link\s+[^>]*rel="(canonical|alternate)"[^>]*>/g, '')
    const remoteMatches = stripped.match(/(?:src|href)=["']https?:\/\/[^"']+/g) || []
    expect(remoteMatches).toEqual([])
  })
})
