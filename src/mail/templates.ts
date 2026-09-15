// PLT-05 — versioned email templates.
//
// ONE definition per template, and it lives in the database (seeded by
// migration 0030), not in code. That is deliberate: a code-side "fallback
// wording" would be a second source of truth that could silently disagree with
// what an operator published, and an email is a commitment to a customer.
// A missing/retired template therefore fails loudly (template_missing) instead
// of sending an empty or improvised message.
//
// Rendering is a strict, non-recursive `{{variable}}` substitution:
//   * an unknown variable is an ERROR, not an empty string — a template that
//     references {{orderTotal}} must never be sent with the amount missing;
//   * body_html escapes every substituted value, because a customer's own
//     message/name flows into these bodies.
import { DomainError } from '../generation/types'

export type EmailTemplateRow = {
  id: number
  key: string
  version: number
  locale: string
  subject: string
  body_text: string
  body_html: string | null
  status: 'draft' | 'published' | 'retired'
  created_at: string
}

export type RenderedEmail = {
  key: string
  version: number
  locale: string
  subject: string
  bodyText: string
  bodyHtml: string | null
}

const PLACEHOLDER = /\{\{([a-zA-Z][a-zA-Z0-9_]*)\}\}/g

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

/**
 * Substitutes `variables` into `template`. Throws on ANY unresolved
 * placeholder so an incomplete message can never reach a customer.
 */
export function renderPlaceholders(template: string, variables: Record<string, string>, opts: { html?: boolean } = {}): string {
  const missing: string[] = []
  const rendered = template.replace(PLACEHOLDER, (_match, name: string) => {
    if (!(name in variables)) {
      missing.push(name)
      return ''
    }
    const value = String(variables[name] ?? '')
    return opts.html ? escapeHtml(value) : value
  })
  if (missing.length) {
    throw new DomainError('template_variables_missing', `Email template is missing value(s) for: ${[...new Set(missing)].sort().join(', ')}`, 500)
  }
  return rendered
}

/** The published template for (key, locale), or the (key, 'en') published row as the fallback locale. */
export async function loadEmailTemplate(db: D1Database, key: string, locale = 'en'): Promise<EmailTemplateRow | null> {
  const exact = await db
    .prepare("SELECT * FROM email_templates WHERE key = ? AND locale = ? AND status = 'published' ORDER BY version DESC LIMIT 1")
    .bind(key, locale)
    .first<EmailTemplateRow>()
  if (exact) return exact
  if (locale === 'en') return null
  return db
    .prepare("SELECT * FROM email_templates WHERE key = ? AND locale = 'en' AND status = 'published' ORDER BY version DESC LIMIT 1")
    .bind(key)
    .first<EmailTemplateRow>()
}

/**
 * Renders the published template for `key`. `renders: 'database'` is recorded
 * on the outbox row so the exact wording that was queued is inspectable later,
 * even after a newer version is published.
 */
export async function renderEmailTemplate(
  db: D1Database,
  key: string,
  variables: Record<string, string>,
  locale = 'en'
): Promise<RenderedEmail> {
  const row = await loadEmailTemplate(db, key, locale)
  if (!row) {
    throw new DomainError('template_missing', `No published email template is configured for "${key}" (locale "${locale}").`, 500)
  }
  return {
    key: row.key,
    version: row.version,
    locale: row.locale,
    subject: renderPlaceholders(row.subject, variables),
    bodyText: renderPlaceholders(row.body_text, variables),
    bodyHtml: row.body_html ? renderPlaceholders(row.body_html, variables, { html: true }) : null
  }
}

/** The template keys this application enqueues — used by tests/admin to assert coverage. */
export const EMAIL_TEMPLATE_KEYS = [
  'verify_email',
  'change_email',
  'password_reset',
  'security_alert',
  'order_confirmation',
  'order_paid',
  'generation_ready',
  'revision_ack',
  'download_ready',
  'guest_claim',
  'privacy_request',
  'support_reply'
] as const

export type EmailTemplateKey = (typeof EMAIL_TEMPLATE_KEYS)[number]
