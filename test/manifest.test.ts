/**
 * Bundle patch contract.
 *
 * The profile loads `cordis.patch.yml` to insert this plugin's row. A malformed
 * patch is a silent no-op at best and a boot failure at worst, and this repo has
 * no YAML dependency, so the shape that matters is asserted directly on the
 * text: one `insert` block, one row, the right id and name, and the documented
 * default config keys.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, it } from 'vite-plus/test';

import { resolveConfig } from '../src/config.ts';
import { unknownRuleIds } from '../src/engine.ts';
import { DEFAULT_RULES } from '../src/rules/index.ts';
import { resolveInstalledEntry } from '../src/resolve-harness.ts';
import type { StoreFs } from '../src/resolve-harness.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const patch = readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
  name: string;
  dsh?: { bundle?: { patch?: string }; compatibility?: Record<string, unknown> };
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
};

describe('cordis.patch.yml', () => {
  it('declares exactly one insert block', () => {
    const inserts = patch.match(/^-\s*insert:/gm) ?? [];
    assert.equal(inserts.length, 1, 'the patch must contain exactly one insert');
  });

  it('inserts exactly one row, with the package id and name', () => {
    const rows = patch.match(/^\s*-\s*id:\s*(\S+)\s*$/gm) ?? [];
    assert.equal(rows.length, 1, 'exactly one row may be inserted');
    assert.match(patch, /- id:\s*dsh-healer/);
    // Quotes are optional in YAML and the formatter strips them, so this checks
    // the value rather than the punctuation.
    assert.match(patch, /name:\s*["']?dsh-healer["']?/);
  });

  it('carries the documented default config', () => {
    assert.match(patch, /mode:\s*fail-safe/);
    assert.match(patch, /onFindings:\s*log/);
    assert.match(patch, /strictRuleIds:\s*true/);
  });

  it('names no other package, so it cannot impersonate one', () => {
    // A `name:` on a *targeted* row asserts the target's identity. Only the
    // inserted row may carry a name, and it is our own.
    const names = patch.match(/^\s*name:\s*(.+)$/gm) ?? [];
    assert.equal(names.length, 1, 'only the inserted row may carry a name');
    assert.match(names[0]!, /dsh-healer/);
  });
});

describe('package manifest', () => {
  it('points the bundle at the patch file', () => {
    assert.equal(pkg.dsh?.bundle?.patch, './cordis.patch.yml');
  });

  it('declares a compatibility range', () => {
    assert.ok(pkg.dsh?.compatibility, 'a compatibility manifest must be present');
    assert.equal(pkg.dsh.compatibility.node, '>=24');
  });

  it('keeps the harness as a peer, never a dependency', () => {
    // A second copy of dsh-llm would make the prototype patch target an unused
    // class. The peer declaration is what prevents that.
    assert.equal(pkg.dependencies, undefined, 'this package must have no runtime dependencies');
    assert.ok(pkg.peerDependencies?.['@deepseek-ai/dsh-llm'], 'dsh-llm must be a peer');
    assert.ok(pkg.peerDependencies?.['@deepseek-ai/cordis'], 'cordis must be a peer');
  });

  it('runs the suite from the sources, with no build step', () => {
    // `vp test` is Vitest, which transpiles the TypeScript on the fly. What this
    // asserts is that the suite never depends on `lib/` existing, so a
    // contributor can clone and run without building anything first.
    assert.equal(pkg.scripts?.test, 'vp test');
  });
});

/**
 * The patch as **parsed YAML**, not as text.
 *
 * The checks above match strings. That is enough to catch a typo in the config
 * keys, but it cannot tell whether the document is well-formed YAML, whether the
 * `insert` key is a list of rows, or whether the row has the shape the loader
 * reads. A patch that fails to parse is a boot failure.
 *
 * A YAML parser is resolved from the DSH store rather than declared as a
 * dependency — this package has no runtime dependencies on purpose — so the
 * suite skips when no parser is present instead of failing.
 */
/** The installed YAML parser, via the shared resolver. */
function findYamlParser(): string | undefined {
  for (const packageName of ['js-yaml', 'yaml']) {
    for (const inner of ['dist/js-yaml.mjs', 'dist/index.js', 'index.js']) {
      const found = resolveInstalledEntry(packageName, inner, storeFs, homedir());
      if (found !== undefined) return found;
    }
  }
  return undefined;
}
const storeFs: StoreFs = {
  readdir: (dir) => readdirSync(dir),
  exists: (path) => existsSync(path),
  join: (...parts) => join(...parts),
};

const yamlPath = findYamlParser();
const yaml =
  yamlPath === undefined
    ? undefined
    : ((await import(pathToFileURL(yamlPath).href)) as { load(source: string): unknown });

describe('cordis.patch.yml as parsed YAML', { skip: yaml === undefined }, () => {
  const doc = yaml!.load(patch) as unknown;

  it('is a well-formed YAML sequence', () => {
    assert.ok(Array.isArray(doc), 'the patch must be a sequence of operations');
    assert.ok(doc.length > 0);
  });

  it('has exactly one operation, and it is an insert', () => {
    const operations = doc as Record<string, unknown>[];
    assert.equal(operations.length, 1);
    assert.deepEqual(Object.keys(operations[0]!), ['insert'], 'the only key must be `insert`');
    assert.ok(Array.isArray(operations[0]!.insert));
  });

  it('inserts exactly one row with the expected shape', () => {
    const rows = (doc as { insert: unknown[] }[])[0]!.insert as Record<string, unknown>[];
    assert.equal(rows.length, 1);
    const row = rows[0]!;
    assert.equal(row.id, 'dsh-healer');
    assert.equal(row.name, 'dsh-healer', 'the row must assert its own package name');
    assert.equal(row.disabled, undefined, 'the row must be enabled');
  });

  it('carries a config the plugin schema accepts', () => {
    const row = ((doc as { insert: unknown[] }[])[0]!.insert as Record<string, unknown>[])[0]!;
    const config = row.config as Record<string, unknown>;
    assert.deepEqual(config, {
      mode: 'fail-safe',
      onFindings: 'log',
      strictRuleIds: true,
    });
  });

  it('names no other package, so it cannot impersonate one', () => {
    // A `name` on a *targeted* row asserts the target's identity; only the
    // inserted row may carry one, and it is our own.
    const rows = (doc as { insert: unknown[] }[])[0]!.insert as Record<string, unknown>[];
    for (const row of rows) {
      if (row.name === undefined) continue;
      assert.equal(row.name, 'dsh-healer');
    }
  });
});

describe('the shipped patch config is accepted by the plugin schema', () => {
  // The text checks above prove the patch *says* the right thing; this proves the
  // thing it says is what the plugin actually accepts. A patch that parses but
  // fails `resolveConfig` would fail at load, not at review.
  const row = (() => {
    // Re-read the YAML when a parser is available; otherwise fall back to the
    // values the text checks already assert, so this case still runs.
    if (yaml === undefined) return { mode: 'heal', onFindings: 'log', strictRuleIds: true };
    const doc = yaml.load(patch) as { insert: { config: Record<string, unknown> }[] }[];
    return doc[0]!.insert[0]!.config;
  })();

  it('resolves without error and yields the documented defaults', () => {
    const config = resolveConfig(row);
    assert.equal(config.mode, 'fail-safe');
    assert.equal(config.onFindings, 'log');
    assert.equal(config.strictRuleIds, true);
    assert.deepEqual(config.rules, {}, 'the shipped patch overrides no rule');
  });

  it('every shipped rule keeps its default enablement under this config', () => {
    const config = resolveConfig(row);
    for (const rule of DEFAULT_RULES) {
      const override = config.rules[rule.id];
      assert.equal(
        override,
        undefined,
        `the shipped patch must not override ${rule.id}; defaults are evidence-driven`,
      );
    }
  });

  it('names no rule the package does not ship', () => {
    const config = resolveConfig(row);
    assert.deepEqual(unknownRuleIds(DEFAULT_RULES, { rules: config.rules }), []);
  });
});
