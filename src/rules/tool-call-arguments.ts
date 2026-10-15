/**
 * `tool-call-arguments` — normalise a tool call whose `arguments` is not a
 * parseable JSON object.
 *
 * Ships **disabled** by default, and normalises rather than drops when enabled.
 *
 * Two reasons, both evidence-driven. The adapter already implements exactly this
 * tolerance: `parseArguments` in `dsh-llm-pi-ai` returns `{}` for anything that
 * is not a JSON object, on both history-reconstruction paths, so the wire never
 * carries an empty `arguments`. And no observed 400 implicated `arguments` — the
 * incident's every error named `name` only. Dropping the block would therefore
 * be a behaviour change with no incident behind it, and it would cascade through
 * the orphan rule to delete a real tool result.
 *
 * @module dsh-healer/rules/tool-call-arguments
 */

import type { DetectContext, Finding, RepairDecision, Rule } from '../types.ts';
import { hasType, readString } from '../narrow.ts';

export const id = 'tool-call-arguments';

/** Tool calls are produced by the model, so only assistant messages are judged. */
export const roles = ['assistant'] as const;

/** The value the adapter itself substitutes for unusable arguments. */
export const NORMALISED_ARGUMENTS = '{}';

/** True when the string parses to a plain JSON object. */
export function isJsonObject(raw: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false;
  }
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed);
}

/** Report one block when it is a tool call with unusable arguments. */
export function detect(block: unknown, _ctx?: DetectContext): Finding | undefined {
  if (block === undefined || block === null) return undefined;
  if (!hasType(block, 'tool-call') && !hasType(block, 'tool_use')) return undefined;

  const raw = readString(block, 'arguments');
  if (raw === undefined) {
    return {
      ruleId: id,
      reason: 'tool-call has no string "arguments"',
      messageIndex: -1,
      // `repair` needs the whole block to rebuild it, so carry it here.
      detail: { block },
    };
  }
  if (!isJsonObject(raw)) {
    return {
      ruleId: id,
      reason: 'tool-call "arguments" is not a parseable JSON object',
      messageIndex: -1,
      detail: { block },
    };
  }
  return undefined;
}

/**
 * Replace with `{}` — the value the pi-ai adapter already substitutes — so the
 * repair reproduces existing semantics without removing the call or orphaning
 * its result.
 */
export function repair(finding: Finding): RepairDecision {
  const detail = finding.detail;
  if (typeof detail === 'object' && detail !== null && 'block' in detail) {
    const block = (detail as { block: unknown }).block;
    if (typeof block === 'object' && block !== null && !Array.isArray(block)) {
      return {
        action: 'replace',
        value: { ...(block as Record<string, unknown>), arguments: NORMALISED_ARGUMENTS },
      };
    }
  }
  return { action: 'drop' };
}

export const rule: Rule = {
  id,
  kind: 'content',
  enabledByDefault: false,
  description:
    'Normalise tool-call arguments that are not a parseable JSON object to {}. Disabled by default: the adapter already tolerates them.',
  roles,
  detect: (block) => detect(block),
  repair: (finding) => repair(finding),
};
