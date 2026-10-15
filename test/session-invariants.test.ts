/**
 * The provider invariants the audit reports on.
 *
 * `scripts/audit-session.mjs` is how every offline claim in TESTPLAN is produced —
 * "2 343 provider-visible messages, 2 fixes applied, PASS". Its invariant check was
 * inline, unexported and untested, so the numbers it printed were only as good as
 * nobody looking at it.
 *
 * It is deliberately an **independent** implementation from the rules: it exists to
 * cross-check them, and sharing the code would make the check circular. That makes
 * testing it more important, not less — an independent implementation nobody
 * verified is a second opinion with no credentials.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'vite-plus/test';

import { createHealer } from '../src/engine.ts';
import { DEFAULT_RULES } from '../src/rules/index.ts';
import { auditInvariants } from '../scripts/session-history.ts';
import type { MessageLike } from '../src/types.ts';

const assistant = (content: readonly unknown[]): MessageLike => ({ role: 'assistant', content });
const tool = (toolCallId: string | undefined, content: readonly unknown[] = []): MessageLike => ({
  role: 'tool',
  ...(toolCallId === undefined ? {} : { toolCallId }),
  content,
});
const call = (id: unknown, name: unknown) => ({ type: 'tool-call', id, name, arguments: '{}' });

describe('auditInvariants · empty names', () => {
  it('counts an empty name', () => {
    assert.equal(auditInvariants([assistant([call('c1', '')])]).emptyNames, 1);
  });

  it('counts a whitespace-only name', () => {
    assert.equal(auditInvariants([assistant([call('c1', '   ')])]).emptyNames, 1);
  });

  it('counts a missing name', () => {
    assert.equal(auditInvariants([assistant([call('c1', undefined)])]).emptyNames, 1);
  });

  it('does not count a valid name', () => {
    assert.equal(auditInvariants([assistant([call('c1', 'bash')])]).emptyNames, 0);
  });

  it('ignores a tool call parked in a non-assistant role', () => {
    // Only the assistant's calls are sent as calls, so a "call" elsewhere is not
    // a call the provider will see.
    const user: MessageLike = { role: 'user', content: [call('c1', '')] };
    assert.equal(auditInvariants([user]).emptyNames, 0);
  });
});

describe('auditInvariants · malformed calls', () => {
  it('counts a missing id', () => {
    assert.equal(auditInvariants([assistant([call(undefined, 'bash')])]).malformedCalls, 1);
  });

  it('counts an empty id', () => {
    assert.equal(auditInvariants([assistant([call('', 'bash')])]).malformedCalls, 1);
  });

  it('counts a non-string id', () => {
    assert.equal(auditInvariants([assistant([call(7, 'bash')])]).malformedCalls, 1);
  });

  it('does not count a usable id', () => {
    assert.equal(auditInvariants([assistant([call('c1', 'bash')])]).malformedCalls, 0);
  });
});

describe('auditInvariants · stranded results', () => {
  it('counts a result whose call is absent', () => {
    assert.equal(auditInvariants([tool('c1')]).strandedResults, 1);
  });

  it('does not count a result whose call is present', () => {
    assert.equal(auditInvariants([assistant([call('c1', 'bash')]), tool('c1')]).strandedResults, 0);
  });

  it('does not count a result with no reference at all', () => {
    // Nothing to correlate, and `malformedCalls` already covers the call side.
    // Treating it as stranded would report a phantom.
    assert.equal(auditInvariants([tool(undefined)]).strandedResults, 0);
  });

  it('does not let an id-less call provide a matchable id', () => {
    // The bug this pins: `ids.add(String(block.id))` put the literal string
    // "undefined" into the set for every id-less call, so a result whose reference
    // happened to be that string looked correlated when it answers nothing.
    //
    // Only this case distinguishes the two implementations — an id-less *result* is
    // skipped by both — which is why the assertion is written against the id side.
    const messages = [assistant([call(undefined, 'bash')]), tool('undefined')];
    const result = auditInvariants(messages);
    assert.equal(result.malformedCalls, 1, 'the call is malformed');
    assert.equal(result.strandedResults, 1, 'the result answers nothing');
  });
});

describe('auditInvariants · agreement with the rules', () => {
  /**
   * The audit exists to cross-check the rules, so where they overlap they must
   * agree. A disagreement means one of the two is wrong, and the audit is the one
   * nobody would notice.
   */
  const healer = createHealer(DEFAULT_RULES);

  const CASES: [string, MessageLike[]][] = [
    ['clean', [assistant([call('c1', 'bash')]), tool('c1')]],
    ['empty name', [assistant([call('c1', '')]), tool('c1')]],
    ['stranded', [assistant([call('c1', 'bash')]), tool('c2')]],
    ['the real cascade', [assistant([call('call-3', '')]), tool('call-3')]],
    ['no tool calls at all', [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]],
  ];

  for (const [label, messages] of CASES) {
    it(`agrees with the rules on: ${label}`, () => {
      const findings = healer.check(messages);
      const byRule = (id: string) => findings.filter((finding) => finding.ruleId === id).length;
      const invariants = auditInvariants(messages);

      assert.equal(
        invariants.emptyNames,
        byRule('tool-call-name'),
        'tool-call-name and emptyNames must count the same thing',
      );
      assert.equal(
        invariants.strandedResults,
        byRule('orphan-tool-result'),
        'orphan-tool-result and strandedResults must count the same thing',
      );
    });
  }

  it('agrees on a history the healer actually changes', () => {
    // The cascade case: the healer removes the call and its result, so after the
    // repair both counts must reach zero — and they must do so together.
    const messages = [assistant([call('call-3', '')]), tool('call-3')];
    const before = auditInvariants(messages);
    assert.equal(before.emptyNames, 1);
    assert.equal(before.strandedResults, 0, 'nothing is stranded until the call is removed');

    const after = auditInvariants(healer.heal(messages).messages);
    assert.deepEqual(after, { emptyNames: 0, malformedCalls: 0, strandedResults: 0 });
  });
});
