// PDP-only interactivity: gallery slider + personalised preview & form controls.
// ES module — imports the canonical cart store and the centralized API client
// instead of touching localStorage / fetch directly.
import { addItem } from './cart.js'
import { getPhotoPolicy, createUserBook, initiatePhotoUpload, completePhotoUpload, getUploadAnalysis, selectFace, patchPersonalization } from './api.js'

// The server-owned contract rendered into the page (see
// src/pages_pdp.ts + src/personalization/user-books.ts). HTML attributes,
// this client validation, the schema endpoint and the API all read from the
// same values, so they can never disagree (D-01/D-02/D-03).
function readContract() {
  try {
    const el = document.getElementById('ww-personalization-contract')
    if (el && el.textContent) return JSON.parse(el.textContent)
  } catch {
    /* fall through */
  }
  return null
}

/**
 * D-04: ONE stable draft idempotency key per (product, browser), persisted
 * across reload / back-navigation / double-click, so those never create a
 * duplicate or orphan user-book draft. Rotated only after a successful
 * add-to-cart, so a second purchase of the same product starts a fresh draft.
 */
function stableDraftKey(slug) {
  const key = `ww_draft_key:${slug}`
  try {
    const existing = localStorage.getItem(key)
    if (existing) return existing
    const fresh = `pdp-${slug}-${crypto.randomUUID()}`
    localStorage.setItem(key, fresh)
    return fresh
  } catch {
    return `pdp-${slug}-${crypto.randomUUID()}`
  }
}
function rotateDraftKey(slug) {
  try {
    localStorage.removeItem(`ww_draft_key:${slug}`)
  } catch {
    /* storage unavailable — the key simply won't persist */
  }
}

(function () {
  const contract = readContract()
  const photoPolicy = contract?.photo || null

  // ----- gallery slider -----
  const main = document.getElementById('pdp-main-image')
  const thumbs = Array.from(document.querySelectorAll('.pdp-thumb'))
  const dots = Array.from(document.querySelectorAll('.pdp-dot'))
  const next = document.querySelector('.pdp-next')
  const prev = document.querySelector('.pdp-prev')
  if (main && thumbs.length) {
    const items = thumbs
      .map(t => t.querySelector('img'))
      .map(img => ({ src: img?.src || '', alt: img?.alt || '' }))
    let i = 0
    const set = (idx) => {
      i = (idx + items.length) % items.length
      const wrap = document.getElementById('pdp-main-img')
      if (wrap) wrap.classList.add('is-loading')
      main.src = items[i].src
      main.alt = items[i].alt
      setTimeout(() => wrap?.classList.remove('is-loading'), 50)
      thumbs.forEach((t, k) => t.classList.toggle('active', k === i))
      dots.forEach((d, k) => d.classList.toggle('active', k === i))
    }
    thumbs.forEach((t, k) => t.addEventListener('click', () => set(k)))
    dots.forEach((d, k) => d.addEventListener('click', () => set(k)))
    next?.addEventListener('click', () => set(i + 1))
    prev?.addEventListener('click', () => set(i - 1))
    // basic touch swipe
    let touchX = null
    const wrap = document.getElementById('pdp-main-img')
    if (wrap) {
      wrap.addEventListener('touchstart', (e) => { touchX = e.touches[0].clientX }, { passive: true })
      wrap.addEventListener('touchend', (e) => {
        if (touchX === null) return
        const dx = (e.changedTouches[0].clientX - touchX)
        if (dx > 40) set(i - 1)
        else if (dx < -40) set(i + 1)
        touchX = null
      })
    }
  }

  // ----- smooth scroll from PDP CTA into the personalise panel -----
  const cta = document.querySelector('.pdp-cta')
  cta?.addEventListener('click', (e) => {
    const target = document.getElementById('personalise')
    if (target) { e.preventDefault(); target.scrollIntoView({ behavior: 'smooth', block: 'start' }) }
  })

  // ----- Live Character Counter for Child's Name (contract-driven limit) -----
  const nameInput = document.getElementById('child-name')
  const nameCounter = document.getElementById('name-counter')
  const nameMax = Number(contract?.childName?.maxLength) || 24
  if (nameInput && nameCounter) {
    const updateCount = () => {
      nameCounter.textContent = `${nameInput.value.length}/${nameMax}`
    }
    nameInput.addEventListener('input', updateCount)
    updateCount()
  }

  // ----- Child's name validation: the SAME allowed-character contract the
  // server enforces (D-01), so a name that passes here passes there. -----
  const namePattern = (() => {
    try {
      return contract?.childName?.allowedCharsPattern ? new RegExp(contract.childName.allowedCharsPattern, 'u') : null
    } catch {
      return null
    }
  })()
  function validateChildName(value) {
    const v = String(value || '').trim()
    if (!v) return 'Please enter your child’s name.'
    if (v.length > nameMax) return `Please use ${nameMax} characters or fewer.`
    if (namePattern && !namePattern.test(v)) return `Please use only ${contract?.childName?.allowedCharsHint || 'letters, spaces, apostrophes, hyphens and dots'}.`
    return ''
  }
  function validateChildAge(value) {
    const age = Number(value)
    const min = Number(contract?.ageRange?.min ?? 1)
    const max = Number(contract?.ageRange?.max ?? 18)
    if (!Number.isInteger(age) || age < min || age > max) return `Please enter an age between ${min} and ${max}.`
    return ''
  }

  // ----- Age Stepper Buttons (clamped to the product's own range) -----
  const ageInput = document.getElementById('child-age')
  const ageUp = document.getElementById('age-up')
  const ageDown = document.getElementById('age-down')
  if (ageInput && ageUp && ageDown) {
    const min = Number(contract?.ageRange?.min ?? 1)
    const max = Number(contract?.ageRange?.max ?? 18)
    ageUp.addEventListener('click', () => {
      const val = parseInt(ageInput.value, 10) || min
      if (val < max) ageInput.value = val + 1
    })
    ageDown.addEventListener('click', () => {
      const val = parseInt(ageInput.value, 10) || min
      if (val > min) ageInput.value = val - 1
    })
  }

  // ----- Cover/format selection (D-08) -----
  let selectedCover = document.getElementById('personalise-form')?.dataset.defaultCover || 'hardcover'
  document.querySelectorAll('#cover-options .pdp-cover-option').forEach((label) => {
    label.addEventListener('click', () => {
      document.querySelectorAll('#cover-options .pdp-cover-option').forEach((l) => l.classList.remove('active'))
      label.classList.add('active')
      const radio = label.querySelector('input[type="radio"]')
      if (radio) radio.checked = true
      selectedCover = label.dataset.coverType || selectedCover
      const el = document.getElementById('preview-cover')
      if (el) el.textContent = (label.textContent || selectedCover).trim()
    })
  })

  // ----- Avatar Upload: local preview (blob:, never stored) + REAL server upload -----
  const avatarContainer = document.getElementById('avatar-container')
  const photoInput = document.getElementById('photo')
  const photoPreview = document.getElementById('photo-preview')
  const photoRemoveBtn = document.getElementById('photo-remove-btn')
  const avatarEmpty = document.getElementById('avatar-empty')
  const photoStatus = document.getElementById('upload-status')

  const productSlug = document.getElementById('personalise-form')?.dataset.slug || ''
  const userBookIdempotencyKey = stableDraftKey(productSlug)
  let userBookId = null
  let uploadedPhotoKey = null
  let uploadInFlight = false
  let faceSelectionRequired = false
  let selectedFaceId = null
  let availableFaces = []
  // One of: 'none' | 'ready' | 'manual_review' | 'blocked'. Checkout accepts
  // the first two states only (C-02/C-03) — the confirm button is disabled
  // otherwise, so we never promise a continuation checkout would reject.
  let analysisState = 'none'

  function setPhotoStatus(text, isError) {
    if (!photoStatus) return
    photoStatus.textContent = text || ''
    photoStatus.hidden = !text
    photoStatus.classList.toggle('is-error', !!isError)
  }

  function updateConfirmAvailability() {
    const btn = document.getElementById('btn-confirm-order')
    if (!btn) return
    const analysisOk = analysisState === 'ready' || analysisState === 'manual_review'
    const ready = !!uploadedPhotoKey && !uploadInFlight && !faceSelectionRequired && analysisOk
    btn.disabled = !ready
    btn.title = ready
      ? ''
      : uploadInFlight
        ? 'Uploading photo…'
        : faceSelectionRequired
          ? 'Choose which face is your child'
          : !uploadedPhotoKey
            ? 'Upload a photo to continue'
            : 'We still need to check the photo before you can continue'
  }

  async function ensureUserBook() {
    if (userBookId) return userBookId
    const result = await createUserBook(productSlug, userBookIdempotencyKey)
    if (result.ok) userBookId = result.data.id
    return userBookId
  }

  function renderFacePicker(faces) {
    const panel = document.getElementById('face-select-panel')
    const grid = document.getElementById('face-select-grid')
    if (!panel || !grid) return
    grid.innerHTML = ''
    faces.forEach((face, i) => {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'face-select-option'
      btn.dataset.faceId = face.id
      btn.innerHTML = `<i class="fas fa-user"></i> Face ${i + 1}`
      btn.addEventListener('click', async () => {
        const res = await selectFace(uploadedPhotoKey, userBookId, face.id)
        if (res.ok) {
          selectedFaceId = face.id
          faceSelectionRequired = false
          analysisState = 'ready'
          Array.from(grid.children).forEach((c) => c.classList.remove('selected'))
          btn.classList.add('selected')
          panel.hidden = true
          updateConfirmAvailability()
        } else {
          setPhotoStatus(res.error || 'Could not select that face — please try again.', true)
        }
      })
      grid.appendChild(btn)
    })
    panel.hidden = false
  }

  async function runAnalysis(uploadKey) {
    const statusEl = document.getElementById('analysis-status')
    const res = await getUploadAnalysis(uploadKey)
    availableFaces = []
    faceSelectionRequired = false
    analysisState = 'blocked'

    if (!res.ok || !res.data) {
      if (statusEl) {
        statusEl.hidden = false
        // Honest: a network/server failure means we could NOT check the photo,
        // and checkout will refuse until it succeeds — say exactly that.
        statusEl.textContent = 'We could not check your photo just now. Please try again in a moment.'
      }
      updateConfirmAvailability()
      return { ok: false }
    }

    if (res.data.status === 'manual_review') {
      // No automated provider is configured: the server flagged this book for
      // explicit manual review, and checkout ACCEPTS it. This is the ONE
      // honest modelled outcome — we do not claim an automatic check happened.
      analysisState = 'manual_review'
      if (statusEl) {
        statusEl.hidden = false
        statusEl.textContent = res.data.message || 'We have flagged this book for manual review. You can continue.'
      }
      updateConfirmAvailability()
      return { ok: true, manualReview: true }
    }

    if (res.data.status === 'unavailable') {
      if (statusEl) {
        statusEl.hidden = false
        statusEl.textContent = res.data.message || 'Photo checks are temporarily unavailable. Please try again shortly.'
      }
      updateConfirmAvailability()
      return { ok: false }
    }

    if (res.data.status !== 'complete') {
      if (statusEl) {
        statusEl.hidden = false
        statusEl.textContent = 'Your photo is still being checked. Please wait a moment and try again.'
      }
      updateConfirmAvailability()
      return { ok: false }
    }

    availableFaces = res.data.faces || []
    if (availableFaces.length === 0) {
      // Genuine zero-face result: the user must retry with a different photo.
      setPhotoStatus('We could not find a clear face in that photo. Please upload a different photo.', true)
      uploadedPhotoKey = null
      analysisState = 'blocked'
      updateConfirmAvailability()
      return { ok: false }
    }
    if (res.data.faceSelectionRequired) {
      faceSelectionRequired = true
      analysisState = 'blocked'
      renderFacePicker(availableFaces)
      updateConfirmAvailability()
      return { ok: true }
    }
    selectedFaceId = availableFaces[0]?.id || null
    analysisState = 'ready'
    const panel = document.getElementById('face-select-panel')
    if (panel) panel.hidden = true
    updateConfirmAvailability()
    return { ok: true }
  }

  if (avatarContainer && photoInput) {
    avatarContainer.addEventListener('click', (e) => {
      if (e.target.closest('#photo-remove-btn')) return
      photoInput.click()
    })

    photoInput.addEventListener('change', async () => {
      const file = photoInput.files?.[0]
      if (!file) return

      uploadedPhotoKey = null
      analysisState = 'none'

      // Fast browser-side pre-check, derived from the SAME server-owned
      // policy the real upload endpoint enforces (rendered into the page as
      // the personalization contract, D-02). This is a UX convenience only:
      // file.size/file.type are client-reported and can be wrong or spoofed,
      // so a pass here proves nothing by itself — the server always
      // re-validates with a real image decode.
      const policy = photoPolicy || (await getPhotoPolicy())
      if (policy) {
        const maxMB = Number(policy.maxMB) || 10
        if (file.size > maxMB * 1024 * 1024) {
          setPhotoStatus(`That photo is too large — please choose one under ${maxMB}MB.`, true)
          photoInput.value = ''
          return
        }
        const mimeTypes = policy.allowedMimeTypes || (policy.allowedFormats || []).map((f) => `image/${f}`)
        const looksSupported = !file.type || mimeTypes.includes(file.type)
        if (!looksSupported) {
          setPhotoStatus(`Please choose a ${(policy.allowedFormats || []).join(' or ').toUpperCase()} photo.`, true)
          photoInput.value = ''
          return
        }
      }

      uploadInFlight = true
      updateConfirmAvailability()
      setPhotoStatus('Uploading photo…', false)

      // Local, in-memory-only preview (blob: URL) — used for the on-page
      // preview only; it is NEVER written to the cart or localStorage (D-05).
      const objectUrl = URL.createObjectURL(file)
      if (photoPreview) {
        photoPreview.src = objectUrl
        photoPreview.style.display = 'block'
      }
      if (avatarEmpty) avatarEmpty.style.display = 'none'
      const faceOverlay = document.getElementById('preview-child-face')
      if (faceOverlay) faceOverlay.src = objectUrl

      // Dimension pre-check (also just UX — the server checks the REAL
      // decoded dimensions, not whatever the browser reports here).
      if (policy) {
        const dims = await new Promise((resolve) => {
          const probe = new Image()
          probe.onload = () => resolve({ w: probe.naturalWidth, h: probe.naturalHeight })
          probe.onerror = () => resolve(null)
          probe.src = objectUrl
        })
        const minD = Number(policy.minDimensionPx) || 800
        const maxD = Number(policy.maxDimensionPx) || 4000
        if (dims && (dims.w < minD || dims.h < minD || dims.w > maxD || dims.h > maxD)) {
          uploadInFlight = false
          setPhotoStatus(`Photo must be ${minD}–${maxD}px on each side.`, true)
          if (photoPreview) photoPreview.style.display = 'none'
          if (avatarEmpty) avatarEmpty.style.display = ''
          updateConfirmAvailability()
          return
        }
      }

      // Two-phase upload: declare intent, then send real bytes against the
      // one-time completion capability that step returns.
      const initiated = await initiatePhotoUpload(file.type, file.size)
      if (!initiated.ok) {
        uploadInFlight = false
        setPhotoStatus(initiated.error || 'Upload failed — please try a different photo.', true)
        if (photoPreview) photoPreview.style.display = 'none'
        if (avatarEmpty) avatarEmpty.style.display = ''
        updateConfirmAvailability()
        return
      }
      const completed = await completePhotoUpload(initiated.data.uploadId, initiated.data.completionToken, file)
      uploadInFlight = false
      if (completed.ok) {
        uploadedPhotoKey = initiated.data.uploadId
        setPhotoStatus('Photo uploaded ✓', false)
        selectedFaceId = null
        faceSelectionRequired = false
        // Create the user_book now so a page reload/duplicate click still
        // resolves to the SAME book (stable idempotency key).
        await ensureUserBook()
      } else {
        setPhotoStatus(completed.error || 'Upload failed — please try a different photo.', true)
        if (photoPreview) photoPreview.style.display = 'none'
        if (avatarEmpty) avatarEmpty.style.display = ''
      }
      updateConfirmAvailability()
    })

    photoRemoveBtn?.addEventListener('click', (e) => {
      e.stopPropagation()
      photoInput.value = ''
      uploadedPhotoKey = null
      analysisState = 'none'
      setPhotoStatus('', false)
      if (photoPreview) {
        photoPreview.src = '/static/img/photo-placeholder.svg'
        photoPreview.style.display = 'none'
      }
      if (avatarEmpty) avatarEmpty.style.display = ''
      updateConfirmAvailability()
    })
  }
  updateConfirmAvailability()

  // ----- Live Preview Modal Logic -----
  const modal = document.getElementById('book-preview-modal')
  const modalClose = document.getElementById('modal-close-btn')
  const btnEdit = document.getElementById('btn-edit-personalise')
  const btnConfirm = document.getElementById('btn-confirm-order')
  const form = document.getElementById('personalise-form')

  const closeModal = () => {
    if (modal) modal.hidden = true
    document.body.style.overflow = ''
  }
  const openModal = () => {
    if (modal) modal.hidden = false
    document.body.style.overflow = 'hidden'
  }

  modalClose?.addEventListener('click', closeModal)
  btnEdit?.addEventListener('click', closeModal)
  modal?.addEventListener('click', (e) => {
    if (e.target === modal) closeModal()
  })

  // Submit -> save the REAL personalization revision on the server, then run
  // the photo check and show the honest review modal. No fabricated "finished
  // pages" — see src/pages_pdp.ts's review-note copy.
  if (form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault()
      if (!uploadedPhotoKey) {
        setPhotoStatus('Please upload a photo before continuing.', true)
        document.getElementById('personalise')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
        return
      }
      const nameError = validateChildName(nameInput?.value)
      if (nameError) {
        setPhotoStatus(nameError, true)
        nameInput?.focus()
        return
      }
      const ageError = validateChildAge(ageInput?.value)
      if (ageError) {
        setPhotoStatus(ageError, true)
        ageInput?.focus()
        return
      }
      if (faceSelectionRequired) {
        setPhotoStatus('Please choose which face is your child before continuing.', true)
        return
      }
      const bookId = await ensureUserBook()
      if (!bookId) {
        setPhotoStatus('Could not start personalisation — please try again.', true)
        return
      }

      const childName = String(nameInput?.value || '').trim()
      const childAge = Number(ageInput?.value)
      const language = document.getElementById('lang')?.value || 'en'
      const dedication = document.getElementById('dedication')?.value || ''

      const saved = await patchPersonalization(bookId, {
        childName,
        childAge,
        languageCode: language,
        dedication,
        photoUploadKey: uploadedPhotoKey
      })
      if (!saved.ok) {
        const firstField = saved.fields ? Object.values(saved.fields)[0] : null
        setPhotoStatus(firstField || saved.error || 'Could not save personalisation — please try again.', true)
        return
      }

      // Only now does the book sit in awaiting_photo_analysis (the patch above
      // attached the photo) — this is the one call that records detected
      // faces and advances the state machine.
      await runAnalysis(uploadedPhotoKey)
      // A photo that needs an explicit face choice still opens the review
      // modal — the picker panel lives inside it — while Confirm stays
      // disabled until the choice is made. Every OTHER blocked outcome (no
      // usable face, provider unavailable, photo not checkable) shows its
      // status message instead of a "review your details" dialog.
      if (analysisState === 'blocked' && !faceSelectionRequired) return

      const elModalName = document.getElementById('modal-child-name')
      const elModalAge = document.getElementById('modal-child-age')
      const elModalLang = document.getElementById('modal-book-lang')
      if (elModalName) elModalName.textContent = childName
      if (elModalAge) elModalAge.textContent = String(childAge)
      if (elModalLang) elModalLang.textContent = document.getElementById('lang')?.selectedOptions?.[0]?.textContent || language
      const elCover = document.getElementById('preview-cover')
      if (elCover) elCover.textContent = selectedCover.charAt(0).toUpperCase() + selectedCover.slice(1)

      const previewImg = document.getElementById('preview-child-face')
      if (previewImg && photoPreview) previewImg.src = photoPreview.src
      const elDedication = document.getElementById('preview-dedication')
      if (elDedication) elDedication.textContent = dedication || '—'

      openModal()
    })
  }

  // Modal Confirm -> Add to Cart. Only the opaque userBookId is
  // authoritative; the other fields are non-authoritative display data. The
  // thumbnail is the product's public image — never a blob:/data: URL and
  // never the private R2 key (D-05).
  btnConfirm?.addEventListener('click', async () => {
    if (!uploadedPhotoKey || !userBookId) {
      setPhotoStatus('Please upload a photo before adding to cart.', true)
      return
    }
    btnConfirm.disabled = true
    btnConfirm.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Adding to Cart…'

    const elModalName = document.getElementById('modal-child-name')
    const elModalAge = document.getElementById('modal-child-age')
    const item = {
      id: `${productSlug || 'book'}-${Date.now()}`,
      slug: productSlug,
      title: form?.dataset.title || 'Personalised storybook',
      image: form?.dataset.image || '/static/img/cover-princess.webp',
      kind: form?.dataset.kind || 'book',
      coverType: selectedCover,
      userBookId,
      childName: elModalName?.textContent || '',
      childAge: elModalAge?.textContent || '',
      language: document.getElementById('lang')?.value || 'en',
      languageLabel: document.getElementById('lang')?.selectedOptions?.[0]?.textContent || '',
      qty: 1
    }

    addItem(item)
    // A new draft key for the NEXT purchase of this product — the book just
    // added is identified by its own userBookId.
    rotateDraftKey(productSlug)
    window.location.href = '/cart'
  })
})()
