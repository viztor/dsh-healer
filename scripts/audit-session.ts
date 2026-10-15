#!/usr/bin/env node
/**
 * Heal a **real session log** and report what happened.
 *
 * This is the closest thing to the live acceptance check that can run without a
 * provider. It derives the provider-visible message history from a real
 * `session.v4.jsonl.zstd`, runs the shipped rules over it, and reports whether
 * the result is a request a strict provider would accept.
 *
 * It reads a local, private log and prints only counts and coordinates — never
 * message content — so its output is safe to paste into a report.
 *
 * Usage:
 *   node scripts/audit-session.ts <session.v4.jsonl.zstd> [--verbose]
 *
 * Exit: 0 when the history heals to a provider-valid request (or was already
 *       valid), 1 when it does not.
 *
 * @module scripts/audit-session
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

import { createHealer } from '../src/engine.ts';
import { DEFAULT_RULES } from '../src/rules/index.ts';
import type { MessageLike } from '../src/types.ts';
import { auditInvariants as audit, countRoles, deriveMessages } from './session-history.ts';

const [, , sessionPath, ...flags] = process.argv;
const verbose = flags.includes('--verbose');

if (sessionPath === undefined || !existsSync(sessionPath)) {
  console.error('usage: node scripts/audit-session.ts <session.v4.jsonl.zstd> [--verbose]');
  process.exit(2);
}

const raw = execFileSync('zstdcat', [sessionPath], { maxBuffer: 1 << 30 }).toString();
const { messages, skipped } = deriveMessages(raw);
const roles = countRoles(messages);

console.log(`session        : ${sessionPath.replace(/^.*\/sessions\//, '…/sessions/')}`);
console.log(`derived        : ${messages.length} provider-visible messages`);
console.log(`roles          : ${JSON.stringify(roles)}`);
if (skipped.length > 0) console.log(`skipped events : ${skipped.length}`);

const before = audit(messages as readonly unknown[]);
console.log(`before         : ${JSON.stringify(before)}`);

const healer = createHealer(DEFAULT_RULES);
const snapshot = JSON.stringify(messages);

const findings = healer.check(messages as MessageLike[]);
if (verbose) {
  for (const finding of findings) {
    console.log(
      `  finding      : ${finding.ruleId} message ${finding.messageIndex}` +
        (finding.blockIndex === undefined ? '' : ` block ${finding.blockIndex}`) +
        ` — ${finding.reason}`,
    );
  }
}

const healed = healer.heal(messages as MessageLike[]);
const unmutated = JSON.stringify(messages) === snapshot;
const after = audit(healed.messages as readonly unknown[]);
const idempotent = healer.heal(healed.messages).messages === healed.messages;

console.log(`after          : ${JSON.stringify(after)}`);
console.log(`applied        : ${healed.applied.length} fix(es)`);
console.log(`input unmutated: ${unmutated}`);
console.log(`idempotent     : ${idempotent}`);
console.log(
  `clean identity : ${healed.messages === messages ? 'true (no alloc)' : 'false (copy on write)'}`,
);

const repairable = after.emptyNames === 0 && after.strandedResults === 0;
const outsideModel = after.malformedCalls > 0;
const ok = repairable && unmutated && idempotent;

if (outsideModel) {
  console.log(
    `\nnote: ${after.malformedCalls} tool call(s) carry no usable id. That shape has` +
      '\n      never been observed and no rule repairs it — see the comment above.' +
      '\n      The repair checks below still decide the verdict.',
  );
}

console.log(
  ok
    ? '\nPASS: the real history heals to a provider-valid request'
    : '\nFAIL: the healed history is still not provider-valid',
);

process.exit(ok ? 0 : 1);
