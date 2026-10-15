/**
 * Unit matrix for the `empty-assistant-message` rule (WORKFLOW.md N11).
 *
 * Import isolation: this file imports its own rule module and `node:test` /
 * `node:assert` and nothing else. No engine, no rule index, no other rule, no
 * plugin. The engine's phase ordering and role-skip reporting live in
 * test/engine.test.ts and are deliberately not duplicated here.
 *
 * @module dsh-healer/test/rules/empty-assistant-message.test
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { detect, id, repair, roles, rule } from '../../src/rules/empty-assistant-message.ts';

/**
 * Build the (message, context) pair the engine hands a message rule.
 *
 * The rule is handed the message itself, so the message is the target and the
 * context carries the position and the surviving ids. Call sites spread this.
 */
function view(over: Record<string, unknown> = {}) {
  // Read the context fields with explicit narrowing: `over` is an untyped bag,
  // so a destructure would leave them `unknown` and the context would not type.
  const index = typeof over.index === 'number' ? over.index : 0;
  const messages = Array.isArray(over.messages) ? over.messages : [];
  // Preserve the value as given — including `null`, which the rule must treat as
  // "cannot tell" rather than as an empty set that would report an orphan.
  const survivingToolCallIds = (
    'survivingToolCallIds' in over ? over.survivingToolCallIds : new Set<string>()
  ) as ReadonlySet<string>;
  const {
    index: _i,
    messages: _m,
    survivingToolCallIds: _s,
    phase: _p,
    original: _o,
    ...message
  } = over;
  return [
    { role: 'assistant' as const, content: [] as unknown[], ...message },
    { phase: 'message' as const, index, messages, survivingToolCallIds },
  ] as const;
}

describe('empty-assistant-message · module surface', () => {
  it('exports the documented identity', () => {
    assert.equal(id, 'empty-assistant-message');
    assert.deepEqual(roles, ['assistant']);
  });

  it('exports a message rule that is DISABLED by default (D-14)', () => {
    // Deliberate: content: [] is provider-dependent, so emptying a message is an
    // opt-in decision rather than an automatic consequence of the content phase.
    assert.equal(rule.id, 'empty-assistant-message');
    assert.equal(rule.kind, 'message');
    assert.equal(rule.enabledByDefault, false);
    assert.deepEqual(rule.roles, ['assistant']);
    assert.equal(typeof rule.detect, 'function');
    assert.equal(typeof rule.repair, 'function');
  });

  it('declares a role scope that excludes every non-assistant role', () => {
    // Only an assistant message can be emptied by the content phase. The
    // engine's skip entry is asserted in test/engine.test.ts.
    for (const role of ['system', 'developer', 'user', 'tool'] as const) {
      assert.ok(
        !(rule.roles ?? []).includes(role),
        `roles must not include "${role}" — only an assistant turn can be emptied`,
      );
    }
  });
});

describe('empty-assistant-message · empty content is a finding', () => {
  it('reports content: []', () => {
    const finding = detect(...view({ content: [] }));
    assert.ok(finding, 'expected a finding for content: []');
    assert.equal(finding.ruleId, 'empty-assistant-message');
    assert.match(finding.reason, /no content blocks left/);
    assert.deepEqual(finding.detail, { role: 'assistant' });
  });

  it('carries the message index through', () => {
    const finding = detect(...view({ content: [], index: 114 }));
    assert.ok(finding);
    assert.equal(typeof finding.messageIndex, 'number');
  });

  it('reports content: [] for a user-role envelope too (the engine owns role scoping)', () => {
    // `detect` never inspects `input.role`; the engine refuses to show this rule
    // a non-assistant message. Asserting the rule's own indifference documents
    // that the scoping cannot be silently duplicated in the rule.
    const finding = detect(...view({ content: [], role: 'user' }));
    assert.ok(finding);
    assert.deepEqual(finding.detail, { role: 'user' });
  });
});

describe('empty-assistant-message · content with blocks is not a finding', () => {
  it('returns undefined for one block', () => {
    assert.equal(detect(...view({ content: [{ type: 'text', text: 'hi' }] })), undefined);
  });

  it('returns undefined for several blocks', () => {
    const content = [
      { type: 'reasoning', text: 'thinking' },
      { type: 'text', text: 'answer' },
      { type: 'tool-call', id: 'call-1', name: 'read', arguments: '{}' },
    ];
    assert.equal(detect(...view({ content })), undefined);
  });

  it('returns undefined for a single surviving block of any shape', () => {
    for (const block of [{ type: 'text', text: '' }, {}, null, 7, 'x']) {
      assert.equal(detect(...view({ content: [block] })), undefined);
    }
  });
});

describe('empty-assistant-message · the post-content-phase view', () => {
  // The reachable path: the message had one block, and the content phase removed
  // it. The rule is shown the post-phase content, so it sees [].
  it('reports a message that was non-empty and was then emptied', () => {
    const before = [{ type: 'tool-call', id: 'call-1', name: '', arguments: '{}' }];
    const afterContentPhase: unknown[] = [];
    // Sanity: the pre-phase message was NOT empty, so this is a real transition.
    assert.equal(before.length > 0, true);

    const finding = detect(...view({ content: afterContentPhase }));
    assert.ok(finding, 'an assistant turn emptied by the content phase must be reported');
    assert.deepEqual(finding.detail, { role: 'assistant' });
  });

  it('does not report the same message while its block is still present', () => {
    const before = [{ type: 'tool-call', id: 'call-1', name: '', arguments: '{}' }];
    assert.equal(detect(...view({ content: before })), undefined);
  });

  it('reports each emptied message independently', () => {
    const emptied = [0, 1, 2].map((index) => detect(...view({ content: [], index })));
    assert.deepEqual(
      emptied.map((f) => f === undefined),
      [false, false, false],
    );
  });
});

describe('empty-assistant-message · never throws on a shape it was not written against', () => {
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

  it('returns undefined for a non-object input', () => {
    for (const value of [7, 'assistant', true]) {
      assert.doesNotThrow(() => detect(value));
      assert.equal(detect(value), undefined);
    }
  });

  it('returns undefined when content is not an array', () => {
    // A non-array content cannot be "emptied", and reading `.length` off it was
    // the original defect. Only an array with zero entries is a finding.
    for (const content of [null, undefined, 'hi', 7, {}, { length: 0 }, true]) {
      assert.doesNotThrow(() => detect(...view({ content })));
      assert.equal(detect(...view({ content })), undefined);
    }
  });

  it('returns undefined for an empty envelope with a stray length field', () => {
    assert.equal(detect({ content: { length: 0 } }), undefined);
  });
});

describe('empty-assistant-message · repair', () => {
  it('drops the message — an empty assistant turn carries no information', () => {
    assert.deepEqual(repair(), { action: 'drop' });
  });

  it('drops through the exported rule entry point', () => {
    const finding = detect(...view({ content: [] }));
    assert.ok(finding);
    assert.deepEqual(rule.repair(finding, { phase: 'message', messages: [] }), { action: 'drop' });
  });

  it('never returns replace or keep for any finding shape', () => {
    for (const index of [0, 1, 114, 4810]) {
      const finding = detect(...view({ content: [], index }));
      assert.ok(finding);
      assert.equal(rule.repair(finding, { phase: 'message', messages: [] }).action, 'drop');
    }
  });
});
