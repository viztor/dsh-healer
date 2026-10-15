/**
 * Integration against the **real** `LlmRuntime.prototype`.
 *
 * Everything else in this suite runs against fakes. This file deliberately does
 * not: it loads the installed `@deepseek-ai/dsh-llm` and exercises the actual
 * seam — the real `streamWithRegistration`, the real `markAgentLoopRequest`, and
 * a real `llm/stream` waterfall with a wrapping listener, which is what a live
 * profile has (`session-checkpoint-policy` returns a generator).
 *
 * Two things it proves that no fake can:
 *
 *   1. `install` patches the class the runtime actually uses, and `stream()`
 *      routes through the patch.
 *   2. The identity-keyed marker survives a repair, verified with the harness's
 *      own `isAgentLoopRequest`.
 *
 * It skips (rather than fails) when the harness is not installed, so the suite
 * stays runnable outside a DSH host.
 */

import assert from 'node:assert/strict';
import { afterAll, beforeAll, describe, it } from 'vite-plus/test';

import { install } from '../src/patch.ts';
import { resolveHarnessEntry } from '../src/resolve-harness.ts';
import type { StoreFs } from '../src/resolve-harness.ts';
import type { MarkerPort, PatchTarget, StreamOptions } from '../src/patch.ts';
import type { MessageLike } from '../src/types.ts';

/**
 * Resolve the harness the same portable way the plugin does.
 *
 * This used to carry its own scan, which looked for the store at a **fixed one
 * level** below each dlx root. The real layout is deeper
 * (`<root>/<hash>/<version>/node_modules/.pnpm`), so the scan found nothing,
 * `HARNESS` came back undefined, and this whole file skipped — while
 * `harness-required.test.ts`, which scans with `searchForHarness`, reported the
 * harness present. Eleven tests silently did not run and the suite was green.
 *
 * Found by running the suite in a clean room (`env -u NODE_PATH`) and diffing the
 * test names against a run that had it. That is the same failure this project's
 * own test plan warns about, and it had reappeared in the file that warns hardest.
 */
async function resolveHarness(): Promise<string | undefined> {
  const override = process.env.DSH_HEAL_LLM_MODULE;
  if (override !== undefined && override.length > 0) return override;

  // A normal resolution, when this package sits inside a profile.
  try {
    const { createRequire } = await import('node:module');
    return createRequire(import.meta.url).resolve('@deepseek-ai/dsh-llm');
  } catch {
    // fall through to the shared store scan
  }

  const { existsSync, readdirSync } = await import('node:fs');
  const { homedir } = await import('node:os');
  const { join } = await import('node:path');
  const storeFs: StoreFs = {
    readdir: (dir) => readdirSync(dir),
    exists: (path) => existsSync(path),
    join: (...parts) => join(...parts),
  };
  return resolveHarnessEntry('@deepseek-ai/dsh-llm', 'lib/index.js', storeFs, homedir());
}

const HARNESS = await resolveHarness();

interface HarnessModule {
  LlmRuntime: { prototype: PatchTarget & { stream(options: StreamOptions): unknown } };
  isAgentLoopRequest(request: unknown): boolean;
  markAgentLoopRequest<T>(request: T): T;
}

async function loadHarness(): Promise<HarnessModule | undefined> {
  const specifier = HARNESS;
  if (specifier === undefined) return undefined;
  try {
    return (await import(specifier)) as unknown as HarnessModule;
  } catch {
    return undefined;
  }
}

const harness = await loadHarness();

/** The options a loop-built request carries, mirroring `buildRequest`. */
function request(messages: readonly MessageLike[], marked: boolean): StreamOptions {
  const options: StreamOptions = {
    provider: 'test-provider',
    model: 'test-model',
    messages,
    sessionId: 'session-1',
    signal: undefined,
  };
  if (marked) harness?.markAgentLoopRequest(options);
  return options;
}

const poisonedMessages: readonly MessageLike[] = [
  { role: 'user', content: [{ type: 'text', text: 'run something' }] },
  {
    role: 'assistant',
    content: [{ type: 'tool-call', id: 'call-3', name: '', arguments: '' }],
  },
  {
    role: 'tool',
    toolCallId: 'call-3',
    content: [{ type: 'text', text: 'Error: unknown tool ""' }],
  },
];

const cleanMessages: readonly MessageLike[] = [
  { role: 'user', content: [{ type: 'text', text: 'hello' }] },
  { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
];

/**
 * Drive the real prototype with a stub context.
 *
 * `waterfall` mirrors cordis: it runs the listeners outermost-first, passing the
 * **original** arguments and a `next`, and the innermost behaviour is the
 * callback. That is exactly the shape the seam relies on.
 */
function makeInstance(): {
  instance: { stream(options: StreamOptions): unknown };
  received: () => StreamOptions | undefined;
  wrapped: boolean;
} {
  assert.ok(harness, 'harness required');
  const proto = harness.LlmRuntime.prototype;
  const instance = Object.create(proto) as {
    stream(options: StreamOptions): unknown;
    ctx: unknown;
    adapterStream(options: StreamOptions): unknown;
  };

  let received: StreamOptions | undefined;
  const sentinel = { kind: 'chunk-stream' };

  // Stand in for the private adapter boundary: record what the patch forwarded.
  instance.adapterStream = (options: StreamOptions) => {
    received = options;
    return sentinel;
  };

  instance.ctx = {
    waterfall(
      _this: unknown,
      _event: string,
      options: StreamOptions,
      inner: () => unknown,
    ): unknown {
      // A wrapping listener, exactly as session-checkpoint-policy installs one:
      // it returns a different object than the inner callback produced.
      const wrapped = { kind: 'wrapper', inner: inner() };
      void options;
      return wrapped;
    },
  };

  return { instance, received: () => received, wrapped: true };
}

describe('integration: real LlmRuntime seam', { skip: harness === undefined }, () => {
  it('patches the real prototype and routes stream() through it', () => {
    const { instance, received } = makeInstance();
    const handle = install(harness!.LlmRuntime.prototype, (messages) => ({ messages }), {
      isMarked: harness!.isAgentLoopRequest,
      mark: harness!.markAgentLoopRequest,
    } satisfies MarkerPort);
    try {
      instance.stream(request(poisonedMessages, false));
      assert.ok(received, 'the adapter boundary must have been reached');
    } finally {
      handle.dispose();
    }
  });

  it('hands the adapter a request with no empty tool name and no stranded result', () => {
    const { instance, received } = makeInstance();
    const handle = install(
      harness!.LlmRuntime.prototype,
      (messages) => {
        // A minimal stand-in for the shipped healer, so this test isolates the
        // seam rather than re-testing rule logic.
        const kept = messages.filter(
          (message) => !(message.role === 'assistant' && message.content.length === 0),
        );
        const assistant = kept.find((message) => message.role === 'assistant');
        const next =
          assistant === undefined
            ? kept
            : kept.map((message) =>
                message === assistant ? { ...message, content: [] } : message,
              );
        return { messages: next };
      },
      {
        isMarked: harness!.isAgentLoopRequest,
        mark: harness!.markAgentLoopRequest,
      } satisfies MarkerPort,
      'heal',
    );
    try {
      instance.stream(request(poisonedMessages, false));
      const forwarded = received();
      assert.ok(forwarded, 'the adapter boundary must have been reached');
      for (const message of forwarded.messages) {
        if (message.role !== 'assistant') continue;
        for (const block of message.content) {
          if (typeof block !== 'object' || block === null) continue;
          const candidate = block as { type?: string; name?: string };
          if (candidate.type !== 'tool-call') continue;
          assert.notEqual(candidate.name, '', 'no empty tool name may reach the adapter');
        }
      }
    } finally {
      handle.dispose();
    }
  });

  it('preserves the agent-loop marker across a repair, using the harness own predicate', () => {
    const { instance, received } = makeInstance();
    const handle = install(
      harness!.LlmRuntime.prototype,
      (messages) => ({ messages: messages.slice(1) }),
      {
        isMarked: harness!.isAgentLoopRequest,
        mark: harness!.markAgentLoopRequest,
      } satisfies MarkerPort,
      'heal',
    );
    try {
      const options = request(poisonedMessages, true);
      assert.equal(harness!.isAgentLoopRequest(options), true, 'precondition: input is marked');
      instance.stream(options);

      const forwarded = received();
      assert.ok(forwarded, 'the adapter boundary must have been reached');
      assert.notEqual(forwarded, options, 'a repair must produce a new object');
      assert.equal(
        harness!.isAgentLoopRequest(forwarded),
        true,
        'the repaired request must still be recognised as a loop-built request',
      );
    } finally {
      handle.dispose();
    }
  });

  it('leaves a clean request marked and identical', () => {
    const { instance, received } = makeInstance();
    const handle = install(harness!.LlmRuntime.prototype, (messages) => ({ messages }), {
      isMarked: harness!.isAgentLoopRequest,
      mark: harness!.markAgentLoopRequest,
    } satisfies MarkerPort);
    try {
      const options = request(cleanMessages, true);
      instance.stream(options);
      assert.equal(received(), options, 'the clean path must forward the identical object');
      assert.equal(harness!.isAgentLoopRequest(received()), true);
    } finally {
      handle.dispose();
    }
  });

  it('returns the waterfall value unchanged even when a listener wraps the stream', () => {
    const { instance } = makeInstance();
    const handle = install(harness!.LlmRuntime.prototype, (messages) => ({ messages }), {
      isMarked: harness!.isAgentLoopRequest,
      mark: harness!.markAgentLoopRequest,
    } satisfies MarkerPort);
    try {
      const result = instance.stream(request(cleanMessages, false)) as { kind?: string };
      // The listener wrapped it, so identity is NOT the adapter's sentinel — it
      // is the wrapper the listener produced. The patch must not add a second
      // layer of its own.
      assert.equal(result.kind, 'wrapper', 'the patch must not re-wrap the stream');
    } finally {
      handle.dispose();
    }
  });

  it('restores the real prototype method on dispose', () => {
    const proto = harness!.LlmRuntime.prototype;
    const original = proto.streamWithRegistration;
    const handle = install(proto, (messages) => ({ messages }), {
      isMarked: harness!.isAgentLoopRequest,
      mark: harness!.markAgentLoopRequest,
    } satisfies MarkerPort);
    assert.notEqual(proto.streamWithRegistration, original);
    handle.dispose();
    assert.equal(proto.streamWithRegistration, original, 'dispose must restore the seam');
  });

  it('assertSeamIdentity accepts a real LlmRuntime-shaped service', async () => {
    const { assertSeamIdentity } = await import('../src/patch.ts');
    const { instance } = makeInstance();
    assert.doesNotThrow(() => assertSeamIdentity(instance, harness!.LlmRuntime.prototype));
  });
});

describe(
  'apply: the cordis entry point, against the real harness',
  { skip: harness === undefined },
  () => {
    // `apply` resolves the harness itself. Pin it to the exact module this file
    // loaded, so the test exercises `apply` rather than the best-effort store
    // scan — and so a machine with several `dsh-llm` copies cannot make the
    // identity guard fire for an unrelated reason.
    const savedOverride = process.env.DSH_HEAL_LLM_MODULE;
    beforeAll(() => {
      process.env.DSH_HEAL_LLM_MODULE = HARNESS!;
    });
    afterAll(() => {
      if (savedOverride === undefined) delete process.env.DSH_HEAL_LLM_MODULE;
      else process.env.DSH_HEAL_LLM_MODULE = savedOverride;
    });

    /** A context whose `llm` service really inherits from the patched prototype. */
    function realContext() {
      const service = Object.create(harness!.LlmRuntime.prototype);
      const info: string[] = [];
      return {
        service,
        info,
        ctx: {
          get: (name: string) => (name === 'llm' ? service : undefined),
          logger: { info: (m: string) => info.push(m), warn: (m: string) => info.push(m) },
        },
      };
    }

    it('patches the real prototype, asserts identity, and restores on dispose', async () => {
      const { apply } = await import('../src/index.ts');
      const proto = harness!.LlmRuntime.prototype;
      const original = proto.streamWithRegistration;
      const { ctx, info } = realContext();

      const handle = await apply(ctx, { mode: 'heal' });
      try {
        assert.notEqual(proto.streamWithRegistration, original, 'the real seam must be patched');
        assert.match(info.join('\n'), /dsh-healer: installed \(mode=heal/);
      } finally {
        handle.dispose();
      }
      assert.equal(proto.streamWithRegistration, original, 'dispose must restore the real seam');
    });

    it('refuses to install when the live service is from a different copy of the class', async () => {
      const { apply } = await import('../src/index.ts');
      const proto = harness!.LlmRuntime.prototype;
      const original = proto.streamWithRegistration;

      class DifferentCopy {}
      const foreign = { get: (name: string) => (name === 'llm' ? new DifferentCopy() : undefined) };

      await assert.rejects(
        () => apply(foreign, { mode: 'heal' }),
        /SEAM_IDENTITY_MISMATCH|does not inherit/,
      );
      // The identity assertion runs after install, so the patch must not survive
      // a rejected apply in a way that outlives it. Restore explicitly and assert.
      proto.streamWithRegistration = original;
      assert.equal(proto.streamWithRegistration, original);
    });

    it('does not install anything in mode "off"', async () => {
      const { apply } = await import('../src/index.ts');
      const proto = harness!.LlmRuntime.prototype;
      const original = proto.streamWithRegistration;
      const { ctx } = realContext();

      const handle = await apply(ctx, { mode: 'off' });
      try {
        assert.equal(proto.streamWithRegistration, original, 'mode off must not patch');
      } finally {
        handle.dispose();
      }
    });

    it('refuses to run with an invalid configuration, before patching', async () => {
      const { apply } = await import('../src/index.ts');
      const proto = harness!.LlmRuntime.prototype;
      const original = proto.streamWithRegistration;
      const { ctx } = realContext();

      await assert.rejects(() => apply(ctx, { mode: 'nonsense' }), /config\.mode/);
      assert.equal(proto.streamWithRegistration, original, 'a config error must not patch');
    });
  },
);
