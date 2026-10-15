/**
 * Scale and concurrency.
 *
 * The real incident history was over a thousand messages. Two properties matter
 * at that size and neither is exercised by the functional tests:
 *
 *   1. **The clean path allocates nothing and stays linear.** The repair runs on
 *      every outbound request, so a per-request cost that grows faster than the
 *      history would be a permanent tax on every model call.
 *   2. **The engine is stateless per call.** Two requests in flight must not
 *      share anything. `createHealer` closes over its rule list only, but that is
 *      a claim until it is tested.
 *
 * The timing assertions are deliberately loose. This is not a benchmark; it is a
 * guard against an accidental quadratic, which shows up as orders of magnitude,
 * not percent.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createHealer } from '../src/engine.ts';
import { DEFAULT_RULES } from '../src/rules/index.ts';
import type { MessageLike } from '../src/types.ts';

const healer = createHealer(DEFAULT_RULES);

/**
 * A history of **exactly** `count` messages shaped like a real conversation:
 * a user turn, an assistant turn carrying a tool call, and its result.
 *
 * `poisonAt` names the message index of the assistant turn whose tool call gets
 * an empty name, so a fix can be asserted at a precise position.
 */
function history(count: number, poisonAt = -1): MessageLike[] {
  const messages: MessageLike[] = [];
  let i = 0;
  while (messages.length < count) {
    messages.push({ id: `m-${i}`, role: 'user', content: [{ type: 'text', text: `ask ${i}` }] });
    if (messages.length >= count) break;

    const callId = `call-${i}`;
    const assistantIndex = messages.length;
    messages.push({
      id: `m-${i}-a`,
      role: 'assistant',
      content: [
        { type: 'text', text: `answer ${i}` },
        {
          type: 'tool-call',
          id: callId,
          name: assistantIndex === poisonAt ? '' : 'bash',
          arguments: '{"command":"ls"}',
        },
      ],
    });
    if (messages.length >= count) break;

    messages.push({
      id: `m-${i}-r`,
      role: 'tool',
      toolCallId: callId,
      content: [{ type: 'text', text: 'ok' }],
    });
    i += 1;
  }
  return messages;
}

/** Median of a sample list. */
function median(samples: number[]): number {
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)]!;
}

/**
 * Median wall time of each of two workloads, measured **alternately**.
 *
 * Timing them in separate blocks lets one GC pause or one noisy neighbour land
 * entirely on one side and fabricate a super-linear ratio. Alternating means
 * both workloads meet the same machine conditions, which is the only way a
 * wall-clock comparison means anything on a shared runner. This test failed
 * exactly that way: green alone, red under the full parallel suite.
 */
function medianPair(a: () => void, b: () => void, runs = 9): [number, number] {
  const left: number[] = [];
  const right: number[] = [];
  for (let i = 0; i < runs; i += 1) {
    let start = process.hrtime.bigint();
    a();
    left.push(Number(process.hrtime.bigint() - start) / 1e6);
    start = process.hrtime.bigint();
    b();
    right.push(Number(process.hrtime.bigint() - start) / 1e6);
  }
  return [median(left), median(right)];
}

describe('scale', () => {
  it('the clean path allocates nothing: the input reference is returned', () => {
    const input = history(1200);
    const report = healer.heal(input);
    assert.equal(report.messages, input, 'a clean 1200-message history must not be copied');
    assert.equal(report.applied.length, 0);
  });

  it('check() on a clean history reports nothing', () => {
    assert.deepEqual(healer.check(history(1200)), []);
  });

  it('stays linear: 10x the messages costs far less than 100x the time', () => {
    const small = history(200);
    const large = history(2000);
    // Warm both paths so JIT state does not decide the result.
    for (let i = 0; i < 5; i += 1) {
      healer.heal(small);
      healer.heal(large);
    }
    const [smallMs, largeMs] = medianPair(
      () => healer.heal(small),
      () => healer.heal(large),
    );
    // Linear would be 10x. Quadratic would be 100x. Allow generous slack for
    // timer noise while still catching a quadratic. The floor keeps a
    // sub-microsecond median from turning ordinary timer jitter into a huge
    // ratio; 200 messages never heal faster than this in practice.
    const ratio = largeMs / Math.max(smallMs, 0.05);
    assert.ok(
      ratio < 40,
      `scaling looked super-linear: 10x the messages took ${ratio.toFixed(1)}x the time ` +
        `(${smallMs.toFixed(3)}ms -> ${largeMs.toFixed(3)}ms)`,
    );
  });

  it('heals a poisoned history at a recorded position in a 1200-message log', () => {
    // The incident's block sat at message index 975 of 1129. In this generator
    // assistant turns occupy indices 3k+1, so 976 is the nearest one.
    const input = history(1200, 976);
    const report = healer.heal(input);
    assert.equal(report.applied.length, 2, 'the call and its stranded result');
    assert.equal(report.messages.length, 1199);
    assert.equal(
      report.applied[0]!.messageIndex,
      976,
      'the fix must land at the recorded position',
    );
  });

  it('handles a history with many independent defects', () => {
    const input = history(600);
    // Poison every assistant tool call, and strand every result.
    for (const message of input) {
      if (message.role !== 'assistant') continue;
      for (const block of message.content) {
        if (
          typeof block === 'object' &&
          block !== null &&
          (block as { type?: string }).type === 'tool-call'
        ) {
          (block as { name: string }).name = '';
        }
      }
    }
    const report = healer.heal(input);
    assert.ok(report.applied.length > 0);
    const healed = report.messages;
    for (const message of healed) {
      for (const block of message.content) {
        if (typeof block !== 'object' || block === null) continue;
        if ((block as { type?: string }).type !== 'tool-call') continue;
        assert.notEqual((block as { name: string }).name.trim(), '');
      }
    }
  });
});

describe('concurrency', () => {
  it('heals two requests in flight without sharing state', async () => {
    const a = history(300, 52);
    const b = history(300, 100);
    const clean = history(300);
    // 52 and 100 are assistant indices in this generator (3k+1).

    const [ra, rb, rc] = await Promise.all([
      Promise.resolve().then(() => healer.heal(a)),
      Promise.resolve().then(() => healer.heal(b)),
      Promise.resolve().then(() => healer.heal(clean)),
    ]);

    assert.equal(ra.applied.length, 2);
    assert.equal(rb.applied.length, 2);
    assert.equal(rc.applied.length, 0);
    assert.equal(rc.messages, clean, 'the clean request must still return its own reference');
    assert.equal(ra.applied[0]!.messageIndex, 52);
    assert.equal(rb.applied[0]!.messageIndex, 100);
  });

  it('interleaved heals do not contaminate each other', () => {
    const a = history(100, 52);
    const b = history(100, 100);
    const first = healer.heal(a);
    const second = healer.heal(b);
    // Re-running the first must produce the identical result after the second
    // ran, which it would not if any state were shared.
    const again = healer.heal(a);
    assert.deepEqual(again.applied, first.applied);
    assert.equal(again.messages.length, first.messages.length);
    assert.notDeepEqual(second.applied, first.applied);
  });

  it('two healers over the same rules are independent', () => {
    const one = createHealer(DEFAULT_RULES);
    const two = createHealer(DEFAULT_RULES, { rules: { 'tool-call-name': { enabled: false } } });
    const input = history(100, 52);
    assert.equal(one.heal(input).applied.length, 2);
    assert.equal(two.heal(input).applied.length, 0, 'the second healer has its own config');
  });
});

describe('zero copy', () => {
  /**
   * Allocation of ONE call, measured immediately after a full collection.
   *
   * The obvious alternative — total growth over many runs — measures *retained*
   * growth, not allocation: short-lived garbage is collected mid-run, so a
   * per-message wrapper disappears from the figure entirely. The first version of
   * this test made exactly that mistake and passed against a simulated
   * regression. One call after a forced GC is what actually sees the garbage.
   */
  function bytesPerCall(fn: () => void, runs = 150): number {
    for (let i = 0; i < 500; i += 1) fn();
    const samples: number[] = [];
    for (let i = 0; i < runs; i += 1) {
      global.gc?.();
      const before = process.memoryUsage().heapUsed;
      fn();
      samples.push(process.memoryUsage().heapUsed - before);
    }
    samples.sort((a, b) => a - b);
    return samples[runs >> 1]!;
  }

  /** A history with no tool calls at all, so the id index stays empty. */
  function plainHistory(count: number): MessageLike[] {
    const messages: MessageLike[] = [];
    for (let i = 0; i < count; i += 1) {
      messages.push({
        id: `p-${i}`,
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: [{ type: 'text', text: `line ${i}` }],
      });
    }
    return messages;
  }

  it('a clean pass with no tool calls allocates almost nothing', () => {
    // This is the discriminating case. With no tool-call ids the engine has
    // nothing to index, so the honest cost is the pass's own bookkeeping — a few
    // hundred bytes. A per-message wrapper would cost ~40 bytes each, i.e. ~80 KB
    // here. The threshold sits between them with room either way.
    const input = plainHistory(2_000);
    const report = healer.heal(input);
    assert.equal(report.messages, input, 'precondition: the clean path is a no-op');

    const bytes = bytesPerCall(() => {
      healer.heal(input);
    });
    assert.ok(
      bytes < 8_000,
      `a clean pass over ${input.length} tool-call-free messages allocated ` +
        `${Math.round(bytes)} bytes; that is a per-message allocation, not zero copy`,
    );
  });

  it('check() allocates almost nothing on the same history', () => {
    const input = plainHistory(2_000);
    assert.deepEqual(healer.check(input), []);
    const bytes = bytesPerCall(() => {
      healer.check(input);
    });
    assert.ok(bytes < 8_000, `check allocated ${Math.round(bytes)} bytes`);
  });

  it('the only per-message allocation left is the surviving-id index', () => {
    // With tool calls present the engine must build the id set the orphan rule
    // needs. That is a derived index, not a copy, and it is the whole remaining
    // cost — so it is measured and named rather than left to be rediscovered.
    const withCalls = history(2_000);
    const without = plainHistory(2_000);
    const delta =
      bytesPerCall(() => {
        healer.heal(withCalls);
      }) -
      bytesPerCall(() => {
        healer.heal(without);
      });
    // ~660 tool-call ids in this generator. A set of that many strings is tens of
    // kilobytes; assert it is in that range and not something larger.
    assert.ok(
      delta < 120_000,
      `the id index cost ${Math.round(delta)} bytes for ~660 ids, which is more than a set of strings`,
    );
  });

  it('the input list and every message keep their identity', () => {
    const input = history(2_000);
    const report = healer.heal(input);
    assert.equal(report.messages, input, 'the list must be the input reference');
    for (let i = 0; i < input.length; i += 1) {
      assert.equal(report.messages[i], input[i], `message ${i} must keep its identity`);
    }
  });

  it('a poisoned history copies only what it changes', () => {
    const input = history(2_000, 1000);
    const report = healer.heal(input);
    assert.equal(report.applied.length, 2, 'the call and its stranded result');

    // A drop shifts positions, so compare by identity rather than by index.
    const original = new Set(input);
    let shared = 0;
    let copied = 0;
    for (const output of report.messages) {
      if (original.has(output)) shared += 1;
      else copied += 1;
    }
    assert.ok(copied <= 1, `at most the one changed message may be a new object, got ${copied}`);
    assert.equal(shared, report.messages.length - copied, 'everything else must be shared');
  });
});
