import { chromium } from 'playwright'
import { mkdirSync, copyFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const BASE = 'http://localhost:5173'
const ARTIFACT_DIR = 'C:/Users/mehed/.gemini/antigravity-ide/brain/48d813b0-cf8f-4eac-805d-42556ce38b72'
const AUDIT_DIR = join(process.cwd(), 'audit-evidence', 'visual-acceptance')

mkdirSync(AUDIT_DIR, { recursive: true })

const VIEWPORTS = [
  { width: 320, height: 800, name: '320x800_mobile_small' },
  { width: 375, height: 812, name: '375x812_mobile_medium' },
  { width: 390, height: 844, name: '390x844_mobile_standard' },
  { width: 768, height: 1024, name: '768x1024_tablet' },
  { width: 1024, height: 768, name: '1024x768_desktop_small' },
  { width: 1280, height: 900, name: '1280x900_desktop_standard' },
  { width: 1440, height: 1000, name: '1440x1000_desktop_wide' },
  { width: 1874, height: 954, name: '1874x954_desktop_ultra' }
]

async function run() {
  console.log(`[fidelity-audit] Launching browser to audit ${BASE}...`)
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext()

  const findings = []
  const measurements = []

  for (const vp of VIEWPORTS) {
    console.log(`\n--- Auditing Viewport ${vp.width}x${vp.height} (${vp.name}) ---`)
    const page = await context.newPage()
    await page.setViewportSize({ width: vp.width, height: vp.height })

    const consoleErrors = []
    const failedRequests = []

    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text())
    })

    page.on('response', (res) => {
      if (res.status() >= 400) {
        failedRequests.push(`${res.status()} ${res.url()}`)
      }
    })

    await page.goto(`${BASE}/`, { waitUntil: 'networkidle' })

    // Save fullpage screenshot
    const screenshotPath = join(AUDIT_DIR, `homepage_${vp.width}x${vp.height}.png`)
    await page.screenshot({ path: screenshotPath, fullPage: true })
    console.log(`Saved screenshot: ${screenshotPath}`)

    // Copy key viewports to brain artifact directory
    if (['1440x1000', '1874x954', '390x844'].includes(`${vp.width}x${vp.height}`)) {
      const artifactPath = join(ARTIFACT_DIR, `after_homepage_${vp.width}x${vp.height}.png`)
      copyFileSync(screenshotPath, artifactPath)
      console.log(`Copied key screenshot to artifacts: ${artifactPath}`)
    }

    // Check horizontal overflow
    const overflow = await page.evaluate(() => {
      return {
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
        hasOverflow: document.documentElement.scrollWidth > window.innerWidth + 1
      }
    })
    if (overflow.hasOverflow) {
      findings.push(`[${vp.name}] Horizontal overflow detected: scrollWidth=${overflow.scrollWidth} > innerWidth=${overflow.innerWidth}`)
    }

    // Measure cards and images
    const cardData = await page.evaluate(() => {
      const cards = Array.from(document.querySelectorAll('.product-card'))
      const container = document.querySelector('.shelf-section-redesigned .wrap') || document.querySelector('.wrap')
      const containerRect = container ? container.getBoundingClientRect() : null

      const cardMetrics = cards.map((c, idx) => {
        const rect = c.getBoundingClientRect()
        const img = c.querySelector('.card-cover-wrap img, img')
        const title = c.querySelector('.card-title')
        const cta = c.querySelector('.card-cta')

        return {
          idx,
          width: rect.width,
          height: rect.height,
          bottom: rect.bottom,
          img: img ? {
            src: img.src,
            naturalWidth: img.naturalWidth,
            naturalHeight: img.naturalHeight,
            clientWidth: img.clientWidth,
            clientHeight: img.clientHeight,
            isSvg: img.src.endsWith('.svg') || img.src.includes('.svg'),
            isSmallCrop: img.src.includes('assets/books/')
          } : null,
          title: title ? {
            text: title.textContent?.trim(),
            height: title.getBoundingClientRect().height,
            fontSize: window.getComputedStyle(title).fontSize
          } : null,
          cta: cta ? {
            text: cta.textContent?.trim(),
            height: cta.getBoundingClientRect().height
          } : null
        }
      })

      // Group cards into rows by approx vertical offset
      const rows = []
      let currentRow = []
      let lastTop = -1
      for (const c of cards) {
        const top = Math.round(c.getBoundingClientRect().top)
        if (lastTop === -1 || Math.abs(top - lastTop) < 10) {
          currentRow.push(c)
        } else {
          rows.push(currentRow.length)
          currentRow = [c]
        }
        lastTop = top
      }
      if (currentRow.length > 0) rows.push(currentRow.length)

      return {
        containerWidth: containerRect ? containerRect.width : 0,
        cardsCount: cards.length,
        cardsPerRow: rows[0] || 0,
        sampleCard: cardMetrics[0] || null,
        allCards: cardMetrics
      }
    })

    measurements.push({
      viewport: `${vp.width}x${vp.height}`,
      containerWidth: Math.round(cardData.containerWidth),
      cardsPerRow: cardData.cardsPerRow,
      sampleCard: cardData.sampleCard
    })

    console.log(`Measured: Container width=${Math.round(cardData.containerWidth)}px, Cards/row=${cardData.cardsPerRow}`)
    if (cardData.sampleCard) {
      console.log(`Sample Card: ${Math.round(cardData.sampleCard.width)}x${Math.round(cardData.sampleCard.height)}px`)
      if (cardData.sampleCard.img) {
        console.log(`Sample Card Media: ${Math.round(cardData.sampleCard.img.clientWidth)}x${Math.round(cardData.sampleCard.img.clientHeight)}px, natural=${cardData.sampleCard.img.naturalWidth}x${cardData.sampleCard.img.naturalHeight} (SVG=${cardData.sampleCard.img.isSvg})`)
      }
      if (cardData.sampleCard.cta) {
        console.log(`Sample Card CTA Height: ${Math.round(cardData.sampleCard.cta.height)}px`)
      }
    }

    // Invariant assertions
    if (consoleErrors.length > 0) {
      findings.push(`[${vp.name}] Console errors: ${consoleErrors.join('; ')}`)
    }
    if (failedRequests.length > 0) {
      findings.push(`[${vp.name}] Failed asset requests: ${failedRequests.join('; ')}`)
    }

    // Verify raster scale
    for (const card of cardData.allCards) {
      if (!card.img) continue
      if (card.img.isSmallCrop) {
        findings.push(`[${vp.name}] Card ${card.idx} is using small thumbnail crop: ${card.img.src}`)
      }
      if (!card.img.isSvg && card.img.naturalWidth > 0) {
        const ratio = card.img.clientWidth / card.img.naturalWidth
        if (ratio > 1.25) {
          findings.push(`[${vp.name}] Blurry raster image on card ${card.idx}: naturalWidth=${card.img.naturalWidth} rendered=${card.img.clientWidth} (ratio ${ratio.toFixed(2)})`)
        }
      }
    }

    // Grid columns check
    if (vp.width >= 1024 && cardData.cardsPerRow !== 4 && cardData.cardsCount >= 4) {
      findings.push(`[${vp.name}] Expected 4 cards per row on desktop, got ${cardData.cardsPerRow}`)
    }
    if (vp.width === 768 && cardData.cardsPerRow !== 2) {
      findings.push(`[${vp.name}] Expected 2 cards per row on tablet, got ${cardData.cardsPerRow}`)
    }
    if (vp.width <= 640 && cardData.cardsPerRow !== 1) {
      findings.push(`[${vp.name}] Expected 1 card per row on mobile, got ${cardData.cardsPerRow}`)
    }

    await page.close()
  }

  // Also verify /books (catalog) and PDP /books/the-lantern-and-the-long-night
  console.log('\n--- Auditing Catalog Page (/books) ---')
  const catalogPage = await context.newPage()
  await catalogPage.setViewportSize({ width: 1440, height: 1000 })
  const catRes = await catalogPage.goto(`${BASE}/books`, { waitUntil: 'networkidle' })
  console.log(`Catalog response status: ${catRes.status()}`)
  await catalogPage.screenshot({ path: join(AUDIT_DIR, 'catalog_1440x1000.png'), fullPage: true })
  await catalogPage.close()

  console.log('\n--- Auditing PDP (/books/the-lantern-and-the-long-night) ---')
  const pdpPage = await context.newPage()
  await pdpPage.setViewportSize({ width: 1440, height: 1000 })
  const pdpRes = await pdpPage.goto(`${BASE}/books/the-lantern-and-the-long-night`, { waitUntil: 'networkidle' })
  console.log(`PDP response status: ${pdpRes.status()}`)
  await pdpPage.screenshot({ path: join(AUDIT_DIR, 'pdp_1440x1000.png'), fullPage: true })
  await pdpPage.close()

  await browser.close()

  console.log('\n================ AUDIT SUMMARY ================')
  console.log('Measurements across viewports:')
  console.table(measurements.map(m => ({
    viewport: m.viewport,
    containerWidth: m.containerWidth,
    cardsPerRow: m.cardsPerRow,
    cardDimensions: m.sampleCard ? `${Math.round(m.sampleCard.width)}x${Math.round(m.sampleCard.height)}` : 'N/A',
    mediaDimensions: m.sampleCard?.img ? `${Math.round(m.sampleCard.img.clientWidth)}x${Math.round(m.sampleCard.img.clientHeight)}` : 'N/A',
    isSvg: m.sampleCard?.img?.isSvg
  })))

  if (findings.length > 0) {
    console.error('\nFINDINGS DETECTED:')
    for (const f of findings) console.error(` - ${f}`)
    process.exit(1)
  } else {
    console.log('\nSUCCESS: 0 visual findings! All invariants passed across all 8 viewports!')
  }
}

run().catch((err) => {
  console.error('Fatal error during fidelity audit:', err)
  process.exit(1)
})
