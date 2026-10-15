/**
 * The complete causal chain, from raw stream to provider-valid request.
 *
 * Every other test covers one link:
 *
 *   - `upstream-assembler.test.ts` — the assembler fabricates the bad block,
 *   - `replay.test.ts`            — the healer removes a bad block from a fixture,
 *   - `integration.test.ts`       — the seam hands the healed request to an adapter.
 *
 * None of them connects the links. This file does: it feeds the **real**
 * assembler the exact chunk sequence the incident's adapter produced, takes the
 * assistant message the assembler actually builds, feeds that into the healer,
 * and asserts the result is a request a provider will accept.
 *
 * That is the end-to-end claim the whole project rests on, and it was previously
 * only asserted by construction — which is the weakest kind of assertion.
 *
 * Skips when the harness is not installed.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, it } from 'node:test';

import { createHealer } from '../src/engine.ts';
import { DEFAULT_RULES } from '../src/rules/index.ts';
import type { MessageLike } from '../src/types.ts';
import { resolveHarnessEntry } from '../src/resolve-harness.ts';
import type { StoreFs } from '../src/resolve-harness.ts';

/** Locate a file inside an installed package, via the shared resolver. */
function findInStore(packageName: string, inner: string): string | undefined {
  return resolveHarnessEntry(packageName, inner, storeFs, homedir());
}
const storeFs: StoreFs = {
  readdir: (dir) => readdirSync(dir),
  exists: (path) => existsSync(path),
  join: (...parts) => join(...parts),
};

interface AssemblerModule {
  BlockAssembler: new () => {
    push(chunk: unknown): void;
    blocks(): readonly MessageLike['content'][number][];
    message(source: Record<string, unknown>): MessageLike;
  };
}

const assemblerPath = findInStore('@deepseek-ai/dsh-llm', 'lib/types/assembler.js');
const assemblerModule: AssemblerModule | undefined =
  assemblerPath === undefined
    ? undefined
    : ((await import(pathToFileURL(assemblerPath).href)) as unknown as AssemblerModule);

const healer = createHealer(DEFAULT_RULES);

/** The exact chunk sequence the incident's `antigravity` stream produced. */
function feedIncidentStream() {
  const assembler = new assemblerModule!.BlockAssembler();
  assembler.push({ type: 'block-start', index: 0, blockType: 'reasoning' });
  assembler.push({ type: 'reasoning-delta', index: 0, text: 'considering' });
  assembler.push({
    type: 'block-end',
    index: 0,
    block: { type: 'reasoning', text: 'considering' },
  });
  assembler.push({ type: 'block-start', index: 1, blockType: 'text' });
  assembler.push({ type: 'text-delta', index: 1, text: 'let me check' });
  assembler.push({ type: 'block-end', index: 1, block: { type: 'text', text: 'let me check' } });
  // The defect: a tool-call block-start with no delta carrying an id or name.
  assembler.push({ type: 'block-start', index: 3, blockType: 'tool-call' });
  assembler.push({ type: 'finish', reason: { kind: 'tool-calls' } });
  return assembler;
}

/** Every tool-call block in a message list, with coordinates. */
function toolCalls(messages: readonly MessageLike[]) {
  const found: { messageIndex: number; id: string; name: string }[] = [];
  messages.forEach((message, messageIndex) => {
    for (const block of message.content) {
      if (typeof block !== 'object' || block === null) continue;
      const candidate = block as { type?: string; id?: unknown; name?: unknown };
      if (candidate.type !== 'tool-call') continue;
      found.push({
        messageIndex,
        id: String(candidate.id),
        name: typeof candidate.name === 'string' ? candidate.name : '',
      });
    }
  });
  return found;
}

/** The invariants a provider enforces on a request. */
function assertProviderValid(messages: readonly MessageLike[], label: string): void {
  for (const call of toolCalls(messages)) {
    assert.notEqual(call.name.trim(), '', `${label}: tool call ${call.id} has an empty name`);
  }
  const surviving = new Set(toolCalls(messages).map((call) => call.id));
  messages.forEach((message, index) => {
    if (message.role !== 'tool') return;
    assert.ok(
      surviving.has(String(message.toolCallId)),
      `${label}: result at ${index} ("${String(message.toolCallId)}") has no surviving call`,
    );
  });
}

describe(
  'causal chain: raw stream -> assembler -> healer -> valid request',
  { skip: assemblerModule === undefined },
  () => {
    it('step 1: the real assembler fabricates the poisoned block from a bare block-start', () => {
      const blocks = feedIncidentStream().blocks();
      const calls = blocks.filter(
        (block) =>
          typeof block === 'object' &&
          block !== null &&
          (block as { type?: string }).type === 'tool-call',
      ) as { id?: string; name?: string; arguments?: string }[];

      assert.equal(calls.length, 1, 'the assembler emits a tool call from no delta');
      assert.equal(calls[0]!.name, '', 'with an empty name — this is the poison');
      assert.equal(calls[0]!.id, 'call-3', 'and an id synthesised from the index');
      assert.equal(calls[0]!.arguments, '', 'and empty arguments');
    });

    it('step 2: the assembler records it into a real assistant message', () => {
      const message = feedIncidentStream().message({
        provider: 'antigravity',
        model: 'gemini-3.8-flash-high',
      });
      assert.equal(message.role, 'assistant');
      assert.equal(message.content.length, 3, 'reasoning, text, and the fabricated tool call');
      const calls = toolCalls([message]);
      assert.equal(calls.length, 1);
      assert.equal(calls[0]!.name, '', 'the poison is in the message that would be persisted');
    });

    it('step 3: the healer removes it and the request becomes provider-valid', () => {
      // Build the history exactly as a poisoned session would hold it: the
      // assembled assistant message, plus the tool result the harness produced by
      // dispatching the fabricated call.
      const assistant = feedIncidentStream().message({
        provider: 'antigravity',
        model: 'gemini-3.8-flash-high',
      });
      const result: MessageLike = {
        role: 'tool',
        toolCallId: 'call-3',
        content: [{ type: 'text', text: 'Error: unknown tool ""' }],
        isError: true,
      };
      const history: MessageLike[] = [
        { role: 'user', content: [{ type: 'text', text: 'check the repo' }] },
        assistant,
        result,
      ];

      // Before: this is what the incident re-sent on every request.
      assert.equal(toolCalls(history).length, 1);
      assert.equal(toolCalls(history)[0]!.name, '');

      const report = healer.heal(history);

      // After: a request a strict provider accepts.
      assertProviderValid(report.messages, 'healed chain');
      assert.equal(toolCalls(report.messages).length, 0, 'the fabricated call is gone');
      assert.equal(report.messages.length, 2, 'its stranded result went with it');
      assert.deepEqual(
        report.applied.map((fix) => fix.ruleId),
        ['tool-call-name', 'orphan-tool-result'],
        'both rules fired, in phase order',
      );
    });

    it('step 4: the healed request is idempotent and non-mutating', () => {
      const assistant = feedIncidentStream().message({ provider: 'antigravity', model: 'g' });
      const history: MessageLike[] = [
        { role: 'user', content: [{ type: 'text', text: 'go' }] },
        assistant,
        { role: 'tool', toolCallId: 'call-3', content: [{ type: 'text', text: 'err' }] },
      ];
      const snapshot = JSON.stringify(history);
      const once = healer.heal(history);
      const twice = healer.heal(once.messages);
      assert.equal(JSON.stringify(history), snapshot, 'the input must be untouched');
      assert.deepEqual(twice.findings, [], 'a second pass finds nothing');
      assertProviderValid(twice.messages, 'chain, second pass');
    });

    it('step 5: check() sees the poison without repairing it', () => {
      const assistant = feedIncidentStream().message({ provider: 'antigravity', model: 'g' });
      const history: MessageLike[] = [
        { role: 'user', content: [{ type: 'text', text: 'go' }] },
        assistant,
        { role: 'tool', toolCallId: 'call-3', content: [{ type: 'text', text: 'err' }] },
      ];
      const found = healer.check(history);
      assert.equal(found.length, 1, 'exactly one defect is visible in detection mode');
      assert.equal(found[0]!.ruleId, 'tool-call-name');
      // The orphan only becomes visible once the call is removed, which detection
      // does not do — that is the documented cascade.
      assert.equal(
        found.filter((finding) => finding.ruleId === 'orphan-tool-result').length,
        0,
        'the cascade is a repair-time effect, not a detection-time one',
      );
    });

    it('step 6: a well-formed stream passes through untouched', () => {
      const assembler = new assemblerModule!.BlockAssembler();
      assembler.push({ type: 'block-start', index: 0, blockType: 'tool-call' });
      assembler.push({
        type: 'tool-call-delta',
        index: 0,
        id: 'call_ok',
        name: 'bash',
        argumentsDelta: '{"command":"ls"}',
      });
      assembler.push({
        type: 'block-end',
        index: 0,
        block: { type: 'tool-call', id: 'call_ok', name: 'bash', arguments: '{"command":"ls"}' },
      });
      assembler.push({ type: 'finish', reason: { kind: 'tool-calls' } });
      const message = assembler.message({ provider: 'antigravity', model: 'g' });

      const history: MessageLike[] = [
        { role: 'user', content: [{ type: 'text', text: 'go' }] },
        message,
        { role: 'tool', toolCallId: 'call_ok', content: [{ type: 'text', text: 'ok' }] },
      ];
      const report = healer.heal(history);
      assert.equal(report.messages, history, 'a clean chain must return the identical list');
      assert.deepEqual(report.applied, []);
      assertProviderValid(report.messages, 'clean chain');
    });
  },
);

/**
 * Shape conformance: the healed messages must satisfy the **real** DSH contract.
 *
 * `src/types.ts` defines `MessageLike` as a deliberately minimal structural view
 * — that is what keeps the engine dependency-free. The risk is silent drift: the
 * local view could accept a shape the real `Message` union forbids, and a
 * typecheck is exactly what would normally catch that.
 *
 * So the shapes are checked against the harness's own declaration file, read as
 * text. It is a coarse check, but it is a real one, and it covers the fields a
 * provider actually validates.
 *
 * Skips when the harness is not installed.
 */

const dtsPath = findInStore('@deepseek-ai/dsh-llm', 'lib/types/message.d.ts');
const dts = dtsPath === undefined ? undefined : readFileSync(dtsPath, 'utf8');

describe(
  'healed messages conform to the real DSH message contract',
  { skip: dts === undefined },
  () => {
    /** The role union the harness declares. */
    const declaredRoles = (() => {
      // Keys are unquoted identifiers, one per line.
      const map = dts!.match(/interface MessageRoleMap \{([\s\S]*?)\n\}/);
      if (map === null) return [];
      return [...map[1]!.matchAll(/^\s+(\w+):/gm)].map((m) => m[1]!);
    })();

    it('reads the real role vocabulary from the harness', () => {
      assert.ok(
        declaredRoles.length >= 4,
        `expected several roles, got ${JSON.stringify(declaredRoles)}`,
      );
      for (const role of ['user', 'assistant', 'tool']) {
        assert.ok(declaredRoles.includes(role), `the harness must declare the ${role} role`);
      }
    });

    it('every healed message uses a declared role', () => {
      const assistant = feedIncidentStream().message({ provider: 'antigravity', model: 'g' });
      const history: MessageLike[] = [
        { role: 'user', content: [{ type: 'text', text: 'go' }] },
        assistant,
        { role: 'tool', toolCallId: 'call-3', content: [{ type: 'text', text: 'err' }] },
      ];
      for (const message of healer.heal(history).messages) {
        assert.ok(
          declaredRoles.includes(message.role),
          `healed message has role "${message.role}", which the harness does not declare`,
        );
      }
    });

    it('every tool-role message carries a toolCallId, as the harness requires', () => {
      // `ToolResultMessage` declares `toolCallId` as required and non-optional.
      assert.match(
        dts!,
        /readonly toolCallId: ToolCallId/,
        'the contract must require a toolCallId',
      );
      const assistant = feedIncidentStream().message({ provider: 'antigravity', model: 'g' });
      const history: MessageLike[] = [
        { role: 'user', content: [{ type: 'text', text: 'go' }] },
        assistant,
        { role: 'tool', toolCallId: 'call-3', content: [{ type: 'text', text: 'err' }] },
      ];
      for (const message of healer.heal(history).messages) {
        if (message.role !== 'tool') continue;
        assert.equal(
          typeof message.toolCallId,
          'string',
          'a tool message without a toolCallId would violate the declared contract',
        );
      }
    });

    it('every healed block type is one the harness declares', () => {
      const declared = (() => {
        const map = dts!.match(/interface ContentBlockMap \{([\s\S]*?)\n\}/);
        // The block map lives in types.d.ts, not message.d.ts; fall back to the
        // known vocabulary when it is not in this file.
        if (map === null)
          return [
            'text',
            'reasoning',
            'image',
            'file',
            'tool-call',
            'tool-addition',
            'tool-removal',
          ];
        return [...map[1]!.matchAll(/'([\w-]+)':/g)].map((m) => m[1]!);
      })();
      const assistant = feedIncidentStream().message({ provider: 'antigravity', model: 'g' });
      const history: MessageLike[] = [
        { role: 'user', content: [{ type: 'text', text: 'go' }] },
        assistant,
        { role: 'tool', toolCallId: 'call-3', content: [{ type: 'text', text: 'err' }] },
      ];
      for (const message of healer.heal(history).messages) {
        for (const block of message.content) {
          if (typeof block !== 'object' || block === null) continue;
          const type = (block as { type?: unknown }).type;
          if (typeof type !== 'string') continue;
          assert.ok(
            declared.includes(type),
            `healed block type "${type}" is not declared by the harness`,
          );
        }
      }
    });
  },
);
