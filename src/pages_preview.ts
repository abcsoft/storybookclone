// The "Preview" step of the personalised-book flow (owner request 4).
//
// WHAT THIS PAGE IS: the step AFTER the child's photo/details have been saved.
// Its gallery renders a REAL preview produced by the Phase-3 generation
// pipeline — the watermarked `page_preview` asset served by the entitlement-
// checked `/previews/...` route — never a fabricated or placeholder image.
//
// WHAT IT DELIBERATELY DOES NOT DO: the remaining pages of the pack are shown
// as locked placeholders. Those placeholders are pure CSS decoration with NO
// `src`/`href` of any kind, so the locked tiles cannot leak the bytes of an
// asset the customer has not bought. Only the FIRST unlocked page — the one the
// pipeline actually published for the current revision — carries an asset URL.
//
// The page is honest about the not-yet-built capability too: the email box
// records PDF interest (the same endpoint the reader uses) and says so, because
// there is no PDF renderer in this build.
import { esc } from './layout'
import type { GenerationPanelState } from './pages_generation'

export type PreviewStepData = {
  slug: string
  title: string
  childName: string
  childAge: string
  /** Opaque owned user-book id — the authoritative personalisation reference. */
  userBookId?: string
  /** Server-rendered generation panel (already escaped by src/pages_generation.ts). */
  generationPanelHtml?: string
  generation: GenerationPanelState
  /** Where the sticky primary action goes once the preview exists. */
  checkoutHref: string
  /** False when the book is not in a state the cart/order can accept yet. */
  canContinue: boolean
  /**
   * The cart payload for the primary action. It mirrors what the reader page
   * hands its own "Continue to Cart" button: the OWNED userBookId is the only
   * personalisation reference, and the thumbnail is a stable public product
   * image (never a private photo key).
   */
  cart: {
    coverType: string
    coverLabel: string
    price: number
    cartImage?: string
  }
}

/**
 * How many locked tiles to draw. The pack can be up to 24 scenes; drawing all
 * of them would be noise, and the explanatory line states the real total. The
 * exact number is cosmetic — it conveys "there is more, and it is locked".
 */
export const LOCKED_PREVIEW_TILES = 2

/** The one preview page the customer may actually see, if the pipeline published one. */
export function visiblePreviewPage(state: GenerationPanelState) {
  const preview = state.preview
  if (!preview || preview.status !== 'ready' || !preview.pages.length) return null
  return preview.pages[0]
}

function statusCopy(state: GenerationPanelState): string {
  if (state.job) {
    if (state.job.phase === 'working' || state.job.phase === 'queued') {
      return 'Your book is being illustrated right now. This page updates itself when the preview is ready.'
    }
    if (state.job.phase === 'needs_attention') {
      return 'The last attempt did not finish. You can try again below.'
    }
    if (state.job.phase === 'stopped') {
      return 'That generation run was stopped. Start a new one below when you are ready.'
    }
  }
  if (state.bookState === 'ready_to_generate' || state.bookState === 'revision_requested' || state.bookState === 'generation_failed') {
    return 'Nothing has been generated for this book yet. Create the preview below and it will appear here.'
  }
  if (state.bookState === 'awaiting_face_selection') {
    return 'Choose which face to use for the story, then come back to this step.'
  }
  if (state.bookState === 'awaiting_photo_analysis' || state.bookState === 'manual_photo_review') {
    return 'The photo still needs to be checked before a preview can be generated.'
  }
  return 'A preview will appear here once generation has run for this book.'
}

function lockedTiles(totalScenes: number, shown: number): string {
  const count = Math.max(0, Math.min(LOCKED_PREVIEW_TILES, totalScenes - 1))
  if (count === 0) return ''
  return Array.from({ length: count })
    .map(
      () => `
      <figure class="pv-preview-card pv-preview-locked">
        <!-- No src, no href, no data attribute: this tile is drawn entirely in
             CSS so it cannot expose the bytes of a locked asset. -->
        <div class="pv-locked-thumb" role="img" aria-label="Locked preview page">
          <i class="fas fa-eye-slash" aria-hidden="true"></i>
        </div>
        <figcaption class="pv-locked-cap"><i class="fas fa-lock" aria-hidden="true"></i> Locked</figcaption>
      </figure>`
    )
    .join('')
  void shown
}

export function previewStepPage(data: PreviewStepData): string {
  const state = data.generation
  const page = visiblePreviewPage(state)
  const sceneCount = state.preview?.sceneCount || 0
  const remaining = Math.max(0, sceneCount - 1)
  const editorHref = `/my/books/${encodeURIComponent(data.slug)}${data.userBookId ? `?userBookId=${encodeURIComponent(data.userBookId)}` : ''}`

  const gallery = page
    ? `
      <div class="pv-gallery" id="pv-gallery" data-page-count="${esc(String(sceneCount))}">
        <figure class="pv-preview-card pv-preview-unlocked" id="pv-unlocked">
          <img
            src="${esc(page.url)}"
            alt="Published preview page 1 of ${esc(String(sceneCount))} for ${esc(data.title)}"
            width="${esc(String(page.width || 600))}"
            height="${esc(String(page.height || 600))}"
            loading="eager"
            decoding="async">
          <figcaption>Page 1 of ${esc(String(sceneCount))} · visible preview</figcaption>
        </figure>
        ${lockedTiles(sceneCount, LOCKED_PREVIEW_TILES)}
      </div>
      <div class="pv-preview-tools">
        <p class="pv-locked-note">
          <i class="fas fa-lock" aria-hidden="true"></i>
          The other ${esc(String(remaining))} of ${esc(String(sceneCount))} page${sceneCount === 1 ? '' : 's'} ${remaining === 1 ? 'is' : 'are'} generated in full once you buy the book. This preview is watermarked.
        </p>
        <button type="button" class="pv-reset" id="pv-reset">
          <i class="fas fa-rotate-left" aria-hidden="true"></i> Reset view
        </button>
      </div>`
    : `
      <div class="pv-gallery pv-gallery-empty" id="pv-gallery">
        <div class="pv-empty" role="status">
          <i class="fas fa-image" aria-hidden="true"></i>
          <h2>Your preview isn’t ready yet</h2>
          <p>${esc(statusCopy(state))}</p>
        </div>
      </div>`

  return `
  <div class="preview-step" id="preview-step"
       data-slug="${esc(data.slug)}"
       data-child-name="${esc(data.childName)}"
       data-child-age="${esc(data.childAge)}"
       data-user-book-id="${esc(data.userBookId || '')}">

    <!-- Top row: title, personalisation summary, Change, PDF-by-email interest -->
    <header class="pv-topbar">
      <div class="pv-title-box">
        <h1 class="pv-book-title">${esc(data.title)}</h1>
        <p class="pv-personalisation">
          First Name: <strong>${esc(data.childName)}</strong>
          <span class="pv-sep" aria-hidden="true">|</span>
          Age: <strong>${esc(data.childAge)}</strong>
        </p>
      </div>
      <div class="pv-topbar-actions">
        <a class="btn btn-outline btn-sm pv-change" href="${esc(editorHref)}" id="pv-change">
          <i class="fas fa-pen" aria-hidden="true"></i> Change
        </a>
        <form class="pv-pdf" id="pv-pdf-form" novalidate>
          <label class="sr-only" for="pv-pdf-email">Email address for a PDF copy</label>
          <span class="pv-pdf-field">
            <i class="far fa-envelope" aria-hidden="true"></i>
            <input id="pv-pdf-email" name="email" type="email" inputmode="email" autocomplete="email"
                   placeholder="Email Address" required>
          </span>
          <!-- Starts disabled: enabled by preview-step.js once its submit
               handler is attached, so a click can never fall back to a plain
               HTML submit and reload the page. -->
          <button type="submit" class="pv-pdf-submit" id="pv-pdf-submit" disabled aria-disabled="true">
            <i class="fas fa-paper-plane" aria-hidden="true"></i>
            <span class="sr-only">Register interest in a PDF copy</span>
          </button>
        </form>
      </div>
      <p class="pv-pdf-note">
        PDF copies aren’t available yet. Add your email and we’ll record your interest — nothing is sent in this version.
      </p>
      <p class="pv-pdf-status" id="pv-pdf-status" role="status" aria-live="polite" hidden></p>
    </header>

    <!-- Centre: the real generated preview, plus locked placeholders -->
    <section class="pv-stage" aria-labelledby="pv-stage-heading">
      <h2 class="sr-only" id="pv-stage-heading">Book preview</h2>
      ${gallery}
    </section>

    <!-- The existing Phase-3 generation panel: real job state, real actions,
         polled by public/static/generation.js exactly as on the reader page. -->
    ${data.generationPanelHtml || ''}

    <!-- Sticky bottom bar: completed step, active step, primary action -->
    <nav class="pv-sticky-bar" id="pv-sticky-bar" aria-label="Personalisation steps">
      <ol class="pv-steps">
        <li class="pv-step pv-step-done">
          <a href="${esc(editorHref)}"><i class="fas fa-check-circle" aria-hidden="true"></i> Book</a>
        </li>
        <li class="pv-step-connector" aria-hidden="true"></li>
        <li class="pv-step pv-step-active" aria-current="step">
          <i class="fas fa-circle-dot" aria-hidden="true"></i> Preview
        </li>
      </ol>
      ${
        data.canContinue
          ? `<button type="button" class="btn btn-primary pv-continue" id="pv-continue">Continue</button>`
          : `<button type="button" class="btn btn-primary pv-continue" id="pv-continue" disabled aria-disabled="true" title="Available once the preview exists">Continue</button>`
      }
    </nav>
  </div>
  <script>
    // The same shape the reader page hands its own cart button. The escape of
    // "<" keeps a product title from closing this script element early.
    window.__PREVIEW_DATA__ = ${JSON.stringify({
      slug: data.slug,
      title: data.title,
      childName: data.childName,
      childAge: data.childAge,
      userBookId: data.userBookId || null,
      coverType: data.cart.coverType,
      coverLabel: data.cart.coverLabel,
      price: data.cart.price,
      cartImage: data.cart.cartImage || '',
      cartHref: data.checkoutHref
    }).replace(/</g, '\\u003c')};
  </script>
  <script type="module" src="/static/preview-step.js"></script>`
}
