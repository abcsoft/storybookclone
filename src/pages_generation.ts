// GEN-09: the customer's generation panel.
//
// Design constraints, all of which come from earlier phases' findings:
//
//   * The panel is SERVER-RENDERED from the real job/preview rows on every page
//     load, so a refresh shows the true state immediately — it never depends on
//     a client-side cache or a value the browser invented.
//   * `public/static/generation.js` then polls the same API while the job is in
//     flight, so progress and failure updates arrive without the customer
//     reloading. Polling stops the moment the job reaches a terminal state.
//   * A preview is presented as a PREVIEW: watermarked, from its own private
//     route, with the watermark label named. Nothing here claims the pages are
//     print-ready, and when no provider is configured the panel says so
//     instead of leaving the customer waiting for work that cannot start.
//   * Every control (create / retry / cancel) is a real, CSRF-protected request
//     to the same validated domain service the API exposes.
import { esc } from './layout'
import type { JobView } from './generation/routes'
import type { ProviderHealth } from './generation/providers/types'

export type PreviewPageView = {
  sceneId: number | null
  checksum: string
  width: number | null
  height: number | null
  watermarked: boolean
  url: string
}

export type PreviewView = {
  version: number
  id: number
  status: string
  sceneCount: number
  watermarkLabel: string | null
  manifestChecksum: string | null
  finalizedAt: string | null
  pages: PreviewPageView[]
  isCurrentRevision?: boolean
  approved?: boolean
  canApprove?: boolean
}

export type GenerationPanelState = {
  userBookId: string
  bookState: string
  currentRevision: number
  job: JobView | null
  preview: PreviewView | null
  providers: ProviderHealth[]
}

const PHASE_LABELS: Record<string, string> = {
  queued: 'Queued',
  working: 'Creating your pages',
  ready: 'Preview ready',
  needs_attention: 'Needs attention',
  stopped: 'Stopped'
}

function statusMessage(state: GenerationPanelState): string {
  const { job, bookState } = state
  if (job) {
    if (job.phase === 'working') return `Creating your illustrations — ${job.scenes.ready} of ${job.scenes.total} pages done.`
    if (job.phase === 'queued') return 'Your book is queued. This page updates on its own — you can safely close it and come back.'
    if (job.status === 'succeeded') return 'Your watermarked preview is ready below. Look it over, then approve it or ask for changes.'
    if (job.phase === 'needs_attention') return `We could not finish this preview${job.lastError?.message ? `: ${job.lastError.message}` : '.'} You can try again, or contact support if it keeps failing.`
    if (job.status === 'cancelled') return 'This generation was cancelled.'
    if (job.status === 'superseded') return 'Your details changed while this preview was being made, so it was discarded. Create a new preview from your current details.'
  }
  if (bookState === 'ready_to_generate') return 'Your details are saved. Create a watermarked preview to see your book.'
  if (bookState === 'manual_photo_review') return 'Your photo is queued for a person to check before your book is made.'
  if (bookState === 'awaiting_face_selection') return 'Choose which face to use, then create your preview.'
  if (bookState === 'generation_failed') return 'The last attempt did not finish. You can try again.'
  return ''
}

function providerNotice(providers: ProviderHealth[]): string {
  const generation = providers.filter((p) => ['story_text', 'illustration'].includes(p.capability))
  const blocked = generation.filter((p) => !p.configured && p.active === 'disabled')
  if (!blocked.length) return ''
  return `<p class="gen-note" role="status"><strong>Generation is not switched on in this environment.</strong> ${esc(blocked[0].detail)}</p>`
}

/** The server-rendered panel. `data-` attributes are the contract the polling script reads. */
export function renderGenerationPanel(state: GenerationPanelState): string {
  const { job, preview } = state
  const canCreate = ['ready_to_generate', 'revision_requested', 'generation_failed'].includes(state.bookState) && state.currentRevision > 0
  const canCancel = !!job?.canCancel
  const canRetry = !!job?.canRetry

  return `
  <section class="reader-section gen-panel" id="generation-panel"
           data-user-book-id="${esc(state.userBookId)}"
           data-book-state="${esc(state.bookState)}"
           data-current-revision="${state.currentRevision}"
           data-job-status="${esc(job?.status ?? '')}"
           data-job-phase="${esc(job?.phase ?? '')}">
    <h2 class="reader-section-heading">Your preview</h2>
    ${providerNotice(state.providers)}
    <p class="gen-status" id="gen-status" role="status" aria-live="polite">${esc(statusMessage(state))}</p>

    ${
      job && job.scenes.total > 0
        ? `<div class="gen-progress" id="gen-progress">
             <div class="gen-progress-track" role="progressbar" aria-valuemin="0" aria-valuemax="${job.scenes.total}" aria-valuenow="${job.scenes.ready}" aria-label="Pages generated">
               <span class="gen-progress-bar" style="width:${job.scenes.total ? Math.round((job.scenes.ready / job.scenes.total) * 100) : 0}%"></span>
             </div>
             <span class="gen-progress-label" id="gen-progress-label">${job.scenes.ready} / ${job.scenes.total} pages</span>
           </div>`
        : ''
    }

    <div class="gen-actions" id="gen-actions">
      ${canCreate ? `<button type="button" class="btn btn-purple" id="gen-start">Create my preview</button>` : ''}
      ${canRetry ? `<button type="button" class="btn btn-outline" id="gen-retry">Try again</button>` : ''}
      ${canCancel ? `<button type="button" class="btn btn-outline" id="gen-cancel">Cancel</button>` : ''}
    </div>
    <p class="gen-error" id="gen-error" role="alert" hidden></p>

    <div class="gen-preview" id="gen-preview">
      ${
        preview
          ? renderPreview(preview, state)
          : `<p class="gen-empty" id="gen-empty">No preview yet. Generated pages appear here, watermarked, once they are ready.</p>`
      }
    </div>
  </section>
  <script type="module" src="/static/generation.js"></script>
  `
}

function renderPreview(preview: PreviewView, state: GenerationPanelState): string {
  const label = preview.watermarkLabel || 'PREVIEW'
  return `
    <p class="gen-preview-meta" id="gen-preview-meta">
      <strong>Version ${preview.version}</strong> · ${preview.sceneCount} pages · every page carries a visible
      <strong>${esc(label)}</strong> watermark and is stored privately to your account.
      ${preview.isCurrentRevision === false ? ' <em>This is not the current version of your book.</em>' : ''}
      ${preview.approved ? ' <span class="gen-approved">Approved</span>' : ''}
    </p>
    <ul class="gen-pages" id="gen-pages">
      ${preview.pages
        .map(
          (page, index) => `<li class="gen-page">
            <img src="${esc(page.url)}" alt="Watermarked preview of page ${index + 1}" width="${page.width ?? 600}" height="${page.height ?? 750}" loading="lazy" decoding="async">
            <span class="gen-page-label">Page ${index + 1}${page.watermarked ? ' · watermarked' : ''}</span>
          </li>`
        )
        .join('')}
    </ul>
    ${
      preview.canApprove || preview.approved
        ? `<div class="gen-approve" id="gen-approval-block"${preview.approved ? ' hidden' : ''}>
             <button type="button" class="btn btn-purple" id="gen-approve" data-version="${preview.version}">Approve this preview</button>
             <button type="button" class="btn btn-outline" id="gen-revision">Request changes</button>
           </div>
           <div class="gen-revision-form" id="gen-revision-form" hidden>
             <label for="gen-revision-note">What should change?</label>
             <textarea id="gen-revision-note" name="note" maxlength="500" rows="3"></textarea>
             <button type="button" class="btn btn-outline" id="gen-revision-submit" data-version="${preview.version}">Send request</button>
           </div>
           <p class="gen-approved-note" id="gen-approved-flag" role="status"${preview.approved ? '' : ' hidden'}>You approved version ${preview.version}. Editing your details will invalidate that approval and start a new version.</p>`
        : ''
    }
  `
}

export { PHASE_LABELS }
