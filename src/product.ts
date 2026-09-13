// Canonical Product domain type. Both the static catalog seed (src/data.ts)
// and the D1-backed catalog (src/db.ts's toProduct()) return this exact
// shape — every consumer (storefront, admin, PDP editor) imports it from
// here. Previously this type was declared twice (once in each file) and
// had already drifted once (db.ts's copy was missing `active`, which broke
// the admin product list — see docs/FRONTEND_AUDIT.md finding #6); a single
// declaration makes that class of bug impossible to reintroduce.
export type Product = {
  // Optional: the static seed in data.ts has no DB id; every D1-backed
  // product (toProduct() in db.ts) always sets it.
  id?: number
  /** 1/0 — whether this product is visible on the storefront. Only meaningful for D1-backed products. */
  active?: number
  slug: string
  title: string
  tagline: string
  description: string
  story: string
  price: number
  compareAt?: number
  image: string
  gender: 'girl' | 'boy' | 'unisex'
  category: 'book' | 'sticker'
  ages: string
  ageMin: number
  ageMax: number
  pages: number
  reviews: number
  rating: number
  bestseller?: boolean
  newRelease?: boolean
  career?: boolean
  traits: string[]
}
