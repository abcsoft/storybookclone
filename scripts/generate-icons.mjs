#!/usr/bin/env node
// Original UI icon set (V2 Phase 2, SF-01).
//
// The storefront used to load Font Awesome from a public CDN and Google Fonts
// from another. Both are third-party requests on every page view, and neither
// is part of this project's own design system. This script authors a small,
// original 24x24 geometric icon set instead and emits the CSS that maps the
// class names the templates already use onto it via `mask-image`, so the
// markup keeps working with ZERO network requests and the glyph colour always
// follows `currentColor`.
//
// Every path below is authored here from primitives (lines, circles, rounded
// rectangles, simple polylines). Nothing is traced or copied from another
// icon library.
//
// Usage: node scripts/generate-icons.mjs [--check]

import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, unlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const repoRootFromScript = (url = import.meta.url) => resolve(dirname(fileURLToPath(url)), '..')
export const ICON_DIR_REL = join('public', 'static', 'icons')
export const ICON_CSS_REL = join('public', 'static', 'icons.css')

const S = 'stroke="#000" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"'
const F = 'fill="#000" stroke="none"'

/** icon name -> inner markup for a 24x24 viewBox */
const ICONS = {
  bars: `<rect x="3" y="5" width="18" height="2.4" rx="1.2" ${F}/><rect x="3" y="10.8" width="18" height="2.4" rx="1.2" ${F}/><rect x="3" y="16.6" width="18" height="2.4" rx="1.2" ${F}/>`,
  search: `<circle cx="10.5" cy="10.5" r="6.2" ${S}/><path d="M15.4 15.4 21 21" ${S}/>`,
  xmark: `<path d="M6 6 18 18M18 6 6 18" ${S}/>`,
  plus: `<path d="M12 5v14M5 12h14" ${S}/>`,
  minus: `<path d="M5 12h14" ${S}/>`,
  check: `<path d="M4.5 12.5 9.5 17.5 19.5 6.5" ${S}/>`,
  'check-circle': `<circle cx="12" cy="12" r="9" ${S}/><path d="M8 12.4 11 15.4 16.2 9.4" ${S}/>`,
  'circle-question': `<circle cx="12" cy="12" r="9" ${S}/><path d="M9.4 9.2a2.7 2.7 0 1 1 3.6 2.5c-.7.3-1 .9-1 1.6v.4" ${S}/><circle cx="12" cy="17.2" r="1.1" ${F}/>`,
  'circle-info': `<circle cx="12" cy="12" r="9" ${S}/><circle cx="12" cy="8" r="1.15" ${F}/><path d="M12 11v6" ${S}/>`,
  'circle-dot': `<circle cx="12" cy="12" r="9" ${S}/><circle cx="12" cy="12" r="3.4" ${F}/>`,
  circle: `<circle cx="12" cy="12" r="9" ${S}/>`,
  clock: `<circle cx="12" cy="12" r="9" ${S}/><path d="M12 7v5.4l3.6 2.2" ${S}/>`,
  'arrow-right': `<path d="M4 12h15" ${S}/><path d="M13.5 6.5 19.5 12l-6 5.5" ${S}/>`,
  'arrow-left': `<path d="M20 12H5" ${S}/><path d="M10.5 6.5 4.5 12l6 5.5" ${S}/>`,
  'arrow-up-from-bracket': `<path d="M12 15.5V4.5" ${S}/><path d="M7.6 8.9 12 4.5l4.4 4.4" ${S}/><path d="M5 15v3.4A1.6 1.6 0 0 0 6.6 20h10.8A1.6 1.6 0 0 0 19 18.4V15" ${S}/>`,
  'chevron-down': `<path d="M6 9.5 12 15.5 18 9.5" ${S}/>`,
  'chevron-up': `<path d="M6 14.5 12 8.5 18 14.5" ${S}/>`,
  'chevron-right': `<path d="M9.5 6 15.5 12 9.5 18" ${S}/>`,
  'caret-down': `<path d="M6 9h12l-6 7z" ${F}/>`,
  user: `<circle cx="12" cy="8.2" r="3.6" ${S}/><path d="M4.8 20c0-3.6 3.2-5.6 7.2-5.6s7.2 2 7.2 5.6" ${S}/>`,
  users: `<circle cx="9" cy="8.6" r="3.2" ${S}/><path d="M2.8 19.6c0-3.2 2.8-5 6.2-5s6.2 1.8 6.2 5" ${S}/><path d="M16.4 6.2a3 3 0 0 1 0 6" ${S}/><path d="M17.6 14.9c2.1.5 3.6 1.8 3.6 4.7" ${S}/>`,
  'user-check': `<circle cx="10" cy="8.4" r="3.6" ${S}/><path d="M3.4 19.8c0-3.4 2.9-5.2 6.6-5.2" ${S}/><path d="M15 17.4 17.2 19.6 21 15" ${S}/>`,
  'bag-shopping': `<path d="M4.6 8h14.8l-1.2 12H5.8z" ${S}/><path d="M8.6 8V6.4a3.4 3.4 0 0 1 6.8 0V8" ${S}/>`,
  'cart-shopping': `<path d="M2.5 4h2.6l2.6 10.6h10.2L20.5 7H6.2" ${S}/><circle cx="9.4" cy="19" r="1.7" ${S}/><circle cx="17.4" cy="19" r="1.7" ${S}/>`,
  'box-open': `<path d="M3.4 8.6 12 4.4l8.6 4.2v7L12 19.8l-8.6-4.2z" ${S}/><path d="M3.4 8.6 12 12.8l8.6-4.2M12 12.8v7" ${S}/>`,
  'right-from-bracket': `<path d="M13.6 5H6.4A1.4 1.4 0 0 0 5 6.4v11.2A1.4 1.4 0 0 0 6.4 19h7.2" ${S}/><path d="M11.6 12h8.6" ${S}/><path d="M16.6 8.4 20.2 12l-3.6 3.6" ${S}/>`,
  lock: `<rect x="4.8" y="10.4" width="14.4" height="9.6" rx="2" ${S}/><path d="M8.4 10.4V8a3.6 3.6 0 0 1 7.2 0v2.4" ${S}/><circle cx="12" cy="15.2" r="1.4" ${F}/>`,
  envelope: `<rect x="3" y="5.6" width="18" height="12.8" rx="2" ${S}/><path d="M4.2 7.4 12 13 19.8 7.4" ${S}/>`,
  'paper-plane': `<path d="M21 3.4 3.6 10.2l6.6 2.7 2.7 6.6z" ${S}/><path d="M21 3.4 10.2 12.9" ${S}/>`,
  book: `<path d="M4.6 5.2h5.6a2 2 0 0 1 2 2v11a1.7 1.7 0 0 0-1.7-1.7H4.6z" ${S}/><path d="M20.4 5.2h-5.6a2 2 0 0 0-2 2v11a1.7 1.7 0 0 1 1.7-1.7h5.9z" ${S}/>`,
  'book-open': `<path d="M3.6 5.6h5.8a2.6 2.6 0 0 1 2.6 2.6v10.2a2 2 0 0 0-2-2H3.6z" ${S}/><path d="M20.4 5.6h-5.8a2.6 2.6 0 0 0-2.6 2.6v10.2a2 2 0 0 1 2-2h6.4z" ${S}/>`,
  tag: `<path d="M11.4 3.6H20v8.6l-8.4 8.4a1.6 1.6 0 0 1-2.3 0l-6.3-6.3a1.6 1.6 0 0 1 0-2.3z" ${S}/><circle cx="16.4" cy="7.4" r="1.5" ${F}/>`,
  store: `<path d="M4 9.4h16v9.2a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z" ${S}/><path d="M3 9.4 5.2 4.8h13.6L21 9.4z" ${S}/><path d="M9.4 19.6v-5.2h5.2v5.2" ${S}/>`,
  sparkles: `<path d="M12 3.4 13.8 9 19.4 10.8 13.8 12.6 12 18.2 10.2 12.6 4.6 10.8 10.2 9z" ${F}/><path d="M18.4 15.4 19.2 17.6 21.4 18.4 19.2 19.2 18.4 21.4 17.6 19.2 15.4 18.4 17.6 17.6z" ${F}/>`,
  'wand-magic-sparkles': `<path d="M5 19 16.2 7.8" ${S}/><path d="M15.2 6.8 17.2 8.8" ${S}/><path d="M8.6 3.6 9.4 5.8 11.6 6.6 9.4 7.4 8.6 9.6 7.8 7.4 5.6 6.6 7.8 5.8z" ${F}/><path d="M18.4 12.4 19 13.9 20.5 14.5 19 15.1 18.4 16.6 17.8 15.1 16.3 14.5 17.8 13.9z" ${F}/>`,
  'shield-halved': `<path d="M12 3.2 5 5.8v6c0 4.4 3 8 7 9.2 4-1.2 7-4.8 7-9.2V5.8z" ${S}/><path d="M12 3.2v17.8c4-1.2 7-4.8 7-9.2V5.8z" ${F} opacity="0.35"/>`,
  'shield-heart': `<path d="M12 3.2 5 5.8v6c0 4.4 3 8 7 9.2 4-1.2 7-4.8 7-9.2V5.8z" ${S}/><path d="M12 16.4c-2.6-1.7-4-3-4-4.5a1.9 1.9 0 0 1 4-.9 1.9 1.9 0 0 1 4 .9c0 1.5-1.4 2.8-4 4.5z" ${F}/>`,
  globe: `<circle cx="12" cy="12" r="9" ${S}/><path d="M3 12h18" ${S}/><path d="M12 3c2.6 2.6 4 5.6 4 9s-1.4 6.4-4 9c-2.6-2.6-4-5.6-4-9s1.4-6.4 4-9z" ${S}/>`,
  language: `<path d="M3.4 6.4h9.2M8 4.4v2M10 6.4c-.7 3.2-2.6 5.6-5.4 7.4" ${S}/><path d="M4.6 13.8c1.9-1 3.3-2.4 4.2-4" ${S}/><path d="M12.6 20.4l3.6-9.2 3.6 9.2" ${S}/><path d="M13.9 17.2h4.6" ${S}/>`,
  image: `<rect x="3.4" y="4.8" width="17.2" height="14.4" rx="2.2" ${S}/><circle cx="9" cy="10" r="1.7" ${S}/><path d="M4.4 17.6 9.6 12.6l3.4 3.2 3-2.6 3.6 3.4" ${S}/>`,
  heart: `<path d="M12 20.2C7.4 17.2 4 14.4 4 10.8A4 4 0 0 1 12 8.6a4 4 0 0 1 8 2.2c0 3.6-3.4 6.4-8 9.4z" ${S}/>`,
  gauge: `<path d="M4 17.4a9 9 0 1 1 16 0" ${S}/><path d="M12 12.4l4-3.6" ${S}/><circle cx="12" cy="13.6" r="1.6" ${F}/>`,
  'floppy-disk': `<path d="M4.4 4.8h11.2L20 9.2v9.4a1.4 1.4 0 0 1-1.4 1.4H4.4A1.4 1.4 0 0 1 3 18.6V6.2a1.4 1.4 0 0 1 1.4-1.4z" ${S}/><path d="M7.6 4.8h7v4.4h-7z" ${S}/><path d="M7 20v-6h10v6" ${S}/>`,
  flask: `<path d="M9.4 3.6v5.2L5 17.2a2 2 0 0 0 1.8 2.8h10.4a2 2 0 0 0 1.8-2.8L14.6 8.8V3.6z" ${S}/><path d="M8.4 3.6h7.2" ${S}/><path d="M6.8 14.6h10.4" ${S}/>`,
  'credit-card': `<rect x="2.8" y="5.6" width="18.4" height="12.8" rx="2.2" ${S}/><path d="M2.8 10h18.4" ${S}/><rect x="5.6" y="13.4" width="4.6" height="2.2" rx="0.8" ${F}/>`,
  'cloud-arrow-up': `<path d="M7.6 18.4h9.2a3.8 3.8 0 0 0 .4-7.6 5.4 5.4 0 0 0-10.5 1 3.4 3.4 0 0 0 .9 6.6z" ${S}/><path d="M12 15.4V8.6" ${S}/><path d="M9.6 10.8 12 8.4l2.4 2.4" ${S}/>`,
  camera: `<rect x="3" y="7.2" width="18" height="12.6" rx="2.4" ${S}/><path d="M8.6 7.2 10 4.6h4l1.4 2.6" ${S}/><circle cx="12" cy="13.4" r="3.4" ${S}/>`,
  'camera-retro': `<rect x="3" y="7.2" width="18" height="12.6" rx="2.4" ${S}/><circle cx="12" cy="13.4" r="3.6" ${S}/><path d="M8 7.2 9.2 4.6h5.6L16 7.2" ${S}/><circle cx="6" cy="10.4" r="1.1" ${F}/>`,
  child: `<circle cx="12" cy="6.6" r="3.2" ${S}/><path d="M12 9.8v6.4" ${S}/><path d="M8 12.6h8" ${S}/><path d="M12 16.2 9.4 20.6M12 16.2l2.6 4.4" ${S}/>`,
  bolt: `<path d="M13.6 2.8 5.6 13.4h5.2l-.8 7.8 8.4-10.6h-5.4z" ${S}/>`,
  palette: `<path d="M12 3.4a8.6 8.6 0 0 0 0 17.2c1.4 0 2-1 1.4-2-.8-1.4.2-2.6 1.8-2.6h1.6a3.8 3.8 0 0 0 3.8-3.8c0-4.9-3.9-8.8-8.6-8.8z" ${S}/><circle cx="8.4" cy="9" r="1.3" ${F}/><circle cx="12" cy="7.2" r="1.3" ${F}/><circle cx="15.6" cy="9" r="1.3" ${F}/>`,
  lightbulb: `<path d="M12 3.4a5.6 5.6 0 0 0-3.4 10.1V16h6.8v-2.5A5.6 5.6 0 0 0 12 3.4z" ${S}/><path d="M9.2 19h5.6" ${S}/><path d="M10.4 21.4h3.2" ${S}/>`,
  'sack-dollar': `<path d="M9.2 3.6h5.6l-2 3.2h-1.6z" ${S}/><path d="M12 6.8c-3.4 1.2-5.6 4-5.6 7.4 0 3.4 2.5 6.2 5.6 6.2s5.6-2.8 5.6-6.2c0-3.4-2.2-6.2-5.6-7.4z" ${S}/><path d="M12 10.6v7" ${S}/><path d="M13.8 12.6a1.9 1.9 0 0 0-1.8-1h-.6a1.6 1.6 0 0 0 0 3.2h1.2a1.6 1.6 0 0 1 0 3.2h-.6a1.9 1.9 0 0 1-1.8-1" ${S}/>`,
  spinner: `<path d="M12 3.6a8.4 8.4 0 0 1 8.4 8.4" ${S}/><path d="M20.4 12a8.4 8.4 0 0 1-8.4 8.4" ${S} opacity="0.45"/>`,
  filter: `<path d="M3.6 5.4h16.8l-6.6 7.6v5.6l-3.6-2V13z" ${S}/>`,
  'arrows-sort': `<path d="M8 4.6v14.8M4.8 16.2 8 19.4l3.2-3.2" ${S}/><path d="M16 19.4V4.6M12.8 7.8 16 4.6l3.2 3.2" ${S}/>`,
  'eye-slash': `<path d="M3.4 12s3.4-5.6 8.6-5.6c1.5 0 2.8.4 4 1.1" ${S}/><path d="M20.6 12c-.7 1.2-1.6 2.3-2.7 3.2" ${S}/><path d="M4 20 20 4" ${S}/><path d="M9.6 14.4a3.4 3.4 0 0 0 4.8-4.8" ${S}/>`
}

// Class names the templates/stylesheets use -> icon name. Aliases are listed
// explicitly rather than derived, so an unknown class is a generator error
// instead of a silently invisible glyph.
export const CLASS_ALIASES = {
  'fa-bars': 'bars',
  'fa-search': 'search',
  'fa-xmark': 'xmark',
  'fa-plus': 'plus',
  'fa-minus': 'minus',
  'fa-check': 'check',
  'fa-check-circle': 'check-circle',
  'fa-circle-question': 'circle-question',
  'fa-circle-info': 'circle-info',
  'fa-circle-dot': 'circle-dot',
  'fa-circle': 'circle',
  'fa-clock': 'clock',
  'fa-arrow-right': 'arrow-right',
  'fa-arrow-left': 'arrow-left',
  'fa-arrow-up-from-bracket': 'arrow-up-from-bracket',
  'fa-chevron-down': 'chevron-down',
  'fa-chevron-up': 'chevron-up',
  'fa-chevron-right': 'chevron-right',
  'fa-caret-down': 'caret-down',
  'fa-user': 'user',
  'fa-users': 'users',
  'fa-user-check': 'user-check',
  'fa-bag-shopping': 'bag-shopping',
  'fa-cart-shopping': 'cart-shopping',
  'fa-box-open': 'box-open',
  'fa-right-from-bracket': 'right-from-bracket',
  'fa-lock': 'lock',
  'fa-envelope': 'envelope',
  'fa-paper-plane': 'paper-plane',
  'fa-book': 'book',
  'fa-book-open': 'book-open',
  'fa-tag': 'tag',
  'fa-store': 'store',
  'fa-sparkles': 'sparkles',
  'fa-wand-magic-sparkles': 'wand-magic-sparkles',
  'fa-shield-halved': 'shield-halved',
  'fa-shield-heart': 'shield-heart',
  'fa-globe': 'globe',
  'fa-language': 'language',
  'fa-image': 'image',
  'fa-heart': 'heart',
  'fa-gauge': 'gauge',
  'fa-floppy-disk': 'floppy-disk',
  'fa-flask': 'flask',
  'fa-credit-card': 'credit-card',
  'fa-cloud-arrow-up': 'cloud-arrow-up',
  'fa-camera': 'camera',
  'fa-camera-retro': 'camera-retro',
  'fa-child': 'child',
  'fa-bolt': 'bolt',
  'fa-palette': 'palette',
  'fa-lightbulb': 'lightbulb',
  'fa-sack-dollar': 'sack-dollar',
  'fa-spinner': 'spinner',
  'fa-filter': 'filter',
  'fa-arrows-sort': 'arrows-sort',
  'fa-eye-slash': 'eye-slash'
}

export function renderIcons() {
  const out = new Map()
  for (const [name, inner] of Object.entries(ICONS)) {
    out.set(
      `${name}.svg`,
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false">${inner}</svg>\n`
    )
  }
  return out
}

export function renderCss() {
  for (const [cls, icon] of Object.entries(CLASS_ALIASES)) {
    if (!ICONS[icon]) throw new Error(`class .${cls} maps to unknown icon "${icon}"`)
  }
  return `/* Original UI icon set (V2 Phase 2, SF-01) — generated by
   scripts/generate-icons.mjs. Do not edit by hand; run the generator.
   No icon font and no third-party stylesheet is loaded: each glyph is an
   original SVG masked with mask-image so its colour is always currentColor
   (meaning is never carried by colour alone). */
i[class*='fa-'] {
  display: inline-block;
  inline-size: 1em;
  block-size: 1em;
  vertical-align: -0.125em;
  background-color: currentColor;
  -webkit-mask-repeat: no-repeat;
  mask-repeat: no-repeat;
  -webkit-mask-position: center;
  mask-position: center;
  -webkit-mask-size: contain;
  mask-size: contain;
  font-style: normal;
  flex: none;
}

/* size/text helpers that were previously provided by the icon font */
.fa-lg { font-size: 1.25em; }
.fa-xl { font-size: 1.5em; }
.fa-2x { font-size: 2em; }
.fa-3x { font-size: 3em; }
.fa-fw { text-align: center; inline-size: 1.25em; }

.fa-spin {
  animation: icon-spin 1s linear infinite;
}
@media (prefers-reduced-motion: reduce) {
  .fa-spin { animation: none; }
}
@keyframes icon-spin {
  to { transform: rotate(360deg); }
}

/* Icons that only carry decoration must not be announced separately. */
i[class*='fa-'][aria-hidden='true'] { speak: none; }

${Object.entries(CLASS_ALIASES)
  .map(([cls, icon]) => `.${cls} {\n  -webkit-mask-image: url(icons/${icon}.svg);\n  mask-image: url(icons/${icon}.svg);\n}`)
  .join('\n')}
`
}

export function writeAll(root) {
  const dir = join(root, ICON_DIR_REL)
  mkdirSync(dir, { recursive: true })
  const icons = renderIcons()
  for (const [name, svg] of icons) writeFileSync(join(dir, name), svg, 'utf8')
  writeFileSync(join(root, ICON_CSS_REL), renderCss(), 'utf8')
  return icons.size
}

export function checkAll(root) {
  const problems = []
  const dir = join(root, ICON_DIR_REL)
  for (const [name, svg] of renderIcons()) {
    const p = join(dir, name)
    if (!existsSync(p)) problems.push(`missing: ${name}`)
    else if (readFileSync(p, 'utf8') !== svg) problems.push(`drifted: ${name}`)
  }
  const cssPath = join(root, ICON_CSS_REL)
  if (!existsSync(cssPath)) problems.push(`missing: ${ICON_CSS_REL}`)
  else if (readFileSync(cssPath, 'utf8') !== renderCss()) problems.push('drifted: icons.css')
  if (existsSync(dir)) {
    for (const f of readdirSync(dir)) if (!renderIcons().has(f)) problems.push(`unexpected file: ${f}`)
  }
  return problems
}

export function main(argv = process.argv.slice(2), root = repoRootFromScript()) {
  if (argv.includes('--check')) {
    const problems = checkAll(root)
    if (problems.length) {
      console.error(`[icons] ${problems.length} problem(s):`)
      for (const p of problems) console.error(`  - ${p}`)
      return 1
    }
    console.log(`[icons] ${renderIcons().size} generated icon(s) verified (deterministic, in sync)`)
    return 0
  }
  const n = writeAll(root)
  console.log(`[icons] wrote ${n} original icon(s) + icons.css`)
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = repoRootFromScript()
  const dir = join(root, ICON_DIR_REL)
  if (!process.argv.includes('--check') && existsSync(dir)) {
    for (const f of readdirSync(dir)) unlinkSync(join(dir, f))
  }
  process.exit(main(process.argv.slice(2), root))
}
