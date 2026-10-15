import { defineConfig } from 'vite-plus';

/**
 * Vite+ toolchain configuration: formatting and linting.
 *
 * Tests stay on `node --test`. This package is a Node/Cordis plugin with no
 * build step for its sources — Node ≥24 runs the TypeScript directly — and the
 * suite deliberately depends on nothing but the standard library, so it is run
 * through `vpr test` rather than migrated to Vitest.
 */
export default defineConfig({
  fmt: {
    // The repo is single-quoted throughout; oxfmt defaults to double quotes and
    // would otherwise rewrite every string literal for no reason.
    singleQuote: true,
    ignorePatterns: [
      // Captured incident evidence: byte-for-byte records of real sessions that
      // `test/replay.test.ts` hashes and replays. Reformatting them would edit
      // the evidence rather than the code.
      'test/fixtures/**',
    ],
  },
  lint: {
    ignorePatterns: ['test/fixtures/**'],
  },
  staged: {
    // Runs on the files Git has staged, via `.vite-hooks/pre-commit`. Format and
    // lint only: the full gate (typechecks, suite, mutation, upstream) belongs in
    // CI, where it cannot be skipped with `--no-verify`.
    '*.{ts,mts}': ['vp fmt', 'vp lint'],
    '*.{json,md,yml,yaml}': 'vp fmt',
  },
});
