// Admin panel progressive enhancements (confirm on destructive actions)
document.querySelectorAll('form[data-confirm]').forEach(f => {
  f.addEventListener('submit', (e) => {
    if (!confirm(f.dataset.confirm)) e.preventDefault()
  })
})
