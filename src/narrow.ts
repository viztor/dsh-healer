/**
 * Shape-narrowing helpers shared by rules and the engine.
 *
 * These live here, and not in `engine.ts`, so a rule can be genuinely
 * standalone: a rule's test must be able to import its rule without pulling in
 * the engine. This module depends on nothing.
 *
 * Everything here is defensive by contract. A rule must survive a harness
 * vocabulary it was not written against, so these never throw and never assume a
 * shape.
 *
 * @module dsh-healer/narrow
 */

/** True when a value is a plain (non-array, non-null) object. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Read a string field off an unknown value, or `undefined`. */
export function readString(source: unknown, key: string): string | undefined {
  if (!isRecord(source)) return undefined;
  const value = source[key];
  return typeof value === 'string' ? value : undefined;
}

/** True when a value carries the given `type` tag. */
export function hasType(block: unknown, type: string): boolean {
  return readString(block, 'type') === type;
}

/**
 * True when a value behaves like a `Set` for membership testing.
 *
 * Used where a rule receives a collection it did not build: calling `.has` on a
 * non-Set would throw and take down the request, which is strictly worse than
 * declining to answer.
 */
export function isMembershipSet(value: unknown): value is ReadonlySet<unknown> {
  if (value === null || value === undefined) return false;
  if (typeof value !== 'object' && typeof value !== 'function') return false;
  return typeof (value as { has?: unknown }).has === 'function';
}
