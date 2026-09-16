import { describe, it, expect } from 'vitest'
import { toProduct, type ProductRow } from '../../src/db'
import { adminProducts } from '../../src/admin'

// Regression test for a frontend-audit finding: toProduct() never carried
// the `active` column through, so every row's `.active` was `undefined`
// and the admin products table showed "Hidden" for literally every
// product regardless of its real state.
function fakeRow(overrides: Partial<ProductRow> = {}): ProductRow {
  return {
    id: 1,
    slug: 'test-book',
    title: 'Test Book',
    tagline: '',
    description: '',
    story: '',
    price: 34.99,
    compare_at: null,
    image: '',
    gender: 'unisex',
    category: 'book',
    ages: '4-8',
    age_min: 4,
    age_max: 8,
    pages: 32,
    reviews: 0,
    rating: 4.8,
    bestseller: 0,
    new_release: 0,
    career: 0,
    traits_json: '[]',
    active: 1,
    ...overrides
  } as ProductRow
}

describe('toProduct() carries the active column through', () => {
  it('maps active=1 to a truthy Product.active', () => {
    expect(toProduct(fakeRow({ active: 1 })).active).toBe(1)
  })
  it('maps active=0 to a falsy Product.active', () => {
    expect(toProduct(fakeRow({ active: 0 })).active).toBe(0)
  })
})

// V2 Phase 6: adminProducts() takes the caller's resolved permission set, because
// the shared admin shell renders its navigation from it (TypeScript requires the
// argument, so a view can never be rendered with an unjustified menu).
const ADMIN_PERMISSIONS = ['admin.access', 'dashboard.view', 'catalog.read']

describe('adminProducts() renders the real status, not always "Hidden"', () => {
  it('shows "Active" for an active product', () => {
    const html = adminProducts([toProduct(fakeRow({ active: 1 }))], undefined, ADMIN_PERMISSIONS)
    expect(html).toContain('Active')
    expect(html).not.toContain('Hidden')
  })
  it('shows "Hidden" for an inactive product', () => {
    const html = adminProducts([toProduct(fakeRow({ active: 0 }))], undefined, ADMIN_PERMISSIONS)
    expect(html).toContain('Hidden')
  })
})
