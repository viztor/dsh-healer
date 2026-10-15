/**
 * The plugin's settings schema.
 *
 * Every rule is individually toggleable, and the toggle set is validated: a
 * configuration that names a rule which does not exist is a startup error, not a
 * silent no-op. That matters because the failure mode of a typo here is a
 * protection the operator believes is on but which is not.
 *
 * The schema is plain data plus a small validator, so the plugin carries no
 * runtime dependency on a schema library and the rules stay testable alone.
 *
 * @module dsh-healer/config
 */

import { createRequire } from 'node:module';
import { delimiter } from 'node:path';
import { isRecord } from './narrow.ts';
import type { HealerOptions, RuleConfig } from './types.ts';

// Minimal Schemastery interface
interface SchemasteryLike {
  object(dict: Record<string, unknown>): SchemasteryLike;
  union(choices: readonly unknown[]): SchemasteryLike;
  const(val: unknown): SchemasteryLike;
  string(): SchemasteryLike;
  boolean(): SchemasteryLike;
  default(val: unknown): SchemasteryLike;
  description(text: string): SchemasteryLike;
  volatile(): SchemasteryLike;
}

/**
 * Load `@deepseek-ai/schemastery`, or `null` when it is not installed.
 *
 * Schemastery is deliberately **not** a dependency: the formal Config schema is
 * an enhancement, and a host without it still runs — just without a settings
 * projection. Two roots are tried because the harness is loaded from a pnpm dlx
 * store where schemastery is a sibling of `dsh`, not of this plugin, so a
 * require rooted at this module finds nothing. The `NODE_PATH` entries the host
 * exports are what actually reach it; measured, not assumed.
 */
function loadSchemastery(): SchemasteryLike | null {
  const roots = [
    import.meta.url,
    ...(process.env.NODE_PATH ?? '')
      .split(delimiter)
      .filter(Boolean)
      .map((entry) => `${entry}/dsh-healer.cjs`),
  ];
  for (const root of roots) {
    try {
      return createRequire(root)('@deepseek-ai/schemastery') as SchemasteryLike;
    } catch {
      // Try the next root; the last failure means "not installed here".
    }
  }
  return null;
}

const z = loadSchemastery();

/**
 * Formal Cordis Config schema.
 *
 * Exported so DSH config editor recognizes the plugin as configurable,
 * and sets `status: "schema"` in `Config.listConfigs`. Every field carries
 * `.volatile()` and `.description(...)` so DSH settings projects it.
 */
export const Config: unknown = z
  ? z.object({
      mode: z
        .union([z.const('fail-safe'), z.const('heal'), z.const('check'), z.const('off')])
        .default('fail-safe')
        .description(
          "Operating mode: 'fail-safe' (non-intrusive auto-retry on 400 error), 'heal' (proactive sanitization), 'check' (audit only), or 'off' (disabled).",
        )
        .volatile(),
      dropEmptyToolNames: z
        .boolean()
        .default(true)
        .description('Drop tool calls with an empty name string produced by assembler defects.')
        .volatile(),
      dropOrphanedResults: z
        .boolean()
        .default(true)
        .description('Drop orphaned tool results answering calls that were dropped.')
        .volatile(),
    })
  : undefined;

/** How the plugin behaves on each request. */
export type HealMode = 'off' | 'check' | 'heal' | 'fail-safe';

/** What to do with the findings a pass produced. */
export type FindingAction = 'silent' | 'log' | 'throw';

/** Resolved plugin configuration. */
export interface HealConfig {
  readonly mode: HealMode;
  readonly rules: Readonly<Record<string, RuleConfig>>;
  readonly onFindings: FindingAction;
  readonly strictRuleIds: boolean;
}

/** The defaults, which are also the documented behaviour. */
export const DEFAULT_CONFIG: HealConfig = {
  mode: 'fail-safe',
  rules: {},
  onFindings: 'log',
  strictRuleIds: true,
};

const MODES: readonly HealMode[] = ['off', 'check', 'heal', 'fail-safe'];
const ACTIONS: readonly FindingAction[] = ['silent', 'log', 'throw'];

function isHealMode(value: unknown): value is HealMode {
  return typeof value === 'string' && (MODES as readonly string[]).includes(value);
}

function isFindingAction(value: unknown): value is FindingAction {
  return typeof value === 'string' && (ACTIONS as readonly string[]).includes(value);
}

/** Raised for a configuration the plugin refuses to run with. */
export class ConfigError extends Error {
  readonly code = 'INVALID_CONFIG';
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

function unwrapVolatile<T>(value: T): unknown {
  if (
    typeof value === 'object' &&
    value !== null &&
    'get' in value &&
    typeof (value as { get: unknown }).get === 'function'
  ) {
    return (value as { get(): unknown }).get();
  }
  return value;
}

/**
 * Validate and normalise raw settings.
 *
 * Unknown top-level keys and malformed rule entries are rejected rather than
 * ignored, so a mistake surfaces at startup with a precise message.
 */
export function resolveConfig(raw: unknown): HealConfig {
  if (raw === undefined || raw === null) return DEFAULT_CONFIG;
  if (!isRecord(raw)) {
    throw new ConfigError(`dsh-healer: config must be an object, got ${typeof raw}`);
  }

  const rawMode = unwrapVolatile(raw.mode);
  const mode = (rawMode ?? DEFAULT_CONFIG.mode) as HealMode;
  if (!isHealMode(mode)) {
    throw new ConfigError(
      `dsh-healer: config.mode must be one of ${MODES.join(', ')}; got ${JSON.stringify(rawMode)}`,
    );
  }

  const rawOnFindings = unwrapVolatile(raw.onFindings);
  const onFindings = (rawOnFindings ?? DEFAULT_CONFIG.onFindings) as FindingAction;
  if (!isFindingAction(onFindings)) {
    throw new ConfigError(
      `dsh-healer: config.onFindings must be one of ${ACTIONS.join(', ')}; got ${JSON.stringify(rawOnFindings)}`,
    );
  }

  const rawStrict = unwrapVolatile(raw.strictRuleIds);
  const strictRuleIds = (rawStrict ?? DEFAULT_CONFIG.strictRuleIds) as boolean;
  if (typeof strictRuleIds !== 'boolean') {
    throw new ConfigError('dsh-healer: config.strictRuleIds must be a boolean');
  }

  const rules: Record<string, RuleConfig> = {};
  const rawRules = unwrapVolatile(raw.rules) ?? {};
  if (!isRecord(rawRules)) {
    throw new ConfigError('dsh-healer: config.rules must be an object keyed by rule id');
  }
  for (const [ruleId, rawValue] of Object.entries(rawRules)) {
    const value = unwrapVolatile(rawValue);
    if (!isRecord(value)) {
      throw new ConfigError(`dsh-healer: config.rules["${ruleId}"] must be an object`);
    }
    const enabled = unwrapVolatile(value.enabled);
    if (typeof enabled !== 'boolean') {
      throw new ConfigError(`dsh-healer: config.rules["${ruleId}"].enabled must be a boolean`);
    }
    const known = Object.keys(value).filter((key) => key !== 'enabled' && key !== 'options');
    if (known.length > 0) {
      throw new ConfigError(
        `dsh-healer: config.rules["${ruleId}"] has unknown key(s): ${known.join(', ')}`,
      );
    }
    rules[ruleId] = {
      enabled,
      ...(value.options === undefined ? {} : { options: unwrapVolatile(value.options) }),
    };
  }

  return { mode, rules, onFindings, strictRuleIds };
}

/** The engine options implied by a resolved config. */
export function healerOptions(config: HealConfig): HealerOptions {
  return { rules: config.rules };
}
