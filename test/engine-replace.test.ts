/**
 * The engine's **replace** path.
 *
 * Every shipped rule that is enabled by default only ever *drops*, and the one
 * rule that replaces (`tool-call-arguments`) ships disabled. So the replace path
 * is unreachable in the default configuration, which is exactly why it needs its
 * own tests: a defect there would sit dormant until someone enabled the rule.
 *
 * These use fake rules, so they prove engine behaviour independently of the
 * shipped set.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createHealer } from '../src/engine.ts';
import type { MessageLike, RepairDecision, Rule } from '../src/types.ts';

const assistant = (content: unknown[]): MessageLike => ({ role: 'assistant', content });

/** A content rule that replaces any block tagged `old` with one tagged `new`. */
function replaceTag(id: string, from: string, to: string): Rule {
  return {
    id,
    kind: 'content',
    enabledByDefault: true,
    description: `replace ${from} with ${to}`,
    roles: ['assistant'],
    detect: (target) => {
      const block = target as { type?: string };
      if (block?.type !== from) return undefined;
      return { ruleId: id, reason: `normalise ${from}`, messageIndex: -1 };
    },
    repair: () => ({ action: 'replace', value: { type: to, normalised: true } }),
  };
}

/** A content rule that drops any block tagged `drop`. */
const dropTag: Rule = {
  id: 'drop-tag',
  kind: 'content',
  enabledByDefault: true,
  description: 'drop tagged blocks',
  roles: ['assistant'],
  detect: (target) => {
    const block = target as { type?: string };
    if (block?.type !== 'drop') return undefined;
    return { ruleId: 'drop-tag', reason: 'drop me', messageIndex: -1 };
  },
  repair: () => ({ action: 'drop' }),
};

/** A rule that drops everything it is shown, to prove drop beats replace. */
const dropEverything: Rule = {
  id: 'drop-everything',
  kind: 'content',
  enabledByDefault: true,
  description: 'drops every block',
  roles: ['assistant'],
  detect: () => ({ ruleId: 'drop-everything', reason: 'all', messageIndex: -1 }),
  repair: () => ({ action: 'drop' }),
};

/** A rule that always keeps, to prove a keep cannot veto another rule's fix. */
const keepEverything: Rule = {
  id: 'keep-everything',
  kind: 'content',
  enabledByDefault: true,
  description: 'reports but keeps',
  roles: ['assistant'],
  detect: () => ({ ruleId: 'keep-everything', reason: 'noted', messageIndex: -1 }),
  repair: (): RepairDecision => ({ action: 'keep' }),
};

describe('engine: replace path', () => {
  it('rewrites the block and accounts for the fix', () => {
    const healer = createHealer([replaceTag('normalise', 'old', 'new')]);
    const input = [assistant([{ type: 'old' }])];
    const report = healer.heal(input);

    assert.notEqual(report.messages, input, 'a replace must produce a new list');
    assert.deepEqual(report.messages[0]!.content, [{ type: 'new', normalised: true }]);
    assert.deepEqual(report.applied, [
      {
        ruleId: 'normalise',
        reason: 'normalise old',
        messageIndex: 0,
        blockIndex: 0,
        action: 'replace',
      },
    ]);
  });

  it('preserves neighbouring blocks in order', () => {
    const healer = createHealer([replaceTag('normalise', 'old', 'new')]);
    const input = [
      assistant([
        { type: 'text', text: 'before' },
        { type: 'old' },
        { type: 'text', text: 'after' },
      ]),
    ];
    const report = healer.heal(input);
    assert.deepEqual(report.messages[0]!.content, [
      { type: 'text', text: 'before' },
      { type: 'new', normalised: true },
      { type: 'text', text: 'after' },
    ]);
  });

  it('replaces several blocks across several messages', () => {
    const healer = createHealer([replaceTag('normalise', 'old', 'new')]);
    const input: MessageLike[] = [
      assistant([{ type: 'old' }, { type: 'old' }]),
      { role: 'user', content: [{ type: 'old' }] },
      assistant([{ type: 'old' }]),
    ];
    const report = healer.heal(input);
    assert.equal(report.applied.length, 3, 'the user message is out of scope');
    assert.equal(report.applied[0]!.blockIndex, 0);
    assert.equal(report.applied[1]!.blockIndex, 1);
    assert.deepEqual(report.messages[0]!.content, [
      { type: 'new', normalised: true },
      { type: 'new', normalised: true },
    ]);
    assert.equal(
      report.messages[1],
      input[1],
      'a message the rule cannot touch keeps its identity',
    );
  });

  it('leaves the message object identical when nothing in it changed', () => {
    const healer = createHealer([replaceTag('normalise', 'old', 'new')]);
    const untouched = assistant([{ type: 'text', text: 'fine' }]);
    const input = [untouched, assistant([{ type: 'old' }])];
    const report = healer.heal(input);
    assert.equal(report.messages[0], untouched);
    assert.notEqual(report.messages[1], input[1]);
  });

  it('is idempotent: a second pass does not replace again', () => {
    const healer = createHealer([replaceTag('normalise', 'old', 'new')]);
    const once = healer.heal([assistant([{ type: 'old' }])]);
    const twice = healer.heal(once.messages);
    assert.deepEqual(twice.findings, []);
    assert.deepEqual(twice.applied, []);
    assert.equal(twice.messages, once.messages);
  });

  it('never mutates the original block object', () => {
    const block = { type: 'old', keep: 'me' };
    const input = [assistant([block])];
    const snapshot = JSON.stringify(input);
    createHealer([replaceTag('normalise', 'old', 'new')]).heal(input);
    assert.equal(JSON.stringify(input), snapshot);
    assert.deepEqual(block, { type: 'old', keep: 'me' });
  });

  it('reports a replace to the message phase as a surviving block', () => {
    // A replace must not be mistaken for a removal: the call id is preserved in
    // the replacement, so a result answering it must NOT be orphaned.
    const replacing: Rule = {
      id: 'touch-call',
      kind: 'content',
      enabledByDefault: true,
      description: 'rewrites a tool call, keeping its id',
      roles: ['assistant'],
      detect: (target) => {
        const block = target as { type?: string };
        if (block?.type !== 'tool-call') return undefined;
        return { ruleId: 'touch-call', reason: 'touched', messageIndex: -1 };
      },
      repair: () => ({
        action: 'replace',
        value: { type: 'tool-call', id: 'c1', name: 'fixed', arguments: '{}' },
      }),
    };
    const orphan: Rule = {
      id: 'orphan',
      kind: 'message',
      enabledByDefault: true,
      description: 'drops orphaned results',
      roles: ['tool'],
      detect: (message, ctx) => {
        const view = message as { toolCallId?: string };
        const context = ctx as unknown as {
          index: number;
          survivingToolCallIds: ReadonlySet<string>;
        };
        if (view.toolCallId === undefined) return undefined;
        if (context.survivingToolCallIds.has(view.toolCallId)) return undefined;
        return { ruleId: 'orphan', reason: 'orphan', messageIndex: context.index };
      },
      repair: () => ({ action: 'drop' }),
    };
    const input: MessageLike[] = [
      assistant([{ type: 'tool-call', id: 'c1', name: '', arguments: '' }]),
      { role: 'tool', content: [{ type: 'text', text: 'ok' }], toolCallId: 'c1' },
    ];
    const report = createHealer([replacing, orphan]).heal(input);
    assert.equal(report.messages.length, 2, 'the result must survive a replace of its call');
    assert.equal(report.applied.filter((fix) => fix.action === 'drop').length, 0);
  });
});

describe('engine: multi-rule precedence on one block', () => {
  it('lets a drop win over a replace', () => {
    const healer = createHealer([replaceTag('normalise', 'old', 'new'), dropEverything]);
    const report = healer.heal([assistant([{ type: 'old' }])]);
    assert.deepEqual(report.messages[0]!.content, [], 'the block must be gone, not replaced');
    assert.equal(report.applied.filter((fix) => fix.action === 'replace').length, 0);
    assert.ok(report.applied.some((fix) => fix.action === 'drop'));
  });

  it('lets a drop win even when the dropping rule runs second', () => {
    const healer = createHealer([dropEverything, replaceTag('normalise', 'old', 'new')]);
    const report = healer.heal([assistant([{ type: 'old' }])]);
    assert.deepEqual(report.messages[0]!.content, []);
    assert.equal(report.applied.filter((fix) => fix.action === 'replace').length, 0);
  });

  it('lets a later replace supersede an earlier one', () => {
    const healer = createHealer([
      replaceTag('first', 'old', 'middle'),
      replaceTag('second', 'old', 'final'),
    ]);
    const report = healer.heal([assistant([{ type: 'old' }])]);
    assert.deepEqual(report.messages[0]!.content, [{ type: 'final', normalised: true }]);
    // Only the winning replacement is accounted for, so the report is not
    // claiming two changes when one block changed once.
    assert.equal(report.applied.length, 1);
    assert.equal(report.applied[0]!.ruleId, 'second');
  });

  it('does not let a keep veto another rule', () => {
    const healer = createHealer([keepEverything, dropTag]);
    const report = healer.heal([assistant([{ type: 'drop' }])]);
    assert.deepEqual(report.messages[0]!.content, [], 'the drop must still apply');
    assert.equal(report.findings.length, 2, 'both rules report');
  });

  it('stops consulting rules once one has dropped the block', () => {
    let secondCalled = 0;
    const second: Rule = {
      ...keepEverything,
      id: 'second',
      detect: () => {
        secondCalled += 1;
        return undefined;
      },
    };
    createHealer([dropEverything, second]).heal([assistant([{ type: 'x' }])]);
    assert.equal(secondCalled, 0, 'a dropped block must not be shown to later rules');
  });
});

describe('engine: degenerate inputs', () => {
  it('handles an empty history', () => {
    const healer = createHealer([replaceTag('normalise', 'old', 'new'), dropEverything]);
    const report = healer.heal([]);
    assert.equal(report.messages.length, 0);
    assert.equal(report.messages.length === 0 && report.applied.length === 0, true);
    assert.deepEqual(healer.check([]), []);
  });

  it('handles a message with no content blocks', () => {
    const healer = createHealer([replaceTag('normalise', 'old', 'new')]);
    const input = [assistant([])];
    const report = healer.heal(input);
    assert.equal(report.messages, input, 'nothing changed, so identity holds');
  });

  it('handles a content array of nulls and primitives', () => {
    const healer = createHealer([replaceTag('normalise', 'old', 'new'), dropEverything]);
    const input = [assistant([null, 7, 'text', undefined])];
    assert.doesNotThrow(() => healer.heal(input));
  });
});

describe('engine: replace with an undefined value', () => {
  /** A rule whose replacement value happens to be `undefined`. */
  const replaceWithUndefined: Rule = {
    id: 'replace-undefined',
    kind: 'content',
    enabledByDefault: true,
    description: 'replaces a block with undefined',
    roles: ['assistant'],
    detect: (target) => {
      const block = target as { type?: string };
      if (block?.type !== 'old') return undefined;
      return { ruleId: 'replace-undefined', reason: 'drop via replace', messageIndex: -1 };
    },
    repair: (): RepairDecision => ({ action: 'replace', value: undefined }),
  };

  it('applies the replacement instead of silently ignoring it', () => {
    // `replacement !== undefined` would be false here, so an earlier version
    // pushed the ORIGINAL block: the finding was reported and nothing changed.
    // `source` is the reliable indicator that a replace was folded in.
    const healer = createHealer([replaceWithUndefined]);
    const report = healer.heal([assistant([{ type: 'old' }, { type: 'text', text: 'keep' }])]);

    assert.equal(report.applied.length, 1, 'the replacement must be accounted for');
    assert.equal(report.applied[0]!.action, 'replace');
    assert.deepEqual(
      report.messages[0]!.content,
      [undefined, { type: 'text', text: 'keep' }],
      'the value must actually replace the block, even when it is undefined',
    );
  });

  it('does not push the original block when the replacement is undefined', () => {
    const healer = createHealer([replaceWithUndefined]);
    const report = healer.heal([assistant([{ type: 'old' }])]);
    assert.notDeepEqual(report.messages[0]!.content, [{ type: 'old' }]);
    assert.deepEqual(report.messages[0]!.content, [undefined]);
  });
});

describe('engine: a message rule that replaces a whole message', () => {
  /** A message rule that rewrites the message rather than dropping it. */
  const rewriteMessage: Rule = {
    id: 'rewrite-message',
    kind: 'message',
    enabledByDefault: true,
    description: 'replaces a whole message',
    roles: ['tool'],
    detect: (message, ctx) => {
      const view = message as { toolCallId?: string };
      const position = (ctx as unknown as { index: number }).index;
      if (view.toolCallId !== 'c1') return undefined;
      return { ruleId: 'rewrite-message', reason: 'rewrite it', messageIndex: position };
    },
    repair: (): RepairDecision => ({
      action: 'replace',
      value: { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'rewritten' }] },
    }),
  };

  const input: MessageLike[] = [
    assistant([{ type: 'tool-call', id: 'c1', name: 'bash', arguments: '{}' }]),
    { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'original' }] },
  ];

  it('replaces the message instead of silently dropping it', () => {
    // An earlier version treated every non-`keep` decision as a drop, so an
    // explicit rewrite became data loss.
    const report = createHealer([rewriteMessage]).heal(input);
    assert.equal(report.messages.length, 2, 'the message must survive');
    assert.deepEqual(report.messages[1]!.content, [{ type: 'text', text: 'rewritten' }]);
    assert.equal(report.applied[0]!.action, 'replace');
  });

  it('keeps a keep decision as a no-op', () => {
    const keeping: Rule = { ...rewriteMessage, repair: () => ({ action: 'keep' }) };
    const report = createHealer([keeping]).heal(input);
    assert.equal(report.messages, input, 'a keep must not change the list');
    assert.deepEqual(report.applied, []);
  });

  it('lets a drop still drop', () => {
    const dropping: Rule = { ...rewriteMessage, repair: () => ({ action: 'drop' }) };
    const report = createHealer([dropping]).heal(input);
    assert.equal(report.messages.length, 1);
    assert.equal(report.applied[0]!.action, 'drop');
  });

  it('is idempotent when the replacement removes its own trigger', () => {
    // Idempotence is the rule author's obligation: a replacement must not
    // re-trigger its own detection, or every later pass rewrites again. This
    // pins the engine's half — a second pass over a no-longer-matching message
    // changes nothing and returns the identical list.
    const detectsOriginal: Rule = {
      ...rewriteMessage,
      detect: (message, ctx) => {
        const view = message as { content: readonly { type?: string; text?: string }[] };
        const position = (ctx as unknown as { index: number }).index;
        const first = view.content[0];
        if (first?.type !== 'text' || first.text !== 'original') return undefined;
        return { ruleId: 'rewrite-message', reason: 'rewrite it', messageIndex: position };
      },
    };
    const once = createHealer([detectsOriginal]).heal(input);
    assert.equal(once.applied.length, 1);
    const twice = createHealer([detectsOriginal]).heal(once.messages);
    assert.deepEqual(twice.applied, [], 'the replacement must not re-trigger');
    assert.equal(twice.messages, once.messages, 'a second pass must return the identical list');
  });

  it('does not loop within one pass when a replacement re-triggers', () => {
    // The engine consults each rule once per message per pass, so a
    // self-triggering replacement cannot spin. It will rewrite again on the
    // *next* pass, which is the rule author's bug, not an engine hang.
    const report = createHealer([rewriteMessage]).heal(input);
    assert.equal(report.applied.length, 1, 'exactly one application per pass');
  });
});
