import { chromium } from 'playwright'
import { mkdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')
const outDir = join(root, 'audit-evidence', 'after-redesign')
mkdirSync(outDir, { recursive: true })

const BASE_URL = process.env.BASE_URL || 'http://localhost:5173'

async function run() {
  console.log(`Starting visual capture and verification against ${BASE_URL}...`)
  const browser = await chromium.launch()

  const pagesToTest = [
    { name: 'homepage', path: '/' },
    { name: 'collection', path: '/collections' },
    { name: 'pdp', path: '/books/the-lantern-and-the-long-night' },
    { name: 'login', path: '/login' },
    { name: 'cart', path: '/cart' },
    { name: 'how_it_works', path: '/how-it-works' },
  ]

  const viewports = [
    { name: '360x800', width: 360, height: 800 },
    { name: '390x844', width: 390, height: 844 },
    { name: '768x1024', width: 768, height: 1024 },
    { name: '1024x768', width: 1024, height: 768 },
    { name: '1440x900', width: 1440, height: 900 }
  ]

  let totalErrors = 0
  let totalFailedImages = 0
  let totalOverflows = 0

  for (const vp of viewports) {
    console.log(`\n--- Testing Viewport ${vp.name} (${vp.width}x${vp.height}) ---`)
    const context = await browser.newContext({
      viewport: { width: vp.width, height: vp.height }
    })
    const page = await context.newPage()

    // Listen for console errors & failed requests
    page.on('console', msg => {
      if (msg.type() === 'error') {
        console.error(`[CONSOLE ERROR] [${vp.name}] ${msg.text()}`)
        totalErrors++
      }
    })

    page.on('response', resp => {
      if (resp.status() >= 400) {
        console.error(`[HTTP ${resp.status()}] [${vp.name}] ${resp.url()}`)
        if (resp.url().match(/\.(png|jpe?g|webp|svg)/i)) {
          totalFailedImages++
        }
      }
    })

    for (const p of pagesToTest) {
      const url = `${BASE_URL}${p.path}`
      const resp = await page.goto(url, { waitUntil: 'networkidle' })
      if (!resp || resp.status() !== 200) {
        console.error(`Failed to load ${url}: status ${resp ? resp.status() : 'no response'}`)
        totalErrors++
        continue
      }

      // Check design marker
      const hasMarker = await page.evaluate(() => {
        return document.querySelector('[data-design-version="cream-purple-v2"]') !== null
      })
      if (!hasMarker) {
        console.error(`[MARKER MISSING] ${url} does not have data-design-version="cream-purple-v2"`)
        totalErrors++
      }

      // Check horizontal overflow
      const overflow = await page.evaluate(() => {
        return {
          scrollWidth: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
          hasOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
        }
      })
      if (overflow.hasOverflow) {
        console.error(`[OVERFLOW] ${p.name} @ ${vp.name}: scrollWidth=${overflow.scrollWidth} > clientWidth=${overflow.clientWidth}`)
        totalOverflows++
      }

      // Capture full-page screenshot for primary viewports (1440x900 and 390x844)
      if (vp.name === '1440x900' || vp.name === '390x844') {
        const shotPath = join(outDir, `after_${p.name}_${vp.name}.png`)
        await page.screenshot({ path: shotPath, fullPage: true })
        console.log(`Saved screenshot: ${shotPath}`)
      }
    }

    // On 1440x900, capture individual redesigned sections of homepage
    if (vp.name === '1440x900') {
      await page.goto(`${BASE_URL}/`, { waitUntil: 'networkidle' })
      const sections = [
        { name: '01_hero', selector: '.hero' },
        { name: '02_bestsellers_shelf', selector: '.shelf-section-redesigned' },
        { name: '03_how_it_works', selector: '.steps-section-redesigned' },
        { name: '04_photo_guidance', selector: '.photo-guidance-redesigned' },
        { name: '05_collections_grid', selector: '.collection-grid-redesigned' },
        { name: '06_age_discovery', selector: '.age-section-redesigned' },
        { name: '07_sticker_cross_sell', selector: '.sticker-cross-sell-redesigned' },
        { name: '08_editorial_feature', selector: '.editorial-feature-redesigned' },
        { name: '09_faq_preview', selector: '.faq-preview-redesigned' },
        { name: '10_footer', selector: '.site-footer' }
      ]

      for (const s of sections) {
        const el = await page.$(s.selector)
        if (el) {
          const sPath = join(outDir, `after_section_${s.name}.png`)
          await el.screenshot({ path: sPath })
          console.log(`Saved section screenshot: ${sPath}`)
        } else {
          console.warn(`[SECTION MISSING] Selector not found: ${s.selector}`)
        }
      }
    }

    await context.close()
  }

  await browser.close()

  console.log(`\n=== VERIFICATION SUMMARY ===`)
  console.log(`Total console errors: ${totalErrors}`)
  console.log(`Total failed images: ${totalFailedImages}`)
  console.log(`Total horizontal overflows: ${totalOverflows}`)

  if (totalErrors > 0 || totalFailedImages > 0 || totalOverflows > 0) {
    console.error('❌ Acceptance criteria failed!')
    process.exit(1)
  } else {
    console.log('✅ ALL VIEWPORT, ASSET, AND OVERFLOW CHECKS PASSED!')
  }
}

run().catch(err => {
  console.error(err)
  process.exit(1)
})
