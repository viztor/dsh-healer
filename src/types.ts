/**
 * Pure value types for the healer: the rule contract, detection findings, and
 * the report a heal returns.
 *
 * Nothing in this file imports a runtime value. It is types only, so the engine
 * and every rule stay free of any DSH or cordis dependency and remain testable
 * as plain functions.
 *
 * @module dsh-healer/types
 */

/** A role that may appear on a message. Kept open for forward compatibility. */
export type MessageRole = 'system' | 'developer' | 'user' | 'assistant' | 'tool';

/**
 * The minimal structural view of a message the healer needs.
 *
 * Deliberately structural rather than an import of the harness `Message` union:
 * a real harness message satisfies this shape, so no dependency is required, and
 * the engine cannot be coupled to a vocabulary that may gain members.
 *
 * `content` is `readonly unknown[]` because a content rule must survive a block
 * type it was not written against and narrow defensively.
 */
export interface MessageLike {
  readonly role: MessageRole;
  readonly content: readonly unknown[];
  /** Present on tool-role messages; correlates a result with its call. */
  readonly toolCallId?: string;
  readonly [key: string]: unknown;
}

/** The phase a rule runs in. Content rules run first, then message rules. */
export type RulePhase = 'content' | 'message';

/** One observed defect. Pure data; it carries no fix. */
export interface Finding {
  readonly ruleId: string;
  readonly reason: string;
  /** Index into the list `detect` was given. */
  readonly messageIndex: number;
  /** Index into the message's content array, for a content finding. */
  readonly blockIndex?: number;
  /** Rule-owned payload, opaque to the engine. `repair` receives it verbatim. */
  readonly detail?: unknown;
}

/**
 * What a **content** rule is told about the call it is in.
 *
 * The rule is handed the block itself as its target; this context carries where
 * that block sits. The object is **reused** across calls within a pass — read it,
 * do not retain it. That reuse is what keeps the clean path allocation-free: a
 * rule receives the block that already exists rather than a freshly built
 * wrapper around it.
 */
export interface ContentDetectContext {
  readonly phase: 'content';
  readonly messageIndex: number;
  readonly blockIndex: number;
}

/**
 * What a **message** rule is told about the call it is in.
 *
 * The rule is handed the message itself as its target, so reading `.content` or
 * `.toolCallId` costs nothing. This context carries the position, the whole
 * surviving list — a message rule needs it, because "does this tool result still
 * have a matching call?" cannot be answered from one message — and the ids that
 * survived the content phase.
 *
 * Reused across calls within a rule pass — read it, do not retain it.
 */
export interface MessageDetectContext {
  readonly phase: 'message';
  /** Index into the list the pass was given. */
  readonly index: number;
  /** Every surviving message, post content phase. The input array when unchanged. */
  readonly messages: readonly MessageLike[];
  /** Ids of tool calls that survived the content phase. */
  readonly survivingToolCallIds: ReadonlySet<string>;
}

/** Any context the engine may hand a rule. Discriminated by `phase`. */
export type DetectContext = ContentDetectContext | MessageDetectContext;

/**
 * What `repair` is told.
 *
 * `phase` says which kind of decision is being made; `messages` is the exact list
 * `detect` ran against.
 */
export interface RepairContext {
  readonly phase: RulePhase;
  readonly messages: readonly MessageLike[];
}

/** The outcome a rule's `repair` asks the engine to apply. */
export type RepairDecision =
  | { readonly action: 'keep' }
  | { readonly action: 'drop' }
  | { readonly action: 'replace'; readonly value: unknown };

/**
 * A repair rule: two pure functions, never a mutation.
 *
 * `detect` observes and reports; `repair` says what to do about a finding. The
 * engine drives both, owns phase ordering, role scoping, application and
 * accounting, and enforces the invariants. A rule never mutates its input,
 * never performs I/O, never logs, and never throws for expected input.
 */
export interface Rule {
  /** Stable identity, used by config, findings and reports. */
  readonly id: string;
  /** Content rules judge one block; message rules judge the whole list. */
  readonly kind: RulePhase;
  /** Whether the rule runs when the configuration says nothing about it. */
  readonly enabledByDefault: boolean;
  /** One line for the settings UI and for diagnostics. */
  readonly description: string;
  /**
   * Roles this rule may inspect. The engine skips any message outside this set
   * before calling `detect`, and reports the skip. `undefined` means every role.
   */
  readonly roles?: readonly MessageRole[];
  /**
   * A content rule is handed one **block**; a message rule is handed one
   * **message**. The context carries the coordinates and, for a message rule,
   * the surviving list.
   *
   * The context object is reused across calls within a pass, and the target is
   * whatever already exists — an existing block, or an existing message. That is
   * deliberate: the engine allocates nothing per message on a clean history.
   * Read the context; do not retain it.
   */
  detect(target: unknown, ctx: DetectContext): Finding | readonly Finding[] | undefined;
  repair(finding: Finding, ctx: RepairContext): RepairDecision;
}

/**
 * Why the engine declined to run a rule, aggregated.
 *
 * A role skip is reported **once per rule per role**, with a count — not once
 * per message. On the real 2 342-message incident history the per-message form
 * produced **2 498 entries** to say "these two rules never applied here": a
 * diagnostics flood, and an allocation that dominated the pass. Aggregated, the
 * same information is four entries.
 */
export interface SkippedRule {
  readonly ruleId: string;
  readonly reason: 'disabled' | 'role';
  /** Present when `reason` is `'role'`: the role the rule could not judge. */
  readonly role?: MessageRole;
  /** Present when `reason` is `'role'`: how many messages carried that role. */
  readonly count?: number;
}

/** One fix the engine actually applied. */
export interface AppliedFix {
  readonly ruleId: string;
  readonly reason: string;
  readonly messageIndex: number;
  readonly blockIndex?: number;
  readonly action: 'drop' | 'replace';
}

/** The result of a heal. `messages` is the input reference when nothing changed. */
export interface HealReport {
  readonly messages: readonly MessageLike[];
  /** Every detection from an enabled rule, in phase order. */
  readonly findings: readonly Finding[];
  /** What `repair` actually changed. */
  readonly applied: readonly AppliedFix[];
  /** Rules the engine declined to run, and why. */
  readonly skipped: readonly SkippedRule[];
}

/** Per-rule configuration, as accepted from the plugin settings. */
export interface RuleConfig {
  readonly enabled: boolean;
  /** Rule-owned options. The engine never reads this. */
  readonly options?: unknown;
}

/** Resolved engine options. */
export interface HealerOptions {
  /** Overrides keyed by rule id. An absent id falls back to `enabledByDefault`. */
  readonly rules?: Readonly<Record<string, RuleConfig>>;
}

/**
 * The live DSH session surface this plugin repairs.
 *
 * Structural rather than an import of the harness `Session` class, for the same
 * reason `MessageLike` is: the plugin must not depend on a vocabulary that may
 * gain members, and a test can satisfy this shape with a plain object.
 *
 * `surfaceManager._state.projectedMessages` is the store the harness folds into
 * `deriveMessages()`. Writing a clean message there repairs what the model sees
 * without touching the append-only durable log — which is what keeps the session
 * file, its sequence numbers and the GUI projection cache in sync.
 *
 * `_state` is private to the harness, so every field is optional and every write
 * is guarded; a harness that renames it degrades to "no repair" rather than to a
 * crash.
 */
export interface HealableSession {
  readonly seq?: number;
  eventAt?(seq: number): unknown;
  readonly surface?: { readonly nodes?: readonly number[] };
  readonly surfaceManager?: {
    readonly _state?: {
      readonly projectedMessages?: Map<number, unknown>;
      contentGeneration?: number;
    };
  };
  deriveMessages?(): MessageLike[];
}
