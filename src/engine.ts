/**
 * The rule-agnostic healer engine.
 *
 * The engine owns everything that must hold no matter which rules are
 * registered: phase ordering, role scoping, enablement, identity preservation,
 * immutability, application, accounting, and diagnostics. A rule owns exactly
 * one thing: judging what it is shown, and saying what to do about it.
 *
 * Two entry points share one detection implementation, so they cannot drift:
 *
 *   `check(messages)` detects and reports, and never repairs.
 *   `heal(messages)` detects, repairs, and reports what it changed.
 *
 * ## Zero copy
 *
 * On a clean history a pass allocates **no message, no message list, and no
 * per-message wrapper**. Three decisions get it there:
 *
 *   1. A content rule is handed the existing block, and a message rule the
 *      existing message, as its target. The engine builds no view object — the
 *      earlier design built one per message, which measured ~100 KB of garbage
 *      on a 2 300-message history even when nothing changed.
 *   2. The only per-call object is a **reused context** whose fields are
 *      rewritten between calls. Rules read it; the contract says not to retain
 *      it, and that is what buys the allocation away.
 *   3. Content changes are recorded sparsely in a map that is not created unless
 *      a rule actually changes something, and the projected list is built only
 *      when that map exists.
 *
 * One thing is deliberately **not** free: `survivingToolCallIds`, a `Set` derived
 * from the assistant messages. A message rule needs it to answer "does this tool
 * result still have a matching call?" in one pass instead of a quadratic scan. It
 * is a derived index rather than a copy, and it is named here rather than left
 * for someone to rediscover.
 *
 * @module dsh-healer/engine
 */

import { hasType, readString } from './narrow.ts';
import type {
  AppliedFix,
  Finding,
  HealReport,
  HealerOptions,
  MessageLike,
  MessageRole,
  RepairDecision,
  Rule,
  SkippedRule,
} from './types.ts';

/** Narrowing helpers, re-exported for callers that already import them here. */
export { hasType, isRecord, readString } from './narrow.ts';

function roleOf(message: MessageLike): MessageRole {
  return message.role;
}

/** Whether a rule may be shown a message with this role. */
function roleAllowed(rule: Rule, role: MessageRole): boolean {
  return rule.roles === undefined || rule.roles.includes(role);
}

/**
 * A shared empty list, returned instead of a fresh `[]`.
 *
 * `asFindings` is called once per rule per block. On a 2 342-message history that
 * is thousands of calls, and a new empty array each time was measurable garbage.
 * The result is never mutated, so one frozen instance is safe.
 */
const NO_FINDINGS: readonly Finding[] = Object.freeze([]);

/** Normalise `detect`'s return into a list. */
function asFindings(result: Finding | readonly Finding[] | undefined): readonly Finding[] {
  if (result === undefined) return NO_FINDINGS;
  return Array.isArray(result) ? result : [result as Finding];
}

/** Whether a rule is enabled under the resolved configuration. */
function isEnabled(rule: Rule, options: HealerOptions | undefined): boolean {
  const override = options?.rules?.[rule.id];
  return override === undefined ? rule.enabledByDefault : override.enabled;
}

/** Configured rule ids that no registered rule provides. */
export function unknownRuleIds(
  rules: readonly Rule[],
  options: HealerOptions | undefined,
): readonly string[] {
  const known = new Set(rules.map((rule) => rule.id));
  return Object.keys(options?.rules ?? {}).filter((id) => !known.has(id));
}

/**
 * Every tool-call id that survives, from assistant messages only.
 *
 * A `tool-call` parked in another role does not count: only the assistant's
 * calls are sent as calls, so a result answering a non-assistant "call" is
 * genuinely orphaned.
 */
function collectToolCallIds(messages: readonly MessageLike[]): Set<string> {
  const ids = new Set<string>();
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    for (const block of message.content) {
      if (!hasType(block, 'tool-call')) continue;
      const id = readString(block, 'id');
      if (id !== undefined && id.length > 0) ids.add(id);
    }
  }
  return ids;
}

/** One block's repair decision, paired with the reason that produced it. */
interface DecidedRepair {
  readonly ruleId: string;
  readonly reason: string;
  readonly decision: RepairDecision;
}

/** Decide what one block's findings should do to the block. */
interface BlockOutcome {
  readonly dropped: boolean;
  readonly replacement?: unknown;
  readonly source?: DecidedRepair;
}

/**
 * The outcome when no rule decided anything about a block.
 *
 * Shared, and returned by identity. Building `{ dropped: false }` per block looks
 * expensive and is not: re-injecting it measures ~56 bytes more, because V8
 * eliminates an object that never escapes. An earlier comment here claimed
 * ~270 KB; that figure came from a flawed measurement and does not reproduce.
 * The constant stays because it is free and honest, not because it is load-bearing.
 */
const KEPT: BlockOutcome = Object.freeze({ dropped: false });

/**
 * Fold one block's repair decisions into a single outcome, in rule order.
 *
 * The engine — not the rule — decides precedence, so rule ordering cannot
 * produce a surprising result: a drop wins immediately over any replacement, and
 * a replacement from an earlier rule can be superseded by a later one.
 */
function foldDecisions(decisions: readonly DecidedRepair[]): BlockOutcome {
  if (decisions.length === 0) return KEPT;
  let replacement: unknown;
  let hasReplacement = false;
  let source: DecidedRepair | undefined;
  for (const entry of decisions) {
    if (entry.decision.action === 'drop') return { dropped: true };
    if (entry.decision.action === 'replace') {
      replacement = entry.decision.value;
      hasReplacement = true;
      source = entry;
    }
  }
  return hasReplacement ? { dropped: false, replacement, source } : { dropped: false };
}

interface PassResult {
  readonly findings: readonly Finding[];
  readonly applied: readonly AppliedFix[];
  readonly skipped: readonly SkippedRule[];
  /** `undefined` when nothing was applied, so callers reuse the input list. */
  readonly messages: readonly MessageLike[] | undefined;
}

/**
 * Run one full pass: content phase, then message phase.
 *
 * `repair` decides whether `repair()` is consulted. When it is `false` this is a
 * pure detection pass: no message object and no message list is constructed.
 */
function runPass(
  rules: readonly Rule[],
  messages: readonly MessageLike[],
  options: HealerOptions | undefined,
  repair: boolean,
): PassResult {
  const findings: Finding[] = [];
  const applied: AppliedFix[] = [];
  const skipped: SkippedRule[] = [];

  /**
   * Role skips, counted per rule per role.
   *
   * Counted rather than listed: on the real 2 342-message history, one entry per
   * message produced 2 498 diagnostics to say "these two rules never applied
   * here". Counting keeps the same information in six entries.
   *
   * This is a **reporting** fix, not an allocation fix. Re-injecting the
   * per-message form measures ~344 bytes more, because V8 eliminates the
   * short-lived entries; an earlier comment here claimed it saved ~40 KB, which
   * does not reproduce.
   */
  const roleSkips: { ruleId: string; role: MessageRole; count: number }[] = [];
  /**
   * Count one role skip.
   *
   * A linear scan over a handful of entries, deliberately: keying a `Map` by
   * `${ruleId}\u0000${role}` built a fresh string for **every message**, which
   * measured ~40 bytes per message — more than the bookkeeping it saved. With a
   * rule set this small, the scan is free and allocates nothing.
   */
  const noteRoleSkip = (ruleId: string, role: MessageRole): void => {
    for (let i = 0; i < roleSkips.length; i += 1) {
      const entry = roleSkips[i]!;
      if (entry.ruleId === ruleId && entry.role === role) {
        entry.count += 1;
        return;
      }
    }
    roleSkips.push({ ruleId, role, count: 1 });
  };

  const contentRules: Rule[] = [];
  const messageRules: Rule[] = [];
  for (let r = 0; r < rules.length; r += 1) {
    const rule = rules[r]!;
    if (!isEnabled(rule, options)) {
      skipped.push({ ruleId: rule.id, reason: 'disabled' });
      continue;
    }
    (rule.kind === 'content' ? contentRules : messageRules).push(rule);
  }

  // --- Content phase -------------------------------------------------------
  /**
   * Content changes, keyed by message index.
   *
   * `undefined` until a rule actually changes something, which is what makes a
   * clean history free: no map, no projected list, no copied message.
   */
  let contentOverrides: Map<number, readonly unknown[]> | undefined;

  /**
   * One reused context for the whole phase. `phase` never changes; the
   * coordinates are rewritten before each call. A content rule reads the block
   * it is handed and, at most, the phase.
   */
  const contentCtx = { phase: 'content' as const, messageIndex: 0, blockIndex: 0 };

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;
    const role = roleOf(message);

    // Record a skip for every content rule this message is out of scope for, and
    // note whether any rule applies at all. No array is built: the rules are
    // re-walked per block below, and a content rule set is tiny by construction.
    let anyApplicable = false;
    for (let r = 0; r < contentRules.length; r += 1) {
      const rule = contentRules[r]!;
      if (roleAllowed(rule, role)) anyApplicable = true;
      else noteRoleSkip(rule.id, role);
    }
    if (!anyApplicable) continue;

    let next: unknown[] | undefined;
    const content = message.content;
    for (let blockIndex = 0; blockIndex < content.length; blockIndex += 1) {
      const block = content[blockIndex];
      contentCtx.messageIndex = index;
      contentCtx.blockIndex = blockIndex;

      // Created only when a rule actually reports, so a clean block allocates
      // nothing at all.
      let decisions: DecidedRepair[] | undefined;
      let dropped = false;
      for (let r = 0; r < contentRules.length; r += 1) {
        const rule = contentRules[r]!;
        if (!roleAllowed(rule, role)) continue;
        // Once a rule has decided to drop this block, later rules are not
        // consulted: the block is gone, so their findings would describe a
        // message that no longer exists.
        if (dropped) break;
        const reported = asFindings(rule.detect(block, contentCtx));
        for (let f = 0; f < reported.length; f += 1) {
          const raw = reported[f]!;
          // The engine owns the coordinates; a rule supplies only the reason.
          const finding: Finding = {
            ruleId: rule.id,
            reason: raw.reason,
            messageIndex: index,
            blockIndex,
            ...(raw.detail === undefined ? {} : { detail: raw.detail }),
          };
          findings.push(finding);
          if (!repair) continue;
          const decision = rule.repair(finding, { phase: 'content', messages });
          (decisions ??= []).push({ ruleId: rule.id, reason: finding.reason, decision });
          if (decision.action === 'drop') dropped = true;
        }
      }
      if (!repair) continue;
      // No rule reported on this block: nothing to fold, nothing to allocate.
      if (decisions === undefined) {
        next?.push(block);
        continue;
      }

      const outcome = foldDecisions(decisions);
      if (outcome.dropped) {
        const winner = decisions!.find((entry) => entry.decision.action === 'drop');
        if (winner !== undefined) {
          applied.push({
            ruleId: winner.ruleId,
            reason: winner.reason,
            messageIndex: index,
            blockIndex,
            action: 'drop',
          });
        }
        next ??= message.content.slice(0, blockIndex);
        continue;
      }
      if (outcome.source !== undefined) {
        // `source` is set only when a replace decision was folded in, so it is
        // the reliable indicator. Testing `replacement !== undefined` instead
        // would silently ignore a rule that legitimately replaces a block with
        // `undefined` — reporting the finding while applying nothing.
        next ??= message.content.slice(0, blockIndex);
        next.push(outcome.replacement);
        applied.push({
          ruleId: outcome.source.ruleId,
          reason: outcome.source.reason,
          messageIndex: index,
          blockIndex,
          action: 'replace',
        });
        continue;
      }
      next?.push(block);
    }

    if (next !== undefined) (contentOverrides ??= new Map()).set(index, next);
  }

  /**
   * The post-content-phase list.
   *
   * Returns the **input array** when the content phase changed nothing, which is
   * the common case and the reason a clean pass copies no list.
   */
  const projectContent = (): readonly MessageLike[] => {
    const overrides = contentOverrides;
    if (overrides === undefined) return messages;
    return messages.map((message, index) => {
      const content = overrides.get(index);
      return content === undefined ? message : { ...message, content };
    });
  };

  // --- Message phase -------------------------------------------------------
  let droppedIndexes: Set<number> | undefined;
  let replacedMessages: Map<number, unknown> | undefined;
  /** The post-content-phase list, built once and only if a rule needs it. */
  let base: readonly MessageLike[] | undefined;

  /**
   * One reused context per pass. Only `index` and `survivingToolCallIds` change
   * between calls; `messages` is fixed for the rule.
   */
  const messageCtx = {
    phase: 'message' as const,
    index: 0,
    messages: messages as readonly MessageLike[],
    survivingToolCallIds: new Set<string>(),
  };

  for (let r = 0; r < messageRules.length; r += 1) {
    const rule = messageRules[r]!;
    const list = (base ??= projectContent());

    // The surviving list is the whole list until something is dropped; only then
    // is a filtered copy worth building.
    const dropped = droppedIndexes;
    const surviving = dropped === undefined ? list : list.filter((_, index) => !dropped.has(index));

    messageCtx.messages = surviving;
    messageCtx.survivingToolCallIds = collectToolCallIds(surviving);

    // Iterate the full list and skip dropped positions, so every message keeps
    // its original index without an `indexOf` scan.
    for (let position = 0; position < list.length; position += 1) {
      const message = list[position]!;
      if (droppedIndexes?.has(position) === true) continue;
      if (!roleAllowed(rule, message.role)) {
        noteRoleSkip(rule.id, message.role);
        continue;
      }
      messageCtx.index = position;
      const reported = asFindings(rule.detect(message, messageCtx));
      for (let f = 0; f < reported.length; f += 1) {
        const raw = reported[f]!;
        const finding: Finding = {
          ruleId: rule.id,
          reason: raw.reason,
          messageIndex: position,
          ...(raw.blockIndex === undefined ? {} : { blockIndex: raw.blockIndex }),
          ...(raw.detail === undefined ? {} : { detail: raw.detail }),
        };
        findings.push(finding);
        if (!repair) continue;
        const decision = rule.repair(finding, { phase: 'message', messages });
        if (decision.action === 'keep') continue;
        // A message rule may replace the whole message or drop it. Treating
        // anything that is not `keep` as a drop would silently discard a message
        // the rule asked to rewrite — data loss, and the worst possible
        // misreading of an explicit instruction.
        if (decision.action === 'replace') {
          (replacedMessages ??= new Map()).set(position, decision.value);
          applied.push({
            ruleId: rule.id,
            reason: finding.reason,
            messageIndex: position,
            ...(finding.blockIndex === undefined ? {} : { blockIndex: finding.blockIndex }),
            action: 'replace',
          });
          continue;
        }
        (droppedIndexes ??= new Set()).add(position);
        applied.push({
          ruleId: rule.id,
          reason: finding.reason,
          messageIndex: position,
          ...(finding.blockIndex === undefined ? {} : { blockIndex: finding.blockIndex }),
          action: 'drop',
        });
      }
    }
  }

  for (let i = 0; i < roleSkips.length; i += 1) {
    const entry = roleSkips[i]!;
    skipped.push({ ruleId: entry.ruleId, reason: 'role', role: entry.role, count: entry.count });
  }

  if (!repair || applied.length === 0) {
    return { findings, applied, skipped, messages: undefined };
  }

  const projected: MessageLike[] = [];
  // `base` is only assigned when a message rule ran. With no message rules the
  // content phase's edits still have to reach the output, so fall back to
  // `projectContent()` — which returns the input array unchanged when there were
  // no edits at all.
  const finalList = base ?? projectContent();
  for (let index = 0; index < finalList.length; index += 1) {
    const message = finalList[index]!;
    if (droppedIndexes?.has(index) === true) continue;
    const replacement = replacedMessages?.get(index);
    if (replacedMessages?.has(index) === true) {
      // A whole-message replacement supersedes any content-phase edit to it.
      projected.push(replacement as MessageLike);
      continue;
    }
    projected.push(message);
  }
  return { findings, applied, skipped, messages: projected };
}

/** The public healer surface. */
export interface Healer {
  /** Detection only. Never calls `repair`, never builds a message list. */
  check(messages: readonly MessageLike[]): readonly Finding[];
  /** Detection plus repair. Returns the input reference when nothing changed. */
  heal(messages: readonly MessageLike[]): HealReport;
  /** The registered rules, in registration order. */
  readonly rules: readonly Rule[];
}

/**
 * Build a healer over a fixed rule set.
 *
 * The engine never inspects a rule beyond the {@link Rule} contract, so adding,
 * removing or reordering rules requires no engine change.
 */
export function createHealer(rules: readonly Rule[], options?: HealerOptions): Healer {
  const frozenRules = [...rules];
  return {
    rules: frozenRules,
    check(messages) {
      // Fail safe, not loud. This runs inside the outbound path of every model
      // call, so a malformed list must be passed through untouched rather than
      // made into an exception the plugin caused. A request with no message
      // array is already broken; it is not this plugin's job to break it
      // differently, and a confusing stack trace here would be blamed on the
      // repair rather than on the caller.
      if (!Array.isArray(messages)) return [];
      return runPass(frozenRules, messages, options, false).findings;
    },
    heal(messages) {
      if (!Array.isArray(messages)) {
        return { messages, findings: [], applied: [], skipped: [] };
      }
      const result = runPass(frozenRules, messages, options, true);
      return {
        // Identity preservation is engine policy: reuse the input reference
        // whenever nothing was applied.
        messages: result.messages ?? messages,
        findings: result.findings,
        applied: result.applied,
        skipped: result.skipped,
      };
    },
  };
}
