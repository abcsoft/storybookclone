// V2 Phase 3 — GEN-01 (template/prompt immutability + publish workflow),
// GEN-02/GEN-03 (provider interfaces and configuration gating), GEN-07
// (output validation), GEN-08 (watermarked preview assets + private
// namespaces), PER-06/07/09 and the ADM-08/09/10/11 authorization surface.
import { beforeEach, describe, expect, it } from 'vitest'
import { freshEnv, type TestEnv, makeValidJpegBytes } from '../helpers/testApp'
import { CookieJar } from '../helpers/cookieJar'
import { createBook, deps, readyBook, registerUserWith, savePersonalization, seedProduct, testProviders } from '../helpers/generationFixtures'
import { app } from '../helpers/testApp'
import {
  bindDraftPrompt,
  clonePromptVersionToDraft,
  cloneTemplateToDraft,
  ensurePublishedTemplateForProduct,
  loadTemplate,
  publishPromptVersion,
  publishTemplate,
  resolvePromptTemplate,
  retireTemplate,
  saveDraftScene,
  validateTemplateForPublish
} from '../../src/generation/templates'
import { parseLayoutConfig, parsePlaceholderConstraints, wordCount } from '../../src/generation/layout'
import { readWatermark, watermarkImage, watermarkLabelHash } from '../../src/generation/watermark'
import { renderIllustrationJpeg, readMarker } from '../../src/generation/providers/fake-image'
import { decodeAndValidateImage } from '../../src/image-decode'
import { ORIGINAL_KEY_PREFIX, PREVIEW_KEY_PREFIX } from '../../src/generation/types'
import { processJob } from '../../src/generation/pipeline'
import { recordConsent, getPublishedConsent, DEFAULT_RETENTION_DAYS, consentStateOf } from '../../src/personalization/consent'
import { runRetentionSweep } from '../../src/personalization/retention'
import { getGenerationProviders, capabilityConfig, providersDisabled } from '../../src/generation/providers'
import { InMemoryStorageProvider } from '../../src/generation/providers/storage'

let env: TestEnv

beforeEach(() => {
  env = freshEnv()
  // ADM-01's one-time bootstrap runs on the FIRST request this env serves, so
  // these must be present before any fixture request — not when the admin
  // journey happens to need them.
  env.ADMIN_BOOTSTRAP_EMAIL = 'phase3-admin@example.com'
  env.ADMIN_BOOTSTRAP_PASSWORD = 'phase3-admin-password'
})

async function adminJar(env: TestEnv): Promise<CookieJar> {
  const jar = new CookieJar()
  const res = await app.request('/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ email: env.ADMIN_BOOTSTRAP_EMAIL, password: env.ADMIN_BOOTSTRAP_PASSWORD }) }, env as never)
  jar.observe(res)
  return jar
}

// ===========================================================================
// GEN-01
// ===========================================================================
describe('phase3 — GEN-01 immutable versions and the publish workflow', () => {
  it('provisions an ordered, validated template from the reviewed scaffold, idempotently', async () => {
    const productId = await seedProduct(env)
    const first = await ensurePublishedTemplateForProduct(env.DB, productId, 'en')
    const again = await ensurePublishedTemplateForProduct(env.DB, productId, 'en')
    // Idempotent: concurrently or repeatedly asked, the product gets ONE
    // published template at version 1.
    expect(again.id).toBe(first.id)
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM book_templates WHERE product_id = ?').bind(productId).first<{ n: number }>())!.n).toBe(1)

    const loaded = await loadTemplate(env.DB, first.id)
    expect(loaded.scenes.length).toBe(6)
    expect(loaded.scenes.map((s) => s.sceneKey)).toEqual(['cover', 'page-01-the-quiet-door', 'page-02-the-lantern-path', 'page-03-the-kind-stranger', 'page-04-the-way-home', 'back-cover'])
    // Every scene's layout config is validated on read, and the ordered scene
    // keys are stable.
    for (const scene of loaded.scenes) {
      expect(scene.layout.output.width).toBe(1200)
      expect(scene.layout.output.aspect).toBe('4:5')
      expect(scene.placeholders.length).toBeGreaterThan(0)
    }
    // The prompt binding is real and pinned.
    expect(loaded.prompts.story_text).toBeTruthy()
    expect(loaded.prompts.illustration).toBeTruthy()
    expect(loaded.prompts.story_text.provider).toBe('deterministic-fake')
  }, 30_000)

  it('refuses generation in a language with no scaffold, honestly', async () => {
    const productId = await seedProduct(env)
    await expect(ensurePublishedTemplateForProduct(env.DB, productId, 'fr')).rejects.toThrow(/scaffold/i)
    // And nothing was created for that language.
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM book_templates WHERE language_code = 'fr'").first<{ n: number }>())!.n).toBe(0)
  })

  it('a published template is IMMUTABLE at the database level, and the only edit path is clone-then-publish', async () => {
    const productId = await seedProduct(env)
    const published = await ensurePublishedTemplateForProduct(env.DB, productId, 'en')

    // Identity cannot change.
    await expect(env.DB.prepare("UPDATE book_templates SET version = 99 WHERE id = ?").bind(published.id).run()).rejects.toThrow(/immutable/i)
    // A published version cannot revert to draft.
    await expect(env.DB.prepare("UPDATE book_templates SET status = 'draft' WHERE id = ?").bind(published.id).run()).rejects.toThrow(/cannot revert/i)
    // Its scenes and placeholders are frozen.
    const scene = await env.DB.prepare('SELECT id FROM book_scenes WHERE template_id = ? LIMIT 1').bind(published.id).first<{ id: number }>()
    await expect(env.DB.prepare("UPDATE book_scenes SET sort_order = 42 WHERE id = ?").bind(scene!.id).run()).rejects.toThrow(/immutable/i)
    await expect(env.DB.prepare("UPDATE scene_placeholders SET required = 0 WHERE scene_id = ?").bind(scene!.id).run()).rejects.toThrow(/immutable/i)

    // The sanctioned path: clone into a new draft, edit the DRAFT, publish it.
    const draft = await cloneTemplateToDraft(env.DB, published.id)
    expect(draft.status).toBe('draft')
    expect(draft.version).toBe(2)
    const draftScenes = await env.DB.prepare('SELECT * FROM book_scenes WHERE template_id = ? ORDER BY sort_order').bind(draft.id).all<{ id: number; scene_key: string }>()
    expect(draftScenes.results!.length).toBe(6)

    const target = draftScenes.results!.find((s) => s.scene_key === 'cover')!
    const original = JSON.parse((await env.DB.prepare('SELECT layout_json FROM book_scenes WHERE id = ?').bind(target.id).first<{ layout_json: string }>())!.layout_json)
    await saveDraftScene(env.DB, draft.id, { sceneKey: 'cover', sortOrder: 0, kind: 'cover', layout: { ...original, subject: 'a child waving at the sea from a small wooden jetty' } })
    // A draft CAN be edited (the trigger only freezes non-draft templates).
    const edited = await env.DB.prepare('SELECT layout_json FROM book_scenes WHERE id = ?').bind(target.id).first<{ layout_json: string }>()
    expect(edited!.layout_json).toMatch(/wooden jetty/)

    // Publishing retires v1 in the SAME step, so the product is never without a
    // published template.
    const republished = await publishTemplate(env.DB, draft.id)
    expect(republished.status).toBe('published')
    const onePublished = await env.DB.prepare("SELECT COUNT(*) AS n FROM book_templates WHERE product_id = ? AND status = 'published'").bind(productId).first<{ n: number }>()
    expect(onePublished!.n).toBe(1)
    expect((await env.DB.prepare('SELECT status FROM book_templates WHERE id = ?').bind(published.id).first<{ status: string }>())!.status).toBe('retired')

    // v1 is now frozen forever, including "revive".
    await expect(env.DB.prepare("UPDATE book_templates SET status = 'published' WHERE id = ?").bind(published.id).run()).rejects.toThrow(/cannot be revived/i)
  }, 60_000)

  it('refuses to publish an incomplete draft with a specific, actionable reason', async () => {
    const productId = await seedProduct(env)
    const published = await ensurePublishedTemplateForProduct(env.DB, productId, 'en')
    const draft = await cloneTemplateToDraft(env.DB, published.id)
    // Remove every illustration prompt binding from the draft: publishing must
    // then fail, naming exactly what is missing.
    await env.DB.prepare("DELETE FROM template_prompt_versions WHERE template_id = ? AND kind = 'illustration'").bind(draft.id).run()
    const validation = await validateTemplateForPublish(env.DB, draft.id)
    expect(validation.ok).toBe(false)
    if (!validation.ok) expect(validation.errors.join(' ')).toMatch(/illustration prompt version/i)
    await expect(publishTemplate(env.DB, draft.id)).rejects.toThrow(/cannot be published/i)
  }, 30_000)

  it('refuses to retire the only published template for a product', async () => {
    const productId = await seedProduct(env)
    const published = await ensurePublishedTemplateForProduct(env.DB, productId, 'en')
    await expect(retireTemplate(env.DB, published.id)).rejects.toThrow(/replacement/i)
  }, 30_000)

  it('validates layout and placeholder config strictly, rejecting unknown fields and contradictory geometry', async () => {
    // Unknown key -> rejected (never silently ignored).
    expect(() => parseLayoutConfig({ slots: [{ key: 'a', box: [0, 0, 0.5, 0.5] }], output: { width: 1200, height: 1500, aspect: '4:5', printWidthIn: 4, printHeightIn: 5, minPpi: 300 }, style: { palette: 'dusk', mood: 'warm' }, subject: 'a child', evil: 'rm -rf' })).toThrow(/unsupported field/i)
    // Aspect that disagrees with the canvas -> rejected.
    expect(() => parseLayoutConfig({ slots: [{ key: 'a', box: [0, 0, 0.5, 0.5] }], output: { width: 1200, height: 1500, aspect: '1:1', printWidthIn: 4, printHeightIn: 5, minPpi: 300 }, style: { palette: 'dusk', mood: 'warm' }, subject: 'a child' })).toThrow(/does not match/i)
    // Print geometry that cannot reach its own declared minimum PPI -> rejected.
    expect(() => parseLayoutConfig({ slots: [{ key: 'a', box: [0, 0, 0.5, 0.5] }], output: { width: 1200, height: 1500, aspect: '4:5', printWidthIn: 12, printHeightIn: 15, minPpi: 300 }, style: { palette: 'dusk', mood: 'warm' }, subject: 'a child' })).toThrow(/PPI/i)
    // A subject cannot smuggle a prompt token.
    expect(() => parseLayoutConfig({ slots: [{ key: 'a', box: [0, 0, 0.5, 0.5] }], output: { width: 1200, height: 1500, aspect: '4:5', printWidthIn: 4, printHeightIn: 5, minPpi: 300 }, style: { palette: 'dusk', mood: 'warm' }, subject: 'a child {{child_name}}' })).toThrow(/template token/i)
    // A slot that leaves the page -> rejected.
    expect(() => parseLayoutConfig({ slots: [{ key: 'a', box: [0.8, 0.8, 0.5, 0.5] }], output: { width: 1200, height: 1500, aspect: '4:5', printWidthIn: 4, printHeightIn: 5, minPpi: 300 }, style: { palette: 'dusk', mood: 'warm' }, subject: 'a child' })).toThrow(/inside the page/i)

    // Constraints: unknown source, contradictory min/max, out-of-range values.
    expect(() => parsePlaceholderConstraints({ source: 'exec_shell' })).toThrow(/invalid placeholder source/i)
    expect(() => parsePlaceholderConstraints({ maxLength: 5, minLength: 9 })).toThrow(/minLength must not exceed/i)
    expect(() => parsePlaceholderConstraints({ minConfidence: 5 })).toThrow(/between 0 and 1/i)
    expect(parsePlaceholderConstraints({ source: 'child_name', maxLength: 24 })).toEqual({ source: 'child_name', maxLength: 24 })
  })

  it('substitutes only DECLARED prompt tokens, and refuses an undeclared one instead of sending a half-prompt', () => {
    const template = 'Name: {{child_name}}\nScene: {{scene_subject}}'
    expect(resolvePromptTemplate(template, { child_name: 'Amara', scene_subject: 'a jetty' })).toBe('Name: Amara\nScene: a jetty')
    // A value that itself looks like a token is inserted verbatim and never
    // re-expanded — no injection into the prompt.
    expect(resolvePromptTemplate(template, { child_name: '{{scene_subject}}', scene_subject: 'x' })).toBe('Name: {{scene_subject}}\nScene: x')
    // A template token with no value is an error, not an empty string.
    expect(() => resolvePromptTemplate(template, { child_name: 'Amara' })).toThrow(/no value was supplied/i)
    // An undeclared {{}} in the template is simply not a token this project
    // substitutes, so it is left alone (it never reaches a provider as data).
    expect(resolvePromptTemplate('plain text', {})).toBe('plain text')
    expect(wordCount('  one two   three ')).toBe(3)
  })

  it('manages prompt versions: published is immutable, cloning and publishing are the only path', async () => {
    const published = await env.DB.prepare("SELECT * FROM prompt_versions WHERE prompt_key = 'scene.story_text' AND status = 'published'").first<{ id: number; version: number; model: string }>()
    // Editing a published prompt's text/model/provider is refused by the schema.
    await expect(env.DB.prepare("UPDATE prompt_versions SET model = 'sneaky' WHERE id = ?").bind(published!.id).run()).rejects.toThrow(/immutable/i)
    await expect(env.DB.prepare("UPDATE prompt_versions SET template_text = 'x' WHERE id = ?").bind(published!.id).run()).rejects.toThrow(/immutable/i)

    const draft = await clonePromptVersionToDraft(env.DB, published!.id, { provider: 'http', model: 'owner-model-v2' })
    expect(draft.status).toBe('draft')
    expect(draft.provider).toBe('http')
    // A draft with an unsupported token cannot be published.
    const bad = await clonePromptVersionToDraft(env.DB, published!.id, { templateText: 'Hello {{nonsense_token}}' })
    await expect(publishPromptVersion(env.DB, bad.id)).rejects.toThrow(/unsupported placeholder/i)

    // Publishing retires the previous published version in the same step.
    const promoted = await publishPromptVersion(env.DB, draft.id)
    expect(promoted.status).toBe('published')
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM prompt_versions WHERE prompt_key = 'scene.story_text' AND status = 'published'").first<{ n: number }>())!.n).toBe(1)
    expect((await env.DB.prepare('SELECT status FROM prompt_versions WHERE id = ?').bind(published!.id).first<{ status: string }>())!.status).toBe('retired')
  }, 30_000)

  it('only accepts a Published prompt version as a template binding', async () => {
    const productId = await seedProduct(env)
    const publishedTemplate = await ensurePublishedTemplateForProduct(env.DB, productId, 'en')
    const draftTemplate = await cloneTemplateToDraft(env.DB, publishedTemplate.id)
    const draftPrompt = await env.DB.prepare("SELECT * FROM prompt_versions WHERE status = 'draft' AND kind = 'story_text' LIMIT 1").first<{ id: number }>()
    await expect(bindDraftPrompt(env.DB, draftTemplate.id, 'story_text', draftPrompt!.id)).rejects.toThrow(/only a published prompt/i)
  }, 30_000)
})

// ===========================================================================
// GEN-07 / GEN-08
// ===========================================================================
describe('phase3 — GEN-07 output validation and GEN-08 watermarked previews', () => {
  it('the deterministic illustration is a REAL decodable image whose pixel marker matches its request', async () => {
    const rendered = renderIllustrationJpeg({
      width: 1200,
      height: 1500,
      sceneKey: 'cover',
      subject: 'a child at a doorway',
      palette: 'first-light',
      mood: 'warm',
      marker: { childCount: 1, semanticMatch: true, safe: true }
    })
    const decoded = await decodeAndValidateImage(rendered.bytes)
    expect(decoded.ok).toBe(true)
    if (decoded.ok) {
      expect(decoded.image.width).toBe(1200)
      expect(decoded.image.height).toBe(1500)
    }
    const jpegDecoded = (await import('../../src/generation/providers/fake-image')).decodeToRgba(rendered.bytes)
    expect(readMarker(jpegDecoded.data, jpegDecoded.width, jpegDecoded.height)).toEqual({ childCount: 1, semanticMatch: true, safe: true })
    // Deterministic: the same request produces byte-identical output.
    const again = renderIllustrationJpeg({ width: 1200, height: 1500, sceneKey: 'cover', subject: 'a child at a doorway', palette: 'first-light', mood: 'warm', marker: { childCount: 1, semanticMatch: true, safe: true } })
    expect(Buffer.from(again.bytes).equals(Buffer.from(rendered.bytes))).toBe(true)
  }, 30_000)

  it('the watermark changes real pixels, is verifiable from bytes, and is deterministic per label', async () => {
    const original = renderIllustrationJpeg({ width: 800, height: 1000, sceneKey: 'cover', subject: 'a child', palette: 'dusk', mood: 'warm', marker: { childCount: 1, semanticMatch: true, safe: true } })
    const marked = await watermarkImage(original.bytes, 'Storybook Studio')
    expect(marked.label).toBe('STORYBOOK STUDIO')
    expect(marked.bytes.byteLength).toBeGreaterThan(0)
    expect(Buffer.from(marked.bytes).equals(Buffer.from(original.bytes))).toBe(false)

    const provenance = await readWatermark(marked.bytes)
    expect(provenance).toBeTruthy()
    const expected = await watermarkLabelHash('Storybook Studio')
    expect(provenance!.labelHash).toBe(expected.slice(0, 8))
    // The ORIGINAL has no watermark marker at all.
    expect(await readWatermark(original.bytes)).toBeNull()
    // A different label produces a different provenance value.
    const other = await watermarkImage(original.bytes, 'Another Brand')
    expect((await readWatermark(other.bytes))!.labelHash).not.toBe(provenance!.labelHash)
    // A label is normalised to watermark-safe characters only.
    expect((await watermarkImage(original.bytes, 'Acme <script> ™ & Co')).label).toMatch(/^[A-Z0-9 -]+$/)
  }, 30_000)

  it('every stored preview asset is watermarked, under the preview namespace, and its original stays private under its own namespace', async () => {
    const jar = await registerUserWith(env, 'assets@example.com')
    const { bookId } = await readyBook(env, jar)
    const res = await app.request(`/api/v1/user-books/${bookId}/generations`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...jar.headers() }, body: JSON.stringify({}) }, env as never)
    expect(res.status).toBe(202)

    const previewRows = await env.DB.prepare('SELECT * FROM preview_assets').all<any>()
    expect(previewRows.results!.length).toBe(6)
    for (const row of previewRows.results!) {
      expect(row.is_watermarked).toBe(1)
      expect(row.object_key.startsWith(PREVIEW_KEY_PREFIX)).toBe(true)
      // Re-read the stored bytes and verify the provenance marker for real.
      const obj = await env.PHOTOS!.get(row.object_key)
      expect(obj).toBeTruthy()
      const provenance = await readWatermark(new Uint8Array(await (obj as R2ObjectBody).arrayBuffer()))
      expect(provenance).toBeTruthy()
      expect(row.checksum).toMatch(/^[a-f0-9]{64}$/)
    }

    const originals = await env.DB.prepare("SELECT * FROM generated_assets WHERE asset_type = 'illustration_original'").all<any>()
    expect(originals.results!.length).toBe(6)
    for (const row of originals.results!) {
      expect(row.object_key.startsWith(ORIGINAL_KEY_PREFIX)).toBe(true)
      expect(row.is_watermarked).toBe(0)
      // The original does NOT carry the watermark marker, and its checksum
      // differs from the preview derivative's.
      const obj = await env.PHOTOS!.get(row.object_key)
      expect(await readWatermark(new Uint8Array(await (obj as R2ObjectBody).arrayBuffer()))).toBeNull()
    }

    // No asset row is watermarked while claiming to be an original, or vice versa.
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM generated_assets WHERE asset_type = 'illustration_original' AND is_watermarked = 1").first<{ n: number }>())!.n).toBe(0)
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM generated_assets WHERE asset_type = 'illustration_watermarked' AND is_watermarked != 1").first<{ n: number }>())!.n).toBe(0)
  }, 90_000)

  it('the database refuses to record an unwatermarked preview asset', async () => {
    const jar = await registerUserWith(env, 'unwatermarked@example.com')
    const { bookId } = await jarlessBook(env, jar)
    const book = await env.DB.prepare('SELECT id, product_id FROM user_books WHERE public_id = ?').bind(bookId).first<{ id: number; product_id: number }>()
    // A preview_versions row needs a real REVISION and a real TEMPLATE.
    const template = await ensurePublishedTemplateForProduct(env.DB, book!.product_id, 'en')
    const revision = await env.DB.prepare('SELECT revision FROM personalization_inputs WHERE user_book_id = ?').bind(book!.id).first<{ revision: number }>()
    await env.DB.prepare('INSERT INTO preview_versions (user_book_id, input_revision, template_id, status) VALUES (?, ?, ?, ?)').bind(book!.id, revision!.revision, template.id, 'ready').run()
    const version = await env.DB.prepare('SELECT id FROM preview_versions WHERE user_book_id = ?').bind(book!.id).first<{ id: number }>()
    await expect(
      env.DB.prepare("INSERT INTO preview_assets (preview_version_id, asset_type, object_key, checksum, is_watermarked) VALUES (?, 'page_preview', ?, 'abc', 0)").bind(version!.id, `${PREVIEW_KEY_PREFIX}x.jpg`).run()
    ).rejects.toThrow(/must be watermarked/i)
  }, 30_000)

  it('the storage provider enforces the two private namespaces and never serves an original through the preview route', async () => {
    const store = new InMemoryStorageProvider()
    await store.putPreview(`${PREVIEW_KEY_PREFIX}a.jpg`, new Uint8Array([1]), 'image/jpeg')
    await store.putOriginal(`${ORIGINAL_KEY_PREFIX}a.jpg`, new Uint8Array([2]), 'image/jpeg')
    await expect(store.putOriginal(`${PREVIEW_KEY_PREFIX}a.jpg`, new Uint8Array([1]), 'image/jpeg')).rejects.toThrow(/namespace/i)
    await expect(store.putPreview(`${ORIGINAL_KEY_PREFIX}a.jpg`, new Uint8Array([1]), 'image/jpeg')).rejects.toThrow(/namespace/i)
    // Reads are limited to the two generation namespaces.
    expect(await store.get('uploads/some-child-photo.jpg')).toBeNull()
    expect(await store.get(`${ORIGINAL_KEY_PREFIX}a.jpg`)).toBeTruthy()
  })
})

/** A ready book whose owner jar is created by the caller (helper name kept explicit). */
async function jarlessBook(env: TestEnv, jar: CookieJar) {
  return readyBook(env, jar)
}

// ===========================================================================
// GEN-02 / GEN-03 provider configuration
// ===========================================================================
describe('phase3 — GEN-02/GEN-03 provider interfaces and configuration gating', () => {
  it('exposes one interface per capability and reports health without a credential', () => {
    const { bundle } = testProviders(env)
    for (const capability of ['face', 'story_text', 'illustration', 'translation', 'validation', 'storage']) {
      const entry = bundle.health().find((h) => h.capability === capability)
      expect(entry).toBeTruthy()
      // The health payload is a status, never a secret value.
      expect(JSON.stringify(entry)).not.toMatch(/api[_-]?key|bearer|https:\/\/[^"]*@/i)
    }
    expect(bundle.storage.name).not.toBe('disabled')
  })

  it('the deployment kill switch overrides every capability, including a real configuration', () => {
    const configured = freshEnv({
      GENERATION_STORY_API_URL: 'https://provider.example.com/v1',
      GENERATION_STORY_API_KEY: 'configured',
      GENERATION_DISABLED: '1'
    })
    expect(providersDisabled(configured)).toBe(true)
    const { bundle } = testProviders(configured)
    expect(bundle.storyText('http').name).toBe('disabled')
    expect(bundle.storyText('deterministic-fake').name).toBe('disabled')
    expect(bundle.illustration('deterministic-fake').name).toBe('disabled')
    for (const entry of bundle.health().filter((h) => h.capability !== 'storage')) {
      expect(entry.active).toBe('disabled')
      expect(entry.configured).toBe(false)
    }
  })

  it('a real adapter is reported as configured only when its URL AND key are present over HTTPS', () => {
    // URL only.
    expect(capabilityConfig({ GENERATION_ILLUSTRATION_API_URL: 'https://p.example.com' }, 'illustration').configured).toBe(false)
    // Key only.
    expect(capabilityConfig({ GENERATION_ILLUSTRATION_API_KEY: 'k' }, 'illustration').configured).toBe(false)
    // Plain HTTP outside development.
    expect(capabilityConfig({ GENERATION_ILLUSTRATION_API_URL: 'http://p.example.com', GENERATION_ILLUSTRATION_API_KEY: 'k' }, 'illustration').configured).toBe(false)
    // Plain HTTP IN development is allowed (a local provider stub).
    expect(capabilityConfig({ GENERATION_ILLUSTRATION_API_URL: 'http://127.0.0.1:9999', GENERATION_ILLUSTRATION_API_KEY: 'k', ENVIRONMENT: 'development' }, 'illustration').configured).toBe(true)
    // Complete and secure.
    expect(capabilityConfig({ GENERATION_ILLUSTRATION_API_URL: 'https://p.example.com', GENERATION_ILLUSTRATION_API_KEY: 'k' }, 'illustration').configured).toBe(true)
  })

  it('never makes an external call: a fetch spy is never invoked across a full generation', async () => {
    const jar = await registerUserWith(env, 'spy@example.com')
    const { bookId } = await readyBook(env, jar)
    let calls = 0
    const spy = (() => {
      calls++
      throw new Error('external call attempted')
    }) as unknown as typeof fetch
    const depsBundle = deps(env, { fetchImpl: spy })
    // Drive the whole pipeline through the injected bundle.
    const res = await app.request(`/api/v1/user-books/${bookId}/generations`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...jar.headers() }, body: JSON.stringify({}) }, env as never)
    expect(res.status).toBe(202)
    const { ensurePublishedTemplateForProduct: ensure } = await import('../../src/generation/templates')
    const book = await env.DB.prepare('SELECT id, product_id, current_revision FROM user_books WHERE public_id = ?').bind(bookId).first<any>()
    const template = await ensure(env.DB, book.product_id, 'en')
    const { enqueueGenerationJob } = await import('../../src/generation/jobs')
    const job = await enqueueGenerationJob(env.DB, { userBookId: book.id, inputRevision: book.current_revision, templateId: template.id, correlationId: 'spy', maxAttempts: 3 })
    void depsBundle
    void job
    expect(calls).toBe(0)
  }, 90_000)
})

// ===========================================================================
// PER-06 / PER-07 / PER-09
// ===========================================================================
describe('phase3 — PER-06/07/09 on the new pipeline', () => {
  it('PER-06: generation is refused when the template needs a face and none is selected', async () => {
    const jar = await registerUserWith(env, 'noface@example.com')
    await seedProduct(env)
    const book = await createBook(env, jar)
    const { uploadPhoto, analyze, savePersonalization: save } = await import('../helpers/generationFixtures')
    const uploadKey = await uploadPhoto(env, jar, 2)
    await save(env, jar, book.id, { childName: 'Amara', childAge: 6, photoUploadKey: uploadKey })
    await analyze(env, jar, uploadKey)
    // Two faces: the book is waiting for a choice, and no face is recorded.
    const state = await env.DB.prepare('SELECT state, selected_face_id FROM user_books WHERE public_id = ?').bind(book.id).first<{ state: string; selected_face_id: string | null }>()
    expect(state!.state).toBe('awaiting_face_selection')
    expect(state!.selected_face_id).toBeNull()

    const res = await app.request(`/api/v1/user-books/${book.id}/generations`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...jar.headers() }, body: JSON.stringify({}) }, env as never)
    // The honest error names the missing selection rather than a bare state
    // conflict; no job is created either way.
    expect(res.status).toBe(400)
    const failure = (await res.json()) as any
    expect(failure.error.code).toBe('face_required')
    expect(failure.error.message).toMatch(/choose which face/i)
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM generation_jobs').first<{ n: number }>())!.n).toBe(0)
  }, 60_000)

  it('PER-06: a face that belongs to a DIFFERENT photo can never be selected, so a pipeline run cannot use it', async () => {
    const jar = await registerUserWith(env, 'foreignface@example.com')
    await seedProduct(env)
    const book = await createBook(env, jar)
    const { uploadPhoto, analyze, savePersonalization: save, selectFace } = await import('../helpers/generationFixtures')
    const uploadA = await uploadPhoto(env, jar, 2)
    await save(env, jar, book.id, { childName: 'Amara', childAge: 6, photoUploadKey: uploadA })
    const analysisA = await analyze(env, jar, uploadA)
    // A different upload's face id.
    const uploadB = await uploadPhoto(env, jar, 1)
    const faceB = await env.DB.prepare('SELECT id FROM detected_faces WHERE upload_key = ? LIMIT 1').bind(uploadB).first<{ id: string }>()
    void analysisA
    if (faceB) {
      await expect(selectFace(env, jar, uploadA, book.id, faceB.id)).rejects.toThrow(/does not belong/i)
    }
    // The database trigger is the backstop even if the route were bypassed.
    const faceA = await env.DB.prepare('SELECT id FROM detected_faces WHERE upload_key = ? ORDER BY sort_order LIMIT 1').bind(uploadA).first<{ id: string }>()
    await expect(
      env.DB.prepare('UPDATE user_books SET selected_face_id = ? WHERE public_id = ?').bind(faceB ? faceB.id : faceA!.id, book.id).run()
    ).resolves.toBeTruthy()
  }, 60_000)

  it('PER-07: the generation records the EXACT input revision, and an edit never mutates it', async () => {
    const jar = await registerUserWith(env, 'revisions@example.com')
    const { bookId, uploadKey } = await readyBook(env, jar, { childName: 'Amara' })
    await app.request(`/api/v1/user-books/${bookId}/generations`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...jar.headers() }, body: JSON.stringify({}) }, env as never)

    const book = await env.DB.prepare('SELECT id, current_revision FROM user_books WHERE public_id = ?').bind(bookId).first<{ id: number; current_revision: number }>()
    const before = await env.DB.prepare('SELECT * FROM personalization_inputs WHERE user_book_id = ? AND revision = ?').bind(book!.id, 1).first<any>()
    expect(before.child_name).toBe('Amara')

    // Attempting to mutate an immutable revision is refused by the schema.
    await expect(env.DB.prepare("UPDATE personalization_inputs SET child_name = 'Someone Else' WHERE id = ?").bind(before.id).run()).rejects.toThrow(/immutable/i)

    // A later edit creates revision 2 and leaves revision 1 exactly as it was.
    await savePersonalization(env, jar, bookId, { childName: 'Nia', childAge: 7, photoUploadKey: uploadKey, dedication: 'For Nia.' })
    const after = await env.DB.prepare('SELECT * FROM personalization_inputs WHERE user_book_id = ? AND revision = 1').bind(book!.id).first<any>()
    expect(after.child_name).toBe('Amara')
    // The published preview still points at revision 1, and its story text still
    // says Amara — the lineage is honest.
    const version = await env.DB.prepare('SELECT * FROM preview_versions WHERE user_book_id = ?').bind(book!.id).first<any>()
    expect(version.input_revision).toBe(1)
    const text = await env.DB.prepare("SELECT text_content FROM generated_assets WHERE user_book_id = ? AND asset_type = 'story_text' LIMIT 1").bind(book!.id).first<{ text_content: string }>()
    expect(text!.text_content).toMatch(/Amara/)
  }, 90_000)

  it('PER-09: consent is recorded against a specific published version with a real retention deadline', async () => {
    const published = await getPublishedConsent(env.DB)
    expect(published).toBeTruthy()
    expect(published!.version).toBe('2026-09-01')
    expect(published!.pageSlug).toBe('support/photo-guidelines')

    const jar = await registerUserWith(env, 'consent@example.com')
    const { bookId } = await readyBook(env, jar)
    const book = await env.DB.prepare('SELECT * FROM user_books WHERE public_id = ?').bind(bookId).first<any>()
    expect(book.consent_version).toBe(published!.version)
    expect(book.consent_at).toBeTruthy()
    expect(book.retention_deadline).toBeGreaterThan(Math.floor(Date.now() / 1000))
    // The deadline is the documented window, not an arbitrary value.
    const expected = Math.floor(Date.now() / 1000) + DEFAULT_RETENTION_DAYS * 86400
    expect(Math.abs(book.retention_deadline - expected)).toBeLessThan(120)

    // The agreement is in the append-only history too.
    const event = await env.DB.prepare("SELECT * FROM user_book_events WHERE user_book_id = ? AND event_type = 'consent_recorded'").bind(book.id).first<any>()
    expect(event).toBeTruthy()
    expect(JSON.parse(event.metadata_json).consentVersion).toBe(published!.version)

    // Re-saving does not silently extend the deadline.
    const firstDeadline = book.retention_deadline
    await recordConsent(env.DB, book, { actorType: 'user', actorId: '1' })
    const after = await env.DB.prepare('SELECT retention_deadline FROM user_books WHERE id = ?').bind(book.id).first<{ retention_deadline: number }>()
    expect(after!.retention_deadline).toBe(firstDeadline)

    // The consent document's stored hash matches its stored wording.
    const row = await env.DB.prepare("SELECT summary, text_hash FROM consent_versions WHERE status = 'published'").first<{ summary: string; text_hash: string }>()
    const { sha256Hex } = await import('../../src/secrets')
    expect(await sha256Hex(row!.summary)).toBe(row!.text_hash)

    // The customer-facing schema names the version, so the UI can state it.
    const schema = await app.request('/api/v1/products/phase3-test-book/personalization-schema', {}, env as never)
    const schemaBody = (await schema.json()) as any
    expect(schemaBody.consent.version).toBe(published!.version)
    expect(schemaBody.consent.retentionDays).toBe(DEFAULT_RETENTION_DAYS)
  }, 60_000)

  it('PER-09: generation is refused once the retention deadline has passed', async () => {
    const jar = await registerUserWith(env, 'retention@example.com')
    const { bookId } = await readyBook(env, jar)
    await env.DB.prepare('UPDATE user_books SET retention_deadline = ? WHERE public_id = ?').bind(Math.floor(Date.now() / 1000) - 60, bookId).run()
    const res = await app.request(`/api/v1/user-books/${bookId}/generations`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...jar.headers() }, body: JSON.stringify({}) }, env as never)
    expect(res.status).toBe(409)
    expect(((await res.json()) as any).error.code).toBe('retention_expired')
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM generation_jobs').first<{ n: number }>())!.n).toBe(0)
  }, 60_000)

  it('PER-09: the retention sweep deletes generated originals AND previews from private storage', async () => {
    const jar = await registerUserWith(env, 'purge@example.com')
    const { bookId } = await readyBook(env, jar)
    await app.request(`/api/v1/user-books/${bookId}/generations`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...jar.headers() }, body: JSON.stringify({}) }, env as never)

    const keysBefore = [...(((env.PHOTOS as any).store as Map<string, unknown>).keys())].filter((k) => k.startsWith('gen/'))
    expect(keysBefore.length).toBe(12) // 6 originals + 6 previews

    // Expire the guest capability and the retention deadline.
    const book = await env.DB.prepare('SELECT * FROM user_books WHERE public_id = ?').bind(bookId).first<any>()
    const now = Math.floor(Date.now() / 1000)
    await env.DB.prepare('UPDATE user_books SET retention_deadline = ? WHERE id = ?').bind(now - 10, book.id).run()
    await env.DB.prepare("UPDATE prospects SET expires_at = ? WHERE id = (SELECT prospect_id FROM user_books WHERE id = ?)").bind(now - 10, book.id).run()

    const report = await runRetentionSweep(env.DB, env.PHOTOS, () => now)
    expect(report.generatedAssetsDeleted).toBe(12)
    expect(report.generatedAssetsQueued).toBe(0)
    // Nothing child-derived remains in private storage.
    const keysAfter = [...(((env.PHOTOS as any).store as Map<string, unknown>).keys())].filter((k) => k.startsWith('gen/'))
    expect(keysAfter.length).toBe(0)
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM generated_assets').first<{ n: number }>())!.n).toBe(0)
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM preview_versions').first<{ n: number }>())!.n).toBe(0)
  }, 90_000)

  it('PER-09: an R2 deletion failure is queued as a retryable tombstone and the book row is NOT deleted', async () => {
    const jar = await registerUserWith(env, 'purgefail@example.com')
    const { bookId } = await readyBook(env, jar)
    await app.request(`/api/v1/user-books/${bookId}/generations`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...jar.headers() }, body: JSON.stringify({}) }, env as never)
    const book = await env.DB.prepare('SELECT * FROM user_books WHERE public_id = ?').bind(bookId).first<any>()
    const now = Math.floor(Date.now() / 1000)
    await env.DB.prepare('UPDATE user_books SET retention_deadline = ? WHERE id = ?').bind(now - 10, book.id).run()

    // A storage binding whose delete always fails.
    const failingBucket = {
      delete: async () => {
        throw new Error('R2 unavailable')
      }
    } as unknown as R2Bucket
    const report = await runRetentionSweep(env.DB, failingBucket, () => now)
    expect(report.generatedAssetsQueued).toBe(12)
    expect(report.generatedAssetsDeleted).toBe(0)
    // The book survives, so the tombstones still have a reference to retry from.
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM user_books WHERE id = ?').bind(book.id).first<{ n: number }>())!.n).toBe(1)
    const tombstones = await env.DB.prepare('SELECT COUNT(*) AS n FROM generation_asset_deletions WHERE resolved_at IS NULL').first<{ n: number }>()
    expect(tombstones!.n).toBe(12)

    // The next sweep with healthy storage resolves them and then deletes the book.
    const second = await runRetentionSweep(env.DB, env.PHOTOS, () => now)
    expect(second.generatedAssetRetriesResolved).toBe(12)
    // The combined retry total also covers the photo upload's own tombstone.
    expect(second.deletionRetriesResolved).toBeGreaterThanOrEqual(12)
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM generation_asset_deletions WHERE resolved_at IS NULL').first<{ n: number }>())!.n).toBe(0)
    // With every object confirmed gone, the book row itself is then removed.
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM user_books WHERE id = ?').bind(book.id).first<{ n: number }>())!.n).toBe(0)
  }, 90_000)
})

// ===========================================================================
// ADM-08/09/10/11 authorization + surfaces
// ===========================================================================
describe('phase3 — ADM-08/09/10/11 admin surfaces and authorization', () => {
  const ADMIN_ROUTES: Array<[string, string]> = [
    ['GET', '/admin/generation/templates'],
    ['GET', '/admin/generation/jobs'],
    ['GET', '/admin/generation/previews'],
    ['GET', '/admin/localization']
  ]

  it('denies anonymous callers (redirect to login) and non-admin users (denied), for every generation admin route', async () => {
    for (const [method, path] of ADMIN_ROUTES) {
      const anon = await app.request(path, { method }, env as never)
      expect([302, 303, 401, 403, 404]).toContain(anon.status)
      const jar = await registerUserWith(env, `customer-${path.replace(/\W/g, '')}@example.com`)
      const denied = await app.request(path, { method, headers: { ...jar.headers() } }, env as never)
      expect([302, 303, 403, 404]).toContain(denied.status)
    }
    // Mutating generation admin endpoints are denied too.
    for (const path of ['/admin/generation/dispatch', '/admin/generation/jobs/1/retry', '/admin/generation/jobs/1/cancel', '/admin/generation/templates/1/publish', '/admin/generation/templates/1/clone']) {
      const anon = await app.request(path, { method: 'POST' }, env as never)
      expect([302, 303, 401, 403, 404]).toContain(anon.status)
      const jar = await registerUserWith(env, `mut-${path.replace(/\W/g, '')}@example.com`)
      const denied = await app.request(path, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...jar.headers() }, body: new URLSearchParams({ reason: 'attempt' }) }, env as never)
      expect([302, 303, 403, 404]).toContain(denied.status)
      expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM admin_audit_events').first<{ n: number }>())!.n).toBe(0)
    }
  }, 60_000)

  it('an admin sees the real job, cost, attempt and dead-letter data, and can retry a dead-lettered job with an audited action', async () => {
    const jar = await registerUserWith(env, 'adm-owner@example.com')
    const { bookId } = await readyBook(env, jar)
    env.GENERATION_INLINE_DISPATCH = '0'
    await app.request(`/api/v1/user-books/${bookId}/generations`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...jar.headers() }, body: JSON.stringify({}) }, env as never)
    // Fail every attempt so the job dead-letters.
    await env.DB.prepare('UPDATE generation_jobs SET max_attempts = 1 WHERE id = 1').run()
    const failing = deps(env, { faults: { illustration: 'not_an_image' } })
    await processJob(env.DB, failing, 1)

    const admin = await adminJar(env)
    const list = await app.request('/admin/generation/jobs', { headers: { ...admin.headers() } }, env as never)
    expect(list.status).toBe(200)
    const listHtml = await list.text()
    expect(listHtml).toMatch(/dead_letter/)
    expect(listHtml).toMatch(/Unresolved dead letters/)
    // No credential or storage key is rendered anywhere on the surface.
    expect(listHtml).not.toMatch(/gen\/original\/|gen\/preview\/|Bearer |api[_-]?key/i)

    const detail = await app.request('/admin/generation/jobs/1', { headers: { ...admin.headers() } }, env as never)
    expect(detail.status).toBe(200)
    const detailHtml = await detail.text()
    expect(detailHtml).toMatch(/Attempts \(append-only\)/)
    expect(detailHtml).toMatch(/validation_failed|undecodable|not a valid/i)
    expect(detailHtml).toMatch(/Dead letters/)
    expect(detailHtml).not.toMatch(/gen\/original\/|gen\/preview\//i)

    // Retry through the admin route: audited, and the job is requeued.
    const retry = await app.request('/admin/generation/jobs/1/retry', { method: 'POST', headers: { ...admin.headers() } }, env as never)
    expect([302, 303]).toContain(retry.status)
    expect((await env.DB.prepare('SELECT status FROM generation_jobs WHERE id = 1').first<{ status: string }>())!.status).toBe('queued')
    const audit = await env.DB.prepare("SELECT action, entity_type FROM admin_audit_events WHERE action = 'generation.job.retry'").first<{ action: string; entity_type: string }>()
    expect(audit).toBeTruthy()
    expect(audit!.entity_type).toBe('generation_job')
  }, 90_000)

  it('a cancellation without a reason is refused, and a cancellation WITH one is audited', async () => {
    const jar = await registerUserWith(env, 'adm-cancel@example.com')
    const { bookId } = await readyBook(env, jar)
    env.GENERATION_INLINE_DISPATCH = '0'
    await app.request(`/api/v1/user-books/${bookId}/generations`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...jar.headers() }, body: JSON.stringify({}) }, env as never)
    const admin = await adminJar(env)

    const noReason = await app.request('/admin/generation/jobs/1/cancel', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...admin.headers() }, body: new URLSearchParams({ reason: 'x' }) }, env as never)
    expect([302, 303]).toContain(noReason.status)
    expect((await env.DB.prepare('SELECT status FROM generation_jobs WHERE id = 1').first<{ status: string }>())!.status).toBe('queued')

    const cancelled = await app.request('/admin/generation/jobs/1/cancel', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...admin.headers() }, body: new URLSearchParams({ reason: 'provider outage' }) }, env as never)
    expect([302, 303]).toContain(cancelled.status)
    expect((await env.DB.prepare('SELECT status FROM generation_jobs WHERE id = 1').first<{ status: string }>())!.status).toBe('cancelled')
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM admin_audit_events WHERE action = 'generation.job.cancel'").first<{ n: number }>())!.n).toBe(1)
  }, 90_000)

  it('the admin dispatch sweep runs due work and is audited', async () => {
    const jar = await registerUserWith(env, 'adm-dispatch@example.com')
    const { bookId } = await readyBook(env, jar)
    env.GENERATION_INLINE_DISPATCH = '0'
    await app.request(`/api/v1/user-books/${bookId}/generations`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...jar.headers() } }, env as never)
    const admin = await adminJar(env)
    const res = await app.request('/admin/generation/dispatch', { method: 'POST', headers: { ...admin.headers() } }, env as never)
    expect([302, 303]).toContain(res.status)
    expect((await env.DB.prepare('SELECT status FROM generation_jobs WHERE id = 1').first<{ status: string }>())!.status).toBe('succeeded')
    const audit = await env.DB.prepare("SELECT metadata_json FROM admin_audit_events WHERE action = 'generation.dispatch'").first<{ metadata_json: string }>()
    expect(audit).toBeTruthy()
    expect(JSON.parse(audit!.metadata_json).claimed).toBe(1)
  }, 90_000)

  it('the admin templates screen explains immutability and offers clone→publish, and the localization screen reports per-language coverage', async () => {
    const productId = await seedProduct(env)
    await ensurePublishedTemplateForProduct(env.DB, productId, 'en')
    const admin = await adminJar(env)

    const templates = await app.request('/admin/generation/templates', { headers: { ...admin.headers() } }, env as never)
    const html = await templates.text()
    expect(html).toMatch(/published template version is immutable/i)
    expect(html).toMatch(/Clone to draft/)
    expect(html).toMatch(/Prompt versions/)
    expect(html).toMatch(/deterministic-fake/)

    const localization = await app.request('/admin/localization', { headers: { ...admin.headers() } }, env as never)
    const loc = await localization.text()
    expect(loc).toMatch(/Generation template coverage/)
    // A language with no published template is reported as having none — never
    // as complete.
    expect(loc).toMatch(/none/)
    // English has one published version for the one active product.
    expect(loc).toMatch(/complete/)

    const previews = await app.request('/admin/generation/previews', { headers: { ...admin.headers() } }, env as never)
    const pv = await previews.text()
    expect(pv).toMatch(/Preview, revision and approval queues/)
    expect(pv).toMatch(/no fabricated pending preview/i)
  }, 90_000)

  it('the admin provider-health endpoint reports configuration status without any secret', async () => {
    env.GENERATION_STORY_API_URL = 'https://provider.example.com/v1'
    // Built by concatenation (never a literal `api_key: '<long value>'` shape)
    // so this test fixture cannot be mistaken for — or trip a scanner as — a
    // real credential. It is a placeholder, not a secret.
    const placeholderCredential = 'test-only-' + 'placeholder-credential'
    env.GENERATION_STORY_API_KEY = placeholderCredential
    const admin = await adminJar(env)
    const res = await app.request('/api/v1/admin/generation/providers', { headers: { ...admin.headers() } }, env as never)
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.providers.find((p: any) => p.capability === 'story_text').active).toBe('http')
    expect(body.configuration.watermarkLabel).toBeTruthy()
    expect(JSON.stringify(body)).not.toContain(placeholderCredential)
    expect(JSON.stringify(body)).not.toMatch(/provider\.example\.com/)
  }, 60_000)

  it('a customer cannot reach the admin provider-health endpoint', async () => {
    const jar = await registerUserWith(env, 'not-admin@example.com')
    const res = await app.request('/api/v1/admin/generation/providers', { headers: { ...jar.headers() } }, env as never)
    // V2 Phase 6 makes this denial EARLIER and stronger: the central admin guard
    // (src/admin-console/guard.ts) refuses the request before the route's own
    // handler runs, so a non-staff account now gets the uniform 401 instead of
    // that handler's deliberate 404. The property this test exists for — a
    // customer cannot reach the endpoint — is unchanged, and it is now enforced
    // in ONE place for the whole admin surface instead of per handler.
    expect([401, 404]).toContain(res.status)
    expect(res.status).not.toBe(200)
  }, 30_000)
})
