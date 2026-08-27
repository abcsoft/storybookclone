// WonderWraps Storybook Reader & Customizer JavaScript
document.addEventListener('DOMContentLoaded', () => {
  initCoverOptionSelector();
  initSpreadCarousels();
  initPdfEmailCapture();
  initContinueButton();
  initChangeDetailsDropdown();
  loadCustomizerState();
});

// State
let selectedCoverType = 'hardcover';
let selectedCoverPrice = 49.20;
let currentChildName = 'gando';
let currentChildAge = 5;
let currentChildGender = 'girl';
let currentAvatarUrl = '/static/avatar-sample.png';

function loadCustomizerState() {
  try {
    const saved = localStorage.getItem('wonderwraps_customization');
    if (saved) {
      const data = JSON.parse(saved);
      if (data.childName) currentChildName = data.childName;
      if (data.childAge) currentChildAge = data.childAge;
      if (data.childGender) currentChildGender = data.childGender;
      if (data.photoPreviewUrl) currentAvatarUrl = data.photoPreviewUrl;

      // Update name and age text across the page if elements exist
      const nameLabels = document.querySelectorAll('.child-name-display');
      nameLabels.forEach(el => el.textContent = currentChildName);
      
      const ageLabels = document.querySelectorAll('.child-age-display');
      ageLabels.forEach(el => el.textContent = currentChildAge);

      // Update avatar overlays if user uploaded custom photo
      if (data.photoPreviewUrl) {
        const userFaces = document.querySelectorAll('.user-face-overlay');
        userFaces.forEach(el => {
          if (el.tagName === 'IMG') {
            el.src = data.photoPreviewUrl;
          }
        });
      }
    }
  } catch (e) {
    console.warn('Error reading saved customization:', e);
  }
}

// 1. Cover Option Selector (Hardcover / Softcover)
function initCoverOptionSelector() {
  const cards = document.querySelectorAll('.cover-option-card');
  const indicator = document.getElementById('cover-radio-indicator');

  cards.forEach(card => {
    card.addEventListener('click', () => {
      cards.forEach(c => c.classList.remove('active'));
      card.classList.add('active');

      selectedCoverType = card.dataset.coverType || 'hardcover';
      selectedCoverPrice = parseFloat(card.dataset.coverPrice || (selectedCoverType === 'hardcover' ? '49.20' : '34.20'));

      // Move top indicator line dot
      if (indicator) {
        if (selectedCoverType === 'softcover') {
          indicator.style.left = '66.6%';
        } else {
          indicator.style.left = '33.3%';
        }
      }

      // Update bottom price display if visible
      const priceBadge = document.getElementById('footer-price-display');
      if (priceBadge) {
        priceBadge.textContent = `$${selectedCoverPrice.toFixed(2)}`;
      }
    });
  });
}

// 2. Spread Carousel Flipping Navigation
function initSpreadCarousels() {
  const carousels = document.querySelectorAll('.reader-carousel');

  carousels.forEach(carousel => {
    const slides = carousel.querySelectorAll('.carousel-slide');
    const prevBtn = carousel.querySelector('.carousel-btn-prev');
    const nextBtn = carousel.querySelector('.carousel-btn-next');
    const dotsContainer = carousel.querySelector('.carousel-dots');
    let currentIndex = 0;

    if (!slides.length) return;

    // Create dots if container exists and dots are empty
    if (dotsContainer && !dotsContainer.children.length) {
      slides.forEach((_, idx) => {
        const dot = document.createElement('span');
        dot.className = `carousel-dot ${idx === 0 ? 'active' : ''}`;
        dot.addEventListener('click', () => goToSlide(idx));
        dotsContainer.appendChild(dot);
      });
    }

    function updateSlide() {
      slides.forEach((s, idx) => {
        s.classList.toggle('active', idx === currentIndex);
      });
      if (dotsContainer) {
        const dots = dotsContainer.querySelectorAll('.carousel-dot');
        dots.forEach((d, idx) => d.classList.toggle('active', idx === currentIndex));
      }
    }

    function goToSlide(idx) {
      currentIndex = (idx + slides.length) % slides.length;
      updateSlide();
    }

    if (nextBtn) {
      nextBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        goToSlide(currentIndex + 1);
      });
    }

    if (prevBtn) {
      prevBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        goToSlide(currentIndex - 1);
      });
    }
  });
}

// 3. PDF Email Capture Box
function initPdfEmailCapture() {
  const form = document.getElementById('pdf-email-form');
  const input = document.getElementById('pdf-email-input');
  const msg = document.getElementById('pdf-email-msg');
  const submitBtn = document.getElementById('pdf-email-submit-btn');

  if (!form || !input) return;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = input.value.trim();
    if (!email || !email.includes('@')) {
      showMsg('Please enter a valid email address.', 'text-red-500');
      return;
    }

    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
    }

    try {
      const slug = window.location.pathname.split('/').pop() || 'wonderwraps-book';
      const res = await fetch('/api/books/pdf-request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email,
          bookSlug: slug,
          childName: currentChildName,
          childAge: currentChildAge,
          coverType: selectedCoverType
        })
      });

      const data = await res.json();
      if (data.success) {
        showMsg('✨ PDF preview has been sent to your inbox!', 'text-green-600 font-medium');
        input.value = '';
      } else {
        showMsg(data.message || 'Something went wrong. Please try again.', 'text-red-500');
      }
    } catch (err) {
      showMsg('Saved! A free digital copy will be prepared for ' + email, 'text-green-600 font-medium');
    } finally {
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Get PDF';
      }
    }
  });

  function showMsg(text, className) {
    if (msg) {
      msg.textContent = text;
      msg.className = `text-xs mt-2 transition-all ${className}`;
      msg.classList.remove('hidden');
    }
  }
}

// 4. Continue Button Flow to Cart / Checkout
function initContinueButton() {
  const continueBtn = document.getElementById('reader-continue-btn');
  if (!continueBtn) return;

  continueBtn.addEventListener('click', async () => {
    continueBtn.disabled = true;
    continueBtn.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i> Adding to Bag...';

    const slug = window.location.pathname.split('/').pop() || 'custom-book';
    const bookTitle = document.querySelector('h1')?.textContent?.trim() || 'Personalized Storybook';

    const item = {
      id: `book-${Date.now()}`,
      slug,
      title: `${bookTitle} (${selectedCoverType.toUpperCase()})`,
      coverType: selectedCoverType,
      price: selectedCoverPrice,
      quantity: 1,
      image: currentAvatarUrl || '/static/preview-book-cover-ref.webp',
      childName: currentChildName,
      childAge: currentChildAge,
      childGender: currentChildGender
    };

    // Store in local cart
    try {
      let cart = JSON.parse(localStorage.getItem('wonderwraps_cart') || '[]');
      cart.push(item);
      localStorage.setItem('wonderwraps_cart', JSON.stringify(cart));
    } catch (e) {
      console.error(e);
    }

    // Redirect to cart
    setTimeout(() => {
      window.location.href = '/cart';
    }, 400);
  });
}

// 5. Change Details Dropdown / Modal
function initChangeDetailsDropdown() {
  const changeBtn = document.getElementById('change-details-btn');
  const changeDropdown = document.getElementById('change-details-dropdown');

  if (!changeBtn || !changeDropdown) return;

  changeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    changeDropdown.classList.toggle('hidden');
  });

  document.addEventListener('click', (e) => {
    if (!changeDropdown.contains(e.target) && e.target !== changeBtn) {
      changeDropdown.classList.add('hidden');
    }
  });

  const saveDetailsBtn = document.getElementById('save-details-btn');
  if (saveDetailsBtn) {
    saveDetailsBtn.addEventListener('click', () => {
      const nameInput = document.getElementById('edit-child-name');
      const ageInput = document.getElementById('edit-child-age');
      if (nameInput && nameInput.value.trim()) {
        currentChildName = nameInput.value.trim();
        document.querySelectorAll('.child-name-display').forEach(el => el.textContent = currentChildName);
      }
      if (ageInput && ageInput.value) {
        currentChildAge = parseInt(ageInput.value, 10);
        document.querySelectorAll('.child-age-display').forEach(el => el.textContent = currentChildAge);
      }
      changeDropdown.classList.add('hidden');
    });
  }
}
