// GEN-01: versioned templates, scenes, placeholders and prompt/model/config
// versions, plus the publish workflow that makes a published version
// immutable.
//
// The database is the authority here, not this file: migration 0024's triggers
// already refuse to edit a template's identity once it leaves draft, refuse to
// un-publish or revive a version, refuse to edit a scene or placeholder whose
// owning template has left draft, and refuse to edit a published prompt's
// wording/model/config. This module therefore only ever:
//   * inserts a new version (clone-then-edit),
//   * performs the one legal status change (draft -> published, published ->
//     retired, draft -> retired), and
//   * validates a draft in application code BEFORE it is published, so an
//     operator gets a clear message instead of a constraint abort.
//
// A published version is never edited anywhere in Phase 3 — including by the
// generation pipeline, which only ever reads.
import { sha256Hex } from '../secrets'
import { DomainError, type BookSceneRow, type BookTemplateRow, type PromptVersionRow, type ScenePlaceholderRow } from './types'
import { parseLayoutConfig, parsePlaceholderConstraints, type LayoutConfig, type PlaceholderConstraints } from './layout'

export type TemplateScene = {
  id: number
  sceneKey: string
  sortOrder: number
  kind: string
  layout: LayoutConfig
  placeholders: Array<{ key: string; type: string; required: boolean; constraints: PlaceholderConstraints }>
}

export type LoadedTemplate = {
  template: BookTemplateRow
  scenes: TemplateScene[]
  prompts: Record<'story_text' | 'illustration' | 'translation', PromptVersionRow>
}

export const PROMPT_KINDS = ['story_text', 'illustration', 'translation'] as const
export type PromptKind = (typeof PROMPT_KINDS)[number]

const TEMPLATE_DEFAULT_LANGUAGE = 'en'

async function maxTemplateVersion(db: D1Database, productId: number, languageCode: string): Promise<number> {
  const row = await db
    .prepare('SELECT COALESCE(MAX(version), 0) AS v FROM book_templates WHERE product_id = ? AND language_code = ?')
    .bind(productId, languageCode)
    .first<{ v: number }>()
  return row?.v ?? 0
}

async function publishedTemplate(db: D1Database, productId: number, languageCode: string): Promise<BookTemplateRow | null> {
  return db
    .prepare("SELECT * FROM book_templates WHERE product_id = ? AND language_code = ? AND status = 'published'")
    .bind(productId, languageCode)
    .first<BookTemplateRow>()
}

/**
 * Instantiates an immutable, published template (plus its ordered scenes,
 * placeholders and prompt bindings) for a product from the reviewed scaffold
 * in migration 0025.
 *
 * Idempotent and race-safe: the partial unique index
 * `idx_book_templates_one_published` is the final authority, so two concurrent
 * callers cannot end up with two published templates — the loser re-reads the
 * winner's row and returns it.
 */
export async function ensurePublishedTemplateForProduct(db: D1Database, productId: number, languageCode = TEMPLATE_DEFAULT_LANGUAGE): Promise<BookTemplateRow> {
  const existing = await publishedTemplate(db, productId, languageCode)
  if (existing) return existing

  const scaffold = await db
    .prepare("SELECT key FROM template_scaffolds WHERE language_code = ? AND active = 1 ORDER BY version DESC LIMIT 1")
    .bind(languageCode)
    .first<{ key: string }>()
  if (!scaffold) {
    throw new DomainError('no_template_scaffold', `No generation template scaffold is available for language "${languageCode}".`, 409)
  }

  const promptVersions = await loadPublishedPrompts(db)
  for (const kind of PROMPT_KINDS) {
    if (!promptVersions[kind]) {
      throw new DomainError('no_published_prompt', `No published ${kind} prompt version is available, so a template cannot be provisioned.`, 409)
    }
  }

  const sceneRows = await db
    .prepare('SELECT * FROM template_scaffold_scenes WHERE scaffold_key = ? ORDER BY sort_order')
    .bind(scaffold.key)
    .all<{ id: number; scene_key: string; sort_order: number; kind: string; layout_json: string }>()
  const scenes = sceneRows.results || []
  if (!scenes.length) throw new DomainError('no_template_scaffold', 'The generation template scaffold has no scenes.', 409)
  // Validate the scaffold's own config before instantiating it — a malformed
  // scaffold must fail loudly here, not halfway through a generation job.
  for (const scene of scenes) parseLayoutConfig(scene.layout_json)

  const version = (await maxTemplateVersion(db, productId, languageCode)) + 1
  try {
    await db
      .prepare("INSERT INTO book_templates (product_id, language_code, version, status, published_at) VALUES (?, ?, ?, 'published', CURRENT_TIMESTAMP)")
      .bind(productId, languageCode, version)
      .run()
  } catch (err) {
    const winner = await publishedTemplate(db, productId, languageCode)
    if (winner) return winner
    throw err
  }

  const template = await publishedTemplate(db, productId, languageCode)
  if (!template) throw new DomainError('internal', 'Failed to provision the generation template.', 500)

  const statements = scenes.map((scene) =>
    db
      .prepare("INSERT INTO book_scenes (template_id, scene_key, sort_order, kind, layout_json) VALUES (?, ?, ?, ?, ?)")
      .bind(template.id, scene.scene_key, scene.sort_order, scene.kind, scene.layout_json)
  )
  statements.push(
    ...PROMPT_KINDS.map((kind) =>
      db
        .prepare('INSERT INTO template_prompt_versions (template_id, prompt_version_id, kind) VALUES (?, ?, ?)')
        .bind(template.id, promptVersions[kind]!.id, kind)
    )
  )
  await db.batch(statements)

  const created = await db.prepare('SELECT * FROM book_scenes WHERE template_id = ? ORDER BY sort_order').bind(template.id).all<BookSceneRow>()
  const placeholderStatements: D1PreparedStatement[] = []
  for (const scene of created.results || []) {
    const placeholders = await db
      .prepare('SELECT * FROM template_scaffold_placeholders WHERE scaffold_scene_id = (SELECT id FROM template_scaffold_scenes WHERE scaffold_key = ? AND scene_key = ?) ORDER BY id')
      .bind(scaffold.key, scene.scene_key)
      .all<{ placeholder_key: string; type: string; required: number; constraints_json: string }>()
    for (const placeholder of placeholders.results || []) {
      placeholderStatements.push(
        db
          .prepare('INSERT INTO scene_placeholders (scene_id, placeholder_key, type, required, constraints_json) VALUES (?, ?, ?, ?, ?)')
          .bind(scene.id, placeholder.placeholder_key, placeholder.type, placeholder.required, placeholder.constraints_json)
      )
    }
  }
  if (placeholderStatements.length) await db.batch(placeholderStatements)

  return template
}

export async function loadPublishedPrompts(db: D1Database): Promise<Partial<Record<PromptKind, PromptVersionRow>>> {
  const rows = await db
    .prepare("SELECT * FROM prompt_versions WHERE status = 'published' AND kind IN ('story_text', 'illustration', 'translation')")
    .all<PromptVersionRow>()
  const out: Partial<Record<PromptKind, PromptVersionRow>> = {}
  for (const row of rows.results || []) {
    const kind = row.kind as PromptKind
    // Deterministic pick: the highest published version wins if a prompt_key
    // ever has more than one published key of the same kind.
    if (!out[kind] || out[kind]!.version < row.version) out[kind] = row
  }
  return out
}

/** Loads a template with its ordered scenes, validated layout config, placeholders and pinned prompt versions. */
export async function loadTemplate(db: D1Database, templateId: number): Promise<LoadedTemplate> {
  const template = await db.prepare('SELECT * FROM book_templates WHERE id = ?').bind(templateId).first<BookTemplateRow>()
  if (!template) throw new DomainError('template_not_found', 'Generation template not found.', 404)

  const sceneRows = await db.prepare('SELECT * FROM book_scenes WHERE template_id = ? ORDER BY sort_order, id').bind(templateId).all<BookSceneRow>()
  const scenes: TemplateScene[] = []
  for (const scene of sceneRows.results || []) {
    const placeholderRows = await db.prepare('SELECT * FROM scene_placeholders WHERE scene_id = ? ORDER BY id').bind(scene.id).all<ScenePlaceholderRow>()
    scenes.push({
      id: scene.id,
      sceneKey: scene.scene_key,
      sortOrder: scene.sort_order,
      kind: scene.kind,
      layout: parseLayoutConfig(scene.layout_json),
      placeholders: (placeholderRows.results || []).map((p) => ({
        key: p.placeholder_key,
        type: p.type,
        required: p.required === 1,
        constraints: parsePlaceholderConstraints(p.constraints_json)
      }))
    })
  }

  const bindingRows = await db
    .prepare(
      `SELECT pv.*, tpv.kind AS binding_kind FROM template_prompt_versions tpv
       JOIN prompt_versions pv ON pv.id = tpv.prompt_version_id
       WHERE tpv.template_id = ?`
    )
    .bind(templateId)
    .all<PromptVersionRow & { binding_kind: string }>()
  const prompts = {} as LoadedTemplate['prompts']
  for (const row of bindingRows.results || []) {
    const kind = (row.binding_kind || row.kind) as PromptKind
    if (PROMPT_KINDS.includes(kind)) prompts[kind] = row
  }
  return { template, scenes, prompts }
}

/**
 * Substitutes DECLARED {{token}} placeholders with plain string values.
 *
 * Only tokens that literally appear in the prompt template are replaced, and
 * each replacement value is inserted as-is — it is never re-scanned for
 * further tokens (so a child's name containing "{{...}}" cannot become a
 * second substitution), never interpreted, and never executed. An undeclared
 * token in the template is a hard error rather than a silent empty string,
 * because a prompt with an unfilled instruction would otherwise be sent to a
 * provider as if it were complete.
 */
export function resolvePromptTemplate(templateText: string, values: Record<string, string>): string {
  const tokenPattern = /\{\{\s*([a-z0-9_]+)\s*\}\}/gi
  const declared = new Set<string>()
  let match: RegExpExecArray | null
  while ((match = tokenPattern.exec(templateText)) !== null) declared.add(match[1].toLowerCase())
  for (const token of declared) {
    if (!(token in values)) {
      throw new DomainError('unknown_prompt_token', `The prompt template declares "{{${token}}}" but no value was supplied for it.`, 500)
    }
  }
  return templateText.replace(tokenPattern, (_full, token: string) => String(values[token.toLowerCase()] ?? ''))
}

export function promptHashOf(resolved: string): Promise<string> {
  return sha256Hex(resolved)
}

// ---------------------------------------------------------------------------
// Admin: draft editing + publish workflow
// ---------------------------------------------------------------------------

async function requireTemplate(db: D1Database, templateId: number): Promise<BookTemplateRow> {
  const template = await db.prepare('SELECT * FROM book_templates WHERE id = ?').bind(templateId).first<BookTemplateRow>()
  if (!template) throw new DomainError('template_not_found', 'Generation template not found.', 404)
  return template
}

/** Draft-only guard, mirroring the DB triggers so the failure is a clear message rather than a constraint abort. */
export function assertDraft(template: BookTemplateRow) {
  if (template.status !== 'draft') {
    throw new DomainError('template_immutable', `This template is ${template.status}. Published and used versions are immutable — clone it into a new draft version to make changes.`, 409)
  }
}

/**
 * Clones a template — published, retired or draft — into the next DRAFT
 * version for the same (product, language), copying its scenes, placeholders
 * and prompt bindings. This is the ONLY sanctioned way to "edit" a published
 * template (GEN-01).
 */
export async function cloneTemplateToDraft(db: D1Database, templateId: number): Promise<BookTemplateRow> {
  const source = await requireTemplate(db, templateId)
  const loaded = await loadTemplate(db, templateId)
  const version = (await maxTemplateVersion(db, source.product_id, source.language_code)) + 1

  await db
    .prepare("INSERT INTO book_templates (product_id, language_code, version, status) VALUES (?, ?, ?, 'draft')")
    .bind(source.product_id, source.language_code, version)
    .run()
  const draft = await db
    .prepare('SELECT * FROM book_templates WHERE product_id = ? AND language_code = ? AND version = ?')
    .bind(source.product_id, source.language_code, version)
    .first<BookTemplateRow>()
  if (!draft) throw new DomainError('internal', 'Failed to clone the template.', 500)

  for (const scene of loaded.scenes) {
    await db
      .prepare('INSERT INTO book_scenes (template_id, scene_key, sort_order, kind, layout_json) VALUES (?, ?, ?, ?, ?)')
      .bind(draft.id, scene.sceneKey, scene.sortOrder, scene.kind, JSON.stringify({
        slots: scene.layout.slots,
        output: scene.layout.output,
        style: scene.layout.style,
        subject: scene.layout.subject
      }))
      .run()
    const newScene = await db
      .prepare('SELECT id FROM book_scenes WHERE template_id = ? AND scene_key = ?')
      .bind(draft.id, scene.sceneKey)
      .first<{ id: number }>()
    if (!newScene) continue
    for (const placeholder of scene.placeholders) {
      await db
        .prepare('INSERT INTO scene_placeholders (scene_id, placeholder_key, type, required, constraints_json) VALUES (?, ?, ?, ?, ?)')
        .bind(newScene.id, placeholder.key, placeholder.type, placeholder.required ? 1 : 0, JSON.stringify(placeholder.constraints))
        .run()
    }
  }
  for (const kind of PROMPT_KINDS) {
    const prompt = loaded.prompts[kind]
    if (!prompt) continue
    await db
      .prepare('INSERT INTO template_prompt_versions (template_id, prompt_version_id, kind) VALUES (?, ?, ?)')
      .bind(draft.id, prompt.id, kind)
      .run()
  }
  return draft
}

export type TemplateValidation = { ok: true } | { ok: false; errors: string[] }

/** Everything that must be true before a draft may be published. */
export async function validateTemplateForPublish(db: D1Database, templateId: number): Promise<TemplateValidation> {
  const errors: string[] = []
  const template = await requireTemplate(db, templateId)
  let loaded: LoadedTemplate
  try {
    loaded = await loadTemplate(db, templateId)
  } catch (err) {
    return { ok: false, errors: [err instanceof Error ? err.message : 'The template could not be read.'] }
  }
  if (!loaded.scenes.length) errors.push('A template needs at least one scene.')
  const keys = new Set<string>()
  for (const scene of loaded.scenes) {
    if (keys.has(scene.sceneKey)) errors.push(`Duplicate scene key "${scene.sceneKey}".`)
    keys.add(scene.sceneKey)
    if (scene.layout.subject.length < 4) errors.push(`Scene "${scene.sceneKey}" needs a descriptive subject.`)
    const slotKeys = new Set(scene.layout.slots.map((s) => s.key))
    if (!scene.placeholders.length) errors.push(`Scene "${scene.sceneKey}" declares no placeholders.`)
    const generatedStory = scene.placeholders.filter((p) => p.constraints.source === 'generated_story')
    if (generatedStory.length > 1) {
      // One story text is generated per scene; two placeholders would mean one
      // of them is silently never filled.
      errors.push(`Scene "${scene.sceneKey}" declares ${generatedStory.length} generated-story placeholders; at most one is supported.`)
    }
    // A text placeholder whose value comes from a generated story MUST declare
    // a word budget, otherwise the output validator has nothing to check the
    // generated text against.
    for (const placeholder of generatedStory) {
      if (placeholder.constraints.maxWords === undefined) errors.push(`Placeholder "${placeholder.key}" in scene "${scene.sceneKey}" must declare maxWords.`)
    }
    for (const placeholder of scene.placeholders) {
      if (!slotKeys.has(placeholder.key)) {
        errors.push(`Scene "${scene.sceneKey}" declares placeholder "${placeholder.key}" with no matching layout slot.`)
      }
    }
    for (const slot of scene.layout.slots) {
      if (!scene.placeholders.some((p) => p.key === slot.key)) {
        errors.push(`Scene "${scene.sceneKey}" has a layout slot "${slot.key}" with no declared placeholder.`)
      }
    }
  }
  for (const kind of ['story_text', 'illustration'] as const) {
    if (!loaded.prompts[kind]) errors.push(`No ${kind} prompt version is pinned to this template.`)
  }
  if (template.status === 'published') errors.push('This template is already published.')
  if (template.status === 'retired') errors.push('A retired template cannot be published.')
  return errors.length ? { ok: false, errors } : { ok: true }
}

/**
 * Publishes a draft. Retirement of the previously published sibling and the
 * publish itself happen in ONE batch, so the "exactly one published version
 * per (product, language)" unique index is never violated and no window ever
 * exists in which the product has no published template.
 */
export async function publishTemplate(db: D1Database, templateId: number): Promise<BookTemplateRow> {
  const template = await requireTemplate(db, templateId)
  assertDraft(template)
  const validation = await validateTemplateForPublish(db, templateId)
  if (!validation.ok) {
    throw new DomainError('template_invalid', `This template cannot be published: ${validation.errors.join(' ')}`, 400)
  }
  await db.batch([
    db
      .prepare("UPDATE book_templates SET status = 'retired' WHERE product_id = ? AND language_code = ? AND status = 'published' AND id != ?")
      .bind(template.product_id, template.language_code, templateId),
    db.prepare("UPDATE book_templates SET status = 'published', published_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'draft'").bind(templateId)
  ])
  const fresh = await db.prepare('SELECT * FROM book_templates WHERE id = ?').bind(templateId).first<BookTemplateRow>()
  if (!fresh || fresh.status !== 'published') throw new DomainError('template_publish_failed', 'The template could not be published.', 409)
  return fresh
}

export async function retireTemplate(db: D1Database, templateId: number): Promise<BookTemplateRow> {
  const template = await requireTemplate(db, templateId)
  if (template.status === 'retired') return template
  if (template.status === 'published') {
    // Refuse to leave a product with no published template at all: retiring
    // the live version is only legal once a replacement is published.
    const sibling = await db
      .prepare("SELECT id FROM book_templates WHERE product_id = ? AND language_code = ? AND status = 'published' AND id != ?")
      .bind(template.product_id, template.language_code, templateId)
      .first<{ id: number }>()
    if (!sibling) {
      throw new DomainError('template_would_orphan_product', 'Publish a replacement version before retiring the only published template for this product and language.', 409)
    }
  }
  await db.prepare("UPDATE book_templates SET status = 'retired' WHERE id = ?").bind(templateId).run()
  const fresh = await db.prepare('SELECT * FROM book_templates WHERE id = ?').bind(templateId).first<BookTemplateRow>()
  if (!fresh) throw new DomainError('internal', 'Failed to retire the template.', 500)
  return fresh
}

export type DraftSceneInput = {
  sceneKey: string
  sortOrder: number
  kind: 'cover' | 'page' | 'spread' | 'back_cover'
  layout: unknown
}

/** Creates or replaces a DRAFT scene, validating its structured layout first. */
export async function saveDraftScene(db: D1Database, templateId: number, input: DraftSceneInput): Promise<BookSceneRow> {
  const template = await requireTemplate(db, templateId)
  assertDraft(template)
  const layout = parseLayoutConfig(input.layout)
  if (!/^[a-z0-9][a-z0-9-]{0,60}$/.test(input.sceneKey)) {
    throw new DomainError('invalid_scene_key', 'A scene key must be lowercase letters, digits and hyphens.', 400)
  }
  if (!Number.isInteger(input.sortOrder) || input.sortOrder < 0 || input.sortOrder > 999) {
    throw new DomainError('invalid_sort_order', 'A scene order must be a whole number between 0 and 999.', 400)
  }
  const existing = await db.prepare('SELECT * FROM book_scenes WHERE template_id = ? AND scene_key = ?').bind(templateId, input.sceneKey).first<BookSceneRow>()
  const serialized = JSON.stringify({ slots: layout.slots, output: layout.output, style: layout.style, subject: layout.subject })
  if (existing) {
    await db.prepare('UPDATE book_scenes SET sort_order = ?, kind = ?, layout_json = ? WHERE id = ?').bind(input.sortOrder, input.kind, serialized, existing.id).run()
    const fresh = await db.prepare('SELECT * FROM book_scenes WHERE id = ?').bind(existing.id).first<BookSceneRow>()
    if (!fresh) throw new DomainError('internal', 'Failed to save the scene.', 500)
    return fresh
  }
  await db
    .prepare('INSERT INTO book_scenes (template_id, scene_key, sort_order, kind, layout_json) VALUES (?, ?, ?, ?, ?)')
    .bind(templateId, input.sceneKey, input.sortOrder, input.kind, serialized)
    .run()
  const created = await db.prepare('SELECT * FROM book_scenes WHERE template_id = ? AND scene_key = ?').bind(templateId, input.sceneKey).first<BookSceneRow>()
  if (!created) throw new DomainError('internal', 'Failed to create the scene.', 500)
  return created
}

export async function deleteDraftScene(db: D1Database, templateId: number, sceneId: number): Promise<void> {
  const template = await requireTemplate(db, templateId)
  assertDraft(template)
  const scene = await db.prepare('SELECT * FROM book_scenes WHERE id = ? AND template_id = ?').bind(sceneId, templateId).first<BookSceneRow>()
  if (!scene) throw new DomainError('scene_not_found', 'Scene not found on this template.', 404)
  await db.prepare('DELETE FROM book_scenes WHERE id = ?').bind(sceneId).run()
}

export type DraftPlaceholderInput = {
  placeholderKey: string
  type: 'face' | 'text' | 'image_static'
  required: boolean
  constraints: unknown
}

export async function saveDraftPlaceholder(db: D1Database, templateId: number, sceneId: number, input: DraftPlaceholderInput): Promise<ScenePlaceholderRow> {
  const template = await requireTemplate(db, templateId)
  assertDraft(template)
  const scene = await db.prepare('SELECT * FROM book_scenes WHERE id = ? AND template_id = ?').bind(sceneId, templateId).first<BookSceneRow>()
  if (!scene) throw new DomainError('scene_not_found', 'Scene not found on this template.', 404)
  const constraints = parsePlaceholderConstraints(input.constraints)
  if (!/^[a-z0-9][a-z0-9_-]{0,40}$/.test(input.placeholderKey)) {
    throw new DomainError('invalid_placeholder_key', 'A placeholder key must be lowercase letters, digits, underscores and hyphens.', 400)
  }
  const serialized = JSON.stringify(constraints)
  const existing = await db.prepare('SELECT * FROM scene_placeholders WHERE scene_id = ? AND placeholder_key = ?').bind(sceneId, input.placeholderKey).first<ScenePlaceholderRow>()
  if (existing) {
    await db.prepare('UPDATE scene_placeholders SET type = ?, required = ?, constraints_json = ? WHERE id = ?').bind(input.type, input.required ? 1 : 0, serialized, existing.id).run()
    const fresh = await db.prepare('SELECT * FROM scene_placeholders WHERE id = ?').bind(existing.id).first<ScenePlaceholderRow>()
    if (!fresh) throw new DomainError('internal', 'Failed to save the placeholder.', 500)
    return fresh
  }
  await db
    .prepare('INSERT INTO scene_placeholders (scene_id, placeholder_key, type, required, constraints_json) VALUES (?, ?, ?, ?, ?)')
    .bind(sceneId, input.placeholderKey, input.type, input.required ? 1 : 0, serialized)
    .run()
  const created = await db.prepare('SELECT * FROM scene_placeholders WHERE scene_id = ? AND placeholder_key = ?').bind(sceneId, input.placeholderKey).first<ScenePlaceholderRow>()
  if (!created) throw new DomainError('internal', 'Failed to create the placeholder.', 500)
  return created
}

/** Binds a prompt version to a DRAFT template (what produced this template's pages is then answerable forever). */
export async function bindDraftPrompt(db: D1Database, templateId: number, kind: PromptKind, promptVersionId: number): Promise<void> {
  const template = await requireTemplate(db, templateId)
  assertDraft(template)
  const prompt = await db.prepare('SELECT * FROM prompt_versions WHERE id = ?').bind(promptVersionId).first<PromptVersionRow>()
  if (!prompt) throw new DomainError('prompt_not_found', 'Prompt version not found.', 404)
  if (prompt.kind !== kind) throw new DomainError('prompt_kind_mismatch', `That prompt version is a ${prompt.kind} prompt, not ${kind}.`, 400)
  if (prompt.status !== 'published') throw new DomainError('prompt_not_published', 'Only a published prompt version can be pinned to a template.', 400)
  const existing = await db.prepare('SELECT id FROM template_prompt_versions WHERE template_id = ? AND kind = ?').bind(templateId, kind).first<{ id: number }>()
  if (existing) {
    await db.prepare('UPDATE template_prompt_versions SET prompt_version_id = ? WHERE id = ?').bind(promptVersionId, existing.id).run()
    return
  }
  await db.prepare('INSERT INTO template_prompt_versions (template_id, prompt_version_id, kind) VALUES (?, ?, ?)').bind(templateId, promptVersionId, kind).run()
}

// ---------------------------------------------------------------------------
// Prompt version management (ADM-08)
// ---------------------------------------------------------------------------

export async function listPromptVersions(db: D1Database) {
  const rows = await db.prepare('SELECT * FROM prompt_versions ORDER BY prompt_key, version DESC').all<PromptVersionRow>()
  return rows.results || []
}

export async function clonePromptVersionToDraft(db: D1Database, promptVersionId: number, overrides: { provider?: string; model?: string; templateText?: string; params?: unknown } = {}): Promise<PromptVersionRow> {
  const source = await db.prepare('SELECT * FROM prompt_versions WHERE id = ?').bind(promptVersionId).first<PromptVersionRow>()
  if (!source) throw new DomainError('prompt_not_found', 'Prompt version not found.', 404)
  const max = await db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM prompt_versions WHERE prompt_key = ?').bind(source.prompt_key).first<{ v: number }>()
  const version = (max?.v ?? 0) + 1
  const provider = overrides.provider !== undefined ? String(overrides.provider) : source.provider
  const model = overrides.model !== undefined ? String(overrides.model).trim() : source.model
  const templateText = overrides.templateText !== undefined ? String(overrides.templateText) : source.template_text
  if (!model || model.length > 120) throw new DomainError('invalid_model', 'A model identifier of at most 120 characters is required.', 400)
  if (!templateText.trim() || templateText.length > 8000) throw new DomainError('invalid_prompt_text', 'Prompt text is required (at most 8000 characters).', 400)
  const params = overrides.params !== undefined ? overrides.params : JSON.parse(source.params_json)
  await db
    .prepare("INSERT INTO prompt_versions (prompt_key, kind, version, status, provider, model, params_json, template_text) VALUES (?, ?, ?, 'draft', ?, ?, ?, ?)")
    .bind(source.prompt_key, source.kind, version, provider, model, JSON.stringify(params ?? {}), templateText)
    .run()
  const created = await db.prepare('SELECT * FROM prompt_versions WHERE prompt_key = ? AND version = ?').bind(source.prompt_key, version).first<PromptVersionRow>()
  if (!created) throw new DomainError('internal', 'Failed to clone the prompt version.', 500)
  return created
}

/**
 * Publishes a draft prompt version, retiring whichever version was published
 * for that prompt key in the same batch so the single-published index is
 * never violated.
 */
export async function publishPromptVersion(db: D1Database, promptVersionId: number): Promise<PromptVersionRow> {
  const prompt = await db.prepare('SELECT * FROM prompt_versions WHERE id = ?').bind(promptVersionId).first<PromptVersionRow>()
  if (!prompt) throw new DomainError('prompt_not_found', 'Prompt version not found.', 404)
  if (prompt.status === 'published') return prompt
  if (prompt.status === 'retired') throw new DomainError('prompt_immutable', 'A retired prompt version cannot be published.', 409)
  // Validate the prompt's declared tokens are a known set, so a typo like
  // {{childname}} surfaces here instead of failing every generation later.
  const tokens = new Set<string>()
  const pattern = /\{\{\s*([a-z0-9_]+)\s*\}\}/gi
  let match: RegExpExecArray | null
  while ((match = pattern.exec(prompt.template_text)) !== null) tokens.add(match[1].toLowerCase())
  const known = new Set(Object.keys(PROMPT_TOKENS))
  const unknown = [...tokens].filter((t) => !known.has(t))
  if (unknown.length) {
    throw new DomainError('unknown_prompt_token', `This prompt uses unsupported placeholder(s): ${unknown.map((t) => `{{${t}}}`).join(', ')}.`, 400)
  }
  await db.batch([
    db.prepare("UPDATE prompt_versions SET status = 'retired' WHERE prompt_key = ? AND status = 'published' AND id != ?").bind(prompt.prompt_key, promptVersionId),
    db.prepare("UPDATE prompt_versions SET status = 'published', published_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'draft'").bind(promptVersionId)
  ])
  const fresh = await db.prepare('SELECT * FROM prompt_versions WHERE id = ?').bind(promptVersionId).first<PromptVersionRow>()
  if (!fresh || fresh.status !== 'published') throw new DomainError('prompt_publish_failed', 'The prompt version could not be published.', 409)
  return fresh
}

/**
 * The complete set of prompt tokens this project supports. A prompt template
 * may only use these; anything else is rejected at publish time.
 */
export const PROMPT_TOKENS: Record<string, string> = {
  child_name: "The child's name from the current personalization revision.",
  child_age: "The child's age from the current personalization revision.",
  language: 'The language the personalization is being written in.',
  scene_key: 'The stable key of the scene being generated.',
  scene_subject: 'The scene subject string from the scene layout config.',
  style_palette: 'The style palette token from the scene layout config.',
  style_mood: 'The style mood token from the scene layout config.',
  output_width: 'The declared illustration width in pixels.',
  output_height: 'The declared illustration height in pixels.',
  output_aspect: 'The declared illustration aspect ratio.',
  max_words: 'The maximum word count declared by the story_text placeholder.',
  source_text: 'The already-generated source line a translation is produced from.'
}

// ---------------------------------------------------------------------------
// Consent (PER-09)
// ---------------------------------------------------------------------------

/** The currently published consent version for a key, or null. Never guessed or back-filled. */
export async function getPublishedConsentVersion(db: D1Database, key = 'personalization_photo_processing') {
  return db
    .prepare("SELECT * FROM consent_versions WHERE key = ? AND status = 'published' ORDER BY published_at DESC LIMIT 1")
    .bind(key)
    .first<import('./types').ConsentVersionRow>()
}
