/**
 * Unit tests for client-side configuration schema, i18n dictionaries, and group mappings.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'vite-plus/test';
import { EN, FIELDS, GROUPS, NS, STRINGS, apply, type ClientContextLike } from '../src/client.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Read one `locale/<lang>.json`, the manifest DSH reads for the plugin list. */
function manifestLocale(lang: string): { title: string; description: string } {
  const raw = readFileSync(join(ROOT, 'locale', `${lang}.json`), 'utf8');
  const parsed = JSON.parse(raw) as { meta: { title: string; description: string } };
  return parsed.meta;
}

describe('client i18n dictionaries', () => {
  it('namespace is dsh-healer', () => {
    assert.equal(NS, 'dsh-healer');
    assert.equal(EN, 'en');
  });

  /**
   * The title and description exist twice — in `locale/<lang>.json`, which the
   * plugin list reads, and in `STRINGS`, which the settings card renders. They
   * are the same strings, so nothing but this check stops them drifting apart
   * and showing two different descriptions for one plugin.
   */
  it('title and description agree with the locale manifests', () => {
    for (const [lang, strings] of [
      ['en', STRINGS.en],
      ['zh', STRINGS.zh],
    ] as const) {
      const meta = manifestLocale(lang);
      assert.equal(
        meta.title,
        strings.title,
        `locale/${lang}.json title disagrees with STRINGS.${lang}.title`,
      );
      assert.equal(
        meta.description,
        strings.description,
        `locale/${lang}.json description disagrees with STRINGS.${lang}.description`,
      );
    }
  });

  it('en and zh dictionaries have exact matching key sets', () => {
    const enKeys = Object.keys(STRINGS.en).sort();
    const zhKeys = Object.keys(STRINGS.zh).sort();
    assert.deepEqual(enKeys, zhKeys);
  });

  it('no translation string is empty or whitespace-only', () => {
    for (const [key, value] of Object.entries(STRINGS.en)) {
      assert.ok(
        typeof value === 'string' && value.trim().length > 0,
        `en.${key} must not be empty`,
      );
    }
    for (const [key, value] of Object.entries(STRINGS.zh)) {
      assert.ok(
        typeof value === 'string' && value.trim().length > 0,
        `zh.${key} must not be empty`,
      );
    }
  });

  it('every labelKey and hintKey in FIELDS exists in the dictionaries', () => {
    for (const [fieldName, meta] of Object.entries(FIELDS)) {
      assert.ok(
        meta.labelKey in STRINGS.en,
        `FIELDS.${fieldName}.labelKey "${String(meta.labelKey)}" missing from STRINGS.en`,
      );
      assert.ok(
        meta.hintKey in STRINGS.en,
        `FIELDS.${fieldName}.hintKey "${String(meta.hintKey)}" missing from STRINGS.en`,
      );
      assert.ok(
        meta.labelKey in STRINGS.zh,
        `FIELDS.${fieldName}.labelKey "${String(meta.labelKey)}" missing from STRINGS.zh`,
      );
      assert.ok(
        meta.hintKey in STRINGS.zh,
        `FIELDS.${fieldName}.hintKey "${String(meta.hintKey)}" missing from STRINGS.zh`,
      );
    }
  });

  it('every titleKey in GROUPS exists in the dictionaries', () => {
    for (const group of GROUPS) {
      assert.ok(
        group.titleKey in STRINGS.en,
        `GROUPS.${group.id}.titleKey "${String(group.titleKey)}" missing from STRINGS.en`,
      );
      assert.ok(
        group.titleKey in STRINGS.zh,
        `GROUPS.${group.id}.titleKey "${String(group.titleKey)}" missing from STRINGS.zh`,
      );
    }
  });
});

describe('client fields and groups layout', () => {
  it('every grouped field is declared in FIELDS', () => {
    for (const group of GROUPS) {
      for (const field of group.fields) {
        assert.ok(field in FIELDS, `Field "${field}" in group "${group.id}" missing from FIELDS`);
      }
    }
  });

  it('every field in FIELDS belongs to exactly one group', () => {
    const allGroupedFields = GROUPS.flatMap((g) => g.fields);
    for (const field of Object.keys(FIELDS)) {
      const occurrences = allGroupedFields.filter((f) => f === field).length;
      assert.equal(
        occurrences,
        1,
        `Field "${field}" must appear exactly once in GROUPS, found ${occurrences}`,
      );
    }
  });

  it('mode choices match valid HealMode values', () => {
    const modeField = FIELDS.mode;
    assert.equal(modeField?.kind, 'enum');
    assert.deepEqual(modeField?.choices, ['fail-safe', 'heal', 'check', 'off']);
  });
});

describe('client apply', () => {
  it('registers dictionaries into ctx.locale', () => {
    const registered: Record<string, unknown> = {};
    const mockCtx: ClientContextLike = {
      locale: {
        define(lang, dict) {
          registered[lang] = dict;
        },
      },
      effect(cb) {
        cb();
      },
    };

    apply(mockCtx);

    assert.ok('en' in registered);
    assert.ok('zh' in registered);
    assert.deepEqual(registered.en, { [NS]: STRINGS.en });
    assert.deepEqual(registered.zh, { [NS]: STRINGS.zh });
  });

  it('handles null/undefined ctx gracefully', () => {
    assert.doesNotThrow(() => {
      apply({
        effect: () => {},
      });
    });
  });
});

/**
 * The forms a string literal may take in the bundle.
 *
 * The bundle is formatted by oxfmt, which is configured to single quotes, so a
 * check hard-coded to `JSON.stringify` output silently stops matching the moment
 * the formatter runs. Accepting either quoting keeps this test about content
 * rather than about punctuation.
 */
function literalForms(value: string): string[] {
  const escaped = value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  return [JSON.stringify(value), `'${escaped}'`];
}

/**
 * The shipped bundle is hand-written; `src/client.ts` is the typed model these
 * tests exercise. Nothing generates one from the other, so a string added to the
 * model would never reach the runtime and no test would notice — the browser
 * would simply render a missing translation or a missing field. This is the
 * check that closes that gap, directionally: everything the model declares must
 * be present in the bundle the client actually loads.
 */
describe('shipped client bundle agrees with the model', () => {
  const bundle = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8');

  it('registers under the same namespace', () => {
    assert.ok(
      literalForms(NS).some((form) => bundle.includes(form)),
      `lib/client.js does not reference the "${NS}" namespace`,
    );
  });

  it('carries every dictionary string', () => {
    for (const [lang, dict] of Object.entries(STRINGS)) {
      for (const [key, value] of Object.entries(dict)) {
        assert.ok(
          literalForms(value).some((form) => bundle.includes(form)),
          `lib/client.js is missing ${lang}.${key}: ${JSON.stringify(value)}`,
        );
      }
    }
  });

  it('carries every field and group the model declares', () => {
    for (const field of Object.keys(FIELDS)) {
      assert.ok(bundle.includes(field), `lib/client.js is missing field "${field}"`);
    }
    for (const group of GROUPS) {
      assert.ok(bundle.includes(group.id), `lib/client.js is missing group "${group.id}"`);
    }
  });
});
