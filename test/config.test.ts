/**
 * Settings validation.
 *
 * The failure mode this guards is specific: a typo in a rule id would otherwise
 * silently disable a protection the operator believes is on. So unknown ids are
 * an error, not a no-op, and the check runs before anything is installed.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'vite-plus/test';

import { ConfigError, DEFAULT_CONFIG, healerOptions, resolveConfig } from '../src/config.ts';

describe('resolveConfig', () => {
  it('returns the defaults for absent settings', () => {
    assert.deepEqual(resolveConfig(undefined), DEFAULT_CONFIG);
    assert.deepEqual(resolveConfig(null), DEFAULT_CONFIG);
  });

  it('accepts a full valid configuration', () => {
    const config = resolveConfig({
      mode: 'check',
      onFindings: 'throw',
      strictRuleIds: false,
      rules: { 'tool-call-name': { enabled: false }, 'tool-call-arguments': { enabled: true } },
    });
    assert.equal(config.mode, 'check');
    assert.equal(config.onFindings, 'throw');
    assert.equal(config.strictRuleIds, false);
    assert.deepEqual(config.rules['tool-call-name'], { enabled: false });
    assert.deepEqual(config.rules['tool-call-arguments'], { enabled: true });
  });

  it('carries per-rule options through untouched', () => {
    const config = resolveConfig({
      rules: { 'some-rule': { enabled: true, options: { maxBytes: 4096 } } },
    });
    assert.deepEqual(config.rules['some-rule'], { enabled: true, options: { maxBytes: 4096 } });
  });

  it('rejects an unknown mode', () => {
    assert.throws(() => resolveConfig({ mode: 'fix' }), ConfigError);
  });

  it('rejects an unknown onFindings action', () => {
    assert.throws(() => resolveConfig({ onFindings: 'explode' }), ConfigError);
  });

  it('rejects a non-boolean strictRuleIds', () => {
    assert.throws(() => resolveConfig({ strictRuleIds: 'yes' }), ConfigError);
  });

  it('rejects a non-object config', () => {
    assert.throws(() => resolveConfig('heal'), ConfigError);
    assert.throws(() => resolveConfig([1, 2]), ConfigError);
  });

  it('rejects a rules entry that is not an object', () => {
    assert.throws(() => resolveConfig({ rules: { 'tool-call-name': true } }), ConfigError);
  });

  it('rejects a rules entry with no enabled flag', () => {
    assert.throws(() => resolveConfig({ rules: { 'tool-call-name': {} } }), ConfigError);
  });

  it('rejects a rules entry with an unknown key', () => {
    assert.throws(
      () => resolveConfig({ rules: { 'tool-call-name': { enabled: true, typo: 1 } } }),
      ConfigError,
    );
  });

  it('produces engine options keyed by rule id', () => {
    const config = resolveConfig({ rules: { 'tool-call-name': { enabled: false } } });
    assert.deepEqual(healerOptions(config), { rules: { 'tool-call-name': { enabled: false } } });
  });
});

describe('resolveConfig · additional guards', () => {
  it('rejects a non-object rules collection', () => {
    assert.throws(() => resolveConfig({ rules: 'tool-call-name' }), ConfigError);
    assert.throws(() => resolveConfig({ rules: ['tool-call-name'] }), ConfigError);
    assert.throws(() => resolveConfig({ rules: 7 }), ConfigError);
  });

  it('accepts an explicitly empty rules collection', () => {
    assert.deepEqual(resolveConfig({ rules: {} }).rules, {});
  });

  it('treats a null config as the defaults', () => {
    assert.deepEqual(resolveConfig(null), DEFAULT_CONFIG);
  });

  it('keeps options alongside enabled', () => {
    const config = resolveConfig({ rules: { r: { enabled: false, options: null } } });
    assert.deepEqual(config.rules.r, { enabled: false, options: null });
  });
});
