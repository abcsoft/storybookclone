// PDP-only interactivity: gallery slider + personalised preview & form controls.
// ES module — imports the canonical cart store and the centralized API client
// instead of touching localStorage / fetch directly (Phase 1 defects #1/#3).
import { addItem } from './cart.js'
import { getPhotoPolicy, createUserBook, initiatePhotoUpload, completePhotoUpload, getUploadAnalysis, selectFace, patchPersonalization } from './api.js'

(function () {
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

  // ----- Live Character Counter for Child's Name -----
  const nameInput = document.getElementById('child-name')
  const nameCounter = document.getElementById('name-counter')
  if (nameInput && nameCounter) {
    const updateCount = () => {
      const len = nameInput.value.length
      nameCounter.textContent = `${len}/25`
    }
    nameInput.addEventListener('input', updateCount)
    updateCount()
  }

  // ----- Age Stepper Buttons -----
  const ageInput = document.getElementById('child-age')
  const ageUp = document.getElementById('age-up')
  const ageDown = document.getElementById('age-down')
  if (ageInput && ageUp && ageDown) {
    ageUp.addEventListener('click', () => {
      let val = parseInt(ageInput.value, 10) || 6
      if (val < 18) ageInput.value = val + 1
    })
    ageDown.addEventListener('click', () => {
      let val = parseInt(ageInput.value, 10) || 6
      if (val > 1) ageInput.value = val - 1
    })
  }

  // ----- Avatar Upload: local preview (blob:, never stored) + REAL server upload -----
  const avatarContainer = document.getElementById('avatar-container')
  const photoInput = document.getElementById('photo')
  const photoPreview = document.getElementById('photo-preview')
  const photoRemoveBtn = document.getElementById('photo-remove-btn')
  const avatarEmpty = document.getElementById('avatar-empty')
  const photoStatus = document.getElementById('upload-status')

  // Phase 2 personalization state. `userBookId` is the ONLY identifier the
  // cart/checkout ever sees for this personalization — never a raw photo,
  // never a guest capability. Created once per page load (idempotency key
  // below makes a page reload/duplicate click resolve to the SAME book,
  // never a duplicate).
  const productSlug = document.getElementById('personalise-form')?.dataset.slug || ''
  const userBookIdempotencyKey = `pdp-${productSlug}-${crypto.randomUUID()}`
  let userBookId = null
  let uploadedPhotoKey = null
  let uploadedPhotoUrl = null
  let uploadInFlight = false
  let faceSelectionRequired = false
  let selectedFaceId = null
  let availableFaces = []

  function setPhotoStatus(text, isError) {
    if (!photoStatus) return
    photoStatus.textContent = text || ''
    photoStatus.hidden = !text
    photoStatus.classList.toggle('is-error', !!isError)
  }

  function updateConfirmAvailability() {
    const btn = document.getElementById('btn-confirm-order')
    if (!btn) return
    const ready = !!uploadedPhotoKey && !uploadInFlight && !faceSelectionRequired
    btn.disabled = !ready
    btn.title = ready ? '' : uploadInFlight ? 'Uploading photo…' : faceSelectionRequired ? 'Choose which face is your child' : 'Upload a photo to continue'
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
    if (!res.ok || !res.data) {
      if (statusEl) {
        statusEl.hidden = false
        statusEl.textContent = 'Photo analysis is unavailable right now — you can still continue.'
      }
      faceSelectionRequired = false
      return
    }
    if (res.data.status === 'unavailable') {
      if (statusEl) {
        statusEl.hidden = false
        statusEl.textContent = res.data.message || 'Photo analysis is unavailable right now — you can still continue.'
      }
      faceSelectionRequired = false
      return
    }
    availableFaces = res.data.faces || []
    faceSelectionRequired = !!res.data.faceSelectionRequired
    if (availableFaces.length === 0) {
      setPhotoStatus('We could not find a clear face in that photo. Please upload a different photo.', true)
      uploadedPhotoKey = null
      uploadedPhotoUrl = null
    } else if (faceSelectionRequired) {
      renderFacePicker(availableFaces)
    } else {
      selectedFaceId = availableFaces[0]?.id || null
      const panel = document.getElementById('face-select-panel')
      if (panel) panel.hidden = true
    }
    updateConfirmAvailability()
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
      uploadedPhotoUrl = null

      // Fast browser-side pre-check, derived from the SAME server-owned
      // policy the real upload endpoint enforces (GET
      // /api/v1/uploads/photo-policy — see src/photo-policy.ts). This is a
      // UX convenience only: file.size/file.type are client-reported and
      // can be wrong or spoofed, so a pass here proves nothing by itself —
      // the server always re-validates with a real image decode. It only
      // saves an obviously-doomed upload a round trip.
      const policy = await getPhotoPolicy()
      if (policy) {
        if (file.size > policy.maxMB * 1024 * 1024) {
          setPhotoStatus(`That photo is too large — please choose one under ${policy.maxMB}MB.`, true)
          photoInput.value = ''
          return
        }
        const looksSupported = !file.type || policy.allowedFormats.some((f) => file.type === `image/${f}`)
        if (!looksSupported) {
          setPhotoStatus(`Please choose a ${policy.allowedFormats.join(' or ').toUpperCase()} photo.`, true)
          photoInput.value = ''
          return
        }
      }

      uploadInFlight = true
      updateConfirmAvailability()
      setPhotoStatus('Uploading photo…', false)

      // Local, in-memory-only preview (blob: URL) — never persisted, never
      // becomes the value we send anywhere.
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
        if (dims && (dims.w < policy.minDimensionPx || dims.h < policy.minDimensionPx || dims.w > policy.maxDimensionPx || dims.h > policy.maxDimensionPx)) {
          uploadInFlight = false
          setPhotoStatus(`Photo must be ${policy.minDimensionPx}–${policy.maxDimensionPx}px on each side.`, true)
          if (photoPreview) photoPreview.style.display = 'none'
          if (avatarEmpty) avatarEmpty.style.display = ''
          updateConfirmAvailability()
          return
        }
      }

      // Two-phase upload (Phase 2): declare intent, then send real bytes
      // against the one-time completion capability that step returns.
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
        // Display-only: no public URL for a private photo exists server-side
        // (by design — see Phase 2 privacy rules). The local blob: preview
        // is reused purely for cart/UI display and never sent to the server.
        uploadedPhotoUrl = objectUrl
        setPhotoStatus('Photo uploaded ✓', false)
        selectedFaceId = null
        faceSelectionRequired = false
        // Create the user_book now so a page reload/duplicate click still
        // resolves to the SAME book (idempotency key). Face analysis itself
        // only runs after personalization is saved (see form submit below) —
        // the book must first reach awaiting_photo_analysis via
        // attachInitialPhoto/beginPhotoAnalysis before /analysis has
        // anything to apply its outcome to.
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
      uploadedPhotoUrl = null
      setPhotoStatus('', false)
      if (photoPreview) {
        photoPreview.src = '/static/img/avatar-sample.png'
        photoPreview.style.display = 'none'
      }
      if (avatarEmpty) avatarEmpty.style.display = ''
      updateConfirmAvailability()
    })
  }
  updateConfirmAvailability()

  // ----- Storybook Live Preview Modal Logic -----
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

  // Handle Form Submission -> save the REAL personalization revision on the
  // server (Section 5/6), then show the honest review modal. No fabricated
  // "finished pages" — see src/pages_pdp.ts's review-note copy.
  if (form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault()
      if (!uploadedPhotoKey) {
        setPhotoStatus('Please upload a photo before continuing.', true)
        document.getElementById('personalise')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
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

      const childName = (nameInput?.value || 'gando').trim()
      const childAge = Number(ageInput?.value || 6)
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
        setPhotoStatus(saved.error || 'Could not save personalisation — please try again.', true)
        return
      }

      // Only now does the book sit in awaiting_photo_analysis (patch above
      // just attached the photo) — this is the one call that actually
      // records detected faces and advances the state machine.
      await runAnalysis(uploadedPhotoKey)
      if (availableFaces.length === 0) {
        // runAnalysis already reset uploadedPhotoKey/Url and showed an error.
        return
      }

      const elModalName = document.getElementById('modal-child-name')
      const elModalAge = document.getElementById('modal-child-age')
      const elModalLang = document.getElementById('modal-book-lang')
      if (elModalName) elModalName.textContent = childName
      if (elModalAge) elModalAge.textContent = String(childAge)
      if (elModalLang) elModalLang.textContent = document.getElementById('lang')?.selectedOptions?.[0]?.textContent || language

      const previewImg = document.getElementById('preview-child-face')
      if (previewImg && photoPreview) previewImg.src = photoPreview.src
      const elDedication = document.getElementById('preview-dedication')
      if (elDedication) elDedication.textContent = dedication || '—'

      openModal()
    })
  }

  // Modal Confirm -> Add to Cart. Only an opaque userBookId is authoritative;
  // the other fields here are non-authoritative display data for the cart/
  // checkout UI — the server always re-reads the real personalization by
  // userBookId at order time (src/orders.ts), so a forged value here changes
  // nothing.
  btnConfirm?.addEventListener('click', async () => {
    if (!uploadedPhotoKey || !userBookId) {
      setPhotoStatus('Please upload a photo before adding to cart.', true)
      return
    }
    btnConfirm.disabled = true
    btnConfirm.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Adding to Cart…'

    const childName = (nameInput?.value || 'gando').trim()
    const childAge = ageInput?.value || '6'
    const langSelect = document.getElementById('lang')
    const languageLabel = langSelect?.selectedOptions?.[0]?.textContent || langSelect?.value || 'English'

    const item = {
      id: `${form?.dataset.slug || 'book'}-${Date.now()}`,
      slug: form?.dataset.slug || 'the-portugals-new-legend',
      title: form?.dataset.title || "The Portugal's New Legend",
      image: uploadedPhotoUrl || form?.dataset.image || '/static/img/cover-portugal.webp',
      kind: form?.dataset.kind || 'book',
      userBookId,
      childName,
      childAge,
      language: languageLabel,
      qty: 1
    }

    addItem(item)
    window.location.href = '/cart'
  })
})()
