// CUS-12 — safe attachment validation.
//
// WHAT MAKES AN ATTACHMENT "SAFE" HERE:
//
//  1. The declared Content-Type must be in a small allowlist (jpeg/png/pdf/text).
//     A browser-declared type is a HINT from an untrusted client.
//  2. The MAGIC BYTES must agree with that declaration. A polyglot or a
//     mislabelled file is rejected — so "I am a JPEG" cannot smuggle an HTML
//     document past the allowlist.
//  3. The size is bounded here as well as by a database CHECK, so a limit
//     cannot be lost by a later code change.
//  4. The bytes are stored under a private prefix and served ONLY with
//     `Content-Disposition: attachment`, `X-Content-Type-Options: nosniff` and a
//     restrictive CSP — a browser never parses one as a page.
//
// The stored object key is generated server-side and never derived from the
// customer's filename, so a hostile name cannot influence where bytes land.
import { PHOTO_POLICY } from '../photo-policy'
import { decodeAndValidateImage } from '../image-decode'

export const SUPPORT_ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024
export const SUPPORT_ATTACHMENT_TYPES = ['image/jpeg', 'image/png', 'application/pdf', 'text/plain'] as const
export type SupportAttachmentType = (typeof SUPPORT_ATTACHMENT_TYPES)[number]

export const SUPPORT_ATTACHMENT_ACCEPT = SUPPORT_ATTACHMENT_TYPES.join(',')

export type AttachmentRejection = { ok: false; code: string; message: string }
export type AttachmentAcceptance = { ok: true; contentType: SupportAttachmentType; bytes: Uint8Array; byteSize: number; extension: string; originalName: string }
export type AttachmentValidation = AttachmentAcceptance | AttachmentRejection

function startsWith(bytes: Uint8Array, signature: number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false
  for (let i = 0; i < signature.length; i++) if (bytes[offset + i] !== signature[i]) return false
  return true
}

/** A filename is stored for display only. No path separators, no control characters, bounded. */
export function safeOriginalName(name: unknown): string {
  return String(name ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/]+/g, '_')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 120)
}

export function isProbablyHtmlOrMarkup(bytes: Uint8Array): boolean {
  // Decode only the head; enough to recognise a document rather than text.
  const head = new TextDecoder('utf-8', { fatal: false, ignoreBOM: false }).decode(bytes.slice(0, 512)).trimStart().toLowerCase()
  return head.startsWith('<!doctype html') || head.startsWith('<html') || head.startsWith('<?xml') || head.startsWith('<svg') || head.startsWith('<script')
}

/**
 * Validates the DECLARED type against the actual bytes. `declaredType` comes from
 * the client and is never trusted on its own; `bytes` is the only real evidence.
 */
export async function validateSupportAttachment(input: { declaredType: string; bytes: Uint8Array; originalName?: string }): Promise<AttachmentValidation> {
  const declared = String(input.declaredType || '').split(';')[0].trim().toLowerCase()
  const bytes = input.bytes
  const originalName = safeOriginalName(input.originalName)

  if (!bytes.length) return { ok: false, code: 'empty_file', message: 'That file is empty.' }
  if (bytes.length > SUPPORT_ATTACHMENT_MAX_BYTES) {
    return { ok: false, code: 'too_large', message: `Attachments must be ${Math.round(SUPPORT_ATTACHMENT_MAX_BYTES / (1024 * 1024))}MB or smaller.` }
  }
  if (!(SUPPORT_ATTACHMENT_TYPES as readonly string[]).includes(declared)) {
    return { ok: false, code: 'unsupported_type', message: `Attachments must be one of: ${SUPPORT_ATTACHMENT_TYPES.join(', ')}.` }
  }

  const isJpeg = startsWith(bytes, [0xff, 0xd8, 0xff])
  const isPng = startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const isPdf = startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d]) // %PDF-

  if (declared === 'image/jpeg') {
    if (!isJpeg) return { ok: false, code: 'type_mismatch', message: 'That file is not a JPEG image (its contents do not match its type).' }
    // A real decode, not just a signature: a truncated or corrupt file is
    // rejected here rather than becoming a support attachment nobody can open.
    const decode = await decodeAndValidateImage(bytes)
    if (!decode.ok) return { ok: false, code: 'image_invalid', message: 'That image could not be read. Please re-export it as a standard JPG.' }
    return { ok: true, contentType: 'image/jpeg', bytes, byteSize: bytes.length, extension: 'jpg', originalName: originalName || 'attachment.jpg' }
  }
  if (declared === 'image/png') {
    if (!isPng) return { ok: false, code: 'type_mismatch', message: 'That file is not a PNG image (its contents do not match its type).' }
    const decode = await decodeAndValidateImage(bytes)
    if (!decode.ok) return { ok: false, code: 'image_invalid', message: 'That image could not be read. Please re-export it as a standard PNG.' }
    return { ok: true, contentType: 'image/png', bytes, byteSize: bytes.length, extension: 'png', originalName: originalName || 'attachment.png' }
  }
  if (declared === 'application/pdf') {
    if (!isPdf) return { ok: false, code: 'type_mismatch', message: 'That file is not a PDF (its contents do not match its type).' }
    return { ok: true, contentType: 'application/pdf', bytes, byteSize: bytes.length, extension: 'pdf', originalName: originalName || 'attachment.pdf' }
  }

  // text/plain: must be valid UTF-8, must contain no NUL, and must not actually
  // be a markup document wearing a text/plain label.
  if (bytes.includes(0)) return { ok: false, code: 'type_mismatch', message: 'That file is not plain text (it contains binary data).' }
  try {
    new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)
  } catch {
    return { ok: false, code: 'type_mismatch', message: 'That file is not valid UTF-8 text.' }
  }
  if (isProbablyHtmlOrMarkup(bytes)) {
    return { ok: false, code: 'type_mismatch', message: 'That file contains markup, which is not accepted as a plain-text attachment.' }
  }
  return { ok: true, contentType: 'text/plain', bytes, byteSize: bytes.length, extension: 'txt', originalName: originalName || 'attachment.txt' }
}

/** A server-generated, customer-name-independent object key under the private support prefix. */
export function supportObjectKey(ticketPublicId: string, extension: string): string {
  const safeTicket = String(ticketPublicId).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40)
  return `support/${safeTicket}/${crypto.randomUUID().replace(/-/g, '')}.${sanitizeExtension(extension)}`
}

function sanitizeExtension(extension: string): string {
  const value = String(extension).toLowerCase().replace(/[^a-z0-9]/g, '')
  return ['jpg', 'jpeg', 'png', 'pdf', 'txt'].includes(value) ? value : 'bin'
}

/** The photo policy an attachment shares with uploads — reported so UI copy matches enforcement. */
export function attachmentPolicySummary() {
  return {
    maxBytes: SUPPORT_ATTACHMENT_MAX_BYTES,
    allowedTypes: [...SUPPORT_ATTACHMENT_TYPES],
    accept: SUPPORT_ATTACHMENT_ACCEPT,
    photoPolicy: PHOTO_POLICY.allowedFormats.slice()
  }
}
