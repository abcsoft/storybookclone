// PDP-only interactivity: gallery slider + personalised preview & form controls

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

  // ----- Avatar Upload & Remove Interaction -----
  const avatarContainer = document.getElementById('avatar-container')
  const photoInput = document.getElementById('photo')
  const photoPreview = document.getElementById('photo-preview')
  const photoRemoveBtn = document.getElementById('photo-remove-btn')
  const avatarEmpty = document.getElementById('avatar-empty')

  if (avatarContainer && photoInput) {
    avatarContainer.addEventListener('click', (e) => {
      if (e.target.closest('#photo-remove-btn')) return
      photoInput.click()
    })

    photoInput.addEventListener('change', () => {
      const file = photoInput.files?.[0]
      if (!file) return
      const reader = new FileReader()
      reader.onload = () => {
        if (photoPreview) {
          photoPreview.src = reader.result
          photoPreview.style.display = 'block'
        }
        if (avatarEmpty) avatarEmpty.style.display = 'none'
        const faceOverlay = document.getElementById('preview-child-face')
        if (faceOverlay) faceOverlay.src = reader.result
      }
      reader.readAsDataURL(file)
    })

    photoRemoveBtn?.addEventListener('click', (e) => {
      e.stopPropagation()
      photoInput.value = ''
      if (photoPreview) {
        photoPreview.src = '/static/img/avatar-sample.png'
      }
    })
  }

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

  // Pages story data for Portugal book and generic books
  const bookPages = [
    {
      chapter: 'CHAPTER 1',
      title: 'The Dream of the Final',
      text: (name) => `Months of sweat and practice in the wind and rain have led to this single moment. The stadium lights shine bright over Lisbon as <strong>${name}</strong> steps onto the pitch wearing the legendary number 7 jersey!`,
      quote: '“Believe in every pass, because today a new legend is born!”',
      art: '/static/img/cover-portugal.webp',
      caption: (name) => `Hero of Portugal: ${name}`
    },
    {
      chapter: 'CHAPTER 2',
      title: 'The Golden Touch',
      text: (name) => `With the crowd cheering their name, <strong>${name}</strong> dribbles past two defenders with unstoppable grace and vision. Every touch is pure magic!`,
      quote: '“Courage isn\'t just in the legs—it\'s in the heart of a champion.”',
      art: '/static/img/hero.webp',
      caption: (name) => `Unstoppable Wonder: ${name}`
    },
    {
      chapter: 'CHAPTER 3',
      title: 'The Winning Goal',
      text: (name) => `90th minute. The ball curves into the top corner—GOOOAL! <strong>${name}</strong> lifts the golden trophy high into the Lisbon sky as confetti rains down!`,
      quote: '“A champion never gives up, and a hero always inspires!”',
      art: '/static/img/cta-reading.webp',
      caption: (name) => `Champion of Champions: ${name}`
    },
    {
      chapter: 'CHAPTER 4',
      title: 'A Story to Keep Forever',
      text: (name) => `From the stadiums of Portugal to bedtime memories, <strong>${name}</strong>\'s courage will be celebrated in this heirloom keepsake book for years to come.`,
      quote: '“The greatest adventures start with a brave heart.”',
      art: '/static/img/step-delivered.png',
      caption: (name) => `The Legend: ${name}`
    }
  ]

  let curPage = 0
  const renderModalPage = (idx) => {
    curPage = Math.max(0, Math.min(bookPages.length - 1, idx))
    const p = bookPages[curPage]
    const childName = (nameInput?.value || 'gando').trim()

    const elChapter = document.getElementById('preview-chapter')
    const elHeadline = document.getElementById('preview-page-headline')
    const elStoryText = document.getElementById('preview-story-text')
    const elQuote = document.getElementById('preview-quote-text')
    const elArt = document.getElementById('preview-page-art')
    const elCaption = document.getElementById('preview-art-caption')
    const elLeftNum = document.getElementById('preview-page-num-left')
    const elRightNum = document.getElementById('preview-page-num-right')

    if (elChapter) elChapter.textContent = p.chapter
    if (elHeadline) elHeadline.textContent = p.title
    if (elStoryText) elStoryText.innerHTML = p.text(childName)
    if (elQuote) elQuote.textContent = p.quote
    if (elArt) elArt.src = p.art
    if (elCaption) elCaption.textContent = p.caption(childName)
    if (elLeftNum) elLeftNum.textContent = `Page ${curPage * 2 + 1}`
    if (elRightNum) elRightNum.textContent = `Page ${curPage * 2 + 2}`

    const btnPrev = document.getElementById('btn-prev-page')
    const btnNext = document.getElementById('btn-next-page')
    if (btnPrev) btnPrev.disabled = curPage === 0
    if (btnNext) btnNext.disabled = curPage === bookPages.length - 1

    document.querySelectorAll('.book-nav-dots .nav-dot').forEach((d, i) => {
      d.classList.toggle('active', i === curPage)
    })
  }

  document.getElementById('btn-prev-page')?.addEventListener('click', () => renderModalPage(curPage - 1))
  document.getElementById('btn-next-page')?.addEventListener('click', () => renderModalPage(curPage + 1))
  document.querySelectorAll('.book-nav-dots .nav-dot').forEach((d, i) => {
    d.addEventListener('click', () => renderModalPage(i))
  })

  // Handle Form Submission / Preview Book CTA
  if (form) {
    form.addEventListener('submit', (e) => {
      e.preventDefault()
      const childName = (nameInput?.value || 'gando').trim()
      const childAge = ageInput?.value || '6'
      const lang = document.getElementById('lang')?.value || 'English'

      // Update Modal Header
      const elModalName = document.getElementById('modal-child-name')
      const elModalAge = document.getElementById('modal-child-age')
      const elModalLang = document.getElementById('modal-book-lang')
      if (elModalName) elModalName.textContent = childName
      if (elModalAge) elModalAge.textContent = childAge
      if (elModalLang) elModalLang.textContent = lang

      // Update face overlay in modal
      const previewImg = document.getElementById('preview-child-face')
      if (previewImg && photoPreview) {
        previewImg.src = photoPreview.src
      }

      renderModalPage(0)
      openModal()
    })
  }

  // Modal Confirm Order -> Add to Cart
  btnConfirm?.addEventListener('click', async () => {
    btnConfirm.disabled = true
    btnConfirm.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Adding to Cart…'

    const childName = (nameInput?.value || 'gando').trim()
    const childAge = ageInput?.value || '6'
    const language = document.getElementById('lang')?.value || 'English'
    const photoSrc = photoPreview?.src || ''

    const item = {
      id: Date.now(),
      slug: form?.dataset.slug || 'the-portugals-new-legend',
      title: form?.dataset.title || "The Portugal's New Legend",
      image: form?.dataset.image || '/static/img/cover-portugal.webp',
      kind: form?.dataset.kind || 'book',
      childName,
      childAge,
      language,
      dedication: document.getElementById('dedication')?.value || '',
      photoPreview: photoSrc,
      qty: 1
    }

    try {
      const CART_KEY = 'ww_cart'
      let cart = []
      try { cart = JSON.parse(localStorage.getItem(CART_KEY) || '[]') } catch { cart = [] }
      cart.push(item)
      localStorage.setItem(CART_KEY, JSON.stringify(cart))
      window.location.href = '/cart'
    } catch {
      window.location.href = '/cart'
    }
  })
})()
