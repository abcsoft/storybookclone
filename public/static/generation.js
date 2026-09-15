// GEN-09: the customer generation panel's live behaviour.
//
// The server renders the true state on every page load (src/pages_generation.ts),
// so a refresh always shows reality. This module only makes an in-flight job
// update WITHOUT a reload: it polls the same authorized endpoint, re-renders the
// status line and progress bar, shows a real failure message with a retry
// control, and stops polling as soon as the job reaches a terminal state.
//
// It never invents a status, never shows a preview before the server says a
// watermarked version exists, and every mutation (create / retry / cancel /
// approve / revision) goes through the app's own CSRF-protected fetch helper.
import {
  generationStatus,
  requestGeneration,
  cancelGeneration,
  retryGeneration,
  approvePreview,
  requestRevision
} from './api.js'

function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

const PHASE_TEXT = {
  queued: 'Your book is queued. This page updates on its own — you can safely close it and come back.',
  working: '',
  ready: 'Your watermarked preview is ready below. Look it over, then approve it or ask for changes.',
  needs_attention: '',
  stopped: ''
}

const POLL_INTERVAL_MS = 4000
/** Bounded polling: a job that never reaches a terminal state must not poll forever. */
const MAX_POLLS = 90

function el(id) {
  return document.getElementById(id)
}

function statusText(payload) {
  const job = payload.job
  if (job) {
    if (job.phase === 'working') return `Creating your illustrations — ${job.scenes.ready} of ${job.scenes.total} pages done.`
    if (job.phase === 'queued') return PHASE_TEXT.queued
    if (job.status === 'succeeded') return PHASE_TEXT.ready
    if (job.phase === 'needs_attention') {
      const detail = job.lastError && job.lastError.message ? `: ${job.lastError.message}` : '.'
      return `We could not finish this preview${detail} You can try again, or contact support if it keeps failing.`
    }
    if (job.status === 'cancelled') return 'This generation was cancelled.'
    if (job.status === 'superseded') return 'Your details changed while this preview was being made, so it was discarded. Create a new preview from your current details.'
  }
  if (payload.bookState === 'ready_to_generate') return 'Your details are saved. Create a watermarked preview to see your book.'
  if (payload.bookState === 'generation_failed') return 'The last attempt did not finish. You can try again.'
  return 'Your details are saved.'
}

function render(payload) {
  const panel = el('generation-panel')
  if (!panel) return
  const job = payload.job
  panel.dataset.jobStatus = job ? job.status : ''
  panel.dataset.jobPhase = job ? job.phase : ''

  const status = el('gen-status')
  if (status) status.textContent = statusText(payload)

  if (job && job.scenes && job.scenes.total) {
    let progress = el('gen-progress')
    if (!progress) {
      progress = document.createElement('div')
      progress.id = 'gen-progress'
      progress.className = 'gen-progress'
      progress.innerHTML =
        '<div class="gen-progress-track" role="progressbar" aria-valuemin="0" aria-valuemax="0" aria-valuenow="0" aria-label="Pages generated"><span class="gen-progress-bar" style="width:0%"></span></div><span class="gen-progress-label" id="gen-progress-label"></span>'
      const label = status && status.parentNode ? status.parentNode : panel
      label.insertBefore(progress, status && status.nextSibling ? status.nextSibling : null)
    }
    const track = progress.querySelector('.gen-progress-track')
    const bar = progress.querySelector('.gen-progress-bar')
    const label = el('gen-progress-label')
    const pct = Math.round((job.scenes.ready / job.scenes.total) * 100)
    if (track) {
      track.setAttribute('aria-valuemax', String(job.scenes.total))
      track.setAttribute('aria-valuenow', String(job.scenes.ready))
    }
    if (bar) bar.style.width = `${pct}%`
    if (label) label.textContent = `${job.scenes.ready} / ${job.scenes.total} pages`
  }

  // The panel's action buttons live in TWO places and must not be duplicated:
  // `#gen-actions` holds create/retry/cancel, while the server renders the
  // approval block (`#gen-approval-block`) and its approved note
  // (`#gen-approved-flag`). The client only TOGGLES the server-rendered ones —
  // creating a second approve button here was a real defect the browser journey
  // caught (the operator could approve the same version twice).
  const actions = el('gen-actions')
  if (actions) {
    actions.innerHTML = ''
    if (job && job.canRetry) append(actions, 'gen-retry', 'btn btn-outline', 'Try again')
    if (job && job.canCancel) append(actions, 'gen-cancel', 'btn btn-outline', 'Cancel')
    if (!payload.preview && job === null && (payload.bookState === 'ready_to_generate' || payload.bookState === 'revision_requested' || payload.bookState === 'generation_failed')) {
      append(actions, 'gen-start', 'btn btn-purple', 'Create my preview')
    }
  }

  const approved = !!(payload.preview && payload.preview.approved)
  const approvalBlock = el('gen-approval-block')
  if (approvalBlock) approvalBlock.hidden = approved
  const approvedFlag = el('gen-approved-flag')
  if (approvedFlag) {
    approvedFlag.hidden = !approved
    if (approved && payload.preview) {
      approvedFlag.textContent = `You approved version ${payload.preview.version}. Editing your details will invalidate that approval and start a new version.`
    }
  } else if (approved && payload.preview) {
    // No server-rendered note (the page was rendered before a preview existed):
    // create it once, visibly and to assistive technology.
    const note = document.createElement('p')
    note.id = 'gen-approved-flag'
    note.className = 'gen-approved-note'
    note.setAttribute('role', 'status')
    note.textContent = `You approved version ${payload.preview.version}. Editing your details will invalidate that approval and start a new version.`
    const preview = el('gen-preview')
    if (preview && preview.parentNode) preview.parentNode.insertBefore(note, preview)
  }
}

function append(parent, id, className, text, version, onlyIfMissing) {
  if (onlyIfMissing && el(id)) return
  const button = document.createElement('button')
  button.type = 'button'
  button.id = id
  button.className = className
  button.textContent = text
  if (version !== undefined) button.dataset.version = String(version)
  parent.appendChild(button)
}

function showError(message) {
  const target = el('gen-error')
  if (!target) return
  target.textContent = message
  target.hidden = !message
}

function userBookId() {
  const panel = el('generation-panel')
  return panel ? panel.dataset.userBookId : null
}

async function refresh() {
  const id = userBookId()
  if (!id) return null
  const result = await generationStatus(id)
  if (!result.ok) {
    showError(result.status === 404 ? 'This book is no longer available.' : `Could not load your preview status (${esc(result.error)}).`)
    return null
  }
  showError('')
  render(result.data)
  return result.data
}

function terminal(payload) {
  return !payload.job || ['succeeded', 'failed_permanent', 'dead_letter', 'cancelled', 'superseded'].includes(payload.job.status)
}

let polls = 0
function startPolling() {
  if (polls >= MAX_POLLS) return
  polls++
  setTimeout(async () => {
    const payload = await refresh()
    // Re-render the page once a preview exists, so the freshly stored
    // watermarked pages appear without the customer having to reload.
    if (payload && payload.preview && !el('gen-pages')) {
      window.location.reload()
      return
    }
    if (!payload || !terminal(payload)) startPolling()
  }, POLL_INTERVAL_MS)
}

async function act(run) {
  const result = await run()
  if (!result.ok) {
    showError(result.error ? esc(result.error) : 'That did not work. Please try again.')
    return false
  }
  showError('')
  await refresh()
  return true
}

function wire() {
  const panel = el('generation-panel')
  if (!panel) return

  panel.addEventListener('click', async (event) => {
    const target = event.target
    if (!(target instanceof HTMLElement)) return
    const id = target.id
    const bookId = userBookId()
    if (!bookId) return
    if (id === 'gen-start') {
      target.disabled = true
      const started = await act(() => requestGeneration(bookId))
      target.disabled = false
      if (started) startPolling()
    } else if (id === 'gen-retry') {
      target.disabled = true
      const retried = await act(() => retryGeneration(bookId))
      target.disabled = false
      if (retried) startPolling()
    } else if (id === 'gen-cancel') {
      target.disabled = true
      await act(() => cancelGeneration(bookId, 'Cancelled from the preview page'))
      target.disabled = false
    } else if (id === 'gen-approve') {
      target.disabled = true
      await act(() => approvePreview(bookId, Number(target.dataset.version)))
      target.disabled = false
    } else if (id === 'gen-revision') {
      const form = el('gen-revision-form')
      if (form) form.hidden = !form.hidden
    } else if (id === 'gen-revision-submit') {
      const note = el('gen-revision-note')
      const value = note ? note.value.trim() : ''
      if (value.length < 3) {
        showError('Please describe what should change.')
        return
      }
      const requested = await act(() => requestRevision(bookId, value, Number(target.dataset.version)))
      if (requested) window.location.reload()
    }
  })

  const status = panel.dataset.jobPhase
  if (status === 'queued' || status === 'working') startPolling()
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', wire)
} else {
  wire()
}
