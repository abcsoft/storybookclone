// The single design-system boundary (storefront visual language).
//
// WHY THIS EXISTS
// The storefront's visual language used to be split across two stylesheets that
// had drifted apart (`style.css` carried one homepage look, `storefront.css`
// carried another) plus a third PDP/app layer that was no longer linked at all.
// Colour, spacing and radius values were re-declared per component and
// contradicted each other, which is what made the rendered pages read like a
// test harness rather than a shop.
//
// `public/static/storefront.css` is now the ONE stylesheet that declares the
// tokens. This module is the machine-readable contract for that file: the same
// names and the same values, grouped the same way, so
//   * the template layer can make a visual decision in code
//     (`cardBadge`, `sectionTone`) instead of hard-coding a class name, and
//   * a unit test can fail the build if the CSS and this list ever drift
//     (see test/unit/storefront-design-system.test.ts).
//
// It is deliberately NOT a runtime stylesheet generator: no value here is
// injected into a page. The CSS stays the thing the browser loads; this file is
// the thing the tests and the renderer agree on.

/** Colour tokens. Every one is a plain hex value so the contrast pairs below stay checkable. */
export const COLOR_TOKENS = {
  /** Body text and headings. 13.4:1 on `--c-bg`. */
  '--c-ink': '#231a35',
  /** Secondary text: card meta, section sub-copy. 8.7:1 on `--c-bg`. */
  '--c-ink-2': '#4b3c63',
  /** Muted text: footnotes, disclaimers, captions. 5.4:1 on `--c-bg` (AA for body text). */
  '--c-muted': '#6b5f80',
  /** Warm page background. */
  '--c-bg': '#fffaf4',
  /** Cards, panels, the header. */
  '--c-surface': '#ffffff',
  /** The alternating soft band behind every other section. */
  '--c-surface-2': '#fbf2e7',
  /** Warm hairline: borders and dividers. */
  '--c-line': '#f1e3d3',
  /** Primary action colour. White on it is 7.1:1. */
  '--c-primary': '#6d28d9',
  '--c-primary-strong': '#55189f',
  /** Primary at wash strength, for chips and quiet fills. */
  '--c-primary-soft': '#f4ecff',
  /** Playful accent: the promo strip, highlight badges, the logo mark. Ink on it is 8.2:1. */
  '--c-accent': '#f2a63b',
  '--c-accent-ink': '#7a4a06',
  '--c-accent-soft': '#fdf1dd',
  /** Discount / attention. White on it is 5.4:1. */
  '--c-berry': '#c9245c',
  '--c-berry-soft': '#fdeaef',
  /** Positive state (a tip that works, a saved record). */
  '--c-success': '#0f6b4f',
  '--c-success-soft': '#e6f5ef',
  /** The focus ring colour. Never the ONLY signal: it is always paired with an offset. */
  '--c-ring': '#1d4ed8'
} as const

/** Type scale. Display sizes are fluid so 360px and 1920px need no extra rules. */
export const TYPE_TOKENS = {
  '--fs-xs': '0.78rem',
  '--fs-sm': '0.875rem',
  '--fs-base': '1rem',
  '--fs-lg': '1.125rem',
  '--fs-xl': 'clamp(1.25rem, 1.1rem + 0.6vw, 1.5rem)',
  '--fs-2xl': 'clamp(1.5rem, 1.2rem + 1.4vw, 2rem)',
  '--fs-3xl': 'clamp(1.85rem, 1.35rem + 2.2vw, 2.6rem)',
  '--fs-4xl': 'clamp(2.1rem, 1.45rem + 3vw, 3rem)',
  '--fs-display': 'clamp(2.3rem, 1.4rem + 4.2vw, 3.75rem)',
  '--lh-tight': '1.08',
  '--lh-snug': '1.3',
  '--lh-body': '1.65'
} as const

/** Spacing scale, 4px base, plus the vertical rhythm a section uses. */
export const SPACE_TOKENS = {
  '--sp-1': '0.25rem',
  '--sp-2': '0.5rem',
  '--sp-3': '0.75rem',
  '--sp-4': '1rem',
  '--sp-5': '1.5rem',
  '--sp-6': '2rem',
  '--sp-7': '3rem',
  '--sp-8': '4rem',
  '--sp-9': '5rem',
  '--sp-10': '6.5rem',
  '--section-y': 'clamp(2.75rem, 5vw, 5rem)',
  '--content-max': '1280px',
  '--content-narrow': '760px'
} as const

/** Corner radii. Cards and covers are deliberately softer than form controls. */
export const RADIUS_TOKENS = {
  '--radius-xs': '6px',
  '--radius-sm': '10px',
  '--radius-md': '16px',
  '--radius-lg': '24px',
  '--radius-xl': '32px',
  '--radius-pill': '999px'
} as const

/** Elevation. Warm-tinted, so a shadow never reads as a grey smudge on the cream background. */
export const SHADOW_TOKENS = {
  '--shadow-xs': '0 1px 2px rgba(35, 26, 53, 0.06)',
  '--shadow-sm': '0 2px 10px rgba(35, 26, 53, 0.06)',
  '--shadow-md': '0 14px 32px -14px rgba(53, 29, 92, 0.22)',
  '--shadow-lg': '0 30px 64px -26px rgba(53, 29, 92, 0.32)'
} as const

/** Motion. Every duration is zeroed by the `prefers-reduced-motion` block in the stylesheet. */
export const MOTION_TOKENS = {
  '--dur-1': '120ms',
  '--dur-2': '220ms',
  '--dur-3': '420ms',
  '--ease-1': 'cubic-bezier(0.22, 0.8, 0.25, 1)'
} as const

export const FONT_TOKENS = {
  '--font': "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, 'Noto Sans', sans-serif",
  '--font-display': "ui-serif, Georgia, Cambria, 'Times New Roman', serif",
  '--focus-ring': '3px solid var(--c-ring)'
} as const

/**
 * Every token the stylesheet must declare, flattened. The drift test walks this
 * map and asserts each name is present in `public/static/storefront.css` with
 * exactly this value, so a renamed or re-coloured token cannot be applied to
 * one component and forgotten in the others.
 */
export const DESIGN_TOKENS: Record<string, string> = {
  ...COLOR_TOKENS,
  ...TYPE_TOKENS,
  ...SPACE_TOKENS,
  ...RADIUS_TOKENS,
  ...SHADOW_TOKENS,
  ...MOTION_TOKENS,
  ...FONT_TOKENS
}

// ---------------------------------------------------------------------------
// card badges — a badge is rendered only when the DATA supports it
// ---------------------------------------------------------------------------

export type CardBadge = {
  /** `discount` sits on the cover's leading corner; `flag` on the trailing one. */
  slot: 'discount' | 'flag'
  /** The visible label. */
  label: string
  /** The modifier class that carries the colour. */
  className: string
}

/**
 * Which badges a catalogue card may show, in priority order.
 *
 * `-20%` is derived from the compare-at price the server sends (never a made-up
 * saving). `New` and `Most ordered` are the product's own `new_release` /
 * `bestseller` flags. When a product carries the discount AND a flag, both are
 * shown — one per corner, so they can never paint on top of each other (which
 * is what three absolutely-positioned badges at the same coordinates did).
 *
 * A product with none of those flags gets an unbadged card, not a decorative
 * placeholder badge.
 */
export function cardBadges(p: {
  newRelease?: boolean
  bestseller?: boolean
  /** Integer minor units, or null when the title is not offered in the visitor's currency. */
  priceMinor: number | null
  compareAtMinor: number | null
}): CardBadge[] {
  const badges: CardBadge[] = []
  if (p.priceMinor != null && p.compareAtMinor != null && p.compareAtMinor > p.priceMinor) {
    const percent = Math.round((1 - p.priceMinor / p.compareAtMinor) * 100)
    if (percent > 0) badges.push({ slot: 'discount', label: `-${percent}%`, className: 'badge-sale' })
  }
  if (p.newRelease && !p.bestseller) badges.push({ slot: 'flag', label: 'New', className: 'badge-new' })
  else if (p.bestseller) badges.push({ slot: 'flag', label: 'Most ordered', className: 'badge-best' })
  return badges
}

// ---------------------------------------------------------------------------
// section rhythm — which band a section sits on
// ---------------------------------------------------------------------------

/**
 * The storefront alternates a plain and a soft band so consecutive sections read
 * as separate shelves rather than one long column. The renderer asks for the
 * tone instead of hard-coding `bg-soft` per block kind, which is what kept the
 * homepage from settling into a rhythm when blocks were reordered in the CMS.
 *
 * The homepage order is operator-editable, so the tone is derived from the
 * section's POSITION among the visible sections, not from its kind.
 */
export const SECTION_TONES = ['plain', 'soft'] as const
export type SectionTone = (typeof SECTION_TONES)[number]

export function sectionTone(index: number): SectionTone {
  return SECTION_TONES[Math.abs(index) % SECTION_TONES.length]
}

/** The class list for a section band. `plain` is the page background itself. */
export function sectionClass(tone: SectionTone, extra = ''): string {
  return ['section', tone === 'soft' ? 'section-soft' : '', extra].filter(Boolean).join(' ')
}
