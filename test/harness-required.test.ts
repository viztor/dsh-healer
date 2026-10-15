/**
 * Harness availability — the guard that stops the suite lying.
 *
 * Five files (`integration`, `loader`, `chain`, `upstream-assembler`, `shims`)
 * need the installed `@deepseek-ai/dsh-llm` to exercise anything. They **skip**
 * when it cannot be resolved, which is right for portability — but it means the
 * suite can report green while its most valuable tests never ran.
 *
 * That is exactly the failure mode this project's own test plan warns about: "a
 * suite that silently omits a check reads as verified when it is not". It then
 * happened here — the pnpm dlx cache was cleared while the DSH host kept running
 * from memory, the resolver found nothing, and the count fell from 450 to 409
 * with no failure.
 *
 * So absence is now a **failure** by default, with an explicit opt-out for a
 * machine that legitimately has no DSH (CI, or a contributor without the host):
 *
 *     DSH_HEAL_ALLOW_NO_HARNESS=1 pnpm test
 *
 * With the opt-out the suite is honest about what it did not check, rather than
 * quietly smaller.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'vite-plus/test';
import { fileURLToPath } from 'node:url';

import { resolveHarnessEntry } from '../src/resolve-harness.ts';

/** The directory this file lives in, for the structural checks below. */
const TEST_DIR = dirname(fileURLToPath(import.meta.url));
import type { StoreFs } from '../src/resolve-harness.ts';

const fs: StoreFs = {
  readdir: (dir) => readdirSync(dir),
  exists: (path) => existsSync(path),
  join: (...parts) => join(...parts),
};

/** Resolve the harness the same way the plugin does — through the shared resolver. */
function findHarness(): string | undefined {
  const override = process.env.DSH_HEAL_LLM_MODULE;
  if (override !== undefined && override.length > 0) return override;
  return resolveHarnessEntry('@deepseek-ai/dsh-llm', 'lib/index.js', fs, homedir());
}

const harness = findHarness();
const allowedAbsent = process.env.DSH_HEAL_ALLOW_NO_HARNESS === '1';

describe('harness availability', { skip: allowedAbsent }, () => {
  it('the installed DSH harness is resolvable, so the integration tests actually ran', () => {
    assert.ok(
      harness !== undefined,
      [
        'The @deepseek-ai/dsh-llm harness could not be found.',
        '',
        'This is a FAILURE rather than a skip on purpose: without the harness, five',
        'test files contribute zero tests (integration, loader, chain,',
        'upstream-assembler, shims) and the suite would otherwise report green while',
        'its most valuable checks never ran.',
        '',
        'The plugin resolves it from DSH_HEAL_LLM_MODULE, then a bare import, then a',
        'pnpm dlx store scan. The dlx cache is frequently cleared while a running DSH',
        'host keeps working from memory, which is the usual cause.',
        '',
        'If this machine genuinely has no DSH, acknowledge that explicitly:',
        '    DSH_HEAL_ALLOW_NO_HARNESS=1 pnpm test',
      ].join('\n'),
    );
  });
});

describe('harness availability · one resolver', () => {
  /**
   * Every harness-dependent test must resolve through `resolveHarnessEntry`.
   *
   * The guard above asserts the harness is *resolvable*. That is not the same as
   * the harness-dependent tests *running*, and the difference cost eleven tests:
   * `integration.test.ts` carried its own scan that looked one level below each
   * dlx root, while the real layout is deeper. This file found the harness and
   * stayed green; `integration` found nothing and skipped the whole file. Eleven
   * tests silently did not run.
   *
   * A structural check is the right shape here because the defect is structural:
   * two resolvers with different reach. There is now one, and this keeps it that
   * way. If a test needs a path inside the installed harness it calls
   * `resolveHarnessEntry`, or it re-derives the layout and this fails.
   */
  it('no test file re-derives the pnpm store layout', () => {
    const offenders: string[] = [];
    for (const entry of readdirSync(TEST_DIR)) {
      if (!entry.endsWith('.test.ts')) continue;
      const source = readFileSync(join(TEST_DIR, entry), 'utf8');
      // The layout signature: naming the dlx roots directly.
      if (/['"]pnpm['"]\s*,\s*['"]dlx['"]/.test(source)) offenders.push(entry);
    }
    assert.deepEqual(
      offenders,
      [],
      `these files build their own dlx roots instead of calling resolveHarnessEntry: ${offenders.join(', ')}`,
    );
  });

  it('every harness-dependent file routes through the shared resolver', () => {
    const files = ['integration', 'loader', 'chain', 'upstream-assembler', 'shims'];
    for (const name of files) {
      const source = readFileSync(join(TEST_DIR, `${name}.test.ts`), 'utf8');
      assert.ok(
        source.includes('resolveHarnessEntry'),
        `${name}.test.ts must resolve the harness through resolveHarnessEntry`,
      );
    }
  });
});

describe('harness availability · every store-resolved dependency', () => {
  /**
   * The guard above only checks `@deepseek-ai/dsh-llm`. Five other packages are
   * resolved from the same store, and a file that cannot find its package skips
   * silently — which is the failure this whole file exists to prevent, just
   * pointed at a different package.
   *
   * Each entry names the file it would take down with it, so a failure says what
   * stopped running rather than only what went missing.
   */
  const DEPENDENCIES: [string, string, string][] = [
    [
      '@deepseek-ai/dsh-llm',
      'lib/index.js',
      'integration, loader, chain, shims, upstream-assembler',
    ],
    ['@deepseek-ai/dsh-llm', 'lib/types/assembler.js', 'chain, upstream-assembler'],
    ['@deepseek-ai/dsh-llm', 'lib/types/message.d.ts', 'chain'],
    ['@deepseek-ai/dsh-session', 'lib/index.js', 'session-history'],
    ['@deepseek-ai/cordis', 'lib/index.js', 'loader'],
    ['@types/node', 'package.json', 'shims'],
    ['js-yaml', 'dist/js-yaml.mjs', 'manifest'],
  ];

  for (const [packageName, inner, affected] of DEPENDENCIES) {
    it(`${packageName} resolves, so ${affected} actually runs`, () => {
      const found = resolveHarnessEntry(packageName, inner, fs, homedir());
      assert.ok(
        found !== undefined,
        `${packageName}/${inner} could not be resolved from the pnpm store, so these ` +
          `files contribute zero tests and the suite would report green: ${affected}. ` +
          'Run the suite in a clean room (`env -u NODE_PATH node --test test/`) to see it.',
      );
    });
  }
});

describe('harness availability · overrides survive consolidation', () => {
  /**
   * A resolver has more inputs than the ones the suite happens to use.
   *
   * Migrating `upstream-assembler.test.ts` onto the shared resolver dropped the
   * `DSH_HEAL_ASSEMBLER_MODULE` and `DSH_LLM_MODULE` overrides it had honoured —
   * and nothing failed, because only `scripts/verify-upstream-fix.ts` sets them
   * and that script is not part of `node --test`. The verifier broke silently and
   * was found by running it by hand.
   *
   * This is a structural check because the regression is structural: the override
   * must still be read. It is weaker than a behavioural test and is written down as
   * such — the real coverage for these paths is the verifier itself.
   */
  const OVERRIDES: [string, string][] = [
    ['upstream-assembler.test.ts', 'DSH_HEAL_ASSEMBLER_MODULE'],
    ['upstream-assembler.test.ts', 'DSH_LLM_MODULE'],
    ['integration.test.ts', 'DSH_HEAL_LLM_MODULE'],
    ['session-history.test.ts', 'DSH_SESSION_MODULE'],
    ['harness-required.test.ts', 'DSH_HEAL_LLM_MODULE'],
  ];

  for (const [file, variable] of OVERRIDES) {
    it(`${file} still honours ${variable}`, () => {
      const source = readFileSync(join(TEST_DIR, file), 'utf8');
      assert.ok(
        source.includes(variable),
        `${file} no longer reads ${variable}. If this was a resolver consolidation, ` +
          'the override was dropped: consolidate the fallback, keep every input.',
      );
    });
  }
});
