import { configDefaults, defineConfig } from 'vitest/config';

// Integration suites open embedded PGlite databases and run full syncs; give
// them room when files run in parallel on a loaded machine.
export default defineConfig({
  test: {
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // the suite opens throwaway embedded PGlite indexes; the product default is PostgreSQL
    env: { KNODE_DATABASE_KIND: 'pglite' },
    // sessions' worktrees live under .claude/worktrees, each with its own copy of
    // tests/: run from the main checkout, the suite would run every copy too
    exclude: [...configDefaults.exclude, '.claude/**'],
  },
});
