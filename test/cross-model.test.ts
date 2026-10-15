/**
 * Cross-model projection: the same healed history, three wire shapes.
 *
 * The claim this backs is "one repair works across models". The repair itself is
 * provider-neutral — it only removes a block no provider accepted — so the thing
 * worth proving is that each protocol projects the *healed* history into a shape
 * with no empty tool name and no stranded result, and that the three projections
 * agree on the content they carry.
 *
 * The projectors here mirror the mappings the adapters perform
 * (`tool-call` -> `tool_use` for Anthropic, `tool_calls[]` for OpenAI-compatible,
 * and the responses shape for the opencode route). They are deliberately small:
 * this test is about the repaired data, not about adapter fidelity.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, it } from 'vite-plus/test';

import { createHealer } from '../src/engine.ts';
import { DEFAULT_RULES } from '../src/rules/index.ts';
import type { MessageLike } from '../src/types.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, '..', 'test', 'fixtures');

const history = JSON.parse(
  readFileSync(join(FIXTURES, 'history-around.json'), 'utf8'),
) as readonly MessageLike[];

const healer = createHealer(DEFAULT_RULES);

/** Every tool-call block across a message list, with its call id. */
function calls(messages: readonly MessageLike[]): { id: string; name: string }[] {
  const found: { id: string; name: string }[] = [];
  for (const message of messages) {
    for (const block of message.content) {
      if (typeof block !== 'object' || block === null) continue;
      const candidate = block as { type?: string; id?: string; name?: string };
      if (candidate.type !== 'tool-call') continue;
      found.push({ id: String(candidate.id), name: String(candidate.name) });
    }
  }
  return found;
}

/** Anthropic Messages: `tool-call` becomes `tool_use` with a parsed `input`. */
function projectAnthropic(messages: readonly MessageLike[]) {
  return messages.map((message) => ({
    role: message.role,
    content: message.content.map((block) => {
      const candidate = block as { type?: string; id?: string; name?: string; arguments?: string };
      if (candidate.type !== 'tool-call') return block;
      return {
        type: 'tool_use',
        id: candidate.id,
        name: candidate.name,
        input: JSON.parse(candidate.arguments ?? '{}'),
      };
    }),
    ...(message.toolCallId === undefined ? {} : { tool_use_id: message.toolCallId }),
  }));
}

/** OpenAI Chat Completions: tool calls live under `tool_calls[].function`. */
function projectOpenAi(messages: readonly MessageLike[]) {
  return messages.map((message) => {
    if (message.role === 'tool') {
      return { role: 'tool', tool_call_id: message.toolCallId, content: message.content };
    }
    const toolCalls = message.content
      .filter(
        (block) =>
          typeof block === 'object' &&
          block !== null &&
          (block as { type?: string }).type === 'tool-call',
      )
      .map((block) => {
        const candidate = block as { id?: string; name?: string; arguments?: string };
        return {
          id: candidate.id,
          type: 'function',
          function: { name: candidate.name, arguments: candidate.arguments },
        };
      });
    return {
      role: message.role,
      content: message.content,
      ...(toolCalls.length === 0 ? {} : { tool_calls: toolCalls }),
    };
  });
}

/** The responses shape used by the opencode route: flat call/result items. */
function projectResponses(messages: readonly MessageLike[]) {
  const items: unknown[] = [];
  for (const message of messages) {
    for (const block of message.content) {
      const candidate = block as { type?: string; id?: string; name?: string; arguments?: string };
      if (candidate.type === 'tool-call') {
        items.push({
          type: 'function_call',
          call_id: candidate.id,
          name: candidate.name,
          arguments: candidate.arguments,
        });
        continue;
      }
      items.push({ type: message.role === 'tool' ? 'function_call_output' : 'message', block });
    }
    if (message.role === 'tool') {
      items.push({ type: 'function_call_output', call_id: message.toolCallId });
    }
  }
  return items;
}

const projectors = {
  'anthropic-messages': projectAnthropic,
  'openai-completions': projectOpenAi,
  'opencode-responses': projectResponses,
} as const;

describe('cross-model projection of the healed history', () => {
  const healed = healer.heal(history).messages;

  it('heals before projection, so every shape sees the same repaired input', () => {
    assert.equal(calls(healed).filter((call) => call.name === '').length, 0);
  });

  for (const [label, project] of Object.entries(projectors)) {
    it(`${label}: carries no empty tool name`, () => {
      const projected = project(healed);
      const serialised = JSON.stringify(projected);
      // The precise failure the incident produced on the wire.
      assert.doesNotMatch(serialised, /"name":""/, `${label} must not send an empty name`);
    });

    it(`${label}: carries no stranded tool result`, () => {
      const projected = project(healed);
      const serialised = JSON.stringify(projected);
      const surviving = new Set(calls(healed).map((call) => call.id));
      for (const id of ['call-3']) {
        assert.ok(!surviving.has(id), 'the fabricated call is gone');
        assert.ok(
          !serialised.includes(`"${id}"`),
          `${label} must not reference the removed call ${id}`,
        );
      }
    });
  }

  it('agrees across all three shapes on the surviving calls', () => {
    const perShape = Object.entries(projectors).map(([label, project]) => {
      const serialised = JSON.stringify(project(healed));
      const surviving = calls(healed).map((call) => call.name);
      return { label, names: surviving.filter((name) => serialised.includes(name)) };
    });
    const first = perShape[0];
    assert.ok(first, 'at least one protocol shape must be present');
    for (const shape of perShape) {
      assert.deepEqual(
        shape.names,
        first.names,
        `${shape.label} disagrees with ${first.label} about the surviving calls`,
      );
    }
    assert.ok(first.names.length > 0, 'at least one valid call must survive in every shape');
  });
});
