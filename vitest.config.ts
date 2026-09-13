import { defineConfig } from 'vitest/config'

export default defineConfig({
  // JSX transform options come from tsconfig.json (jsx/jsxImportSource) —
  // Vite's default oxc transformer picks those up automatically.
  test: {
    environment: 'node',
    include: ['test/unit/**/*.test.ts'],
    // Phase 0 scope: fast, deterministic unit tests only. Integration
    // (real local-D1 migration smoke test) and e2e (browser journey) run via
    // their own npm scripts — see package.json / STORYBOOKCLONE_COMPLETION_CODING_PACK.md.
    exclude: ['node_modules/**', 'test/integration/**', 'test/e2e/**']
  }
})
