#!/usr/bin/env node
/**
 * Live acceptance: a **real** provider call on a **real** poisoned history.
 *
 * Everything else in this repository proves the repair against fakes, against
 * the real seam with a fake adapter, or against real histories offline. This is
 * the one check that closes the loop: the provider itself decides.
 *
 * It is opt-in and never runs as part of `node --test`, because it needs a live
 * endpoint and a real session log — neither of which a contributor is guaranteed
 * to have. It skips with an explanation rather than failing when either is
 * missing.
 *
 * ## Why a window
 *
 * The real incident session is 2 343 messages / 6.7 MB, which exceeds the
 * provider's context limit — so both the poisoned and the healed request come
 * back 400 for *size*, and the experiment proves nothing. A window centred on the
 * defect keeps the poison, its stranded result, and enough surrounding history to
 * be well-formed otherwise.
 *
 * ## Why five requests, and what they found
 *
 * A single "poisoned 400, healed 200" pair would be suggestive but not causal: it
 * would not show *which* half of the damage caused the rejection. The
 * decomposition removes one defect at a time.
 *
 *   1. original            both defects present         -> rejected (asserted)
 *   2. result removed      the empty-name call remains  -> rejected (asserted)
 *   3. call removed        the result is now stranded   -> OBSERVED, not asserted
 *   4. both removed        what the healer does         -> accepted (asserted)
 *   5. heal the healed     idempotence                  -> accepted (asserted)
 *
 * Step 3 is the finding. The first live run asserted that a stranded result is
 * fatal — the assumption the `orphan-tool-result` rule is justified by — and the
 * provider **accepted** it. For Anthropic Messages, an empty tool name is fatal
 * and an unmatched `tool_result` is not.
 *
 * So this check asserts only what it can prove. The orphan rule stays, because a
 * history with a result answering no call is malformed and OpenAI-compatible
 * protocols reject it by contract — but that contract is *not* verified here, and
 * the scripts and docs no longer claim it is. See TESTPLAN §3l.
 *
 * ## Usage
 *
 *   DSH_SESSION_LOG=<session.v4.jsonl.zstd> node scripts/live-acceptance.ts
 *
 * Optional: `DSH_AT` (window centre message index), `DSH_LIVE_ENDPOINT`,
 * `DSH_LIVE_MODEL`, `DSH_LIVE_KEY`.
 *
 * @module dsh-healer/scripts/live-acceptance
 */

import { execSync } from 'node:child_process';

import { createHealer } from '../src/engine.ts';
import { DEFAULT_RULES } from '../src/rules/index.ts';
import type { MessageLike } from '../src/types.ts';
import { deriveMessages } from './session-history.ts';

const ENDPOINT = process.env.DSH_LIVE_ENDPOINT ?? 'http://localhost:8080/v1/messages';
const MODEL = process.env.DSH_LIVE_MODEL ?? 'gemini-3.8-flash';
const KEY = process.env.DSH_LIVE_KEY ?? 'local';
const SESSION = process.env.DSH_SESSION_LOG;
const WINDOW = Number(process.env.DSH_WINDOW ?? 30);

function skip(reason: string): never {
  console.log(`SKIP: ${reason}`);
  console.log(
    'This check needs a live endpoint and a real session log; it is not part of the suite.',
  );
  process.exit(0);
}

if (SESSION === undefined || SESSION.length === 0) {
  skip('set DSH_SESSION_LOG to a session .jsonl.zstd to run it');
}

/** DSH internal blocks -> Anthropic Messages blocks. */
function toBlocks(content: readonly unknown[]): unknown[] {
  const out: unknown[] = [];
  for (const block of content) {
    const b = block as {
      type?: string;
      text?: unknown;
      arguments?: unknown;
      id?: unknown;
      name?: unknown;
    };
    if (b?.type === 'text') {
      out.push({ type: 'text', text: String(b.text ?? '') });
    } else if (b?.type === 'tool-call') {
      let input = {};
      try {
        input = JSON.parse(String(b.arguments ?? '{}'));
      } catch {
        input = {};
      }
      out.push({ type: 'tool_use', id: String(b.id ?? ''), name: String(b.name ?? ''), input });
    }
  }
  return out;
}

/**
 * Project to Anthropic Messages.
 */
function project(messages: readonly MessageLike[]): unknown[] {
  const out: { role: string; content: unknown[] }[] = [];
  const push = (role: string, content: unknown[]) => {
    const last = out[out.length - 1];
    if (last !== undefined && last.role === role) last.content.push(...content);
    else out.push({ role, content: [...content] });
  };
  for (const message of messages) {
    if (message.role === 'user') push('user', toBlocks(message.content));
    else if (message.role === 'assistant') push('assistant', toBlocks(message.content));
    else if (message.role === 'tool') {
      const inner = message.content.map((block) => ({
        type: 'text',
        text: String((block as { text?: unknown })?.text ?? ''),
      }));
      push('user', [
        {
          type: 'tool_result',
          tool_use_id: String(message.toolCallId ?? ''),
          content: inner,
          ...((message as { isError?: boolean }).isError === true ? { is_error: true } : {}),
        },
      ]);
    }
  }
  if (out.length > 0 && out[0]!.role !== 'user') {
    out.unshift({ role: 'user', content: [{ type: 'text', text: '(history)' }] });
  }
  return out;
}

async function send(
  messages: readonly MessageLike[],
): Promise<{ status: number; detail: string; bytes: number }> {
  const body = JSON.stringify({ model: MODEL, max_tokens: 32, messages: project(messages) });
  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
      authorization: `Bearer ${KEY}`,
    },
    body,
  });
  const text = await response.text();
  let detail = text.slice(0, 200);
  try {
    const parsed = JSON.parse(text) as {
      error?: { message?: string };
      content?: [{ text?: string }];
    };
    detail = parsed?.error?.message ?? parsed?.content?.[0]?.text ?? detail;
  } catch {
    // keep the raw prefix
  }
  return {
    status: response.status,
    detail: String(detail).replace(/\s+/g, ' ').slice(0, 150),
    bytes: body.length,
  };
}

/** Drop one block, addressed by message index and block index. */
function withoutBlock(
  messages: readonly MessageLike[],
  messageIndex: number,
  blockIndex: number,
): MessageLike[] {
  return messages.map((message, index) =>
    index === messageIndex
      ? { ...message, content: message.content.filter((_, block) => block !== blockIndex) }
      : message,
  );
}

const raw = execSync(`zstdcat ${JSON.stringify(SESSION)}`, { maxBuffer: 1 << 30 }).toString();
const { messages: all } = deriveMessages(raw);

/** The assistant message holding a tool call with an empty name. */
function findPoison(messages: readonly MessageLike[]) {
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;
    if (message.role !== 'assistant') continue;
    for (let block = 0; block < message.content.length; block += 1) {
      const candidate = message.content[block] as { type?: string; name?: unknown; id?: unknown };
      if (candidate?.type === 'tool-call' && String(candidate.name ?? '') === '') {
        return { messageIndex: index, blockIndex: block, callId: String(candidate.id ?? '') };
      }
    }
  }
  return undefined;
}

const poison = findPoison(all as MessageLike[]);
if (poison === undefined) skip('the session log contains no empty-name tool call to test against');

const from = Math.max(0, poison.messageIndex - WINDOW);
const to = Math.min(all.length, poison.messageIndex + 6);
const window = (all as MessageLike[]).slice(from, to);
const at = { messageIndex: poison.messageIndex - from, blockIndex: poison.blockIndex };

console.log(`endpoint     : ${ENDPOINT}`);
console.log(`model        : ${MODEL}`);
console.log(`session      : ${all.length} messages; window ${from}..${to} (${window.length})`);
console.log(
  `defect       : message ${at.messageIndex}, block ${at.blockIndex}, call id "${poison.callId}"`,
);

const strandedIndex = window.findIndex(
  (message) => message.role === 'tool' && message.toolCallId === poison.callId,
);
const hasStranded = strandedIndex >= 0;

const healer = createHealer(DEFAULT_RULES);
const report = healer.heal(window);

console.log(
  `healer       : ${report.applied.length} fix(es) — ${report.applied.map((a) => `${a.ruleId}@${a.messageIndex}/${a.action}`).join(', ')}`,
);
console.log('');

const results: { label: string; ok: boolean; status: number; detail: string; bytes: number }[] = [];
const check = async (
  label: string,
  expectation: 'reject' | 'accept' | 'observe',
  messages: readonly MessageLike[],
) => {
  const result = await send(messages);
  const ok = expectation === 'reject' ? result.status >= 400 : result.status < 400;
  if (expectation !== 'observe') results.push({ label, ok, ...result });
  const mark = expectation === 'observe' ? 'obs ' : ok ? 'ok  ' : 'FAIL';
  console.log(
    `${mark} ${label.padEnd(22)} HTTP ${result.status}  ${(result.bytes / 1024).toFixed(0)} KB  ${result.detail.slice(0, 90)}`,
  );
  return result;
};

await check('1 original', 'reject', window);
await check(
  '2 empty-name call remains',
  'reject',
  hasStranded ? window.filter((_, index) => index !== strandedIndex) : window,
);
const stranded = hasStranded
  ? await check(
      '3 call removed only',
      'observe',
      withoutBlock(window, at.messageIndex, at.blockIndex),
    )
  : { status: 0 };
await check('4 both removed (heal)', 'accept', report.messages);
await check('5 heal is idempotent', 'accept', healer.heal(report.messages).messages);

const failed = results.filter((entry) => !entry.ok);
console.log('');
if (!hasStranded) {
  console.log(
    'note: this session has no stranded result — the fabricated call was never dispatched,',
  );
  console.log('      so the healer applies one fix and step 3 does not apply.');
} else if (stranded.status >= 400) {
  console.log(
    'note: this protocol rejects a stranded tool result, so the orphan cascade is required here too.',
  );
} else {
  console.log(
    'note: this protocol ACCEPTS a stranded tool result. The empty tool name is the fatal defect',
  );
  console.log(
    '      for Anthropic Messages; the orphan rule is justified by the OpenAI-compatible contract',
  );
  console.log('      and by history consistency, not by this endpoint. See TESTPLAN §3l.');
}
if (failed.length === 0) {
  console.log('PASS: the provider rejects the empty tool name and accepts the healed history.');
  process.exit(0);
}
console.log(`FAIL: ${failed.map((entry) => entry.label).join(', ')}`);
process.exit(1);
