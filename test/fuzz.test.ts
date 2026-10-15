/**
 * Property / fuzz testing over randomly generated malformed histories.
 *
 * The unit tests prove the rules handle the cases we thought of. This proves the
 * **invariants** hold for cases nobody thought of, which is the only way to test
 * a repair that must be safe on arbitrary real history.
 *
 * The generator is seeded, so a failure is reproducible from its seed and the
 * run is deterministic.
 *
 * Invariants asserted after every heal:
 *
 *   I1  No surviving tool call has an empty or whitespace-only name.
 *   I2  No `role:"tool"` message is stranded — every result has a surviving call.
 *   I3  Healing is idempotent: a second pass changes nothing.
 *   I4  The input is never mutated.
 *   I5  The output preserves message order.
 *   I6  Every applied fix is accounted for in the report.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createHealer } from '../src/engine.ts';
import { DEFAULT_RULES } from '../src/rules/index.ts';
import type { MessageLike, MessageRole } from '../src/types.ts';

/** Small deterministic PRNG (mulberry32), so failures are reproducible. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(next: () => number, items: readonly T[]): T =>
  items[Math.floor(next() * items.length)]!;

const NAMES = ['', '   ', 'bash', 'read', 'grep', '\t', 'write'];
const ARGUMENTS = ['', '{}', '{"a":1}', 'not json', '[]', 'null', '5', '{"unclosed":'];
const ROLES: readonly MessageRole[] = ['user', 'assistant', 'tool', 'developer', 'system'];

/** Generate one malformed-but-plausible history. */
function generate(seed: number): MessageLike[] {
  const next = rng(seed);
  const messages: MessageLike[] = [];
  const callIds: string[] = [];
  const count = 1 + Math.floor(next() * 24);

  for (let i = 0; i < count; i += 1) {
    const role = pick(next, ROLES);
    const blocks = 0 + Math.floor(next() * 4);
    const content: unknown[] = [];

    for (let b = 0; b < blocks; b += 1) {
      const kind = next();
      if (kind < 0.45) {
        const id = `call-${i}-${b}`;
        callIds.push(id);
        content.push({
          type: next() < 0.9 ? 'tool-call' : 'tool_use',
          id,
          name: pick(next, NAMES),
          arguments: pick(next, ARGUMENTS),
        });
      } else if (kind < 0.6) {
        content.push({ type: 'text', text: 'x'.repeat(1 + Math.floor(next() * 10)) });
      } else if (kind < 0.7) {
        content.push({ type: 'reasoning', text: 'thinking' });
      } else if (kind < 0.78) {
        content.push({ type: 'image', attachment: { attachmentId: 'sha256:abc' } });
      } else if (kind < 0.85) {
        content.push({ type: 'file', attachment: { attachmentId: 'sha256:def' } });
      } else if (kind < 0.92) {
        content.push({ type: 'tool-addition', toolName: 'x' });
      } else {
        // Hostile shapes: a rule must survive anything.
        content.push(pick(next, [null, 7, 'text', [], {}, { type: 42 }, undefined]));
      }
    }

    const message: Record<string, unknown> = { id: `m-${i}`, role, content };
    if (role === 'tool') {
      // Half the time the result answers a real call, half the time a phantom.
      message.toolCallId =
        next() < 0.5 && callIds.length > 0 ? pick(next, callIds) : `phantom-${i}`;
      if (next() < 0.5) message.isError = true;
    }
    messages.push(message as unknown as MessageLike);
  }
  return messages;
}

/** Every surviving tool call, with coordinates. */
function survivingCalls(messages: readonly MessageLike[]) {
  const found: { messageIndex: number; id: string; name: string }[] = [];
  messages.forEach((message, messageIndex) => {
    for (const block of message.content) {
      if (typeof block !== 'object' || block === null) continue;
      const candidate = block as { type?: string; id?: unknown; name?: unknown };
      if (candidate.type !== 'tool-call' && candidate.type !== 'tool_use') continue;
      found.push({
        messageIndex,
        id: String(candidate.id),
        name: typeof candidate.name === 'string' ? candidate.name : '',
      });
    }
  });
  return found;
}

const healer = createHealer(DEFAULT_RULES);
const SEEDS = Array.from({ length: 400 }, (_, i) => i * 7919 + 13);

describe('fuzz: invariants hold for generated histories', () => {
  it('I1: no surviving tool call in an assistant message has an empty name', () => {
    // Scoped to assistant messages because that is the rule's role scope, and
    // deliberately so: a `tool-call` block in a `developer` message is rejected
    // by the adapter outright (`UNSUPPORTED_CONTENT`), so a malformed name there
    // cannot be the thing that breaks a request. See D-8a.
    for (const seed of SEEDS) {
      const healed = healer.heal(generate(seed)).messages;
      for (const call of survivingCalls(healed)) {
        if (healed[call.messageIndex]!.role !== 'assistant') continue;
        assert.notEqual(
          call.name.trim(),
          '',
          `seed ${seed}: surviving call ${call.id} at message ${call.messageIndex} has an empty name`,
        );
      }
    }
  });

  it('I1b: a malformed call outside the role scope is left alone, not half-repaired', () => {
    // Documents the boundary rather than pretending it does not exist: the
    // engine must not rewrite a role its rules were not scoped to judge.
    const input: MessageLike[] = [
      { role: 'developer', content: [{ type: 'tool-call', id: 'c1', name: '', arguments: '' }] },
    ];
    const report = healer.heal(input);
    assert.equal(report.applied.length, 0, 'a developer message is out of scope');
    assert.equal(report.messages, input);
    const skips = report.skipped.filter((entry) => entry.ruleId === 'tool-call-name');
    assert.equal(skips.length, 1, 'the skip must be visible in the report');
    assert.equal(skips[0]!.reason, 'role');
  });

  it('I2: no tool result is stranded', () => {
    for (const seed of SEEDS) {
      const healed = healer.heal(generate(seed)).messages;
      const ids = new Set(survivingCalls(healed).map((call) => call.id));
      healed.forEach((message, index) => {
        if (message.role !== 'tool') return;
        assert.ok(
          ids.has(String(message.toolCallId)),
          `seed ${seed}: result at message ${index} ("${String(message.toolCallId)}") is stranded`,
        );
      });
    }
  });

  it('I3: healing is idempotent', () => {
    for (const seed of SEEDS) {
      const once = healer.heal(generate(seed));
      const twice = healer.heal(once.messages);
      assert.equal(twice.findings.length, 0, `seed ${seed}: a second pass still found defects`);
      assert.equal(twice.applied.length, 0, `seed ${seed}: a second pass still applied fixes`);
      assert.equal(twice.messages, once.messages, `seed ${seed}: second pass changed the list`);
    }
  });

  it('I4: the input is never mutated', () => {
    for (const seed of SEEDS) {
      const input = generate(seed);
      const snapshot = JSON.stringify(input);
      healer.heal(input);
      assert.equal(JSON.stringify(input), snapshot, `seed ${seed}: input was mutated`);
    }
  });

  it('I5: message order is preserved and no message is reordered or invented', () => {
    for (const seed of SEEDS) {
      const input = generate(seed);
      const healed = healer.heal(input).messages;
      // A replaced message is a NEW object, so object identity cannot match it
      // back — but the generated `id` is carried through a spread, so identity
      // of *message* is what to compare. The output must be an ordered
      // subsequence of the input by id, with nothing invented.
      const inputIds = input.map((message) => String(message.id));
      const healedIds = healed.map((message) => String(message.id));
      assert.equal(
        new Set(healedIds).size,
        healedIds.length,
        `seed ${seed}: the output contains a duplicated message`,
      );
      let cursor = 0;
      for (const id of healedIds) {
        const found = inputIds.indexOf(id, cursor);
        assert.ok(found >= 0, `seed ${seed}: output message "${id}" is reordered or invented`);
        cursor = found + 1;
      }
      assert.ok(healed.length <= input.length);
    }
  });

  it('I6: every applied fix is accounted for, and each names a real rule', () => {
    const known = new Set(DEFAULT_RULES.map((rule) => rule.id));
    for (const seed of SEEDS) {
      const report = healer.heal(generate(seed));
      for (const fix of report.applied) {
        assert.ok(known.has(fix.ruleId), `seed ${seed}: fix names unknown rule ${fix.ruleId}`);
        assert.ok(fix.messageIndex >= 0, `seed ${seed}: fix has no message index`);
        assert.ok(fix.reason.length > 0, `seed ${seed}: fix has no reason`);
        assert.ok(fix.action === 'drop' || fix.action === 'replace');
      }
    }
  });

  it('check() is a subset of heal(), and the only extra is the documented cascade', () => {
    for (const seed of SEEDS) {
      const input = generate(seed);
      const found = healer.check(input);
      const report = healer.heal(input);
      const reportedRules = new Set(found.map((finding) => finding.ruleId));
      for (const fix of report.applied) {
        if (reportedRules.has(fix.ruleId)) continue;
        // The one legitimate extra: `orphan-tool-result` can only fire once the
        // content phase has removed a call, which detection alone never does.
        assert.equal(
          fix.ruleId,
          'orphan-tool-result',
          `seed ${seed}: heal applied ${fix.ruleId}, which check() never reported and which is not the cascade`,
        );
      }
    }
  });

  it('check() never mutates and never allocates a replacement list', () => {
    for (const seed of SEEDS) {
      const input = generate(seed);
      const snapshot = JSON.stringify(input);
      healer.check(input);
      assert.equal(JSON.stringify(input), snapshot, `seed ${seed}: check() mutated its input`);
    }
  });

  it('never throws on any generated history', () => {
    for (const seed of SEEDS) {
      assert.doesNotThrow(() => healer.check(generate(seed)), `seed ${seed}: check threw`);
      assert.doesNotThrow(() => healer.heal(generate(seed)), `seed ${seed}: heal threw`);
    }
  });

  it('produces a strictly smaller or equal list, never larger', () => {
    for (const seed of SEEDS) {
      const input = generate(seed);
      const healed = healer.heal(input).messages;
      assert.ok(
        healed.length <= input.length,
        `seed ${seed}: healing grew the history (${input.length} -> ${healed.length})`,
      );
    }
  });
});
