#!/usr/bin/env node
// Original artwork generator (V2 Phase 2, SF-01).
//
// WHY THIS EXISTS
// The storefront previously shipped the reference catalogue's marketing
// photography and cover artwork — including photographs of real children —
// plus third-party press logos. None of that is licensed to this project and
// none of it may be copied. This script authors a REPLACEMENT set from
// scratch: every file it writes under `public/static/art/` is generated from
// the geometric primitives below, is deterministic (same input -> same bytes)
// and contains no third-party image, logo, character, title or trademark.
//
// The motifs are deliberately abstract (layered landscape bands, geometric
// props, soft gradients). They read as a cohesive illustrated system at card,
// hero and thumbnail sizes without depicting any real person or property.
//
// Usage: node scripts/generate-original-art.mjs [--check]
//   --check  verify the committed files match what the generator produces
//            (used by the test suite so art can never silently drift).

import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, unlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const repoRootFromScript = (url = import.meta.url) => resolve(dirname(fileURLToPath(url)), '..')
export const ART_DIR_REL = join('public', 'static', 'img', 'art')

// ---------------------------------------------------------------------------
// deterministic PRNG (mulberry32) — no Math.random, so output is reproducible
// ---------------------------------------------------------------------------
function rng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function hashSeed(str) {
  let h = 2166136261
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

// ---------------------------------------------------------------------------
// palettes — one per story theme family
// ---------------------------------------------------------------------------
const P = {
  night:      { sky: ['#1b2a5e', '#3b4d8f'], far: '#4b5fa8', mid: '#33447f', near: '#232f5c', accent: '#ffd166', ink: '#0f1733' },
  dawn:       { sky: ['#ffd6a5', '#ffb4a2'], far: '#ffc9a0', mid: '#f29f7b', near: '#c9745c', accent: '#7b3f5e', ink: '#4a2436' },
  meadow:     { sky: ['#d8f3dc', '#95d5b2'], far: '#74c69d', mid: '#52b788', near: '#2d6a4f', accent: '#ffd166', ink: '#1b4332' },
  sea:        { sky: ['#caf0f8', '#90e0ef'], far: '#48cae4', mid: '#0096c7', near: '#023e8a', accent: '#ffe066', ink: '#03045e' },
  snow:       { sky: ['#e7f0ff', '#bcd4f6'], far: '#9db9e8', mid: '#7d9ad6', near: '#4f6bb0', accent: '#ffffff', ink: '#22305c' },
  space:      { sky: ['#150a33', '#2b1b5e'], far: '#3d2a7a', mid: '#2a1c56', near: '#1a1140', accent: '#ffd166', ink: '#0a0620' },
  sunset:     { sky: ['#ffe8a3', '#ffb37b'], far: '#f79d65', mid: '#e2715f', near: '#a33b56', accent: '#3f2a56', ink: '#3a1f2e' },
  forest:     { sky: ['#e4f1d5', '#b7dfa4'], far: '#8ec97c', mid: '#5aa35f', near: '#2f6b46', accent: '#ffd166', ink: '#1d4029' },
  clinic:     { sky: ['#e3f6f5', '#b8e6e0'], far: '#8bd3cb', mid: '#5bb8ae', accent: '#ff9f68', ink: '#1d4b46' },
  ember:      { sky: ['#ffe0c2', '#ffb26b'], far: '#f08c3c', mid: '#c9542c', near: '#8c2f26', accent: '#4a4e69', ink: '#3a1a15' },
  candy:      { sky: ['#ffe5f1', '#ffc2dd'], far: '#ff9ec6', mid: '#ef6fa8', near: '#b93f81', accent: '#ffd166', ink: '#5b1944' },
  paper:      { sky: ['#fdf6e3', '#f3e3c3'], far: '#e6d3ae', mid: '#d3b98a', near: '#a98e60', accent: '#5b8def', ink: '#4a3f28' }
}

const SIZES = {
  cover: { w: 600, h: 600 },
  wide: { w: 960, h: 540 },
  hero: { w: 720, h: 560 },
  tile: { w: 640, h: 420 },
  sheet: { w: 600, h: 600 },
  square: { w: 512, h: 512 },
  og: { w: 1200, h: 630 },
  thumb: { w: 240, h: 240 },
  icon: { w: 64, h: 64 }
}

// ---------------------------------------------------------------------------
// primitive emitters
// ---------------------------------------------------------------------------
const r2 = (n) => Math.round(n * 100) / 100

function layerBands({ w, h, palette, seed, count = 3 }) {
  const rand = rng(seed)
  const out = []
  for (let i = 0; i < count; i++) {
    const y = h * (0.52 + i * 0.16)
    const amp = h * (0.05 + i * 0.015)
    const color = i === 0 ? palette.far : i === 1 ? palette.mid : palette.near
    let d = `M0 ${r2(y)}`
    const steps = 6
    for (let s = 1; s <= steps; s++) {
      const x = (w / steps) * s
      const yy = y + Math.sin((s + i * 2 + rand()) * 1.1) * amp
      d += ` Q ${r2(x - w / (steps * 2))} ${r2(yy - amp)} ${r2(x)} ${r2(yy)}`
    }
    d += ` L ${w} ${h} L 0 ${h} Z`
    out.push(`<path d="${d}" fill="${color}"/>`)
  }
  return out.join('')
}

function sky({ w, h, palette, seed, id }) {
  return `<defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">
<stop offset="0" stop-color="${palette.sky[0]}"/><stop offset="1" stop-color="${palette.sky[1]}"/>
</linearGradient></defs><rect width="${w}" height="${h}" fill="url(#${id})"/>`
}

function sunOrMoon({ w, h, palette, seed, kind = 'sun', x = 0.76, y = 0.22, r = 0.09 }) {
  const cx = w * x
  const cy = h * y
  const rr = Math.min(w, h) * r
  if (kind === 'moon') {
    return `<circle cx="${r2(cx)}" cy="${r2(cy)}" r="${r2(rr)}" fill="${palette.accent}" opacity="0.95"/>
<circle cx="${r2(cx + rr * 0.55)}" cy="${r2(cy - rr * 0.25)}" r="${r2(rr * 0.92)}" fill="${palette.sky[0]}" opacity="0.9"/>`
  }
  const rays = Array.from({ length: 12 }, (_, i) => {
    const a = (Math.PI * 2 * i) / 12
    const x1 = cx + Math.cos(a) * rr * 1.35
    const y1 = cy + Math.sin(a) * rr * 1.35
    const x2 = cx + Math.cos(a) * rr * 1.75
    const y2 = cy + Math.sin(a) * rr * 1.75
    return `<line x1="${r2(x1)}" y1="${r2(y1)}" x2="${r2(x2)}" y2="${r2(y2)}" stroke="${palette.accent}" stroke-width="${r2(rr * 0.16)}" stroke-linecap="round" opacity="0.75"/>`
  }).join('')
  return `${rays}<circle cx="${r2(cx)}" cy="${r2(cy)}" r="${r2(rr)}" fill="${palette.accent}"/>`
}

function starField({ w, h, palette, seed, count = 26 }) {
  const rand = rng(seed + 7)
  return Array.from({ length: count }, () => {
    const x = rand() * w
    const y = rand() * h * 0.6
    const s = 1.2 + rand() * 2.4
    return `<circle cx="${r2(x)}" cy="${r2(y)}" r="${r2(s)}" fill="${palette.accent}" opacity="${r2(0.35 + rand() * 0.6)}"/>`
  }).join('')
}

function sparkle(x, y, s, color, opacity = 0.9) {
  const d = `M${x} ${y - s} L${x + s * 0.28} ${y - s * 0.28} L${x + s} ${y} L${x + s * 0.28} ${y + s * 0.28} L${x} ${y + s} L${x - s * 0.28} ${y + s * 0.28} L${x - s} ${y} L${x - s * 0.28} ${y - s * 0.28} Z`
  return `<path d="${r2(d)}" fill="${color}" opacity="${opacity}"/>`
}

function clouds({ w, h, palette, seed, count = 3 }) {
  const rand = rng(seed + 11)
  return Array.from({ length: count }, (_, i) => {
    const cx = w * (0.12 + rand() * 0.76)
    const cy = h * (0.12 + rand() * 0.22)
    const s = Math.min(w, h) * (0.06 + rand() * 0.05)
    return `<g opacity="0.85" transform="translate(${r2(cx)} ${r2(cy)})">
<ellipse cx="0" cy="0" rx="${r2(s)}" ry="${r2(s * 0.62)}" fill="#ffffff"/>
<ellipse cx="${r2(s * 0.85)}" cy="${r2(s * 0.12)}" rx="${r2(s * 0.68)}" ry="${r2(s * 0.48)}" fill="#ffffff"/>
<ellipse cx="${r2(-s * 0.8)}" cy="${r2(s * 0.16)}" rx="${r2(s * 0.6)}" ry="${r2(s * 0.44)}" fill="#ffffff"/>
</g>`
  }).join('')
}

function tree(x, baseY, s, trunk, leaf) {
  return `<g transform="translate(${r2(x)} ${r2(baseY)})">
<rect x="${r2(-s * 0.1)}" y="${r2(-s * 0.9)}" width="${r2(s * 0.2)}" height="${r2(s * 0.9)}" fill="${trunk}" rx="${r2(s * 0.06)}"/>
<circle cx="0" cy="${r2(-s * 1.05)}" r="${r2(s * 0.55)}" fill="${leaf}"/>
<circle cx="${r2(-s * 0.42)}" cy="${r2(-s * 0.78)}" r="${r2(s * 0.42)}" fill="${leaf}"/>
<circle cx="${r2(s * 0.42)}" cy="${r2(-s * 0.78)}" r="${r2(s * 0.42)}" fill="${leaf}"/>
</g>`
}

function pine(x, baseY, s, color, ink) {
  return `<g transform="translate(${r2(x)} ${r2(baseY)})">
<rect x="${r2(-s * 0.07)}" y="${r2(-s * 0.5)}" width="${r2(s * 0.14)}" height="${r2(s * 0.5)}" fill="${ink}" opacity="0.6"/>
<path d="M0 ${r2(-s * 1.9)} L ${r2(s * 0.5)} ${r2(-s * 0.5)} L ${r2(-s * 0.5)} ${r2(-s * 0.5)} Z" fill="${color}"/>
<path d="M0 ${r2(-s * 2.45)} L ${r2(s * 0.36)} ${r2(-s * 1.15)} L ${r2(-s * 0.36)} ${r2(-s * 1.15)} Z" fill="${color}"/>
</g>`
}

function bookProp(x, y, s, palette) {
  return `<g transform="translate(${r2(x)} ${r2(y)}) rotate(-6)">
<rect x="${r2(-s / 2)}" y="${r2(-s * 0.36)}" width="${s}" height="${r2(s * 0.72)}" rx="${r2(s * 0.05)}" fill="${palette.accent}"/>
<rect x="${r2(-s / 2)}" y="${r2(-s * 0.36)}" width="${r2(s * 0.06)}" height="${r2(s * 0.72)}" fill="${palette.ink}" opacity="0.35"/>
<path d="M0 ${r2(-s * 0.34)} Q ${r2(s * 0.22)} ${r2(-s * 0.44)} ${r2(s * 0.46)} ${r2(-s * 0.3)} L ${r2(s * 0.46)} ${r2(s * 0.32)} Q ${r2(s * 0.22)} ${r2(s * 0.18)} 0 ${r2(s * 0.3)} Z" fill="#ffffff" opacity="0.92"/>
</g>`
}

function rocket(x, y, s, palette) {
  return `<g transform="translate(${r2(x)} ${r2(y)})">
<path d="M0 ${r2(-s)} Q ${r2(s * 0.42)} ${r2(-s * 0.2)} ${r2(s * 0.3)} ${r2(s * 0.45)} L ${r2(-s * 0.3)} ${r2(s * 0.45)} Q ${r2(-s * 0.42)} ${r2(-s * 0.2)} 0 ${r2(-s)} Z" fill="#f4f7ff"/>
<circle cx="0" cy="${r2(-s * 0.28)}" r="${r2(s * 0.16)}" fill="${palette.mid}"/>
<path d="M${r2(-s * 0.3)} ${r2(s * 0.2)} L ${r2(-s * 0.55)} ${r2(s * 0.6)} L ${r2(-s * 0.28)} ${r2(s * 0.45)} Z" fill="${palette.accent}"/>
<path d="M${r2(s * 0.3)} ${r2(s * 0.2)} L ${r2(s * 0.55)} ${r2(s * 0.6)} L ${r2(s * 0.28)} ${r2(s * 0.45)} Z" fill="${palette.accent}"/>
<path d="M${r2(-s * 0.14)} ${r2(s * 0.46)} Q 0 ${r2(s * 0.95)} ${r2(s * 0.14)} ${r2(s * 0.46)} Z" fill="#ff9f1c"/>
</g>`
}

function boat(x, y, s, palette) {
  return `<g transform="translate(${r2(x)} ${r2(y)})">
<path d="M${r2(-s * 0.7)} 0 L ${r2(s * 0.7)} 0 L ${r2(s * 0.45)} ${r2(s * 0.34)} L ${r2(-s * 0.45)} ${r2(s * 0.34)} Z" fill="${palette.ink}"/>
<rect x="${r2(-s * 0.05)}" y="${r2(-s * 0.95)}" width="${r2(s * 0.1)}" height="${r2(s * 0.95)}" fill="${palette.ink}"/>
<path d="M${r2(s * 0.05)} ${r2(-s * 0.9)} L ${r2(s * 0.62)} ${r2(-s * 0.12)} L ${r2(s * 0.05)} ${r2(-s * 0.12)} Z" fill="${palette.accent}"/>
<path d="M${r2(-s * 0.06)} ${r2(-s * 0.8)} L ${r2(-s * 0.6)} ${r2(-s * 0.12)} L ${r2(-s * 0.06)} ${r2(-s * 0.12)} Z" fill="#ffffff" opacity="0.9"/>
</g>`
}

function plane(x, y, s, palette) {
  return `<g transform="translate(${r2(x)} ${r2(y)})">
<path d="M${r2(-s)} ${r2(s * 0.16)} L ${r2(s)} 0 L ${r2(-s * 0.25)} ${r2(-s * 0.34)} Z" fill="#ffffff"/>
<path d="M${r2(-s * 0.25)} ${r2(-s * 0.34)} L ${r2(-s * 0.62)} ${r2(-s * 0.1)} L ${r2(-s * 0.12)} ${r2(-s * 0.02)} Z" fill="${palette.accent}"/>
<circle cx="${r2(-s * 0.62)}" cy="${r2(s * 0.07)}" r="${r2(s * 0.07)}" fill="${palette.ink}" opacity="0.5"/>
</g>`
}

function kite(x, y, s, palette) {
  return `<g transform="translate(${r2(x)} ${r2(y)})">
<path d="M0 ${r2(-s)} L ${r2(s * 0.62)} 0 L 0 ${r2(s)} L ${r2(-s * 0.62)} 0 Z" fill="${palette.accent}"/>
<path d="M0 ${r2(-s)} L 0 ${r2(s)} M ${r2(-s * 0.62)} 0 L ${r2(s * 0.62)} 0" stroke="${palette.ink}" stroke-width="${r2(s * 0.05)}" opacity="0.4"/>
<path d="M0 ${r2(s)} Q ${r2(s * 0.2)} ${r2(s * 1.5)} ${r2(-s * 0.1)} ${r2(s * 2)}" stroke="${palette.ink}" stroke-width="${r2(s * 0.04)}" fill="none" opacity="0.55"/>
</g>`
}

function lantern(x, y, s, palette) {
  return `<g transform="translate(${r2(x)} ${r2(y)})">
<path d="M${r2(-s * 0.34)} ${r2(-s * 0.5)} Q 0 ${r2(-s * 1.05)} ${r2(s * 0.34)} ${r2(-s * 0.5)}" stroke="${palette.ink}" stroke-width="${r2(s * 0.06)}" fill="none"/>
<rect x="${r2(-s * 0.42)}" y="${r2(-s * 0.5)}" width="${r2(s * 0.84)}" height="${r2(s)}" rx="${r2(s * 0.14)}" fill="${palette.accent}" opacity="0.35"/>
<rect x="${r2(-s * 0.34)}" y="${r2(-s * 0.44)}" width="${r2(s * 0.68)}" height="${r2(s * 0.88)}" rx="${r2(s * 0.1)}" fill="#fff3c4"/>
<circle cx="0" cy="${r2(s * 0.02)}" r="${r2(s * 0.18)}" fill="#ffb703"/>
<rect x="${r2(-s * 0.46)}" y="${r2(-s * 0.58)}" width="${r2(s * 0.92)}" height="${r2(s * 0.12)}" rx="${r2(s * 0.05)}" fill="${palette.ink}"/>
<rect x="${r2(-s * 0.46)}" y="${r2(s * 0.46)}" width="${r2(s * 0.92)}" height="${r2(s * 0.14)}" rx="${r2(s * 0.05)}" fill="${palette.ink}"/>
</g>`
}

function drum(x, y, s, palette) {
  return `<g transform="translate(${r2(x)} ${r2(y)})">
<ellipse cx="0" cy="${r2(-s * 0.62)}" rx="${r2(s * 0.8)}" ry="${r2(s * 0.24)}" fill="${palette.accent}"/>
<path d="M${r2(-s * 0.8)} ${r2(-s * 0.62)} L ${r2(-s * 0.8)} ${r2(s * 0.5)} Q 0 ${r2(s * 1.05)} ${r2(s * 0.8)} ${r2(s * 0.5)} L ${r2(s * 0.8)} ${r2(-s * 0.62)} Z" fill="#f6e0b5"/>
<path d="M${r2(-s * 0.8)} ${r2(s * 0.05)} L ${r2(s * 0.8)} ${r2(s * 0.05)}" stroke="${palette.ink}" stroke-width="${r2(s * 0.1)}"/>
</g>`
}

function moonGarden(x, baseY, s, palette) {
  const flower = (fx, fs) => `<g transform="translate(${r2(fx)} ${r2(baseY)})">
<rect x="${r2(-fs * 0.05)}" y="${r2(-fs * 0.85)}" width="${r2(fs * 0.1)}" height="${r2(fs * 0.85)}" fill="${palette.near}"/>
${Array.from({ length: 6 }, (_, i) => {
  const a = (Math.PI * 2 * i) / 6
  return `<circle cx="${r2(Math.cos(a) * fs * 0.28)}" cy="${r2(-fs * 0.95 + Math.sin(a) * fs * 0.28)}" r="${r2(fs * 0.2)}" fill="#ffffff" opacity="0.92"/>`
}).join('')}
<circle cx="0" cy="${r2(-fs * 0.95)}" r="${r2(fs * 0.16)}" fill="${palette.accent}"/>
</g>`
  return [0.16, 0.34, 0.5, 0.68, 0.86].map((f, i) => flower(x + s * (f - 0.5) * 2.2, s * (0.55 + (i % 2) * 0.2))).join('')
}

function snowFox(x, baseY, s, palette) {
  return `<g transform="translate(${r2(x)} ${r2(baseY)})">
<ellipse cx="0" cy="0" rx="${r2(s * 0.9)}" ry="${r2(s * 0.52)}" fill="#ffffff"/>
<circle cx="${r2(s * 0.78)}" cy="${r2(-s * 0.3)}" r="${r2(s * 0.38)}" fill="#ffffff"/>
<path d="M${r2(s * 0.6)} ${r2(-s * 0.6)} L ${r2(s * 0.72)} ${r2(-s * 1.05)} L ${r2(s * 0.92)} ${r2(-s * 0.56)} Z" fill="#ffffff"/>
<path d="M${r2(s * 0.96)} ${r2(-s * 0.62)} L ${r2(s * 1.06)} ${r2(-s * 1.05)} L ${r2(s * 1.2)} ${r2(-s * 0.5)} Z" fill="#ffffff"/>
<circle cx="${r2(s * 0.95)}" cy="${r2(-s * 0.34)}" r="${r2(s * 0.05)}" fill="${palette.ink}"/>
<circle cx="${r2(s * 0.68)}" cy="${r2(-s * 0.34)}" r="${r2(s * 0.05)}" fill="${palette.ink}"/>
<path d="M${r2(-s * 0.95)} ${r2(-s * 0.2)} Q ${r2(-s * 1.5)} ${r2(-s * 0.6)} ${r2(-s * 1.75)} ${r2(-s * 0.12)} Q ${r2(-s * 1.3)} ${r2(s * 0.1)} ${r2(-s * 0.9)} ${r2(s * 0.16)} Z" fill="#ffffff"/>
<circle cx="${r2(s * 1.06)}" cy="${r2(-s * 0.42)}" r="${r2(s * 0.06)}" fill="${palette.accent}"/>
<g transform="translate(${r2(-s * 0.2)} ${r2(s * 0.4)})">
<path d="M${r2(-s * 0.3)} 0 Q ${r2(-s * 0.6)} ${r2(s * 0.5)} ${r2(-s * 0.9)} ${r2(s * 0.62)}" stroke="${palette.mid}" stroke-width="${r2(s * 0.1)}" fill="none" stroke-linecap="round"/>
<path d="M${r2(s * 0.4)} 0 Q ${r2(s * 0.7)} ${r2(s * 0.5)} ${r2(s)} ${r2(s * 0.62)}" stroke="${palette.mid}" stroke-width="${r2(s * 0.1)}" fill="none" stroke-linecap="round"/>
</g>
</g>`
}

function whale(x, y, s, palette) {
  return `<g transform="translate(${r2(x)} ${r2(y)})">
<path d="M${r2(-s)} 0 Q ${r2(-s * 0.3)} ${r2(-s * 0.72)} ${r2(s * 0.45)} ${r2(-s * 0.34)} Q ${r2(s * 0.9)} ${r2(-s * 0.2)} ${r2(s * 0.78)} ${r2(s * 0.06)} Q ${r2(s * 0.3)} ${r2(s * 0.55)} ${r2(-s * 0.55)} ${r2(s * 0.3)} Z" fill="${palette.mid}"/>
<path d="M${r2(s * 0.78)} ${r2(s * 0.02)} Q ${r2(s * 1.15)} ${r2(-s * 0.5)} ${r2(s * 1.4)} ${r2(-s * 0.5)} Q ${r2(s * 1.15)} ${r2(s * 0.1)} ${r2(s * 1.16)} ${r2(s * 0.36)} Z" fill="${palette.mid}"/>
<circle cx="${r2(-s * 0.55)}" cy="${r2(-s * 0.12)}" r="${r2(s * 0.07)}" fill="#ffffff"/>
<path d="M${r2(-s * 0.62)} ${r2(-s * 0.3)} Q ${r2(-s * 0.42)} ${r2(-s * 0.85)} ${r2(-s * 0.2)} ${r2(-s * 0.5)}" stroke="#cfefff" stroke-width="${r2(s * 0.06)}" fill="none" opacity="0.9"/>
</g>`
}

function dino(x, baseY, s, palette) {
  return `<g transform="translate(${r2(x)} ${r2(baseY)})">
<path d="M${r2(-s * 0.75)} 0 Q ${r2(-s * 0.95)} ${r2(-s * 0.8)} ${r2(-s * 0.3)} ${r2(-s * 1)} Q ${r2(s * 0.2)} ${r2(-s * 1.15)} ${r2(s * 0.3)} ${r2(-s * 0.6)} Q ${r2(s * 0.95)} ${r2(-s * 0.7)} ${r2(s * 0.85)} ${r2(-s * 0.15)} Q ${r2(s * 0.6)} ${r2(s * 0.25)} ${r2(-s * 0.4)} ${r2(s * 0.22)} Z" fill="${palette.mid}"/>
<path d="M${r2(-s * 0.7)} ${r2(-s * 0.55)} L ${r2(-s * 0.9)} ${r2(-s * 0.95)} L ${r2(-s * 0.52)} ${r2(-s * 0.72)} Z" fill="${palette.mid}"/>
${[0, 1, 2, 3].map((i) => `<path d="M${r2(-s * 0.5 + i * s * 0.32)} ${r2(-s * 0.82)} l ${r2(s * 0.12)} ${r2(-s * 0.26)} l ${r2(s * 0.12)} ${r2(s * 0.26)} Z" fill="${palette.near}"/>`).join('')}
<circle cx="${r2(s * 0.5)}" cy="${r2(-s * 0.5)}" r="${r2(s * 0.07)}" fill="#ffffff"/>
<circle cx="${r2(s * 0.5)}" cy="${r2(-s * 0.5)}" r="${r2(s * 0.032)}" fill="${palette.ink}"/>
</g>`
}

function castle(x, baseY, s, palette) {
  return `<g transform="translate(${r2(x)} ${r2(baseY)})">
<rect x="${r2(-s * 0.9)}" y="${r2(-s * 0.9)}" width="${r2(s * 0.5)}" height="${r2(s * 0.9)}" fill="${palette.near}"/>
<rect x="${r2(s * 0.4)}" y="${r2(-s * 0.9)}" width="${r2(s * 0.5)}" height="${r2(s * 0.9)}" fill="${palette.near}"/>
<rect x="${r2(-s * 0.34)}" y="${r2(-s * 1.3)}" width="${r2(s * 0.68)}" height="${r2(s * 1.3)}" fill="${palette.mid}"/>
<path d="M${r2(-s * 0.34)} ${r2(-s * 1.3)} L 0 ${r2(-s * 1.85)} L ${r2(s * 0.34)} ${r2(-s * 1.3)} Z" fill="${palette.accent}"/>
<rect x="${r2(-s * 0.12)}" y="${r2(-s * 0.6)}" width="${r2(s * 0.24)}" height="${r2(s * 0.6)}" rx="${r2(s * 0.12)}" fill="${palette.ink}" opacity="0.7"/>
<rect x="${r2(-s * 0.05)}" y="${r2(-s * 1.6)}" width="${r2(s * 0.1)}" height="${r2(s * 0.3)}" fill="${palette.ink}"/>
<path d="M${r2(s * 0.05)} ${r2(-s * 1.6)} L ${r2(s * 0.4)} ${r2(-s * 1.5)} L ${r2(s * 0.05)} ${r2(-s * 1.4)} Z" fill="${palette.accent}"/>
</g>`
}

function raceFlag(x, baseY, s, palette) {
  return `<g transform="translate(${r2(x)} ${r2(baseY)})">
<rect x="0" y="${r2(-s * 1.7)}" width="${r2(s * 0.12)}" height="${r2(s * 1.7)}" fill="${palette.ink}"/>
${[0, 1, 2].flatMap((r) => [0, 1, 2, 3].map((c) => `<rect x="${r2(s * 0.12 + c * s * 0.2)}" y="${r2(-s * 1.7 + r * s * 0.2)}" width="${r2(s * 0.2)}" height="${r2(s * 0.2)}" fill="${(r + c) % 2 ? '#ffffff' : palette.ink}"/>`)).join('')}
</g>`
}

function carProp(x, baseY, s, palette) {
  return `<g transform="translate(${r2(x)} ${r2(baseY)})">
<path d="M${r2(-s)} 0 L ${r2(-s * 0.85)} ${r2(-s * 0.42)} Q ${r2(-s * 0.4)} ${r2(-s * 0.9)} ${r2(s * 0.2)} ${r2(-s * 0.86)} L ${r2(s * 0.72)} ${r2(-s * 0.4)} L ${r2(s)} 0 Z" fill="${palette.mid}"/>
<rect x="${r2(-s * 0.6)}" y="${r2(-s * 0.68)}" width="${r2(s * 0.7)}" height="${r2(s * 0.3)}" rx="${r2(s * 0.06)}" fill="#dff1ff" opacity="0.9"/>
<circle cx="${r2(-s * 0.55)}" cy="${r2(s * 0.06)}" r="${r2(s * 0.22)}" fill="${palette.ink}"/>
<circle cx="${r2(s * 0.5)}" cy="${r2(s * 0.06)}" r="${r2(s * 0.22)}" fill="${palette.ink}"/>
<circle cx="${r2(-s * 0.55)}" cy="${r2(s * 0.06)}" r="${r2(s * 0.09)}" fill="${palette.accent}"/>
<circle cx="${r2(s * 0.5)}" cy="${r2(s * 0.06)}" r="${r2(s * 0.09)}" fill="${palette.accent}"/>
</g>`
}

function clinicProp(x, baseY, s, palette) {
  return `<g transform="translate(${r2(x)} ${r2(baseY)})">
<rect x="${r2(-s * 0.8)}" y="${r2(-s * 1.1)}" width="${r2(s * 1.6)}" height="${r2(s * 1.1)}" rx="${r2(s * 0.12)}" fill="#ffffff"/>
<path d="M${r2(-s * 0.8)} ${r2(-s * 1.1)} L 0 ${r2(-s * 1.6)} L ${r2(s * 0.8)} ${r2(-s * 1.1)} Z" fill="${palette.mid}"/>
<rect x="${r2(-s * 0.14)}" y="${r2(-s * 1.05)}" width="${r2(s * 0.28)}" height="${r2(s * 0.8)}" fill="${palette.mid}"/>
<rect x="${r2(-s * 0.4)}" y="${r2(-s * 0.79)}" width="${r2(s * 0.8)}" height="${r2(s * 0.28)}" fill="${palette.mid}"/>
</g>`
}

function stethoscope(x, baseY, s, palette) {
  return `<g transform="translate(${r2(x)} ${r2(baseY)})">
<path d="M${r2(-s * 0.7)} ${r2(-s * 1.5)} L ${r2(-s * 0.7)} ${r2(-s * 0.7)} Q ${r2(-s * 0.7)} ${r2(s * 0.1)} 0 ${r2(s * 0.1)} Q ${r2(s * 0.7)} ${r2(s * 0.1)} ${r2(s * 0.7)} ${r2(-s * 0.7)} L ${r2(s * 0.7)} ${r2(-s * 1.5)}" stroke="${palette.mid}" stroke-width="${r2(s * 0.14)}" fill="none" stroke-linecap="round"/>
<circle cx="${r2(s * 0.7)}" cy="${r2(-s * 0.42)}" r="${r2(s * 0.3)}" fill="${palette.accent}"/>
<circle cx="${r2(s * 0.7)}" cy="${r2(-s * 0.42)}" r="${r2(s * 0.16)}" fill="#ffffff"/>
</g>`
}

function bridgeProp(x, baseY, s, palette) {
  return `<g transform="translate(${r2(x)} ${r2(baseY)})">
<path d="M${r2(-s)} 0 Q 0 ${r2(-s * 1.3)} ${r2(s)} 0" stroke="${palette.mid}" stroke-width="${r2(s * 0.16)}" fill="none"/>
<rect x="${r2(-s * 0.95)}" y="0" width="${r2(s * 0.18)}" height="${r2(s * 0.5)}" fill="${palette.near}"/>
<rect x="${r2(s * 0.77)}" y="0" width="${r2(s * 0.18)}" height="${r2(s * 0.5)}" fill="${palette.near}"/>
${[-0.5, 0, 0.5].map((f) => `<rect x="${r2(s * f - s * 0.03)}" y="${r2(-s * 0.75)}" width="${r2(s * 0.06)}" height="${r2(s * 0.78)}" fill="${palette.near}"/>`).join('')}
</g>`
}

function flask(x, baseY, s, palette) {
  return `<g transform="translate(${r2(x)} ${r2(baseY)})">
<path d="M${r2(-s * 0.28)} ${r2(-s * 1.6)} L ${r2(-s * 0.28)} ${r2(-s * 0.7)} L ${r2(-s * 0.85)} ${r2(s * 0.1)} Q ${r2(-s * 0.9)} ${r2(s * 0.45)} ${r2(-s * 0.4)} ${r2(s * 0.45)} L ${r2(s * 0.4)} ${r2(s * 0.45)} Q ${r2(s * 0.9)} ${r2(s * 0.45)} ${r2(s * 0.85)} ${r2(s * 0.1)} L ${r2(s * 0.28)} ${r2(-s * 0.7)} L ${r2(s * 0.28)} ${r2(-s * 1.6)} Z" fill="#ffffff" opacity="0.92"/>
<path d="M${r2(-s * 0.78)} ${r2(-s * 0.1)} L ${r2(s * 0.78)} ${r2(-s * 0.1)} L ${r2(s * 0.85)} ${r2(s * 0.1)} Q ${r2(s * 0.9)} ${r2(s * 0.45)} ${r2(s * 0.4)} ${r2(s * 0.45)} L ${r2(-s * 0.4)} ${r2(s * 0.45)} Q ${r2(-s * 0.9)} ${r2(s * 0.45)} ${r2(-s * 0.85)} ${r2(s * 0.1)} Z" fill="${palette.accent}"/>
</g>`
}

function cake(x, baseY, s, palette) {
  return `<g transform="translate(${r2(x)} ${r2(baseY)})">
<rect x="${r2(-s * 0.85)}" y="${r2(-s * 0.7)}" width="${r2(s * 1.7)}" height="${r2(s * 0.7)}" rx="${r2(s * 0.1)}" fill="#ffffff"/>
<rect x="${r2(-s * 0.85)}" y="${r2(-s * 0.75)}" width="${r2(s * 1.7)}" height="${r2(s * 0.24)}" rx="${r2(s * 0.1)}" fill="${palette.accent}"/>
<rect x="${r2(-s * 0.85)}" y="${r2(-s * 0.28)}" width="${r2(s * 1.7)}" height="${r2(s * 0.16)}" fill="${palette.mid}"/>
${[-0.4, 0, 0.4].map((f) => `<g transform="translate(${r2(s * f)} ${r2(-s * 0.9)})">
<rect x="${r2(-s * 0.05)}" y="0" width="${r2(s * 0.1)}" height="${r2(s * 0.3)}" fill="${palette.ink}"/>
<path d="M0 ${r2(-s * 0.22)} Q ${r2(s * 0.1)} ${r2(-s * 0.36)} 0 ${r2(-s * 0.5)} Q ${r2(-s * 0.1)} ${r2(-s * 0.36)} 0 ${r2(-s * 0.22)} Z" fill="#ff9f1c"/>
</g>`).join('')}
</g>`
}

function stickerSheet(x, y, s, palette, seed = 1) {
  const rand = rng((seed >>> 0) || 1)
  const shapes = ['circle', 'star', 'heart', 'cloud', 'leaf']
  return `<g transform="translate(${r2(x)} ${r2(y)})">
<rect x="${r2(-s / 2)}" y="${r2(-s / 2)}" width="${s}" height="${s}" rx="${r2(s * 0.08)}" fill="#ffffff" stroke="${palette.far}" stroke-width="${r2(s * 0.02)}"/>
${Array.from({ length: 9 }, (_, i) => {
  const cx = -s * 0.32 + (i % 3) * s * 0.32
  const cy = -s * 0.32 + Math.floor(i / 3) * s * 0.32
  const shape = shapes[Math.floor(rand() * shapes.length)]
  const col = [palette.accent, palette.mid, palette.far, palette.near][Math.floor(rand() * 4)]
  const rr = s * 0.11
  if (shape === 'star') return `<g transform="translate(${r2(cx)} ${r2(cy)})">${sparkle(0, 0, rr * 1.5, col)}</g>`
  if (shape === 'heart') return `<path d="M${r2(cx)} ${r2(cy + rr)} C ${r2(cx - rr * 1.6)} ${r2(cy - rr * 0.4)} ${r2(cx - rr * 0.5)} ${r2(cy - rr * 1.4)} ${r2(cx)} ${r2(cy - rr * 0.4)} C ${r2(cx + rr * 0.5)} ${r2(cy - rr * 1.4)} ${r2(cx + rr * 1.6)} ${r2(cy - rr * 0.4)} ${r2(cx)} ${r2(cy + rr)} Z" fill="${col}"/>`
  if (shape === 'cloud') return `<g transform="translate(${r2(cx)} ${r2(cy)})"><ellipse rx="${r2(rr * 1.2)}" ry="${r2(rr * 0.75)}" fill="${col}"/><ellipse cx="${r2(rr * 0.8)}" cy="${r2(rr * 0.15)}" rx="${r2(rr * 0.8)}" ry="${r2(rr * 0.55)}" fill="${col}"/></g>`
  if (shape === 'leaf') return `<path d="M${r2(cx - rr)} ${r2(cy + rr)} Q ${r2(cx + rr * 1.4)} ${r2(cy + rr)} ${r2(cx + rr)} ${r2(cy - rr * 1.2)} Q ${r2(cx - rr * 1.2)} ${r2(cy - rr)} ${r2(cx - rr)} ${r2(cy + rr)} Z" fill="${col}"/>`
  return `<circle cx="${r2(cx)}" cy="${r2(cy)}" r="${r2(rr)}" fill="${col}"/>`
}).join('')}
</g>`
}

const MOTIFS = {
  none: () => '',
  hills: ({ w, h, palette, seed }) => layerBands({ w, h, palette, seed, count: 3 }),
  trees: ({ w, h, palette, seed }) => {
    const rand = rng(seed + 3)
    return layerBands({ w, h, palette, seed, count: 2 }) +
      Array.from({ length: 5 }, (_, i) => tree(w * (0.1 + i * 0.2 + rand() * 0.05), h * 0.92, h * (0.13 + rand() * 0.05), palette.ink, palette.near)).join('')
  },
  pines: ({ w, h, palette, seed }) => {
    const rand = rng(seed + 5)
    return layerBands({ w, h, palette, seed, count: 2 }) +
      Array.from({ length: 6 }, (_, i) => pine(w * (0.08 + i * 0.17 + rand() * 0.04), h * 0.95, h * (0.12 + rand() * 0.06), palette.near, palette.ink)).join('')
  },
  waves: ({ w, h, palette, seed }) => {
    let out = ''
    for (let i = 0; i < 4; i++) {
      const y = h * (0.5 + i * 0.13)
      const amp = h * 0.04
      let d = `M0 ${r2(y)}`
      for (let s = 1; s <= 6; s++) d += ` Q ${r2((w / 6) * (s - 0.5))} ${r2(y - amp)} ${r2((w / 6) * s)} ${r2(y)}`
      d += ` L ${w} ${h} L 0 ${h} Z`
      out += `<path d="${d}" fill="${[palette.far, palette.mid, palette.near, palette.ink][i]}" opacity="${r2(0.75 + i * 0.06)}"/>`
    }
    return out
  }
}

// ---------------------------------------------------------------------------
// composed artwork
// ---------------------------------------------------------------------------
function frame(size) {
  const { w, h } = SIZES[size] || SIZES.cover
  return { w, h }
}

/**
 * A themed scene. `props` is a list of motif renderers placed by normalized
 * coordinates — this is the whole "art direction" language of the set.
 */
function scene({ id, size = 'cover', palette, motif = 'hills', props = [], celestial = 'sun', seedBase = 0 }) {
  const { w, h } = frame(size)
  const seed = (hashSeed(id) + seedBase) >>> 0
  const p = P[palette] || P.meadow
  const body = [
    sky({ w, h, palette: p, seed, id: `g${seed}` }),
    celestial === 'stars' ? starField({ w, h, palette: p, seed, count: size === 'og' ? 46 : 26 }) : '',
    celestial === 'moon' ? sunOrMoon({ w, h, palette: p, seed, kind: 'moon' }) : '',
    celestial === 'sun' ? sunOrMoon({ w, h, palette: p, seed, kind: 'sun' }) : '',
    motif === 'waves' ? '' : clouds({ w, h, palette: p, seed, count: 2 }),
    MOTIFS[motif] ? MOTIFS[motif]({ w, h, palette: p, seed }) : '',
    ...props.map((prop) => prop({ w, h, palette: p, seed }))
  ].join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-hidden="true" focusable="false">${body}</svg>\n`
}

const at = (fx, fy, s, fn) => ({ w, h, palette, seed }) => fn(w * fx, h * fy, Math.min(w, h) * s, palette, seed)

// ---------------------------------------------------------------------------
// the catalogue — ORIGINAL titles/themes authored for this project
// ---------------------------------------------------------------------------
export const COVERS = {
  'the-lantern-and-the-long-night': { palette: 'night', motif: 'pines', celestial: 'moon', props: [at(0.5, 0.72, 0.3, lantern)] },
  'captain-of-the-cardboard-sea': { palette: 'sea', motif: 'waves', celestial: 'sun', props: [at(0.5, 0.68, 0.36, boat)] },
  'the-quiet-drum': { palette: 'sunset', motif: 'hills', celestial: 'sun', props: [at(0.5, 0.7, 0.32, drum)] },
  'the-moon-garden': { palette: 'night', motif: 'hills', celestial: 'moon', props: [(o) => moonGarden(o.w * 0.5, o.h * 0.88, Math.min(o.w, o.h) * 0.28, o.palette)] },
  'the-paper-aeroplane-race': { palette: 'dawn', motif: 'hills', celestial: 'sun', props: [at(0.36, 0.4, 0.22, plane), at(0.68, 0.3, 0.12, kite)] },
  'the-snow-fox': { palette: 'snow', motif: 'pines', celestial: 'sun', props: [at(0.5, 0.8, 0.28, snowFox)] },
  'the-puddle-who-met-the-sea': { palette: 'sea', motif: 'waves', celestial: 'sun', props: [at(0.5, 0.66, 0.34, whale)] },
  'the-brave-little-baker': { palette: 'candy', motif: 'hills', celestial: 'sun', props: [at(0.5, 0.74, 0.32, cake)] },
  'the-star-collector': { palette: 'space', motif: 'hills', celestial: 'stars', props: [at(0.7, 0.42, 0.2, rocket), at(0.28, 0.3, 0.1, (x, y, s, p) => sparkle(x, y, s, p.accent))] },
  'the-forest-that-sang': { palette: 'forest', motif: 'trees', celestial: 'sun', props: [at(0.5, 0.66, 0.3, drum)] },
  'the-lost-little-dinosaur': { palette: 'meadow', motif: 'hills', celestial: 'sun', props: [at(0.5, 0.82, 0.3, (x, y, s) => dino(x, y, s, { mid: '#ffd166', near: '#e08e2f', ink: '#3a2a12' }))] },
  'the-great-paper-boat-race': { palette: 'sea', motif: 'waves', celestial: 'sun', props: [at(0.32, 0.62, 0.22, boat), at(0.7, 0.74, 0.16, boat)] },
  'the-kind-vet': { palette: 'clinic', motif: 'hills', celestial: 'sun', props: [at(0.5, 0.78, 0.3, clinicProp), at(0.74, 0.6, 0.16, (x, y, s, p) => stethoscope(x, y, s, p))] },
  'the-little-fire-crew': { palette: 'ember', motif: 'hills', celestial: 'sun', props: [at(0.5, 0.78, 0.32, carProp)] },
  'up-in-the-clouds': { palette: 'snow', motif: 'hills', celestial: 'sun', props: [at(0.62, 0.4, 0.24, plane)] },
  'the-helping-hands-clinic': { palette: 'clinic', motif: 'hills', celestial: 'sun', props: [at(0.46, 0.8, 0.3, clinicProp)] },
  'the-bridge-builders': { palette: 'paper', motif: 'hills', celestial: 'sun', props: [at(0.5, 0.84, 0.34, (x, y, s) => bridgeProp(x, y, s, { mid: '#c2703f', near: '#7d4a26' }))] },
  'the-curious-scientist': { palette: 'clinic', motif: 'hills', celestial: 'sun', props: [at(0.5, 0.84, 0.3, flask)] },
  'the-birthday-balloon': { palette: 'candy', motif: 'hills', celestial: 'sun', props: [at(0.5, 0.72, 0.3, cake), at(0.3, 0.34, 0.12, kite)] },
  'the-snowy-night-parade': { palette: 'night', motif: 'pines', celestial: 'moon', props: [at(0.5, 0.72, 0.28, lantern)] },
  'the-sunrise-kite-club': { palette: 'dawn', motif: 'hills', celestial: 'sun', props: [at(0.5, 0.44, 0.2, kite)] },
  'the-moonlight-parade': { palette: 'night', motif: 'hills', celestial: 'stars', props: [at(0.5, 0.7, 0.26, lantern)] },
  'the-little-explorer': { palette: 'forest', motif: 'trees', celestial: 'sun', props: [at(0.42, 0.4, 0.22, kite), at(0.76, 0.26, 0.1, (x, y, s, p) => sparkle(x, y, s, p.accent))] },
  // sticker packs
  'star-sticker-sheet': { palette: 'candy', motif: 'hills', celestial: 'sun', props: [at(0.5, 0.58, 0.62, stickerSheet)] },
  'meadow-sticker-sheet': { palette: 'meadow', motif: 'hills', celestial: 'sun', props: [at(0.5, 0.58, 0.62, stickerSheet)] },
  'space-sticker-sheet': { palette: 'space', motif: 'hills', celestial: 'stars', props: [at(0.5, 0.58, 0.62, stickerSheet)] },
  'ocean-sticker-sheet': { palette: 'sea', motif: 'hills', celestial: 'sun', props: [at(0.5, 0.58, 0.62, stickerSheet)] }
}

// Non-catalogue art: shell, editorial and instructional artwork.
export const SHELL_ART = {
  'logo': { size: 'icon', palette: 'meadow', motif: 'none', celestial: 'none', props: [at(0.5, 0.58, 0.52, bookProp), at(0.5, 0.3, 0.2, (x, y, s, p) => sparkle(x, y, s, p.accent))] },
  'og-default': { size: 'og', palette: 'dawn', motif: 'hills', celestial: 'sun', props: [at(0.72, 0.6, 0.3, bookProp), at(0.34, 0.5, 0.2, (x, y, s, p) => sparkle(x, y, s, p.accent))] },
  'hero': { size: 'hero', palette: 'dawn', motif: 'hills', celestial: 'sun', props: [at(0.6, 0.62, 0.34, bookProp), at(0.3, 0.34, 0.12, kite), at(0.84, 0.32, 0.09, (x, y, s, p) => sparkle(x, y, s, p.accent))] },
  'cta-reading': { size: 'tile', palette: 'meadow', motif: 'trees', celestial: 'sun', props: [at(0.5, 0.7, 0.3, bookProp)] },
  'login-art': { size: 'tile', palette: 'night', motif: 'pines', celestial: 'moon', props: [at(0.5, 0.7, 0.26, lantern)] },
  'books-header': { size: 'wide', palette: 'sea', motif: 'waves', celestial: 'sun', props: [at(0.7, 0.6, 0.22, boat), at(0.3, 0.34, 0.1, kite)] },
  'stickers-header': { size: 'wide', palette: 'candy', motif: 'hills', celestial: 'sun', props: [at(0.5, 0.62, 0.36, stickerSheet)] },
  'step-1': { size: 'tile', palette: 'paper', motif: 'hills', celestial: 'sun', props: [at(0.5, 0.62, 0.3, bookProp)] },
  'step-2': { size: 'tile', palette: 'snow', motif: 'hills', celestial: 'sun', props: [at(0.5, 0.62, 0.26, (x, y, s, p) => `<g transform="translate(${r2(x)} ${r2(y)})"><rect x="${r2(-s * 0.7)}" y="${r2(-s * 0.5)}" width="${r2(s * 1.4)}" height="${r2(s)}" rx="${r2(s * 0.14)}" fill="#ffffff"/><circle cx="0" cy="0" r="${r2(s * 0.3)}" fill="${p.mid}"/><path d="M${r2(-s * 0.7)} ${r2(-s * 0.1)} Q 0 ${r2(-s * 0.5)} ${r2(s * 0.7)} ${r2(-s * 0.1)}" stroke="${p.far}" stroke-width="${r2(s * 0.07)}" fill="none"/></g>`)] },
  'step-3': { size: 'tile', palette: 'meadow', motif: 'hills', celestial: 'sun', props: [at(0.5, 0.62, 0.28, (x, y, s, p) => `<g transform="translate(${r2(x)} ${r2(y)})">${[0, 1, 2].map((i) => `<rect x="${r2(-s * 0.5 + i * s * 0.36)}" y="${r2(-s * 0.55 + i * s * 0.12)}" width="${r2(s * 0.9)}" height="${r2(s * 0.2)}" rx="${r2(s * 0.08)}" fill="${[p.accent, p.mid, '#ffffff'][i]}"/>`).join('')}</g>`)] },
  'step-4': { size: 'tile', palette: 'candy', motif: 'hills', celestial: 'sun', props: [at(0.5, 0.66, 0.28, cake)] },
  'age-2-4': { size: 'tile', palette: 'candy', motif: 'hills', celestial: 'sun', props: [at(0.5, 0.68, 0.3, (x, y, s, p) => `<g transform="translate(${r2(x)} ${r2(y)})">${[0, 1, 2].map((i) => `<circle cx="${r2((i - 1) * s * 0.7)}" cy="0" r="${r2(s * 0.34)}" fill="${[p.accent, p.near, '#ffffff'][i]}" stroke="${p.ink}" stroke-width="${r2(s * 0.05)}"/>`).join('')}</g>`)] },
  'age-4-6': { size: 'tile', palette: 'dawn', motif: 'hills', celestial: 'sun', props: [at(0.5, 0.5, 0.2, kite)] },
  'age-6-8': { size: 'tile', palette: 'space', motif: 'hills', celestial: 'stars', props: [at(0.5, 0.6, 0.26, rocket)] },
  'thumb-hardcover': { size: 'thumb', palette: 'paper', motif: 'hills', celestial: 'sun', props: [at(0.5, 0.62, 0.42, bookProp)] },
  'thumb-softcover': { size: 'thumb', palette: 'snow', motif: 'waves', celestial: 'sun', props: [at(0.5, 0.62, 0.42, bookProp)] },
  'magic-before': { size: 'tile', palette: 'paper', motif: 'none', celestial: 'none', props: [at(0.5, 0.5, 0.34, (x, y, s, p) => `<g transform="translate(${r2(x)} ${r2(y)})"><rect x="${r2(-s)}" y="${r2(-s * 0.7)}" width="${r2(s * 2)}" height="${r2(s * 1.4)}" rx="${r2(s * 0.12)}" fill="#ffffff" stroke="${p.mid}" stroke-width="${r2(s * 0.06)}"/><circle cx="${r2(-s * 0.45)}" cy="${r2(-s * 0.2)}" r="${r2(s * 0.22)}" fill="${p.far}" opacity="0.5"/><path d="M${r2(-s * 0.8)} ${r2(s * 0.5)} Q 0 ${r2(-s * 0.1)} ${r2(s * 0.8)} ${r2(s * 0.5)}" stroke="${p.mid}" stroke-width="${r2(s * 0.06)}" fill="none"/></g>`)] },
  'magic-after': { size: 'tile', palette: 'meadow', motif: 'hills', celestial: 'sun', props: [at(0.5, 0.62, 0.3, bookProp), at(0.78, 0.32, 0.1, (x, y, s, p) => sparkle(x, y, s, p.accent))] },
  'tip-blurry': { size: 'thumb', palette: 'paper', motif: 'none', celestial: 'none', props: [at(0.5, 0.5, 0.3, (x, y, s) => `<g transform="translate(${r2(x)} ${r2(y)})" opacity="0.55"><circle cx="0" cy="0" r="${r2(s)}" fill="#9aa3b2"/><circle cx="${r2(s * 0.9)}" cy="${r2(-s * 0.2)}" r="${r2(s * 0.75)}" fill="#b6bdc9"/></g>`)] },
  'tip-angle': { size: 'thumb', palette: 'paper', motif: 'none', celestial: 'none', props: [at(0.5, 0.5, 0.3, (x, y, s) => `<g transform="translate(${r2(x)} ${r2(y)}) rotate(24)"><ellipse rx="${r2(s * 0.6)}" ry="${r2(s)}" fill="#b6bdc9"/></g>`)] },
  'tip-shadow': { size: 'thumb', palette: 'paper', motif: 'none', celestial: 'none', props: [at(0.5, 0.5, 0.3, (x, y, s) => `<g transform="translate(${r2(x)} ${r2(y)})"><circle cx="0" cy="0" r="${r2(s * 0.8)}" fill="#cfd5df"/><path d="M0 0 L ${r2(s)} 0 A ${r2(s)} ${r2(s)} 0 0 1 0 ${r2(s)} Z" fill="#7c8494"/></g>`)] },
  'tip-good-1': { size: 'thumb', palette: 'meadow', motif: 'none', celestial: 'none', props: [at(0.5, 0.5, 0.3, (x, y, s, p) => `<g transform="translate(${r2(x)} ${r2(y)})"><circle cx="0" cy="0" r="${r2(s)}" fill="#ffffff"/><circle cx="${r2(-s * 0.3)}" cy="${r2(-s * 0.15)}" r="${r2(s * 0.11)}" fill="${p.ink}"/><circle cx="${r2(s * 0.3)}" cy="${r2(-s * 0.15)}" r="${r2(s * 0.11)}" fill="${p.ink}"/><path d="M${r2(-s * 0.35)} ${r2(s * 0.35)} Q 0 ${r2(s * 0.7)} ${r2(s * 0.35)} ${r2(s * 0.35)}" stroke="${p.mid}" stroke-width="${r2(s * 0.1)}" fill="none" stroke-linecap="round"/></g>`)] },
  'tip-good-2': { size: 'thumb', palette: 'dawn', motif: 'none', celestial: 'none', props: [at(0.5, 0.5, 0.3, (x, y, s, p) => `<g transform="translate(${r2(x)} ${r2(y)})"><circle cx="0" cy="0" r="${r2(s)}" fill="#ffffff"/><circle cx="0" cy="${r2(-s * 0.95)}" r="${r2(s * 0.3)}" fill="${p.accent}"/><path d="M${r2(-s * 0.4)} ${r2(s * 0.3)} Q 0 ${r2(s * 0.65)} ${r2(s * 0.4)} ${r2(s * 0.3)}" stroke="${p.mid}" stroke-width="${r2(s * 0.1)}" fill="none" stroke-linecap="round"/><circle cx="${r2(-s * 0.32)}" cy="${r2(-s * 0.12)}" r="${r2(s * 0.1)}" fill="${p.ink}"/><circle cx="${r2(s * 0.32)}" cy="${r2(-s * 0.12)}" r="${r2(s * 0.1)}" fill="${p.ink}"/></g>`)] },
}

/** Every file this generator is responsible for: name -> rendered SVG. */
export function renderAll() {
  const out = new Map()
  for (const [name, spec] of Object.entries({ ...COVERS })) {
    out.set(`cover-${name}.svg`, scene({ id: `cover-${name}`, size: 'cover', ...spec }))
  }
  for (const [name, spec] of Object.entries(SHELL_ART)) {
    out.set(`${name}.svg`, scene({ id: name, size: spec.size || 'tile', ...spec }))
  }
  return out
}

export function writeAll(dir) {
  mkdirSync(dir, { recursive: true })
  const files = renderAll()
  for (const [name, svg] of files) writeFileSync(join(dir, name), svg, 'utf8')
  return files.size
}

export function checkAll(dir) {
  const files = renderAll()
  const problems = []
  for (const [name, svg] of files) {
    const p = join(dir, name)
    if (!existsSync(p)) problems.push(`missing: ${name}`)
    else if (readFileSync(p, 'utf8') !== svg) problems.push(`drifted: ${name}`)
  }
  if (existsSync(dir)) {
    for (const f of readdirSync(dir)) {
      if (f.endsWith('.svg') && !files.has(f) && f !== 'icons.css') problems.push(`unexpected file: ${f}`)
    }
  }
  return problems
}

export function main(argv = process.argv.slice(2), root = repoRootFromScript()) {
  const dir = join(root, ART_DIR_REL)
  if (argv.includes('--check')) {
    const problems = checkAll(dir)
    if (problems.length) {
      console.error(`[art] ${problems.length} problem(s):`)
      for (const p of problems) console.error(`  - ${p}`)
      return 1
    }
    console.log(`[art] ${renderAll().size} generated files verified (deterministic, in sync)`)
    return 0
  }
  const n = writeAll(dir)
  console.log(`[art] wrote ${n} original SVG asset(s) to ${ART_DIR_REL}`)
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Clean out the previous generated set so a rename cannot leave a stale file.
  const dir = join(repoRootFromScript(), ART_DIR_REL)
  if (!process.argv.includes('--check') && existsSync(dir)) {
    for (const f of readdirSync(dir)) if (f.endsWith('.svg')) unlinkSync(join(dir, f))
  }
  process.exit(main())
}
