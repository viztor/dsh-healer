/**
 * Engine invariants, proven against **fake** rules.
 *
 * These tests never import the shipped rule set. The properties they assert —
 * identity preservation, immutability, phase order, accumulation, idempotence,
 * loud failure, pass-through — must survive any rule being added, removed or
 * rewritten, so proving them against the real rules would prove nothing.
 *
 * No DSH runtime, no cordis context, no network.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createHealer, unknownRuleIds } from '../src/engine.ts';
import type { Finding, MessageLike, RepairDecision, Rule } from '../src/types.ts';

const msg = (
  role: MessageLike['role'],
  content: unknown[],
  extra: Record<string, unknown> = {},
): MessageLike => ({
  role,
  content,
  ...extra,
});

/** A content rule that reports on blocks whose `type` is in `tags`. */
function dropTags(id: string, tags: readonly string[]): Rule {
  return {
    id,
    kind: 'content',
    enabledByDefault: true,
    description: `drop ${tags.join('/')}`,
    roles: ['assistant'],
    detect: (target) => {
      const block = target as Record<string, unknown>;
      if (typeof block !== 'object' || block === null) return undefined;
      if (!tags.includes(String(block.type))) return undefined;
      return { ruleId: id, reason: `drop ${String(block.type)}`, messageIndex: -1 };
    },
    repair: (): RepairDecision => ({ action: 'drop' }),
  };
}

/** A rule that drops every block it is shown. */
const dropAll: Rule = {
  id: 'drop-all',
  kind: 'content',
  enabledByDefault: true,
  description: 'drops every block',
  detect: () => ({ ruleId: 'drop-all', reason: 'everything', messageIndex: -1 }),
  repair: () => ({ action: 'drop' }),
};

/** A rule that reports nothing. */
const dropNothing: Rule = {
  id: 'drop-nothing',
  kind: 'content',
  enabledByDefault: true,
  description: 'reports nothing',
  detect: () => undefined,
  repair: () => ({ action: 'keep' }),
};

/** A rule that throws from detect. */
const throwing: Rule = {
  id: 'throwing',
  kind: 'content',
  enabledByDefault: true,
  description: 'throws',
  detect: () => {
    throw new Error('rule exploded');
  },
  repair: () => ({ action: 'keep' }),
};

/** A message rule that drops tool messages with a given call id. */
function dropToolCall(id: string, callId: string): Rule {
  return {
    id,
    kind: 'message',
    enabledByDefault: true,
    description: `drop tool result ${callId}`,
    roles: ['tool'],
    detect: (message, ctx) => {
      const view = message as { toolCallId?: string };
      const position = (ctx as unknown as { index: number }).index;
      if (view.toolCallId !== callId) return undefined;
      return { ruleId: id, reason: `drop ${callId}`, messageIndex: position };
    },
    repair: () => ({ action: 'drop' }),
  };
}

/** A disabled rule that records whether it was ever consulted. */
function countingDisabledRule(counter: { calls: number }): Rule {
  return {
    id: 'counting-disabled',
    kind: 'content',
    enabledByDefault: false,
    description: 'must never be consulted',
    detect: () => {
      counter.calls += 1;
      return undefined;
    },
    repair: () => ({ action: 'keep' }),
  };
}

const clean: readonly MessageLike[] = [
  msg('user', [{ type: 'text', text: 'hi' }]),
  msg('assistant', [{ type: 'text', text: 'hello' }]),
];

describe('engine invariants (fake rules)', () => {
  it('returns the input reference when no rule drops anything', () => {
    const healer = createHealer([dropNothing]);
    const report = healer.heal(clean);
    assert.equal(report.messages, clean, 'identity must be preserved');
    assert.deepEqual(report.applied, []);
  });

  it('returns the input reference with an empty rule set', () => {
    const healer = createHealer([]);
    assert.equal(healer.heal(clean).messages, clean);
    assert.deepEqual(healer.check(clean), []);
  });

  it('never mutates its input, and is correct on deep-frozen input', () => {
    const content = Object.freeze([{ type: 'tool-call', id: 'c1', name: '', arguments: '' }]);
    const frozen = Object.freeze([Object.freeze({ role: 'assistant' as const, content })]);
    const before = JSON.stringify(frozen);
    const healer = createHealer([dropTags('drop-tool', ['tool-call'])]);
    const report = healer.heal(frozen as readonly MessageLike[]);
    assert.equal(JSON.stringify(frozen), before, 'input must be unchanged');
    assert.equal(report.messages.length, 1);
    assert.deepEqual(report.messages[0]!.content, []);
  });

  it('never mutates a non-frozen input either', () => {
    const input: MessageLike[] = [
      msg('assistant', [{ type: 'tool-call', id: 'c1', name: '', arguments: '' }]),
    ];
    const snapshot = JSON.stringify(input);
    const healer = createHealer([dropTags('drop-tool', ['tool-call'])]);
    healer.heal(input);
    assert.equal(JSON.stringify(input), snapshot);
  });

  it('accumulates findings from several rules with correct coordinates', () => {
    const healer = createHealer([
      dropTags('drop-text', ['text']),
      dropTags('drop-tool', ['tool-call']),
    ]);
    const input = [
      msg('assistant', [
        { type: 'text', text: 'a' },
        { type: 'tool-call', id: 'c1', name: 'x', arguments: '{}' },
      ]),
    ];
    const report = healer.heal(input);
    assert.equal(report.applied.length, 2);
    assert.deepEqual(
      report.applied.map((fix) => [fix.ruleId, fix.blockIndex]),
      [
        ['drop-text', 0],
        ['drop-tool', 1],
      ],
    );
  });

  it('makes a content-phase drop visible to the message phase', () => {
    // The content rule removes the call; the message rule then sees the call id
    // as no longer surviving.
    const orphanByCall = dropToolCall('orphan', 'c1');
    const healer = createHealer([dropTags('drop-tool', ['tool-call']), orphanByCall]);
    const input = [
      msg('assistant', [{ type: 'tool-call', id: 'c1', name: 'x', arguments: '{}' }]),
      msg('tool', [{ type: 'text', text: 'ok' }], { toolCallId: 'c1' }),
    ];
    const report = healer.heal(input);
    assert.equal(report.messages.length, 1, 'the stranded result must go too');
    assert.equal(report.messages[0]!.role, 'assistant');
  });

  it('does not drop a tool result whose call survived', () => {
    const healer = createHealer([dropNothing, dropToolCall('orphan', 'c1')]);
    const input = [
      msg('assistant', [{ type: 'tool-call', id: 'c1', name: 'x', arguments: '{}' }]),
      msg('tool', [{ type: 'text', text: 'ok' }], { toolCallId: 'c1' }),
    ];
    // `dropToolCall` drops unconditionally when the id matches, so use a rule
    // that actually consults survivingToolCallIds instead.
    const realOrphan: Rule = {
      id: 'real-orphan',
      kind: 'message',
      enabledByDefault: true,
      description: 'drops only genuinely orphaned results',
      roles: ['tool'],
      detect: (message, ctx) => {
        // The message is the target; the ids and the position are on the context.
        const view = message as { toolCallId?: string };
        const context = ctx as unknown as {
          index: number;
          survivingToolCallIds: ReadonlySet<string>;
        };
        if (view.toolCallId === undefined) return undefined;
        if (context.survivingToolCallIds.has(view.toolCallId)) return undefined;
        return { ruleId: 'real-orphan', reason: 'orphan', messageIndex: context.index };
      },
      repair: () => ({ action: 'drop' }),
    };
    const report = createHealer([realOrphan]).heal(input);
    assert.equal(report.messages.length, 2, 'a matched result must survive');
    void healer;
  });

  it('is idempotent: a second pass reports nothing', () => {
    const healer = createHealer([
      dropTags('drop-tool', ['tool-call']),
      dropToolCall('orphan', 'c1'),
    ]);
    const input = [
      msg('assistant', [{ type: 'tool-call', id: 'c1', name: '', arguments: '' }]),
      msg('tool', [{ type: 'text', text: 'err' }], { toolCallId: 'c1' }),
    ];
    const first = healer.heal(input);
    const second = healer.heal(first.messages);
    assert.deepEqual(second.findings, []);
    assert.deepEqual(second.applied, []);
    assert.equal(second.messages, first.messages);
  });

  it('propagates a throwing rule rather than returning a half-repaired request', () => {
    const healer = createHealer([throwing]);
    assert.throws(() => healer.heal(clean), /rule exploded/);
    assert.throws(() => healer.check(clean), /rule exploded/);
  });

  it('never consults a disabled rule, and reports it as skipped', () => {
    const counter = { calls: 0 };
    const healer = createHealer([countingDisabledRule(counter)]);
    const report = healer.heal(clean);
    assert.equal(counter.calls, 0, 'a disabled rule must not be called');
    assert.deepEqual(report.skipped, [{ ruleId: 'counting-disabled', reason: 'disabled' }]);
    assert.equal(report.messages, clean);
  });

  it('honours a config override that enables a default-off rule', () => {
    const counter = { calls: 0 };
    const healer = createHealer([countingDisabledRule(counter)], {
      rules: { 'counting-disabled': { enabled: true } },
    });
    healer.check(clean);
    assert.ok(counter.calls > 0, 'the override must enable the rule');
  });

  it('honours a config override that disables a default-on rule', () => {
    const healer = createHealer([dropAll], { rules: { 'drop-all': { enabled: false } } });
    const report = healer.heal(clean);
    assert.equal(report.messages, clean);
    assert.deepEqual(report.applied, []);
  });

  it('records a role skip for every rule that cannot judge the message', () => {
    // Two role-scoped content rules and one out-of-scope message: both must be
    // reported, so the operator can see why neither fired.
    const healer = createHealer([
      dropTags('rule-a', ['text']),
      { ...dropTags('rule-b', ['text']), roles: ['assistant'] },
    ]);
    const report = healer.heal([msg('user', [{ type: 'text', text: 'a' }])]);
    const roleSkips = report.skipped.filter((entry) => entry.reason === 'role');
    assert.deepEqual(
      roleSkips.sort((a, b) => a.ruleId.localeCompare(b.ruleId)),
      [
        { ruleId: 'rule-a', reason: 'role', role: 'user', count: 1 },
        { ruleId: 'rule-b', reason: 'role', role: 'user', count: 1 },
      ],
    );
  });

  it('aggregates role skips per rule per role, with a count', () => {
    // Two out-of-scope messages, each with several blocks. The report says
    // "this rule could not judge two user messages" once — not once per message
    // and certainly not once per block. On the real 2 332-message history the
    // per-message form produced 2 498 entries.
    const healer = createHealer([dropTags('drop-text', ['text'])]);
    const input = [
      msg('user', [
        { type: 'text', text: 'a' },
        { type: 'text', text: 'b' },
      ]),
      msg('user', [{ type: 'text', text: 'c' }]),
    ];
    const report = healer.heal(input);
    const roleSkips = report.skipped.filter((entry) => entry.reason === 'role');
    assert.deepEqual(roleSkips, [{ ruleId: 'drop-text', reason: 'role', role: 'user', count: 2 }]);
  });

  it('reports a role skip for the message phase too', () => {
    const healer = createHealer([dropToolCall('orphan', 'c1')]);
    const report = healer.heal([msg('user', [{ type: 'text', text: 'a' }])]);
    assert.deepEqual(report.skipped, [
      { ruleId: 'orphan', reason: 'role', role: 'user', count: 1 },
    ]);
  });

  it('check() reports the same findings as heal() applies', () => {
    const healer = createHealer([
      dropTags('drop-tool', ['tool-call']),
      dropToolCall('orphan', 'c1'),
    ]);
    const input = [
      msg('assistant', [{ type: 'tool-call', id: 'c1', name: '', arguments: '' }]),
      msg('tool', [{ type: 'text', text: 'err' }], { toolCallId: 'c1' }),
    ];
    const found = healer.check(input);
    const report = healer.heal(input);
    assert.deepEqual(
      found.map((finding: Finding) => [finding.ruleId, finding.messageIndex, finding.blockIndex]),
      report.applied.map((fix) => [fix.ruleId, fix.messageIndex, fix.blockIndex]),
    );
  });

  it('check() never calls repair', () => {
    let repaired = 0;
    const spy: Rule = {
      id: 'spy',
      kind: 'content',
      enabledByDefault: true,
      description: 'detects but must not be repaired in check mode',
      detect: () => ({ ruleId: 'spy', reason: 'seen', messageIndex: -1 }),
      repair: () => {
        repaired += 1;
        return { action: 'drop' };
      },
    };
    const healer = createHealer([spy]);
    const found = healer.check([msg('assistant', [{ type: 'text', text: 'a' }])]);
    assert.equal(found.length, 1);
    assert.equal(repaired, 0, 'check() must not repair');
  });

  it('check() does not build a new message list', () => {
    const input = [msg('assistant', [{ type: 'tool-call', id: 'c1', name: '', arguments: '' }])];
    const healer = createHealer([dropTags('drop-tool', ['tool-call'])]);
    const before = JSON.stringify(input);
    healer.check(input);
    assert.equal(JSON.stringify(input), before);
  });

  it('reports configured rule ids that no rule provides', () => {
    const rules = [dropAll];
    assert.deepEqual(unknownRuleIds(rules, { rules: { 'drop-all': { enabled: true } } }), []);
    assert.deepEqual(unknownRuleIds(rules, { rules: { 'no-such-rule': { enabled: true } } }), [
      'no-such-rule',
    ]);
  });

  it('exposes the registered rules in order', () => {
    const healer = createHealer([dropAll, dropNothing]);
    assert.deepEqual(
      healer.rules.map((rule) => rule.id),
      ['drop-all', 'drop-nothing'],
    );
  });

  it('reuses the original message object when only a sibling changed', () => {
    const untouched = msg('user', [{ type: 'text', text: 'keep me' }]);
    const input = [
      untouched,
      msg('assistant', [{ type: 'tool-call', id: 'c1', name: '', arguments: '' }]),
    ];
    const healer = createHealer([dropTags('drop-tool', ['tool-call'])]);
    const report = healer.heal(input);
    assert.equal(report.messages[0], untouched, 'an unchanged message must keep its identity');
  });
});

describe('rule contract: never throws on unexpected input', () => {
  // The engine only ever hands a rule a well-formed input, so these guards are
  // belt-and-braces — but a rule that throws would take down the whole request,
  // which is strictly worse than reporting nothing. Pinned against regression.
  const hostile: readonly [string, unknown][] = [
    ['undefined', undefined],
    ['null', null],
    ['a number', 7],
    ['a string', 'nonsense'],
    ['an empty object', {}],
    ['an object with no block', { phase: 'content' }],
    ['an array', []],
  ];

  it('every shipped rule returns undefined rather than throwing', async () => {
    const { DEFAULT_RULES } = await import('../src/rules/index.ts');
    // A complete context per kind — the engine always supplies one, so a rule may
    // read it without a guard.
    const contextFor = (kind: string) =>
      kind === 'content'
        ? ({ phase: 'content', messageIndex: 0, blockIndex: 0 } as never)
        : ({
            phase: 'message',
            index: 0,
            messages: [],
            survivingToolCallIds: new Set<string>(),
          } as never);

    for (const rule of DEFAULT_RULES) {
      for (const [label, value] of hostile) {
        const ctx = contextFor(rule.kind);
        assert.doesNotThrow(
          () => rule.detect(value as never, ctx),
          `${rule.id}.detect(${label}) must not throw`,
        );
        assert.equal(
          rule.detect(value as never, contextFor(rule.kind)),
          undefined,
          `${rule.id}.detect(${label}) must report nothing`,
        );
      }
    }
  });
});

describe('engine: fail safe on a malformed message list', () => {
  // This runs inside the outbound path of every model call. A malformed list
  // must pass through untouched rather than become an exception the plugin
  // caused — a confusing stack trace here would be blamed on the repair rather
  // than on the caller that supplied no array.
  const hostile: readonly [string, unknown][] = [
    ['undefined', undefined],
    ['null', null],
    ['a string', 'not an array'],
    ['a number', 42],
    ['a plain object', { length: 0 }],
  ];

  it('check() returns no findings and does not throw', () => {
    const healer = createHealer([dropAll]);
    for (const [label, value] of hostile) {
      assert.doesNotThrow(() => healer.check(value as never), `check(${label}) threw`);
      assert.deepEqual(healer.check(value as never), [], `check(${label}) must report nothing`);
    }
  });

  it('heal() returns the input unchanged and does not throw', () => {
    const healer = createHealer([dropAll]);
    for (const [label, value] of hostile) {
      let report: { messages: unknown } | undefined;
      assert.doesNotThrow(() => {
        report = healer.heal(value as never);
      }, `heal(${label}) threw`);
      assert.equal(report!.messages, value, `heal(${label}) must return the input reference`);
    }
  });

  it('a rule is never consulted for a malformed list', () => {
    let calls = 0;
    const counting: Rule = {
      ...dropAll,
      id: 'counting',
      detect: () => {
        calls += 1;
        return undefined;
      },
    };
    createHealer([counting]).heal(null as never);
    assert.equal(calls, 0, 'no rule may run when there is no list to judge');
  });
});
