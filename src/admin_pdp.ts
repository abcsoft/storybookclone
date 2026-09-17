// Admin UI for editing the per-product PDP
// (banner, gallery, accordions, steps, photo tips, magic, trust, reactions, media, related, FAQs).
import { esc } from './layout'
import { brand } from './brand'
import { money } from './data'
import { loadPdp, ensurePdpPageRow } from './pdp'
import { queryProducts, type Product } from './db'

function adminPage(opts: { title: string; active: string; body: string; previewHref?: string }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(opts.title)} · ${esc(brand().name)} Admin</title>
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <link href="/static/admin.css" rel="stylesheet">
  <link href="/static/icons.css" rel="stylesheet">
  <link href="/static/storefront.css" rel="stylesheet">
  <link href="/static/admin-pdp.css" rel="stylesheet">
</head>
<body class="admin-pdp-edit">
  <header class="a-pdp-top">
    <a href="/admin/products" class="a-link">← Products</a>
    <h1>${esc(opts.title)}</h1>
    <a href="${esc(opts.previewHref || '/books')}" target="_blank" class="a-link">Preview ↗</a>
  </header>
  <main class="admin-main pdp-editor-main">${opts.body}</main>
</body>
</html>`
}

export async function adminPdpEditor(c: any, product: Product, flash?: string) {
  // product here always comes from a D1 row (toProduct()), which always
  // sets id — Product.id is optional only because the static catalog seed
  // (src/data.ts) has no DB id.
  await ensurePdpPageRow(c.env.DB, product.id!)
  const data = await loadPdp(c.env.DB, product)
  // Request-scoped: loaded here and threaded through explicitly. It is NEVER
  // stored on globalThis/module scope (C-07), so two concurrent admin requests
  // can never leak each other's product lists into a rendered page.
  const allProducts = (await queryProducts(c.env.DB, { includeInactive: true })).map((x) => ({
    id: x.id,
    title: x.title,
    image: x.image,
    slug: x.slug
  }))
  const previewHref = product.category === 'sticker' ? `/stickers/${product.slug}` : `/books/${product.slug}`
  const slugSafe = String(product.slug || '')

  const body = `
  <p class="muted">Editing PDP for <strong>${esc(product.title)}</strong> · <a href="${previewHref}" target="_blank">Open public page ↗</a></p>
  ${flash ? `<p class="a-notice ok">${esc(flash)}</p>` : ''}

  <nav class="pdp-tabs">
    <a class="active" data-tab="banner">Banner & Hero</a>
    <a data-tab="gallery">Gallery</a>
    <a data-tab="accordions">Hero accordions</a>
    <a data-tab="steps">Personalising steps</a>
    <a data-tab="tips">Photo tips</a>
    <a data-tab="magic">Magic slider</a>
    <a data-tab="trust">Why trust</a>
    <a data-tab="reactions">Reactions</a>
    <a data-tab="media">Media links</a>
    <a data-tab="related">Also like</a>
    <a data-tab="faqs">FAQs</a>
  </nav>

  ${tabBanner(product, data)}
  ${tabGallery(product, data)}
  ${tabAccordions(product, data)}
  ${tabSteps(product, data)}
  ${tabTips(product, data)}
  ${tabMagic(product, data)}
  ${tabTrust(product, data)}
  ${tabReactions(product, data)}
  ${tabMedia(product, data)}
  ${await tabRelated(product, data, allProducts)}
  ${tabFaqs(product, data)}

  <script>
    document.querySelectorAll('.pdp-tabs a').forEach(t => {
      t.onclick = e => {
        e.preventDefault()
        document.querySelectorAll('.pdp-tabs a').forEach(x => x.classList.remove('active'))
        t.classList.add('active')
        document.querySelectorAll('.pdp-tab').forEach(p => p.hidden = p.dataset.tab !== t.dataset.tab)
        history.replaceState(null, '', '#' + t.dataset.tab)
      }
    })
    const initial = (location.hash || '#banner').slice(1)
    const exists = document.querySelector('.pdp-tabs a[data-tab="' + initial + '"]')
    if (exists) exists.click()
  </script>
  `
  return c.html(adminPage({ title: `PDP · ${product.title}`, active: 'products', body, previewHref }))
}

function row(label: string, field: string, type = 'text', value = '', placeholder = '', extra = '') {
  return `<label>${label}<input name="${field}" type="${type}" value="${esc(String(value))}" placeholder="${esc(placeholder)}" ${extra}></label>`
}
function area(label: string, field: string, value = '', rows = 3) {
  return `<label>${label}<textarea name="${field}" rows="${rows}">${esc(String(value))}</textarea></label>`
}

// ---------- Banner ----------
function tabBanner(p: Product, d: any) {
  return `<section class="a-card pdp-tab" data-tab="banner">
    <h2>Banner & Hero</h2>
    <form class="a-form" method="post" action="/admin/products/${p.id}/pdp/banner">
      ${row('Banner text (kept on the row; no longer rendered — the offer is stated once, beside the call to action)', 'banner_text', 'text', d.page.banner_text, 'Order 2+ books and save 20% automatically')}
      ${row('Code shown (highlighted)', 'banner_code', 'text', d.page.banner_code, 'EXTRA20')}
      ${row('Save badge (next to price)', 'banner_badge', 'text', d.page.banner_badge, 'SAVE 40%')}
      ${area('Pre-order / below CTA note (optional)', 'preorder_note', d.page.preorder_note, 2)}
      <button class="a-btn" type="submit">Save banner</button>
    </form>
  </section>`
}

// ---------- Gallery ----------
function tabGallery(p: Product, d: any) {
  const rows = d.gallery.map((g: any) => `
    <form class="a-form a-row-form" method="post" action="/admin/products/${p.id}/pdp/gallery">
      <input type="hidden" name="id" value="${g.id}">
      ${row('Image URL', 'image_url', 'text', g.image_url, '/static/img/...')}
      ${row('Alt text', 'alt', 'text', g.alt)}
      ${row('Sort', 'sort_order', 'number', g.sort_order)}
      <label class="check"><input type="checkbox" name="active" ${g.active ? 'checked' : ''}> Active</label>
      <div class="a-form-actions">
        <button class="a-btn ghost" type="submit">Save</button>
    </form>
    <form class="a-inline-form" method="post" action="/admin/products/${p.id}/pdp/gallery/delete" onsubmit="return confirm('Delete this image?')">
      <input type="hidden" name="id" value="${g.id}">
      <button class="a-btn danger" type="submit">Delete</button>
    </form>
    </div>
  `).join('')
  return `<section class="a-card pdp-tab" data-tab="gallery" hidden>
    <h2>Hero gallery (thumbnails + main slider)</h2>
    <p class="muted">Drag/drop URLs. Use full URLs (https://…) or /static/img/… paths. Square 800×800+ recommended.</p>
    ${rows || '<p class="muted">No images yet.</p>'}
    <form class="a-form a-inline-form" method="post" action="/admin/products/${p.id}/pdp/gallery">
      <input type="hidden" name="id" value="">
      ${row('Image URL', 'image_url', 'text', '', '/static/img/...')}
      ${row('Alt text', 'alt', 'text', 'Hero image')}
      ${row('Sort', 'sort_order', 'number', (d.gallery.length || 0) + 1)}
      <label class="check"><input type="checkbox" name="active" checked> Active</label>
      <button class="a-btn" type="submit">Add image</button>
    </form>
  </section>`
}

// ---------- Accordions ----------
function tabAccordions(p: Product, d: any) {
  const rows = d.accordions.map((a: any) => `
    <form class="a-form a-row-form" method="post" action="/admin/products/${p.id}/pdp/accordion">
      <input type="hidden" name="id" value="${a.id}">
      ${row('Title', 'title', 'text', a.title)}
      ${area('Body', 'body', a.body, 3)}
      ${row('Sort', 'sort_order', 'number', a.sort_order)}
      <label class="check"><input type="checkbox" name="active" ${a.active ? 'checked' : ''}> Active</label>
      <div class="a-form-actions">
        <button class="a-btn ghost" type="submit">Save</button>
    </form>
    <form class="a-inline-form" method="post" action="/admin/products/${p.id}/pdp/accordion/delete" onsubmit="return confirm('Delete?')">
      <input type="hidden" name="id" value="${a.id}">
      <button class="a-btn danger" type="submit">Delete</button>
    </form>
    </div>
  `).join('')
  return `<section class="a-card pdp-tab" data-tab="accordions" hidden>
    <h2>Hero accordions (below price)</h2>
    <p class="muted">Common: "How is the book personalised…", "What if I need to make changes…", "Size & Quality".</p>
    ${rows || '<p class="muted">No accordions yet.</p>'}
    <form class="a-form a-inline-form" method="post" action="/admin/products/${p.id}/pdp/accordion">
      <input type="hidden" name="id" value="">
      ${row('Title', 'title', 'text', '')}
      ${area('Body', 'body', '', 3)}
      ${row('Sort', 'sort_order', 'number', (d.accordions.length || 0) + 1)}
      <label class="check"><input type="checkbox" name="active" checked> Active</label>
      <button class="a-btn" type="submit">Add accordion</button>
    </form>
  </section>`
}

// ---------- Steps ----------
function tabSteps(p: Product, d: any) {
  const taken = new Set(d.steps.map((s: any) => s.step_no))
  const slots = [1, 2, 3].map(n => {
    const s = d.steps.find((x: any) => x.step_no === n)
    return `<form class="a-form" method="post" action="/admin/products/${p.id}/pdp/step">
      ${row('Step #', 'step_no', 'number', s?.step_no ?? n, '', 'readonly')}
      ${row('Title', 'title', 'text', s?.title || '')}
      ${area('Body', 'body', s?.body || '', 2)}
      <button class="a-btn" type="submit">Save step ${n}</button>
    </form>`
  }).join('')
  return `<section class="a-card pdp-tab" data-tab="steps" hidden>
    <h2>"Start Personalising" — three numbered steps</h2>
    ${slots}
  </section>`
}

// ---------- Tips ----------
function tabTips(p: Product, d: any) {
  const rows = d.tips.map((t: any) => `
    <form class="a-form a-row-form" method="post" action="/admin/products/${p.id}/pdp/tip">
      <input type="hidden" name="id" value="${t.id}">
      <label>Kind<select name="kind"><option value="bad" ${t.kind === 'bad' ? 'selected' : ''}>Bad example</option><option value="good" ${t.kind === 'good' ? 'selected' : ''}>Good example</option></select></label>
      ${row('Label', 'label', 'text', t.label)}
      ${row('Image URL', 'image_url', 'text', t.image_url, '/static/img/tips/...')}
      ${row('Sort', 'sort_order', 'number', t.sort_order)}
      <div class="a-form-actions">
        <button class="a-btn ghost" type="submit">Save</button>
    </form>
    <form class="a-inline-form" method="post" action="/admin/products/${p.id}/pdp/tip/delete" onsubmit="return confirm('Delete?')">
      <input type="hidden" name="id" value="${t.id}">
      <button class="a-btn danger" type="submit">Delete</button>
    </form>
    </div>
  `).join('')
  return `<section class="a-card pdp-tab" data-tab="tips" hidden>
    <h2>Photo tips (TIPS card)</h2>
    <p class="muted">Bad examples on the left, good examples on the right of the tips card.</p>
    ${rows || '<p class="muted">No tips yet.</p>'}
    <form class="a-form a-inline-form" method="post" action="/admin/products/${p.id}/pdp/tip">
      <input type="hidden" name="id" value="">
      <label>Kind<select name="kind"><option value="bad">Bad example</option><option value="good">Good example</option></select></label>
      ${row('Label', 'label', 'text', '', 'Clear front face')}
      ${row('Image URL', 'image_url', 'text', '', '/static/img/tips/...')}
      ${row('Sort', 'sort_order', 'number', (d.tips.length || 0) + 1)}
      <button class="a-btn" type="submit">Add tip</button>
    </form>
  </section>`
}

// ---------- Magic ----------
function tabMagic(p: Product, d: any) {
  return `<section class="a-card pdp-tab" data-tab="magic" hidden>
    <h2>"See How a Simple Photo Becomes a Beautiful Story" slider</h2>
    <form class="a-form" method="post" action="/admin/products/${p.id}/pdp/magic">
      ${row('Heading', 'heading', 'text', d.magic.heading)}
      ${row('Left image URL', 'left_image', 'text', d.magic.left_image, '/static/img/art/magic-before.svg')}
      ${row('Left caption', 'left_caption', 'text', d.magic.left_caption, 'Your real photo')}
      ${row('Right image URL', 'right_image', 'text', d.magic.right_image, '/static/img/art/magic-after.svg')}
      ${row('Right caption', 'right_caption', 'text', d.magic.right_caption, 'Personalised version')}
      ${area('Below-slider paragraph', 'body', d.magic.body, 3)}
      <button class="a-btn" type="submit">Save magic block</button>
    </form>
  </section>`
}

// ---------- Trust ----------
function tabTrust(p: Product, d: any) {
  const ICON_OPTS = [
    ['sparkle', 'Sparkle'],
    ['globe',   'Globe'],
    ['shield',  'Shield']
  ]
  const makeIconSelect = (current: string) =>
    ICON_OPTS.map(([val, lab]) => `<option value="${val}" ${current === val ? 'selected' : ''}>${lab}</option>`).join('')
  const rows = d.trust.map((tr: any) => `
    <form class="a-form a-row-form" method="post" action="/admin/products/${p.id}/pdp/trust">
      <input type="hidden" name="id" value="${tr.id}">
      ${row('Title', 'title', 'text', tr.title)}
      ${area('Body', 'body', tr.body, 3)}
      <label>Icon<select name="icon">${makeIconSelect(tr.icon)}</select></label>
      ${row('Sort', 'sort_order', 'number', tr.sort_order)}
      <div class="a-form-actions">
        <button class="a-btn ghost" type="submit">Save</button>
    </form>
    <form class="a-inline-form" method="post" action="/admin/products/${p.id}/pdp/trust/delete" onsubmit="return confirm('Delete?')">
      <input type="hidden" name="id" value="${tr.id}">
      <button class="a-btn danger" type="submit">Delete</button>
    </form>
    </div>
  `).join('')

  return `<section class="a-card pdp-tab" data-tab="trust" hidden>
    <h2>"Why parents trust ${esc(brand().name)}" cards</h2>
    <p class="muted">Three cards on the dark purple band. Common patterns: Years of Experience / Happy Families / Personalisation Standards.</p>
    ${rows || '<p class="muted">No cards yet.</p>'}
    <form class="a-form a-inline-form" method="post" action="/admin/products/${p.id}/pdp/trust">
      <input type="hidden" name="id" value="">
      ${row('Title', 'title', 'text', '')}
      ${area('Body', 'body', '', 3)}
      <label>Icon<select name="icon"><option value="sparkle">Sparkle</option><option value="globe">Globe</option><option value="shield">Shield</option></select></label>
      ${row('Sort', 'sort_order', 'number', (d.trust.length || 0) + 1)}
      <button class="a-btn" type="submit">Add trust card</button>
    </form>
  </section>`
}

// ---------- Reactions ----------
function tabReactions(p: Product, d: any) {
  const rows = d.reactions.map((r: any) => `
    <form class="a-form a-row-form" method="post" action="/admin/products/${p.id}/pdp/reaction">
      <input type="hidden" name="id" value="${r.id}">
      ${row('Name', 'name', 'text', r.name)}
      ${row('Rating (1-5)', 'rating', 'number', r.rating, '5')}
      ${area('Review', 'review', r.review, 3)}
      ${row('Image URL', 'image_url', 'text', r.image_url, '/static/img/reviews/...')}
      ${row('Sort', 'sort_order', 'number', r.sort_order)}
      <label class="check"><input type="checkbox" name="active" ${r.active ? 'checked' : ''}> Active</label>
      <div class="a-form-actions">
        <button class="a-btn ghost" type="submit">Save</button>
    </form>
    <form class="a-inline-form" method="post" action="/admin/products/${p.id}/pdp/reaction/delete" onsubmit="return confirm('Delete?')">
      <input type="hidden" name="id" value="${r.id}">
      <button class="a-btn danger" type="submit">Delete</button>
    </form>
    </div>
  `).join('')
  return `<section class="a-card pdp-tab" data-tab="reactions" hidden>
    <h2>"Reactions You Can Count On" reviews</h2>
    ${rows || '<p class="muted">No reactions yet.</p>'}
    <form class="a-form a-inline-form" method="post" action="/admin/products/${p.id}/pdp/reaction">
      <input type="hidden" name="id" value="">
      ${row('Name', 'name', 'text', '')}
      ${row('Rating (1-5)', 'rating', 'number', '', '5')}
      ${area('Review', 'review', '', 3)}
      ${row('Image URL', 'image_url', 'text', '', '/static/img/reviews/...')}
      ${row('Sort', 'sort_order', 'number', (d.reactions.length || 0) + 1)}
      <label class="check"><input type="checkbox" name="active" checked> Active</label>
      <button class="a-btn" type="submit">Add reaction</button>
    </form>
  </section>`
}

// ---------- Media ----------
function tabMedia(p: Product, d: any) {
  const rows = d.media.map((m: any) => `
    <form class="a-form a-row-form" method="post" action="/admin/products/${p.id}/pdp/media">
      <input type="hidden" name="id" value="${m.id}">
      ${row('Name', 'name', 'text', m.name)}
      ${row('Logo URL (optional)', 'image_url', 'text', m.image_url, '/static/img/media/nbc.svg')}
      ${row('Link', 'href', 'text', m.href, '#')}
      ${row('Sort', 'sort_order', 'number', m.sort_order)}
      <div class="a-form-actions">
        <button class="a-btn ghost" type="submit">Save</button>
    </form>
    <form class="a-inline-form" method="post" action="/admin/products/${p.id}/pdp/media/delete" onsubmit="return confirm('Delete?')">
      <input type="hidden" name="id" value="${m.id}">
      <button class="a-btn danger" type="submit">Delete</button>
    </form>
    </div>
  `).join('')
  return `<section class="a-card pdp-tab" data-tab="media" hidden>
    <h2>Media links (owner-entered only)</h2>
    <p class="muted">If logo URL is empty, the name appears as text. Recommended images: grayscale SVG, ~140×40.</p>
    ${rows || '<p class="muted">No media yet.</p>'}
    <form class="a-form a-inline-form" method="post" action="/admin/products/${p.id}/pdp/media">
      <input type="hidden" name="id" value="">
      ${row('Name', 'name', 'text', '', 'NBC')}
      ${row('Logo URL', 'image_url', 'text', '', '/static/img/media/nbc.svg')}
      ${row('Link', 'href', 'text', '#')}
      ${row('Sort', 'sort_order', 'number', (d.media.length || 0) + 1)}
      <button class="a-btn" type="submit">Add media logo</button>
    </form>
  </section>`
}

// ---------- Related (also like) ----------
type RelatedProductOption = { id?: number; title: string; image: string; slug: string }

async function tabRelated(p: Product, d: any, allProducts: RelatedProductOption[]) {
  return `<section class="a-card pdp-tab" data-tab="related" hidden>
    <h2>"You may also like" — pick up to 8 products</h2>
    <p class="muted">Tick to include. Order is preserved from top to bottom.</p>
    ${await renderRelatedPicker(p, d, allProducts)}
  </section>`
}

async function renderRelatedPicker(p: Product, d: any, allProducts: RelatedProductOption[]) {
  // The option list is passed in explicitly by the caller (request-scoped) —
  // it is never read from a global, so a concurrent admin request cannot leak
  // its own product list into this page (C-06/C-07).
  const html = `<script>
    window.__pdpRelated = ${JSON.stringify(allProducts)}
    window.__relatedCurrent = ${JSON.stringify((d.related || []).map((r: any) => r.id))}
  </script>
  <div id="pdp-related-picker"></div>
  <form class="a-form" method="post" action="/admin/products/${p.id}/pdp/related" id="pdp-related-form">
    <input type="hidden" name="related_ids" id="pdp-related-input">
  </form>
  <script>
    (function() {
      const all = window.__pdpRelated || []
      const picked = (window.__relatedCurrent || []).slice()
      const wrap = document.getElementById('pdp-related-picker')
      const input = document.getElementById('pdp-related-input')
      const form = document.getElementById('pdp-related-form')
      function render() {
        wrap.innerHTML = '<div class="pdp-rel-list">' + all.map(p =>
          '<label class="pdp-rel-item"><input type="checkbox" value="' + p.id + '" ' + (picked.includes(p.id) ? 'checked' : '') + ' onchange="toggleRel(' + p.id + ')">'
          + '<img src="' + p.image + '" alt="">'
          + '<span>' + p.title.replace(/&/g,'&amp;').replace(/</g,'&lt;') + '</span></label>'
        ).join('') + '</div>'
        + '<button class="a-btn" type="button" onclick="saveRelated()">Save selection</button>'
      }
      window.toggleRel = function(id) {
        const i = picked.indexOf(id)
        if (i >= 0) picked.splice(i, 1)
        else if (picked.length < 8) picked.push(id)
        else { alert('Maximum 8 related products.'); return }
        render()
      }
      window.saveRelated = function() {
        input.value = picked.join(',')
        form.submit()
      }
      render()
    })()
  </script>`
  return html
}

// ---------- FAQs ----------
function tabFaqs(p: Product, d: any) {
  const rows = d.faqs.map((f: any) => `
    <form class="a-form a-row-form" method="post" action="/admin/products/${p.id}/pdp/faq">
      <input type="hidden" name="id" value="${f.id}">
      ${area('Question', 'question', f.question, 2)}
      ${area('Answer', 'answer', f.answer, 3)}
      ${row('Sort', 'sort_order', 'number', f.sort_order)}
      <label class="check"><input type="checkbox" name="active" ${f.active ? 'checked' : ''}> Active</label>
      <div class="a-form-actions">
        <button class="a-btn ghost" type="submit">Save</button>
    </form>
    <form class="a-inline-form" method="post" action="/admin/products/${p.id}/pdp/faq/delete" onsubmit="return confirm('Delete?')">
      <input type="hidden" name="id" value="${f.id}">
      <button class="a-btn danger" type="submit">Delete</button>
    </form>
    </div>
  `).join('')
  return `<section class="a-card pdp-tab" data-tab="faqs" hidden>
    <h2>Frequently Asked Questions</h2>
    <p class="muted">One FAQ per row. Drag/drop text directly. Used on the in-page FAQ section.</p>
    ${rows || '<p class="muted">No FAQs yet.</p>'}
    <form class="a-form a-inline-form" method="post" action="/admin/products/${p.id}/pdp/faq">
      <input type="hidden" name="id" value="">
      ${area('Question', 'question', '', 2)}
      ${area('Answer', 'answer', '', 3)}
      ${row('Sort', 'sort_order', 'number', (d.faqs.length || 0) + 1)}
      <label class="check"><input type="checkbox" name="active" checked> Active</label>
      <button class="a-btn" type="submit">Add FAQ</button>
    </form>
  </section>`
}
