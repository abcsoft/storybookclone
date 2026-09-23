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
  /** Body text and headings: Midnight. */
  '--c-ink': '#11184b',
  /** Secondary text: dark purple ink. */
  '--c-ink-2': '#2a2050',
  /** Muted text: sub-copy, helper text, footnotes. */
  '--c-muted': '#5e647c',
  /** Warm page background: Warm Ivory. */
  '--c-bg': '#fff9f1',
  /** Cards, panels, inputs: White. */
  '--c-surface': '#ffffff',
  /** Soft alternating band: Soft Peach. */
  '--c-surface-2': '#fff0e2',
  /** Sky tint section band. */
  '--c-sky': '#eaf6ff',
  /** Borders and dividers: Border. */
  '--c-line': '#e8e2db',
  /** Primary action colour: Royal Purple. */
  '--c-primary': '#6c2cf1',
  '--c-primary-strong': '#5620d8',
  '--c-primary-pressed': '#4317b5',
  /** Primary at wash strength: Purple Mist. */
  '--c-primary-soft': '#f1eaff',
  /** Playful accent: Golden Gold. */
  '--c-accent': '#ffb823',
  '--c-accent-ink': '#7a4a06',
  '--c-accent-soft': '#fff0e2',
  /** Delight / attention: Coral. */
  '--c-berry': '#ff6478',
  '--c-berry-soft': '#fff0e2',
  /** Positive state: Mint. */
  '--c-success': '#39c992',
  '--c-success-soft': '#eaf8f2',
  /** Error state. */
  '--c-error': '#c9364f',
  /** The focus ring colour: Gold. */
  '--c-ring': '#ffb823'
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
  '--lh-tight': '1.12',
  '--lh-snug': '1.3',
  '--lh-body': '1.55'
} as const

/** Spacing scale, 4px base, plus the vertical rhythm a section uses. */
export const SPACE_TOKENS = {
  '--sp-1': '0.25rem',
  '--sp-2': '0.5rem',
  '--sp-3': '0.75rem',
  '--sp-4': '1rem',
  '--sp-5': '1.25rem',
  '--sp-6': '1.5rem',
  '--sp-7': '2rem',
  '--sp-8': '3rem',
  '--sp-9': '4rem',
  '--sp-10': '6rem',
  '--section-y': 'clamp(2.5rem, 5vw, 4rem)',
  '--content-max': '1240px',
  '--content-narrow': '760px'
} as const

/** Corner radii matching the design pack scale. */
export const RADIUS_TOKENS = {
  '--radius-xs': '6px',
  '--radius-sm': '8px',
  '--radius-md': '12px',
  '--radius-control': '12px',
  '--radius-card': '16px',
  '--radius-lg': '16px',
  '--radius-feature': '24px',
  '--radius-xl': '24px',
  '--radius-pill': '999px'
} as const

/** Elevation: soft, warm-tinted shadows from design pack. */
export const SHADOW_TOKENS = {
  '--shadow-xs': '0 1px 2px rgb(17 24 75 / 0.05)',
  '--shadow-sm': '0 2px 10px rgb(17 24 75 / 0.07)',
  '--shadow-card': '0 2px 10px rgb(17 24 75 / 0.07)',
  '--shadow-md': '0 10px 24px -10px rgb(17 24 75 / 0.10)',
  '--shadow-raised': '0 14px 36px rgb(17 24 75 / 0.12)',
  '--shadow-lg': '0 14px 36px rgb(17 24 75 / 0.12)'
} as const

/** Motion. Every duration is zeroed by the `prefers-reduced-motion` block in the stylesheet. */
export const MOTION_TOKENS = {
  '--dur-1': '120ms',
  '--dur-2': '180ms',
  '--dur-3': '320ms',
  '--ease-1': 'ease'
} as const

export const FONT_TOKENS = {
  '--font': '"Inter", system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  '--font-ui': '"Inter", system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  '--font-display': '"Fraunces", Georgia, Cambria, "Times New Roman", serif',
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
export const SECTION_TONES = ['plain', 'soft', 'sky', 'plain', 'soft', 'mist'] as const
export type SectionTone = (typeof SECTION_TONES)[number]

export function sectionTone(index: number): SectionTone {
  return SECTION_TONES[Math.abs(index) % SECTION_TONES.length]
}

/** The class list for a section band. `plain` is the page background itself. */
export function sectionClass(tone: SectionTone, extra = ''): string {
  const toneClass =
    tone === 'soft'
      ? 'section-soft'
      : tone === 'sky'
        ? 'section-sky'
        : tone === 'mist'
          ? 'section-mist'
          : ''
  return ['section', toneClass, extra].filter(Boolean).join(' ')
}
