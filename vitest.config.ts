import { defineConfig } from 'vitest/config';

// Integration suites open embedded PGlite databases and run full syncs; give
// them room when files run in parallel on a loaded machine.
export default defineConfig({
  test: {
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
