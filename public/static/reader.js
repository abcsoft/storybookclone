// Storybook Reader & Customizer — ES module.
// Matches the real markup in src/pages_reader.ts.
import { addItem } from './cart.js'
import { requestPdf, patchPersonalization, getUserBook } from './api.js'

const state = Object.assign(
  {
    slug: '',
    title: '',
    childName: '',
    childAge: '',
    language: 'en',
    dedication: '',
    coverType: 'hardcover',
    coverOptions: ['hardcover', 'softcover'],
    ageMin: 1,
    ageMax: 18,
    childNameMaxLength: 24,
    hardcoverPrice: 0,
    softcoverPrice: 0,
    photoUrl: '',
    photoKey: null,
    cartImage: '',
    userBookId: null,
    userBookVersion: null,
    readOnly: false,
    orderItemId: null
  },
  window.__BOOK_DATA__ || {}
)
let selectedCoverType = state.coverType || state.coverOptions[0] || 'hardcover'

// ---- Guest order capability token (if this reader was opened from a
// guest order confirmation link) ----
// Captured from the URL FRAGMENT only, never a query parameter: fragments
// are never sent to the server and never appear in a Referer header, so
// this never touches a server access log or a third-party resource's
// request. Held in memory only (this module-scope variable) — never
// localStorage/sessionStorage, never console-logged, never written into
// any DOM attribute. The URL is scrubbed via history.replaceState()
// immediately after reading it, so it doesn't linger in the visible
// address bar or in the browser history entry's stored URL text.
let guestOrderToken = null
;(function captureGuestOrderTokenFromFragment() {
  const hash = window.location.hash || ''
  const match = hash.match(/(?:^#|[&#])gt=([^&]+)/)
  if (!match) return
  try {
    guestOrderToken = decodeURIComponent(match[1])
  } catch {
    guestOrderToken = null
  }
  if (guestOrderToken) {
    const cleanUrl = window.location.pathname + window.location.search
    window.history.replaceState(window.history.state, '', cleanUrl)
  }
})()

// Each widget initialises independently. Before this change a throw in any one
// of them silently disabled every widget that came after it — including the
// PDF-request form's submit handler, which then fell back to a NATIVE form
// submit (a full page reload) instead of the API call. A failure in one widget
// must never take the others down with it.
document.addEventListener('DOMContentLoaded', () => {
  const widgets = [
    ['pdfRequestForm', initPdfRequestForm],
    ['coverOptionSelector', initCoverOptionSelector],
    ['pageFlip', initPageFlip],
    ['continueButton', initContinueButton],
    ['changeDetailsDropdown', initChangeDetailsDropdown]
  ]
  for (const [name, init] of widgets) {
    try {
      init()
    } catch (err) {
      console.error(`[reader] ${name} failed to initialise:`, err)
    }
  }
})

// 1. Cover Option Selector (from the server-owned contract)
function initCoverOptionSelector() {
  const cards = document.querySelectorAll('.cover-option-card')
  cards.forEach((card) => {
    if (card.dataset.coverType === selectedCoverType) {
      cards.forEach((c) => c.classList.remove('active'))
      card.classList.add('active')
      const radio = card.querySelector('input[type="radio"]')
      if (radio) radio.checked = true
    }
    card.addEventListener('click', () => {
      cards.forEach((c) => c.classList.remove('active'))
      card.classList.add('active')
      const radio = card.querySelector('input[type="radio"]')
      if (radio) radio.checked = true
      selectedCoverType = card.dataset.coverType || selectedCoverType
      const el = document.getElementById('preview-cover')
      if (el) el.textContent = selectedCoverType.charAt(0).toUpperCase() + selectedCoverType.slice(1)
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
  // The button is server-rendered disabled precisely so this line is the gate:
  // by the time it is enabled, the submit handler below is definitely attached.
  if (submitBtn) {
    submitBtn.disabled = false
    submitBtn.removeAttribute('aria-disabled')
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
      orderItemId: state.orderItemId || undefined,
      guestOrderToken: guestOrderToken || undefined
    })
    if (result.ok) {
      // Honest status (T-03): PDF generation is NOT implemented yet. This
      // records a request; it does not promise a digital copy.
      showStatus('Request recorded. PDF generation is not available yet — we will contact you if and when it becomes available.', false)
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

// 4. Continue Button Flow to Cart. The only authoritative reference is the
// owned userBookId — the private photo key is never put in the cart (D-05)
// and the thumbnail is a stable public product asset.
function initContinueButton() {
  const continueBtn = document.getElementById('btn-continue-checkout')
  if (!continueBtn) return

  continueBtn.addEventListener('click', () => {
    if (!state.userBookId) {
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
      image: state.cartImage || undefined,
      userBookId: state.userBookId,
      childName: state.childName,
      childAge: state.childAge,
      language: state.language,
      dedication: state.dedication,
      qty: 1
    })

    window.location.href = '/cart'
  })
}

// 5. Change Details — loads the OWNED user book and PATCHes a new immutable
// revision with expectedVersion (D-07). A 409 conflict reloads the
// authoritative version and asks the user to retry; we never edit display-only
// data and pretend the server changed.
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

  form?.addEventListener('submit', async (e) => {
    e.preventDefault()
    const name = document.getElementById('edit-child-name')?.value?.trim()
    const age = Number(document.getElementById('edit-child-age')?.value)
    const language = document.getElementById('edit-language')?.value
    const status = document.getElementById('reader-edit-status')
    const setStatus = (text, isError) => {
      if (!status) return
      status.textContent = text || ''
      status.hidden = !text
      status.classList.toggle('is-error', !!isError)
    }

    if (!name) return setStatus('Please enter your child’s name.', true)
    if (!state.userBookId) return setStatus('This book has no saved personalisation to edit.', true)

    const result = await patchPersonalization(state.userBookId, {
      childName: name,
      childAge: age,
      languageCode: language,
      dedication: state.dedication,
      expectedVersion: state.userBookVersion ?? undefined
    })

    if (!result.ok) {
      if (result.status === 409) {
        // Authoritative change elsewhere: reload real state, ask to retry.
        const fresh = await getUserBook(state.userBookId)
        if (fresh.ok && fresh.data) state.userBookVersion = fresh.data.currentRevision != null ? fresh.data.currentVersion ?? state.userBookVersion : state.userBookVersion
        setStatus('This book was updated elsewhere. We reloaded the latest details — please review and press Update again.', true)
        return
      }
      const firstField = result.fields ? Object.values(result.fields)[0] : null
      return setStatus(firstField || result.error || 'Could not save your changes — please try again.', true)
    }

    state.childName = name
    state.childAge = String(age)
    state.language = language || state.language
    if (result.data && result.data.version != null) state.userBookVersion = result.data.version

    document.querySelectorAll('.reader-meta-text strong').forEach((el, i) => {
      el.textContent = i === 0 ? state.childName : state.childAge
    })
    document.getElementById('cover-title-overlay')?.querySelector('.cover-title-name')?.replaceChildren(document.createTextNode(state.childName))
    setStatus('Saved — a new personalization revision was created.', false)
    card.hidden = true
  })
}
