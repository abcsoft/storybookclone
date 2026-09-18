// The "Preview" step's own behaviour (owner request 4).
//
// Everything on this page that matters already works WITHOUT this file: the
// gallery, the locked tiles, the step indicator and the Change control are
// server-rendered, and generation is driven by the existing generation panel
// module. This file only adds three genuinely interactive controls:
//   1. the PDF-interest email box (Enter submits the form natively),
//   2. a zoom toggle on the published preview and its Reset/undo counterpart,
//   3. the sticky Continue, which puts the OWNED book into the cart exactly the
//      way the reader page does and then goes to the cart.
import { addItem } from './cart.js'
import { requestPdf } from './api.js'

const data = window.__PREVIEW_DATA__ || {}

function initPdfInterest() {
  const form = document.getElementById('pv-pdf-form')
  const input = document.getElementById('pv-pdf-email')
  const submit = document.getElementById('pv-pdf-submit')
  const status = document.getElementById('pv-pdf-status')
  if (!form || !input) return
  // The button is server-rendered disabled precisely so this line is the gate:
  // once it is enabled the submit handler below is definitely attached.
  if (submit) {
    submit.disabled = false
    submit.removeAttribute('aria-disabled')
  }

  const showStatus = (text, isError) => {
    if (!status) return
    status.textContent = text
    status.hidden = !text
    status.classList.toggle('is-error', !!isError)
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault()
    const email = input.value.trim()
    if (!email || !email.includes('@')) {
      showStatus('Please enter a valid email address.', true)
      return
    }
    if (submit) submit.disabled = true
    const result = await requestPdf({
      email,
      bookSlug: data.slug,
      childName: data.childName,
      childAge: data.childAge,
      coverType: data.coverType || 'hardcover'
    })
    if (result.ok) {
      // Honest status: there is no PDF renderer in this build. This records a
      // request; it does not promise a digital copy.
      showStatus('Request recorded. PDF copies are not available yet — we’ll be in touch if that changes.', false)
      input.value = ''
    } else {
      showStatus(result.error || 'Something went wrong. Please try again.', true)
    }
    if (submit) submit.disabled = false
  })
}

function initPreviewTools() {
  const gallery = document.getElementById('pv-gallery')
  const unlocked = document.getElementById('pv-unlocked')
  const reset = document.getElementById('pv-reset')
  if (!gallery || !reset) return

  // A real zoom toggle on the one published preview; Reset is its undo.
  if (unlocked) {
    unlocked.tabIndex = 0
    unlocked.setAttribute('role', 'button')
    unlocked.setAttribute('aria-pressed', 'false')
    const toggle = () => {
      const on = unlocked.classList.toggle('is-zoomed')
      unlocked.setAttribute('aria-pressed', on ? 'true' : 'false')
    }
    unlocked.addEventListener('click', toggle)
    unlocked.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        toggle()
      }
    })
  }

  reset.addEventListener('click', () => {
    // Undo: drop the zoom, return the gallery to its first tile and bring it
    // back into view. No server state is involved, so nothing can be corrupted.
    if (unlocked) {
      unlocked.classList.remove('is-zoomed')
      unlocked.setAttribute('aria-pressed', 'false')
    }
    gallery.scrollTo ? gallery.scrollTo({ left: 0, behavior: 'smooth' }) : null
    unlocked?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    reset.blur()
  })
}

function initContinue() {
  const button = document.getElementById('pv-continue')
  if (!button || button.disabled) return
  button.addEventListener('click', () => {
    if (!data.userBookId) return
    // Same shape the reader page writes: the opaque owned userBookId is the
    // only personalisation reference, and no private photo key is stored.
    addItem({
      id: `pv-${data.userBookId}`,
      slug: data.slug,
      title: data.title,
      kind: 'book',
      coverType: data.coverType,
      image: data.cartImage || '',
      userBookId: data.userBookId,
      childName: data.childName,
      childAge: data.childAge,
      qty: 1
    })
    window.location.href = data.cartHref || '/cart'
  })
}

document.addEventListener('DOMContentLoaded', () => {
  initPdfInterest()
  initPreviewTools()
  initContinue()
})
