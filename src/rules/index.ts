/**
 * The shipped rule set, as an ordinary array.
 *
 * Order within this array is the order the engine consults rules; phase ordering
 * (content before message) is structural and belongs to the engine, not here.
 * Adding a rule is a one-line change in this list — no engine or patch file is
 * touched, which is the property that keeps the set extensible.
 *
 * Defaults are evidence-driven:
 *
 *   tool-call-name           on   the only defect implicated by every observed 400
 *   tool-call-arguments      off  the adapter already tolerates bad arguments
 *   orphan-tool-result       on   the cascade terminator for tool-call-name
 *   empty-assistant-message  off  content: [] is provider-dependent
 *
 * @module dsh-healer/rules
 */

import type { Rule } from '../types.ts';
import { rule as toolCallName } from './tool-call-name.ts';
import { rule as toolCallArguments } from './tool-call-arguments.ts';
import { rule as orphanToolResult } from './orphan-tool-result.ts';
import { rule as emptyAssistantMessage } from './empty-assistant-message.ts';

export { toolCallName, toolCallArguments, orphanToolResult, emptyAssistantMessage };

/** Every rule this package ships, enabled or not. */
export const DEFAULT_RULES: readonly Rule[] = [
  toolCallName,
  toolCallArguments,
  orphanToolResult,
  emptyAssistantMessage,
];
