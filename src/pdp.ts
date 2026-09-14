// Product Detail Page (e.g. https://wonderwraps.com/books/girls-sticker-pack)
// — read & write helpers for the per-product editables:
// banner, gallery, accordions, steps, photo tips, magic slider,
// trust cards, reactions, media logos, related products, FAQs.

import type { Product } from './db'

// ---------- types ----------
export type GalleryItem     = { id: number; image_url: string; alt: string; sort_order: number; active: number }
export type AccordionItem   = { id: number; title: string; body: string; sort_order: number; active: number }
export type StepItem        = { step_no: number; title: string; body: string }
export type TipItem         = { id: number; kind: 'bad' | 'good'; label: string; image_url: string; sort_order: number }
export type MagicBlock      = { heading: string; left_image: string; left_caption: string; right_image: string; right_caption: string; body: string }
export type TrustItem       = { id: number; title: string; body: string; icon: string; sort_order: number }
export type ReactionItem    = { id: number; name: string; rating: number; review: string; image_url: string; sort_order: number; active: number }
export type MediaItem       = { id: number; name: string; image_url: string; href: string; sort_order: number }
export type RelatedItem     = { id: number; slug: string; title: string; image: string; price: number; compareAt?: number; sort_order: number }
export type FaqItem         = { id: number; question: string; answer: string; sort_order: number; active: number }
export type PdpPageRow      = { banner_text: string; banner_code: string; banner_badge: string; preorder_note: string }

// ---------- loader (one round-trip per topic) ----------
export async function loadPdp(db: D1Database, product: Product) {
  const [page, gallery, accordions, steps, tips, magic, trust, reactions, media, related, faqs] = await Promise.all([
    db.prepare('SELECT * FROM pdp_page WHERE product_id = ?').bind(product.id).first<PdpPageRow>(),
    db.prepare('SELECT * FROM pdp_gallery WHERE product_id = ? AND active = 1 ORDER BY sort_order, id').bind(product.id).all<GalleryItem>(),
    db.prepare('SELECT * FROM pdp_accordions WHERE product_id = ? AND active = 1 ORDER BY sort_order, id').bind(product.id).all<AccordionItem>(),
    db.prepare('SELECT * FROM pdp_steps WHERE product_id = ? ORDER BY step_no').bind(product.id).all<StepItem>(),
    db.prepare('SELECT * FROM pdp_photo_tips WHERE product_id = ? ORDER BY kind, sort_order').bind(product.id).all<TipItem>(),
    db.prepare('SELECT * FROM pdp_magic WHERE product_id = ?').bind(product.id).first<MagicBlock>(),
    db.prepare('SELECT * FROM pdp_trust WHERE product_id = ? ORDER BY sort_order, id').bind(product.id).all<TrustItem>(),
    db.prepare('SELECT * FROM pdp_reactions WHERE product_id = ? AND active = 1 ORDER BY sort_order, id LIMIT 12').bind(product.id).all<ReactionItem>(),
    db.prepare('SELECT * FROM pdp_media WHERE product_id = ? ORDER BY sort_order, id').bind(product.id).all<MediaItem>(),
    db.prepare(
      `SELECT p.id, p.slug, p.title, p.image, p.price, p.compare_at, r.sort_order
       FROM pdp_related r JOIN products p ON p.id = r.related_id
       WHERE r.product_id = ? AND p.active = 1
       ORDER BY r.sort_order, p.title`
    ).bind(product.id).all<any>(),
    db.prepare('SELECT * FROM pdp_faqs WHERE product_id = ? AND active = 1 ORDER BY sort_order, id').bind(product.id).all<FaqItem>()
  ])

  const relatedItems: RelatedItem[] = (related.results || []).map((r: any) => ({
    id: r.id,
    slug: r.slug,
    title: r.title,
    image: r.image,
    price: r.price,
    compareAt: r.compare_at ?? undefined,
    sort_order: r.sort_order
  }))

  return {
    page: page || { banner_text: '', banner_code: '', banner_badge: '', preorder_note: '' } as PdpPageRow,
    gallery: gallery.results || [],
    accordions: accordions.results || [],
    steps: steps.results || [],
    tips: tips.results || [],
    magic: magic || { heading: '', left_image: '', left_caption: '', right_image: '', right_caption: '', body: '' } as MagicBlock,
    trust: trust.results || [],
    reactions: reactions.results || [],
    media: media.results || [],
    related: relatedItems,
    faqs: faqs.results || []
  }
}

// Default ensure that a row exists for a given product (so editor has something to edit).
// T-04/T-06: the seeded banner advertises only the discount the app itself
// creates and auto-applies (EXTRA20 — see bootstrapLocalDefaults). It must
// never advertise a code or saving the server cannot honour.
export async function ensurePdpPageRow(db: D1Database, productId: number) {
  await db
    .prepare('INSERT OR IGNORE INTO pdp_page (product_id, banner_text, banner_code, banner_badge, preorder_note) VALUES (?, ?, ?, ?, ?)')
    .bind(productId, 'Order 2+ books and save 20% automatically', 'EXTRA20', '', '')
    .run()
}

// ---------- upsert helpers (used by admin POST handlers) ----------

export async function savePdpPage(db: D1Database, productId: number, d: PdpPageRow) {
  await ensurePdpPageRow(db, productId)
  await db
    .prepare(
      `UPDATE pdp_page
       SET banner_text = ?, banner_code = ?, banner_badge = ?, preorder_note = ?, updated_at = CURRENT_TIMESTAMP
       WHERE product_id = ?`
    )
    .bind(d.banner_text, d.banner_code, d.banner_badge, d.preorder_note, productId)
    .run()
}

export async function upsertGallery(db: D1Database, productId: number, id: number | null, image_url: string, alt: string, sort_order: number, active: number) {
  if (id) {
    await db.prepare('UPDATE pdp_gallery SET image_url=?, alt=?, sort_order=?, active=? WHERE id=? AND product_id=?')
      .bind(image_url, alt, sort_order, active, id, productId).run()
  } else {
    await db.prepare('INSERT INTO pdp_gallery (product_id, image_url, alt, sort_order, active) VALUES (?, ?, ?, ?, ?)')
      .bind(productId, image_url, alt, sort_order, active).run()
  }
}
export async function deleteGallery(db: D1Database, productId: number, id: number) {
  await db.prepare('DELETE FROM pdp_gallery WHERE id = ? AND product_id = ?').bind(id, productId).run()
}

export async function upsertAccordion(db: D1Database, productId: number, id: number | null, title: string, body: string, sort_order: number, active: number) {
  if (id) {
    await db.prepare('UPDATE pdp_accordions SET title=?, body=?, sort_order=?, active=? WHERE id=? AND product_id=?')
      .bind(title, body, sort_order, active, id, productId).run()
  } else {
    await db.prepare('INSERT INTO pdp_accordions (product_id, title, body, sort_order, active) VALUES (?, ?, ?, ?, ?)')
      .bind(productId, title, body, sort_order, active).run()
  }
}
export async function deleteAccordion(db: D1Database, productId: number, id: number) {
  await db.prepare('DELETE FROM pdp_accordions WHERE id = ? AND product_id = ?').bind(id, productId).run()
}

export async function upsertStep(db: D1Database, productId: number, step_no: number, title: string, body: string) {
  await db.prepare(
    `INSERT INTO pdp_steps (product_id, step_no, title, body) VALUES (?, ?, ?, ?)
     ON CONFLICT(product_id, step_no) DO UPDATE SET title = excluded.title, body = excluded.body`
  ).bind(productId, step_no, title, body).run()
}

export async function upsertTip(db: D1Database, productId: number, id: number | null, kind: 'bad' | 'good', label: string, image_url: string, sort_order: number) {
  if (id) {
    await db.prepare('UPDATE pdp_photo_tips SET kind=?, label=?, image_url=?, sort_order=? WHERE id=? AND product_id=?')
      .bind(kind, label, image_url, sort_order, id, productId).run()
  } else {
    await db.prepare('INSERT INTO pdp_photo_tips (product_id, kind, label, image_url, sort_order) VALUES (?, ?, ?, ?, ?)')
      .bind(productId, kind, label, image_url, sort_order).run()
  }
}
export async function deleteTip(db: D1Database, productId: number, id: number) {
  await db.prepare('DELETE FROM pdp_photo_tips WHERE id = ? AND product_id = ?').bind(id, productId).run()
}

export async function saveMagic(db: D1Database, productId: number, m: MagicBlock) {
  await db.prepare(
    `INSERT INTO pdp_magic (product_id, heading, left_image, left_caption, right_image, right_caption, body)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(product_id) DO UPDATE SET
       heading = excluded.heading,
       left_image = excluded.left_image,
       left_caption = excluded.left_caption,
       right_image = excluded.right_image,
       right_caption = excluded.right_caption,
       body = excluded.body`
  ).bind(productId, m.heading, m.left_image, m.left_caption, m.right_image, m.right_caption, m.body).run()
}

export async function upsertTrust(db: D1Database, productId: number, id: number | null, title: string, body: string, icon: string, sort_order: number) {
  if (id) {
    await db.prepare('UPDATE pdp_trust SET title=?, body=?, icon=?, sort_order=? WHERE id=? AND product_id=?')
      .bind(title, body, icon, sort_order, id, productId).run()
  } else {
    await db.prepare('INSERT INTO pdp_trust (product_id, title, body, icon, sort_order) VALUES (?, ?, ?, ?, ?)')
      .bind(productId, title, body, icon, sort_order).run()
  }
}
export async function deleteTrust(db: D1Database, productId: number, id: number) {
  await db.prepare('DELETE FROM pdp_trust WHERE id = ? AND product_id = ?').bind(id, productId).run()
}

export async function upsertReaction(db: D1Database, productId: number, id: number | null, name: string, rating: number, review: string, image_url: string, sort_order: number, active: number) {
  if (id) {
    await db.prepare('UPDATE pdp_reactions SET name=?, rating=?, review=?, image_url=?, sort_order=?, active=? WHERE id=? AND product_id=?')
      .bind(name, rating, review, image_url, sort_order, active, id, productId).run()
  } else {
    await db.prepare('INSERT INTO pdp_reactions (product_id, name, rating, review, image_url, sort_order, active) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(productId, name, rating, review, image_url, sort_order, active).run()
  }
}
export async function deleteReaction(db: D1Database, productId: number, id: number) {
  await db.prepare('DELETE FROM pdp_reactions WHERE id = ? AND product_id = ?').bind(id, productId).run()
}

export async function upsertMedia(db: D1Database, productId: number, id: number | null, name: string, image_url: string, href: string, sort_order: number) {
  if (id) {
    await db.prepare('UPDATE pdp_media SET name=?, image_url=?, href=?, sort_order=? WHERE id=? AND product_id=?')
      .bind(name, image_url, href, sort_order, id, productId).run()
  } else {
    await db.prepare('INSERT INTO pdp_media (product_id, name, image_url, href, sort_order) VALUES (?, ?, ?, ?, ?)')
      .bind(productId, name, image_url, href, sort_order).run()
  }
}
export async function deleteMedia(db: D1Database, productId: number, id: number) {
  await db.prepare('DELETE FROM pdp_media WHERE id = ? AND product_id = ?').bind(id, productId).run()
}

export async function setRelated(db: D1Database, productId: number, relatedIds: number[]) {
  // Drop existing picks for this product.
  await db.prepare('DELETE FROM pdp_related WHERE product_id = ?').bind(productId).run()
  // Drop self-picks and any id that doesn't exist in products (FK constraint).
  const cleaned = relatedIds
    .filter((n) => Number.isFinite(n) && n > 0 && n !== productId)
    .slice(0, 8)
  if (!cleaned.length) return
  // Validate against products table — silently skip invalid ids.
  const placeholders = cleaned.map(() => '?').join(',')
  const valid = (
    await db.prepare(`SELECT id FROM products WHERE id IN (${placeholders}) AND active = 1`).bind(...cleaned).all<{ id: number }>()
  ).results || []
  const validIds = valid.map((r) => r.id)
  const stmts = validIds.map((rid, i) =>
    db.prepare('INSERT INTO pdp_related (product_id, related_id, sort_order) VALUES (?, ?, ?)').bind(productId, rid, i)
  )
  if (stmts.length) await db.batch(stmts)
}

export async function upsertFaq(db: D1Database, productId: number, id: number | null, question: string, answer: string, sort_order: number, active: number) {
  if (id) {
    await db.prepare('UPDATE pdp_faqs SET question=?, answer=?, sort_order=?, active=? WHERE id=? AND product_id=?')
      .bind(question, answer, sort_order, active, id, productId).run()
  } else {
    await db.prepare('INSERT INTO pdp_faqs (product_id, question, answer, sort_order, active) VALUES (?, ?, ?, ?, ?)')
      .bind(productId, question, answer, sort_order, active).run()
  }
}
export async function deleteFaq(db: D1Database, productId: number, id: number) {
  await db.prepare('DELETE FROM pdp_faqs WHERE id = ? AND product_id = ?').bind(id, productId).run()
}
