import { defineConfig } from 'vitest/config';

// Local-only suite. tests/ is gitignored (see AGENTS.md); never co-locate
// *.test.mjs next to product code.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.mjs'],
    testTimeout: 30000,
    exclude: ['**/node_modules/**', 'vendor/**'],
  },
});
