// V2 Phase 5 — server-rendered customer account pages (CUS-01..CUS-14).
//
// SERVER-RENDERED ON PURPOSE. Every one of these pages works with JavaScript
// disabled, submits through an ordinary form POST (the CSRF token is injected
// into each form by the middleware in src/index.tsx), and states its outcome as
// text. That is what makes the flows reachable from an email link, testable by
// the accessibility pass, and honest when a client script fails to load.
//
// NOTHING HERE CLAIMS MORE THAN THE DATA SAYS. Where this deployment cannot do
// something (no email provider configured, no print-ready PDF, no automated
// privacy export), the page says so in plain language next to the thing that
// cannot be done.
import { esc } from '../layout'
import { brand } from '../brand'
import { statusLabel } from '../orders-status'
import { formatMinor, type CustomerOrderDetail, type TimelineEntry } from './orders'
import type { MyBookDetail, MyBookSummary, PreviewVersionView, RevisionRequestView } from './library'
import type { DownloadView } from './downloads'
import type { ProfileView, NotificationPreferences } from './profile'
import type { SecurityEventRow } from './security'
import type { SessionView } from './sessions'
import type { TicketDetail, TicketView } from './support'
import type { PrivacyRequestView } from './privacy'
import type { EligibleGuestOrder } from './claims'
import type { MailProviderStatus } from '../mail/provider'
import { REVISION_REASON_CODES, type RevisionPolicy } from './library'
import { SUPPORT_ATTACHMENT_ACCEPT, SUPPORT_ATTACHMENT_MAX_BYTES } from './attachments'

export type AccountNavKey = 'overview' | 'profile' | 'addresses' | 'security' | 'notifications' | 'support' | 'privacy' | 'claims' | 'downloads' | 'orders'

const ACCOUNT_LINKS: Array<{ key: AccountNavKey; href: string; label: string }> = [
  { key: 'overview', href: '/account', label: 'Overview' },
  { key: 'profile', href: '/account/profile', label: 'Profile' },
  { key: 'addresses', href: '/account/addresses', label: 'Addresses' },
  { key: 'security', href: '/account/security', label: 'Security' },
  { key: 'notifications', href: '/account/notifications', label: 'Notifications' },
  { key: 'orders', href: '/my-books', label: 'Orders' },
  { key: 'downloads', href: '/my/downloads', label: 'Downloads' },
  { key: 'support', href: '/account/support', label: 'Support' },
  { key: 'claims', href: '/account/claims', label: 'Guest orders' },
  { key: 'privacy', href: '/account/privacy', label: 'Privacy' }
]

/** Shared account sub-navigation. The current page is marked with aria-current, not with colour alone. */
export function accountNav(active: AccountNavKey): string {
  return `
  <nav class="acct-nav" aria-label="Account sections">
    <ul>
      ${ACCOUNT_LINKS.map((l) => `<li><a href="${l.href}"${l.key === active ? ' aria-current="page"' : ''}>${esc(l.label)}</a></li>`).join('')}
    </ul>
  </nav>`
}

export function accountHeader(title: string, intro: string, active: AccountNavKey): string {
  return `
  <section class="page-hero">
    <div class="wrap">
      <h1>${esc(title)}</h1>
      <p>${esc(intro)}</p>
    </div>
  </section>
  <section class="section">
    <div class="wrap">
      ${accountNav(active)}`
}

export function accountFooter(): string {
  return `
    </div>
  </section>`
}

function notice(message: string | undefined, kind: 'ok' | 'error' = 'ok'): string {
  if (!message) return ''
  return `<p class="notice ${kind === 'error' ? 'error' : 'ok'}" role="${kind === 'error' ? 'alert' : 'status'}">${esc(message)}</p>`
}

function d(term: string, value: string, extraClass = ''): string {
  return `<div class="acct-row${extraClass ? ` ${extraClass}` : ''}"><dt>${esc(term)}</dt><dd>${value}</dd></div>`
}

/** The truthful email-delivery line, rendered wherever an email is involved. */
export function emailDeliveryLine(status: MailProviderStatus): string {
  if (status.deliveryMode === 'live') return `Emails are sent by this deployment (${esc(status.detail)}).`
  if (status.deliveryMode === 'development-console') return `This is a development environment: emails are written to the server log and nothing is sent (${esc(status.detail)}).`
  return `This deployment cannot send email: ${esc(status.detail)}`
}

function verificationBadge(verified: boolean, verifiedAt: string | null): string {
  return verified
    ? `<span class="badge acct-badge-ok">Confirmed${verifiedAt ? ` on ${esc(String(verifiedAt).slice(0, 10))}` : ''}</span>`
    : `<span class="badge acct-badge-warn">Not confirmed</span>`
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

export type OverviewData = {
  profile: ProfileView
  orders: Array<{ id: number; status: string; totalLabel: string; itemCount: number; createdAt: string; paymentStatus: string }>
  books: MyBookSummary[]
  openTickets: number
  openPrivacy: number
  claims: number
  downloadsAvailable: number
  mailStatus: MailProviderStatus
  notice?: { message: string; isError: boolean }
}

export function accountOverviewPage(data: OverviewData): string {
  const { profile } = data
  return `
  ${accountHeader('Your account', 'Your details, orders, books and requests in one place.', 'overview')}
    ${notice(data.notice?.message, data.notice?.isError ? 'error' : 'ok')}
    <dl class="acct-grid">
      ${d('Name', esc(profile.name))}
      ${d('Email', `${esc(profile.email)} ${verificationBadge(profile.emailVerified, profile.emailVerifiedAt)}`)}
      ${d('Account created', esc(String(profile.createdAt).slice(0, 10)))}
      ${d('Account status', esc(statusLabel(profile.status)))}
    </dl>
    ${profile.emailVerified ? '' : `<p class="notice" role="status">Your email address is not confirmed yet. Some actions — like adding an order you placed as a guest — need a confirmed address. <a class="link" href="/account/profile">Confirm it from your profile</a>.</p>`}
    <h2>At a glance</h2>
    <dl class="acct-grid">
      ${d('Orders', `<a class="link" href="/my-books">${data.orders.length} order${data.orders.length === 1 ? '' : 's'}</a>`)}
      ${d('Books', `<a class="link" href="/my/books">${data.books.length} book${data.books.length === 1 ? '' : 's'}</a>`)}
      ${d('Downloads available', `<a class="link" href="/my/downloads">${data.downloadsAvailable}</a>`)}
      ${d('Open support requests', `<a class="link" href="/account/support">${data.openTickets}</a>`)}
      ${d('Privacy requests', `<a class="link" href="/account/privacy">${data.openPrivacy}</a>`)}
      ${d('Guest orders added', `<a class="link" href="/account/claims">${data.claims}</a>`)}
    </dl>
    <h2>Most recent order</h2>
    ${
      data.orders.length
        ? `<p><a class="link" href="/my-books/${data.orders[0].id}">Order #${data.orders[0].id}</a> · ${esc(statusLabel(data.orders[0].status))} · ${esc(data.orders[0].paymentStatus)} · ${esc(data.orders[0].totalLabel)}</p>`
        : `<p class="tiny muted">You have not placed an order yet.</p>`
    }
    <h2>Email</h2>
    <p class="tiny">${emailDeliveryLine(data.mailStatus)}</p>
  ${accountFooter()}`
}

// ---------------------------------------------------------------------------
// Profile (CUS-01, CUS-03)
// ---------------------------------------------------------------------------

export type ProfilePageData = {
  profile: ProfileView
  mailStatus: MailProviderStatus
  notice?: { message: string; isError: boolean }
}

export function accountProfilePage(data: ProfilePageData): string {
  const { profile } = data
  return `
  ${accountHeader('Profile', 'Your name and the email address on your account.', 'profile')}
    ${notice(data.notice?.message, data.notice?.isError ? 'error' : 'ok')}
    <h2>Your details</h2>
    <form class="form acct-form" method="post" action="/account/profile">
      <label for="name">Name</label>
      <input id="name" name="name" value="${esc(profile.name)}" maxlength="80" required autocomplete="name">
      <button class="btn btn-primary" type="submit">Save name</button>
    </form>

    <h2>Email address</h2>
    <dl class="acct-grid">
      ${d('Current address', `${esc(profile.email)} ${verificationBadge(profile.emailVerified, profile.emailVerifiedAt)}`)}
    </dl>
    <p class="tiny">${emailDeliveryLine(data.mailStatus)}</p>
    ${
      profile.emailVerified
        ? ''
        : `<form class="form acct-form" method="post" action="/account/verify-email">
      <p>Confirm your address so we can send you order and preview updates.</p>
      <button class="btn btn-outline" type="submit">Send the confirmation link again</button>
    </form>`
    }

    <h3>Change your email address</h3>
    <p class="tiny">We send a confirmation link to the NEW address. Your account keeps its current address until that link is opened and confirmed. The old address is told after a change happens.</p>
    <form class="form acct-form" method="post" action="/account/email">
      <label for="newEmail">New email address</label>
      <input id="newEmail" name="newEmail" type="email" required autocomplete="email">
      <label for="currentPassword">Your password</label>
      <input id="currentPassword" name="currentPassword" type="password" required autocomplete="current-password">
      <button class="btn btn-primary" type="submit">Send the confirmation link</button>
    </form>
  ${accountFooter()}`
}

// ---------------------------------------------------------------------------
// Addresses (CUS-03)
// ---------------------------------------------------------------------------

export type AddressView = {
  id: string
  label: string
  fullName: string
  line1: string
  line2: string
  city: string
  region: string
  postalCode: string
  country: string
  phone: string
  isDefaultShipping: boolean
  isDefaultBilling: boolean
}

export function accountAddressesPage(addresses: AddressView[], noticeData?: { message: string; isError: boolean }): string {
  return `
  ${accountHeader('Addresses', 'Save the addresses you ship to, so checkout is quicker.', 'addresses')}
    ${notice(noticeData?.message, noticeData?.isError ? 'error' : 'ok')}
    <h2>Saved addresses</h2>
    ${
      addresses.length
        ? `<ul class="acct-list">
      ${addresses
        .map(
          (a) => `<li>
        <p class="acct-list-title">${esc(a.label || a.fullName)}${a.isDefaultShipping ? ' <span class="badge">Default shipping</span>' : ''}</p>
        <p class="tiny muted">${esc(a.fullName)}<br>${esc(a.line1)}${a.line2 ? `<br>${esc(a.line2)}` : ''}<br>${esc(a.city)}${a.region ? `, ${esc(a.region)}` : ''} ${esc(a.postalCode)}<br>${esc(a.country)}${a.phone ? ` · ${esc(a.phone)}` : ''}</p>
        <div class="acct-actions">
          ${
            a.isDefaultShipping
              ? ''
              : `<form method="post" action="/account/addresses/${esc(a.id)}/default"><button class="btn btn-outline btn-sm" type="submit">Make default</button></form>`
          }
          <form method="post" action="/account/addresses/${esc(a.id)}/delete"><button class="btn btn-outline btn-sm" type="submit">Remove</button></form>
        </div>
      </li>`
        )
        .join('')}
    </ul>`
        : `<div class="state-box" role="status"><h3>No saved addresses yet</h3><p>Add one below and it will be offered at checkout.</p></div>`
    }

    <h2 id="add-address">Add an address</h2>
    <form class="form acct-form" method="post" action="/account/addresses">
      ${addressFields()}
      <label class="acct-check"><input type="checkbox" name="isDefaultShipping" value="1"> Use as my default shipping address</label>
      <button class="btn btn-primary" type="submit">Save address</button>
    </form>
  ${accountFooter()}`
}

function addressFields(prefix = ''): string {
  const id = (name: string) => `${prefix}${name}`
  return `
      <label for="${id('label')}">Label (optional)</label>
      <input id="${id('label')}" name="label" maxlength="40" autocomplete="off" placeholder="Home, work…">
      <label for="${id('fullName')}">Full name</label>
      <input id="${id('fullName')}" name="fullName" maxlength="120" required autocomplete="name">
      <label for="${id('line1')}">Address</label>
      <input id="${id('line1')}" name="line1" maxlength="200" required autocomplete="address-line1">
      <label for="${id('line2')}">Address line 2 (optional)</label>
      <input id="${id('line2')}" name="line2" maxlength="200" autocomplete="address-line2">
      <label for="${id('city')}">City</label>
      <input id="${id('city')}" name="city" maxlength="120" required autocomplete="address-level2">
      <label for="${id('region')}">Region / state (optional)</label>
      <input id="${id('region')}" name="region" maxlength="120" autocomplete="address-level1">
      <label for="${id('postalCode')}">Postal code</label>
      <input id="${id('postalCode')}" name="postalCode" maxlength="24" autocomplete="postal-code">
      <label for="${id('country')}">Country (two-letter code, e.g. US)</label>
      <input id="${id('country')}" name="country" maxlength="2" required autocomplete="country">
      <label for="${id('phone')}">Phone (optional)</label>
      <input id="${id('phone')}" name="phone" maxlength="40" autocomplete="tel">`
}

// ---------------------------------------------------------------------------
// Security (CUS-02)
// ---------------------------------------------------------------------------

export type SecurityPageData = {
  sessions: SessionView[]
  events: Array<SecurityEventRow & { label: { title: string; summary: string } }>
  notice?: { message: string; isError: boolean }
}

export function accountSecurityPage(data: SecurityPageData): string {
  return `
  ${accountHeader('Security', 'Where you are signed in, and what has happened on your account.', 'security')}
    ${notice(data.notice?.message, data.notice?.isError ? 'error' : 'ok')}
    <h2>Signed-in sessions</h2>
    <p class="tiny muted">"Last activity seen" is recorded when you visit this page. A session is shown by a device description and a network comparison, never by its credential.</p>
    <ul class="acct-list">
      ${data.sessions
        .map(
          (s) => `<li>
        <p class="acct-list-title">${esc(s.device)}${s.current ? ' <span class="badge acct-badge-ok">This session</span>' : ''}${s.sameNetworkAsCurrent ? ' <span class="badge">Same network as now</span>' : ''}</p>
        <p class="tiny muted">Signed in ${esc(String(s.createdAt).slice(0, 19))} · expires ${esc(String(s.expiresAt).slice(0, 10))}${s.lastSeenAt ? ` · last activity seen ${esc(String(s.lastSeenAt).slice(0, 19))}` : ''}</p>
        ${
          s.current
            ? ''
            : `<form method="post" action="/account/security/revoke"><input type="hidden" name="sessionId" value="${esc(s.id)}"><button class="btn btn-outline btn-sm" type="submit">Sign this session out</button></form>`
        }
      </li>`
        )
        .join('')}
    </ul>
    <form method="post" action="/account/security/revoke-others">
      <input type="hidden" name="confirm" value="1">
      <button class="btn btn-outline" type="submit">Sign out every other session</button>
    </form>

    <h2>Account activity</h2>
    ${
      data.events.length
        ? `<ul class="acct-timeline">
      ${data.events
        .map(
          (e) => `<li>
        <p class="acct-list-title">${esc(e.label.title)}</p>
        <p class="tiny">${esc(e.label.summary)}</p>
        <p class="tiny muted"><time datetime="${esc(String(e.created_at))}">${esc(String(e.created_at).slice(0, 19))}</time></p>
      </li>`
        )
        .join('')}
    </ul>`
        : `<p class="tiny muted">No account activity has been recorded yet.</p>`
    }
    <p class="tiny">Security notices for these events are always sent and cannot be switched off — see <a class="link" href="/account/notifications">notification settings</a>.</p>
  ${accountFooter()}`
}

// ---------------------------------------------------------------------------
// Notification preferences (CUS-13)
// ---------------------------------------------------------------------------

export function accountNotificationsPage(prefs: NotificationPreferences, mailStatus: MailProviderStatus, noticeData?: { message: string; isError: boolean }): string {
  const row = (name: string, label: string, checked: boolean, help: string, locked = false) => `
      <li>
        <label class="acct-check">
          <input type="checkbox" name="${name}" value="1"${checked ? ' checked' : ''}${locked ? ' disabled' : ''}>
          <span>${esc(label)}</span>
        </label>
        <p class="tiny muted">${esc(help)}</p>
        ${locked ? `<input type="hidden" name="${name}" value="1">` : ''}
      </li>`
  return `
  ${accountHeader('Notifications', 'Choose which updates we email you about.', 'notifications')}
    ${notice(noticeData?.message, noticeData?.isError ? 'error' : 'ok')}
    <p class="tiny">${emailDeliveryLine(mailStatus)}</p>
    <form class="form acct-form" method="post" action="/account/notifications">
      <ul class="acct-list acct-list-plain">
        ${row('orderUpdates', 'Order updates', prefs.orderUpdates, 'Receipts, payment confirmations and progress on the orders you place.')}
        ${row('generationUpdates', 'Preview and approval updates', prefs.generationUpdates, 'When a preview is ready, and when a change you asked for has been made.')}
        ${row('supportUpdates', 'Support replies', prefs.supportUpdates, 'When our team replies on a support request you opened.')}
        ${row('productNews', 'Product news and offers', prefs.productNews, 'Occasional news about new titles. Marketing only — off unless you turn it on.')}
        ${row('securityAlerts', 'Account security notices', true, 'Password changes, new sign-ins and email changes. These are account-safety messages and cannot be switched off.', true)}
      </ul>
      <button class="btn btn-primary" type="submit">Save notification settings</button>
    </form>
  ${accountFooter()}`
}

// ---------------------------------------------------------------------------
// Orders (CUS-05, CUS-06, CUS-10)
// ---------------------------------------------------------------------------

export function receiptPage(detail: CustomerOrderDetail): string {
  const { order, items, payments, refunds, addresses } = detail
  const shipping = addresses.find((a) => a.kind === 'shipping')
  return `
  <section class="page-hero">
    <div class="wrap">
      <h1>Receipt for order #${order.id}</h1>
      <p>${esc(brand().name)} · ${esc(String(order.created_at).slice(0, 19))}</p>
    </div>
  </section>
  <section class="section">
    <div class="wrap wrap-narrow">
      <p class="tiny"><a class="link" href="/my-books/${order.id}">← Back to the order</a></p>
      <h2>Summary</h2>
      <dl class="acct-grid">
        ${d('Order status', esc(statusLabel(order.status)))}
        ${d('Payment', esc(order.payment_status))}
        ${d('Paid', esc(order.capturedLabel))}
        ${d('Refunded', esc(order.refundedLabel))}
        ${d('Still paid', esc(formatMinor(order.outstandingMinor, order.currency)))}
        ${order.paid_at ? d('Paid at', esc(String(order.paid_at))) : ''}
      </dl>
      <h2>Items</h2>
      <ul class="acct-list">
        ${items
          .map(
            (it) => `<li>
          <p class="acct-list-title">${esc(it.title)}${it.childName ? ` — ${esc(it.childName)}` : ''}</p>
          <p class="tiny muted">${esc(String(it.qty))} × ${esc(formatMinor(it.unitPriceMinor, it.currency))}${it.variantCode ? ` · ${esc(statusLabel(it.variantCode))}` : ''}</p>
        </li>`
          )
          .join('')}
      </ul>
      <div class="cart-totals">
        <div class="cart-summary-row"><span>Subtotal</span><span>${esc(formatMinor(Number(order.subtotal_minor ?? 0), order.currency))}</span></div>
        ${Number(order.discount_minor ?? 0) ? `<div class="cart-summary-row"><span>Discount${order.discount_code ? ` (${esc(order.discount_code)})` : ''}</span><span>−${esc(formatMinor(Number(order.discount_minor ?? 0), order.currency))}</span></div>` : ''}
        <div class="cart-summary-row"><span>Shipping</span><span>${esc(formatMinor(Number(order.shipping_minor ?? 0), order.currency))}</span></div>
        ${Number(order.tax_minor ?? 0) ? `<div class="cart-summary-row"><span>Tax</span><span>${esc(formatMinor(Number(order.tax_minor ?? 0), order.currency))}</span></div>` : ''}
        <div class="cart-summary-row total-row"><span>Total</span><span>${esc(order.totalLabel)}</span></div>
      </div>
      <h2>Payments recorded</h2>
      ${
        payments.length
          ? `<ul class="acct-list">${payments.map((p) => `<li><p class="acct-list-title">${esc(p.statusLabel)}</p><p class="tiny muted">${esc(formatMinor(p.capturedMinor, p.currency))} captured of ${esc(formatMinor(p.amountMinor, p.currency))} · ${esc(p.provider)} · ${esc(String(p.createdAt).slice(0, 19))}</p></li>`).join('')}</ul>`
          : `<p class="tiny muted">No payment has been recorded for this order.</p>`
      }
      <h2>Refunds recorded</h2>
      ${
        refunds.length
          ? `<ul class="acct-list">${refunds.map((r) => `<li><p class="acct-list-title">${esc(formatMinor(r.amountMinor, r.currency))} · ${esc(statusLabel(r.status))}</p><p class="tiny muted">${esc(String(r.createdAt).slice(0, 19))}${r.reason ? ` · ${esc(r.reason)}` : ''}</p></li>`).join('')}</ul>`
          : `<p class="tiny muted">No refund has been recorded for this order.</p>`
      }
      ${shipping ? `<h2>Shipping to</h2><p class="tiny">${esc(shipping.fullName)}<br>${esc(shipping.line1)}${shipping.line2 ? `<br>${esc(shipping.line2)}` : ''}<br>${esc(shipping.city)}${shipping.region ? `, ${esc(shipping.region)}` : ''} ${esc(shipping.postalCode)}<br>${esc(shipping.country)}</p>` : ''}
      <p class="tiny muted">This receipt is a rendering of the payment records above. It is not a tax invoice.</p>
    </div>
  </section>`
}

export function orderTimelineList(timeline: TimelineEntry[]): string {
  if (!timeline.length) return `<p class="tiny muted">Nothing has been recorded on this order yet.</p>`
  return `<ul class="acct-timeline">
    ${timeline
      .map(
        (t) => `<li${t.production ? ' class="acct-timeline-production"' : ''}>
      <p class="acct-list-title">${esc(t.label)}</p>
      <p class="tiny muted"><time datetime="${esc(String(t.at))}">${esc(String(t.at).slice(0, 19))}</time> · recorded by ${esc(t.actorType)}${t.reason ? ` · ${esc(t.reason)}` : ''}</p>
    </li>`
      )
      .join('')}
  </ul>`
}

// ---------------------------------------------------------------------------
// Library: my books (CUS-05)
// ---------------------------------------------------------------------------

export function myBooksLibraryPage(books: MyBookSummary[], noticeData?: { message: string; isError: boolean }): string {
  return `
  ${accountHeader('My books', 'Every book you have started, and where it has got to.', 'overview')}
    ${notice(noticeData?.message, noticeData?.isError ? 'error' : 'ok')}
    ${
      books.length
        ? `<ul class="acct-list">
      ${books
        .map(
          (b) => `<li>
        <p class="acct-list-title">${esc(b.productTitle)}${b.childName ? ` — ${esc(b.childName)}` : ''}</p>
        <p class="tiny muted">${esc(b.stateLabel)} · version ${esc(String(b.currentRevision))} · updated ${esc(String(b.updatedAt).slice(0, 19))}</p>
        <p class="tiny muted">${b.previews.ready} preview version${b.previews.ready === 1 ? '' : 's'}${b.approval.approved ? ' · you approved this book' : ''}${b.retentionDeadline ? ` · kept until ${esc(String(b.retentionDeadline).slice(0, 10))}` : ''}</p>
        ${b.blockedReason ? `<p class="tiny">${esc(b.blockedReason)}</p>` : ''}
        <div class="acct-actions">
          <a class="btn btn-outline btn-sm" href="/my/previews/${esc(b.id)}">Open preview &amp; history</a>
          <a class="btn btn-outline btn-sm" href="/my/books/${esc(b.productSlug)}?userBookId=${esc(b.id)}">Edit details</a>
        </div>
      </li>`
        )
        .join('')}
    </ul>`
        : `<div class="state-box" role="status"><h3>No books yet</h3><p>Personalise a storybook and it will appear here, with its preview and history.</p><a class="btn btn-primary" href="/books">Browse storybooks</a></div>`
    }
  ${accountFooter()}`
}

// ---------------------------------------------------------------------------
// Preview reader + version history (CUS-07, CUS-08, CUS-09, GEN-09)
// ---------------------------------------------------------------------------

export function myPreviewPage(detail: MyBookDetail, policy: RevisionPolicy, noticeData?: { message: string; isError: boolean }): string {
  const { summary, versions, revisionRequests, events, approvalHistory, personalization, consent } = detail
  const active = versions.find((v) => v.approved) || null
  return `
  <section class="page-hero">
    <div class="wrap">
      <h1>Preview for ${esc(summary.productTitle)}</h1>
      <p>${esc(summary.stateLabel)} · version ${esc(String(summary.currentRevision))}${personalization ? ` · ${esc(personalization.childName)}${personalization.childAge !== null ? `, age ${esc(String(personalization.childAge))}` : ''}` : ''}</p>
    </div>
  </section>
  <section class="section">
    <div class="wrap">
      ${notice(noticeData?.message, noticeData?.isError ? 'error' : 'ok')}
      <p class="tiny"><a class="link" href="/my/books">← All my books</a></p>
      ${
        summary.blockedReason
          ? `<p class="notice error" role="alert">${esc(summary.blockedReason)}</p>`
          : ''
      }
      <dl class="acct-grid">
        ${d('Approval', active ? `<span class="badge acct-badge-ok">Version ${esc(String(active.version))} approved</span>` : '<span class="badge acct-badge-warn">Not approved</span>')}
        ${d('Preview versions', esc(String(versions.length)))}
        ${d('Change requests', esc(String(revisionRequests.length)))}
        ${consent.retentionDeadline ? d('Kept until', esc(String(consent.retentionDeadline).slice(0, 10))) : ''}
        ${consent.version ? d('Consent version', esc(consent.version)) : ''}
      </dl>

      <h2>Generation progress</h2>
      <p class="tiny muted" id="generation-live" data-user-book-id="${esc(summary.id)}" role="status" aria-live="polite">Current state: ${esc(summary.stateLabel)}.</p>
      ${
        summary.canGenerate
          ? `<form method="post" action="/my/books/${esc(summary.id)}/generate"><button class="btn btn-primary" type="submit">${summary.previews.ready ? 'Generate the preview again' : 'Generate the preview'}</button></form>`
          : ''
      }

      <h2>Preview versions</h2>
      ${
        versions.length
          ? versions
              .map(
                (v) => `<section class="acct-version" aria-labelledby="version-${v.previewVersionId}">
        <h3 id="version-${v.previewVersionId}">Version ${esc(String(v.version))}${v.isCurrentRevision ? ' (current)' : ''}${v.approved ? ' — approved' : ''}${v.approvalInvalidated ? ' — a later change invalidated this approval' : ''}</h3>
        <p class="tiny muted">${esc(String(v.sceneCount))} scene${v.sceneCount === 1 ? '' : 's'} · ${esc(String(v.pages.length))} page image${v.pages.length === 1 ? '' : 's'} · published ${esc(String(v.createdAt).slice(0, 19))}${v.watermarkLabel ? ` · watermark: ${esc(v.watermarkLabel)}` : ''}</p>
        ${
          v.pages.length
            ? `<ul class="acct-pages">
          ${v.pages
            .map(
              (p, i) => `<li><img src="${esc(p.url)}" alt="Preview page ${i + 1} of version ${esc(String(v.version))}" loading="lazy" width="${p.width ?? 600}" height="${p.height ?? 600}"><p class="tiny muted">Page ${i + 1} · checksum ${esc(p.checksum.slice(0, 10))}${p.watermarked ? ' · watermarked' : ''}</p></li>`
            )
            .join('')}
        </ul>`
            : `<p class="tiny muted">This version has no page images recorded.</p>`
        }
        ${
          v.canApprove && !v.approved
            ? `<form method="post" action="/my/books/${esc(summary.id)}/approve">
          <input type="hidden" name="previewVersionId" value="${esc(String(v.previewVersionId))}">
          <input type="hidden" name="previewVersion" value="${esc(String(v.version))}">
          <button class="btn btn-primary" type="submit">Approve version ${esc(String(v.version))} exactly</button>
        </form>
        <p class="tiny muted">Approving releases this exact version — version ${esc(String(v.version))}, input revision ${esc(String(v.inputRevision))} — for production. If you change anything afterwards, the approval is invalidated and a new version is generated.</p>`
            : ''
        }
      </section>`
              )
              .join('')
          : `<div class="state-box" role="status"><h3>No preview has been published yet</h3><p>Once generation finishes, the watermarked pages appear here with their version history.</p></div>`
      }

      <h2>Ask for a change</h2>
      ${
        summary.canRequestRevision
          ? `<form class="form acct-form" method="post" action="/my/books/${esc(summary.id)}/revision" enctype="multipart/form-data">
        <label for="reasonCode">What should change?</label>
        <select id="reasonCode" name="reasonCode" required>
          <option value="">Choose a reason…</option>
          ${REVISION_REASON_CODES.map((r) => `<option value="${esc(r.code)}">${esc(r.label)}</option>`).join('')}
        </select>
        <label for="notes">Tell us more</label>
        <textarea id="notes" name="notes" rows="4" minlength="${policy.minNotesLength}" maxlength="${policy.maxNotesLength}" required></textarea>
        <label for="replacementPhoto">Replacement photo (optional)</label>
        <input id="replacementPhoto" name="replacementPhoto" type="file" accept="image/jpeg,image/png">
        <p class="tiny">A replacement photo creates a NEW version of this book: your current version is kept unchanged in the history, and any approval you had given no longer applies. Photos must match the same policy as the original upload.</p>
        <button class="btn btn-primary" type="submit">Send change request</button>
      </form>
      <p class="tiny muted">Limits: at most ${esc(String(policy.maxRequestsPerRevision))} requests per version and ${esc(String(policy.maxRequestsPerBook))} per book.</p>`
          : `<p class="tiny muted">A change can be requested once a preview exists for this book.</p>`
      }

      <h2>Change requests</h2>
      ${
        revisionRequests.length
          ? `<ul class="acct-list">${revisionRequests.map((r: RevisionRequestView) => `<li><p class="acct-list-title">${esc(r.reasonLabel || r.reasonCode || 'Change requested')} · ${esc(statusLabel(r.status))}</p><p class="tiny muted">Version ${esc(String(r.previewVersion))} · ${esc(String(r.createdAt).slice(0, 19))}${r.hasReplacementPhoto ? ' · replacement photo supplied' : ''}</p><p class="tiny">${esc(r.note)}</p></li>`).join('')}</ul>`
          : `<p class="tiny muted">You have not asked for a change yet.</p>`
      }

      <h2>History</h2>
      <ul class="acct-timeline">
        ${events
          .map((e) => `<li><p class="acct-list-title">${esc(e.label)}</p><p class="tiny muted"><time datetime="${esc(String(e.at))}">${esc(String(e.at).slice(0, 19))}</time> · ${esc(e.actorType)}</p></li>`)
          .join('')}
      </ul>
      ${
        approvalHistory.length
          ? `<h3>Approval decisions</h3><ul class="acct-list">${approvalHistory.map((a) => `<li><p class="acct-list-title">${esc(statusLabel(a.decision))} — version ${esc(String(a.inputRevision))}</p><p class="tiny muted">${esc(String(a.at).slice(0, 19))} · decided by ${esc(a.decidedBy)}</p></li>`).join('')}</ul>`
          : ''
      }
    </div>
  </section>`
}

// ---------------------------------------------------------------------------
// Downloads (CUS-11)
// ---------------------------------------------------------------------------

export function myDownloadsPage(downloads: DownloadView[], noticeData?: { message: string; isError: boolean }): string {
  return `
  ${accountHeader('Downloads', 'Your entitled downloads for paid orders.', 'downloads')}
    ${notice(noticeData?.message, noticeData?.isError ? 'error' : 'ok')}
    <p class="tiny muted">Each download starts with a short-lived, single-use link that is created only when you press the button. There is no permanent link to save or share, and every download is recorded against your order.</p>
    ${
      downloads.length
        ? `<ul class="acct-list">
      ${downloads
        .map(
          (dl) => `<li>
        <p class="acct-list-title">${esc(dl.itemTitle)} — ${esc(dl.kindLabel)}</p>
        <p class="tiny muted">Order #${esc(String(dl.orderId))} · ${esc(dl.stateLabel)} · ${esc(String(dl.downloadCount))} of ${esc(String(dl.maxDownloads))} downloads used · expires ${esc(String(dl.expiresAt).slice(0, 10))}${dl.previewVersion !== null ? ` · preview version ${esc(String(dl.previewVersion))}` : ''}</p>
        ${dl.downloadable ? '' : `<p class="tiny">${esc(dl.reason)}</p>`}
        ${
          dl.downloadable
            ? `<form method="post" action="/my/downloads/${esc(dl.id)}"><button class="btn btn-primary btn-sm" type="submit">Download</button></form>`
            : ''
        }
      </li>`
        )
        .join('')}
    </ul>`
        : `<div class="state-box" role="status"><h3>No downloads yet</h3><p>Downloads become available for an order item once its payment has been recorded and its preview has been generated.</p></div>`
    }
  ${accountFooter()}`
}

// ---------------------------------------------------------------------------
// Support (CUS-12)
// ---------------------------------------------------------------------------

export function supportListPage(tickets: TicketView[], noticeData?: { message: string; isError: boolean }, orders: Array<{ id: number }> = []): string {
  return `
  ${accountHeader('Support', 'Ask us about an order, a book, a download or your account.', 'support')}
    ${notice(noticeData?.message, noticeData?.isError ? 'error' : 'ok')}
    <h2>Your requests</h2>
    ${
      tickets.length
        ? `<ul class="acct-list">
      ${tickets
        .map(
          (t) => `<li>
        <p class="acct-list-title"><a class="link" href="/account/support/${esc(t.id)}">${esc(t.subject)}</a></p>
        <p class="tiny muted">${esc(t.statusLabel)} · ${esc(t.categoryLabel)}${t.orderId ? ` · order #${esc(String(t.orderId))}` : ''} · ${esc(String(t.createdAt).slice(0, 19))}</p>
        <p class="tiny">${esc(t.expectation)}</p>
      </li>`
        )
        .join('')}
    </ul>`
        : `<div class="state-box" role="status"><h3>No support requests yet</h3><p>Open one below and we will keep the whole conversation here.</p></div>`
    }

    <h2 id="new-request">Open a request</h2>
    <form class="form acct-form" method="post" action="/account/support" enctype="multipart/form-data">
      <label for="subject">Subject</label>
      <input id="subject" name="subject" maxlength="140" required>
      <label for="category">What is it about?</label>
      <select id="category" name="category" required>
        <option value="order">An order</option>
        <option value="personalization">My book's personalization</option>
        <option value="download">A download</option>
        <option value="payment">A payment or refund</option>
        <option value="account">My account</option>
        <option value="other">Something else</option>
      </select>
      ${
        orders.length
          ? `<label for="orderId">Related order (optional)</label>
      <select id="orderId" name="orderId">
        <option value="">Not about a specific order</option>
        ${orders.map((o) => `<option value="${esc(String(o.id))}">Order #${esc(String(o.id))}</option>`).join('')}
      </select>`
          : ''
      }
      <label for="body">Message</label>
      <textarea id="body" name="body" rows="6" minlength="10" maxlength="4000" required></textarea>
      <label for="attachment">Attachment (optional)</label>
      <input id="attachment" name="attachment" type="file" accept="${esc(SUPPORT_ATTACHMENT_ACCEPT)}">
      <p class="tiny">Up to ${esc(String(Math.round(SUPPORT_ATTACHMENT_MAX_BYTES / (1024 * 1024))))}MB. Accepted: ${esc(SUPPORT_ATTACHMENT_ACCEPT)}. The file's own contents must match its type, and it is stored privately — never as a public link.</p>
      <button class="btn btn-primary" type="submit">Send request</button>
    </form>
  ${accountFooter()}`
}

export function supportTicketPage(detail: TicketDetail, noticeData?: { message: string; isError: boolean }): string {
  const { ticket, messages } = detail
  return `
  <section class="page-hero">
    <div class="wrap">
      <h1>${esc(ticket.subject)}</h1>
      <p>${esc(ticket.statusLabel)} · ${esc(ticket.categoryLabel)}${ticket.orderId ? ` · order #${esc(String(ticket.orderId))}` : ''} · reference ${esc(ticket.id)}</p>
    </div>
  </section>
  <section class="section">
    <div class="wrap">
      ${notice(noticeData?.message, noticeData?.isError ? 'error' : 'ok')}
      <p class="tiny"><a class="link" href="/account/support">← All support requests</a></p>
      <p class="tiny">${esc(ticket.expectation)}${ticket.assigned ? ' A member of our team is assigned.' : ''}</p>
      <h2>Conversation</h2>
      <ul class="acct-list">
        ${messages
          .map(
            (m) => `<li>
          <p class="acct-list-title">${esc(m.authorLabel)} <span class="tiny muted">· ${esc(String(m.createdAt).slice(0, 19))}</span></p>
          <p>${esc(m.body).replace(/\n/g, '<br>')}</p>
          ${
            m.attachments.length
              ? `<ul class="acct-list acct-list-plain">${m.attachments.map((a) => `<li class="tiny"><a class="link" href="${esc(a.url)}">${esc(a.originalName)}</a> · ${esc(a.contentType)} · ${esc(String(Math.max(1, Math.round(a.byteSize / 1024))))}KB</li>`).join('')}</ul>`
              : ''
          }
        </li>`
          )
          .join('')}
      </ul>
      ${
        detail.canReply
          ? `<h2>Reply</h2>
      <form class="form acct-form" method="post" action="/account/support/${esc(ticket.id)}/reply" enctype="multipart/form-data">
        <label for="body">Message</label>
        <textarea id="body" name="body" rows="5" minlength="2" maxlength="4000" required></textarea>
        <label for="attachment">Attachment (optional)</label>
        <input id="attachment" name="attachment" type="file" accept="${esc(SUPPORT_ATTACHMENT_ACCEPT)}">
        <p class="tiny">Up to ${esc(String(Math.round(SUPPORT_ATTACHMENT_MAX_BYTES / (1024 * 1024))))}MB. Accepted: ${esc(SUPPORT_ATTACHMENT_ACCEPT)}.</p>
        <button class="btn btn-primary" type="submit">Send reply</button>
      </form>`
          : `<p class="tiny">This request is closed. Reopen it to add a message.</p>`
      }
      <div class="acct-actions">
        ${
          detail.canClose
            ? `<form method="post" action="/account/support/${esc(ticket.id)}/status"><input type="hidden" name="to" value="closed"><button class="btn btn-outline" type="submit">Close this request</button></form>`
            : ''
        }
        ${
          detail.canReopen
            ? `<form method="post" action="/account/support/${esc(ticket.id)}/status"><input type="hidden" name="to" value="open"><button class="btn btn-outline" type="submit">Reopen</button></form>`
            : ''
        }
      </div>
    </div>
  </section>`
}

// ---------------------------------------------------------------------------
// Guest claims (CUS-04)
// ---------------------------------------------------------------------------

export function accountClaimsPage(data: { claims: Array<{ id: string; resourceType: string; resourceRef: string; verifiedVia: string; createdAt: string }>; claimable: EligibleGuestOrder[]; emailVerified: boolean; mailStatus: MailProviderStatus; notice?: { message: string; isError: boolean } }): string {
  return `
  ${accountHeader('Guest orders', 'Add an order you placed without an account.', 'claims')}
    ${notice(data.notice?.message, data.notice?.isError ? 'error' : 'ok')}
    <h2>How this works</h2>
    <p class="tiny">An order placed as a guest belongs to a browser, not to an account. To move it to your account you must prove one of two things: that you hold the order's own confirmation link, or that you can receive email at the address the order was placed with. Typing an address is never enough on its own — we send a single-use confirmation link to it, and only opening that link moves the order.</p>
    <p class="tiny">${emailDeliveryLine(data.mailStatus)}</p>

    <h2>If you have the order confirmation link</h2>
    <p class="tiny">Open the link you were given when you placed the order and use the <em>Add this order to my account</em> button on it — that link already proves the order is yours.</p>

    <h2>If you know the email address the order used</h2>
    ${
      data.emailVerified
        ? `<form class="form acct-form" method="post" action="/account/claims">
      <label for="email">Email address used for the order</label>
      <input id="email" name="email" type="email" required autocomplete="email">
      <p class="tiny">We send a single-use confirmation link to that address. Your own address is already confirmed, so the link is the only thing left to prove.</p>
      <button class="btn btn-primary" type="submit">Send the confirmation link</button>
    </form>`
        : `<p class="notice" role="status">Confirm the email address on your own account first — <a class="link" href="/account/profile">do that on your profile</a>. Then you can ask for a claim link.</p>`
    }

    <h2>Orders we can see for your address</h2>
    ${
      data.claimable.length
        ? `<ul class="acct-list">${data.claimable.map((o) => `<li><p class="acct-list-title">Order #${esc(String(o.id))}</p><p class="tiny muted">${esc(String(o.createdAt).slice(0, 19))} · ${esc(String(o.itemCount))} item${o.itemCount === 1 ? '' : 's'} · placed as a guest</p><form method="post" action="/account/claims/order"><input type="hidden" name="orderId" value="${esc(String(o.id))}"><label for="guestToken-${esc(String(o.id))}">Confirmation link token</label><input id="guestToken-${esc(String(o.id))}" name="guestToken" required placeholder="Paste the token from your confirmation link"><button class="btn btn-outline btn-sm" type="submit">Add this order</button></form></li>`).join('')}</ul>`
        : `<p class="tiny muted">No unclaimed guest order is recorded against your account's email address.</p>`
    }

    <h2>Orders already added</h2>
    ${
      data.claims.length
        ? `<ul class="acct-list">${data.claims.map((c) => `<li><p class="acct-list-title">${esc(c.resourceType === 'order' ? `Order #${c.resourceRef}` : c.resourceRef)}</p><p class="tiny muted">Added ${esc(String(c.createdAt).slice(0, 19))} · proved by ${esc(c.verifiedVia === 'email_token' ? 'a confirmed email link' : 'the order\'s own confirmation link')}</p></li>`).join('')}</ul>`
        : `<p class="tiny muted">You have not added a guest order yet.</p>`
    }
  ${accountFooter()}`
}

// ---------------------------------------------------------------------------
// Privacy (CUS-14)
// ---------------------------------------------------------------------------

export function accountPrivacyPage(requests: PrivacyRequestView[], mailStatus: MailProviderStatus, noticeData?: { message: string; isError: boolean }): string {
  return `
  ${accountHeader('Privacy', 'Request a copy of your data, or ask for your account to be deleted.', 'privacy')}
    ${notice(noticeData?.message, noticeData?.isError ? 'error' : 'ok')}
    <p class="tiny">${emailDeliveryLine(mailStatus)}</p>
    <h2>Your requests</h2>
    ${
      requests.length
        ? `<ul class="acct-list">
      ${requests
        .map(
          (r) => `<li>
        <p class="acct-list-title">${esc(r.kindLabel)} · ${esc(r.statusLabel)}${r.legalHold ? ' · legal hold recorded' : ''}</p>
        <p class="tiny muted">Reference ${esc(r.id)} · requested ${esc(String(r.createdAt).slice(0, 19))}${r.dueAt ? ` · due by ${esc(String(r.dueAt).slice(0, 10))}` : ''}</p>
        <p class="tiny">${esc(r.expectation)}</p>
        ${r.responseNote ? `<p class="tiny">${esc(r.responseNote)}</p>` : ''}
        ${
          r.open
            ? `<form method="post" action="/account/privacy/${esc(r.id)}/cancel"><button class="btn btn-outline btn-sm" type="submit">Cancel this request</button></form>`
            : ''
        }
      </li>`
        )
        .join('')}
    </ul>`
        : `<p class="tiny muted">You have not made a privacy request.</p>`
    }
    <h2>Request an export</h2>
    <p class="tiny">We record the request, give it a reference, and a person prepares the data. This version of the service records the request but does not yet produce the export automatically.</p>
    <form class="form acct-form" method="post" action="/account/privacy">
      <input type="hidden" name="kind" value="export">
      <label for="exportNote">Anything that would help us (optional)</label>
      <textarea id="exportNote" name="note" rows="3" maxlength="1000"></textarea>
      <button class="btn btn-outline" type="submit">Request a data export</button>
    </form>
    <h2>Request account deletion</h2>
    <p class="tiny">We record the request and a person reviews what must be kept for accounting and dispute reasons before anything is deleted. Nothing is deleted automatically.</p>
    <form class="form acct-form" method="post" action="/account/privacy">
      <input type="hidden" name="kind" value="delete">
      <label for="deleteNote">Anything we should know (optional)</label>
      <textarea id="deleteNote" name="note" rows="3" maxlength="1000"></textarea>
      <button class="btn btn-outline" type="submit">Request account deletion</button>
    </form>
  ${accountFooter()}`
}

// ---------------------------------------------------------------------------
// One-off result pages for email links (no JavaScript required)
// ---------------------------------------------------------------------------

export function tokenResultPage(opts: { title: string; heading: string; body: string; isError: boolean; links?: Array<{ href: string; label: string }> }): string {
  return `
  <section class="page-hero">
    <div class="wrap">
      <h1>${esc(opts.heading)}</h1>
    </div>
  </section>
  <section class="section">
    <div class="wrap wrap-narrow">
      <p class="notice ${opts.isError ? 'error' : 'ok'}" role="${opts.isError ? 'alert' : 'status'}">${esc(opts.body)}</p>
      <div class="acct-actions">
        ${(opts.links || []).map((l) => `<a class="btn btn-primary" href="${esc(l.href)}">${esc(l.label)}</a>`).join('')}
      </div>
    </div>
  </section>`
}
