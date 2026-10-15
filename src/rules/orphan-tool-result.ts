/**
 * `orphan-tool-result` — drop a tool result whose tool call no longer exists.
 *
 * This rule is the cascade terminator, not a primary detector. In the real
 * incident the fabricated call *was* dispatched and answered (`Error: unknown
 * tool ""`), so nothing was orphaned until `tool-call-name` removed the call.
 * Removing a call without removing its result would strand a `role:"tool"`
 * message — which is why the message phase must run after the content phase.
 *
 * ## Whether the stranded result is fatal depends on the protocol
 *
 * Measured live against Anthropic Messages (`scripts/live-acceptance.mjs`,
 * TESTPLAN §3l): an empty tool name is rejected with 400, while a `tool_result`
 * answering a call absent from the request is **accepted**. An earlier version of
 * this comment claimed it "would produce a fresh 400"; that is false for the one
 * protocol we can measure, and it is corrected rather than left standing.
 *
 * The rule stays enabled for two reasons that do not depend on that measurement:
 *
 *   1. OpenAI-compatible protocols reject an unmatched tool result by contract —
 *      each assistant `tool_calls` entry must be answered by a matching `tool`
 *      message. That contract is **not** verified here.
 *   2. A history where a result answers no call is internally inconsistent, and
 *      sending it forward makes the next reader rediscover why.
 *
 * What the rule must never do is fire on a result whose call is still present.
 * That is what the surviving-id set is for, and why a missing or non-Set
 * collection means "report nothing" rather than "assume orphan".
 *
 * Ids may be harness-synthesised rather than provider-issued: the assembler
 * falls back to `call-${index}` when a block never received an id. The rule
 * therefore compares ids literally and makes no assumption about provenance.
 *
 * @module dsh-healer/rules/orphan-tool-result
 */

import { isMembershipSet } from '../narrow.ts';
import type {
  DetectContext,
  Finding,
  MessageDetectContext,
  RepairDecision,
  Rule,
} from '../types.ts';

export const id = 'orphan-tool-result';

/** Only tool-role messages carry a result to correlate. */
export const roles = ['tool'] as const;

/**
 * Report one message when its result answers a call that did not survive.
 *
 * The engine hands the message itself, so `.toolCallId` is read directly and the
 * context supplies only the position and the surviving ids. Reading the message
 * rather than a wrapper is what keeps a clean pass allocation-free.
 */
export function detect(message: unknown, ctx?: DetectContext): Finding | undefined {
  if (message === undefined || message === null) return undefined;
  const callId = (message as { toolCallId?: unknown }).toolCallId;
  if (typeof callId !== 'string' || callId.length === 0) {
    return undefined;
  }
  // A missing or non-Set collection means we cannot tell an orphan from a
  // matched result, and guessing would drop a real result. Report nothing.
  const surviving = (ctx as MessageDetectContext | undefined)?.survivingToolCallIds;
  if (!isMembershipSet(surviving)) return undefined;
  if (surviving.has(callId)) return undefined;
  return {
    ruleId: id,
    reason: `tool result "${callId}" has no surviving tool call`,
    messageIndex: (ctx as MessageDetectContext).index,
    detail: { toolCallId: callId },
  };
}

/** A result with no call cannot be sent; the whole message goes. */
export function repair(): RepairDecision {
  return { action: 'drop' };
}

export const rule: Rule = {
  id,
  kind: 'message',
  enabledByDefault: true,
  description:
    'Drop a tool result whose tool call did not survive the content phase (the cascade terminator).',
  roles,
  detect: (message, ctx) => detect(message, ctx),
  repair: () => repair(),
};
