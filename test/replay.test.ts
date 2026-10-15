/**
 * Fixture contract, and the replay of the real incident history.
 *
 * This is the only test that runs the **shipped** rule set over **real**
 * captured data, and it is where the incident is actually proven fixed. It also
 * asserts that healing leaves the fixtures byte-identical: the repair is an
 * outbound projection, so nothing on disk may move.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, it } from 'vite-plus/test';

import { createHealer } from '../src/engine.ts';
import { DEFAULT_RULES } from '../src/rules/index.ts';
import type { MessageLike } from '../src/types.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, 'fixtures');

function readJson<T>(name: string): T {
  return JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as T;
}

interface FixtureMessage extends MessageLike {
  readonly seq?: number;
  readonly isError?: boolean;
}

const poisoned = readJson<FixtureMessage>('poisoned-assistant.json');
const poisonedSecond = readJson<FixtureMessage>('poisoned-assistant-second.json');
const orphanResult = readJson<FixtureMessage>('orphan-result.json');
const history: readonly MessageLike[] = readJson<readonly FixtureMessage[]>('history-around.json');
const stream = readJson<{ readonly note?: string; readonly stream: readonly unknown[] }>(
  'stream-4810.json',
);

const healer = createHealer(DEFAULT_RULES);

/** Every tool-call block in a message list, with its coordinates. */
function toolCalls(messages: readonly MessageLike[]) {
  const found: { messageIndex: number; id: string; name: string }[] = [];
  messages.forEach((message, messageIndex) => {
    for (const block of message.content) {
      if (typeof block !== 'object' || block === null) continue;
      const candidate = block as { type?: string; id?: string; name?: string };
      if (candidate.type !== 'tool-call') continue;
      found.push({ messageIndex, id: String(candidate.id), name: String(candidate.name) });
    }
  });
  return found;
}

/** Assert the provider-visible invariants that the incident violated. */
function assertProviderValid(messages: readonly MessageLike[], label: string): void {
  for (const call of toolCalls(messages)) {
    assert.notEqual(call.name.trim(), '', `${label}: tool-call ${call.id} has an empty name`);
  }
  const surviving = new Set(toolCalls(messages).map((call) => call.id));
  messages.forEach((message, index) => {
    if (message.role !== 'tool') return;
    assert.ok(
      surviving.has(String(message.toolCallId)),
      `${label}: tool result at ${index} ("${String(message.toolCallId)}") has no surviving call`,
    );
  });
}

describe('fixture contract', () => {
  it('captures the poisoned block exactly as the incident produced it', () => {
    assert.equal(poisoned.seq, 4810);
    assert.equal(poisoned.role, 'assistant');
    const block = poisoned.content[3] as unknown as {
      type: string;
      id: string;
      name: string;
      arguments: string;
    };
    assert.equal(block.type, 'tool-call');
    assert.equal(block.id, 'call-3');
    assert.equal(block.name, '');
    assert.equal(block.arguments, '');
  });

  it('captures the matching tool result, so the call is not an orphan by itself', () => {
    assert.equal(orphanResult.seq, 4812);
    assert.equal(orphanResult.role, 'tool');
    assert.equal(orphanResult.toolCallId, 'call-3');
    assert.equal(orphanResult.isError, true);
  });

  it('captures the second occurrence, where a valid call sits beside the fabricated one', () => {
    assert.equal(poisonedSecond.seq, 7361);
    const calls = toolCalls([poisonedSecond]);
    assert.equal(calls.length, 2, 'the message carries two tool calls');
    const empty = calls.filter((call) => call.name === '');
    const valid = calls.filter((call) => call.name !== '');
    assert.equal(empty.length, 1, 'exactly one fabricated call');
    assert.equal(valid.length, 1, 'exactly one healthy call that must survive');
    // This is why "drop the whole assistant message" is not an acceptable repair.
    assert.equal(valid[0]!.name, 'bash');
  });

  it('captures the stream evidence for the corrected root cause', () => {
    const records = stream.stream;
    assert.ok(Array.isArray(records) && records.length > 0);
    const json = JSON.stringify(records);
    assert.match(json, /"blockType":"tool-call"/);
    // A bare block-start with no delta and no end is what let the assembler
    // fabricate an empty-named call.
    assert.doesNotMatch(json, /tool-call-delta/);
  });

  it('builds a history with a positive control: a valid call that must survive', () => {
    assert.ok(history.length >= 6);
    const calls = toolCalls(history);
    const valid = calls.filter((call) => call.name !== '');
    assert.ok(valid.length >= 1, 'the history must contain a valid call to keep');
    const empty = calls.filter((call) => call.name === '');
    assert.equal(empty.length, 1, 'exactly one poisoned call');
    const resultIds = new Set(
      history
        .filter((message) => message.role === 'tool')
        .map((message) => String(message.toolCallId)),
    );
    for (const call of valid) {
      assert.ok(resultIds.has(call.id), `valid call ${call.id} must have a matching result`);
    }
  });
});

describe('replay of the real incident history', () => {
  it('detects the poisoned call without repairing it', () => {
    const findings = healer.check(history);
    const names = findings.filter((finding) => finding.ruleId === 'tool-call-name');
    assert.equal(names.length, 1, 'exactly one empty-name call is reported');
    assert.equal(names[0]!.messageIndex, 7, 'at the position the incident recorded');
  });

  it('heals to a provider-valid request', () => {
    const report = healer.heal(history);
    assertProviderValid(report.messages, 'healed history');
  });

  it('removes the poisoned call and its stranded result together', () => {
    const report = healer.heal(history);
    assert.ok(
      report.applied.some((fix) => fix.ruleId === 'tool-call-name' && fix.action === 'drop'),
      'the fabricated call must be dropped',
    );
    assert.ok(
      report.applied.some((fix) => fix.ruleId === 'orphan-tool-result' && fix.action === 'drop'),
      'its result must be dropped too, or the request is still malformed',
    );
  });

  it('keeps every valid call and its result', () => {
    const report = healer.heal(history);
    const before = toolCalls(history).filter((call) => call.name !== '');
    const after = toolCalls(report.messages);
    for (const call of before) {
      assert.ok(
        after.some((survivor) => survivor.id === call.id),
        `valid call ${call.id} must survive`,
      );
    }
  });

  it('drops exactly one message: the stranded result', () => {
    const report = healer.heal(history);
    assert.equal(report.messages.length, history.length - 1);
  });

  it('is idempotent over the real history', () => {
    const once = healer.heal(history);
    const twice = healer.heal(once.messages);
    assert.deepEqual(twice.findings, []);
    assert.equal(twice.messages, once.messages);
  });

  it('heals the second occurrence without touching its valid sibling', () => {
    const report = healer.heal([poisonedSecond]);
    const calls = toolCalls(report.messages);
    assert.equal(calls.length, 1, 'the fabricated call is gone');
    assert.equal(calls[0]!.name, 'bash', 'the healthy call is untouched');
  });

  it('leaves the fixtures byte-identical', () => {
    const before = [
      'poisoned-assistant.json',
      'poisoned-assistant-second.json',
      'orphan-result.json',
      'history-around.json',
      'stream-4810.json',
    ].map((name) =>
      createHash('sha256')
        .update(readFileSync(join(FIXTURES, name), 'utf8'))
        .digest('hex'),
    );
    healer.heal(history);
    healer.heal([poisoned]);
    const after = [
      'poisoned-assistant.json',
      'poisoned-assistant-second.json',
      'orphan-result.json',
      'history-around.json',
      'stream-4810.json',
    ].map((name) =>
      createHash('sha256')
        .update(readFileSync(join(FIXTURES, name), 'utf8'))
        .digest('hex'),
    );
    assert.deepEqual(after, before, 'healing must never touch persisted history');
  });

  it('never mutates the input history', () => {
    const snapshot = JSON.stringify(history);
    healer.heal(history);
    assert.equal(JSON.stringify(history), snapshot);
  });

  it('publishes no local absolute path in any fixture', () => {
    for (const name of [
      'poisoned-assistant.json',
      'poisoned-assistant-second.json',
      'orphan-result.json',
      'history-around.json',
      'stream-4810.json',
    ]) {
      const text = readFileSync(join(FIXTURES, name), 'utf8');
      assert.doesNotMatch(text, /\/Users\//, `${name} must not leak a home path`);
      assert.doesNotMatch(text, /\/home\/[a-z]/, `${name} must not leak a home path`);
      assert.doesNotMatch(text, /C:\\Users/, `${name} must not leak a home path`);
    }
  });
});
