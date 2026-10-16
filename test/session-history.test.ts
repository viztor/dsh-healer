/**
 * Deriving a message history from a session log.
 *
 * This exists because of a bug I made and nearly shipped. A first version of the
 * audit script read `data.message` for every event type. Three event types carry
 * messages, and they do **not** carry them in the same place:
 *
 *   user/message      -> `data` **is** the message
 *   assistant/message -> `data.message`
 *   tool/result       -> `data.message`
 *
 * The result was an assistant-only history — 1 054 of 2 325 messages, with every
 * one of the 1 107 tool results silently dropped. Nothing threw. The audit
 * reported "0 stranded results", which was true only because the results were
 * never there to be stranded, and the cascade it existed to verify was hidden.
 *
 * The lesson is narrow and worth pinning: for a log parser, a wrong-but-quiet
 * shape read produces a plausible number, and a plausible number is worse than a
 * crash.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'vite-plus/test';
import { fileURLToPath } from 'node:url';

import { resolveInstalledEntry } from '../src/resolve-harness.ts';
import type { StoreFs } from '../src/resolve-harness.ts';
import { countRoles, deriveMessages, messageOf } from '../scripts/session-history.ts';
import type { SessionMessage } from '../scripts/session-history.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Read the `text` of a message's first content block.
 *
 * A log message's content is `unknown[]` by design — the parser must survive
 * shapes it was not written against — so reading into a block needs a narrow.
 * Doing it here keeps the assertions readable.
 */
function firstBlockText(message: SessionMessage | undefined): unknown {
  const block = message?.content?.[0];
  if (typeof block !== 'object' || block === null) return undefined;
  return (block as { text?: unknown }).text;
}

/** The real shapes, taken from actual session events. */
const USER_EVENT = {
  type: 'user/message',
  seq: 9,
  data: {
    role: 'user',
    content: [{ type: 'text', text: 'hello' }],
    source: { kind: 'user' },
    id: 'm-1',
  },
};

const ASSISTANT_EVENT = {
  type: 'assistant/message',
  seq: 11,
  data: {
    turn: 1,
    step: 1,
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'hi' }],
      source: { kind: 'model', provider: 'p', model: 'm' },
      id: 'm-2',
    },
  },
};

const TOOL_EVENT = {
  type: 'tool/result',
  seq: 42,
  data: {
    turn: 1,
    step: 1,
    message: {
      role: 'tool',
      toolCallId: 'call_1',
      content: [{ type: 'text', text: 'ok' }],
      source: { kind: 'tool', callId: 'call_1' },
    },
  },
};

const OTHER_EVENT = { type: 'step/start', seq: 10, data: { turn: 1, step: 1 } };

describe('messageOf', () => {
  it('reads the message from each of the three real shapes', () => {
    assert.equal(messageOf(USER_EVENT)?.role, 'user');
    assert.equal(messageOf(ASSISTANT_EVENT)?.role, 'assistant');
    assert.equal(messageOf(TOOL_EVENT)?.role, 'tool');
  });

  it('finds the tool result, which is the one the shape trap dropped', () => {
    // `data.message` for this event, not `data` — reading the wrong one yields
    // undefined and silently loses every tool result in the log.
    assert.equal(messageOf(TOOL_EVENT)?.toolCallId, 'call_1');
    assert.equal(firstBlockText(messageOf(TOOL_EVENT)), 'ok');
  });

  it('does not mistake `data` for the message on a tool result', () => {
    // The regression in one assertion: `data` here has no `role`, so treating it
    // as the message must not produce a message.
    assert.equal(messageOf({ type: 'tool/result', data: TOOL_EVENT.data })?.role, 'tool');
    assert.equal(messageOf({ type: 'tool/result', data: { turn: 1, step: 1 } }), undefined);
  });

  it('returns undefined for events that carry no message', () => {
    for (const event of [
      OTHER_EVENT,
      { type: 'user/message' },
      { type: 'assistant/message' },
      {},
      null,
      undefined,
    ]) {
      assert.equal(messageOf(event as never), undefined);
    }
  });

  it('does not throw on a malformed event', () => {
    for (const event of [null, undefined, 7, 'x', [], { type: 'user/message', data: 7 }]) {
      assert.doesNotThrow(() => messageOf(event as never));
    }
  });
});

describe('deriveMessages', () => {
  const log = [
    JSON.stringify(USER_EVENT),
    JSON.stringify(OTHER_EVENT),
    JSON.stringify(ASSISTANT_EVENT),
    JSON.stringify(TOOL_EVENT),
  ].join('\n');

  it('keeps every role, in log order', () => {
    const { messages } = deriveMessages(log);
    assert.deepEqual(
      messages.map((message) => message.role),
      ['user', 'assistant', 'tool'],
      'an assistant-only history means the tool shape was read wrongly',
    );
  });

  it('reports the roles it found', () => {
    const { messages } = deriveMessages(log);
    assert.deepEqual(countRoles(messages), { user: 1, assistant: 1, tool: 1 });
  });

  it('ignores events that carry no message without reporting them as skipped', () => {
    const { skipped } = deriveMessages(log);
    assert.deepEqual(skipped, [], 'a step/start is not a skip; it is simply not a message');
  });

  it('reports a message-carrying event whose message is missing', () => {
    const { messages, skipped } = deriveMessages(
      JSON.stringify({ type: 'assistant/message', seq: 5, data: {} }),
    );
    assert.deepEqual(messages, []);
    assert.equal(skipped.length, 1);
    assert.match(skipped[0]!.reason, /carried no message/);
    assert.equal(skipped[0]!.seq, 5);
  });

  it('skips unparseable lines and reports them', () => {
    const { messages, skipped } = deriveMessages(`not json\n${JSON.stringify(USER_EVENT)}`);
    assert.equal(messages.length, 1);
    assert.equal(skipped.length, 1);
    assert.match(skipped[0]!.reason, /unparseable/);
  });

  it('tolerates blank lines and a trailing newline', () => {
    const { messages } = deriveMessages(`\n\n${JSON.stringify(USER_EVENT)}\n\n`);
    assert.equal(messages.length, 1);
  });

  it('returns nothing for an empty log', () => {
    assert.deepEqual(deriveMessages(''), { messages: [], skipped: [] });
  });
});

describe('session-history · agreement with the harness projection', () => {
  /**
   * The mirror must agree with the harness, not merely look right.
   *
   * It is a reimplementation of `deriveEventMessage`, so the only thing that
   * makes it trustworthy is checking it against the original. The first version
   * omitted `system/message` and `developer/message`: on a real 2,343-message
   * history it read 2,333, silently dropping ten system messages. Every message it
   * did read was byte-identical, which is exactly why nothing caught it.
   */
  /**
   * Resolve `@deepseek-ai/dsh-session` the same portable way the plugin resolves
   * `dsh-llm`: an explicit override, then a normal resolution, then a bounded scan
   * of the pnpm stores.
   *
   * The first version of this helper stopped after the normal resolution, which
   * made it *weaker* than its neighbours: on a clean checkout with no `NODE_PATH`
   * the store scan finds the harness and every other harness-dependent test runs,
   * while this one failed. Two resolvers with different reach is how a suite ends
   * up disagreeing with itself.
   */
  async function loadHarness(): Promise<Record<string, unknown> | undefined> {
    const override = process.env.DSH_SESSION_MODULE;
    if (override !== undefined && override.length > 0) {
      try {
        return (await import(override)) as Record<string, unknown>;
      } catch {
        // fall through to the portable paths
      }
    }

    try {
      const { createRequire } = await import('node:module');
      return (await import(
        createRequire(import.meta.url).resolve('@deepseek-ai/dsh-session')
      )) as Record<string, unknown>;
    } catch {
      // not installed beside this package; try the stores
    }

    const { existsSync, readdirSync } = await import('node:fs');
    const { homedir } = await import('node:os');
    const storeFs: StoreFs = {
      readdir: (dir) => readdirSync(dir),
      exists: (path) => existsSync(path),
      join: (...parts) => join(...parts),
    };
    const found = resolveInstalledEntry(
      '@deepseek-ai/dsh-session',
      'lib/index.js',
      storeFs,
      homedir(),
    );
    if (found !== undefined) {
      try {
        return (await import(found)) as Record<string, unknown>;
      } catch {
        return undefined;
      }
    }
    return undefined;
  }

  const shapes = readFileSync(join(HERE, 'fixtures', 'projection-shapes.jsonl'), 'utf8');

  it('projects the shape fixture through the mirror', () => {
    const { messages } = deriveMessages(shapes);
    assert.deepEqual(
      messages.map((message) => message.role),
      ['system', 'user', 'assistant', 'tool', 'developer', 'assistant', 'tool'],
      'system and developer messages are kept; the empty assistant turn is not',
    );
  });

  it('matches the harness event-for-event, when the harness is installed', async () => {
    const harness = await loadHarness();
    if (harness === undefined) {
      // Same contract as the other harness-dependent tests: name what did not run.
      assert.ok(
        process.env.DSH_HEAL_ALLOW_NO_HARNESS === '1',
        'the DSH session package is not installed, so the mirror was not checked ' +
          'against it; set DSH_HEAL_ALLOW_NO_HARNESS=1 to accept that',
      );
      return;
    }

    const foldSurface = harness.foldSurface as (events: unknown[]) => {
      projectedMessages: Map<number, unknown>;
    };
    const deriveEventMessage = harness.deriveEventMessage as (
      event: unknown,
      projected: Map<number, unknown>,
    ) => unknown;

    const parsed = shapes
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as { type?: string; seq?: number });
    const events = parsed.filter(
      (event) => event.type !== 'session' && typeof event.seq === 'number',
    );
    const folded = foldSurface(events);

    const theirs: unknown[] = [];
    for (const event of events) {
      const message = deriveEventMessage(event, folded.projectedMessages);
      if (message === undefined || message === null) continue;
      theirs.push(message);
    }
    const mine = deriveMessages(shapes).messages;

    assert.equal(mine.length, theirs.length, 'the mirror must project the same number of messages');
    for (let index = 0; index < mine.length; index += 1) {
      assert.deepEqual(
        JSON.parse(JSON.stringify(mine[index])),
        JSON.parse(JSON.stringify(theirs[index])),
        `message ${index} must match the harness exactly`,
      );
    }
  });
});
