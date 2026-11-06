import { configDefaults, defineConfig } from 'vitest/config';

// Integration suites open embedded PGlite databases and run full syncs; give
// them room when files run in parallel on a loaded machine.
export default defineConfig({
  test: {
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // the suite opens throwaway embedded PGlite indexes; the product default is PostgreSQL.
    // Codex catalog copies off: a Codex stub must not read ~/.codex or write ~/.knode-os
    // (tests/codex-catalog.test.ts turns them on, in folders of its own)
    env: { KNODE_DATABASE_KIND: 'pglite', KNODE_CODEX_CATALOG_HOURS: '0' },
    // sessions' worktrees live under .claude/worktrees, each with its own copy of
    // tests/: run from the main checkout, the suite would run every copy too
    exclude: [...configDefaults.exclude, '.claude/**'],
  },
});
