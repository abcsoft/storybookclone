import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')
const outDir = join(root, 'audit-evidence', 'defect-reproduction')
mkdirSync(outDir, { recursive: true })

const BASE_URL = process.env.BASE_URL || 'http://localhost:5173'

async function run() {
  const browser = await chromium.launch()

  const viewports = [
    { name: '1440x1000', width: 1440, height: 1000 },
    { name: '1874x954', width: 1874, height: 954 },
    { name: '390x844', width: 390, height: 844 }
  ]

  for (const vp of viewports) {
    const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height } })
    await page.goto(BASE_URL, { waitUntil: 'networkidle' })

    const shotPath = join(outDir, `homepage_${vp.name}.png`)
    await page.screenshot({ path: shotPath, fullPage: true })
    console.log(`Saved screenshot: ${shotPath}`)

    // Measure live values on 1440x1000 and 1874x954
    const measurements = await page.evaluate(() => {
      const container = document.querySelector('.hero .hero-inner, .shelf-inner, .steps-inner, .wrap, main > section > div')
      const card = document.querySelector('.product-card, .book-card')
      const media = card?.querySelector('.card-cover-wrap, img')
      const img = card?.querySelector('img')
      const h1 = document.querySelector('h1')
      const h2 = document.querySelector('h2')
      const cardTitle = card?.querySelector('.card-title, h3')
      const cardCta = card?.querySelector('.card-cta, .btn')
      const cardBody = card?.querySelector('.card-body')

      const cardRect = card?.getBoundingClientRect()
      const mediaRect = media?.getBoundingClientRect()

      return {
        contentWidth: container?.getBoundingClientRect().width,
        cardWidth: cardRect?.width,
        cardHeight: cardRect?.height,
        mediaWidth: mediaRect?.width,
        mediaHeight: mediaRect?.height,
        mediaComputedAspectRatio: media ? window.getComputedStyle(media).aspectRatio : null,
        mediaCalculatedRatio: mediaRect ? (mediaRect.width / mediaRect.height).toFixed(2) : null,
        imgSrc: img?.src,
        imgNaturalWidth: img?.naturalWidth,
        imgNaturalHeight: img?.naturalHeight,
        heading1FontSize: h1 ? window.getComputedStyle(h1).fontSize : null,
        heading2FontSize: h2 ? window.getComputedStyle(h2).fontSize : null,
        cardTitleFontSize: cardTitle ? window.getComputedStyle(cardTitle).fontSize : null,
        buttonHeight: cardCta ? cardCta.getBoundingClientRect().height : null,
        cardBodyPadding: cardBody ? window.getComputedStyle(cardBody).padding : null,
        cardBodyGap: cardBody ? window.getComputedStyle(cardBody).gap : null
      }
    })

    console.log(`\n=== Live Measurements @ ${vp.name} ===`)
    console.log(JSON.stringify(measurements, null, 2))

    await page.close()
  }

  await browser.close()
}

run().catch(console.error)
