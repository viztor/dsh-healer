/**
 * Unit matrix for the `tool-call-name` rule (WORKFLOW.md N11).
 *
 * Import isolation is the point of this node: this file imports its own rule
 * module, the test runner, and `node:assert` — nothing else. It never imports the
 * engine, the rule index, another rule, or the plugin — which is what proves the
 * rule is a self-contained pure function. Engine-level behaviour (phase order,
 * role scoping, application, identity preservation) is covered by
 * test/engine.test.ts and is deliberately not duplicated here.
 *
 * @module dsh-healer/test/rules/tool-call-name.test
 */

import { describe, it } from 'vite-plus/test';
import assert from 'node:assert/strict';

import { detect, id, repair, roles, rule } from '../../src/rules/tool-call-name.ts';

/** Build the content-phase envelope the engine hands a content rule. */
/**
 * Build the (block, context) pair the engine hands a content rule.
 *
 * The rule is handed the block itself — the coordinates belong to the engine —
 * so this returns the block plus the context, and call sites spread it.
 */
function at(block: unknown, messageIndex = 0, blockIndex = 0) {
  return [block, { phase: 'content' as const, messageIndex, blockIndex }] as const;
}

/** A minimal well-formed tool call. */
function call(over: Record<string, unknown> = {}) {
  return { type: 'tool-call', id: 'call-1', name: 'read', arguments: '{}', ...over };
}

describe('tool-call-name · module surface', () => {
  it('exports the documented identity', () => {
    assert.equal(id, 'tool-call-name');
    assert.deepEqual(roles, ['assistant']);
  });

  it('exports a content rule, enabled by default, scoped to assistant', () => {
    assert.equal(rule.id, 'tool-call-name');
    assert.equal(rule.kind, 'content');
    assert.equal(rule.enabledByDefault, true);
    assert.deepEqual(rule.roles, ['assistant']);
    assert.equal(typeof rule.detect, 'function');
    assert.equal(typeof rule.repair, 'function');
  });

  it('declares a role scope that excludes every non-assistant role (D-8a)', () => {
    // The rule-side half of D-8a: a tool call inside a user/tool/system message
    // can never be judged, because the engine refuses to show this rule that
    // message. The engine's skip reporting is asserted in test/engine.test.ts.
    for (const role of ['system', 'developer', 'user', 'tool'] as const) {
      assert.ok(
        !(rule.roles ?? []).includes(role),
        `roles must not include "${role}" — a tool call there is not model-authored`,
      );
    }
  });
});

describe('tool-call-name · unusable names are findings', () => {
  it('reports an empty-string name', () => {
    const finding = detect(...at(call({ name: '' })));
    assert.ok(finding, 'expected a finding for name: ""');
    assert.equal(finding.ruleId, 'tool-call-name');
    assert.match(finding.reason, /empty/i);
    assert.deepEqual(finding.detail, { tag: 'tool-call', name: '' });
  });

  it('reports a whitespace-only name', () => {
    const finding = detect(...at(call({ name: '   ' })));
    assert.ok(finding, 'expected a finding for a whitespace-only name');
    assert.match(finding.reason, /empty/i);
    assert.deepEqual(finding.detail, { tag: 'tool-call', name: '   ' });
  });

  it('reports a tab/newline-only name', () => {
    assert.ok(detect(...at(call({ name: '\t\n ' }))));
  });

  it('reports name: null', () => {
    const finding = detect(...at(call({ name: null })));
    assert.ok(finding);
    assert.match(finding.reason, /no string/i);
    assert.deepEqual(finding.detail, { tag: 'tool-call', name: null });
  });

  it('reports a numeric name', () => {
    const finding = detect(...at(call({ name: 42 })));
    assert.ok(finding);
    assert.deepEqual(finding.detail, { tag: 'tool-call', name: null });
  });

  it('reports an object name', () => {
    const finding = detect(...at(call({ name: { nested: true } })));
    assert.ok(finding);
    assert.deepEqual(finding.detail, { tag: 'tool-call', name: null });
  });

  it('reports an array name', () => {
    assert.ok(detect(...at(call({ name: ['read'] }))));
  });

  it('reports a MISSING name key', () => {
    const finding = detect(...at({ type: 'tool-call', id: 'call-1', arguments: '{}' }));
    assert.ok(finding, 'expected a finding when the name key is absent');
    assert.match(finding.reason, /no string/i);
    assert.deepEqual(finding.detail, { tag: 'tool-call', name: null });
  });

  it('reports name: undefined explicitly present', () => {
    assert.ok(detect(...at(call({ name: undefined }))));
  });

  it('carries a non-empty reason and a numeric coordinate placeholder', () => {
    // The engine owns the coordinates (src/engine.ts: "The engine owns the
    // coordinates; a rule supplies only the reason"), so only the shape is
    // pinned here, not the placeholder value.
    const finding = detect(...at(call({ name: '' })));
    assert.ok(finding);
    assert.equal(typeof finding.reason, 'string');
    assert.ok(finding.reason.length > 0);
    assert.equal(typeof finding.messageIndex, 'number');
  });
});

describe('tool-call-name · usable names are not findings', () => {
  it('returns undefined for a plain name', () => {
    assert.equal(detect(...at(call({ name: 'read' }))), undefined);
  });

  it('returns undefined for a name with surrounding whitespace', () => {
    assert.equal(detect(...at(call({ name: '  read  ' }))), undefined);
  });

  it('returns undefined for a non-ASCII name', () => {
    assert.equal(detect(...at(call({ name: 'файл_читать' }))), undefined);
  });

  it('returns undefined for the legacy tool_use tag with a valid name', () => {
    assert.equal(
      detect(...at({ type: 'tool_use', id: 'tu-1', name: 'read', input: {} })),
      undefined,
    );
  });
});

describe('tool-call-name · forward compatibility with the legacy tag', () => {
  it('reports an empty name on a legacy tool_use block', () => {
    const finding = detect(...at({ type: 'tool_use', id: 'tu-1', name: '', input: {} }));
    assert.ok(finding, 'expected a finding for a legacy tool_use with an empty name');
    assert.deepEqual(finding.detail, { tag: 'tool_use', name: '' });
    assert.match(finding.reason, /tool_use/);
  });

  it('reports a MISSING name on a legacy tool_use block', () => {
    const finding = detect(...at({ type: 'tool_use', id: 'tu-1', input: {} }));
    assert.ok(finding);
    assert.deepEqual(finding.detail, { tag: 'tool_use', name: null });
  });
});

describe('tool-call-name · every non-tool block type is ignored', () => {
  const NON_TOOL_BLOCKS: ReadonlyArray<readonly [string, unknown]> = [
    ['text', { type: 'text', text: '' }],
    ['reasoning', { type: 'reasoning', text: 'thinking' }],
    ['image', { type: 'image', source: { type: 'base64', data: '' } }],
    ['file', { type: 'file', filename: 'a.txt' }],
    ['tool-addition', { type: 'tool-addition', tools: [] }],
    ['tool-removal', { type: 'tool-removal', toolNames: ['read'] }],
    ['tool-result', { type: 'tool-result', toolCallId: 'call-1', content: [] }],
    ['tool_result', { type: 'tool_result', tool_use_id: 'call-1' }],
  ];

  for (const [label, block] of NON_TOOL_BLOCKS) {
    it(`ignores a ${label} block`, () => {
      assert.equal(detect(...at(block)), undefined);
    });
  }

  it('ignores a non-tool block even when it carries a name-shaped field', () => {
    assert.equal(detect(...at({ type: 'text', name: '', text: 'hi' })), undefined);
  });
});

describe('tool-call-name · unknown and hostile input never throws', () => {
  const UNKNOWN_INPUTS: ReadonlyArray<readonly [string, unknown]> = [
    ['an unknown tag', { type: 'brand-new-block-type', name: '' }],
    ['a garbage tag', { type: '  ', name: '' }],
    ['a non-string type', { type: 7, name: '' }],
    ['a null type', { type: null, name: '' }],
    ['a missing type', { name: '' }],
    ['an empty object', {}],
    ['an array', []],
    ['a bare string', 'tool-call'],
    ['a bare number', 7],
    ['null', null],
    ['a boolean', true],
  ];

  for (const [label, value] of UNKNOWN_INPUTS) {
    it(`returns undefined for ${label}`, () => {
      assert.doesNotThrow(() => detect(...at(value)));
      assert.equal(detect(...at(value)), undefined);
    });
  }
});

describe('tool-call-name · defensive on a missing envelope', () => {
  // src/types.ts: "A rule never ... throws for expected input", and the engine
  // promises to survive a shape it was not written against.
  it('returns undefined for an undefined input', () => {
    assert.doesNotThrow(() => detect(undefined));
    assert.equal(detect(undefined), undefined);
  });

  it('returns undefined for a null input', () => {
    assert.doesNotThrow(() => detect(null));
    assert.equal(detect(null), undefined);
  });

  it('returns undefined for an empty envelope', () => {
    assert.doesNotThrow(() => detect({}));
    assert.equal(detect({}), undefined);
  });

  it('returns undefined when the envelope carries a non-object block', () => {
    assert.equal(
      detect({ phase: 'content', block: undefined, messageIndex: 0, blockIndex: 0 }),
      undefined,
    );
  });
});

describe('tool-call-name · repair', () => {
  it('drops the block — a substituted name would be a fabricated invocation', () => {
    assert.deepEqual(repair(), { action: 'drop' });
  });

  it('drops through the exported rule entry point', () => {
    const finding = detect(...at(call({ name: '' })));
    assert.ok(finding);
    assert.deepEqual(rule.repair(finding, { phase: 'content', messages: [] }), { action: 'drop' });
  });

  it('never returns replace or keep for any finding shape', () => {
    for (const value of ['', '   ', null, 42, {}, ['x']]) {
      const finding = detect(...at(call({ name: value })));
      assert.ok(finding);
      assert.equal(rule.repair(finding, { phase: 'content', messages: [] }).action, 'drop');
    }
  });
});

describe('tool-call-name · order independence within the content phase', () => {
  // A content rule judges one block alone, so its verdict must not depend on
  // where the block sits in the message. This is the rule-local half of the
  // N11 order-independence property; the engine half lives in engine.test.ts.
  it('gives a valid block the same verdict at any position', () => {
    const block = call({ name: 'read' });
    const verdicts = [
      detect(...at(block, 0, 0)),
      detect(...at(block, 0, 1)),
      detect(...at(block, 0, 99)),
      detect(...at(block, 114, 3)),
      detect(...at(block, 4810, 7)),
    ];
    assert.deepEqual(verdicts, [undefined, undefined, undefined, undefined, undefined]);
  });

  it('gives an invalid block the same verdict at any position', () => {
    const block = call({ name: '' });
    for (const [messageIndex, blockIndex] of [
      [0, 0],
      [0, 1],
      [0, 99],
      [114, 3],
      [4810, 7],
    ] as const) {
      const finding = detect(...at(block, messageIndex, blockIndex));
      assert.ok(finding, `expected a finding at message ${messageIndex} block ${blockIndex}`);
      assert.deepEqual(finding.detail, { tag: 'tool-call', name: '' });
    }
  });

  it('judges a valid block the same whether or not other blocks precede it', () => {
    // "Preceding blocks" cannot reach the rule at all, so the assertion is that
    // a mixed message produces exactly one finding per bad block and none for
    // the good ones — evaluated block by block, in both orders.
    const good = call({ id: 'call-ok', name: 'read' });
    const bad = call({ id: 'call-bad', name: '' });
    const forward = [good, bad].map((block, blockIndex) => detect(...at(block, 0, blockIndex)));
    const reverse = [bad, good].map((block, blockIndex) => detect(...at(block, 0, blockIndex)));

    assert.deepEqual(
      forward.map((f) => f === undefined),
      [true, false],
    );
    assert.deepEqual(
      reverse.map((f) => f === undefined),
      [false, true],
    );
  });

  it('does not mutate the block it was shown', () => {
    const block = call({ name: '' });
    const snapshot = structuredClone(block);
    detect(...at(block));
    assert.deepEqual(block, snapshot);
  });
});
