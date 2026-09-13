// Phase 2 personalization domain HTTP routes. Mounted from src/index.tsx.
// Every handler is a thin adapter: resolve the owner, call the domain
// service, shape the response — no business rule lives in this file.
import type { Hono, Context } from 'hono'
import type { Bindings, Vars } from '../index'
import { DomainError, errorBody, newRequestId } from './types'
import { resolveOwner, resolveOrCreateOwner, loadOwnedUserBook } from './ownership'
import { initiateUpload, completeUpload, getOwnedCompletedUpload } from './uploads'
import { getFaceAnalysisAdapter } from './face-analysis'
import { createUserBook, getUserBook, patchPersonalization, getPersonalizationSchema, toView } from './user-books'
import { applyAnalysisOutcome, selectFace as selectFaceTransition, loadUserBook } from './state-machine'
import type { UserBookRow, DetectedFaceRow } from './types'

type Ctx = Context<{ Bindings: Bindings; Variables: Vars }>

async function withErrors(c: Ctx, fn: () => Promise<Response>): Promise<Response> {
  const requestId = newRequestId()
  try {
    return await fn()
  } catch (err) {
    if (err instanceof DomainError) {
      return c.json(errorBody(err, requestId), err.status as any)
    }
    console.error(`[personalization] unhandled error (requestId=${requestId}):`, err instanceof Error ? err.message : err)
    return c.json(errorBody(new DomainError('internal', 'Something went wrong. Please try again.', 500), requestId), 500)
  }
}

function actorFromOwner(owner: { type: 'user' | 'prospect'; userId?: number; prospectId?: string }) {
  return owner.type === 'user' ? { actorType: 'user' as const, actorId: String(owner.userId) } : { actorType: 'prospect' as const, actorId: owner.prospectId ?? null }
}

async function faceSummary(db: D1Database, uploadKey: string) {
  const rows = await db.prepare('SELECT * FROM detected_faces WHERE upload_key = ? ORDER BY sort_order').bind(uploadKey).all<DetectedFaceRow>()
  return (rows.results || []).map((f) => ({
    id: f.id,
    boundingBox: { x: f.bbox_x, y: f.bbox_y, width: f.bbox_w, height: f.bbox_h },
    confidence: f.confidence,
    category: f.category
  }))
}

export function registerPersonalizationRoutes(app: Hono<{ Bindings: Bindings; Variables: Vars }>) {
  // ---- languages ----
  app.get('/api/v1/languages', async (c) =>
    withErrors(c, async () => {
      const rows = await c.env.DB.prepare('SELECT code, name, native_name, direction FROM languages WHERE active = 1 ORDER BY name').all()
      return c.json({ languages: rows.results || [] })
    })
  )

  // ---- personalization schema ----
  app.get('/api/v1/products/:slug/personalization-schema', async (c) =>
    withErrors(c, async () => {
      const schema = await getPersonalizationSchema(c.env.DB, c.req.param('slug'))
      return c.json(schema)
    })
  )

  // ---- upload lifecycle ----
  app.post('/api/v1/uploads/photo/initiate', async (c) =>
    withErrors(c, async () => {
      const owner = await resolveOrCreateOwner(c, c.env.ENVIRONMENT)
      const body = await c.req.json<any>().catch(() => ({}))
      const result = await initiateUpload(c.env.DB, owner, { contentType: String(body.contentType || ''), byteSize: Number(body.byteSize || 0) })
      return c.json({ uploadId: result.uploadKey, completionToken: result.completionToken, expiresAt: result.expiresAt })
    })
  )

  app.post('/api/v1/uploads/photo/complete', async (c) =>
    withErrors(c, async () => {
      const owner = await resolveOwner(c)
      if (!owner) throw new DomainError('not_found', 'Upload session not found.', 404)
      if (!c.env.PHOTOS) throw new DomainError('storage_unavailable', 'Photo storage unavailable.', 503)

      const body = await c.req.parseBody()
      const uploadId = String(body.uploadId || '')
      const completionToken = String(body.completionToken || '')
      const file = body.photo
      if (!(file instanceof File) || !uploadId) throw new DomainError('validation_failed', 'A photo file and uploadId are required.', 400)

      const bytes = new Uint8Array(await file.arrayBuffer())
      const image = await completeUpload(c.env.DB, owner, uploadId, completionToken, bytes)
      await c.env.PHOTOS.put(uploadId, bytes, { httpMetadata: { contentType: image.format === 'png' ? 'image/png' : 'image/jpeg' } })
      return c.json({ ok: true, uploadId, width: image.width, height: image.height })
    })
  )

  // ---- analysis ----
  app.get('/api/v1/uploads/:id/analysis', async (c) =>
    withErrors(c, async () => {
      const owner = await resolveOwner(c)
      if (!owner) throw new DomainError('not_found', 'Not found.', 404)
      const uploadKey = c.req.param('id')
      const upload = await getOwnedCompletedUpload(c.env.DB, owner, uploadKey)
      if (!upload) return c.json({ status: 'pending_upload' })

      let faces = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM detected_faces WHERE upload_key = ?').bind(uploadKey).first<{ n: number }>()
      if (!faces || faces.n === 0) {
        if (!c.env.PHOTOS) throw new DomainError('storage_unavailable', 'Photo storage unavailable.', 503)
        const object = await c.env.PHOTOS.get(uploadKey)
        if (!object) throw new DomainError('not_found', 'Not found.', 404)
        const bytes = new Uint8Array(await object.arrayBuffer())
        const adapter = getFaceAnalysisAdapter(c.env)
        let detections
        try {
          detections = await adapter.analyze(bytes)
        } catch (err) {
          if (err instanceof DomainError) return c.json({ status: 'unavailable', message: err.message })
          throw err
        }
        const stmts = detections.map((d, i) =>
          c.env.DB.prepare('INSERT INTO detected_faces (id, upload_key, sort_order, bbox_x, bbox_y, bbox_w, bbox_h, confidence, category) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(
            `face_${crypto.randomUUID().replace(/-/g, '')}`,
            uploadKey,
            i,
            d.bboxX,
            d.bboxY,
            d.bboxW,
            d.bboxH,
            d.confidence,
            d.category
          )
        )
        if (stmts.length) await c.env.DB.batch(stmts)

        // Apply the outcome to whichever ACTIVE user_book (owned by this
        // same caller) currently has this upload selected and is waiting
        // on analysis — a fresh upload not yet attached anywhere just gets
        // its detected_faces recorded without touching any book's state.
        const book = await c.env.DB
          .prepare(
            `SELECT * FROM user_books WHERE selected_upload_key = ? AND state = 'awaiting_photo_analysis' AND ${
              owner.type === 'user' ? 'user_id = ?' : 'prospect_id = ?'
            }`
          )
          .bind(uploadKey, owner.type === 'user' ? owner.userId : owner.prospectId)
          .first<UserBookRow>()
        if (book) {
          const ctx = actorFromOwner(owner)
          try {
            if (detections.length === 0) {
              await applyAnalysisOutcome(c.env.DB, book, ctx, { faces: 0 })
            } else if (detections.length === 1) {
              const face = await c.env.DB.prepare('SELECT id FROM detected_faces WHERE upload_key = ? ORDER BY sort_order LIMIT 1').bind(uploadKey).first<{ id: string }>()
              await applyAnalysisOutcome(c.env.DB, book, ctx, { faces: 1, faceId: face!.id })
            } else {
              await applyAnalysisOutcome(c.env.DB, book, ctx, { faces: detections.length })
            }
          } catch (err) {
            // zero_faces_detected is expected/honest, not a server error —
            // the analysis result itself (0 faces, empty list) is still
            // returned below.
            if (!(err instanceof DomainError && err.code === 'zero_faces_detected')) throw err
          }
        }
      }

      const summary = await faceSummary(c.env.DB, uploadKey)
      return c.json({ status: 'complete', faces: summary, faceSelectionRequired: summary.length > 1 })
    })
  )

  // ---- face selection ----
  app.post('/api/v1/uploads/:id/select-face', async (c) =>
    withErrors(c, async () => {
      const owner = await resolveOwner(c)
      if (!owner) throw new DomainError('not_found', 'Not found.', 404)
      const uploadKey = c.req.param('id')
      const body = await c.req.json<any>().catch(() => ({}))
      const userBookPublicId = String(body.userBookId || '')
      const faceId = String(body.faceId || '')
      if (!userBookPublicId || !faceId) throw new DomainError('validation_failed', 'userBookId and faceId are required.', 400)

      const book = await loadOwnedUserBook(c.env.DB, userBookPublicId, owner)
      if (book.selected_upload_key !== uploadKey) throw new DomainError('foreign_face', 'That upload does not belong to this book.', 400)

      const fresh = await selectFaceTransition(c.env.DB, book, actorFromOwner(owner), faceId)
      return c.json(await toView(c.env.DB, fresh))
    })
  )

  // ---- user-books ----
  app.post('/api/v1/user-books', async (c) =>
    withErrors(c, async () => {
      const owner = await resolveOrCreateOwner(c, c.env.ENVIRONMENT)
      const body = await c.req.json<any>().catch(() => ({}))
      const idempotencyKey = c.req.header('Idempotency-Key') || body.idempotencyKey
      const book = await createUserBook(c.env.DB, owner, { productSlug: String(body.productSlug || ''), idempotencyKey })
      return c.json(await toView(c.env.DB, book))
    })
  )

  app.get('/api/v1/user-books/:id', async (c) =>
    withErrors(c, async () => {
      const owner = await resolveOwner(c)
      const book = await getUserBook(c.env.DB, owner, c.req.param('id'))
      return c.json(await toView(c.env.DB, book))
    })
  )

  app.patch('/api/v1/user-books/:id/personalization', async (c) =>
    withErrors(c, async () => {
      const owner = await resolveOwner(c)
      if (!owner) throw new DomainError('not_found', 'Not found.', 404)
      const body = await c.req.json<any>().catch(() => ({}))
      const ifMatch = c.req.header('If-Match')
      const expectedVersion = ifMatch !== undefined ? Number(ifMatch) : body.expectedVersion !== undefined ? Number(body.expectedVersion) : undefined

      const result = await patchPersonalization(c.env.DB, owner, c.req.param('id'), {
        childName: body.childName !== undefined ? String(body.childName) : undefined,
        childAge: body.childAge !== undefined ? Number(body.childAge) : undefined,
        languageCode: body.languageCode !== undefined ? String(body.languageCode) : undefined,
        dedication: body.dedication !== undefined ? String(body.dedication) : undefined,
        photoUploadKey: body.photoUploadKey !== undefined ? String(body.photoUploadKey) : undefined,
        expectedVersion
      })
      const view = await toView(c.env.DB, result.book)
      return c.json({ ...view, revisionCreated: result.created, revision: result.revision.revision })
    })
  )
}
