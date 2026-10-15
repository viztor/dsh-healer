/**
 * `tool-call-name` — drop a tool call whose name is not a usable, non-empty
 * string.
 *
 * This is the primary rule: every 400 observed in the incident named an empty
 * tool name (`messages.115.content.3.tool_use.name: Field required`, and
 * `` `name` must be non-empty ``). No provider ever accepted it, and no repair
 * short of removal is safe — a substituted name would be sent as a real tool
 * invocation the model never requested.
 *
 * @module dsh-healer/rules/tool-call-name
 */

import type { DetectContext, Finding, RepairDecision, Rule } from '../types.ts';
import { readString } from '../narrow.ts';

/** Block tags that denote a model-requested tool invocation. */
const TOOL_CALL_TAGS = ['tool-call', 'tool_use'] as const;

export const id = 'tool-call-name';

/**
 * Tool calls are produced by the model, so only assistant messages are judged.
 *
 * The scope is deliberate, and the reason is stronger than "that is where they
 * usually are". A `tool-call` block can sit in a `developer` message, but the
 * pi-ai adapter rejects a developer message outright —
 * `assertSupportedHistory` throws `UNSUPPORTED_CONTENT` before any block is
 * projected — so a malformed name there cannot be the thing that breaks a
 * request. Widening the scope would edit a message for no reason, which is the
 * over-sanitization risk the design exists to avoid. Fuzzing found this
 * boundary; `test/fuzz.test.ts` I1b pins it.
 */
export const roles = ['assistant'] as const;

/**
 * Report one block when it is a tool call with an unusable name.
 *
 * The engine hands the block itself, so there is nothing to unwrap — which is
 * what keeps a clean pass allocation-free.
 */
export function detect(block: unknown, _ctx?: DetectContext): Finding | undefined {
  if (block === undefined || block === null) return undefined;
  // Read the tag once and compare, rather than `TOOL_CALL_TAGS.find(...)`: that
  // callback was a fresh closure for every block in the history, which is the
  // kind of allocation a "clean pass costs nothing" claim cannot survive.
  const tag = readString(block, 'type');
  if (tag === undefined || (tag !== TOOL_CALL_TAGS[0] && tag !== TOOL_CALL_TAGS[1])) {
    return undefined;
  }

  const name = readString(block, 'name');
  if (name === undefined) {
    return {
      ruleId: id,
      reason: `${tag} has no string "name"`,
      messageIndex: -1,
      detail: { tag, name: null },
    };
  }
  if (name.trim().length === 0) {
    return {
      ruleId: id,
      reason: `${tag} has an empty "name"`,
      messageIndex: -1,
      detail: { tag, name },
    };
  }
  return undefined;
}

/** Removal is the only repair that cannot cause an unintended side effect. */
export function repair(): RepairDecision {
  return { action: 'drop' };
}

export const rule: Rule = {
  id,
  kind: 'content',
  enabledByDefault: true,
  description: 'Drop a tool call whose name is missing, empty, or whitespace-only.',
  roles,
  detect: (block) => detect(block),
  repair: () => repair(),
};
