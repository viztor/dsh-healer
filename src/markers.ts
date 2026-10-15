/**
 * The bridge to the harness's identity-keyed agent-loop request marker.
 *
 * `markAgentLoopRequest` records the exact object in a process-local `WeakSet`,
 * and `isAgentLoopRequest` tests membership by identity. The wrapper therefore
 * has to carry the marker across to any replacement object it builds.
 *
 * Loading goes through `resolve-harness` so this bridge and the prototype patch
 * always reach the **same physical module**. If they diverged, the patch would
 * work and the marker would not — a failure that looks like a titling bug rather
 * than a packaging one.
 *
 * @module dsh-healer/markers
 */

import type { MarkerPort } from './patch.ts';
import { llmSpecifier, loadLlmModule } from './resolve-harness.ts';

interface MarkerModule {
  isAgentLoopRequest(request: unknown): boolean;
  markAgentLoopRequest<T>(request: T): T;
}

let cached: MarkerModule | undefined;

/** Load the marker functions, or throw a diagnostic error. */
export async function loadMarkers(): Promise<MarkerModule> {
  if (cached !== undefined) return cached;
  const loaded = await loadLlmModule();
  const isAgentLoopRequest = loaded.isAgentLoopRequest;
  const markAgentLoopRequest = loaded.markAgentLoopRequest;
  if (typeof isAgentLoopRequest !== 'function' || typeof markAgentLoopRequest !== 'function') {
    throw new Error(
      `dsh-healer: ${llmSpecifier()} does not export isAgentLoopRequest/markAgentLoopRequest. ` +
        'The DSH version may have changed; refusing to run without marker preservation.',
    );
  }
  cached = {
    isAgentLoopRequest: isAgentLoopRequest as MarkerModule['isAgentLoopRequest'],
    markAgentLoopRequest: markAgentLoopRequest as MarkerModule['markAgentLoopRequest'],
  };
  return cached;
}

/**
 * A `MarkerPort` that preserves the marker by delegating to the harness.
 *
 * Marking is what makes the repaired request indistinguishable, to downstream
 * listeners, from the loop-built request it replaces.
 */
export async function createMarkerPort(): Promise<MarkerPort> {
  const markers = await loadMarkers();
  return {
    isMarked: (request) => markers.isAgentLoopRequest(request),
    mark: (request) => markers.markAgentLoopRequest(request),
  };
}
