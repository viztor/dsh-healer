/**
 * `empty-assistant-message` — drop an assistant message left with no content.
 *
 * Ships **disabled** by default. Removing every block of an assistant message
 * yields `content: []`, whose validity is provider-dependent: a validation risk
 * on some routes and harmless on others. It is a separate, opt-in decision, not
 * an automatic consequence of the content phase.
 *
 * It becomes *reachable* as soon as `tool-call-name` is enabled — a message
 * whose only block was an empty-named tool call is left empty — so the rule
 * exists and is tested even while disabled.
 *
 * @module dsh-healer/rules/empty-assistant-message
 */

import type {
  DetectContext,
  Finding,
  MessageDetectContext,
  RepairDecision,
  Rule,
} from '../types.ts';

export const id = 'empty-assistant-message';

/** Only assistant messages can be emptied by the content phase. */
export const roles = ['assistant'] as const;

/** Report one message when the content phase left it with nothing to say. */
export function detect(message: unknown, ctx?: DetectContext): Finding | undefined {
  if (message === undefined || message === null) return undefined;
  const candidate = message as { content?: unknown; role?: unknown };
  const content = candidate.content;
  if (!Array.isArray(content)) return undefined;
  if (content.length > 0) return undefined;
  return {
    ruleId: id,
    reason: 'assistant message has no content blocks left',
    messageIndex: (ctx as MessageDetectContext).index,
    detail: { role: candidate.role },
  };
}

/** An empty assistant turn carries no information; drop it. */
export function repair(): RepairDecision {
  return { action: 'drop' };
}

export const rule: Rule = {
  id,
  kind: 'message',
  enabledByDefault: false,
  description:
    'Drop an assistant message whose content is empty after the content phase. Disabled by default: some providers accept content: [].',
  roles,
  detect: (message, ctx) => detect(message, ctx),
  repair: () => repair(),
};
