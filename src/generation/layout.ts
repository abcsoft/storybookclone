// Strict validation for the two structured-config columns Phase 3 introduces:
// `book_scenes.layout_json` and `scene_placeholders.constraints_json`.
//
// This module is the ONLY place that interprets those JSON blobs, and it does
// so as DATA: every value is read, range-checked and copied into a
// freshly-built object. Nothing here evaluates, compiles, evals, interprets,
// template-expands or otherwise executes any part of the input, and no field
// is ever used as a regular-expression source, a SQL fragment, an HTML
// fragment or a function name. Unknown keys are REJECTED rather than ignored,
// so a config cannot smuggle an instruction past the reader.
import { DomainError } from './types'

export type SlotConfig = { key: string; box: [number, number, number, number] }

export type OutputConfig = {
  width: number
  height: number
  aspect: string
  printWidthIn: number
  printHeightIn: number
  minPpi: number
}

export type StyleConfig = { palette: string; mood: string }

export type LayoutConfig = {
  slots: SlotConfig[]
  output: OutputConfig
  style: StyleConfig
  subject: string
}

/**
 * Absolute bounds — a template cannot declare an unbounded/absurd canvas.
 *
 * `minDimension` matches the project's one genuine image decoder
 * (src/image-decode.ts, PHOTO_POLICY): a generated page is decoded with the
 * same real decoder as an uploaded photo, so a canvas the decoder would reject
 * is not a canvas this project can verify. 800px is also the floor for a
 * print-usable illustration at the lowest supported PPI.
 */
export const LAYOUT_BOUNDS = {
  minDimension: 800,
  maxDimension: 4000,
  minPrintIn: 0.5,
  maxPrintIn: 30,
  minPpi: 72,
  maxPpi: 600,
  maxSubjectLength: 300,
  maxSlots: 12,
  maxScalarLength: 40
} as const

const LAYOUT_KEYS = new Set(['slots', 'output', 'style', 'subject'])
const OUTPUT_KEYS = new Set(['width', 'height', 'aspect', 'printWidthIn', 'printHeightIn', 'minPpi'])
const STYLE_KEYS = new Set(['palette', 'mood'])
const SLOT_KEYS = new Set(['key', 'box'])

function invalid(message: string): DomainError {
  return new DomainError('invalid_layout_config', `Invalid template layout configuration: ${message}`, 400)
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid(`${what} must be an object.`)
  return value as Record<string, unknown>
}

function rejectUnknownKeys(record: Record<string, unknown>, allowed: Set<string>, what: string) {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) throw invalid(`${what} has an unsupported field "${key}".`)
  }
}

function boundedNumber(value: unknown, min: number, max: number, what: string, integer = false): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN
  if (!Number.isFinite(n)) throw invalid(`${what} must be a finite number.`)
  if (integer && !Number.isInteger(n)) throw invalid(`${what} must be a whole number.`)
  if (n < min || n > max) throw invalid(`${what} must be between ${min} and ${max}.`)
  return n
}

/** Identifier-like tokens (slot keys, palettes, moods, aspect labels). */
function boundedString(value: unknown, maxLength: number, what: string): string {
  const trimmed = requireText(value, maxLength, what)
  if (!/^[A-Za-z0-9 _.:-]+$/.test(trimmed)) throw invalid(`${what} contains unsupported characters.`)
  return trimmed
}

function requireText(value: unknown, maxLength: number, what: string): string {
  if (typeof value !== 'string') throw invalid(`${what} must be a string.`)
  const trimmed = value.trim()
  if (!trimmed) throw invalid(`${what} must not be empty.`)
  if (trimmed.length > maxLength) throw invalid(`${what} must be at most ${maxLength} characters.`)
  // No control characters, newlines or NULs.
  for (let i = 0; i < trimmed.length; i++) {
    const code = trimmed.charCodeAt(i)
    if (code < 0x20 || code === 0x7f) throw invalid(`${what} must not contain control characters.`)
  }
  return trimmed
}

/**
 * A scene SUBJECT is descriptive prose sent to an image model, so commas and
 * apostrophes are legitimate. It is still strictly constrained: no markup or
 * quoting characters (`< > " ' \` | &`), no braces or brackets, no backslash,
 * and explicitly NO `{{`/`}}` sequence — a subject can therefore never smuggle
 * a second prompt token into a prompt template.
 */
function boundedProse(value: unknown, maxLength: number, what: string): string {
  const trimmed = requireText(value, maxLength, what)
  // Checked BEFORE the general character rule, so the message names the real
  // problem: a subject is data, and a `{{...}}` sequence would make it look
  // like a prompt token.
  if (trimmed.includes('{{') || trimmed.includes('}}')) throw invalid(`${what} must not contain a template token.`)
  if (/[<>"'`\|&{}[\]$#;]/.test(trimmed)) throw invalid(`${what} contains unsupported characters.`)
  return trimmed
}

/** Parses a raw JSON string (or already-parsed value) into a validated LayoutConfig. */
export function parseLayoutConfig(input: string | unknown): LayoutConfig {
  let parsed: unknown = input
  if (typeof input === 'string') {
    try {
      parsed = JSON.parse(input)
    } catch {
      throw invalid('the layout is not valid JSON.')
    }
  }
  const root = asRecord(parsed, 'layout')
  rejectUnknownKeys(root, LAYOUT_KEYS, 'layout')

  if (!Array.isArray(root.slots) || root.slots.length === 0) throw invalid('slots must be a non-empty array.')
  if (root.slots.length > LAYOUT_BOUNDS.maxSlots) throw invalid(`slots must contain at most ${LAYOUT_BOUNDS.maxSlots} entries.`)
  const slots: SlotConfig[] = root.slots.map((raw, index) => {
    const slot = asRecord(raw, `slots[${index}]`)
    rejectUnknownKeys(slot, SLOT_KEYS, `slots[${index}]`)
    const key = boundedString(slot.key, LAYOUT_BOUNDS.maxScalarLength, `slots[${index}].key`)
    if (!Array.isArray(slot.box) || slot.box.length !== 4) throw invalid(`slots[${index}].box must be an array of 4 numbers.`)
    const box = slot.box.map((v, i) => boundedNumber(v, 0, 1, `slots[${index}].box[${i}]`)) as [number, number, number, number]
    if (box[2] <= 0 || box[3] <= 0) throw invalid(`slots[${index}].box width and height must be positive.`)
    if (box[0] + box[2] > 1 || box[1] + box[3] > 1) throw invalid(`slots[${index}].box must stay inside the page.`)
    return { key, box }
  })
  const slotKeys = new Set(slots.map((s) => s.key))
  if (slotKeys.size !== slots.length) throw invalid('slot keys must be unique.')

  const outputRaw = asRecord(root.output, 'output')
  rejectUnknownKeys(outputRaw, OUTPUT_KEYS, 'output')
  const width = boundedNumber(outputRaw.width, LAYOUT_BOUNDS.minDimension, LAYOUT_BOUNDS.maxDimension, 'output.width', true)
  const height = boundedNumber(outputRaw.height, LAYOUT_BOUNDS.minDimension, LAYOUT_BOUNDS.maxDimension, 'output.height', true)
  const printWidthIn = boundedNumber(outputRaw.printWidthIn, LAYOUT_BOUNDS.minPrintIn, LAYOUT_BOUNDS.maxPrintIn, 'output.printWidthIn')
  const printHeightIn = boundedNumber(outputRaw.printHeightIn, LAYOUT_BOUNDS.minPrintIn, LAYOUT_BOUNDS.maxPrintIn, 'output.printHeightIn')
  const minPpi = boundedNumber(outputRaw.minPpi, LAYOUT_BOUNDS.minPpi, LAYOUT_BOUNDS.maxPpi, 'output.minPpi', true)
  const aspect = boundedString(outputRaw.aspect, LAYOUT_BOUNDS.maxScalarLength, 'output.aspect')
  // The declared aspect must actually agree with the declared pixel canvas —
  // otherwise "aspect ratio validation" would be validating a label rather
  // than the real geometry.
  const declared = aspect.split(':').map((p) => Number(p))
  if (declared.length !== 2 || !declared.every((n) => Number.isFinite(n) && n > 0)) throw invalid('output.aspect must look like "4:5".')
  const declaredRatio = declared[0] / declared[1]
  if (Math.abs(declaredRatio - width / height) > 0.01) {
    throw invalid(`output.aspect (${aspect}) does not match the declared canvas (${width}x${height}).`)
  }
  // A layout whose own print geometry cannot reach its own declared minimum
  // PPI is self-contradictory: it would be impossible to generate an output
  // that passes this scene's own print-resolution check. Rejecting it here
  // means the failure surfaces while editing a draft, not mid-generation.
  const effectivePpi = Math.min(width / printWidthIn, height / printHeightIn)
  if (effectivePpi < minPpi) {
    throw invalid(
      `output cannot reach its declared minimum of ${minPpi} PPI: ${width}x${height} pixels over ${printWidthIn}x${printHeightIn} inches is ${Math.round(effectivePpi)} PPI.`
    )
  }

  const styleRaw = asRecord(root.style, 'style')
  rejectUnknownKeys(styleRaw, STYLE_KEYS, 'style')

  return {
    slots,
    output: { width, height, aspect, printWidthIn, printHeightIn, minPpi },
    style: {
      palette: boundedString(styleRaw.palette, LAYOUT_BOUNDS.maxScalarLength, 'style.palette'),
      mood: boundedString(styleRaw.mood, LAYOUT_BOUNDS.maxScalarLength, 'style.mood')
    },
    subject: boundedProse(root.subject, LAYOUT_BOUNDS.maxSubjectLength, 'subject')
  }
}

/** The only `source` values a text placeholder may declare. */
export const PLACEHOLDER_SOURCES = ['child_name', 'child_age', 'dedication', 'generated_story', 'selected_face', 'static_asset', 'language'] as const
export type PlaceholderSource = (typeof PLACEHOLDER_SOURCES)[number]

export type PlaceholderConstraints = {
  source?: PlaceholderSource
  maxLength?: number
  minLength?: number
  maxWords?: number
  minWords?: number
  minConfidence?: number
  assetKey?: string
  mimeType?: string
}

const CONSTRAINT_KEYS = new Set(['source', 'maxLength', 'minLength', 'maxWords', 'minWords', 'minConfidence', 'assetKey', 'mimeType'])

/**
 * Parses `constraints_json`. Every constraint is a plain scalar bound that
 * application code compares numbers against — never a pattern, a script, or a
 * reference to code.
 */
export function parsePlaceholderConstraints(input: string | unknown): PlaceholderConstraints {
  let parsed: unknown = input
  if (typeof input === 'string') {
    const trimmed = input.trim()
    if (!trimmed) return {}
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      throw new DomainError('invalid_placeholder_constraints', 'Invalid placeholder constraints: not valid JSON.', 400)
    }
  }
  if (parsed === null || parsed === undefined) return {}
  const record = asRecord(parsed, 'constraints')
  rejectUnknownKeys(record, CONSTRAINT_KEYS, 'constraints')

  const out: PlaceholderConstraints = {}
  if (record.source !== undefined) {
    const source = String(record.source)
    if (!(PLACEHOLDER_SOURCES as readonly string[]).includes(source)) {
      throw new DomainError('invalid_placeholder_constraints', `Invalid placeholder source "${source}".`, 400)
    }
    out.source = source as PlaceholderSource
  }
  const numberKeys: Array<[keyof PlaceholderConstraints, number, number]> = [
    ['maxLength', 0, 10_000],
    ['minLength', 0, 10_000],
    ['maxWords', 0, 2_000],
    ['minWords', 0, 2_000],
    ['minConfidence', 0, 1]
  ]
  for (const [key, min, max] of numberKeys) {
    if (record[key] !== undefined) {
      const value = typeof record[key] === 'number' ? (record[key] as number) : Number(record[key])
      if (!Number.isFinite(value) || value < min || value > max) {
        throw new DomainError('invalid_placeholder_constraints', `Constraint "${key}" must be between ${min} and ${max}.`, 400)
      }
      out[key] = value as never
    }
  }
  // A min above its own max is a contradictory contract, not a preference.
  if (out.minLength !== undefined && out.maxLength !== undefined && out.minLength > out.maxLength) {
    throw new DomainError('invalid_placeholder_constraints', 'minLength must not exceed maxLength.', 400)
  }
  if (out.minWords !== undefined && out.maxWords !== undefined && out.minWords > out.maxWords) {
    throw new DomainError('invalid_placeholder_constraints', 'minWords must not exceed maxWords.', 400)
  }
  for (const key of ['assetKey', 'mimeType'] as const) {
    if (record[key] !== undefined) {
      const value = String(record[key]).trim()
      if (!value || value.length > 200) throw new DomainError('invalid_placeholder_constraints', `Constraint "${key}" must be a short non-empty string.`, 400)
      out[key] = value
    }
  }
  return out
}

/** Word count used by the text-output validators (whitespace-delimited, never a regex on user input). */
export function wordCount(text: string): number {
  const trimmed = text.trim()
  if (!trimmed) return 0
  return trimmed.split(/\s+/).length
}
