/**
 * The plugin under a **real cordis Context**.
 *
 * Everything else drives `applyWith` with a fake context. This file loads the
 * plugin the way the host does — `ctx.plugin(module, config)` — so the pieces
 * that only exist on that path are exercised:
 *
 *   - the module-level `name` / `inject` / `apply` contract,
 *   - `inject: ['llm']` actually waiting for the service,
 *   - config resolution through cordis rather than a direct call,
 *   - disposal through the fiber, which is what makes disabling the plugin a
 *     true revert.
 *
 * This is as close to the loader path as a unit test can get. It is still not
 * the loader: see TESTPLAN §5 C4/C5 for what remains unverifiable here.
 *
 * Skips when the harness is not installed.
 */

import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, it } from 'vite-plus/test';
import { resolveInstalledEntry } from '../src/resolve-harness.ts';
import type { StoreFs } from '../src/resolve-harness.ts';

/** Locate an installed package by its dlx directory name. */
/** Locate a file inside an installed package, via the shared resolver. */
function findInStore(packageName: string, inner: string): string | undefined {
  return resolveInstalledEntry(packageName, inner, storeFs, homedir());
}
const storeFs: StoreFs = {
  readdir: (dir) => readdirSync(dir),
  exists: (path) => existsSync(path),
  join: (...parts) => join(...parts),
};

const cordisPath = findInStore('@deepseek-ai/cordis', 'lib/index.js');
const llmPath = findInStore('@deepseek-ai/dsh-llm', 'lib/index.js');

interface Harness {
  LlmRuntime: { prototype: { streamWithRegistration?: unknown } };
  isAgentLoopRequest(request: unknown): boolean;
}

const harness: Harness | undefined =
  llmPath === undefined
    ? undefined
    : ((await import(pathToFileURL(llmPath).href)) as unknown as Harness);

const cordis: { Context: new () => unknown } | undefined =
  cordisPath === undefined
    ? undefined
    : ((await import(pathToFileURL(cordisPath).href)) as unknown as { Context: new () => unknown });

const ready = harness !== undefined && cordis !== undefined;

/**
 * Serialized on purpose: every case patches the **same** `LlmRuntime.prototype`,
 * so concurrent cases would interfere — one case's install or teardown would be
 * observed by another, and a test could pass because a *different* case restored
 * the seam.
 *
 * `node --test` needed `concurrency: 1` for that; Vitest is sequential unless a
 * suite opts in with `.concurrent`, so the default is the guarantee here. Do not
 * add `.concurrent` to this block.
 */
describe('plugin under a real cordis Context', { skip: !ready }, () => {
  // `apply` resolves the harness itself; pin it to the same module this file
  // loaded so the identity guard compares one physical class.
  const saved = process.env.DSH_HEAL_LLM_MODULE;
  beforeAll(() => {
    // Pin the plugin to the exact module this file loaded. A dlx store can hold
    // several `dsh-llm` copies, and the identity guard would (correctly) refuse
    // to patch a prototype the live service does not inherit from — which would
    // make this test assert the guard rather than the loader path.
    process.env.DSH_HEAL_LLM_MODULE = llmPath!;
  });
  afterAll(() => {
    if (saved === undefined) delete process.env.DSH_HEAL_LLM_MODULE;
    else process.env.DSH_HEAL_LLM_MODULE = saved;
  });

  /** A context with an `llm` service that really inherits from the harness class. */
  function makeContext() {
    const ctx = new cordis!.Context() as {
      provide(name: string, value: unknown): void;
      plugin(module: unknown, config?: unknown): { dispose(): void };
      get(name: string): unknown;
    };
    const service = Object.create(harness!.LlmRuntime.prototype) as object;
    ctx.provide('llm', service);
    return { ctx, service };
  }

  it('loads through ctx.plugin, waits for `llm`, and patches the real seam', async () => {
    const plugin = await import('../src/index.ts');
    const { ctx } = makeContext();
    const original = harness!.LlmRuntime.prototype.streamWithRegistration;

    const fork = ctx.plugin(plugin, { mode: 'heal' });
    try {
      // A fiber loads asynchronously; awaiting it is what the loader does too.
      await (fork as unknown as Promise<unknown>);
      assert.notEqual(
        harness!.LlmRuntime.prototype.streamWithRegistration,
        original,
        'the seam must be patched through the real loader path',
      );
    } finally {
      // `dispose()` returns a promise: the teardown is yielded inside a
      // `ctx.effect` and runs asynchronously. Not awaiting it would assert
      // against a half-torn-down fiber.
      await (fork.dispose() as unknown as Promise<unknown>);
    }
    assert.equal(
      harness!.LlmRuntime.prototype.streamWithRegistration,
      original,
      'disposal through the fiber must restore the seam',
    );
  });

  it('declares the module contract the loader reads', async () => {
    const plugin = (await import('../src/index.ts')) as {
      name?: unknown;
      inject?: unknown;
      apply?: unknown;
    };
    assert.equal(plugin.name, 'dsh-healer');
    assert.deepEqual(plugin.inject, ['llm'], 'the plugin must wait for the llm service');
    assert.equal(typeof plugin.apply, 'function');
  });

  it('resolves config through cordis and rejects an unknown rule id', async () => {
    const plugin = await import('../src/index.ts');
    const { ctx } = makeContext();
    const original = harness!.LlmRuntime.prototype.streamWithRegistration;

    const fork = ctx.plugin(plugin, { rules: { 'no-such-rule': { enabled: true } } });
    // The fiber reports a failed load rather than throwing synchronously.
    await assert.rejects(
      async () => {
        await (fork as unknown as Promise<unknown>);
      },
      (error: unknown) => {
        assert.match(String((error as Error).message ?? error), /no-such-rule/);
        return true;
      },
    );
    assert.equal(
      harness!.LlmRuntime.prototype.streamWithRegistration,
      original,
      'a rejected load must leave the seam untouched',
    );
    await (fork.dispose() as unknown as Promise<unknown>);
  });

  it('installs nothing for mode "off"', async () => {
    const plugin = await import('../src/index.ts');
    const { ctx } = makeContext();
    const original = harness!.LlmRuntime.prototype.streamWithRegistration;
    const fork = ctx.plugin(plugin, { mode: 'off' });
    try {
      await (fork as unknown as Promise<unknown>);
      assert.equal(harness!.LlmRuntime.prototype.streamWithRegistration, original);
    } finally {
      await (fork.dispose() as unknown as Promise<unknown>);
    }
  });

  it('refuses a second load in a different mode, rather than silently keeping the first', async () => {
    // Found by driving two loads through a real context: the wrapper closes over
    // its healer, so the second load's config was silently inert. An operator
    // changing `check` to `heal` saw no change and no error.
    const plugin = await import('../src/index.ts');
    const { ctx } = makeContext();
    const original = harness!.LlmRuntime.prototype.streamWithRegistration;

    const check = ctx.plugin(plugin, { mode: 'check' });
    await (check as unknown as Promise<unknown>);
    try {
      const heal = ctx.plugin(plugin, { mode: 'heal' });
      await assert.rejects(async () => {
        await (heal as unknown as Promise<unknown>);
      }, /already installed in mode "check"/);
      heal.dispose();
    } finally {
      await (check.dispose() as unknown as Promise<unknown>);
    }
    assert.equal(
      harness!.LlmRuntime.prototype.streamWithRegistration,
      original,
      'the refusal must not leave the seam patched',
    );
  });

  it('is idempotent across two loads of the same plugin', async () => {
    const plugin = await import('../src/index.ts');
    const { ctx } = makeContext();
    const original = harness!.LlmRuntime.prototype.streamWithRegistration;
    const first = ctx.plugin(plugin, { mode: 'heal' });
    await (first as unknown as Promise<unknown>);
    const wrapped = harness!.LlmRuntime.prototype.streamWithRegistration;
    const second = ctx.plugin(plugin, { mode: 'heal' });
    try {
      await (second as unknown as Promise<unknown>);
      // One wrap: a second load must not stack another.
      assert.equal(
        harness!.LlmRuntime.prototype.streamWithRegistration,
        wrapped,
        'a second load must not wrap the seam again',
      );
    } finally {
      await (second.dispose() as unknown as Promise<unknown>);
      await (first.dispose() as unknown as Promise<unknown>);
    }
    assert.equal(harness!.LlmRuntime.prototype.streamWithRegistration, original);
  });
});
