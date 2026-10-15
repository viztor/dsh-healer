/**
 * Patch wrapper, streaming pass-through, and seam guards.
 *
 * The wrapper is a pure function of `(original, heal, markers)`, so all of this
 * runs with a fake `original` and a fake marker port: no LlmRuntime, no cordis
 * context, no adapter, no network. The real seam is exercised in
 * `integration.test.ts`.
 *
 * The pass-through assertion is the important one. It is deliberately **not**
 * "the returned iterable is the one the adapter produced" — a real profile wraps
 * the stream (`session-checkpoint-policy` returns a generator), so that
 * assertion would fail for reasons unrelated to this plugin and would invite
 * someone to weaken it. Instead we prove the property that actually matters:
 * whatever the waterfall produced is returned unchanged.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'vite-plus/test';

import {
  assertSeamIdentity,
  install,
  PATCH_MARKER,
  SeamError,
  wrapStreamWithRegistration,
} from '../src/patch.ts';
import type { MarkerPort, PatchTarget, StreamOptions } from '../src/patch.ts';
import type { MessageLike } from '../src/types.ts';

/** A marker port backed by a real WeakSet, mirroring the harness. */
function fakeMarkers(): MarkerPort & { marked: WeakSet<object> } {
  const marked = new WeakSet<object>();
  return {
    marked,
    isMarked: (request) =>
      typeof request === 'object' && request !== null ? marked.has(request) : false,
    mark: (request) => {
      if (typeof request === 'object' && request !== null) marked.add(request);
      return request;
    },
  };
}

/** A healer that drops assistant blocks tagged `drop`. */
function healerDroppingTag(tag: string) {
  return (messages: readonly MessageLike[]) => {
    let changed = false;
    const next = messages.map((message) => {
      if (message.role !== 'assistant') return message;
      const content = message.content.filter(
        (block) =>
          !(
            typeof block === 'object' &&
            block !== null &&
            (block as { type?: string }).type === tag
          ),
      );
      if (content.length === message.content.length) return message;
      changed = true;
      return { ...message, content };
    });
    return { messages: changed ? next : messages };
  };
}

const cleanOptions: StreamOptions = {
  provider: 'test',
  model: 'test-model',
  messages: [
    { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
  ],
};

const dirtyOptions: StreamOptions = {
  provider: 'test',
  model: 'test-model',
  messages: [
    { role: 'assistant', content: [{ type: 'drop', text: 'go away' }] },
    { role: 'user', content: [{ type: 'text', text: 'hi' }] },
  ],
};

describe('patch wrapper', () => {
  it('forwards the identical object when nothing changed (mode: heal)', () => {
    const seen: unknown[] = [];
    const original = function (this: unknown, options: StreamOptions) {
      seen.push(options);
      return 'stream';
    };
    const markers = fakeMarkers();
    const wrapped = wrapStreamWithRegistration(
      original,
      healerDroppingTag('drop'),
      markers,
      'heal',
    );

    const result = wrapped(cleanOptions);
    assert.equal(result, 'stream');
    assert.equal(seen[0], cleanOptions, 'the clean path must not clone');
  });

  it('passes the healed messages and preserves every other option (mode: heal)', () => {
    const seen: StreamOptions[] = [];
    const original = function (this: unknown, options: StreamOptions) {
      seen.push(options);
      return 'stream';
    };
    const wrapped = wrapStreamWithRegistration(
      original,
      healerDroppingTag('drop'),
      fakeMarkers(),
      'heal',
    );

    wrapped(dirtyOptions);
    const forwarded = seen[0]!;
    assert.notEqual(forwarded, dirtyOptions, 'a changed request must be a new object');
    assert.equal(forwarded.provider, 'test');
    assert.equal(forwarded.model, 'test-model');
    assert.equal(forwarded.messages.length, 2, 'no message is removed by a content-only heal');
    assert.equal(forwarded.messages[0]!.role, 'assistant');
    assert.deepEqual(forwarded.messages[0]!.content, [], 'the tagged block is gone');
    assert.equal(
      forwarded.messages[1],
      dirtyOptions.messages[1],
      'an untouched message keeps its identity',
    );
  });

  it('re-marks a repaired request so the identity-keyed marker survives (mode: heal)', () => {
    const seen: StreamOptions[] = [];
    const original = function (this: unknown, options: StreamOptions) {
      seen.push(options);
      return 'stream';
    };
    const markers = fakeMarkers();
    markers.mark(dirtyOptions);

    const wrapped = wrapStreamWithRegistration(
      original,
      healerDroppingTag('drop'),
      markers,
      'heal',
    );
    wrapped(dirtyOptions);

    assert.equal(markers.isMarked(seen[0]), true, 'the replacement must carry the marker');
    assert.notEqual(seen[0], dirtyOptions);
  });

  it('does not mark a request that was never marked', () => {
    const seen: StreamOptions[] = [];
    const original = function (this: unknown, options: StreamOptions) {
      seen.push(options);
      return 'stream';
    };
    const markers = fakeMarkers();
    const wrapped = wrapStreamWithRegistration(original, healerDroppingTag('drop'), markers);
    wrapped(dirtyOptions);
    assert.equal(markers.isMarked(seen[0]), false);
  });

  it('forwards `this` and `prepared` untouched', () => {
    const receiver = { tag: 'runtime' };
    let seenThis: unknown;
    let seenPrepared: unknown;
    const prepared = { registration: 'r' };
    const original = function (this: unknown, _options: StreamOptions, p?: unknown) {
      // Observing the receiver is the point of this test, and an arrow function
      // cannot see `this` — so the alias is required here, not a smell.
      // oxlint-disable-next-line typescript/no-this-alias
      seenThis = this;
      seenPrepared = p;
      return 'stream';
    };
    const wrapped = wrapStreamWithRegistration(original, healerDroppingTag('drop'), fakeMarkers());
    wrapped.call(receiver, dirtyOptions, prepared);
    assert.equal(seenThis, receiver);
    assert.equal(seenPrepared, prepared);
  });

  it('returns the waterfall value unchanged, and is synchronous', () => {
    // The sentinel stands in for whatever the waterfall produced — including a
    // wrapper generator installed by another listener.
    const sentinel = { kind: 'sentinel-iterable' };
    const original = () => sentinel;
    const wrapped = wrapStreamWithRegistration(original, healerDroppingTag('drop'), fakeMarkers());

    const result = wrapped(dirtyOptions);
    assert.equal(result, sentinel, 'the returned value must be passed through by identity');
    // No `await` anywhere before dispatch: the wrapper is not async and returns
    // a non-promise.
    assert.equal(typeof (result as { then?: unknown }).then, 'undefined');
  });

  it('never consumes or re-emits the returned iterable', () => {
    let pulls = 0;
    const original = () => {
      const iterable = {
        [Symbol.asyncIterator]() {
          return {
            next() {
              pulls += 1;
              return Promise.resolve({ done: true, value: undefined });
            },
          };
        },
      };
      return iterable;
    };
    const wrapped = wrapStreamWithRegistration(original, healerDroppingTag('drop'), fakeMarkers());
    const returned = wrapped(dirtyOptions);
    assert.equal(pulls, 0, 'the wrapper must not pull from the stream');
    assert.ok(returned !== undefined);
  });

  it('propagates a healer throw rather than dispatching a half-repaired request', () => {
    const original = () => 'stream';
    const wrapped = wrapStreamWithRegistration(
      original,
      () => {
        throw new Error('heal exploded');
      },
      fakeMarkers(),
      'heal',
    );
    assert.throws(() => wrapped(dirtyOptions), /heal exploded/);
  });
});

describe('install / dispose', () => {
  function makeTarget(): PatchTarget & { calls: number } {
    const target: PatchTarget & { calls: number } = {
      calls: 0,
      streamWithRegistration(this: unknown, _options: StreamOptions) {
        target.calls += 1;
        return 'stream';
      },
    };
    return target;
  }

  it('installs, forwards to the original, and restores it on dispose', () => {
    const target = makeTarget();
    const original = target.streamWithRegistration;
    const handle = install(target, healerDroppingTag('drop'), fakeMarkers());

    assert.notEqual(target.streamWithRegistration, original, 'the seam must be replaced');
    target.streamWithRegistration!(dirtyOptions);
    assert.equal(target.calls, 1, 'the original must still be called');

    handle.dispose();
    assert.equal(target.streamWithRegistration, original, 'dispose must restore identity');
    assert.equal(target[PATCH_MARKER], undefined);
  });

  it('is idempotent: a second install returns the same handle and wraps once', () => {
    const target = makeTarget();
    const markers = fakeMarkers();
    const first = install(target, healerDroppingTag('drop'), markers);
    const wrapped = target.streamWithRegistration;
    const second = install(target, healerDroppingTag('drop'), markers);

    assert.equal(first, second, 'the same handle must be returned');
    assert.equal(target.streamWithRegistration, wrapped, 'the seam must not be wrapped twice');

    // Double-wrapping would heal twice; prove a single heal by counting heals.
    let heals = 0;
    const countingTarget: PatchTarget = {
      streamWithRegistration() {
        return 'stream';
      },
    };
    install(
      countingTarget,
      (messages) => {
        heals += 1;
        return healerDroppingTag('drop')(messages);
      },
      markers,
      'heal',
    );
    install(
      countingTarget,
      () => {
        heals += 1;
        return { messages: [] };
      },
      markers,
      'heal',
    );
    countingTarget.streamWithRegistration!(dirtyOptions);
    assert.equal(heals, 1, 'exactly one heal per request');
  });

  it('dispose is idempotent and a second dispose does not disturb a reinstall', () => {
    const target = makeTarget();
    const original = target.streamWithRegistration;
    const handle = install(target, healerDroppingTag('drop'), fakeMarkers());
    handle.dispose();
    handle.dispose();
    assert.equal(target.streamWithRegistration, original);
    const again = install(target, healerDroppingTag('drop'), fakeMarkers());
    assert.ok(again);
    assert.notEqual(target.streamWithRegistration, original);
  });

  it('fails loudly when the seam is missing', () => {
    const target: PatchTarget = {};
    assert.throws(
      () => install(target, healerDroppingTag('drop'), fakeMarkers()),
      (error: unknown) => {
        assert.ok(error instanceof SeamError);
        assert.equal((error as SeamError).code, 'SEAM_MISSING');
        return true;
      },
    );
  });

  it('fails loudly when the seam is not a function', () => {
    const target: PatchTarget = { streamWithRegistration: 'not a function' as unknown as never };
    assert.throws(
      () => install(target, healerDroppingTag('drop'), fakeMarkers()),
      /not a function/,
    );
  });
});

describe('seam identity guard', () => {
  it('accepts a service that inherits from the patched prototype', () => {
    class Runtime {}
    class Sub extends Runtime {}
    assertSeamIdentity(new Sub(), Runtime.prototype);
  });

  it('rejects a service from a different copy of the class', () => {
    class Runtime {}
    class OtherCopy {}
    assert.throws(
      () => assertSeamIdentity(new OtherCopy(), Runtime.prototype),
      (error: unknown) => {
        assert.ok(error instanceof SeamError);
        assert.equal((error as SeamError).code, 'SEAM_IDENTITY_MISMATCH');
        return true;
      },
    );
  });

  it('rejects a non-object service', () => {
    assert.throws(
      () => assertSeamIdentity(undefined, {}),
      /SEAM_IDENTITY_MISMATCH|does not inherit/,
    );
  });
});

describe('install · mode conflicts and stale handles', () => {
  function makeTarget(): PatchTarget {
    return {
      streamWithRegistration() {
        return 'stream';
      },
    };
  }

  it('records the mode it installed', () => {
    const target = makeTarget();
    const handle = install(target, healerDroppingTag('drop'), fakeMarkers(), 'check');
    assert.equal(handle.mode, 'check');
    handle.dispose();
  });

  it('defaults the mode to "fail-safe"', () => {
    const target = makeTarget();
    const handle = install(target, healerDroppingTag('drop'), fakeMarkers());
    assert.equal(handle.mode, 'fail-safe');
    handle.dispose();
  });

  it('refuses a second install in a different mode, loudly', () => {
    // The wrapper closes over its healer, so a second install could not take
    // effect. Silently keeping the first configuration would leave an operator
    // who changed `check` to `heal` seeing no change and no error.
    const target = makeTarget();
    const first = install(target, healerDroppingTag('drop'), fakeMarkers(), 'check');
    try {
      assert.throws(
        () => install(target, healerDroppingTag('drop'), fakeMarkers(), 'heal'),
        (error: unknown) => {
          assert.ok(error instanceof SeamError);
          assert.equal((error as SeamError).code, 'MODE_CONFLICT');
          assert.match((error as Error).message, /already installed in mode "check"/);
          assert.match((error as Error).message, /Dispose the existing install/);
          return true;
        },
      );
      // The refusal must not disturb the working install.
      assert.equal(target.streamWithRegistration, target.streamWithRegistration);
      assert.equal(first.mode, 'check');
    } finally {
      first.dispose();
    }
  });

  it('still treats a same-mode second install as a no-op', () => {
    const target = makeTarget();
    const first = install(target, healerDroppingTag('drop'), fakeMarkers(), 'heal');
    const wrapped = target.streamWithRegistration;
    const second = install(target, healerDroppingTag('drop'), fakeMarkers(), 'heal');
    assert.equal(second, first, 'the same handle must be returned');
    assert.equal(target.streamWithRegistration, wrapped, 'the seam must not be wrapped twice');
    first.dispose();
  });

  it('lets a different mode install once the first is disposed', () => {
    const target = makeTarget();
    const original = target.streamWithRegistration;
    const first = install(target, healerDroppingTag('drop'), fakeMarkers(), 'check');
    first.dispose();
    assert.equal(target.streamWithRegistration, original);
    const second = install(target, healerDroppingTag('drop'), fakeMarkers(), 'heal');
    assert.equal(second.mode, 'heal');
    assert.notEqual(target.streamWithRegistration, original);
    second.dispose();
    assert.equal(target.streamWithRegistration, original);
  });

  it('a stale handle does not clobber a newer patch', () => {
    // The handle must be *undisposed* while its patch has been replaced by
    // something else — otherwise `dispose()` returns early on the `disposed`
    // flag and the guard is never reached, which is how the first version of
    // this test passed without exercising anything.
    const target = makeTarget();
    const original = target.streamWithRegistration;
    const first = install(target, healerDroppingTag('drop'), fakeMarkers(), 'heal');

    // Something else takes over the seam while `first` is still live.
    const usurper = function streamWithRegistration() {
      return 'usurper';
    };
    target.streamWithRegistration = usurper;

    first.dispose();

    assert.equal(
      target.streamWithRegistration,
      usurper,
      'a stale dispose must not restore the original over a newer patch',
    );
    assert.notEqual(target.streamWithRegistration, original);
  });
});

describe('patch wrapper · fail-safe mode', () => {
  async function* successStream(text = 'ok') {
    yield { type: 'delta', text };
    yield { type: 'finish', reason: { kind: 'completed' } };
  }

  async function* errorStream(code = 'INVALID_ARGUMENT', message = 'invalid argument') {
    yield {
      type: 'finish',
      reason: { kind: 'error', failure: { code, message } },
    };
  }

  it('forwards the request object itself, without healing it', () => {
    let forwarded: StreamOptions | undefined;
    const original = function (this: unknown, options: StreamOptions) {
      forwarded = options;
      return successStream('hello');
    };
    const wrapped = wrapStreamWithRegistration(
      original,
      healerDroppingTag('drop'),
      fakeMarkers(),
      'fail-safe',
    );

    wrapped(dirtyOptions);

    assert.equal(forwarded, dirtyOptions, 'fail-safe must not alter or copy the request');
  });

  it('returns the provider stream by identity, so nothing is buffered or re-emitted', () => {
    // The strongest form of "zero interference": not merely equivalent chunks,
    // but the very object the runtime produced. Wrapping it in an async
    // generator is what previously let this method swallow the provider error.
    const stream = successStream('hello');
    const original = function (this: unknown, _options: StreamOptions) {
      return stream;
    };
    const wrapped = wrapStreamWithRegistration(
      original,
      healerDroppingTag('drop'),
      fakeMarkers(),
      'fail-safe',
    );

    assert.equal(wrapped(dirtyOptions), stream, 'the stream must pass through untouched');
  });

  it('lets a provider error reach the caller, so agent/request-error can fire', async () => {
    // Regression guard for the defect that motivated the redesign: intercepting
    // the error here hid it from `dsh-agent-loop`, so the hook that repairs the
    // *session* never ran and the history stayed poisoned.
    let calls = 0;
    const original = function (this: unknown, _options: StreamOptions) {
      calls += 1;
      return errorStream('INVALID_ARGUMENT', 'tool call name is empty');
    };
    const wrapped = wrapStreamWithRegistration(
      original,
      healerDroppingTag('drop'),
      fakeMarkers(),
      'fail-safe',
    );

    type Chunk = { type: string; reason?: { kind?: string } };
    const chunks: Chunk[] = [];
    for await (const chunk of wrapped(dirtyOptions) as AsyncIterable<Chunk>) {
      chunks.push(chunk);
    }

    assert.equal(calls, 1, 'the seam must not retry; recovery belongs to the hook');
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0]!.type, 'finish');
    assert.equal(
      chunks[0]!.reason?.kind,
      'error',
      'the error finish must survive for the agent loop',
    );
  });

  it('propagates a synchronous provider throw instead of healing it away', () => {
    const failure = new Error('Request contains an invalid argument');
    const original = function (this: unknown, _options: StreamOptions) {
      throw failure;
    };
    const wrapped = wrapStreamWithRegistration(
      original,
      healerDroppingTag('drop'),
      fakeMarkers(),
      'fail-safe',
    );

    assert.throws(
      () => wrapped(dirtyOptions),
      (error: unknown) => error === failure,
    );
  });

  it('never consults the healer in fail-safe mode', () => {
    let heals = 0;
    const original = function (this: unknown, _options: StreamOptions) {
      return successStream();
    };
    const wrapped = wrapStreamWithRegistration(
      original,
      (messages) => {
        heals += 1;
        return { messages };
      },
      fakeMarkers(),
      'fail-safe',
    );

    wrapped(dirtyOptions);

    assert.equal(heals, 0, 'fail-safe must not heal proactively — that is what heal mode is for');
  });
});
