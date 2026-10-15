/**
 * The seam patch: repair `options.messages` at the last point before the runtime
 * builds its wire payload.
 *
 * Three properties this file exists to protect, each of which has a test:
 *
 *   1. **Pass-through.** The wrapper returns whatever the original returns,
 *      unchanged. It never wraps, buffers, re-emits or reorders the chunk
 *      stream, and it adds no `await` before dispatch.
 *   2. **Identity on the clean path.** When the healer changes nothing, the
 *      *input object* is forwarded — no spread, no allocation.
 *   3. **Marker preservation.** `markAgentLoopRequest` keys a process-local
 *      WeakSet by object identity, so a replacement object silently loses it.
 *      Losing it disables `dsh-session-title`'s main-request path and
 *      fail-opens `dsh-agent-loop`'s request invariant. A repaired request must
 *      therefore be re-marked.
 *
 * This seam only ever repairs **proactively** (`heal`, `check`). Reactive
 * recovery lives in `index.ts`, on the harness's own `agent/request-error`
 * waterfall, because a repair applied here would be per-request: it would hide
 * the failure from the agent loop and leave the durable history poisoned. See
 * `wrapStreamWithRegistration` for the failure that taught this.
 *
 * @module dsh-healer/patch
 */

import type { MessageLike } from './types.ts';

/** The shape of one request as it reaches the seam. */
export interface StreamOptions {
  readonly messages: readonly MessageLike[];
  readonly [key: string]: unknown;
}

/** The method being wrapped. `prepared` is opaque to this module. */
export type StreamWithRegistration = (
  this: unknown,
  options: StreamOptions,
  prepared?: unknown,
) => unknown;

/** A healer, narrowed to what the patch needs. */
export interface HealMessages {
  (messages: readonly MessageLike[]): {
    readonly messages: readonly MessageLike[];
  };
}

/**
 * The two identity-keyed operations the wrapper needs from the runtime.
 *
 * Injected rather than imported so the wrapper is testable as a pure function,
 * with no dependency on the harness being installed.
 */
export interface MarkerPort {
  /** Whether this exact object was assembled by the agent loop. */
  isMarked(request: unknown): boolean;
  /** Record this exact object as assembled by the agent loop. */
  mark<T>(request: T): T;
}

/** Key under which the installed patch records itself on the prototype. */
export const PATCH_MARKER = Symbol.for('dsh-healer.patched');

/** Raised when the seam is absent or is not the one we resolved. */
export class SeamError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'SeamError';
    this.code = code;
  }
}

/** Determine whether a thrown error or failure payload indicates a provider invalid-request rejection. */
export function isRecoverableError(err: unknown): boolean {
  if (err === null || err === undefined) return false;
  if (typeof err === 'object') {
    const errorObj = err as Record<string, unknown>;
    if (errorObj.status === 400 || errorObj.statusCode === 400) return true;
    const code = String(errorObj.code ?? errorObj.name ?? '');
    if (
      code === 'INVALID_ARGUMENT' ||
      code === 'BAD_REQUEST' ||
      code === 'INVALID_REQUEST' ||
      code === '400'
    ) {
      return true;
    }
  }
  const str = typeof err === 'string' ? err : JSON.stringify(err);
  return (
    str.includes('400') ||
    str.includes('INVALID_ARGUMENT') ||
    str.includes('invalid_request_error') ||
    str.includes('INVALID_REQUEST') ||
    str.includes('bad_request') ||
    str.includes('tool_call') ||
    str.includes('tool call') ||
    str.includes('invalid argument')
  );
}

/**
 * Build the wrapped method.
 *
 * The wrapper does **proactive** work only: `heal` rewrites the request before
 * dispatch, `check` reports without rewriting, and `off`/`fail-safe` pass the
 * request and the stream straight through.
 *
 * `fail-safe` deliberately does **not** intercept the stream. An earlier version
 * watched for a provider error chunk and healed-and-retried inside this method,
 * which hid the failure from `dsh-agent-loop` — so the `agent/request-error`
 * hook that repairs the *session* never ran. Every later request then paid a
 * failed round-trip plus a fresh heal, indefinitely, because the durable history
 * was still poisoned. Letting the error surface is what lets the hook fix the
 * cause rather than one symptom of it.
 */
export function wrapStreamWithRegistration(
  original: StreamWithRegistration,
  heal: HealMessages,
  markers: MarkerPort,
  mode: string | (() => string) = 'fail-safe',
): StreamWithRegistration {
  const getMode = typeof mode === 'function' ? mode : () => mode;

  return function streamWithRegistration(
    this: unknown,
    options: StreamOptions,
    prepared?: unknown,
  ): unknown {
    const currentMode = getMode();

    if (currentMode === 'check') {
      heal(options.messages);
      return original.call(this, options, prepared);
    }

    if (currentMode === 'heal') {
      const healed = heal(options.messages);
      if (healed.messages === options.messages) {
        return original.call(this, options, prepared);
      }
      const next: StreamOptions = { ...options, messages: healed.messages };
      if (markers.isMarked(options)) markers.mark(next);
      return original.call(this, next, prepared);
    }

    // 'off' and 'fail-safe': request and stream both untouched.
    return original.call(this, options, prepared);
  };
}

/**
 * The prototype surface `install` needs.
 *
 * Indexed by `PropertyKey` so the symbol-keyed install marker can be read and
 * cleared without a cast.
 */
export interface PatchTarget {
  [key: PropertyKey]: unknown;
  streamWithRegistration?: StreamWithRegistration;
}

/**
 * What `install` returns so the caller can restore the original method.
 *
 * `mode` records what the installed wrapper actually does. It exists because a
 * second install cannot change the behaviour of the first: the wrapper closes
 * over its healer, so a load with a different mode would otherwise silently keep
 * the earlier configuration.
 */
export interface PatchHandle {
  dispose(): void;
  readonly mode: string;
  setMode?(mode: string): void;
}

/**
 * Install the patch on a prototype, once.
 *
 * Throws rather than no-ops when the seam is missing: a silent no-op is the
 * worst failure mode here, because the plugin would appear healthy while every
 * poisoned request still fails.
 *
 * A second install with a **different** `mode` also throws. The wrapper closes
 * over its healer, so returning the existing handle would leave the new
 * configuration silently inert — an operator who changed `mode: check` to
 * `mode: heal` would see no change and no error. Refusing is the only outcome
 * that cannot mislead. Installing again with the *same* mode is still a no-op,
 * which is what makes a repeated `apply` idempotent.
 */
export function install(
  target: PatchTarget,
  heal: HealMessages,
  markers: MarkerPort,
  mode: string | (() => string) = 'fail-safe',
  seamName = 'streamWithRegistration',
): PatchHandle {
  let dynamicMode = typeof mode === 'function' ? mode() : mode;
  const getMode = typeof mode === 'function' ? mode : () => dynamicMode;

  const existing = target[PATCH_MARKER] as PatchHandle | undefined;
  if (existing !== undefined) {
    const requestedMode = getMode();
    if (existing.mode !== requestedMode) {
      throw new SeamError(
        `dsh-healer: the patch is already installed in mode "${existing.mode}", so a second ` +
          `install in mode "${requestedMode}" could not take effect. Dispose the existing install ` +
          'before changing mode.',
        'MODE_CONFLICT',
      );
    }
    return existing;
  }

  const original = target[seamName];
  if (typeof original !== 'function') {
    throw new SeamError(
      `dsh-healer: ${seamName} is not a function on the resolved LlmRuntime prototype; ` +
        'the DSH version may have changed. Refusing to install a patch that would silently no-op.',
      'SEAM_MISSING',
    );
  }

  const wrapped = wrapStreamWithRegistration(
    original as StreamWithRegistration,
    heal,
    markers,
    getMode,
  );
  // Preserve the seam's own name so diagnostics still read sensibly.
  Object.defineProperty(wrapped, 'name', { value: seamName, configurable: true });
  target[seamName] = wrapped;

  let disposed = false;
  const handle: PatchHandle = {
    get mode() {
      return getMode();
    },
    setMode(newMode: string) {
      dynamicMode = newMode;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      // Only restore if this handle still owns the seam. Without this guard a
      // stale handle — one whose patch was replaced by a later install — would
      // clobber the newer patch.
      if (target[seamName] === wrapped) {
        target[seamName] = original;
      }
      delete target[PATCH_MARKER];
    },
  };
  // Non-enumerable so a prototype enumeration does not advertise internals.
  Object.defineProperty(target, PATCH_MARKER, {
    value: handle,
    configurable: true,
    enumerable: false,
    writable: true,
  });
  return handle;
}

/**
 * Assert the live service really inherits from the prototype we patched.
 *
 * A duplicated copy of `@deepseek-ai/dsh-llm` would make `install` patch a class
 * the runtime never uses, which fails silently. This turns that packaging
 * accident into a loud startup error.
 */
export function assertSeamIdentity(service: unknown, prototype: object): void {
  let current: object | null = typeof service === 'object' && service !== null ? service : null;
  while (current !== null) {
    if (current === prototype) return;
    current = Object.getPrototypeOf(current) as object | null;
  }
  throw new SeamError(
    'dsh-healer: the live `llm` service does not inherit from the LlmRuntime prototype this ' +
      'plugin resolved, so the patch would target an unused class. This usually means two ' +
      'copies of @deepseek-ai/dsh-llm are installed. Refusing to install.',
    'SEAM_IDENTITY_MISMATCH',
  );
}
