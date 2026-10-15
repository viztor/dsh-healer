/**
 * The marker bridge.
 *
 * `createMarkerPort` is the only thing standing between a repaired request and
 * the silent loss of its agent-loop marker — which fail-opens
 * `dsh-agent-loop`'s request invariant and skips `dsh-session-title`'s
 * main-request path. So both halves matter: the port must delegate to the
 * harness's own identity-keyed functions, and it must refuse to run at all if
 * the harness no longer exports them.
 *
 * The failure paths are reachable through `DSH_HEAL_LLM_MODULE`, which exists
 * precisely so a guard nobody can exercise does not ship untested.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, it } from 'vite-plus/test';

import { applyWith } from '../src/index.ts';
import { createMarkerPort, loadMarkers } from '../src/markers.ts';

const saved = process.env.DSH_HEAL_LLM_MODULE;

afterEach(() => {
  if (saved === undefined) delete process.env.DSH_HEAL_LLM_MODULE;
  else process.env.DSH_HEAL_LLM_MODULE = saved;
});

/** Write a throwaway ES module and return its file URL. */
function fakeModule(source: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-healer-markers-'));
  const file = join(dir, 'fake.mjs');
  writeFileSync(file, source);
  return pathToFileURL(file).href;
}

describe('markers · failure paths', () => {
  it('reports a bad override explicitly, rather than silently falling back', async () => {
    // An override that quietly resolved to the default copy would hide the very
    // packaging problem the override exists to investigate.
    process.env.DSH_HEAL_LLM_MODULE = 'file:///nonexistent/dsh-healer-no-such-module.mjs';
    await assert.rejects(
      () => loadMarkers(),
      (error: unknown) => {
        const message = (error as Error).message;
        assert.match(message, /DSH_HEAL_LLM_MODULE/);
        assert.match(message, /no-such-module/);
        return true;
      },
    );
  });

  it('refuses to run when the harness exports neither marker function', async () => {
    process.env.DSH_HEAL_LLM_MODULE = fakeModule('export const somethingElse = 1;');
    await assert.rejects(
      () => loadMarkers(),
      (error: unknown) => {
        const message = (error as Error).message;
        assert.match(message, /does not export isAgentLoopRequest/);
        assert.match(message, /refusing to run without marker preservation/);
        return true;
      },
    );
  });

  it('refuses to run when only one marker function is present', async () => {
    process.env.DSH_HEAL_LLM_MODULE = fakeModule(
      'export function isAgentLoopRequest() { return false; }',
    );
    await assert.rejects(() => loadMarkers(), /does not export isAgentLoopRequest/);
  });

  it('refuses to run when the exports are present but not functions', async () => {
    process.env.DSH_HEAL_LLM_MODULE = fakeModule(
      'export const isAgentLoopRequest = 1; export const markAgentLoopRequest = 2;',
    );
    await assert.rejects(() => loadMarkers(), /does not export isAgentLoopRequest/);
  });

  it('accepts a module that exports both, and delegates to it', async () => {
    const marked = new WeakSet<object>();
    process.env.DSH_HEAL_LLM_MODULE = fakeModule(`
      const marked = new WeakSet();
      export function isAgentLoopRequest(request) { return marked.has(request); }
      export function markAgentLoopRequest(request) { marked.add(request); return request; }
    `);
    const markers = await createMarkerPort();
    const request = {};
    assert.equal(markers.isMarked(request), false);
    markers.mark(request);
    assert.equal(markers.isMarked(request), true, 'the port must delegate to the module');
    void marked;
  });
});

describe('markers · the real harness', () => {
  it('preserves identity exactly as the harness does', async () => {
    // Uses the default specifier: the installed harness, resolved the same way
    // the plugin resolves it at runtime.
    let port;
    try {
      port = await createMarkerPort();
    } catch {
      return; // harness not installed here; the failure paths above still ran
    }
    const request = {};
    assert.equal(port.isMarked(request), false, 'an unmarked object must read as unmarked');
    port.mark(request);
    assert.equal(port.isMarked(request), true, 'marking must be observable');

    // Identity, not structure: an equal-but-distinct object must not inherit it.
    const lookalike = { ...request };
    assert.equal(port.isMarked(lookalike), false, 'the marker is keyed by identity');
  });
});

describe('the resolved harness must export LlmRuntime', () => {
  // `resolveRuntimePrototype` refuses to install when the resolved package has no
  // `LlmRuntime`. A silent no-op is the worst outcome here: the plugin would look
  // healthy while every poisoned request kept failing.
  const base = {
    markers: {
      isMarked: () => false,
      mark: <T>(request: T): T => request,
    },
    logger: { info: () => {}, warn: () => {} },
  };

  it('refuses to install when the module exports no LlmRuntime', async () => {
    process.env.DSH_HEAL_LLM_MODULE = fakeModule('export const somethingElse = 1;');
    await assert.rejects(
      () => applyWith({}, base),
      (error: unknown) => {
        const message = (error as Error).message;
        assert.match(message, /does not export LlmRuntime/);
        assert.match(message, /refusing to install a patch that would silently no-op/);
        return true;
      },
    );
  });

  it('refuses to install when LlmRuntime has no prototype to patch', async () => {
    process.env.DSH_HEAL_LLM_MODULE = fakeModule('export const LlmRuntime = 42;');
    await assert.rejects(() => applyWith({}, base), /does not export LlmRuntime/);
  });

  it('accepts a module that exports a usable LlmRuntime', async () => {
    // The default export is accepted too, which is how `dsh-llm` ships.
    process.env.DSH_HEAL_LLM_MODULE = fakeModule(
      'export default class LlmRuntime { streamWithRegistration() { return "inner"; } }',
    );
    const handle = await applyWith({}, base);
    try {
      assert.equal(typeof handle.dispose, 'function');
    } finally {
      handle.dispose();
    }
  });
});
