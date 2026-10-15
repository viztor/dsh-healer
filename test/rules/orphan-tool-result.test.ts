/**
 * Unit matrix for the `orphan-tool-result` rule (WORKFLOW.md N11).
 *
 * Import isolation: this file imports its own rule module and `node:test` /
 * `node:assert` and nothing else. No engine, no rule index, no other rule, no
 * plugin. The engine's phase ordering and role-skip reporting live in
 * test/engine.test.ts and are deliberately not duplicated here.
 *
 * @module dsh-healer/test/rules/orphan-tool-result.test
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { detect, id, repair, roles, rule } from '../../src/rules/orphan-tool-result.ts';

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
    { role: 'tool' as const, content: [] as unknown[], ...message },
    { phase: 'message' as const, index, messages, survivingToolCallIds },
  ] as const;
}

/** A tool-role message answering `callId`, judged against `surviving`. */
function result(callId: string | undefined, surviving: Iterable<string>, index = 0) {
  return view({
    index,
    ...(callId === undefined ? {} : { toolCallId: callId }),
    survivingToolCallIds: new Set(surviving),
  });
}

describe('orphan-tool-result · module surface', () => {
  it('exports the documented identity', () => {
    assert.equal(id, 'orphan-tool-result');
    assert.deepEqual(roles, ['tool']);
  });

  it('exports a message rule, enabled by default, scoped to tool', () => {
    assert.equal(rule.id, 'orphan-tool-result');
    assert.equal(rule.kind, 'message');
    assert.equal(rule.enabledByDefault, true);
    assert.deepEqual(rule.roles, ['tool']);
    assert.equal(typeof rule.detect, 'function');
    assert.equal(typeof rule.repair, 'function');
  });

  it('declares a role scope that excludes every non-tool role (D-8a)', () => {
    // The rule-side half of "orphan-tool-result ignores a user/assistant message
    // even if it carries a toolCallId-shaped field": the engine never shows this
    // rule such a message. The engine's skip entry is asserted in
    // test/engine.test.ts. `detect` itself never looks at `input.role`.
    for (const role of ['system', 'developer', 'user', 'assistant'] as const) {
      assert.ok(
        !(rule.roles ?? []).includes(role),
        `roles must not include "${role}" — only a tool result can be orphaned`,
      );
    }
  });
});

describe('orphan-tool-result · correlation', () => {
  it('reports a toolCallId with NO surviving call', () => {
    const finding = detect(...result('call-9', []));
    assert.ok(finding, 'expected a finding for a result whose call did not survive');
    assert.equal(finding.ruleId, 'orphan-tool-result');
    assert.match(finding.reason, /call-9/);
    assert.match(finding.reason, /no surviving tool call/);
    assert.deepEqual(finding.detail, { toolCallId: 'call-9' });
  });

  it('returns undefined when the toolCallId has a surviving call', () => {
    assert.equal(detect(...result('call-9', ['call-9'])), undefined);
  });

  it('returns undefined when the id survives among many', () => {
    assert.equal(detect(...result('call-9', ['call-1', 'call-9', 'call-30'])), undefined);
  });

  it('reports one orphan among many surviving calls', () => {
    assert.ok(detect(...result('call-9', ['call-1', 'call-2', 'call-30'])));
  });

  it('carries the message index through', () => {
    const finding = detect(...result('call-9', [], 4810));
    assert.ok(finding);
    assert.equal(typeof finding.messageIndex, 'number');
  });
});

describe('orphan-tool-result · a result with nothing to correlate is not reported', () => {
  it('returns undefined when there is no toolCallId field', () => {
    assert.equal(detect(...view({ survivingToolCallIds: new Set(['call-1']) })), undefined);
  });

  it('returns undefined for an empty-string toolCallId', () => {
    assert.equal(detect(...result('', [])), undefined);
  });

  it('returns undefined for a non-string toolCallId', () => {
    for (const value of [42, null, undefined, true, {}, ['call-9']]) {
      assert.equal(detect(...view({ toolCallId: value })), undefined);
    }
  });

  it('returns undefined for toolCallId: 0 and toolCallId: false', () => {
    assert.equal(detect(...view({ toolCallId: 0 })), undefined);
    assert.equal(detect(...view({ toolCallId: false })), undefined);
  });
});

describe('orphan-tool-result · the cascade case (content phase removed the call)', () => {
  // This is the case that matters most. In the incident the fabricated call was
  // dispatched and answered, so nothing was orphaned until `tool-call-name`
  // removed the call. The rule is shown the post-content-phase id set, which no
  // longer contains the removed call, so the result must be reported.
  it('reports a result whose call was removed by the content phase', () => {
    const survivingAfterContentPhase = new Set(['call-1', 'call-2']);
    const finding = detect(...result('call-3', survivingAfterContentPhase));
    assert.ok(finding, 'a call removed by the content phase orphans its result');
    assert.deepEqual(finding.detail, { toolCallId: 'call-3' });
    assert.equal(survivingAfterContentPhase.has('call-3'), false);
  });

  it('does not report the results whose calls survived the same phase', () => {
    const survivingAfterContentPhase = new Set(['call-1', 'call-2']);
    assert.equal(detect(...result('call-1', survivingAfterContentPhase)), undefined);
    assert.equal(detect(...result('call-2', survivingAfterContentPhase)), undefined);
  });

  it('reports every orphan when the only call was removed', () => {
    const survivingAfterContentPhase = new Set<string>();
    assert.ok(detect(...result('call-3', survivingAfterContentPhase)));
  });
});

describe('orphan-tool-result · ids are compared literally, not parsed', () => {
  it('distinguishes the harness-synthesised ids "call-3" and "call-30"', () => {
    const surviving = new Set(['call-30']);
    assert.ok(
      detect(...result('call-3', surviving)),
      '"call-3" must not be satisfied by "call-30" — no prefix or numeric parsing',
    );
    assert.equal(detect(...result('call-30', surviving)), undefined);
  });

  it('distinguishes "call-30" from a surviving "call-3" in the other direction', () => {
    const surviving = new Set(['call-3']);
    assert.ok(detect(...result('call-30', surviving)));
    assert.equal(detect(...result('call-3', surviving)), undefined);
  });

  it('distinguishes ids that differ only in case', () => {
    assert.ok(detect(...result('call-3', ['Call-3'])));
  });

  it('treats a whitespace-only id literally rather than trimming it', () => {
    // Non-empty, so it is a correlation attempt; it matches nothing.
    assert.ok(detect(...result('   ', ['call-3'])));
    assert.equal(detect(...result('   ', ['   '])), undefined);
  });

  it('does not substring-match a longer surviving id', () => {
    assert.ok(detect(...result('call', ['call-30', 'my-call-3'])));
  });
});

describe('orphan-tool-result · a missing surviving-call set means "cannot tell"', () => {
  // Deliberate design decision, not an accident: without the set the rule cannot
  // distinguish an orphan from a matched result, and guessing "orphan" would
  // drop a real tool result. The safe answer is to report nothing.
  it('returns undefined when survivingToolCallIds is absent', () => {
    const input = { phase: 'message', index: 0, role: 'tool', toolCallId: 'call-1' };
    assert.doesNotThrow(() => detect(input));
    assert.equal(detect(input), undefined);
  });

  it('returns undefined when survivingToolCallIds is null', () => {
    assert.equal(detect(...view({ toolCallId: 'call-1', survivingToolCallIds: null })), undefined);
  });

  it('returns undefined when the set is absent even for an otherwise perfect orphan', () => {
    const input = { phase: 'message', index: 114, role: 'tool', content: [], toolCallId: 'call-3' };
    assert.equal(detect(input), undefined);
  });
});

describe('orphan-tool-result · never throws on a shape it was not written against', () => {
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
    for (const value of [7, 'call-1', true, []]) {
      assert.doesNotThrow(() => detect(value));
      assert.equal(detect(value), undefined);
    }
  });
});

describe('orphan-tool-result · repair', () => {
  it('drops the whole message — a result with no call cannot be sent', () => {
    assert.deepEqual(repair(), { action: 'drop' });
  });

  it('drops through the exported rule entry point', () => {
    const finding = detect(...result('call-9', []));
    assert.ok(finding);
    assert.deepEqual(rule.repair(finding, { phase: 'message', messages: [] }), { action: 'drop' });
  });
});

describe('orphan-tool-result · a non-Set surviving collection', () => {
  // `survivingToolCallIds` is typed as a Set and the engine always supplies a
  // real one, so this is outside the declared contract. It is still guarded,
  // because a rule that throws takes down the whole request and the engine's
  // rule-contract test feeds rules deliberately hostile input. A non-Set means
  // "cannot tell", and the safe answer to "cannot tell" is to report nothing
  // rather than drop a result that may well be legitimate.
  // The message is the target; the collection lives on the context.
  const base = { role: 'tool' as const, toolCallId: 'call-1' };
  const ctxWith = (survivingToolCallIds: unknown) =>
    ({ phase: 'message' as const, index: 0, messages: [], survivingToolCallIds }) as never;

  for (const [label, surviving] of [
    ['an array', []],
    ['a plain object', {}],
    ['a string', 'call-1'],
    ['a number', 7],
  ] as const) {
    it(`reports nothing rather than throwing when the collection is ${label}`, () => {
      let finding: unknown;
      assert.doesNotThrow(() => {
        finding = detect(base, ctxWith(surviving));
      });
      assert.equal(finding, undefined);
    });
  }

  it('still reports a genuine orphan when a real Set is supplied', () => {
    const finding = detect(base, ctxWith(new Set(['other'])));
    assert.ok(finding, 'a real Set without the id must still produce a finding');
  });

  it('still keeps a matched result when a real Set is supplied', () => {
    assert.equal(detect(base, ctxWith(new Set(['call-1']))), undefined);
  });
});
