// PDP-only interactivity: gallery slider + simple form submit reuse.
// Most logic (cart, checkout) is shared with the existing app.js so PDP form
// uses the same #personalise-form selector as the legacy product page.

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
})()
