/**
 * The cordis plugin: `dsh-healer`.
 *
 * Wires the healer, the rule set, the settings, and the prototype patch into the
 * host. The heavy lifting lives in `engine.ts` (rules and invariants) and
 * `patch.ts` (the seam); this module owns policy: what to install, what to
 * report, and what to refuse.
 *
 * @module dsh-healer
 */

import { Config, ConfigError, healerOptions, resolveConfig } from './config.ts';
import type { HealConfig, HealMode } from './config.ts';
import { registerHealCommand, repairSessionSurface } from './command.ts';
import type { CommandController, CommandsRegistryLike } from './command.ts';
import { createHealer, unknownRuleIds } from './engine.ts';
import type { Healer } from './engine.ts';
import { createMarkerPort } from './markers.ts';
import { assertSeamIdentity, install, isRecoverableError } from './patch.ts';
import type { MarkerPort, PatchHandle, PatchTarget } from './patch.ts';
import { DEFAULT_RULES } from './rules/index.ts';
import type { HealableSession, MessageLike, Rule } from './types.ts';

/** Cordis plugin name used by loader diagnostics. */
export const name = 'dsh-healer';

/** The service this plugin needs before it can install its patch. */
export const inject = ['llm'];

/** Formal Cordis Config schema exported for DSH settings editor. */
export { Config };

/**
 * A disposer in the shape cordis expects.
 *
 * Cordis treats a plugin's return value as an effect: a **function** is called
 * to tear the plugin down, while a bare object is rejected with
 * `TypeError: Invalid effect`. It is callable *and* carries `dispose()` so both
 * idioms work.
 */
export interface Disposer {
  (): void;
  dispose(): void;
}

/** Wrap a patch handle as a cordis-shaped disposer. */
function toDisposer(handle: PatchHandle): Disposer {
  const disposer = (() => handle.dispose()) as Disposer;
  disposer.dispose = () => handle.dispose();
  return disposer;
}

/** A minimal logger surface, matching what a cordis context provides. */
export interface LoggerLike {
  info(message: string): void;
  warn(message: string): void;
}

/**
 * The `agent/request-error` payload this plugin reads.
 *
 * A structural subset on purpose: the waterfall also passes `turn`, `step`,
 * `provider` and `retryPolicy`, none of which this hook needs. Declaring only
 * what it reads keeps the hook independent of the harness's event type.
 */
interface RequestErrorPayload {
  readonly agent?: { readonly session?: HealableSession };
  readonly failure?: unknown;
  readonly signal?: { readonly aborted?: boolean };
}

/** Everything `applyWith` needs, so it can be driven without the real harness. */
export interface Deps {
  /** Marker port. Loaded from the harness when omitted. */
  readonly markers?: MarkerPort;
  /** The prototype to patch. Resolved from the harness when omitted. */
  readonly runtimePrototype?: PatchTarget;
  /** Diagnostics sink. Silent when omitted. */
  readonly logger?: LoggerLike;
}

/**
 * Used when the host supplies no logger.
 *
 * Deliberately silent: a library module must not assume `console` exists, and
 * findings are already surfaced through the `onFindings` policy. A host that
 * wants the lines passes its own logger.
 */
const silentLogger: LoggerLike = {
  info: () => {},
  warn: () => {},
};

/**
 * Resolve the `LlmRuntime` prototype from the harness.
 *
 * When the live service is present, its prototype chain holds the exact
 * `LlmRuntime` class running in the host. Otherwise, delegates to
 * `resolve-harness`.
 */
async function resolveRuntimePrototype(service?: unknown): Promise<PatchTarget> {
  if (service !== undefined && typeof service === 'object' && service !== null) {
    let current: object | null = Object.getPrototypeOf(service) as object | null;
    while (current !== null && current !== Object.prototype) {
      if (typeof (current as PatchTarget).streamWithRegistration === 'function') {
        return current as PatchTarget;
      }
      current = Object.getPrototypeOf(current) as object | null;
    }
  }

  const { loadLlmModule } = await import('./resolve-harness.ts');
  const loaded = await loadLlmModule();
  const runtime = (loaded.LlmRuntime ?? loaded.default) as { prototype?: PatchTarget } | undefined;
  if (runtime === undefined || runtime.prototype === undefined) {
    throw new Error(
      'dsh-healer: the resolved @deepseek-ai/dsh-llm does not export LlmRuntime (named or default). ' +
        'The DSH version may have changed; refusing to install a patch that would silently no-op.',
    );
  }
  return runtime.prototype;
}

/** Apply one pass's findings to the configured sink. */
function report(
  findings: readonly {
    ruleId: string;
    reason: string;
    messageIndex: number;
    blockIndex?: number;
  }[],
  config: HealConfig,
  logger: LoggerLike,
): void {
  if (findings.length === 0) return;
  if (config.onFindings === 'throw') {
    const detail = findings
      .map(
        (finding) =>
          `${finding.ruleId} at message ${finding.messageIndex}` +
          (finding.blockIndex === undefined ? '' : ` block ${finding.blockIndex}`) +
          `: ${finding.reason}`,
      )
      .join('; ');
    throw new Error(`dsh-healer: ${findings.length} malformed block(s) detected (${detail})`);
  }
  if (config.onFindings === 'log') {
    for (const finding of findings) {
      logger.warn(
        `dsh-healer: ${finding.ruleId} message ${finding.messageIndex}` +
          (finding.blockIndex === undefined ? '' : ` block ${finding.blockIndex}`) +
          `: ${finding.reason}`,
      );
    }
  }
}

/**
 * Install the healer with explicitly supplied dependencies.
 *
 * Separated from `apply` so the whole plugin can be exercised with a fake
 * prototype and marker port, and so the seam-identity assertion is testable
 * without a second copy of the harness.
 */
export async function applyWith(
  rawConfig: unknown,
  deps: Deps,
  rules: readonly Rule[] = DEFAULT_RULES,
): Promise<PatchHandle> {
  const logger = deps.logger ?? silentLogger;
  const config = resolveConfig(rawConfig);

  // Configuration is validated against the registered rules before anything is
  // installed: a typo must fail here, not silently disable a protection.
  if (config.strictRuleIds) {
    const unknown = unknownRuleIds(rules, healerOptions(config));
    if (unknown.length > 0) {
      throw new ConfigError(
        `dsh-healer: config.rules names unknown rule id(s): ${unknown.join(', ')}. ` +
          `Known rules: ${rules.map((rule) => rule.id).join(', ')}`,
      );
    }
  }

  let currentMode: HealMode = config.mode;

  if (currentMode === 'off') {
    logger.info('dsh-healer: mode "off" — no patch installed');
    // Carries `mode` like every other handle, so a caller can tell "nothing was
    // installed" from "something was installed in some other mode".
    return {
      get mode() {
        return currentMode;
      },
      setMode(m: string) {
        currentMode = m as HealMode;
      },
      dispose() {},
    };
  }

  const markers = deps.markers ?? (await createMarkerPort());
  const target = deps.runtimePrototype ?? (await resolveRuntimePrototype());

  const healer: Healer = createHealer(rules, healerOptions(config));

  const handle = install(
    target,
    (messages: readonly MessageLike[]) => {
      if (currentMode === 'check') {
        // Detection only: report, and hand back the identical list so the
        // outbound request is byte-identical to the unhealed one.
        report(healer.check(messages), config, logger);
        return { messages };
      }
      const result = healer.heal(messages);
      report(result.findings, config, logger);
      return { messages: result.messages };
    },
    markers,
    () => currentMode,
  );

  logger.info(
    `dsh-healer: installed (mode=${config.mode}, rules=${
      rules
        .filter((rule) => config.rules[rule.id]?.enabled ?? rule.enabledByDefault)
        .map((rule) => rule.id)
        .join(', ') || 'none'
    })`,
  );
  return handle;
}

/**
 * Cordis entry point.
 *
 * `apply` installs the patch once and returns its disposer, so disabling the
 * plugin is a true revert rather than a permanent behavioural change.
 */
export async function apply(ctx: unknown, rawConfig?: unknown): Promise<Disposer> {
  const context = ctx as {
    get?: (name: string) => unknown;
    logger?: LoggerLike;
    effect?: (execute: () => Generator<unknown, void, void>, label?: string) => () => void;
  };
  const service = context.get?.('llm');

  // Resolve the prototype once and hand it to `applyWith`. If the live service
  // is provided, we derive its prototype directly so we target the exact
  // running class.
  const runtimePrototype = await resolveRuntimePrototype(service);

  // Check identity **before** installing. The patch is only useful if the live
  // service inherits from the prototype we resolved; a duplicated dsh-llm copy
  // would make it a no-op. Checking first means a rejected load leaves the seam
  // untouched rather than installing and then failing.
  if (service !== undefined) {
    assertSeamIdentity(service, runtimePrototype);
  }

  const logger = context.logger ?? silentLogger;
  const resolvedConfig = resolveConfig(rawConfig);

  // `applyWith` is async, so the handle cannot be created inside a synchronous
  // generator: await it first, then register the teardown.
  const handle = await applyWith(rawConfig, {
    runtimePrototype,
    logger,
  });

  // Provide user-facing `/heal` slash command when the commands service is composed.
  const controller: CommandController = {
    getMode: () => handle.mode as HealMode,
    setMode: (m) => {
      handle.setMode?.(m);
      logger.info(`dsh-healer: mode changed to "${m}" via /heal command`);
    },
    activeRules: () =>
      DEFAULT_RULES.filter(
        (rule) => resolvedConfig.rules[rule.id]?.enabled ?? rule.enabledByDefault,
      ).map((rule) => rule.id),
  };

  let unregisterCommand: (() => void) | void;
  const tryRegister = (registry: unknown) => {
    if (registry && typeof (registry as { register?: unknown }).register === 'function') {
      unregisterCommand =
        registerHealCommand(registry as CommandsRegistryLike, controller) ?? undefined;
    }
  };

  const directCommands = context.get?.('commands');
  if (directCommands) {
    tryRegister(directCommands);
  } else if (typeof (context as { inject?: unknown }).inject === 'function') {
    (context as { inject: (deps: string[], cb: (c: unknown) => void) => void }).inject(
      ['commands'],
      (commandCtx: unknown) => {
        const cmdService =
          (commandCtx as { commands?: unknown; get?: (k: string) => unknown }).commands ??
          (commandCtx as { get?: (k: string) => unknown }).get?.('commands');
        tryRegister(cmdService);
      },
    );
  }

  // The native post-failure hook.
  //
  // `dsh-agent-loop` dispatches `agent/request-error` when a model request fails,
  // and retries the step when a listener returns `{ kind: 'retry' }`. That is the
  // whole recovery path: repair the session's projected messages in memory, then
  // let the loop re-derive the request. The durable log is never rewritten, so
  // sequence numbers and the GUI projection cache stay in sync.
  let unregisterErrorHook: (() => void) | void;
  if (typeof (context as { on?: unknown }).on === 'function') {
    const errorListener = (context as { on: (event: string, cb: unknown) => () => void }).on(
      'agent/request-error',
      async ({ agent, failure, signal }: RequestErrorPayload, next: () => Promise<unknown>) => {
        if (signal?.aborted) return next();
        if (controller.getMode() === 'off') return next();
        if (!isRecoverableError(failure)) return next();

        const session = agent?.session;
        if (session === undefined) return next();

        const repaired = repairSessionSurface(session);
        if (repaired === 0) return next();

        logger.info(
          `dsh-healer: post-failure hook repaired ${repaired} defective message(s) in memory; retrying`,
        );
        return { kind: 'retry' };
      },
    );
    unregisterErrorHook = errorListener;
  }

  const patchDisposer = toDisposer(handle);
  const combinedDisposer = (() => {
    patchDisposer();
    if (typeof unregisterCommand === 'function') unregisterCommand();
    if (typeof unregisterErrorHook === 'function') unregisterErrorHook();
  }) as Disposer;
  combinedDisposer.dispose = () => combinedDisposer();
  return combinedDisposer;
}
