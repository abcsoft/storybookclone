// ADM-08, ADM-09, ADM-10, ADM-11: the admin operational surfaces for the
// generation domain.
//
// Discipline shared with every earlier admin screen:
//   * a published version is IMMUTABLE and the UI offers only a clone-then-edit
//     path for it;
//   * every mutation re-validates server-side (the route layer owns that) and
//     writes one immutable audit event;
//   * nothing here displays a credential, a storage key, a prompt's private
//     substitution values, or a provider payload — costs, counts, statuses and
//     reason codes only.
import { esc } from '../layout'
import { adminPage } from '../admin'
import { PROMPT_KINDS, PROMPT_TOKENS } from './templates'

type Row = Record<string, any>

function pageHead(title: string, note: string): string {
  return `<header class="a-page-head"><h1>${esc(title)}</h1><p class="a-inline-note">${note}</p></header>`
}

function notice(kind: 'ok' | 'error', message?: string): string {
  if (!message) return ''
  return `<p class="a-notice ${kind === 'error' ? 'error' : 'ok'}">${esc(message)}</p>`
}

function badge(value: string): string {
  return `<span class="a-badge a-badge-${esc(value)}">${esc(value)}</span>`
}

// ---------------------------------------------------------------------------
// ADM-08: templates / scenes / placeholders / prompt versions + publish
// ---------------------------------------------------------------------------


/**
 * V2 Phase 6 (ADM-20): publishing and retiring a template, and publishing a
 * prompt version, are HIGH-RISK actions, so their forms must carry a single-use
 * confirmation. One is issued per row, because one confirmation authorises
 * exactly one action — a shared one would silently let only the first button work.
 */
/**
 * V2 Phase 6 (ADM-20): publishing or retiring a template, and publishing a prompt
 * version, are HIGH-RISK actions, so each of their forms must carry a single-use
 * confirmation. A ticket is issued per ACTION — one confirmation authorises exactly
 * one publish, so a page with several drafts issues several.
 */
function reauthFields(challenge: string | undefined): string {
  if (!challenge) return ''
  return (
    `<input type="hidden" name="reauth_challenge" value="${esc(challenge)}">` +
    `<input type="password" name="current_password" required autocomplete="current-password" aria-label="Your current password" placeholder="Your password">`
  )
}

export async function adminGenerationTemplates(db: D1Database, opts: {
  permissions: readonly string[]
  flash?: string
  error?: string
  productId?: number
  /** Issues a single-use confirmation for one concrete high-risk path. */
  reauthTicketForPath?: (path: string) => Promise<string | null>
}): Promise<string> {
  const rows = await db
    .prepare(
      `SELECT bt.*, p.slug AS product_slug, p.title AS product_title,
              (SELECT COUNT(*) FROM book_scenes bs WHERE bs.template_id = bt.id) AS scene_count,
              (SELECT COUNT(*) FROM template_prompt_versions tpv WHERE tpv.template_id = bt.id) AS prompt_bindings
       FROM book_templates bt JOIN products p ON p.id = bt.product_id
       ${opts.productId ? 'WHERE bt.product_id = ?' : ''}
       ORDER BY p.title, bt.language_code, bt.version DESC
       LIMIT 200`
    )
    .bind(...(opts.productId ? [opts.productId] : []))
    .all<Row>()

  const promptVersions = await db.prepare('SELECT * FROM prompt_versions ORDER BY prompt_key, version DESC').all<Row>()
  const published: Record<string, Row[]> = {}
  for (const prompt of promptVersions.results || []) {
    if (prompt.status !== 'published') continue
    published[prompt.kind] = [...(published[prompt.kind] || []), prompt]
  }

  // One confirmation per actionable high-risk form, issued up front so the
  // template below stays a pure render.
  const tickets = new Map<string, string>()
  if (opts.reauthTicketForPath) {
    const wanted: string[] = []
    for (const template of rows.results || []) {
      if (template.status === 'draft') wanted.push(`/admin/generation/templates/${template.id}/publish`)
      if (template.status === 'published') wanted.push(`/admin/generation/templates/${template.id}/retire`)
    }
    for (const prompt of promptVersions.results || []) {
      if (prompt.status === 'draft') wanted.push(`/admin/generation/prompts/${prompt.id}/publish`)
    }
    for (const path of wanted) {
      const ticket = await opts.reauthTicketForPath(path)
      if (ticket) tickets.set(path, ticket)
    }
  }

  const bodyHtml = `
  ${pageHead(
    'Generation templates',
    'A published template version is immutable: its scenes, placeholders, layout config and pinned prompt versions can never change. To change anything, clone it into a new draft version — edit the draft — then publish. Publishing retires the previous published version for the same product and language in one atomic step, so a product is never left without a template. Publishing and retiring are high-risk, so each asks for your current password.'
  )}
  ${notice('ok', opts.flash)}
  ${notice('error', opts.error)}
  <table class="a-table">
    <thead><tr><th scope="col">Product</th><th scope="col">Language</th><th scope="col">Version</th><th scope="col">Status</th><th scope="col">Scenes</th><th scope="col">Pinned prompts</th><th scope="col">Actions</th></tr></thead>
    <tbody>
    ${
      rows.results?.length
        ? rows.results
            .map(
              (t) => `<tr>
      <td><a href="/admin/products/${t.product_id}">${esc(t.product_title)}</a><br><span class="a-inline-note"><code>${esc(t.product_slug)}</code></span></td>
      <td><code>${esc(t.language_code)}</code></td>
      <td>v${esc(String(t.version))}</td>
      <td>${badge(t.status)}</td>
      <td>${esc(String(t.scene_count))}</td>
      <td>${esc(String(t.prompt_bindings))} / ${PROMPT_KINDS.length}</td>
      <td>
        <a class="link" href="/admin/generation/templates/${t.id}">Inspect</a>
        <form method="post" action="/admin/generation/templates/${t.id}/clone" style="display:inline">
          <button type="submit">Clone to draft</button>
        </form>
        ${
          t.status === 'draft'
            ? `<form method="post" action="/admin/generation/templates/${t.id}/publish" style="display:inline">${reauthFields(tickets.get(`/admin/generation/templates/${t.id}/publish`))}<button type="submit">Publish</button></form>`
            : ''
        }
        ${
          t.status === 'published'
            ? `<form method="post" action="/admin/generation/templates/${t.id}/retire" style="display:inline"><input type="text" name="reason" placeholder="Reason" maxlength="200" aria-label="Retirement reason">${reauthFields(tickets.get(`/admin/generation/templates/${t.id}/retire`))}<button type="submit">Retire</button></form>`
            : ''
        }
      </td>
    </tr>`
            )
            .join('')
        : `<tr><td colspan="7"><p class="a-empty" role="status">No template exists yet. A template is provisioned automatically the first time a product is generated (from the reviewed scaffold in migration 0025), or on demand from the product's Variants screen.</p></td></tr>`
    }
    </tbody>
  </table>

  <h2>Prompt versions</h2>
  <p class="a-inline-note">A prompt version pins the prompt text, the model and the parameters that produced a page. The <code>provider</code> column decides which adapter runs: <code>http</code> requires the matching <code>GENERATION_*_API_URL</code>/<code>_API_KEY</code> to be configured; <code>deterministic-fake</code> is refused outside an explicitly configured development environment. Tokens a prompt may use: ${Object.keys(PROMPT_TOKENS)
    .map((t) => `<code>{{${esc(t)}}}</code>`)
    .join(', ')}.</p>
  <table class="a-table">
    <thead><tr><th scope="col">Key</th><th scope="col">Kind</th><th scope="col">Version</th><th scope="col">Status</th><th scope="col">Provider</th><th scope="col">Model</th><th scope="col">Actions</th></tr></thead>
    <tbody>
    ${(promptVersions.results || [])
      .map(
        (p) => `<tr>
      <td><code>${esc(p.prompt_key)}</code></td>
      <td>${esc(p.kind)}</td>
      <td>v${esc(String(p.version))}</td>
      <td>${badge(p.status)}</td>
      <td><code>${esc(p.provider)}</code></td>
      <td><code>${esc(p.model)}</code></td>
      <td>
        <form method="post" action="/admin/generation/prompts/${p.id}/clone" style="display:inline"><button type="submit">Clone to draft</button></form>
        ${
          p.status === 'draft'
            ? `<form method="post" action="/admin/generation/prompts/${p.id}/publish" style="display:inline">${reauthFields(tickets.get(`/admin/generation/prompts/${p.id}/publish`))}<button type="submit">Publish</button></form>`
            : ''
        }
      </td>
    </tr>`
      )
      .join('')}
    </tbody>
  </table>
  <p class="a-inline-note">Published ${Object.entries(published)
    .map(([kind, list]) => `${esc(kind)}: v${esc(String(list[0].version))} (${esc(list[0].provider)})`)
    .join(' · ') || 'nothing'}</p>
  `
  return adminPage({ permissions: opts.permissions, title: 'Generation templates', active: 'templates', body: bodyHtml })
}

export async function adminGenerationTemplateDetail(db: D1Database, templateId: number, opts: { permissions: readonly string[]; flash?: string; error?: string }): Promise<string> {
  const template = await db
    .prepare('SELECT bt.*, p.title AS product_title, p.slug AS product_slug FROM book_templates bt JOIN products p ON p.id = bt.product_id WHERE bt.id = ?')
    .bind(templateId)
    .first<Row>()
  if (!template) return adminPage({ permissions: opts.permissions, title: 'Template not found', active: 'templates', body: '<p class="a-notice error">That template does not exist.</p>' })

  const scenes = await db.prepare('SELECT * FROM book_scenes WHERE template_id = ? ORDER BY sort_order, id').bind(templateId).all<Row>()
  const placeholders = await db
    .prepare('SELECT sp.*, bs.scene_key FROM scene_placeholders sp JOIN book_scenes bs ON bs.id = sp.scene_id WHERE bs.template_id = ? ORDER BY bs.sort_order, sp.id')
    .bind(templateId)
    .all<Row>()
  const bindings = await db
    .prepare('SELECT tpv.kind, pv.prompt_key, pv.version, pv.provider, pv.model, pv.id FROM template_prompt_versions tpv JOIN prompt_versions pv ON pv.id = tpv.prompt_version_id WHERE tpv.template_id = ?')
    .bind(templateId)
    .all<Row>()
  const publishedPrompts = await db.prepare("SELECT * FROM prompt_versions WHERE status = 'published' AND kind IN ('story_text','illustration','translation')").all<Row>()
  const isDraft = template.status === 'draft'

  const body = `
  ${pageHead(
    `Template v${esc(String(template.version))} — ${esc(template.product_title)}`,
    isDraft
      ? 'This is a DRAFT: scenes, placeholders and pinned prompts can still be edited. Publish it to make the version immutable and live.'
      : `This version is ${esc(template.status)} and therefore IMMUTABLE. Every field below is read-only; clone it into a new draft to make changes.`
  )}
  ${notice('ok', opts.flash)}
  ${notice('error', opts.error)}
  <p class="a-inline-note">Product <a href="/admin/products/${template.product_id}">${esc(template.product_title)}</a> · language <code>${esc(template.language_code)}</code> · status ${badge(template.status)} · ${esc(String(scenes.results?.length || 0))} scene(s)</p>

  <h2>Pinned prompt versions</h2>
  <table class="a-table"><thead><tr><th scope="col">Kind</th><th scope="col">Prompt</th><th scope="col">Provider</th><th scope="col">Model</th>${isDraft ? '<th scope="col">Change</th>' : ''}</tr></thead><tbody>
  ${
    bindings.results?.length
      ? bindings.results
          .map(
            (b) => `<tr><td>${esc(b.kind)}</td><td><code>${esc(b.prompt_key)}</code> v${esc(String(b.version))}</td><td><code>${esc(b.provider)}</code></td><td><code>${esc(b.model)}</code></td>${
              isDraft
                ? `<td><form method="post" action="/admin/generation/templates/${templateId}/bindings">
                     <input type="hidden" name="kind" value="${esc(b.kind)}">
                     <select name="promptVersionId" aria-label="Prompt version for ${esc(b.kind)}">
                       ${(publishedPrompts.results || [])
                         .filter((p) => p.kind === b.kind)
                         .map((p) => `<option value="${p.id}"${p.id === b.id ? ' selected' : ''}>${esc(p.prompt_key)} v${esc(String(p.version))} (${esc(p.provider)})</option>`)
                         .join('')}
                     </select>
                     <button type="submit">Pin</button>
                   </form></td>`
                : ''
            }</tr>`
          )
          .join('')
      : '<tr><td colspan="5"><p class="a-empty" role="status">No prompt versions are pinned yet. A template needs story_text and illustration prompts before it can be published.</p></td></tr>'
  }
  </tbody></table>

  <h2>Scenes</h2>
  <table class="a-table"><thead><tr><th scope="col">Order</th><th scope="col">Key</th><th scope="col">Kind</th><th scope="col">Subject</th><th scope="col">Canvas</th><th scope="col">Placeholders</th>${isDraft ? '<th scope="col">Edit</th>' : ''}</tr></thead><tbody>
  ${(scenes.results || [])
    .map((scene) => {
      let layout: Row = {}
      try {
        layout = JSON.parse(scene.layout_json)
      } catch {
        layout = {}
      }
      const output = layout.output || {}
      const own = (placeholders.results || []).filter((p) => p.scene_id === scene.id)
      return `<tr>
      <td>${esc(String(scene.sort_order))}</td>
      <td><code>${esc(scene.scene_key)}</code></td>
      <td>${esc(scene.kind)}</td>
      <td>${esc(String(layout.subject || '').slice(0, 90))}</td>
      <td>${esc(String(output.width || '?'))}×${esc(String(output.height || '?'))} @ ${esc(String(output.minPpi || '?'))} PPI min</td>
      <td>${
        own.length
          ? own
              .map((p) => `<code>${esc(p.placeholder_key)}</code> (${esc(p.type)}${p.required === 1 ? ', required' : ''})`)
              .join('<br>')
          : '<span class="a-inline-note">none</span>'
      }</td>
      ${
        isDraft
          ? `<td>
               <form method="post" action="/admin/generation/templates/${templateId}/scenes/${scene.id}">
                 <input type="number" name="sortOrder" value="${esc(String(scene.sort_order))}" min="0" max="999" aria-label="Scene order">
                 <input type="text" name="subject" value="${esc(String(layout.subject || ''))}" maxlength="300" aria-label="Scene subject">
                 <button type="submit">Save</button>
               </form>
             </td>`
          : ''
      }
    </tr>`
    })
    .join('')}
  </tbody></table>
  <p class="a-inline-note"><a class="link" href="/admin/generation/templates">← All templates</a> · <a class="link" href="/admin/generation/jobs">Generation jobs</a></p>
  `
  return adminPage({ permissions: opts.permissions, title: `Template v${template.version}`, active: 'templates', body })
}

// ---------------------------------------------------------------------------
// ADM-10: generation jobs / attempts / cost / manual review / retry / cancel
// ---------------------------------------------------------------------------

const JOB_FILTERS = ['all', 'active', 'queued', 'running', 'retry_wait', 'succeeded', 'failed_permanent', 'dead_letter', 'cancelled', 'superseded'] as const

export async function adminGenerationJobs(db: D1Database, opts: { permissions: readonly string[]; status?: string; flash?: string; error?: string }): Promise<string> {
  const status = (JOB_FILTERS as readonly string[]).includes(opts.status || '') ? (opts.status as string) : 'all'
  const where =
    status === 'all'
      ? ''
      : status === 'active'
        ? "WHERE j.status IN ('queued','leased','running','retry_wait')"
        : 'WHERE j.status = ?'
  const bind = status === 'all' || status === 'active' ? [] : [status]

  const rows = await db
    .prepare(
      `SELECT j.*, ub.public_id AS book_public_id, ub.state AS book_state, p.slug AS product_slug,
              (SELECT COUNT(*) FROM generation_tasks t WHERE t.job_id = j.id) AS task_count,
              (SELECT COUNT(*) FROM generation_tasks t WHERE t.job_id = j.id AND t.status = 'succeeded') AS task_done,
              (SELECT COALESCE(SUM(cost_minor), 0) FROM generation_usage_events u WHERE u.job_id = j.id) AS cost_minor,
              (SELECT COALESCE(SUM(quantity), 0) FROM generation_usage_events u WHERE u.job_id = j.id AND u.unit = 'illustration') AS images,
              (SELECT COALESCE(SUM(input_tokens + output_tokens), 0) FROM generation_usage_events u WHERE u.job_id = j.id) AS tokens
       FROM generation_jobs j
       JOIN user_books ub ON ub.id = j.user_book_id
       JOIN book_templates bt ON bt.id = j.template_id
       JOIN products p ON p.id = bt.product_id
       ${where}
       ORDER BY j.id DESC LIMIT 100`
    )
    .bind(...bind)
    .all<Row>()

  const deadLetters = await db.prepare('SELECT COUNT(*) AS n FROM generation_dead_letters WHERE resolved_at IS NULL').first<{ n: number }>()
  const stuck = await db
    .prepare("SELECT COUNT(*) AS n FROM generation_jobs WHERE status IN ('leased','running') AND lease_expires_at IS NOT NULL AND lease_expires_at < ?")
    .bind(Math.floor(Date.now() / 1000))
    .first<{ n: number }>()
  const totals = await db
    .prepare("SELECT COALESCE(SUM(cost_minor), 0) AS cost, COUNT(*) AS n FROM generation_usage_events WHERE created_at >= datetime('now', '-30 days')")
    .first<{ cost: number; n: number }>()

  const body = `
  ${pageHead(
    'Generation jobs',
    'Every job is a durable D1 row: the queue message is only a wake-up. Attempts, provider events (sanitized) and cost are append-only, so a replayed delivery cannot double-bill. A job whose consumer died is reclaimed by the lease sweep — the count below shows any lease that is currently overdue.'
  )}
  ${notice('ok', opts.flash)}
  ${notice('error', opts.error)}
  <p class="a-inline-note">
    Unresolved dead letters: <strong>${deadLetters?.n ?? 0}</strong> ·
    overdue leases right now: <strong>${stuck?.n ?? 0}</strong> ·
    spend last 30 days: <strong>${esc(String(totals?.cost ?? 0))}</strong> minor units over ${esc(String(totals?.n ?? 0))} usage events
  </p>
  <form class="a-filterbar" method="get" action="/admin/generation/jobs">
    <label>Status
      <select name="status">
        ${JOB_FILTERS.map((f) => `<option value="${f}"${f === status ? ' selected' : ''}>${f}</option>`).join('')}
      </select>
    </label>
    <button type="submit">Filter</button>
  </form>
  <form method="post" action="/admin/generation/dispatch" style="margin:0.75rem 0">
    <button type="submit">Run a dispatch sweep now</button>
    <span class="a-inline-note">Reclaims overdue leases, promotes due retries and runs every job that is ready. Audited.</span>
  </form>
  <table class="a-table">
    <thead><tr><th scope="col">Job</th><th scope="col">Book</th><th scope="col">Status</th><th scope="col">Scenes</th><th scope="col">Attempts</th><th scope="col">Cost</th><th scope="col">Tokens</th><th scope="col">Last error</th><th scope="col">Actions</th></tr></thead>
    <tbody>
    ${
      rows.results?.length
        ? rows.results
            .map(
              (j) => `<tr>
      <td><a href="/admin/generation/jobs/${j.id}"><code>${esc(j.public_id)}</code></a><br><span class="a-inline-note">${esc(String(j.created_at))}<br>rev ${esc(String(j.input_revision))}</span></td>
      <td><span class="a-inline-note">${esc(j.product_slug)}</span><br>${badge(j.book_state)}</td>
      <td>${badge(j.status)}${j.lease_expires_at ? `<br><span class="a-inline-note">lease → ${esc(String(j.lease_expires_at))}</span>` : ''}</td>
      <td>${esc(String(j.task_done))} / ${esc(String(j.task_count))}</td>
      <td>${esc(String(j.attempt_count))} / ${esc(String(j.max_attempts))}</td>
      <td>${esc(String(j.cost_minor))}</td>
      <td>${esc(String(j.tokens))}</td>
      <td>${j.last_error_code ? `<code>${esc(j.last_error_code)}</code><br><span class="a-inline-note">${esc(String(j.last_error_message || '').slice(0, 120))}</span>` : '<span class="a-inline-note">—</span>'}</td>
      <td>
        ${
          ['failed_permanent', 'dead_letter'].includes(j.status)
            ? `<form method="post" action="/admin/generation/jobs/${j.id}/retry" style="display:inline"><button type="submit">Retry</button></form>`
            : ''
        }
        ${
          ['queued', 'leased', 'running', 'retry_wait', 'failed_permanent', 'dead_letter'].includes(j.status)
            ? `<form method="post" action="/admin/generation/jobs/${j.id}/cancel" style="display:inline"><input type="text" name="reason" placeholder="Reason (required)" maxlength="200" aria-label="Cancellation reason"><button type="submit">Cancel</button></form>`
            : ''
        }
      </td>
    </tr>`
            )
            .join('')
        : '<tr><td colspan="9"><p class="a-empty" role="status">No generation job matches this filter.</p></td></tr>'
    }
    </tbody>
  </table>
  <p class="a-inline-note"><a class="link" href="/admin/generation/previews">Preview, revision and approval queues →</a></p>
  `
  return adminPage({ permissions: opts.permissions, title: 'Generation jobs', active: 'generation', body })
}

export async function adminGenerationJobDetail(db: D1Database, jobId: number, opts: { permissions: readonly string[]; flash?: string; error?: string }): Promise<string> {
  const job = await db
    .prepare('SELECT j.*, ub.public_id AS book_public_id, ub.state AS book_state FROM generation_jobs j JOIN user_books ub ON ub.id = j.user_book_id WHERE j.id = ?')
    .bind(jobId)
    .first<Row>()
  if (!job) return adminPage({ permissions: opts.permissions, title: 'Job not found', active: 'generation', body: '<p class="a-notice error">That job does not exist.</p>' })

  const tasks = await db.prepare('SELECT * FROM generation_tasks WHERE job_id = ? ORDER BY sort_order, id').bind(jobId).all<Row>()
  const attempts = await db.prepare('SELECT * FROM generation_attempts WHERE job_id = ? ORDER BY id DESC LIMIT 60').bind(jobId).all<Row>()
  const usage = await db
    .prepare('SELECT unit, provider, model, COUNT(*) AS n, SUM(quantity) AS qty, SUM(cost_minor) AS cost, SUM(input_tokens) AS in_tokens, SUM(output_tokens) AS out_tokens FROM generation_usage_events WHERE job_id = ? GROUP BY unit, provider, model')
    .bind(jobId)
    .all<Row>()
  const events = await db.prepare('SELECT * FROM provider_events WHERE job_id = ? ORDER BY id DESC LIMIT 40').bind(jobId).all<Row>()
  const deadLetters = await db.prepare('SELECT * FROM generation_dead_letters WHERE job_id = ?').bind(jobId).all<Row>()
  const assets = await db
    .prepare('SELECT asset_type, COUNT(*) AS n, SUM(byte_size) AS bytes, SUM(cost_minor) AS cost FROM generated_assets WHERE job_id = ? GROUP BY asset_type')
    .bind(jobId)
    .all<Row>()

  const body = `
  ${pageHead(`Job ${esc(job.public_id)}`, 'Attempts, sanitized provider events, per-unit usage and dead letters for this job. No storage key, prompt value or provider payload is shown here.')}
  ${notice('ok', opts.flash)}
  ${notice('error', opts.error)}
  <p class="a-inline-note">
    status ${badge(job.status)} · book <code>${esc(job.book_public_id)}</code> (${badge(job.book_state)}) · input revision ${esc(String(job.input_revision))} ·
    template ${esc(String(job.template_id))} · attempts ${esc(String(job.attempt_count))}/${esc(String(job.max_attempts))} ·
    attempt budget per task ${esc(String(job.max_attempts))} · correlation <code>${esc(job.correlation_id)}</code>
  </p>
  ${job.preview_version_id ? `<p class="a-inline-note">Published preview version id: <strong>${esc(String(job.preview_version_id))}</strong></p>` : ''}
  ${job.last_error_code ? `<p class="a-notice error"><code>${esc(job.last_error_code)}</code> — ${esc(String(job.last_error_message || ''))}</p>` : ''}

  <h2>Tasks</h2>
  <table class="a-table"><thead><tr><th scope="col">Order</th><th scope="col">Kind</th><th scope="col">Scene</th><th scope="col">Status</th><th scope="col">Attempts</th><th scope="col">Lease</th><th scope="col">Last error</th></tr></thead><tbody>
  ${(tasks.results || [])
    .map(
      (t) => `<tr>
    <td>${esc(String(t.sort_order))}</td><td>${esc(t.kind)}</td><td><code>${esc(t.scene_key || '—')}</code></td><td>${badge(t.status)}</td>
    <td>${esc(String(t.attempt_count))} / ${esc(String(t.max_attempts))}</td>
    <td><span class="a-inline-note">${t.lease_expires_at ? esc(String(t.lease_expires_at)) : '—'}</span></td>
    <td>${t.last_error_code ? `<code>${esc(t.last_error_code)}</code>` : '<span class="a-inline-note">—</span>'}</td>
  </tr>`
    )
    .join('')}
  </tbody></table>

  <h2>Cost and usage (integer minor units)</h2>
  <table class="a-table"><thead><tr><th scope="col">Unit</th><th scope="col">Provider</th><th scope="col">Model</th><th scope="col">Events</th><th scope="col">Quantity</th><th scope="col">Cost</th><th scope="col">In tokens</th><th scope="col">Out tokens</th></tr></thead><tbody>
  ${
    usage.results?.length
      ? usage.results
          .map(
            (u) => `<tr><td>${esc(u.unit)}</td><td><code>${esc(u.provider)}</code></td><td><code>${esc(u.model)}</code></td><td>${esc(String(u.n))}</td><td>${esc(String(u.qty))}</td><td>${esc(String(u.cost))}</td><td>${esc(String(u.in_tokens))}</td><td>${esc(String(u.out_tokens))}</td></tr>`
          )
          .join('')
      : '<tr><td colspan="8"><p class="a-empty" role="status">Nothing has been billed for this job.</p></td></tr>'
  }
  </tbody></table>

  <h2>Generated assets</h2>
  <table class="a-table"><thead><tr><th scope="col">Type</th><th scope="col">Rows</th><th scope="col">Bytes</th><th scope="col">Cost</th></tr></thead><tbody>
  ${
    assets.results?.length
      ? assets.results.map((a) => `<tr><td>${esc(a.asset_type)}</td><td>${esc(String(a.n))}</td><td>${esc(String(a.bytes ?? 0))}</td><td>${esc(String(a.cost ?? 0))}</td></tr>`).join('')
      : '<tr><td colspan="4"><p class="a-empty" role="status">No asset rows.</p></td></tr>'
  }
  </tbody></table>

  <h2>Attempts (append-only)</h2>
  <table class="a-table"><thead><tr><th scope="col">#</th><th scope="col">Task</th><th scope="col">Outcome</th><th scope="col">Provider</th><th scope="col">Model</th><th scope="col">Latency</th><th scope="col">Cost</th><th scope="col">Error</th><th scope="col">When</th></tr></thead><tbody>
  ${
    attempts.results?.length
      ? attempts.results
          .map(
            (a) => `<tr><td>${esc(String(a.id))}</td><td>${esc(String(a.task_id ?? '—'))}</td><td>${badge(a.outcome)}</td><td><code>${esc(a.provider || '—')}</code></td><td><code>${esc(a.model || '—')}</code></td><td>${esc(String(a.latency_ms ?? '—'))}ms</td><td>${esc(String(a.cost_minor))}</td><td>${a.error_code ? `<code>${esc(a.error_code)}</code><br><span class="a-inline-note">${esc(String(a.error_message || '').slice(0, 140))}</span>` : '—'}</td><td><span class="a-inline-note">${esc(String(a.created_at))}</span></td></tr>`
          )
          .join('')
      : '<tr><td colspan="9"><p class="a-empty" role="status">No attempts recorded yet.</p></td></tr>'
  }
  </tbody></table>

  <h2>Provider events (sanitized projection)</h2>
  <table class="a-table"><thead><tr><th scope="col">Type</th><th scope="col">Provider</th><th scope="col">Detail</th><th scope="col">When</th></tr></thead><tbody>
  ${
    events.results?.length
      ? events.results
          .map(
            (e) => `<tr><td><code>${esc(e.event_type)}</code></td><td><code>${esc(e.provider)}</code></td><td><code>${esc(String(e.detail_json).slice(0, 220))}</code></td><td><span class="a-inline-note">${esc(String(e.created_at))}</span></td></tr>`
          )
          .join('')
      : '<tr><td colspan="4"><p class="a-empty" role="status">No provider events.</p></td></tr>'
  }
  </tbody></table>

  ${
    deadLetters.results?.length
      ? `<h2>Dead letters</h2><table class="a-table"><thead><tr><th scope="col">Scope</th><th scope="col">Reason</th><th scope="col">Attempts</th><th scope="col">When</th><th scope="col">Resolution</th></tr></thead><tbody>
      ${deadLetters.results
        .map(
          (d) => `<tr><td>${esc(d.scope)}</td><td><code>${esc(d.reason_code)}</code><br><span class="a-inline-note">${esc(String(d.reason_message).slice(0, 160))}</span></td><td>${esc(String(d.attempts))}</td><td><span class="a-inline-note">${esc(String(d.dead_lettered_at))}</span></td><td>${d.resolved_at ? `${esc(String(d.resolution || 'resolved'))}<br><span class="a-inline-note">${esc(String(d.resolved_at))}</span>` : '<span class="a-badge a-badge-pending">unresolved</span>'}</td></tr>`
        )
        .join('')}
      </tbody></table>`
      : ''
  }

  <p class="a-inline-note"><a class="link" href="/admin/generation/jobs">← All jobs</a></p>
  `
  return adminPage({ permissions: opts.permissions, title: `Job ${job.public_id}`, active: 'generation', body })
}

// ---------------------------------------------------------------------------
// ADM-11: preview / revision / approval queues
// ---------------------------------------------------------------------------

export async function adminGenerationPreviews(db: D1Database, opts: { permissions: readonly string[]; status?: string; flash?: string; error?: string }): Promise<string> {
  const filter = ['all', 'awaiting_approval', 'approved', 'changes_requested'].includes(opts.status || '') ? (opts.status as string) : 'all'

  const previews = await db
    .prepare(
      `SELECT pv.*, ub.public_id AS book_public_id, ub.state AS book_state, ub.current_revision,
              (SELECT COUNT(*) FROM preview_assets pa WHERE pa.preview_version_id = pv.id) AS asset_count,
              (SELECT COUNT(*) FROM approvals a WHERE a.preview_version_id = pv.id AND a.decision = 'approved') AS approved_rows,
              (SELECT COUNT(*) FROM approvals a WHERE a.preview_version_id = pv.id AND a.decision = 'invalidated') AS invalidated_rows,
              (SELECT COUNT(*) FROM revision_requests rr WHERE rr.preview_version_id = pv.id) AS revision_requests
       FROM preview_versions pv JOIN user_books ub ON ub.id = pv.user_book_id
       ORDER BY pv.id DESC LIMIT 100`
    )
    .all<Row>()

  const revisionRequests = await db
    .prepare(
      `SELECT rr.*, ub.public_id AS book_public_id FROM revision_requests rr JOIN user_books ub ON ub.id = rr.user_book_id ORDER BY rr.id DESC LIMIT 60`
    )
    .all<Row>()

  const classify = (p: Row): string => {
    if (Number(p.approved_rows) > 0 && Number(p.invalidated_rows) === 0) return 'approved'
    if (Number(p.revision_requests) > 0) return 'changes_requested'
    return 'awaiting_approval'
  }
  const rows = (previews.results || []).filter((p) => filter === 'all' || classify(p) === filter)

  const body = `
  ${pageHead(
    'Preview, revision and approval queues',
    'A preview row is created once, already ready, at the moment a verified multi-scene watermarked preview genuinely exists — there is no fabricated pending preview. An approval is invalidated by inserting a new decision row, never by editing the old one, so the history is complete. An approval of a revision that is no longer current is refused outright.'
  )}
  ${notice('ok', opts.flash)}
  ${notice('error', opts.error)}
  <form class="a-filterbar" method="get" action="/admin/generation/previews">
    <label>Queue
      <select name="status">
        ${['all', 'awaiting_approval', 'approved', 'changes_requested'].map((f) => `<option value="${f}"${f === filter ? ' selected' : ''}>${f.replace(/_/g, ' ')}</option>`).join('')}
      </select>
    </label>
    <button type="submit">Filter</button>
  </form>
  <table class="a-table">
    <thead><tr><th scope="col">Preview</th><th scope="col">Book</th><th scope="col">Revision</th><th scope="col">Scenes</th><th scope="col">Assets</th><th scope="col">Watermark</th><th scope="col">Queue</th><th scope="col">Manifest</th></tr></thead>
    <tbody>
    ${
      rows.length
        ? rows
            .map(
              (p) => `<tr>
      <td>#${esc(String(p.id))}<br><span class="a-inline-note">${esc(String(p.finalized_at || p.created_at))}</span></td>
      <td><code>${esc(p.book_public_id)}</code><br>${badge(p.book_state)}</td>
      <td>${esc(String(p.input_revision))}${Number(p.input_revision) === Number(p.current_revision) ? ' <span class="a-inline-note">(current)</span>' : ' <span class="a-inline-note">(historical)</span>'}</td>
      <td>${esc(String(p.scene_count))}</td>
      <td>${esc(String(p.asset_count))}</td>
      <td><code>${esc(p.watermark_label || '—')}</code></td>
      <td>${badge(classify(p))}${Number(p.revision_requests) ? `<br><span class="a-inline-note">${esc(String(p.revision_requests))} revision request(s)</span>` : ''}</td>
      <td><code>${esc(String(p.manifest_checksum || '').slice(0, 16))}…</code></td>
    </tr>`
            )
            .join('')
        : `<tr><td colspan="8"><p class="a-empty" role="status">No preview matches this queue. A store with no generated previews shows an honest empty state — nothing is seeded.</p></td></tr>`
    }
    </tbody>
  </table>

  <h2>Revision requests</h2>
  <table class="a-table"><thead><tr><th scope="col">Book</th><th scope="col">Preview</th><th scope="col">Revision</th><th scope="col">Requested by</th><th scope="col">Note</th><th scope="col">When</th></tr></thead><tbody>
  ${
    revisionRequests.results?.length
      ? revisionRequests.results
          .map(
            (r) => `<tr><td><code>${esc(r.book_public_id)}</code></td><td>#${esc(String(r.preview_version_id))}</td><td>${esc(String(r.input_revision))}</td><td>${esc(r.requested_by_type)}:${esc(String(r.requested_by_id || '—').slice(0, 12))}</td><td>${esc(String(r.note).slice(0, 200))}</td><td><span class="a-inline-note">${esc(String(r.created_at))}</span></td></tr>`
          )
          .join('')
      : '<tr><td colspan="6"><p class="a-empty" role="status">No revision has been requested.</p></td></tr>'
  }
  </tbody></table>
  <p class="a-inline-note"><a class="link" href="/admin/generation/jobs">← Generation jobs</a> · <a class="link" href="/admin/localization">Language completeness →</a></p>
  `
  return adminPage({ permissions: opts.permissions, title: 'Previews &amp; approvals', active: 'previews', body })
}

/**
 * ADM-09: generation-template and prompt coverage per language. Rendered inside
 * the existing Localization screen so there is ONE place that answers "what is
 * actually translated".
 */
export async function generationLanguageCompleteness(db: D1Database): Promise<string> {
  const languages = await db.prepare('SELECT code, name, active FROM languages ORDER BY code').all<Row>()
  const templateRows = await db.prepare('SELECT language_code, status, COUNT(*) AS n FROM book_templates GROUP BY language_code, status').all<Row>()
  const promptRows = await db.prepare("SELECT kind, COUNT(*) AS n FROM prompt_versions WHERE status = 'published' GROUP BY kind").all<Row>()
  const productCount = await db.prepare('SELECT COUNT(*) AS n FROM products WHERE active = 1').first<{ n: number }>()
  const publishedByLang = new Map<string, number>()
  for (const row of templateRows.results || []) {
    if (row.status !== 'published') continue
    publishedByLang.set(String(row.language_code), (publishedByLang.get(String(row.language_code)) || 0) + Number(row.n))
  }
  const publishedPrompts = new Map((promptRows.results || []).map((r) => [String(r.kind), Number(r.n)]))

  return `
  <h2>Generation template coverage</h2>
  <p class="a-inline-note">A product can only be generated in a language that has a PUBLISHED template. ${esc(String(productCount?.n ?? 0))} active product(s); a language with 0 published versions is honestly reported as having none, and generation in it is refused with a clear message rather than silently falling back to another language.</p>
  <table class="a-table"><thead><tr><th scope="col">Language</th><th scope="col">Name</th><th scope="col">Active</th><th scope="col">Published template versions</th><th scope="col">Coverage</th></tr></thead><tbody>
  ${(languages.results || [])
    .map((l) => {
      const published = publishedByLang.get(String(l.code)) || 0
      const total = Number(productCount?.n ?? 0)
      const coverage = published === 0 ? 'none' : published >= total ? 'complete' : `${published} of ${total} product(s)`
      return `<tr><td><code>${esc(l.code)}</code></td><td>${esc(l.name)}</td><td>${Number(l.active) === 1 ? 'Yes' : 'No'}</td><td>${published}</td><td>${esc(coverage)}</td></tr>`
    })
    .join('')}
  </tbody></table>
  <p class="a-inline-note">Published prompt versions: ${PROMPT_KINDS.map((kind) => `${esc(kind)} ${publishedPrompts.get(kind) || 0}`).join(' · ')} — a template cannot be published unless <code>story_text</code> and <code>illustration</code> are both available.</p>
  `
}
