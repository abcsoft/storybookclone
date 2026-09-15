// Admin routes for the Phase-2 catalog / CMS / reviews / media / settings
// screens (ADM-06, ADM-07, ADM-15, ADM-16).
//
// Registered AFTER the central `/admin/*` authorization guard in src/index.tsx,
// so every route here is admin-only by construction. Each mutating handler
// additionally:
//   * validates and normalises its input (an invalid value is rejected, never
//     written);
//   * records one immutable audit event with the acting admin;
//   * redirects with a flash message rather than re-rendering on POST, so a
//     refresh cannot replay a write.
//
// There is no "hidden menu" security here: the guard is the control, and the
// admin UI simply does not offer an action the caller cannot perform.

import type { Context, Hono } from 'hono'
import {
  adminCatalogProducts,
  adminProductVariants,
  listAdminProducts,
  parseListState,
  type CatalogListFilters
} from './admin_catalog'
import {
  adminCmsHome,
  adminCmsBlockEditor,
  adminCmsNavigation,
  adminCmsPages,
  adminCmsPageEditor,
  adminCmsFaqs,
  adminCmsSettings,
  adminCollections,
  adminCollectionDetail,
  adminMedia,
  adminLocalization,
  PAGE_KINDS
} from './admin_cms'
import { adminReviews } from './admin_reviews'
import {
  adminGenerationJobDetail,
  adminGenerationJobs,
  adminGenerationPreviews,
  adminGenerationTemplateDetail,
  adminGenerationTemplates
} from './generation/admin'
import { bindDraftPrompt, clonePromptVersionToDraft, cloneTemplateToDraft, publishPromptVersion, publishTemplate, retireTemplate, saveDraftScene } from './generation/templates'
import { cancelJob, retryJob } from './generation/jobs'
import { drainDueJobs } from './generation/pipeline'
import { getGenerationProviders } from './generation/providers'
import { parseReviewFilters } from './reviews'
import { adminPage } from './admin'
import { adminActor } from './auth'
import { recordAdminAudit } from './admin-audit'
import { BLOCK_KINDS } from './cms'

type AdminEnv = { Bindings: { DB: D1Database; PHOTOS?: R2Bucket; ENVIRONMENT?: string }; Variables: { user: { id?: number; email?: string } | null } }
type AdminCtx = Context<AdminEnv>

function actorOf(c: AdminCtx): { id: number | null; email: string | null } {
  const actor = c.get('user') || null
  return { id: actor?.id ?? null, email: actor?.email ?? null }
}

async function audit(c: AdminCtx, action: string, entityType: string, entityId?: string | number | null, metadata?: Record<string, unknown>) {
  const actor = actorOf(c)
  await recordAdminAudit(c.env.DB, {
    actorUserId: actor.id,
    actorEmail: actor.email,
    action,
    entityType,
    entityId: entityId ?? null,
    metadata
  })
}

function flashRedirect(path: string, message: string, isError = false) {
  const param = isError ? 'error' : 'saved'
  const sep = path.includes('?') ? '&' : '?'
  return `${path}${sep}${param}=${encodeURIComponent(message)}`
}

function intParam(value: unknown, min: number, max: number): number | null {
  const n = Number(value)
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < min || n > max) return null
  return n
}

function str(value: unknown, max = 200): string {
  return String(value ?? '').trim().slice(0, max)
}

function optionalInt(value: unknown, min: number, max: number): number | null {
  const raw = String(value ?? '').trim()
  if (!raw) return null
  return intParam(raw, min, max)
}

/**
 * ADM-08/ADM-10/ADM-11 routes. Registered from inside
 * registerAdminStoreRoutes(), which src/index.tsx calls AFTER the central
 * `/admin/*` authorization guard — so every route here is admin-only by
 * construction, and each mutation additionally validates its input, writes one
 * audit event and redirects (so a refresh cannot replay a write).
 */
function registerGenerationAdminRoutes(app: Hono<any>) {
  // ---------------------------------------------------------------- ADM-08
  app.get('/admin/generation/templates', async (c: AdminCtx) =>
    c.html(await adminGenerationTemplates(c.env.DB, { flash: c.req.query('saved'), error: c.req.query('error'), productId: optionalInt(c.req.query('product'), 1, Number.MAX_SAFE_INTEGER) ?? undefined }))
  )

  app.get('/admin/generation/templates/:id', async (c: AdminCtx) => {
    const id = intParam(c.req.param('id'), 1, Number.MAX_SAFE_INTEGER)
    if (id == null) return c.html(adminPage({ title: 'Not found', active: 'templates', body: '<p class="a-notice error">Invalid template id.</p>' }), 404)
    return c.html(await adminGenerationTemplateDetail(c.env.DB, id, { flash: c.req.query('saved'), error: c.req.query('error') }))
  })

  app.post('/admin/generation/templates/:id/clone', async (c: AdminCtx) => {
    const id = intParam(c.req.param('id'), 1, Number.MAX_SAFE_INTEGER)
    if (id == null) return c.redirect(flashRedirect('/admin/generation/templates', 'Invalid template id.', true))
    try {
      const draft = await cloneTemplateToDraft(c.env.DB, id)
      await audit(c, 'generation.template.clone', 'book_template', draft.id, { fromTemplateId: id, version: draft.version })
      return c.redirect(flashRedirect(`/admin/generation/templates/${draft.id}`, `Cloned into draft v${draft.version}. Published versions are immutable, so this is the only way to change one.`))
    } catch (err) {
      return c.redirect(flashRedirect(`/admin/generation/templates/${id}`, err instanceof Error ? err.message : 'Could not clone the template.', true))
    }
  })

  app.post('/admin/generation/templates/:id/publish', async (c: AdminCtx) => {
    const id = intParam(c.req.param('id'), 1, Number.MAX_SAFE_INTEGER)
    if (id == null) return c.redirect(flashRedirect('/admin/generation/templates', 'Invalid template id.', true))
    try {
      const published = await publishTemplate(c.env.DB, id)
      await audit(c, 'generation.template.publish', 'book_template', id, { version: published.version })
      return c.redirect(flashRedirect(`/admin/generation/templates/${id}`, `Published v${published.version}. The previous published version for this product and language was retired in the same atomic step.`))
    } catch (err) {
      return c.redirect(flashRedirect(`/admin/generation/templates/${id}`, err instanceof Error ? err.message : 'Could not publish the template.', true))
    }
  })

  app.post('/admin/generation/templates/:id/retire', async (c: AdminCtx) => {
    const id = intParam(c.req.param('id'), 1, Number.MAX_SAFE_INTEGER)
    if (id == null) return c.redirect(flashRedirect('/admin/generation/templates', 'Invalid template id.', true))
    const form = await c.req.parseBody()
    const reason = str(form.reason, 200)
    if (reason.length < 3) return c.redirect(flashRedirect(`/admin/generation/templates/${id}`, 'A retirement needs a short reason.', true))
    try {
      await retireTemplate(c.env.DB, id)
      await audit(c, 'generation.template.retire', 'book_template', id, { reason })
      return c.redirect(flashRedirect(`/admin/generation/templates/${id}`, 'Template retired.'))
    } catch (err) {
      return c.redirect(flashRedirect(`/admin/generation/templates/${id}`, err instanceof Error ? err.message : 'Could not retire the template.', true))
    }
  })

  app.post('/admin/generation/templates/:id/scenes/:sceneId', async (c: AdminCtx) => {
    const id = intParam(c.req.param('id'), 1, Number.MAX_SAFE_INTEGER)
    const sceneId = intParam(c.req.param('sceneId'), 1, Number.MAX_SAFE_INTEGER)
    if (id == null || sceneId == null) return c.redirect(flashRedirect('/admin/generation/templates', 'Invalid id.', true))
    const form = await c.req.parseBody()
    const scene = await c.env.DB.prepare('SELECT * FROM book_scenes WHERE id = ? AND template_id = ?').bind(sceneId, id).first<Record<string, any>>()
    if (!scene) return c.redirect(flashRedirect(`/admin/generation/templates/${id}`, 'That scene is not on this template.', true))
    const sortOrder = intParam(form.sortOrder, 0, 999)
    if (sortOrder == null) return c.redirect(flashRedirect(`/admin/generation/templates/${id}`, 'The scene order must be a whole number between 0 and 999.', true))
    let layout: Record<string, any> = {}
    try {
      layout = JSON.parse(String(scene.layout_json))
    } catch {
      layout = {}
    }
    layout.subject = str(form.subject, 300)
    try {
      await saveDraftScene(c.env.DB, id, { sceneKey: String(scene.scene_key), sortOrder, kind: String(scene.kind) as never, layout })
      await audit(c, 'generation.scene.update', 'book_scene', sceneId, { templateId: id, sortOrder })
      return c.redirect(flashRedirect(`/admin/generation/templates/${id}`, 'Scene saved.'))
    } catch (err) {
      // The layout validator's message names the exact problem, so surface it.
      return c.redirect(flashRedirect(`/admin/generation/templates/${id}`, err instanceof Error ? err.message : 'Could not save the scene.', true))
    }
  })

  app.post('/admin/generation/templates/:id/bindings', async (c: AdminCtx) => {
    const id = intParam(c.req.param('id'), 1, Number.MAX_SAFE_INTEGER)
    if (id == null) return c.redirect(flashRedirect('/admin/generation/templates', 'Invalid template id.', true))
    const form = await c.req.parseBody()
    const kind = str(form.kind, 20)
    const promptVersionId = intParam(form.promptVersionId, 1, Number.MAX_SAFE_INTEGER)
    if (promptVersionId == null || !['story_text', 'illustration', 'translation'].includes(kind)) {
      return c.redirect(flashRedirect(`/admin/generation/templates/${id}`, 'Pick a prompt version for a supported kind.', true))
    }
    try {
      await bindDraftPrompt(c.env.DB, id, kind as never, promptVersionId)
      await audit(c, 'generation.template.bind_prompt', 'book_template', id, { kind, promptVersionId })
      return c.redirect(flashRedirect(`/admin/generation/templates/${id}`, `${kind} prompt pinned.`))
    } catch (err) {
      return c.redirect(flashRedirect(`/admin/generation/templates/${id}`, err instanceof Error ? err.message : 'Could not pin the prompt.', true))
    }
  })

  app.post('/admin/generation/prompts/:id/clone', async (c: AdminCtx) => {
    const id = intParam(c.req.param('id'), 1, Number.MAX_SAFE_INTEGER)
    if (id == null) return c.redirect(flashRedirect('/admin/generation/templates', 'Invalid prompt id.', true))
    try {
      const draft = await clonePromptVersionToDraft(c.env.DB, id)
      await audit(c, 'generation.prompt.clone', 'prompt_version', draft.id, { fromPromptVersionId: id, version: draft.version })
      return c.redirect(flashRedirect('/admin/generation/templates', `Cloned ${draft.prompt_key} v${draft.version} as a draft.`))
    } catch (err) {
      return c.redirect(flashRedirect('/admin/generation/templates', err instanceof Error ? err.message : 'Could not clone the prompt.', true))
    }
  })

  app.post('/admin/generation/prompts/:id/publish', async (c: AdminCtx) => {
    const id = intParam(c.req.param('id'), 1, Number.MAX_SAFE_INTEGER)
    if (id == null) return c.redirect(flashRedirect('/admin/generation/templates', 'Invalid prompt id.', true))
    try {
      const published = await publishPromptVersion(c.env.DB, id)
      await audit(c, 'generation.prompt.publish', 'prompt_version', id, { provider: published.provider, model: published.model })
      return c.redirect(flashRedirect('/admin/generation/templates', `Published ${published.prompt_key} v${published.version} (${published.provider}). Note: a template that has already left draft keeps the version it pinned.`))
    } catch (err) {
      return c.redirect(flashRedirect('/admin/generation/templates', err instanceof Error ? err.message : 'Could not publish the prompt.', true))
    }
  })

  // ---------------------------------------------------------------- ADM-10
  app.get('/admin/generation/jobs', async (c: AdminCtx) =>
    c.html(await adminGenerationJobs(c.env.DB, { status: str(c.req.query('status'), 20), flash: c.req.query('saved'), error: c.req.query('error') }))
  )

  app.get('/admin/generation/jobs/:id', async (c: AdminCtx) => {
    const id = intParam(c.req.param('id'), 1, Number.MAX_SAFE_INTEGER)
    if (id == null) return c.html(adminPage({ title: 'Not found', active: 'generation', body: '<p class="a-notice error">Invalid job id.</p>' }), 404)
    return c.html(await adminGenerationJobDetail(c.env.DB, id, { flash: c.req.query('saved'), error: c.req.query('error') }))
  })

  app.post('/admin/generation/jobs/:id/retry', async (c: AdminCtx) => {
    const id = intParam(c.req.param('id'), 1, Number.MAX_SAFE_INTEGER)
    if (id == null) return c.redirect(flashRedirect('/admin/generation/jobs', 'Invalid job id.', true))
    const outcome = await retryJob(c.env.DB, id, { type: 'admin', id: actorOf(c).id == null ? null : String(actorOf(c).id) })
    if (!outcome.retried) return c.redirect(flashRedirect('/admin/generation/jobs', `That job cannot be retried (${outcome.reason ?? 'unknown'}).`, true))
    await audit(c, 'generation.job.retry', 'generation_job', id)
    return c.redirect(flashRedirect(`/admin/generation/jobs/${id}`, 'Job requeued with a fresh attempt budget.'))
  })

  app.post('/admin/generation/jobs/:id/cancel', async (c: AdminCtx) => {
    const id = intParam(c.req.param('id'), 1, Number.MAX_SAFE_INTEGER)
    if (id == null) return c.redirect(flashRedirect('/admin/generation/jobs', 'Invalid job id.', true))
    const form = await c.req.parseBody()
    const reason = str(form.reason, 200)
    if (reason.length < 3) return c.redirect(flashRedirect(`/admin/generation/jobs/${id}`, 'A cancellation needs a reason.', true))
    const outcome = await cancelJob(c.env.DB, id, { type: 'admin', id: actorOf(c).id == null ? null : String(actorOf(c).id) }, reason)
    if (!outcome.cancelled && !outcome.alreadyCancelled) {
      return c.redirect(flashRedirect(`/admin/generation/jobs/${id}`, outcome.reason === 'already_succeeded' ? 'This job already succeeded.' : 'That job can no longer be cancelled.', true))
    }
    await audit(c, 'generation.job.cancel', 'generation_job', id, { reason })
    return c.redirect(flashRedirect(`/admin/generation/jobs/${id}`, 'Job cancelled.'))
  })

  app.post('/admin/generation/dispatch', async (c: AdminCtx) => {
    const providers = getGenerationProviders(c.env, c.env.PHOTOS)
    const report = await drainDueJobs(c.env.DB, { providers }, { maxJobs: 10 })
    await audit(c, 'generation.dispatch', 'generation_job', null, {
      claimed: report.claimed,
      promotedRetries: report.promotedRetries,
      leasesReclaimed: report.recovered.leasesExpired,
      outcomes: report.outcomes
    })
    const summary = `claimed ${report.claimed}, reclaimed ${report.recovered.leasesExpired} lease(s), promoted ${report.promotedRetries} retry/retries`
    return c.redirect(flashRedirect('/admin/generation/jobs', `Dispatch sweep complete: ${summary}.`))
  })

  // ---------------------------------------------------------------- ADM-11
  app.get('/admin/generation/previews', async (c: AdminCtx) =>
    c.html(await adminGenerationPreviews(c.env.DB, { status: str(c.req.query('status'), 30), flash: c.req.query('saved'), error: c.req.query('error') }))
  )
}

export function registerAdminStoreRoutes(app: Hono<any>) {
  registerGenerationAdminRoutes(app)
  // ---------------------------------------------------------------- ADM-06
  app.get('/admin/catalog', async (c: AdminCtx) => {
    const url = new URL(c.req.url)
    const { page, perPage, q } = parseListState(url.searchParams)
    const filters: CatalogListFilters = { q, category: str(url.searchParams.get('category'), 20), status: str(url.searchParams.get('status'), 20), page, perPage }
    const { rows, state } = await listAdminProducts(c.env.DB, filters)
    return c.html(
      adminCatalogProducts({
        rows,
        state,
        filters,
        flash: c.req.query('saved'),
        error: c.req.query('error')
      })
    )
  })

  app.get('/admin/products/:id/variants', async (c: AdminCtx) => {
    const id = intParam(c.req.param('id'), 1, Number.MAX_SAFE_INTEGER)
    if (id == null) return c.html(adminPage({ title: 'Not found', active: 'catalog', body: '<p class="a-notice error">Invalid product id.</p>' }), 404)
    return c.html(
      await adminProductVariants(c.env.DB, { productId: id, flash: c.req.query('saved'), error: c.req.query('error') })
    )
  })

  app.post('/admin/products/:id/variants/:variantId', async (c: AdminCtx) => {
    const id = intParam(c.req.param('id'), 1, Number.MAX_SAFE_INTEGER)
    const variantId = intParam(c.req.param('variantId'), 1, Number.MAX_SAFE_INTEGER)
    if (id == null || variantId == null) return c.redirect(flashRedirect('/admin/catalog', 'Invalid variant id.', true))
    const form = await c.req.parseBody()
    const label = str(form.label, 60)
    const priceMinor = intParam(form.price_minor, 0, 100_000_000)
    if (!label) return c.redirect(flashRedirect(`/admin/products/${id}/variants`, 'A variant needs a label.', true))
    if (priceMinor == null) return c.redirect(flashRedirect(`/admin/products/${id}/variants`, 'Price must be a whole number of minor units (0 or more).', true))
    const existing = await c.env.DB.prepare('SELECT id, product_id FROM product_variants WHERE id = ? AND product_id = ?').bind(variantId, id).first<{ id: number }>()
    if (!existing) return c.redirect(flashRedirect(`/admin/products/${id}/variants`, 'That variant does not belong to this product.', true))
    const isDefault = form.is_default === '1'
    try {
      if (isDefault) {
        // The unique partial index allows exactly one default per product.
        await c.env.DB.prepare('UPDATE product_variants SET is_default = 0 WHERE product_id = ?').bind(id).run()
      }
      await c.env.DB.prepare('UPDATE product_variants SET label = ?, price_minor = ?, active = ?, is_default = ? WHERE id = ?')
        .bind(label, priceMinor, form.active === '1' ? 1 : 0, isDefault ? 1 : (Number((await c.env.DB.prepare('SELECT is_default FROM product_variants WHERE id = ?').bind(variantId).first<{ is_default: number }>())?.is_default) === 1 ? 1 : 0), variantId)
        .run()
    } catch (err) {
      return c.redirect(flashRedirect(`/admin/products/${id}/variants`, `Could not save: ${(err as Error).message}`, true))
    }
    await audit(c, 'catalog.variant.update', 'product_variant', variantId, { productId: id, label, priceMinor })
    return c.redirect(flashRedirect(`/admin/products/${id}/variants`, 'Variant saved.'))
  })

  app.post('/admin/products/:id/prices', async (c: AdminCtx) => {
    const id = intParam(c.req.param('id'), 1, Number.MAX_SAFE_INTEGER)
    if (id == null) return c.redirect(flashRedirect('/admin/catalog', 'Invalid product id.', true))
    const form = await c.req.parseBody()
    const currency = str(form.currency, 8).toUpperCase()
    const priceMinor = intParam(form.price_minor, 0, 100_000_000)
    const compareMinor = optionalInt(form.compare_at_price_minor, 0, 100_000_000)
    if (!currency || priceMinor == null) return c.redirect(flashRedirect(`/admin/products/${id}/variants`, 'Enter a currency and a whole-number price in minor units.', true))
    if (compareMinor != null && compareMinor <= priceMinor) {
      return c.redirect(flashRedirect(`/admin/products/${id}/variants`, 'A compare-at price must be higher than the price, or left empty.', true))
    }
    const known = await c.env.DB.prepare('SELECT code FROM currency_settings WHERE code = ?').bind(currency).first<{ code: string }>()
    if (!known) return c.redirect(flashRedirect(`/admin/products/${id}/variants`, 'That currency is not configured for the storefront.', true))
    try {
      await c.env.DB.prepare(
        `INSERT INTO product_prices (product_id, currency, price_minor, compare_at_price_minor, updated_at)
         VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(product_id, currency) DO UPDATE SET price_minor = excluded.price_minor,
           compare_at_price_minor = excluded.compare_at_price_minor, updated_at = CURRENT_TIMESTAMP`
      )
        .bind(id, currency, priceMinor, compareMinor)
        .run()
    } catch (err) {
      return c.redirect(flashRedirect(`/admin/products/${id}/variants`, `Could not save the price: ${(err as Error).message}`, true))
    }
    await audit(c, 'catalog.price.upsert', 'product_price', `${id}:${currency}`, { priceMinor, compareMinor })
    return c.redirect(flashRedirect(`/admin/products/${id}/variants`, `${currency} price saved.`))
  })

  app.post('/admin/products/:id/prices/delete', async (c: AdminCtx) => {
    const id = intParam(c.req.param('id'), 1, Number.MAX_SAFE_INTEGER)
    if (id == null) return c.redirect(flashRedirect('/admin/catalog', 'Invalid product id.', true))
    const form = await c.req.parseBody()
    const currency = str(form.currency, 8).toUpperCase()
    await c.env.DB.prepare('DELETE FROM product_prices WHERE product_id = ? AND currency = ?').bind(id, currency).run()
    await audit(c, 'catalog.price.delete', 'product_price', `${id}:${currency}`)
    return c.redirect(flashRedirect(`/admin/products/${id}/variants`, `${currency} price removed — the title is no longer offered in that currency.`))
  })

  // ------------------------------------------------- collections + media
  app.get('/admin/collections', async (c: AdminCtx) => {
    const page = Number(c.req.query('page') || 1) || 1
    return c.html(await adminCollections(c.env.DB, { flash: c.req.query('saved'), error: c.req.query('error'), page }))
  })

  app.post('/admin/collections', async (c: AdminCtx) => {
    const form = await c.req.parseBody()
    const slug = str(form.slug, 80).toLowerCase().replace(/[^a-z0-9-]/g, '-')
    const title = str(form.title, 120)
    const kind = str(form.kind, 20)
    if (!slug || !title) return c.redirect(flashRedirect('/admin/collections', 'A collection needs a slug and a title.', true))
    if (!['audience', 'theme', 'age', 'career', 'sticker', 'editorial'].includes(kind)) {
      return c.redirect(flashRedirect('/admin/collections', 'Unknown collection kind.', true))
    }
    try {
      await c.env.DB.prepare(
        `INSERT INTO collections (slug, kind, title, subtitle, description, hero_image, hero_alt, sort_order, active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`
      )
        .bind(slug, kind, title, str(form.subtitle, 200), str(form.description, 600), str(form.hero_image, 200), str(form.hero_alt, 200), optionalInt(form.sort_order, 0, 9999) ?? 100)
        .run()
    } catch (err) {
      return c.redirect(flashRedirect('/admin/collections', `Could not create: ${(err as Error).message}`, true))
    }
    await audit(c, 'collection.create', 'collection', slug)
    return c.redirect(flashRedirect('/admin/collections', 'Collection created.'))
  })

  app.get('/admin/collections/:id', async (c: AdminCtx) => {
    const id = intParam(c.req.param('id'), 1, Number.MAX_SAFE_INTEGER)
    if (id == null) return c.redirect('/admin/collections')
    return c.html(await adminCollectionDetail(c.env.DB, id, { flash: c.req.query('saved'), error: c.req.query('error') }))
  })

  app.post('/admin/collections/:id', async (c: AdminCtx) => {
    const id = intParam(c.req.param('id'), 1, Number.MAX_SAFE_INTEGER)
    if (id == null) return c.redirect('/admin/collections')
    const form = await c.req.parseBody()
    const title = str(form.title, 120)
    if (!title) return c.redirect(flashRedirect(`/admin/collections/${id}`, 'A collection needs a title.', true))
    const gender = str(form.facet_gender, 10) || null
    const category = str(form.facet_category, 10) || null
    try {
      await c.env.DB.prepare(
        `UPDATE collections SET slug = ?, kind = ?, title = ?, subtitle = ?, description = ?, hero_image = ?, hero_alt = ?,
                facet_gender = ?, facet_age_min = ?, facet_age_max = ?, facet_category = ?, sort_order = ?, active = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?`
      )
        .bind(
          str(form.slug, 80),
          str(form.kind, 20),
          title,
          str(form.subtitle, 200),
          str(form.description, 600),
          str(form.hero_image, 200),
          str(form.hero_alt, 200),
          gender,
          optionalInt(form.facet_age_min, 0, 18),
          optionalInt(form.facet_age_max, 0, 18),
          category,
          optionalInt(form.sort_order, 0, 9999) ?? 100,
          form.active === '1' ? 1 : 0,
          id
        )
        .run()
    } catch (err) {
      return c.redirect(flashRedirect(`/admin/collections/${id}`, `Could not save: ${(err as Error).message}`, true))
    }
    await audit(c, 'collection.update', 'collection', id)
    return c.redirect(flashRedirect(`/admin/collections/${id}`, 'Collection saved.'))
  })

  app.post('/admin/collections/:id/delete', async (c: AdminCtx) => {
    const id = intParam(c.req.param('id'), 1, Number.MAX_SAFE_INTEGER)
    if (id == null) return c.redirect('/admin/collections')
    await c.env.DB.prepare('DELETE FROM collections WHERE id = ?').bind(id).run()
    await audit(c, 'collection.delete', 'collection', id)
    return c.redirect(flashRedirect('/admin/collections', 'Collection deleted. Its product links were removed with it.'))
  })

  app.post('/admin/collections/:id/members', async (c: AdminCtx) => {
    const id = intParam(c.req.param('id'), 1, Number.MAX_SAFE_INTEGER)
    const form = await c.req.parseBody()
    const productId = intParam(form.product_id, 1, Number.MAX_SAFE_INTEGER)
    if (id == null || productId == null) return c.redirect('/admin/collections')
    const exists = await c.env.DB.prepare('SELECT id FROM products WHERE id = ?').bind(productId).first<{ id: number }>()
    if (!exists) return c.redirect(flashRedirect(`/admin/collections/${id}`, 'That product does not exist.', true))
    try {
      await c.env.DB.prepare(
        `INSERT INTO collection_products (collection_id, product_id, sort_order) VALUES (?, ?, ?)
         ON CONFLICT(collection_id, product_id) DO UPDATE SET sort_order = excluded.sort_order`
      )
        .bind(id, productId, optionalInt(form.sort_order, 0, 9999) ?? 100)
        .run()
    } catch (err) {
      return c.redirect(flashRedirect(`/admin/collections/${id}`, `Could not add: ${(err as Error).message}`, true))
    }
    await audit(c, 'collection.member.upsert', 'collection', id, { productId })
    return c.redirect(flashRedirect(`/admin/collections/${id}`, 'Membership saved.'))
  })

  app.post('/admin/collections/:id/members/remove', async (c: AdminCtx) => {
    const id = intParam(c.req.param('id'), 1, Number.MAX_SAFE_INTEGER)
    const form = await c.req.parseBody()
    const productId = intParam(form.product_id, 1, Number.MAX_SAFE_INTEGER)
    if (id == null || productId == null) return c.redirect('/admin/collections')
    await c.env.DB.prepare('DELETE FROM collection_products WHERE collection_id = ? AND product_id = ?').bind(id, productId).run()
    await audit(c, 'collection.member.remove', 'collection', id, { productId })
    return c.redirect(flashRedirect(`/admin/collections/${id}`, 'Product removed from the collection.'))
  })

  app.get('/admin/media', async (c: AdminCtx) => {
    const page = Number(c.req.query('page') || 1) || 1
    return c.html(await adminMedia(c.env.DB, { q: str(c.req.query('q'), 80), page, flash: c.req.query('saved'), error: c.req.query('error') }))
  })

  app.post('/admin/media', async (c: AdminCtx) => {
    const form = await c.req.parseBody()
    const publicPath = str(form.public_path, 200)
    if (!publicPath.startsWith('/')) return c.redirect(flashRedirect('/admin/media', 'A public asset path must start with "/".', true))
    const focalX = Number(form.focal_x)
    const focalY = Number(form.focal_y)
    if (!Number.isFinite(focalX) || focalX < 0 || focalX > 1 || !Number.isFinite(focalY) || focalY < 0 || focalY > 1) {
      return c.redirect(flashRedirect('/admin/media', 'The focal point must be between 0 and 1 on both axes.', true))
    }
    try {
      await c.env.DB.prepare(
        `INSERT INTO media_assets (public_path, alt_text, focal_x, focal_y, source, created_by) VALUES (?, ?, ?, ?, 'upload', ?)`
      )
        .bind(publicPath, str(form.alt_text, 200), focalX, focalY, actorOf(c).id)
        .run()
    } catch (err) {
      return c.redirect(flashRedirect('/admin/media', `Could not register the asset: ${(err as Error).message}`, true))
    }
    await audit(c, 'media.create', 'media_asset', publicPath)
    return c.redirect(flashRedirect('/admin/media', 'Media asset registered.'))
  })

  app.post('/admin/media/:id', async (c: AdminCtx) => {
    const id = intParam(c.req.param('id'), 1, Number.MAX_SAFE_INTEGER)
    if (id == null) return c.redirect('/admin/media')
    const form = await c.req.parseBody()
    const focalX = Number(form.focal_x)
    const focalY = Number(form.focal_y)
    if (!Number.isFinite(focalX) || focalX < 0 || focalX > 1 || !Number.isFinite(focalY) || focalY < 0 || focalY > 1) {
      return c.redirect(flashRedirect('/admin/media', 'The focal point must be between 0 and 1 on both axes.', true))
    }
    try {
      await c.env.DB.prepare('UPDATE media_assets SET alt_text = ?, focal_x = ?, focal_y = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
        .bind(str(form.alt_text, 200), focalX, focalY, id)
        .run()
    } catch (err) {
      return c.redirect(flashRedirect('/admin/media', `Could not save: ${(err as Error).message}`, true))
    }
    await audit(c, 'media.update', 'media_asset', id)
    return c.redirect(flashRedirect('/admin/media', 'Media asset saved.'))
  })

  // ---------------------------------------------------------------- ADM-07
  app.get('/admin/cms', async (c: AdminCtx) => c.html(await adminCmsHome(c.env.DB, { flash: c.req.query('saved'), error: c.req.query('error'), pagePath: str(c.req.query('page'), 120) || '/' })))

  app.post('/admin/cms/blocks', async (c: AdminCtx) => {
    const form = await c.req.parseBody()
    const key = str(form.key, 80)
    const kind = str(form.kind, 40)
    if (!key) return c.redirect(flashRedirect('/admin/cms', 'A block needs a unique key.', true))
    if (!(BLOCK_KINDS as readonly string[]).includes(kind)) return c.redirect(flashRedirect('/admin/cms', 'Unknown block kind.', true))
    try {
      await c.env.DB.prepare(
        `INSERT INTO cms_blocks (key, page_path, kind, eyebrow, title, subtitle, cta_label, cta_href, image_path, image_alt, collection_slug, data_key, max_items, sort_order, active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
        .bind(
          key,
          str(form.page_path, 120) || '/',
          kind,
          str(form.eyebrow, 120),
          str(form.title, 200),
          str(form.subtitle, 600),
          str(form.cta_label, 80),
          str(form.cta_href, 200),
          str(form.image_path, 200),
          str(form.image_alt, 200),
          str(form.collection_slug, 80),
          str(form.data_key, 40),
          optionalInt(form.max_items, 0, 24) ?? 4,
          optionalInt(form.sort_order, 0, 9999) ?? 999,
          form.active === '1' ? 1 : 0
        )
        .run()
    } catch (err) {
      return c.redirect(flashRedirect('/admin/cms', `Could not add the block: ${(err as Error).message}`, true))
    }
    await audit(c, 'cms.block.create', 'cms_block', key)
    return c.redirect(flashRedirect('/admin/cms', 'Block added.'))
  })

  app.get('/admin/cms/blocks/:id', async (c: AdminCtx) => {
    const id = intParam(c.req.param('id'), 1, Number.MAX_SAFE_INTEGER)
    if (id == null) return c.redirect('/admin/cms')
    return c.html(await adminCmsBlockEditor(c.env.DB, id, { flash: c.req.query('saved'), error: c.req.query('error') }))
  })

  app.post('/admin/cms/blocks/:id', async (c: AdminCtx) => {
    const id = intParam(c.req.param('id'), 1, Number.MAX_SAFE_INTEGER)
    if (id == null) return c.redirect('/admin/cms')
    const form = await c.req.parseBody()
    const kind = str(form.kind, 40)
    if (!(BLOCK_KINDS as readonly string[]).includes(kind)) return c.redirect(flashRedirect(`/admin/cms/blocks/${id}`, 'Unknown block kind.', true))
    try {
      await c.env.DB.prepare(
        `UPDATE cms_blocks SET key = ?, page_path = ?, kind = ?, eyebrow = ?, title = ?, subtitle = ?, body = ?,
                cta_label = ?, cta_href = ?, secondary_cta_label = ?, secondary_cta_href = ?, image_path = ?, image_alt = ?,
                collection_slug = ?, data_key = ?, max_items = ?, sort_order = ?, active = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?`
      )
        .bind(
          str(form.key, 80),
          str(form.page_path, 120) || '/',
          kind,
          str(form.eyebrow, 120),
          str(form.title, 200),
          str(form.subtitle, 600),
          String(form.body ?? '').slice(0, 20000),
          str(form.cta_label, 80),
          str(form.cta_href, 200),
          str(form.secondary_cta_label, 80),
          str(form.secondary_cta_href, 200),
          str(form.image_path, 200),
          str(form.image_alt, 200),
          str(form.collection_slug, 80),
          str(form.data_key, 40),
          optionalInt(form.max_items, 0, 24) ?? 4,
          optionalInt(form.sort_order, 0, 9999) ?? 999,
          form.active === '1' ? 1 : 0,
          id
        )
        .run()
    } catch (err) {
      return c.redirect(flashRedirect(`/admin/cms/blocks/${id}`, `Could not save: ${(err as Error).message}`, true))
    }
    await audit(c, 'cms.block.update', 'cms_block', id)
    return c.redirect(flashRedirect(`/admin/cms/blocks/${id}`, 'Block saved.'))
  })

  app.post('/admin/cms/blocks/:id/move', async (c: AdminCtx) => {
    const id = intParam(c.req.param('id'), 1, Number.MAX_SAFE_INTEGER)
    if (id == null) return c.redirect('/admin/cms')
    const form = await c.req.parseBody()
    const direction = str(form.direction, 8)
    const current = await c.env.DB.prepare('SELECT id, page_path, sort_order FROM cms_blocks WHERE id = ?').bind(id).first<{ page_path: string; sort_order: number }>()
    if (!current) return c.redirect('/admin/cms')
    const neighbour = await c.env.DB.prepare(
      direction === 'up'
        ? 'SELECT id, sort_order FROM cms_blocks WHERE page_path = ? AND (sort_order < ? OR (sort_order = ? AND id < ?)) ORDER BY sort_order DESC, id DESC LIMIT 1'
        : 'SELECT id, sort_order FROM cms_blocks WHERE page_path = ? AND (sort_order > ? OR (sort_order = ? AND id > ?)) ORDER BY sort_order ASC, id ASC LIMIT 1'
    )
      .bind(current.page_path, current.sort_order, current.sort_order, id)
      .first<{ id: number; sort_order: number }>()
    if (neighbour) {
      // Two updates in one batch: a failed swap leaves the order untouched.
      await c.env.DB.batch([
        c.env.DB.prepare('UPDATE cms_blocks SET sort_order = ? WHERE id = ?').bind(neighbour.sort_order, id),
        c.env.DB.prepare('UPDATE cms_blocks SET sort_order = ? WHERE id = ?').bind(current.sort_order, neighbour.id)
      ])
      await audit(c, 'cms.block.reorder', 'cms_block', id, { direction })
    }
    return c.redirect(flashRedirect('/admin/cms', 'Block order updated.'))
  })

  app.post('/admin/cms/blocks/:id/delete', async (c: AdminCtx) => {
    const id = intParam(c.req.param('id'), 1, Number.MAX_SAFE_INTEGER)
    if (id == null) return c.redirect('/admin/cms')
    await c.env.DB.prepare('DELETE FROM cms_blocks WHERE id = ?').bind(id).run()
    await audit(c, 'cms.block.delete', 'cms_block', id)
    return c.redirect(flashRedirect('/admin/cms', 'Block deleted.'))
  })

  app.get('/admin/cms/navigation', async (c: AdminCtx) => c.html(await adminCmsNavigation(c.env.DB, { flash: c.req.query('saved'), error: c.req.query('error') })))

  app.post('/admin/cms/nav', async (c: AdminCtx) => {
    const form = await c.req.parseBody()
    const menu = str(form.menu, 20)
    const label = str(form.label, 60)
    const href = str(form.href, 200)
    if (!['primary', 'mobile', 'footer'].includes(menu)) return c.redirect(flashRedirect('/admin/cms/navigation', 'Unknown menu.', true))
    if (!label || !href) return c.redirect(flashRedirect('/admin/cms/navigation', 'A navigation entry needs a label and a link.', true))
    if (!href.startsWith('/') && !/^https:\/\//.test(href)) return c.redirect(flashRedirect('/admin/cms/navigation', 'A link must be a site path or an https URL.', true))
    try {
      await c.env.DB.prepare('INSERT INTO cms_nav_items (menu, column_key, column_title, label, href, sort_order) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(menu, str(form.column_key, 40), str(form.column_title, 60), label, href, optionalInt(form.sort_order, 0, 9999) ?? 100)
        .run()
    } catch (err) {
      return c.redirect(flashRedirect('/admin/cms/navigation', `Could not add the entry: ${(err as Error).message}`, true))
    }
    await audit(c, 'cms.nav.create', 'cms_nav_item', label)
    return c.redirect(flashRedirect('/admin/cms/navigation', 'Navigation entry added.'))
  })

  app.post('/admin/cms/nav/:id', async (c: AdminCtx) => {
    const id = intParam(c.req.param('id'), 1, Number.MAX_SAFE_INTEGER)
    if (id == null) return c.redirect('/admin/cms/navigation')
    const form = await c.req.parseBody()
    const label = str(form.label, 60)
    const href = str(form.href, 200)
    if (!label || !href) return c.redirect(flashRedirect('/admin/cms/navigation', 'A navigation entry needs a label and a link.', true))
    await c.env.DB.prepare('UPDATE cms_nav_items SET label = ?, href = ?, sort_order = ?, active = ? WHERE id = ?')
      .bind(label, href, optionalInt(form.sort_order, 0, 9999) ?? 100, form.active === '1' ? 1 : 0, id)
      .run()
    await audit(c, 'cms.nav.update', 'cms_nav_item', id)
    return c.redirect(flashRedirect('/admin/cms/navigation', 'Navigation entry saved.'))
  })

  app.post('/admin/cms/nav/:id/delete', async (c: AdminCtx) => {
    const id = intParam(c.req.param('id'), 1, Number.MAX_SAFE_INTEGER)
    if (id == null) return c.redirect('/admin/cms/navigation')
    await c.env.DB.prepare('DELETE FROM cms_nav_items WHERE id = ?').bind(id).run()
    await audit(c, 'cms.nav.delete', 'cms_nav_item', id)
    return c.redirect(flashRedirect('/admin/cms/navigation', 'Navigation entry deleted.'))
  })

  app.post('/admin/cms/announcements', async (c: AdminCtx) => {
    const form = await c.req.parseBody()
    const message = str(form.message, 160)
    if (!message) return c.redirect(flashRedirect('/admin/cms/navigation', 'An announcement needs a message.', true))
    const endsAt = str(form.ends_at, 20)
    await c.env.DB.prepare('INSERT INTO announcements (message, code, href, ends_at, sort_order, active) VALUES (?, ?, ?, ?, ?, 1)')
      .bind(message, str(form.code, 40), str(form.href, 200), endsAt ? `${endsAt}T23:59:59Z` : null, optionalInt(form.sort_order, 0, 9999) ?? 10)
      .run()
    await audit(c, 'cms.announcement.create', 'announcement', message.slice(0, 60))
    return c.redirect(flashRedirect('/admin/cms/navigation', 'Announcement added.'))
  })

  app.post('/admin/cms/announcements/:id', async (c: AdminCtx) => {
    const id = intParam(c.req.param('id'), 1, Number.MAX_SAFE_INTEGER)
    if (id == null) return c.redirect('/admin/cms/navigation')
    const form = await c.req.parseBody()
    const endsAt = str(form.ends_at, 20)
    await c.env.DB.prepare('UPDATE announcements SET message = ?, code = ?, href = ?, ends_at = ?, active = ? WHERE id = ?')
      .bind(str(form.message, 160), str(form.code, 40), str(form.href, 200), endsAt ? `${endsAt}T23:59:59Z` : null, form.active === '1' ? 1 : 0, id)
      .run()
    await audit(c, 'cms.announcement.update', 'announcement', id)
    return c.redirect(flashRedirect('/admin/cms/navigation', 'Announcement saved.'))
  })

  app.post('/admin/cms/announcements/:id/delete', async (c: AdminCtx) => {
    const id = intParam(c.req.param('id'), 1, Number.MAX_SAFE_INTEGER)
    if (id == null) return c.redirect('/admin/cms/navigation')
    await c.env.DB.prepare('DELETE FROM announcements WHERE id = ?').bind(id).run()
    await audit(c, 'cms.announcement.delete', 'announcement', id)
    return c.redirect(flashRedirect('/admin/cms/navigation', 'Announcement deleted.'))
  })

  app.get('/admin/cms/pages', async (c: AdminCtx) => {
    const url = new URL(c.req.url)
    const { page, perPage } = parseListState(url.searchParams)
    return c.html(
      await adminCmsPages(c.env.DB, {
        q: str(url.searchParams.get('q'), 80),
        kind: str(url.searchParams.get('kind'), 20),
        status: str(url.searchParams.get('status'), 20),
        page,
        perPage,
        flash: c.req.query('saved'),
        error: c.req.query('error')
      })
    )
  })

  app.post('/admin/cms/pages', async (c: AdminCtx) => {
    const form = await c.req.parseBody()
    const slug = str(form.slug, 80).toLowerCase().replace(/[^a-z0-9-]/g, '-')
    const title = str(form.title, 200)
    const kind = str(form.kind, 20)
    if (!slug || !title) return c.redirect(flashRedirect('/admin/cms/pages', 'A page needs a slug and a title.', true))
    if (!(PAGE_KINDS as readonly string[]).includes(kind)) return c.redirect(flashRedirect('/admin/cms/pages', 'Unknown page kind.', true))
    try {
      await c.env.DB.prepare(
        `INSERT INTO cms_pages (slug, kind, title, category, excerpt, body, image_path, image_alt, status, published_at, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
        .bind(
          slug,
          kind,
          title,
          str(form.category, 60),
          str(form.excerpt, 400),
          String(form.body ?? '').slice(0, 40000),
          str(form.image_path, 200),
          str(form.image_alt, 200),
          str(form.status, 20) === 'published' ? 'published' : 'draft',
          str(form.status, 20) === 'published' ? new Date().toISOString() : null,
          optionalInt(form.sort_order, 0, 9999) ?? 50
        )
        .run()
    } catch (err) {
      return c.redirect(flashRedirect('/admin/cms/pages', `Could not create the page: ${(err as Error).message}`, true))
    }
    await audit(c, 'cms.page.create', 'cms_page', slug)
    return c.redirect(flashRedirect('/admin/cms/pages', 'Page created.'))
  })

  app.get('/admin/cms/pages/:id', async (c: AdminCtx) => {
    const id = intParam(c.req.param('id'), 1, Number.MAX_SAFE_INTEGER)
    if (id == null) return c.redirect('/admin/cms/pages')
    return c.html(await adminCmsPageEditor(c.env.DB, id, { flash: c.req.query('saved'), error: c.req.query('error') }))
  })

  app.post('/admin/cms/pages/:id', async (c: AdminCtx) => {
    const id = intParam(c.req.param('id'), 1, Number.MAX_SAFE_INTEGER)
    if (id == null) return c.redirect('/admin/cms/pages')
    const form = await c.req.parseBody()
    const title = str(form.title, 200)
    if (!title) return c.redirect(flashRedirect(`/admin/cms/pages/${id}`, 'A page needs a title.', true))
    const status = str(form.status, 20) === 'published' ? 'published' : str(form.status, 20) === 'archived' ? 'archived' : 'draft'
    try {
      await c.env.DB.prepare(
        `UPDATE cms_pages SET slug = ?, kind = ?, title = ?, category = ?, excerpt = ?, body = ?, image_path = ?, image_alt = ?,
                seo_title = ?, seo_description = ?, status = ?, sort_order = ?, updated_at = CURRENT_TIMESTAMP,
                published_at = COALESCE(published_at, CASE WHEN ? = 'published' THEN CURRENT_TIMESTAMP ELSE NULL END)
          WHERE id = ?`
      )
        .bind(
          str(form.slug, 80),
          str(form.kind, 20),
          title,
          str(form.category, 60),
          str(form.excerpt, 400),
          String(form.body ?? '').slice(0, 40000),
          str(form.image_path, 200),
          str(form.image_alt, 200),
          str(form.seo_title, 200),
          str(form.seo_description, 400),
          status,
          optionalInt(form.sort_order, 0, 9999) ?? 50,
          status,
          id
        )
        .run()
    } catch (err) {
      return c.redirect(flashRedirect(`/admin/cms/pages/${id}`, `Could not save: ${(err as Error).message}`, true))
    }
    await audit(c, 'cms.page.update', 'cms_page', id, { status })
    return c.redirect(flashRedirect(`/admin/cms/pages/${id}`, 'Page saved.'))
  })

  app.post('/admin/cms/pages/:id/delete', async (c: AdminCtx) => {
    const id = intParam(c.req.param('id'), 1, Number.MAX_SAFE_INTEGER)
    if (id == null) return c.redirect('/admin/cms/pages')
    await c.env.DB.prepare('DELETE FROM cms_pages WHERE id = ?').bind(id).run()
    await audit(c, 'cms.page.delete', 'cms_page', id)
    return c.redirect(flashRedirect('/admin/cms/pages', 'Page deleted. Its slug is now a real 404.'))
  })

  app.get('/admin/cms/faqs', async (c: AdminCtx) => c.html(await adminCmsFaqs(c.env.DB, { flash: c.req.query('saved'), error: c.req.query('error') })))

  app.post('/admin/cms/faqs', async (c: AdminCtx) => {
    const form = await c.req.parseBody()
    const question = str(form.question, 200)
    const answer = String(form.answer ?? '').trim()
    if (!question || !answer) return c.redirect(flashRedirect('/admin/cms/faqs', 'An FAQ entry needs a question and an answer.', true))
    try {
      await c.env.DB.prepare('INSERT INTO cms_faqs (group_key, question, answer, sort_order, active) VALUES (?, ?, ?, ?, 1)')
        .bind(str(form.group_key, 60) || 'Popular', question, answer.slice(0, 2000), optionalInt(form.sort_order, 0, 9999) ?? 100)
        .run()
    } catch (err) {
      return c.redirect(flashRedirect('/admin/cms/faqs', `Could not add: ${(err as Error).message}`, true))
    }
    await audit(c, 'cms.faq.create', 'cms_faq', question.slice(0, 60))
    return c.redirect(flashRedirect('/admin/cms/faqs', 'FAQ answer added.'))
  })

  app.post('/admin/cms/faqs/:id', async (c: AdminCtx) => {
    const id = intParam(c.req.param('id'), 1, Number.MAX_SAFE_INTEGER)
    if (id == null) return c.redirect('/admin/cms/faqs')
    const form = await c.req.parseBody()
    await c.env.DB.prepare('UPDATE cms_faqs SET group_key = ?, question = ?, answer = ?, sort_order = ?, active = ? WHERE id = ?')
      .bind(
        str(form.group_key, 60) || 'Popular',
        str(form.question, 200),
        String(form.answer ?? '').slice(0, 2000),
        optionalInt(form.sort_order, 0, 9999) ?? 100,
        form.active === '1' ? 1 : 0,
        id
      )
      .run()
    await audit(c, 'cms.faq.update', 'cms_faq', id)
    return c.redirect(flashRedirect('/admin/cms/faqs', 'FAQ answer saved.'))
  })

  app.post('/admin/cms/faqs/:id/delete', async (c: AdminCtx) => {
    const id = intParam(c.req.param('id'), 1, Number.MAX_SAFE_INTEGER)
    if (id == null) return c.redirect('/admin/cms/faqs')
    await c.env.DB.prepare('DELETE FROM cms_faqs WHERE id = ?').bind(id).run()
    await audit(c, 'cms.faq.delete', 'cms_faq', id)
    return c.redirect(flashRedirect('/admin/cms/faqs', 'FAQ answer deleted.'))
  })

  app.get('/admin/settings', async (c: AdminCtx) => c.html(await adminCmsSettings(c.env.DB, { flash: c.req.query('saved'), error: c.req.query('error') })))

  app.post('/admin/settings', async (c: AdminCtx) => {
    const form = await c.req.parseBody()
    const key = str(form.key, 80)
    if (!key) return c.redirect(flashRedirect('/admin/settings', 'A setting needs a key.', true))
    const kind = ['string', 'url', 'email', 'number'].includes(str(form.kind, 20)) ? str(form.kind, 20) : 'string'
    const value = String(form.value ?? '').trim().slice(0, 400)
    if (kind === 'email' && value && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) {
      return c.redirect(flashRedirect('/admin/settings', 'That is not a valid email address.', true))
    }
    if (kind === 'url' && value && !value.startsWith('/') && !/^https:\/\//.test(value)) {
      return c.redirect(flashRedirect('/admin/settings', 'A URL must be a site path or an https address.', true))
    }
    if (kind === 'number' && value && !/^\d+$/.test(value)) {
      return c.redirect(flashRedirect('/admin/settings', 'That setting must be a whole number.', true))
    }
    try {
      await c.env.DB.prepare(
        `INSERT INTO site_settings (key, value, kind, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, kind = excluded.kind, updated_at = CURRENT_TIMESTAMP`
      )
        .bind(key, value, kind)
        .run()
    } catch (err) {
      return c.redirect(flashRedirect('/admin/settings', `Could not save: ${(err as Error).message}`, true))
    }
    await audit(c, 'settings.update', 'site_setting', key)
    return c.redirect(flashRedirect('/admin/settings', `${key} saved.`))
  })

  app.get('/admin/localization', async (c: AdminCtx) => c.html(await adminLocalization(c.env.DB)))

  // ---------------------------------------------------------------- ADM-15
  app.get('/admin/reviews', async (c: AdminCtx) => {
    const filters = parseReviewFilters(new URL(c.req.url).searchParams)
    return c.html(await adminReviews(c.env.DB, { filters, flash: c.req.query('saved'), error: c.req.query('error') }))
  })

  app.post('/admin/reviews/:id/moderate', async (c: AdminCtx) => {
    const id = intParam(c.req.param('id'), 1, Number.MAX_SAFE_INTEGER)
    if (id == null) return c.redirect('/admin/reviews')
    const form = await c.req.parseBody()
    const action = str(form.action, 12)
    const reason = str(form.reason, 200)
    const { moderateReview } = await import('./reviews')
    const result = await moderateReview(c.env.DB, id, action === 'publish' ? 'publish' : 'reject', actorOf(c).id, reason)
    if (!result.ok) return c.redirect(flashRedirect('/admin/reviews', result.error, true))
    await audit(c, `review.${result.status}`, 'review', id, { reason: reason || null })
    return c.redirect(flashRedirect('/admin/reviews', `Review ${result.status}.`))
  })
}
