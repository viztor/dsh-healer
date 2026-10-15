#!/usr/bin/env node
/**
 * Verify the upstream `BlockAssembler` fix — without touching the live harness.
 *
 * The fix belongs upstream, so this repo cannot apply it permanently; but a
 * patch nobody has run is a guess. This script:
 *
 *   1. builds a throwaway sandbox in the OS temp dir: a **copy** of the installed
 *      `dsh-llm`, with its real dependencies symlinked beside it so bare imports
 *      still resolve,
 *   2. proves the sandbox reproduces the defect before the fix,
 *   3. applies the fix **to the sandbox copy only**,
 *   4. runs the spec test against the fixed sandbox,
 *   5. removes the sandbox.
 *
 * The live DSH installation is never written to. That is deliberate: this script
 * previously tried to patch the real package in place and was correctly refused
 * by the sandbox, which is the outcome to design for rather than work around.
 *
 * Usage: node scripts/verify-upstream-fix.ts
 * Exit:  0 when the fixed behaviour passes, 1 otherwise.
 *
 * @module scripts/verify-upstream-fix
 */

import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { resolveHarnessEntry } from '../src/resolve-harness.ts';
import { FIND, FIND_BUNDLED, REPLACE, REPLACE_BUNDLED } from '../upstream/assembler-fix.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Locate the installed `@deepseek-ai/dsh-llm` package directory.
 */
function findPackage(): string | undefined {
  const storeFs = {
    readdir: (dir: string) => readdirSync(dir),
    exists: (path: string) => existsSync(path),
    join: (...parts: string[]) => join(...parts),
  };
  const entry = resolveHarnessEntry(
    '@deepseek-ai/dsh-llm',
    'lib/types/assembler.js',
    storeFs,
    homedir(),
  );
  // <pkg>/lib/types/assembler.js -> <pkg>
  return entry === undefined ? undefined : dirname(dirname(dirname(entry)));
}

/** The packages the assembler imports by bare specifier. */
const DEPENDENCIES = ['dsh-brand', 'dsh-util-values', 'dsh-util-crypto', 'dsh-timeout'];

const installed = findPackage();
if (installed === undefined) {
  console.error('could not locate the installed @deepseek-ai/dsh-llm package');
  process.exit(1);
}
const scope = dirname(installed);

const sandbox = mkdtempSync(join(tmpdir(), 'dsh-healer-upstream-'));
let exitCode = 1;

try {
  // 1. Sandbox: a real copy of dsh-llm, with real dependencies symlinked beside it.
  const scopeDir = join(sandbox, 'node_modules', '@deepseek-ai');
  mkdirSync(scopeDir, { recursive: true });
  for (const dependency of DEPENDENCIES) {
    const source = join(scope, dependency);
    if (existsSync(source)) symlinkSync(source, join(scopeDir, dependency), 'dir');
  }
  const copy = join(scopeDir, 'dsh-llm');
  cpSync(installed, copy, { recursive: true });
  console.log(`sandbox: ${sandbox}`);

  const targets = [
    { path: join(copy, 'lib', 'types', 'assembler.js'), find: FIND, replace: REPLACE },
    { path: join(copy, 'lib', 'index.js'), find: FIND_BUNDLED, replace: REPLACE_BUNDLED },
  ];

  // 2. Prove the sandbox reproduces the defect *before* the fix.
  const assemblerPath = join(copy, 'lib', 'types', 'assembler.js');
  const before = (await import(`${pathToFileURL(assemblerPath).href}?v=before`)).BlockAssembler;
  const probe = new before();
  probe.push({ type: 'block-start', index: 3, blockType: 'tool-call' });
  const reproduced = JSON.stringify(probe.assembled().blocks);
  const expected = '[{"type":"tool-call","id":"call-3","name":"","arguments":""}]';
  if (reproduced !== expected) {
    console.error(`the sandbox did not reproduce the defect; got ${reproduced}`);
    process.exit(1);
  }
  console.log('defect reproduced in the sandbox');

  // 3. Apply the fix to the sandbox copy only.
  for (const target of targets) {
    const original = readFileSync(target.path, 'utf8');
    const occurrences = original.split(target.find).length - 1;
    if (occurrences !== 1) {
      console.error(`anchor appears ${occurrences} times in ${target.path}`);
      process.exit(1);
    }
    writeFileSync(target.path, original.replace(target.find, target.replace));
  }
  console.log('fix applied to the sandbox copy');

  // 4. Run the spec against the fixed sandbox.
  execFileSync(process.execPath, ['--test', join(ROOT, 'test', 'upstream-assembler.test.ts')], {
    cwd: ROOT,
    stdio: 'inherit',
    env: {
      ...process.env,
      DSH_HEAL_ASSEMBLER_FIXED: '1',
      DSH_HEAL_ASSEMBLER_MODULE: assemblerPath,
    },
  });
  console.log('\nPASS: the fix produces the required behaviour');
  exitCode = 0;
} catch (error) {
  const err = error as Error;
  console.error(`\nFAIL: ${err.message}`);
  exitCode = 1;
} finally {
  rmSync(sandbox, { recursive: true, force: true });
  console.log('sandbox removed; the live DSH installation was never modified');
}

process.exit(exitCode);
