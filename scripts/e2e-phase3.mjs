// V2 Phase 3 generation E2E journeys (agent-authored addition to
// scripts/test-e2e.mjs). Kept in a separate file so the original journey file
// stays readable; `scripts/test-e2e.mjs` imports and calls `runPhase3Journeys`.
//
// What this proves, against a REAL local wrangler server, REAL D1 and REAL R2 —
// with the deterministic offline providers (zero paid calls):
//
//   1. an owned personalization produces ONE multi-scene preview, created by
//      clicking the real "Create my preview" control;
//   2. the preview is NOT a static mock: the rows, the watermarked assets, the
//      scene count and the manifest checksum are read back from the database,
//      and the images are served from the private preview route;
//   3. the preview survives a full page refresh, because the panel is
//      server-rendered from the job/preview rows;
//   4. it is visible to its owner and DENIED to another user and to anonymous
//      callers, and the unwatermarked ORIGINAL namespace is never served;
//   5. approving works against an exact version, and editing the details
//      afterwards invalidates that approval (GEN-11).

export async function runPhase3Journeys({ browser, base, log, fail, attachDiagnostics, assertClean, admin, queryD1 }) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  const page = await context.newPage()
  // Two of the assertions below are DELIBERATE denials, so their diagnostic
  // noise is explicitly allowed (and still logged): fetching an ORIGINAL under
  // the preview route must 404, and approving a stale preview must 409. Any
  // OTHER 4xx/5xx still fails the journey.
  const diag = attachDiagnostics(page, [/\/previews\/gen\/original\//, /\/approvals$/])
  const runId = Date.now().toString(36)
  const photoUpload = await makeFixturePhoto()
  const email = `phase3-owner-${runId}@example.com`

  try {
    // ---------------------------------------------------------------- 0
    log('phase3.0', 'register an account and personalize a book through the real PDP')
    await register(page, base, email)
    const slug = 'the-star-collector'
    const bookId = await personalize(page, base, { slug, childName: 'Amara', photo: photoUpload })

    // ---------------------------------------------------------------- 1
    log('phase3.1', 'the reader page shows a real generation panel with a working control')
    await page.goto(`${base}/my/books/${slug}?userBookId=${encodeURIComponent(bookId)}`)
    await page.waitForSelector('#generation-panel', { timeout: 30000 })
    const startButton = page.locator('#gen-start')
    if (!(await startButton.count())) fail('phase3.1', 'no "Create my preview" control was rendered for a ready book')
    const panelState = await page.getAttribute('#generation-panel', 'data-book-state')
    if (panelState !== 'ready_to_generate') fail('phase3.1b', `expected the book to be ready_to_generate, got ${panelState}`)
    // The panel must not claim generation is switched off when it is configured.
    const bodyText = await page.textContent('#generation-panel')
    if (/not switched on/i.test(bodyText || '')) fail('phase3.1c', `the panel reported generation as disabled in a configured environment: ${bodyText}`)
    if (!/create a watermarked preview/i.test(bodyText || '')) fail('phase3.1d', `the panel did not explain what creating a preview does: ${bodyText}`)

    // ---------------------------------------------------------------- 2
    log('phase3.2', 'clicking it runs the REAL pipeline and stores a multi-scene preview')
    await startButton.click()
    // The panel polls; once the preview exists, generation.js reloads the page
    // so the stored pages appear.
    await page.waitForSelector('#gen-pages img', { timeout: 180000 })

    const versions = queryD1(`SELECT id, status, scene_count, input_revision, manifest_checksum, watermark_label FROM preview_versions ORDER BY id DESC LIMIT 1;`)
    if (versions.length !== 1) fail('phase3.2', `expected exactly one preview version row, got ${versions.length}`)
    const version = versions[0]
    if (version.status !== 'ready') fail('phase3.2b', `the stored preview is not ready: ${version.status}`)
    if (Number(version.scene_count) !== 6) fail('phase3.2c', `expected a SIX-scene preview, got ${version.scene_count}`)
    if (!/^[a-f0-9]{64}$/.test(version.manifest_checksum)) fail('phase3.2d', `the manifest checksum is not a SHA-256: ${version.manifest_checksum}`)
    if (!version.watermark_label) fail('phase3.2e', 'the preview row records no watermark label')
    log('phase3.2f', `stored preview version ${version.id} at revision ${version.input_revision} with ${version.scene_count} scenes`)

    const assets = queryD1(`SELECT asset_type, COUNT(*) AS n FROM preview_assets GROUP BY asset_type;`)
    if (assets.length !== 1 || Number(assets[0].n) !== 6) fail('phase3.2g', `expected 6 preview assets, got ${JSON.stringify(assets)}`)
    const notWatermarked = queryD1(`SELECT COUNT(*) AS n FROM preview_assets WHERE is_watermarked != 1;`)
    if (Number(notWatermarked[0].n) !== 0) fail('phase3.2h', 'a preview asset is not watermarked')
    const originals = queryD1(`SELECT COUNT(*) AS n FROM generated_assets WHERE asset_type = 'illustration_original' AND object_key LIKE 'gen/original/%';`)
    if (Number(originals[0].n) !== 6) fail('phase3.2i', `expected 6 private originals, got ${originals[0].n}`)
    const texts = queryD1(`SELECT COUNT(*) AS n FROM generated_assets WHERE asset_type = 'story_text' AND text_content LIKE '%Amara%';`)
    if (Number(texts[0].n) < 1) fail('phase3.2j', 'no generated story text names the child — the personalization is not real')

    // The rendered page shows every scene, labelled as a watermarked preview.
    const pageCount = await page.locator('#gen-pages img').count()
    if (pageCount !== 6) fail('phase3.2k', `the panel rendered ${pageCount} preview images, expected 6`)
    const srcs = await page.$$eval('#gen-pages img', (els) => els.map((e) => e.getAttribute('src')))
    if (srcs.some((s) => !s || !s.startsWith('/previews/gen/preview/'))) fail('phase3.2l', `preview images are not served from the private preview route: ${JSON.stringify(srcs)}`)
    const alts = await page.$$eval('#gen-pages img', (els) => els.map((e) => e.getAttribute('alt') || ''))
    if (!alts.every((a) => /watermarked preview/i.test(a))) fail('phase3.2m', `preview images lack descriptive alt text: ${JSON.stringify(alts)}`)

    // ---------------------------------------------------------------- 3
    log('phase3.3', 'the stored preview bytes are a real, watermarked JPEG fetched over the private route')
    const firstSrc = srcs[0]
    const fetched = await page.evaluate(async (src) => {
      const res = await fetch(src)
      const buffer = await res.arrayBuffer()
      const bytes = new Uint8Array(buffer)
      return { status: res.status, cacheControl: res.headers.get('cache-control'), length: bytes.length, magic: Array.from(bytes.slice(0, 3)) }
    }, firstSrc)
    if (fetched.status !== 200) fail('phase3.3', `the preview asset returned HTTP ${fetched.status}`)
    if (fetched.magic.join(',') !== '255,216,255') fail('phase3.3b', `the preview asset is not a JPEG (first bytes ${fetched.magic})`)
    if (fetched.length < 5000) fail('phase3.3c', `the preview asset is implausibly small (${fetched.length} bytes)`)
    if (!/no-store/.test(fetched.cacheControl || '')) fail('phase3.3d', `the private preview is cacheable: ${fetched.cacheControl}`)

    // ---------------------------------------------------------------- 4
    log('phase3.4', 'another user and an anonymous caller are both DENIED, and originals are never served')
    const stranger = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    const strangerPage = await stranger.newPage()
    try {
      await register(strangerPage, base, `phase3-stranger-${runId}@example.com`)
      const denied = await strangerPage.evaluate(async (src) => (await fetch(src)).status, firstSrc)
      if (denied !== 404) fail('phase3.4', `a second user got HTTP ${denied} for someone else's preview (expected 404)`)
    } finally {
      await stranger.close()
    }
    const anonContext = await browser.newContext()
    const anonPage = await anonContext.newPage()
    try {
      // A fresh context starts on about:blank, where a relative URL cannot be
      // resolved — load a real page first so this is a genuine same-origin
      // request with no session.
      await anonPage.goto(`${base}/`)
      const anon = await anonPage.evaluate(async (src) => (await fetch(src)).status, firstSrc)
      if (anon !== 404) fail('phase3.4b', `an anonymous caller got HTTP ${anon} for a private preview (expected 404)`)
    } finally {
      await anonContext.close()
    }
    const originalKey = queryD1(`SELECT object_key FROM generated_assets WHERE asset_type = 'illustration_original' LIMIT 1;`)[0].object_key
    const originalStatus = await page.evaluate(async (key) => (await fetch(`/previews/${key}`)).status, originalKey)
    if (originalStatus !== 404) fail('phase3.4c', `the OWNER could fetch an unwatermarked original (HTTP ${originalStatus}) — originals must never be served`)

    // ---------------------------------------------------------------- 5
    log('phase3.5', 'the preview SURVIVES a full refresh (it is server-rendered, not client state)')
    await page.reload({ waitUntil: 'load' })
    await page.waitForSelector('#gen-pages img')
    const afterReload = await page.locator('#gen-pages img').count()
    if (afterReload !== 6) fail('phase3.5', `after a refresh the panel rendered ${afterReload} preview images, expected 6`)
    const reloadedText = await page.textContent('#generation-panel')
    if (!/version 1/i.test(reloadedText || '')) fail('phase3.5b', `the reloaded panel did not name the stored preview version: ${reloadedText}`)

    // ---------------------------------------------------------------- 6
    log('phase3.6', 'approval is of an EXACT version, and a later edit invalidates it (GEN-11)')
    await page.click('#gen-approve')
    // The panel must show the approved state WITHOUT a reload, and must stop
    // offering the approve action.
    await page.waitForSelector('#gen-approved-flag', { timeout: 30000 })
    if (await page.locator('#gen-approved-flag').isHidden()) fail('phase3.6-pre0', 'the approved note is in the DOM but not visible')
    // The approve control must not be ACTIONABLE after the version is approved
    // (the block stays in the DOM but hidden, so a keyboard/pointer user cannot
    // approve the same version twice).
    if (await page.locator('#gen-approve').isVisible()) fail('phase3.6-pre', 'the panel still offers a usable "Approve" control after the version was approved')
    const panelAfterApprove = await page.textContent('#generation-panel')
    if (!/you approved version 1/i.test(panelAfterApprove || '')) fail('phase3.6-pre2', `the panel did not confirm the approval: ${panelAfterApprove}`)
    const approvals = queryD1(`SELECT decision, preview_version_id FROM approvals ORDER BY id DESC LIMIT 1;`)
    if (!approvals.length || approvals[0].decision !== 'approved') fail('phase3.6', `no approval row was recorded: ${JSON.stringify(approvals)}`)

    // Editing the details creates a NEW revision and invalidates the approval.
    await page.goto(`${base}/my/books/${slug}?userBookId=${encodeURIComponent(bookId)}`)
    await page.waitForSelector('#generation-panel')
    await page.evaluate(async (id) => {
      const token = (document.cookie.match(/(?:^|;\s*)ww_csrf=([^;]+)/) || [])[1] || ''
      const res = await fetch(`/api/v1/user-books/${encodeURIComponent(id)}/personalization`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': decodeURIComponent(token) },
        body: JSON.stringify({ childName: 'Nia' })
      })
      if (res.status !== 200) throw new Error(`patch failed with ${res.status}`)
    }, bookId)
    const invalidated = queryD1(`SELECT decision FROM approvals ORDER BY id DESC LIMIT 1;`)
    if (!invalidated.length || invalidated[0].decision !== 'invalidated') {
      fail('phase3.6b', `a new revision did not invalidate the prior approval: ${JSON.stringify(invalidated)}`)
    }
    const revision = queryD1(`SELECT current_revision FROM user_books WHERE public_id = '${bookId}';`)
    if (Number(revision[0].current_revision) !== 2) fail('phase3.6c', `the edit did not create revision 2 (got ${revision[0].current_revision})`)

    // The stale approval cannot be re-used: approving the OLD version is refused.
    const staleApprove = await page.evaluate(async (id) => {
      const token = (document.cookie.match(/(?:^|;\s*)ww_csrf=([^;]+)/) || [])[1] || ''
      const res = await fetch(`/api/v1/user-books/${encodeURIComponent(id)}/approvals`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': decodeURIComponent(token) },
        body: JSON.stringify({ previewVersion: 1 })
      })
      return res.status
    }, bookId)
    if (staleApprove !== 409) fail('phase3.6d', `approving a stale preview returned ${staleApprove}, expected 409`)

    // ---------------------------------------------------------------- 7
    log('phase3.7', 'the admin generation screens render real data for the operator')
    const adminContext = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    const adminPage = await adminContext.newPage()
    const adminDiag = attachDiagnostics(adminPage)
    try {
      await adminPage.goto(`${base}/admin/login`)
      await adminPage.fill('input[name=email]', admin.email)
      await adminPage.fill('input[name=password]', admin.password)
      await adminPage.click('form button[type=submit]')
      await adminPage.waitForURL(`${base}/admin`, { timeout: 15000 })

      for (const [path, marker] of [
        ['/admin/generation/jobs', /Generation jobs/],
        ['/admin/generation/previews', /Preview, revision and approval queues/],
        ['/admin/generation/templates', /Generation templates/],
        ['/admin/localization', /Generation template coverage/]
      ]) {
        const res = await adminPage.goto(base + path)
        if (res.status() !== 200) fail('phase3.7', `${path} returned HTTP ${res.status()}`)
        const text = await adminPage.textContent('body')
        if (!marker.test(text || '')) fail('phase3.7b', `${path} did not render its expected content`)
        // No storage key, provider payload or credential is ever shown.
        if (/gen\/original\/|gen\/preview\/|Bearer /.test(text || '')) fail('phase3.7c', `${path} exposed a private storage key or credential`)
      }

      const jobDetail = await adminPage.goto(`${base}/admin/generation/jobs/1`)
      if (jobDetail.status() !== 200) fail('phase3.7d', `the job detail returned HTTP ${jobDetail.status()}`)
      const detailText = await adminPage.textContent('body')
      if (!/Attempts \(append-only\)/.test(detailText || '')) fail('phase3.7e', 'the job detail did not show the append-only attempt history')
      if (!/deterministic-fake/.test(detailText || '')) fail('phase3.7f', 'the job detail did not name the provider that actually ran')
      assertClean(adminDiag, 'phase3-admin')
    } finally {
      await adminContext.close()
    }

    assertClean(diag, 'phase3')
    log('phase3', 'generation + preview journeys passed')
  } finally {
    await context.close()
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** A genuinely decodable JPEG carrying the deterministic face provider's fixture trailer. */
async function makeFixturePhoto() {
  const jpegCodec = (await import('jpeg-js')).default
  const width = 900
  const height = 900
  const data = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      data[i] = x % 256
      data[i + 1] = y % 256
      data[i + 2] = 128
      data[i + 3] = 255
    }
  }
  const encoded = jpegCodec.encode({ width, height, data }, 80)
  const bytes = Buffer.concat([Buffer.from(encoded.data), Buffer.from('<<FACES:1>>', 'ascii')])
  // Playwright accepts an in-memory payload for an <input type=file>, so the
  // journey needs no temp file on disk.
  return { name: 'phase3-photo.jpg', mimeType: 'image/jpeg', buffer: bytes }
}

/**
 * Registers a real account and waits for the post-registration landing page —
 * the same selectors and the same wait the existing authenticated journey uses,
 * so this cannot pass by accident on a different form.
 */
async function register(page, base, email) {
  await page.goto(`${base}/register`)
  await page.fill('#name', 'Phase 3 Owner')
  await page.fill('#email', email)
  await page.fill('#password', 'phase3-password-123')
  await page.click('.auth-form form button[type=submit]')
  await page.waitForURL(`${base}/my-books`, { timeout: 30000 })
}

/** Runs the real PDP personalization flow and returns the opaque user-book id the cart holds. */
async function personalize(page, base, { slug, childName, photo }) {
  await page.goto(`${base}/books/${slug}`)
  await page.waitForSelector('#personalise-form')
  await page.fill('#child-name', childName)
  await page.fill('#child-age', '6')
  await page.setInputFiles('#photo', photo)
  await page.waitForFunction(() => document.getElementById('upload-status')?.textContent?.includes('uploaded'), null, { timeout: 20000 })
  await page.click('#personalise-form button[type=submit]')
  await page.waitForSelector('#book-preview-modal:not([hidden])', { timeout: 20000 })
  await page.click('#btn-confirm-order')
  await page.waitForURL(`${base}/cart`, { timeout: 20000 })
  const stored = await page.evaluate(() => localStorage.getItem('ww_cart_v1'))
  const items = JSON.parse(stored || '[]')
  if (!items[0]?.userBookId) {
    // The cart contract is Phase 2's; fall back to the API so this journey still
    // proves the generation half if the cart shape ever changes.
    const created = await page.evaluate(async (productSlug) => {
      const token = (document.cookie.match(/(?:^|;\s*)ww_csrf=([^;]+)/) || [])[1] || ''
      const res = await fetch('/api/v1/user-books', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': decodeURIComponent(token) },
        body: JSON.stringify({ productSlug })
      })
      return (await res.json()).id
    }, slug)
    if (!created) throw new Error('could not obtain the opaque user-book id from the personalization flow')
    return created
  }
  return items[0].userBookId
}
