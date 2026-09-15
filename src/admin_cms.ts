// Admin CMS screens (V2 Phase 2).
//
// Requirement IDs: ADM-07 (homepage/PDP/content/blog/FAQ/legal CMS) plus
// ADM-16 (discounts) which stays in src/admin.ts and is extended by the route
// table with pagination and validation.
//
// This is what makes §12's acceptance criterion true — "all home/PDP/catalog
// content can be changed in admin without code edits":
//   * the homepage is an ORDERED list of typed blocks (add / reorder / edit /
//     hide / delete),
//   * the navigation and footer are rows in `cms_nav_items`,
//   * the announcement banner is a row in `announcements`,
//   * the FAQ is `cms_faqs`,
//   * the blog, FAQ, legal and informational pages are `cms_pages`,
//   * the site identity (name, tagline, contact, logo, legal entity) is
//     `site_settings`, which the brand boundary reads on every request.
//
// Every list here is one COUNT + one page query (no N+1), and every mutating
// form goes through the shared CSRF injection.

import { esc } from './layout'
import { adminPage } from './admin'
import { BLOCK_KINDS, type BlockKind } from './cms'

type Row = Record<string, any>

function notice(flash?: string, error?: string): string {
  return `${flash ? `<p class="a-notice ok">${esc(flash)}</p>` : ''}${error ? `<p class="a-notice error">${esc(error)}</p>` : ''}`
}

function pageHead(title: string, description: string): string {
  return `<p class="a-inline-note">${esc(description)}</p>`
}

// ---------------------------------------------------------------------------
// homepage blocks
// ---------------------------------------------------------------------------

export async function adminCmsHome(db: D1Database, opts: { flash?: string; error?: string; pagePath?: string } = {}): Promise<string> {
  const pagePath = opts.pagePath || '/'
  const blocks = (
    await db
      .prepare('SELECT * FROM cms_blocks WHERE page_path = ? ORDER BY sort_order, id')
      .bind(pagePath)
      .all<Row>()
  ).results || []
  const collections = (
    await db.prepare('SELECT slug, title, kind FROM collections ORDER BY sort_order, id').all<Row>()
  ).results || []

  const rows = blocks.map((b, i) => [
    String(b.sort_order),
    `<strong>${esc(b.key)}</strong><br><span class="a-inline-note">${esc(b.kind)}</span>`,
    esc(b.title) + (b.eyebrow ? `<br><span class="a-inline-note">${esc(b.eyebrow)}</span>` : ''),
    b.collection_slug ? esc(b.collection_slug) : b.data_key ? esc(b.data_key) : '—',
    Number(b.active) === 1 ? 'Live' : 'Hidden',
    `<a class="link" href="/admin/cms/blocks/${b.id}">Edit</a>
     · <form method="post" action="/admin/cms/blocks/${b.id}/move" style="display:inline">
         <input type="hidden" name="direction" value="up"><button type="submit" ${i === 0 ? 'disabled' : ''} aria-label="Move ${esc(b.key)} up">↑</button>
       </form>
     · <form method="post" action="/admin/cms/blocks/${b.id}/move" style="display:inline">
         <input type="hidden" name="direction" value="down"><button type="submit" ${i === blocks.length - 1 ? 'disabled' : ''} aria-label="Move ${esc(b.key)} down">↓</button>
       </form>
     · <form method="post" action="/admin/cms/blocks/${b.id}/delete" style="display:inline">
         <button type="submit" aria-label="Delete ${esc(b.key)}">Delete</button>
       </form>`
  ])

  const body = `
  ${notice(opts.flash, opts.error)}
  ${pageHead('Homepage', 'The homepage is rendered from this ordered list. Add, reorder, hide or edit a block and the storefront changes on the next request — no deploy, no code change.')}
  ${
    rows.length
      ? `<table class="a-table">
      <thead><tr><th scope="col">Order</th><th scope="col">Block</th><th scope="col">Heading</th><th scope="col">Source</th><th scope="col">State</th><th scope="col">Actions</th></tr></thead>
      <tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`
      : '<p class="a-empty" role="status">This page has no blocks yet. Add one below.</p>'
  }
  <h2>Add a block</h2>
  <form class="a-form-grid" method="post" action="/admin/cms/blocks">
    <label>Key (unique)<input name="key" required maxlength="80" placeholder="home.hero-2"></label>
    <label>Page path<input name="page_path" value="/" maxlength="120"></label>
    <label>Kind
      <select name="kind">${BLOCK_KINDS.map((k) => `<option value="${esc(k)}">${esc(k)}</option>`).join('')}</select>
    </label>
    <label>Eyebrow<input name="eyebrow" maxlength="120"></label>
    <label class="full">Title<input name="title" maxlength="200"></label>
    <label class="full">Subtitle / body<textarea name="subtitle" rows="3" maxlength="600"></textarea></label>
    <label>CTA label<input name="cta_label" maxlength="80"></label>
    <label>CTA link<input name="cta_href" maxlength="200" placeholder="/books"></label>
    <label>Image path<input name="image_path" maxlength="200" placeholder="/static/img/art/hero.svg"></label>
    <label>Image alt text<input name="image_alt" maxlength="200"></label>
    <label>Collection
      <select name="collection_slug"><option value="">— none —</option>${collections.map((c) => `<option value="${esc(c.slug)}">${esc(c.title)} (${esc(c.kind)})</option>`).join('')}</select>
    </label>
    <label>Group key (collection kind / age)<input name="data_key" maxlength="40"></label>
    <label>Max items<input name="max_items" type="number" min="0" max="24" value="4"></label>
    <label>Sort order<input name="sort_order" type="number" min="0" max="9999" value="999"></label>
    <label class="full"><input type="checkbox" name="active" value="1" checked> live</label>
    <button type="submit">Add block</button>
  </form>
  `
  return adminPage({ title: 'CMS — homepage', active: 'cms', body })
}

export async function getBlockForEdit(db: D1Database, id: number) {
  return db.prepare('SELECT * FROM cms_blocks WHERE id = ?').bind(id).first<Row>()
}

export async function adminCmsBlockEditor(db: D1Database, id: number, opts: { flash?: string; error?: string } = {}): Promise<string> {
  const b = await getBlockForEdit(db, id)
  if (!b) return adminPage({ title: 'Block not found', active: 'cms', body: '<p class="a-notice error">That block no longer exists.</p>' })
  const collections = (await db.prepare('SELECT slug, title, kind FROM collections ORDER BY sort_order, id').all<Row>()).results || []
  const body = `
  ${notice(opts.flash, opts.error)}
  <p><a class="link" href="/admin/cms">← Back to the homepage blocks</a></p>
  <form class="a-form-grid" method="post" action="/admin/cms/blocks/${id}">
    <label>Key<input name="key" value="${esc(b.key)}" required maxlength="80"></label>
    <label>Page path<input name="page_path" value="${esc(b.page_path)}" maxlength="120"></label>
    <label>Kind<select name="kind">${BLOCK_KINDS.map((k) => `<option value="${esc(k)}"${b.kind === k ? ' selected' : ''}>${esc(k)}</option>`).join('')}</select></label>
    <label>Eyebrow<input name="eyebrow" value="${esc(b.eyebrow)}" maxlength="120"></label>
    <label class="full">Title<input name="title" value="${esc(b.title)}" maxlength="200"></label>
    <label class="full">Subtitle<textarea name="subtitle" rows="3" maxlength="600">${esc(b.subtitle)}</textarea></label>
    <label class="full">Body (HTML allowed for rich-text blocks)<textarea name="body" rows="5">${esc(b.body)}</textarea></label>
    <label>CTA label<input name="cta_label" value="${esc(b.cta_label)}" maxlength="80"></label>
    <label>CTA link<input name="cta_href" value="${esc(b.cta_href)}" maxlength="200"></label>
    <label>Secondary CTA label<input name="secondary_cta_label" value="${esc(b.secondary_cta_label)}" maxlength="80"></label>
    <label>Secondary CTA link<input name="secondary_cta_href" value="${esc(b.secondary_cta_href)}" maxlength="200"></label>
    <label>Image path<input name="image_path" value="${esc(b.image_path)}" maxlength="200"></label>
    <label>Image alt text<input name="image_alt" value="${esc(b.image_alt)}" maxlength="200"></label>
    <label>Collection<select name="collection_slug"><option value="">— none —</option>${collections.map((c) => `<option value="${esc(c.slug)}"${b.collection_slug === c.slug ? ' selected' : ''}>${esc(c.title)} (${esc(c.kind)})</option>`).join('')}</select></label>
    <label>Group key<input name="data_key" value="${esc(b.data_key)}" maxlength="40"></label>
    <label>Max items<input name="max_items" type="number" min="0" max="24" value="${esc(String(b.max_items))}"></label>
    <label>Sort order<input name="sort_order" type="number" min="0" max="9999" value="${esc(String(b.sort_order))}"></label>
    <label class="full"><input type="checkbox" name="active" value="1"${Number(b.active) === 1 ? ' checked' : ''}> live</label>
    <button type="submit">Save block</button>
  </form>
  <p class="a-inline-note">A block that references a collection renders that collection's current members, so adding a product to the collection updates the homepage with no edit here.</p>
  `
  return adminPage({ title: `CMS block — ${b.key}`, active: 'cms', body })
}

// ---------------------------------------------------------------------------
// navigation + footer + announcement
// ---------------------------------------------------------------------------

export async function adminCmsNavigation(db: D1Database, opts: { flash?: string; error?: string } = {}): Promise<string> {
  const items = (
    await db
      .prepare('SELECT id, menu, column_key, column_title, label, href, sort_order, active FROM cms_nav_items ORDER BY menu, column_key, sort_order, id')
      .all<Row>()
  ).results || []
  const announcements = (await db.prepare('SELECT * FROM announcements ORDER BY sort_order, id').all<Row>()).results || []
  const menus = ['primary', 'mobile', 'footer'] as const

  const body = `
  ${notice(opts.flash, opts.error)}
  ${pageHead('Navigation & footer', 'These rows are the site navigation, the mobile drawer and the footer columns. The announcement banner is time-windowed, so a promotion can expire by itself.')}
  ${menus
    .map(
      (menu) => `
    <h2>${menu === 'primary' ? 'Primary navigation' : menu === 'mobile' ? 'Mobile menu' : 'Footer'}</h2>
    ${
      items.filter((i) => i.menu === menu).length
        ? `<table class="a-table"><thead><tr><th scope="col">Order</th><th scope="col">Column</th><th scope="col">Label</th><th scope="col">Link</th><th scope="col">State</th><th scope="col">Actions</th></tr></thead><tbody>
        ${items
          .filter((i) => i.menu === menu)
          .map(
            (i) => `<tr>
            <td>${esc(String(i.sort_order))}</td>
            <td>${esc(i.column_key || '—')}${i.column_title ? `<br><span class="a-inline-note">${esc(i.column_title)}</span>` : ''}</td>
            <td>${esc(i.label)}</td>
            <td><span class="a-inline-note">${esc(i.href)}</span></td>
            <td>${Number(i.active) === 1 ? 'Live' : 'Hidden'}</td>
            <td>
              <form method="post" action="/admin/cms/nav/${i.id}">
                <input type="text" name="label" value="${esc(i.label)}" maxlength="60" aria-label="Label">
                <input type="text" name="href" value="${esc(i.href)}" maxlength="200" aria-label="Link">
                <input type="number" name="sort_order" value="${esc(String(i.sort_order))}" min="0" max="9999" aria-label="Order">
                <label class="a-inline-note"><input type="checkbox" name="active" value="1"${Number(i.active) === 1 ? ' checked' : ''}> live</label>
                <button type="submit">Save</button>
              </form>
              <form method="post" action="/admin/cms/nav/${i.id}/delete"><button type="submit">Delete</button></form>
            </td>
          </tr>`
          )
          .join('')}
        </tbody></table>`
        : '<p class="a-empty" role="status">No entries in this menu yet.</p>'
    }
    <form class="a-filterbar" method="post" action="/admin/cms/nav">
      <input type="hidden" name="menu" value="${menu}">
      <label>Column key (footer only)<input name="column_key" maxlength="40"></label>
      <label>Column title<input name="column_title" maxlength="60"></label>
      <label>Label<input name="label" required maxlength="60"></label>
      <label>Link<input name="href" required maxlength="200" placeholder="/books"></label>
      <label>Order<input name="sort_order" type="number" min="0" max="9999" value="100"></label>
      <button type="submit">Add entry</button>
    </form>
  `
    )
    .join('')}
  <h2>Announcement banner</h2>
  ${
    announcements.length
      ? `<table class="a-table"><thead><tr><th scope="col">Message</th><th scope="col">Code</th><th scope="col">Link</th><th scope="col">Window</th><th scope="col">State</th><th scope="col">Actions</th></tr></thead><tbody>
        ${announcements
          .map(
            (a) => `<tr>
            <td>${esc(a.message)}</td>
            <td>${esc(a.code || '—')}</td>
            <td class="a-inline-note">${esc(a.href || '—')}</td>
            <td class="a-inline-note">${esc(a.starts_at || 'any')} → ${esc(a.ends_at || 'any')}</td>
            <td>${Number(a.active) === 1 ? 'Live' : 'Hidden'}</td>
            <td>
              <form method="post" action="/admin/cms/announcements/${a.id}">
                <input type="text" name="message" value="${esc(a.message)}" maxlength="160" aria-label="Message">
                <input type="text" name="code" value="${esc(a.code)}" maxlength="40" aria-label="Code">
                <input type="text" name="href" value="${esc(a.href)}" maxlength="200" aria-label="Link">
                <label class="a-inline-note">ends <input type="date" name="ends_at" value="${esc(String(a.ends_at || '').slice(0, 10))}"></label>
                <label class="a-inline-note"><input type="checkbox" name="active" value="1"${Number(a.active) === 1 ? ' checked' : ''}> live</label>
                <button type="submit">Save</button>
              </form>
              <form method="post" action="/admin/cms/announcements/${a.id}/delete"><button type="submit">Delete</button></form>
            </td>
          </tr>`
          )
          .join('')}
        </tbody></table>`
      : '<p class="a-empty" role="status">No announcement is configured, so no banner is rendered.</p>'
  }
  <form class="a-filterbar" method="post" action="/admin/cms/announcements">
    <label>Message<input name="message" required maxlength="160" placeholder="Save 20% on 2 or more storybooks with code"></label>
    <label>Code<input name="code" maxlength="40" placeholder="EXTRA20"></label>
    <label>Link<input name="href" maxlength="200" placeholder="/books"></label>
    <label>Ends<input type="date" name="ends_at"></label>
    <label>Order<input name="sort_order" type="number" min="0" max="9999" value="10"></label>
    <button type="submit">Add announcement</button>
  </form>
  <p class="a-inline-note">Only advertise a code that exists in Discounts — the server applies the discount it actually has.</p>
  `
  return adminPage({ title: 'CMS — navigation, footer & banner', active: 'cms', body })
}

// ---------------------------------------------------------------------------
// pages: blog / FAQ / legal / content
// ---------------------------------------------------------------------------

export const PAGE_KINDS = ['blog', 'faq', 'legal', 'shipping', 'refund', 'content'] as const

export async function adminCmsPages(
  db: D1Database,
  opts: { q?: string; kind?: string; status?: string; page?: number; perPage?: number; flash?: string; error?: string } = {}
): Promise<string> {
  const perPage = opts.perPage || 25
  const page = Math.max(1, opts.page || 1)
  const where: string[] = []
  const params: unknown[] = []
  if (opts.q) {
    where.push('(LOWER(title) LIKE ? OR LOWER(slug) LIKE ?)')
    const like = `%${opts.q.toLowerCase()}%`
    params.push(like, like)
  }
  if (opts.kind && (PAGE_KINDS as readonly string[]).includes(opts.kind)) {
    where.push('kind = ?')
    params.push(opts.kind)
  }
  if (opts.status) {
    where.push('status = ?')
    params.push(opts.status)
  }
  const clause = where.length ? 'WHERE ' + where.join(' AND ') : ''
  const total = Number((await db.prepare(`SELECT COUNT(*) AS n FROM cms_pages ${clause}`).bind(...params).first<Row>())?.n || 0)
  const pageCount = Math.max(1, Math.ceil(total / perPage))
  const current = Math.min(page, pageCount)
  const rows = (
    await db
      .prepare(`SELECT id, slug, kind, title, category, status, updated_at FROM cms_pages ${clause} ORDER BY kind, sort_order, id LIMIT ? OFFSET ?`)
      .bind(...params, perPage, (current - 1) * perPage)
      .all<Row>()
  ).results || []

  const body = `
  ${notice(opts.flash, opts.error)}
  ${pageHead('Pages & blog', 'The blog index, every article, the FAQ page and every legal or informational page are rows in this table. An unknown slug stays a real 404.')}
  <form class="a-filterbar" method="get" action="/admin/cms/pages">
    <label>Search<input name="q" type="search" value="${esc(opts.q || '')}"></label>
    <label>Kind<select name="kind"><option value="">All</option>${PAGE_KINDS.map((k) => `<option value="${k}"${opts.kind === k ? ' selected' : ''}>${k}</option>`).join('')}</select></label>
    <label>Status<select name="status"><option value="">All</option>${['draft', 'published', 'archived'].map((s) => `<option value="${s}"${opts.status === s ? ' selected' : ''}>${s}</option>`).join('')}</select></label>
    <button type="submit">Filter</button>
    <a class="link" href="/admin/cms/pages">Reset</a>
  </form>
  ${
    rows.length
      ? `<table class="a-table"><thead><tr><th scope="col">Kind</th><th scope="col">Title</th><th scope="col">Slug</th><th scope="col">Status</th><th scope="col">Updated</th><th scope="col">Actions</th></tr></thead><tbody>
      ${rows.map((r) => `<tr>
        <td>${esc(r.kind)}</td>
        <td>${esc(r.title)}${r.category ? `<br><span class="a-inline-note">${esc(r.category)}</span>` : ''}</td>
        <td class="a-inline-note">${esc(r.slug)}</td>
        <td>${esc(r.status)}</td>
        <td class="a-inline-note">${esc(String(r.updated_at || ''))}</td>
        <td><a class="link" href="/admin/cms/pages/${r.id}">Edit</a> · <a class="link" href="${r.kind === 'blog' ? '/blog/' : '/support/'}${esc(r.slug)}">View</a>
          <form method="post" action="/admin/cms/pages/${r.id}/delete"><button type="submit">Delete</button></form>
        </td>
      </tr>`).join('')}
      </tbody></table>`
      : '<p class="a-empty" role="status">No pages match these filters.</p>'
  }
  ${rows.length ? `<nav class="a-pager" aria-label="Pagination"><span class="a-inline-note">Page ${current} of ${pageCount} · ${total} row(s)</span></nav>` : ''}
  <h2>New page</h2>
  <form class="a-form-grid" method="post" action="/admin/cms/pages">
    <label>Slug<input name="slug" required maxlength="80" placeholder="my-new-article"></label>
    <label>Kind<select name="kind">${PAGE_KINDS.map((k) => `<option value="${k}">${k}</option>`).join('')}</select></label>
    <label class="full">Title<input name="title" required maxlength="200"></label>
    <label>Category (blog)<input name="category" maxlength="60"></label>
    <label>Image path<input name="image_path" maxlength="200"></label>
    <label>Image alt text<input name="image_alt" maxlength="200"></label>
    <label>Status<select name="status"><option value="draft">draft</option><option value="published">published</option></select></label>
    <label>Sort order<input name="sort_order" type="number" min="0" max="9999" value="50"></label>
    <label class="full">Excerpt<textarea name="excerpt" rows="2" maxlength="400"></textarea></label>
    <label class="full">Body (HTML)<textarea name="body" rows="10"></textarea></label>
    <button type="submit">Create page</button>
  </form>
  `
  return adminPage({ title: 'CMS — pages & blog', active: 'pages', body })
}

export async function adminCmsPageEditor(db: D1Database, id: number, opts: { flash?: string; error?: string } = {}): Promise<string> {
  const p = await db.prepare('SELECT * FROM cms_pages WHERE id = ?').bind(id).first<Row>()
  if (!p) return adminPage({ title: 'Page not found', active: 'pages', body: '<p class="a-notice error">That page no longer exists.</p>' })
  const body = `
  ${notice(opts.flash, opts.error)}
  <p><a class="link" href="/admin/cms/pages">← Back to pages</a></p>
  <form class="a-form-grid" method="post" action="/admin/cms/pages/${id}">
    <label>Slug<input name="slug" value="${esc(p.slug)}" required maxlength="80"></label>
    <label>Kind<select name="kind">${PAGE_KINDS.map((k) => `<option value="${k}"${p.kind === k ? ' selected' : ''}>${k}</option>`).join('')}</select></label>
    <label class="full">Title<input name="title" value="${esc(p.title)}" required maxlength="200"></label>
    <label>Category<input name="category" value="${esc(p.category)}" maxlength="60"></label>
    <label>Status<select name="status">${['draft', 'published', 'archived'].map((s) => `<option value="${s}"${p.status === s ? ' selected' : ''}>${s}</option>`).join('')}</select></label>
    <label>Image path<input name="image_path" value="${esc(p.image_path)}" maxlength="200"></label>
    <label>Image alt text<input name="image_alt" value="${esc(p.image_alt)}" maxlength="200"></label>
    <label>SEO title<input name="seo_title" value="${esc(p.seo_title)}" maxlength="200"></label>
    <label>Sort order<input name="sort_order" type="number" min="0" max="9999" value="${esc(String(p.sort_order))}"></label>
    <label class="full">SEO description<textarea name="seo_description" rows="2" maxlength="400">${esc(p.seo_description)}</textarea></label>
    <label class="full">Excerpt<textarea name="excerpt" rows="2" maxlength="400">${esc(p.excerpt)}</textarea></label>
    <label class="full">Body (HTML)<textarea name="body" rows="16">${esc(p.body)}</textarea></label>
    <button type="submit">Save page</button>
  </form>
  ${
    p.kind === 'legal' || p.kind === 'refund' || p.kind === 'shipping'
      ? `<p class="a-notice error">This is a LEGAL page. It renders with an explicit “Draft / not reviewed by a lawyer” banner. That banner stays until the owner replaces the text with counsel-reviewed, jurisdiction-aware copy (S-14) — do not remove the marking by publishing real customers into untested terms.</p>`
      : ''
  }
  `
  return adminPage({ title: `Page — ${p.title}`, active: 'pages', body })
}

// ---------------------------------------------------------------------------
// FAQ + brand settings
// ---------------------------------------------------------------------------

export async function adminCmsFaqs(db: D1Database, opts: { flash?: string; error?: string } = {}): Promise<string> {
  const faqs = (await db.prepare('SELECT * FROM cms_faqs ORDER BY group_key, sort_order, id').all<Row>()).results || []
  const body = `
  ${notice(opts.flash, opts.error)}
  ${pageHead('FAQ', 'These rows are the FAQ page and the homepage FAQ preview. Answers must describe what the build actually does — no shipping, payment, print or delivery promise exists in this version.')}
  ${
    faqs.length
      ? `<table class="a-table"><thead><tr><th scope="col">Group</th><th scope="col">Question</th><th scope="col">State</th><th scope="col">Actions</th></tr></thead><tbody>
      ${faqs
        .map(
          (f) => `<tr>
        <td>${esc(f.group_key)}</td>
        <td>${esc(f.question)}</td>
        <td>${Number(f.active) === 1 ? 'Live' : 'Hidden'}</td>
        <td>
          <form method="post" action="/admin/cms/faqs/${f.id}">
            <input type="text" name="group_key" value="${esc(f.group_key)}" maxlength="60" aria-label="Group">
            <input type="text" name="question" value="${esc(f.question)}" maxlength="200" aria-label="Question">
            <textarea name="answer" rows="3" aria-label="Answer">${esc(f.answer)}</textarea>
            <input type="number" name="sort_order" value="${esc(String(f.sort_order))}" min="0" max="9999" aria-label="Order">
            <label class="a-inline-note"><input type="checkbox" name="active" value="1"${Number(f.active) === 1 ? ' checked' : ''}> live</label>
            <button type="submit">Save</button>
          </form>
          <form method="post" action="/admin/cms/faqs/${f.id}/delete"><button type="submit">Delete</button></form>
        </td>
      </tr>`
        )
        .join('')}
      </tbody></table>`
      : '<p class="a-empty" role="status">The FAQ is empty.</p>'
  }
  <h2>Add an answer</h2>
  <form class="a-form-grid" method="post" action="/admin/cms/faqs">
    <label>Group<input name="group_key" required maxlength="60" value="Popular"></label>
    <label>Sort order<input name="sort_order" type="number" min="0" max="9999" value="100"></label>
    <label class="full">Question<input name="question" required maxlength="200"></label>
    <label class="full">Answer<textarea name="answer" required rows="4"></textarea></label>
    <button type="submit">Add answer</button>
  </form>
  `
  return adminPage({ title: 'CMS — FAQ', active: 'cms', body })
}

export async function adminCmsSettings(db: D1Database, opts: { flash?: string; error?: string } = {}): Promise<string> {
  const settings = (await db.prepare('SELECT key, value, kind FROM site_settings ORDER BY key').all<Row>()).results || []
  const body = `
  ${notice(opts.flash, opts.error)}
  ${pageHead('Brand & site settings', 'These values are read by the single brand boundary (src/brand.ts) on every request, so the site name, tagline, contact address, logo and legal entity can change here without a deploy and without editing a template.')}
  ${
    settings.length
      ? `<table class="a-table"><thead><tr><th scope="col">Key</th><th scope="col">Value</th><th scope="col">Type</th><th scope="col">Actions</th></tr></thead><tbody>
      ${settings
        .map(
          (s) => `<tr>
        <td><code>${esc(s.key)}</code></td>
        <td>${esc(s.value)}</td>
        <td>${esc(s.kind)}</td>
        <td>
          <form method="post" action="/admin/settings">
            <input type="hidden" name="key" value="${esc(s.key)}">
            <input type="text" name="value" value="${esc(s.value)}" maxlength="400" aria-label="Value for ${esc(s.key)}">
            <button type="submit">Save</button>
          </form>
        </td>
      </tr>`
        )
        .join('')}
      </tbody></table>`
      : '<p class="a-empty" role="status">No settings rows exist.</p>'
  }
  <h2>Add a setting</h2>
  <form class="a-filterbar" method="post" action="/admin/settings">
    <label>Key<input name="key" required maxlength="80" placeholder="brand.name"></label>
    <label>Value<input name="value" maxlength="400"></label>
    <label>Type<select name="kind"><option value="string">string</option><option value="url">url</option><option value="email">email</option><option value="number">number</option></select></label>
    <button type="submit">Add</button>
  </form>
  <p class="a-inline-note">An EMPTY value falls back to the deployment's environment configuration, so clearing a field never blanks the site name.</p>
  `
  return adminPage({ title: 'Brand & site settings', active: 'settings', body })
}

// ---------------------------------------------------------------------------
// collections
// ---------------------------------------------------------------------------

export async function adminCollections(db: D1Database, opts: { flash?: string; error?: string; page?: number } = {}): Promise<string> {
  const perPage = 25
  const page = Math.max(1, opts.page || 1)
  const total = Number((await db.prepare('SELECT COUNT(*) AS n FROM collections').first<Row>())?.n || 0)
  const pageCount = Math.max(1, Math.ceil(total / perPage))
  const current = Math.min(page, pageCount)
  const rows = (
    await db
      .prepare(
        `SELECT c.*, (SELECT COUNT(*) FROM collection_products cp WHERE cp.collection_id = c.id) AS product_count
           FROM collections c ORDER BY c.sort_order, c.id LIMIT ? OFFSET ?`
      )
      .bind(perPage, (current - 1) * perPage)
      .all<Row>()
  ).results || []
  const body = `
  ${notice(opts.flash, opts.error)}
  ${pageHead('Collections', 'A collection is a curated group the homepage sections, the catalog facets and the collection landing pages all read. Reordering the membership list changes the storefront immediately.')}
  ${
    rows.length
      ? `<table class="a-table"><thead><tr><th scope="col">Order</th><th scope="col">Title</th><th scope="col">Kind</th><th scope="col">Products</th><th scope="col">State</th><th scope="col">Actions</th></tr></thead><tbody>
      ${rows
        .map(
          (c) => `<tr>
        <td>${esc(String(c.sort_order))}</td>
        <td>${esc(c.title)}<br><span class="a-inline-note">${esc(c.slug)}</span></td>
        <td>${esc(c.kind)}</td>
        <td>${String(c.product_count)}</td>
        <td>${Number(c.active) === 1 ? 'Live' : 'Hidden'}</td>
        <td>
          <a class="link" href="/admin/collections/${c.id}">Edit & members</a>
          <form method="post" action="/admin/collections/${c.id}/delete"><button type="submit">Delete</button></form>
        </td>
      </tr>`
        )
        .join('')}
      </tbody></table>`
      : '<p class="a-empty" role="status">No collections yet.</p>'
  }
  <nav class="a-pager" aria-label="Pagination"><span class="a-inline-note">Page ${current} of ${pageCount} · ${total} row(s)</span></nav>
  <h2>New collection</h2>
  <form class="a-form-grid" method="post" action="/admin/collections">
    <label>Slug<input name="slug" required maxlength="80"></label>
    <label>Kind<select name="kind">${['audience', 'theme', 'age', 'career', 'sticker', 'editorial'].map((k) => `<option value="${k}">${k}</option>`).join('')}</select></label>
    <label class="full">Title<input name="title" required maxlength="120"></label>
    <label class="full">Subtitle<input name="subtitle" maxlength="200"></label>
    <label class="full">Description<textarea name="description" rows="3" maxlength="600"></textarea></label>
    <label>Hero image<input name="hero_image" maxlength="200" placeholder="/static/img/art/hero.svg"></label>
    <label>Hero alt text<input name="hero_alt" maxlength="200"></label>
    <label>Sort order<input name="sort_order" type="number" min="0" max="9999" value="100"></label>
    <button type="submit">Create collection</button>
  </form>
  `
  return adminPage({ title: 'Collections', active: 'collections', body })
}

export async function adminCollectionDetail(db: D1Database, id: number, opts: { flash?: string; error?: string } = {}): Promise<string> {
  const c = await db.prepare('SELECT * FROM collections WHERE id = ?').bind(id).first<Row>()
  if (!c) return adminPage({ title: 'Collection not found', active: 'collections', body: '<p class="a-notice error">That collection no longer exists.</p>' })
  const members = (
    await db
      .prepare(
        `SELECT cp.product_id, cp.sort_order, p.title, p.slug FROM collection_products cp JOIN products p ON p.id = cp.product_id
          WHERE cp.collection_id = ? ORDER BY cp.sort_order, p.id`
      )
      .bind(id)
      .all<Row>()
  ).results || []
  const available = (
    await db
      .prepare(
        `SELECT id, title, slug FROM products WHERE id NOT IN (SELECT product_id FROM collection_products WHERE collection_id = ?) ORDER BY title LIMIT 200`
      )
      .bind(id)
      .all<Row>()
  ).results || []
  const body = `
  ${notice(opts.flash, opts.error)}
  <p><a class="link" href="/admin/collections">← Back to collections</a></p>
  <form class="a-form-grid" method="post" action="/admin/collections/${id}">
    <label>Slug<input name="slug" value="${esc(c.slug)}" required maxlength="80"></label>
    <label>Kind<select name="kind">${['audience', 'theme', 'age', 'career', 'sticker', 'editorial'].map((k) => `<option value="${k}"${c.kind === k ? ' selected' : ''}>${k}</option>`).join('')}</select></label>
    <label class="full">Title<input name="title" value="${esc(c.title)}" required maxlength="120"></label>
    <label class="full">Subtitle<input name="subtitle" value="${esc(c.subtitle)}" maxlength="200"></label>
    <label class="full">Description<textarea name="description" rows="3" maxlength="600">${esc(c.description)}</textarea></label>
    <label>Hero image<input name="hero_image" value="${esc(c.hero_image)}" maxlength="200"></label>
    <label>Hero alt text<input name="hero_alt" value="${esc(c.hero_alt)}" maxlength="200"></label>
    <label>Catalog facet: audience<select name="facet_gender"><option value="">—</option>${['girl', 'boy', 'unisex'].map((g) => `<option value="${g}"${c.facet_gender === g ? ' selected' : ''}>${g}</option>`).join('')}</select></label>
    <label>Catalog facet: age min<input name="facet_age_min" type="number" min="0" max="18" value="${c.facet_age_min == null ? '' : esc(String(c.facet_age_min))}"></label>
    <label>Catalog facet: age max<input name="facet_age_max" type="number" min="0" max="18" value="${c.facet_age_max == null ? '' : esc(String(c.facet_age_max))}"></label>
    <label>Catalog facet: category<select name="facet_category"><option value="">—</option><option value="book"${c.facet_category === 'book' ? ' selected' : ''}>book</option><option value="sticker"${c.facet_category === 'sticker' ? ' selected' : ''}>sticker</option></select></label>
    <label>Sort order<input name="sort_order" type="number" min="0" max="9999" value="${esc(String(c.sort_order))}"></label>
    <label class="full"><input type="checkbox" name="active" value="1"${Number(c.active) === 1 ? ' checked' : ''}> live</label>
    <button type="submit">Save collection</button>
  </form>
  <h2>Members (${members.length})</h2>
  ${
    members.length
      ? `<table class="a-table"><thead><tr><th scope="col">Order</th><th scope="col">Product</th><th scope="col">Actions</th></tr></thead><tbody>
      ${members
        .map(
          (m) => `<tr>
        <td>${esc(String(m.sort_order))}</td>
        <td><a href="/admin/products/${m.product_id}">${esc(m.title)}</a> <span class="a-inline-note">${esc(m.slug)}</span></td>
        <td>
          <form method="post" action="/admin/collections/${id}/members">
            <input type="hidden" name="product_id" value="${esc(String(m.product_id))}">
            <input type="number" name="sort_order" value="${esc(String(m.sort_order))}" min="0" max="9999" aria-label="Order">
            <button type="submit">Reorder</button>
          </form>
          <form method="post" action="/admin/collections/${id}/members/remove">
            <input type="hidden" name="product_id" value="${esc(String(m.product_id))}">
            <button type="submit">Remove</button>
          </form>
        </td>
      </tr>`
        )
        .join('')}
      </tbody></table>`
      : '<p class="a-empty" role="status">This collection has no members yet.</p>'
  }
  <h2>Add a product</h2>
  <form class="a-filterbar" method="post" action="/admin/collections/${id}/members">
    <label>Product<select name="product_id">${available.map((p) => `<option value="${esc(String(p.id))}">${esc(p.title)}</option>`).join('')}</select></label>
    <label>Order<input type="number" name="sort_order" min="0" max="9999" value="100"></label>
    <button type="submit">Add to collection</button>
  </form>
  `
  return adminPage({ title: `Collection — ${c.title}`, active: 'collections', body })
}

// ---------------------------------------------------------------------------
// media library
// ---------------------------------------------------------------------------

export async function adminMedia(db: D1Database, opts: { q?: string; page?: number; flash?: string; error?: string } = {}): Promise<string> {
  const perPage = 25
  const page = Math.max(1, opts.page || 1)
  const where: string[] = []
  const params: unknown[] = []
  if (opts.q) {
    where.push('(LOWER(alt_text) LIKE ? OR LOWER(public_path) LIKE ?)')
    const like = `%${opts.q.toLowerCase()}%`
    params.push(like, like)
  }
  const clause = where.length ? 'WHERE ' + where.join(' AND ') : ''
  const total = Number((await db.prepare(`SELECT COUNT(*) AS n FROM media_assets ${clause}`).bind(...params).first<Row>())?.n || 0)
  const pageCount = Math.max(1, Math.ceil(total / perPage))
  const current = Math.min(page, pageCount)
  const rows = (
    await db
      .prepare(`SELECT * FROM media_assets ${clause} ORDER BY id DESC LIMIT ? OFFSET ?`)
      .bind(...params, perPage, (current - 1) * perPage)
      .all<Row>()
  ).results || []

  const body = `
  ${notice(opts.flash, opts.error)}
  ${pageHead('Media', 'Every asset carries alt text and a focal point, so a cropped card still frames its subject and an image can never be rendered without its description. Private (uploaded) assets are readable only through the app\u2019s ownership checks.')}
  <form class="a-filterbar" method="get" action="/admin/media">
    <label>Search<input name="q" type="search" value="${esc(opts.q || '')}"></label>
    <button type="submit">Filter</button>
    <a class="link" href="/admin/media">Reset</a>
  </form>
  ${
    rows.length
      ? `<table class="a-table"><thead><tr><th scope="col">Preview</th><th scope="col">Path / key</th><th scope="col">Alt text</th><th scope="col">Focal point</th><th scope="col">Source</th><th scope="col">Actions</th></tr></thead><tbody>
      ${rows
        .map(
          (m) => `<tr>
        <td>${m.is_private ? '<span class="a-inline-note">private</span>' : `<img class="a-media-preview" src="${esc(m.public_path)}" alt="${esc(m.alt_text)}" loading="lazy">`}</td>
        <td class="a-inline-note">${esc(m.is_private ? m.storage_key : m.public_path)}</td>
        <td>${m.alt_text ? esc(m.alt_text) : '<em class="a-inline-note">decorative</em>'}</td>
        <td class="a-inline-note">${esc(String(m.focal_x))} / ${esc(String(m.focal_y))}</td>
        <td>${esc(m.source)}</td>
        <td>
          <form method="post" action="/admin/media/${m.id}">
            <input type="text" name="alt_text" value="${esc(m.alt_text)}" maxlength="200" aria-label="Alt text">
            <input type="number" name="focal_x" value="${esc(String(m.focal_x))}" min="0" max="1" step="0.05" aria-label="Focal X">
            <input type="number" name="focal_y" value="${esc(String(m.focal_y))}" min="0" max="1" step="0.05" aria-label="Focal Y">
            <button type="submit">Save</button>
          </form>
        </td>
      </tr>`
        )
        .join('')}
      </tbody></table>`
      : '<p class="a-empty" role="status">No media rows match these filters.</p>'
  }
  <nav class="a-pager" aria-label="Pagination"><span class="a-inline-note">Page ${current} of ${pageCount} · ${total} row(s)</span></nav>
  <h2>Register a media asset</h2>
  <form class="a-form-grid" method="post" action="/admin/media">
    <label>Public path<input name="public_path" maxlength="200" placeholder="/static/img/art/hero.svg"></label>
    <label>Alt text (required for non-decorative)<input name="alt_text" maxlength="200"></label>
    <label>Focal X<input name="focal_x" type="number" min="0" max="1" step="0.05" value="0.5"></label>
    <label>Focal Y<input name="focal_y" type="number" min="0" max="1" step="0.05" value="0.5"></label>
    <button type="submit">Register</button>
  </form>
  `
  return adminPage({ title: 'Media', active: 'media', body })
}

// ---------------------------------------------------------------------------
// localization readiness
// ---------------------------------------------------------------------------

export async function adminLocalization(db: D1Database): Promise<string> {
  const langs = (await db.prepare('SELECT code, name, native_name, direction, fallback_code, active FROM languages ORDER BY code').all<Row>()).results || []
  const productLocs = (
    await db
      .prepare(
        `SELECT pl.language_code, pl.status, COUNT(*) AS n FROM product_localizations pl GROUP BY pl.language_code, pl.status`
      )
      .all<Row>()
  ).results || []
  const pageLocs = (
    await db.prepare('SELECT language_code, status, COUNT(*) AS n FROM cms_page_localizations GROUP BY language_code, status').all<Row>()
  ).results || []
  const publishedByLang = new Map<string, number>()
  for (const r of [...productLocs, ...pageLocs]) {
    if (r.status !== 'published') continue
    publishedByLang.set(String(r.language_code), (publishedByLang.get(String(r.language_code)) || 0) + Number(r.n))
  }

  const body = `
  ${pageHead('Localization', 'Languages the personalisation form offers, and the translations that actually exist. A language with no published row is reported as having no translated content — the storefront never presents an empty translation as complete, and hreflang alternates are only emitted for languages with published content.')}
  <table class="a-table"><thead><tr><th scope="col">Code</th><th scope="col">Name</th><th scope="col">Native</th><th scope="col">Direction</th><th scope="col">Fallback</th><th scope="col">Active</th><th scope="col">Published content rows</th></tr></thead><tbody>
  ${langs
    .map(
      (l) => `<tr>
      <td><code>${esc(l.code)}</code></td>
      <td>${esc(l.name)}</td>
      <td>${esc(l.native_name)}</td>
      <td>${esc(l.direction)}</td>
      <td>${esc(l.fallback_code || '—')}</td>
      <td>${Number(l.active) === 1 ? 'Yes' : 'No'}</td>
      <td>${publishedByLang.get(String(l.code)) || 0}</td>
    </tr>`
    )
    .join('')}
  </tbody></table>
  <h2>Storefront currencies</h2>
  <table class="a-table"><thead><tr><th scope="col">Currency</th><th scope="col">Symbol</th><th scope="col">Enabled</th><th scope="col">Order</th></tr></thead><tbody>
  ${(
    (await db.prepare('SELECT code, symbol, enabled, sort_order FROM currency_settings ORDER BY sort_order').all<Row>()).results || []
  )
    .map(
      (cur) => `<tr><td><code>${esc(cur.code)}</code></td><td>${esc(cur.symbol)}</td><td>${Number(cur.enabled) === 1 ? 'Yes' : 'No'}</td><td>${esc(String(cur.sort_order))}</td></tr>`
    )
    .join('')}
  </tbody></table>
  <h2>Countries</h2>
  <table class="a-table"><thead><tr><th scope="col">Code</th><th scope="col">Name</th><th scope="col">Currency</th><th scope="col">Active</th></tr></thead><tbody>
  ${((await db.prepare('SELECT code, name, currency, active FROM countries ORDER BY sort_order').all<Row>()).results || [])
    .map((x) => `<tr><td><code>${esc(x.code)}</code></td><td>${esc(x.name)}</td><td>${esc(x.currency)}</td><td>${Number(x.active) === 1 ? 'Yes' : 'No'}</td></tr>`)
    .join('')}
  </tbody></table>
  <p class="a-inline-note">Currency availability is a price-row question: a title appears in a currency only when it has a price for it, which you set on the product's Variants &amp; prices screen.</p>
  `
  return adminPage({ title: 'Localization', active: 'localization', body })
}

export { pageHead, notice }
export type { BlockKind }
