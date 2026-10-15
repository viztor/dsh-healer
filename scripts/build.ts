/**
 * Build script for dsh-healer.
 *
 * Bundles `src/index.ts` into the Node ESM entry point `lib/index.js`, with every
 * package import left external, and verifies the distribution assets exist.
 *
 * esbuild is called through its API rather than `pnpm dlx esbuild`: a `dlx` build
 * resolves whatever version is current at run time, so two builds of the same
 * commit could differ, and it needs the network on every CI run.
 *
 * @module scripts/build
 */

import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

import { build } from 'esbuild';

const ROOT = resolve(import.meta.dirname, '..');
const SRC_INDEX = resolve(ROOT, 'src/index.ts');
const LIB_INDEX = resolve(ROOT, 'lib/index.js');
const LIB_CLIENT = resolve(ROOT, 'lib/client.js');

console.log('Building dsh-healer host bundle...');

await build({
  entryPoints: [SRC_INDEX],
  outfile: LIB_INDEX,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node24',
  // Every import stays external: the host supplies cordis and dsh-llm, and a
  // second bundled copy of either is exactly the failure this plugin guards
  // against.
  packages: 'external',
});

for (const [label, path] of [
  ['lib/index.js', LIB_INDEX],
  ['lib/client.js', LIB_CLIENT],
] as const) {
  if (!existsSync(path)) {
    console.error(`Build failed: ${label} is missing.`);
    process.exit(1);
  }
}

const kb = (path: string): string => (statSync(path).size / 1024).toFixed(1);

console.log(`✓ Host bundle compiled:   lib/index.js (${kb(LIB_INDEX)} KB)`);
console.log(`✓ Client bundle verified: lib/client.js (${kb(LIB_CLIENT)} KB)`);
console.log('Build complete.');
