/**
 * Build script for dsh-healer.
 *
 * Drives `vp pack` — configured in `vite.config.ts` — and then verifies the
 * distribution, because packing alone cannot know what else belongs in `lib/`.
 *
 * The verification is not ceremony. `vp pack` cleans its output directory by
 * default, and `lib/client.js` is hand-written and lives beside the bundle it
 * generates. One missing `clean: false` deletes it, and that failure would
 * surface only at runtime, in a browser, as a settings card that never renders.
 *
 * @module scripts/build
 */

import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');

/** Artifacts the package entry points and the client slot resolve to. */
const ARTIFACTS = [
  ['lib/index.js', 'host bundle'],
  ['lib/client.js', 'hand-written client bundle'],
] as const;

console.log('Building dsh-healer with vp pack...');

execFileSync(resolve(ROOT, 'node_modules', '.bin', 'vp'), ['pack'], {
  cwd: ROOT,
  stdio: 'inherit',
});

let missing = 0;
for (const [relative, what] of ARTIFACTS) {
  const path = resolve(ROOT, relative);
  if (!existsSync(path)) {
    console.error(`Build failed: ${relative} is missing (${what}).`);
    missing += 1;
    continue;
  }
  const kb = (statSync(path).size / 1024).toFixed(1);
  console.log(`✓ ${relative.padEnd(15)} ${kb.padStart(6)} KB  ${what}`);
}

if (missing > 0) process.exit(1);

console.log('Build complete.');
