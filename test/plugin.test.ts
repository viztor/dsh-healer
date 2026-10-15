/**
 * Plugin behaviour: `applyWith`.
 *
 * Driven with a fake prototype, a fake marker port and a capturing logger, so
 * the whole plugin can be exercised without a DSH host. The checks that matter
 * are the ones about *refusing* to run: an unknown rule id, a missing seam, and
 * `mode: 'off'` must all behave precisely.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'vite-plus/test';

import { ConfigError } from '../src/config.ts';
import { applyWith } from '../src/index.ts';
import { PATCH_MARKER, SeamError } from '../src/patch.ts';
import type { MarkerPort, PatchTarget, StreamOptions } from '../src/patch.ts';
import type { MessageLike, Rule } from '../src/types.ts';

function fakeMarkers(): MarkerPort {
  const marked = new WeakSet<object>();
  return {
    isMarked: (request) => typeof request === 'object' && request !== null && marked.has(request),
    mark: (request) => {
      if (typeof request === 'object' && request !== null) marked.add(request);
      return request;
    },
  };
}

function fakePrototype(): PatchTarget & { lastOptions?: StreamOptions } {
  const target: PatchTarget & { lastOptions?: StreamOptions } = {
    streamWithRegistration(this: unknown, options: StreamOptions) {
      target.lastOptions = options;
      return 'stream';
    },
  };
  return target;
}

function capturingLogger() {
  const info: string[] = [];
  const warn: string[] = [];
  return {
    info: (m: string) => info.push(m),
    warn: (m: string) => warn.push(m),
    lines: { info, warn },
  };
}

/** One content rule that drops blocks tagged `drop`. */
const dropRule: Rule = {
  id: 'drop-tagged',
  kind: 'content',
  enabledByDefault: true,
  description: 'drops tagged blocks',
  roles: ['assistant'],
  detect: (target) => {
    const block = target as { type?: string };
    if (block?.type !== 'drop') return undefined;
    return { ruleId: 'drop-tagged', reason: 'tagged', messageIndex: -1 };
  },
  repair: () => ({ action: 'drop' }),
};

/** A second, default-off rule, to exercise enablement through config. */
const optInRule: Rule = {
  id: 'opt-in',
  kind: 'content',
  enabledByDefault: false,
  description: 'only runs when enabled',
  roles: ['assistant'],
  detect: () => undefined,
  repair: () => ({ action: 'keep' }),
};

const dirtyMessages: readonly MessageLike[] = [
  { role: 'assistant', content: [{ type: 'drop' }, { type: 'text', text: 'keep' }] },
];

const cleanMessages: readonly MessageLike[] = [
  { role: 'assistant', content: [{ type: 'text', text: 'keep' }] },
];

describe('applyWith', () => {
  it('installs the patch and heals a request (mode: heal)', async () => {
    const target = fakePrototype();
    const handle = await applyWith(
      { mode: 'heal' },
      { runtimePrototype: target, markers: fakeMarkers(), logger: capturingLogger() },
      [dropRule],
    );
    try {
      target.streamWithRegistration!({ messages: dirtyMessages });
      const forwarded = target.lastOptions!;
      assert.equal(forwarded.messages[0]!.content.length, 1);
      assert.equal((forwarded.messages[0]!.content[0] as { type?: string }).type, 'text');
    } finally {
      handle.dispose();
    }
  });

  it('forwards the request untouched in fail-safe mode on success', async () => {
    const target = fakePrototype();
    const handle = await applyWith(
      {},
      { runtimePrototype: target, markers: fakeMarkers(), logger: capturingLogger() },
      [dropRule],
    );
    try {
      const options: StreamOptions = { messages: dirtyMessages };
      target.streamWithRegistration!(options);
      assert.equal(target.lastOptions, options, 'fail-safe mode must not mutate on clean dispatch');
    } finally {
      handle.dispose();
    }
  });

  it('installs nothing when mode is "off"', async () => {
    const target = fakePrototype();
    const logger = capturingLogger();
    const handle = await applyWith(
      { mode: 'off' },
      { runtimePrototype: target, markers: fakeMarkers(), logger },
      [dropRule],
    );
    assert.equal(target[PATCH_MARKER], undefined, 'no patch may be installed');
    assert.match(logger.lines.info.join('\n'), /mode "off"/);
    handle.dispose();
  });

  it('leaves the outbound request byte-identical in check mode, while reporting', async () => {
    const target = fakePrototype();
    const logger = capturingLogger();
    const handle = await applyWith(
      { mode: 'check' },
      { runtimePrototype: target, markers: fakeMarkers(), logger },
      [dropRule],
    );
    try {
      const options: StreamOptions = { messages: dirtyMessages };
      target.streamWithRegistration!(options);
      assert.equal(target.lastOptions, options, 'check mode must not replace the request');
      assert.match(logger.lines.warn.join('\n'), /drop-tagged/);
    } finally {
      handle.dispose();
    }
  });

  it('does not report when nothing is found', async () => {
    const target = fakePrototype();
    const logger = capturingLogger();
    const handle = await applyWith(
      {},
      { runtimePrototype: target, markers: fakeMarkers(), logger },
      [dropRule],
    );
    try {
      target.streamWithRegistration!({ messages: cleanMessages });
      assert.deepEqual(logger.lines.warn, []);
    } finally {
      handle.dispose();
    }
  });

  it('throws on findings when onFindings is "throw", before dispatch (mode: heal)', async () => {
    const target = fakePrototype();
    const handle = await applyWith(
      { mode: 'heal', onFindings: 'throw' },
      { runtimePrototype: target, markers: fakeMarkers(), logger: capturingLogger() },
      [dropRule],
    );
    try {
      assert.throws(
        () => target.streamWithRegistration!({ messages: dirtyMessages }),
        /1 malformed block/,
      );
    } finally {
      handle.dispose();
    }
  });

  it('reports nothing when onFindings is "silent"', async () => {
    const target = fakePrototype();
    const logger = capturingLogger();
    const handle = await applyWith(
      { onFindings: 'silent' },
      { runtimePrototype: target, markers: fakeMarkers(), logger },
      [dropRule],
    );
    try {
      target.streamWithRegistration!({ messages: dirtyMessages });
      assert.deepEqual(logger.lines.warn, []);
    } finally {
      handle.dispose();
    }
  });

  it('refuses to install when config names an unknown rule id', async () => {
    const target = fakePrototype();
    await assert.rejects(
      () =>
        applyWith(
          { rules: { 'no-such-rule': { enabled: true } } },
          { runtimePrototype: target, markers: fakeMarkers(), logger: capturingLogger() },
          [dropRule, optInRule],
        ),
      (error: unknown) => {
        assert.ok(error instanceof ConfigError);
        assert.match((error as Error).message, /no-such-rule/);
        assert.match((error as Error).message, /drop-tagged/);
        return true;
      },
    );
    assert.equal(target[PATCH_MARKER], undefined, 'nothing may be installed on a config error');
  });

  it('tolerates an unknown rule id when strictRuleIds is off', async () => {
    const target = fakePrototype();
    const handle = await applyWith(
      { strictRuleIds: false, rules: { 'no-such-rule': { enabled: true } } },
      { runtimePrototype: target, markers: fakeMarkers(), logger: capturingLogger() },
      [dropRule],
    );
    assert.notEqual(target[PATCH_MARKER], undefined);
    handle.dispose();
  });

  it('honours a per-rule disable', async () => {
    const target = fakePrototype();
    const handle = await applyWith(
      { rules: { 'drop-tagged': { enabled: false } } },
      { runtimePrototype: target, markers: fakeMarkers(), logger: capturingLogger() },
      [dropRule],
    );
    try {
      const options: StreamOptions = { messages: dirtyMessages };
      target.streamWithRegistration!(options);
      assert.equal(target.lastOptions, options, 'a disabled rule must change nothing');
    } finally {
      handle.dispose();
    }
  });

  it('honours a per-rule enable of a default-off rule', async () => {
    let called = 0;
    const spy: Rule = {
      ...optInRule,
      detect: () => {
        called += 1;
        return undefined;
      },
    };
    const target = fakePrototype();
    const handle = await applyWith(
      { mode: 'heal', rules: { 'opt-in': { enabled: true } } },
      { runtimePrototype: target, markers: fakeMarkers(), logger: capturingLogger() },
      [spy],
    );
    try {
      target.streamWithRegistration!({ messages: cleanMessages });
      assert.ok(called > 0, 'the enabled default-off rule must run');
    } finally {
      handle.dispose();
    }
  });

  it('fails loudly when the seam is missing', async () => {
    await assert.rejects(
      () =>
        applyWith({}, { runtimePrototype: {}, markers: fakeMarkers(), logger: capturingLogger() }, [
          dropRule,
        ]),
      (error: unknown) => {
        assert.ok(error instanceof SeamError);
        assert.equal((error as SeamError).code, 'SEAM_MISSING');
        return true;
      },
    );
  });

  it('is idempotent across repeated application', async () => {
    const target = fakePrototype();
    const markers = fakeMarkers();
    const first = await applyWith(
      {},
      { runtimePrototype: target, markers, logger: capturingLogger() },
      [dropRule],
    );
    const second = await applyWith(
      {},
      { runtimePrototype: target, markers, logger: capturingLogger() },
      [dropRule],
    );
    assert.equal(first, second, 'a second apply must reuse the installed handle');
    first.dispose();
    assert.equal(target[PATCH_MARKER], undefined);
  });
});

describe('applyWith · reporting policies', () => {
  /** A rule that reports on every assistant block, so several findings arise. */
  const noisy: Rule = {
    id: 'noisy',
    kind: 'content',
    enabledByDefault: true,
    description: 'reports on every block',
    roles: ['assistant'],
    detect: () => ({ ruleId: 'noisy', reason: 'suspect', messageIndex: -1 }),
    repair: () => ({ action: 'keep' }),
  };

  const multiBlock: readonly MessageLike[] = [
    { role: 'assistant', content: [{ type: 'text' }, { type: 'text' }, { type: 'text' }] },
  ];

  it('logs one line per finding, with coordinates', async () => {
    const target = fakePrototype();
    const logger = capturingLogger();
    const handle = await applyWith(
      { mode: 'heal', onFindings: 'log' },
      { runtimePrototype: target, markers: fakeMarkers(), logger },
      [noisy],
    );
    try {
      target.streamWithRegistration!({ messages: multiBlock });
      assert.equal(logger.lines.warn.length, 3, 'one line per finding');
      assert.match(logger.lines.warn[0]!, /dsh-healer: noisy message 0 block 0: suspect/);
      assert.match(logger.lines.warn[2]!, /block 2/);
    } finally {
      handle.dispose();
    }
  });

  it('omits the block coordinate for a message-level finding', async () => {
    const target = fakePrototype();
    const logger = capturingLogger();
    const messageRule: Rule = {
      id: 'msg-rule',
      kind: 'message',
      enabledByDefault: true,
      description: 'reports on the message',
      roles: ['assistant'],
      detect: () => ({ ruleId: 'msg-rule', reason: 'whole message', messageIndex: -1 }),
      repair: () => ({ action: 'keep' }),
    };
    const handle = await applyWith(
      { mode: 'heal', onFindings: 'log' },
      { runtimePrototype: target, markers: fakeMarkers(), logger },
      [messageRule],
    );
    try {
      target.streamWithRegistration!({ messages: multiBlock });
      assert.equal(logger.lines.warn.length, 1);
      assert.match(logger.lines.warn[0]!, /message 0: whole message/);
      assert.doesNotMatch(logger.lines.warn[0]!, /block/);
    } finally {
      handle.dispose();
    }
  });

  it('throws a count and a joined detail list for several findings', async () => {
    const target = fakePrototype();
    const handle = await applyWith(
      { mode: 'heal', onFindings: 'throw' },
      { runtimePrototype: target, markers: fakeMarkers(), logger: capturingLogger() },
      [noisy],
    );
    try {
      assert.throws(
        () => target.streamWithRegistration!({ messages: multiBlock }),
        (error: unknown) => {
          const message = (error as Error).message;
          assert.match(message, /3 malformed block\(s\)/);
          assert.match(message, /noisy at message 0 block 0: suspect/);
          assert.match(message, /noisy at message 0 block 2: suspect/);
          return true;
        },
      );
    } finally {
      handle.dispose();
    }
  });

  it('does not throw when there are no findings, even under onFindings: throw', async () => {
    const target = fakePrototype();
    const handle = await applyWith(
      { mode: 'heal', onFindings: 'throw' },
      { runtimePrototype: target, markers: fakeMarkers(), logger: capturingLogger() },
      [dropRule],
    );
    try {
      assert.doesNotThrow(() => target.streamWithRegistration!({ messages: cleanMessages }));
    } finally {
      handle.dispose();
    }
  });

  it('reports the installed mode and the enabled rule set', async () => {
    const target = fakePrototype();
    const logger = capturingLogger();
    const handle = await applyWith(
      { rules: { 'opt-in': { enabled: true } } },
      { runtimePrototype: target, markers: fakeMarkers(), logger },
      [dropRule, optInRule],
    );
    try {
      const line = logger.lines.info.join('\n');
      assert.match(line, /installed \(mode=fail-safe/);
      assert.match(line, /drop-tagged/);
      assert.match(line, /opt-in/);
    } finally {
      handle.dispose();
    }
  });

  it('reports a default-off rule as absent from the enabled set', async () => {
    const target = fakePrototype();
    const logger = capturingLogger();
    const handle = await applyWith(
      {},
      { runtimePrototype: target, markers: fakeMarkers(), logger },
      [dropRule, optInRule],
    );
    try {
      const line = logger.lines.info.join('\n');
      assert.match(line, /drop-tagged/);
      assert.doesNotMatch(line, /opt-in/);
    } finally {
      handle.dispose();
    }
  });

  it('says "none" when no rule is enabled', async () => {
    const target = fakePrototype();
    const logger = capturingLogger();
    const handle = await applyWith(
      { rules: { 'drop-tagged': { enabled: false } } },
      { runtimePrototype: target, markers: fakeMarkers(), logger },
      [dropRule],
    );
    try {
      assert.match(logger.lines.info.join('\n'), /rules=none/);
    } finally {
      handle.dispose();
    }
  });

  it('falls back to a silent logger when the host supplies none', async () => {
    const target = fakePrototype();
    // No `logger` in deps: must not throw, and must not depend on `console`.
    const handle = await applyWith({}, { runtimePrototype: target, markers: fakeMarkers() }, [
      dropRule,
    ]);
    try {
      assert.doesNotThrow(() => target.streamWithRegistration!({ messages: dirtyMessages }));
    } finally {
      handle.dispose();
    }
  });
});
