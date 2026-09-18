// Legacy plain-USD display helper for the ADMIN screens only.
//
// This used to live in src/data.ts, which also holds the 28-product static seed
// fixture (`products`: ~21 kB of source including full story text). Importing
// the formatter therefore created an INVISIBLE coupling: an admin view that only
// wanted a dollar string dragged the whole fixture into its dependency graph.
// src/index.tsx still imports that fixture on purpose — its fresh-install
// bootstrap seeds an empty `products` table — so removing the formatter did NOT
// by itself shrink the Worker. What it removed is the coupling that made a
// display helper look load-bearing for the catalog fixture; the importer set is
// now explicit and pinned by a guard in test/unit/storefront-round2.test.ts
// (exactly one runtime importer: the bootstrap).
//
// The storefront formats money with the selected currency's own settings
// (src/locale.ts::formatMoneyForCurrency) — never with this.
export function money(n: number) {
  return `$${Number(n || 0).toFixed(2)}`
}
