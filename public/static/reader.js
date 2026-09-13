// WonderWraps Storybook Reader & Customizer — ES module.
// Rewritten to match the real markup in src/pages_reader.ts (the previous
// version targeted element IDs/classes — #reader-continue-btn,
// .reader-carousel, #change-details-btn, wonderwraps_customization — that do
// not exist on this page, so every handler here silently no-op'd).
import { addItem } from './cart.js'
import { requestPdf } from './api.js'

const state = Object.assign(
  { slug: '', title: '', childName: 'gando', childAge: 5, language: 'English', dedication: '', photoUrl: '/static/img/avatar-sample.png', photoKey: null, readOnly: false, orderItemId: null, hardcoverPrice: 49.2, softcoverPrice: 34.2 },
  window.__BOOK_DATA__ || {}
)
let selectedCoverType = 'hardcover'

document.addEventListener('DOMContentLoaded', () => {
  initCoverOptionSelector()
  initPageFlip()
  initPdfRequestForm()
  initContinueButton()
  initChangeDetailsDropdown()
})

// 1. Cover Option Selector (Hardcover / Softcover)
function initCoverOptionSelector() {
  const cards = document.querySelectorAll('.cover-option-card')
  cards.forEach((card) => {
    card.addEventListener('click', () => {
      cards.forEach((c) => c.classList.remove('active'))
      card.classList.add('active')
      const radio = card.querySelector('input[type="radio"]')
      if (radio) radio.checked = true
      selectedCoverType = card.dataset.coverType || 'hardcover'
    })
  })
}

// 2. Cover/spread "flip" arrows — advance the dot indicator for that preview.
function initPageFlip() {
  document.querySelectorAll('.book-preview-item').forEach((item) => {
    const btn = item.querySelector('.book-carousel-arrow')
    const dots = item.querySelectorAll('.preview-dot')
    if (!btn || !dots.length) return
    let idx = 0
    btn.addEventListener('click', () => {
      idx = (idx + 1) % dots.length
      dots.forEach((d, i) => d.classList.toggle('active', i === idx))
    })
  })
}

// 3. PDF Copy Request
function initPdfRequestForm() {
  const form = document.getElementById('pdf-request-form')
  const input = document.getElementById('pdf-email')
  const submitBtn = document.getElementById('btn-pdf-submit')
  const status = document.getElementById('pdf-status-msg')
  if (!form || !input) return

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
    if (submitBtn) {
      submitBtn.disabled = true
      submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>'
    }
    const result = await requestPdf({
      email,
      bookSlug: state.slug,
      childName: state.childName,
      childAge: state.childAge,
      coverType: selectedCoverType,
      orderItemId: state.orderItemId || undefined
    })
    if (result.ok) {
      // Honest status: a request was queued, not "sent" — no PDF is
      // actually generated yet in this baseline (that's a later phase).
      showStatus('Request received — we’ll email you once your digital copy is ready.', false)
      input.value = ''
    } else {
      showStatus(result.error || 'Something went wrong. Please try again.', true)
    }
    if (submitBtn) {
      submitBtn.disabled = false
      submitBtn.innerHTML = '<i class="fas fa-paper-plane"></i>'
    }
  })
}

// 4. Continue Button Flow to Cart (adds a REAL, checkout-able item — the
// same personalization + uploaded photoKey the customer already confirmed
// on the product page; never a placeholder or duplicate).
function initContinueButton() {
  const continueBtn = document.getElementById('btn-continue-checkout')
  if (!continueBtn) return

  continueBtn.addEventListener('click', () => {
    if (!state.photoKey) {
      window.location.href = `/books/${encodeURIComponent(state.slug)}`
      return
    }
    continueBtn.disabled = true
    continueBtn.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i> Adding to Cart…'

    addItem({
      id: `${state.slug}-${Date.now()}`,
      slug: state.slug,
      title: `${state.title} (${selectedCoverType})`,
      kind: 'book',
      coverType: selectedCoverType,
      image: state.photoUrl,
      childName: state.childName,
      childAge: state.childAge,
      language: state.language,
      dedication: state.dedication,
      photoKey: state.photoKey,
      qty: 1
    })

    window.location.href = '/cart'
  })
}

// 5. Change Details Dropdown
function initChangeDetailsDropdown() {
  const toggleBtn = document.getElementById('btn-change-details')
  const card = document.getElementById('reader-change-card')
  const form = document.getElementById('reader-quick-edit-form')
  if (!toggleBtn || !card) return

  toggleBtn.addEventListener('click', (e) => {
    e.stopPropagation()
    card.hidden = !card.hidden
  })
  document.addEventListener('click', (e) => {
    if (!card.hidden && !card.contains(e.target) && e.target !== toggleBtn) {
      card.hidden = true
    }
  })

  form?.addEventListener('submit', (e) => {
    e.preventDefault()
    const name = document.getElementById('edit-child-name')?.value?.trim()
    const age = document.getElementById('edit-child-age')?.value
    const language = document.getElementById('edit-language')?.value
    if (name) state.childName = name
    if (age) state.childAge = age
    if (language) state.language = language

    document.querySelectorAll('.reader-meta-text strong').forEach((el, i) => {
      el.textContent = i === 0 ? state.childName : state.childAge
    })
    document.getElementById('cover-title-overlay')?.querySelector('.cover-title-name')?.replaceChildren(document.createTextNode(state.childName))
    card.hidden = true
  })
}
