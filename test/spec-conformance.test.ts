/**
 * Spec conformance — every factual claim in `HOW-IT-WORKS.md`, asserted.
 *
 * Documentation drifts. A spec that describes behaviour the code no longer has is
 * worse than no spec, because it is trusted. This file ties each section of the
 * document to an executable claim, so changing the engine in a way that
 * contradicts the spec fails the build rather than quietly invalidating the
 * prose.
 *
 * Some assertions duplicate `engine.test.ts`. That is intentional: those tests
 * exist to catch defects, these exist to catch a *document* becoming wrong, and
 * they are organised by spec section so a failure names the paragraph at fault.
 *
 * When a claim here fails, either the code is wrong or the spec is — decide which
 * and update the other.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { createHealer } from '../src/engine.ts';
import { DEFAULT_RULES } from '../src/rules/index.ts';
import type { MessageLike, RepairDecision, Rule } from '../src/types.ts';

const assistant = (content: unknown[]): MessageLike => ({ role: 'assistant', content });

/** A content rule that reports once per block it sees. */
function contentRule(
  id: string,
  repair: () => RepairDecision,
  roles: readonly string[] = ['assistant'],
): Rule {
  return {
    id,
    kind: 'content',
    enabledByDefault: true,
    description: id,
    roles: roles as never,
    detect: () => ({ ruleId: id, reason: `${id} reason`, messageIndex: -1 }),
    repair,
  };
}

describe('HOW-IT-WORKS §4.2 — content phase', () => {
  const drop = contentRule('drop', () => ({ action: 'drop' }));
  const replace = contentRule('replace', () => ({ action: 'replace', value: { type: 'new' } }));

  it('a drop wins over a replace, in either order', () => {
    for (const rules of [
      [replace, drop],
      [drop, replace],
    ]) {
      const report = createHealer(rules).heal([assistant([{ type: 'old' }])]);
      assert.deepEqual(report.messages[0]!.content, [], 'the block must be dropped');
    }
  });

  it('rules after a drop are not consulted for that block', () => {
    let consulted = 0;
    const after: Rule = {
      ...contentRule('after', () => ({ action: 'keep' })),
      detect: () => {
        consulted += 1;
        return undefined;
      },
    };
    createHealer([drop, after]).heal([assistant([{ type: 'old' }])]);
    assert.equal(consulted, 0, 'a dropped block must not be shown to later rules');
  });

  it('the last replace wins', () => {
    const first = contentRule('first', () => ({ action: 'replace', value: { which: 'first' } }));
    const second = contentRule('second', () => ({ action: 'replace', value: { which: 'second' } }));
    const report = createHealer([first, second]).heal([assistant([{ type: 'old' }])]);
    assert.deepEqual(report.messages[0]!.content, [{ which: 'second' }]);
  });

  it('the engine owns the coordinates a rule reports', () => {
    const lying: Rule = {
      ...contentRule('lying', () => ({ action: 'keep' })),
      detect: () => ({ ruleId: 'lying', reason: 'x', messageIndex: 999, blockIndex: 999 }),
    };
    const findings = createHealer([lying]).check([
      assistant([{ type: 'a' }]),
      assistant([{ type: 'b' }]),
    ]);
    assert.equal(findings[0]!.messageIndex, 0);
    assert.equal(findings[0]!.blockIndex, 0);
    assert.equal(findings[1]!.messageIndex, 1);
  });

  it('a rule that cannot judge the role is recorded as skipped', () => {
    const scoped = contentRule('scoped', () => ({ action: 'keep' }), ['assistant']);
    const report = createHealer([scoped]).heal([{ role: 'user', content: [{ type: 'text' }] }]);
    assert.deepEqual(report.skipped, [
      { ruleId: 'scoped', reason: 'role', role: 'user', count: 1 },
    ]);
  });

  it('a disabled rule is recorded as skipped and never called', () => {
    let consulted = 0;
    const off: Rule = {
      ...contentRule('off', () => ({ action: 'keep' })),
      enabledByDefault: false,
      detect: () => {
        consulted += 1;
        return undefined;
      },
    };
    const report = createHealer([off]).heal([assistant([{ type: 'text' }])]);
    assert.equal(consulted, 0);
    assert.deepEqual(report.skipped, [{ ruleId: 'off', reason: 'disabled' }]);
  });
});

describe('HOW-IT-WORKS §4.3 — message phase', () => {
  const input: MessageLike[] = [
    assistant([{ type: 'tool-call', id: 'c1', name: 'bash', arguments: '{}' }]),
    { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'original' }] },
  ];

  /** A message rule that reports on the tool message with id `c1`. */
  function messageRule(id: string, repair: () => RepairDecision): Rule {
    return {
      id,
      kind: 'message',
      enabledByDefault: true,
      description: id,
      roles: ['tool'],
      detect: (target) => {
        const view = target as { index: number; toolCallId?: string };
        if (view.toolCallId !== 'c1') return undefined;
        return { ruleId: id, reason: `${id} reason`, messageIndex: view.index };
      },
      repair,
    };
  }

  it('a message replace keeps the message, rather than dropping it', () => {
    const rewrite = messageRule('rewrite', () => ({
      action: 'replace',
      value: { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'rewritten' }] },
    }));
    const report = createHealer([rewrite]).heal(input);
    assert.equal(report.messages.length, 2, 'the message must survive');
    assert.deepEqual(report.messages[1]!.content, [{ type: 'text', text: 'rewritten' }]);
    assert.equal(report.applied[0]!.action, 'replace');
  });

  it('a message drop removes the message', () => {
    const report = createHealer([messageRule('drop', () => ({ action: 'drop' }))]).heal(input);
    assert.equal(report.messages.length, 1);
    assert.equal(report.applied[0]!.action, 'drop');
  });

  it('a keep changes nothing and keeps the input reference', () => {
    const report = createHealer([messageRule('keep', () => ({ action: 'keep' }))]).heal(input);
    assert.equal(report.messages, input);
    assert.deepEqual(report.applied, []);
  });

  it('a message rule is given the whole surviving list', () => {
    let sawLength = -1;
    let sawIds = -1;
    const inspector: Rule = {
      ...messageRule('inspector', () => ({ action: 'keep' })),
      detect: (_message, ctx) => {
        // The list and the surviving ids live on the context; the message is the
        // target, so the engine allocates nothing to hand a rule a message.
        const context = ctx as {
          messages: readonly unknown[];
          survivingToolCallIds: ReadonlySet<string>;
        };
        sawLength = context.messages.length;
        sawIds = context.survivingToolCallIds.size;
        return undefined;
      },
    };
    createHealer([inspector]).heal(input);
    assert.equal(sawLength, 2, 'the rule must see the whole list');
    assert.equal(sawIds, 1, 'and the surviving tool-call ids');
  });

  it('surviving tool-call ids come only from assistant messages', () => {
    // A tool call parked in a non-assistant message must not count as surviving,
    // or the orphan rule would keep a result whose call was never sent.
    let sawIds: ReadonlySet<string> = new Set();
    const inspector: Rule = {
      ...messageRule('inspector', () => ({ action: 'keep' })),
      detect: (_message, ctx) => {
        sawIds = (ctx as { survivingToolCallIds: ReadonlySet<string> }).survivingToolCallIds;
        return undefined;
      },
    };
    createHealer([inspector]).heal([
      {
        role: 'user',
        content: [{ type: 'tool-call', id: 'from-user', name: 'x', arguments: '{}' }],
      },
      { role: 'tool', toolCallId: 'c1', content: [] },
    ]);
    assert.equal(sawIds.has('from-user'), false, 'a user-role tool call must not count');
  });
});

describe('HOW-IT-WORKS §4.5 — identity guarantees', () => {
  const healer = createHealer(DEFAULT_RULES);

  it('a clean heal returns the input array reference', () => {
    const clean: MessageLike[] = [assistant([{ type: 'text', text: 'x' }])];
    assert.equal(healer.heal(clean).messages, clean);
  });

  it('an untouched message keeps its object identity', () => {
    const untouched = assistant([{ type: 'text', text: 'keep' }]);
    const input = [untouched, assistant([{ type: 'tool-call', id: 'c', name: '', arguments: '' }])];
    const report = healer.heal(input);
    assert.equal(report.messages[0], untouched);
    assert.notEqual(report.messages[1], input[1], 'a changed message must be a new object');
  });

  it('the input is never mutated, even when it is not frozen', () => {
    const input = [assistant([{ type: 'tool-call', id: 'c', name: '', arguments: '' }])];
    const snapshot = JSON.stringify(input);
    healer.heal(input);
    assert.equal(JSON.stringify(input), snapshot);
  });

  it('a second pass reports nothing and returns the identical list', () => {
    const input: MessageLike[] = [
      assistant([{ type: 'tool-call', id: 'c', name: '', arguments: '' }]),
      { role: 'tool', toolCallId: 'c', content: [] },
    ];
    const once = healer.heal(input);
    const twice = healer.heal(once.messages);
    assert.deepEqual(twice.findings, []);
    assert.deepEqual(twice.applied, []);
    assert.equal(twice.messages, once.messages);
  });

  it('check() never repairs', () => {
    let repaired = 0;
    const spy = contentRule('spy', () => {
      repaired += 1;
      return { action: 'drop' };
    });
    createHealer([spy]).check([assistant([{ type: 'x' }])]);
    assert.equal(repaired, 0);
  });
});

describe('HOW-IT-WORKS §4.6 — check and heal agree', () => {
  const input: MessageLike[] = [
    assistant([{ type: 'tool-call', id: 'c', name: '', arguments: '' }]),
    { role: 'tool', toolCallId: 'c', content: [] },
  ];
  const healer = createHealer(DEFAULT_RULES);

  it('check reports the content finding and cannot see the cascade', () => {
    const found = healer.check(input);
    assert.ok(found.some((finding) => finding.ruleId === 'tool-call-name'));
    assert.equal(
      found.some((finding) => finding.ruleId === 'orphan-tool-result'),
      false,
      'a result is only orphaned once its call is removed, which detection does not do',
    );
  });

  it('heal applies the content fix and the cascade', () => {
    const report = healer.heal(input);
    assert.deepEqual(
      report.applied.map((fix) => fix.ruleId),
      ['tool-call-name', 'orphan-tool-result'],
    );
  });
});

describe('HOW-IT-WORKS §4.0 — fail safe on a malformed list', () => {
  const healer = createHealer(DEFAULT_RULES);
  const hostile = [undefined, null, 'x', 42, {}] as const;

  it('check returns no findings and does not throw', () => {
    for (const value of hostile) {
      assert.deepEqual(healer.check(value as never), []);
    }
  });

  it('heal returns the input reference and does not throw', () => {
    for (const value of hostile) {
      const report = healer.heal(value as never);
      assert.equal(report.messages, value);
      assert.deepEqual(report.applied, []);
    }
  });
});

describe('HOW-IT-WORKS §5 — shipped rule defaults', () => {
  const byId = new Map(DEFAULT_RULES.map((rule) => [rule.id, rule]));

  it('lists exactly the four documented rules, in the documented order', () => {
    assert.deepEqual(
      DEFAULT_RULES.map((rule) => rule.id),
      ['tool-call-name', 'tool-call-arguments', 'orphan-tool-result', 'empty-assistant-message'],
    );
  });

  it('matches the documented kind, roles and default for each rule', () => {
    const documented: [string, string, string[], boolean][] = [
      ['tool-call-name', 'content', ['assistant'], true],
      ['tool-call-arguments', 'content', ['assistant'], false],
      ['orphan-tool-result', 'message', ['tool'], true],
      ['empty-assistant-message', 'message', ['assistant'], false],
    ];
    for (const [id, kind, roles, enabled] of documented) {
      const rule = byId.get(id)!;
      assert.ok(rule, `${id} must ship`);
      assert.equal(rule.kind, kind, `${id} kind`);
      assert.deepEqual([...(rule.roles ?? [])], roles, `${id} roles`);
      assert.equal(rule.enabledByDefault, enabled, `${id} default`);
    }
  });

  it('the default healer enables exactly the two documented rules', () => {
    const report = createHealer(DEFAULT_RULES).heal([assistant([{ type: 'text', text: 'x' }])]);
    const disabled = report.skipped
      .filter((entry) => entry.reason === 'disabled')
      .map((entry) => entry.ruleId);
    assert.deepEqual(disabled, ['tool-call-arguments', 'empty-assistant-message']);
  });
});

describe('documented counts match the gates', () => {
  /**
   * A count in prose is a claim, and three documents carried three different stale
   * numbers when this was added: 26, 39 and 46 mutants for a gate that had 46.
   *
   * Nobody updates a number they only read. So the number is read from the gate
   * itself, and the documents are checked against it.
   */
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

  function mutantCount(): number {
    const output = execFileSync(process.execPath, [join(ROOT, 'scripts', 'mutate.ts'), '--list'], {
      encoding: 'utf8',
    });
    return Number(output.trim());
  }

  it('every documented mutant count matches scripts/mutate.ts', () => {
    const actual = mutantCount();
    assert.ok(Number.isInteger(actual) && actual > 0, `--list returned ${actual}`);

    const offenders: string[] = [];
    for (const doc of ['README.md', 'TESTPLAN.md', 'WORKFLOW.md', 'HOW-IT-WORKS.md']) {
      const text = readFileSync(join(ROOT, doc), 'utf8');
      for (const [index, line] of text.split('\n').entries()) {
        // A line may be quoting a *past* state — §3q records that the gate once
        // had 43 mutants — and such a quote is accurate for its context. The
        // exemption is explicit and greppable rather than inferred, because an
        // inferred exemption is one more thing that silently stops working.
        if (line.includes('count-exempt')) continue;
        for (const match of line.matchAll(
          /(\d+)\s*(?:\/\s*\d+\s*)?(?:mutants?|mutations?)\b|\b(\d+)\s*\/\s*(\d+)\s+caught\b/g,
        )) {
          // Either shape captures the figure to check in group 1 or group 2.
          const claimed = Number(match[1] ?? match[2]);
          if (claimed !== actual) {
            offenders.push(`${doc}:${index + 1}: says ${claimed}, gate has ${actual}`);
          }
        }
      }
    }
    assert.deepEqual(offenders, [], `stale mutant counts:\n${offenders.join('\n')}`);
  });
});
