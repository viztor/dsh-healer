/**
 * Unit matrix for the `tool-call-arguments` rule (WORKFLOW.md N11).
 *
 * Import isolation: this file imports its own rule module, the test runner, and `node:assert` — nothing else. No engine, no rule index, no other rule, no
 * plugin. Engine-level behaviour lives in test/engine.test.ts.
 *
 * @module dsh-healer/test/rules/tool-call-arguments.test
 */

import { describe, it } from 'vite-plus/test';
import assert from 'node:assert/strict';

import {
  NORMALISED_ARGUMENTS,
  detect,
  id,
  isJsonObject,
  repair,
  roles,
  rule,
} from '../../src/rules/tool-call-arguments.ts';

/** Build the content-phase envelope the engine hands a content rule. */
/**
 * Build the (block, context) pair the engine hands a content rule.
 *
 * The rule is handed the block itself — the coordinates belong to the engine —
 * so this returns the block plus the context, and call sites spread it.
 */
function at(block: unknown, messageIndex = 0, blockIndex = 0) {
  return [block, { phase: 'content' as const, messageIndex, blockIndex }] as const;
}

/** A minimal well-formed tool call. */
function call(over: Record<string, unknown> = {}) {
  return { type: 'tool-call', id: 'call-1', name: 'read', arguments: '{}', ...over };
}

/** Build a finding by hand, for the defensive `repair` paths. */
function finding(detail?: unknown) {
  return {
    ruleId: id,
    reason: 'hand-built',
    messageIndex: -1,
    ...(detail === undefined ? {} : { detail }),
  };
}

describe('tool-call-arguments · module surface', () => {
  it('exports the documented identity', () => {
    assert.equal(id, 'tool-call-arguments');
    assert.deepEqual(roles, ['assistant']);
  });

  it('exports a content rule that is DISABLED by default (D-12)', () => {
    // Deliberate: the pi-ai adapter's `parseArguments` already substitutes {}
    // for a non-object, so shipping this enabled would be a behaviour change
    // with no incident behind it.
    assert.equal(rule.id, 'tool-call-arguments');
    assert.equal(rule.kind, 'content');
    assert.equal(rule.enabledByDefault, false);
    assert.deepEqual(rule.roles, ['assistant']);
    assert.equal(typeof rule.detect, 'function');
    assert.equal(typeof rule.repair, 'function');
  });

  it('normalises to exactly the adapter-substituted value', () => {
    assert.equal(NORMALISED_ARGUMENTS, '{}');
  });
});

describe('tool-call-arguments · isJsonObject', () => {
  const OBJECTS = ['{}', '{"a":1}', '  {"a":[1,2],"b":null}  ', '{"a":{"b":{}}}'];
  for (const raw of OBJECTS) {
    it(`accepts ${raw}`, () => {
      assert.equal(isJsonObject(raw), true);
    });
  }

  const NON_OBJECTS: ReadonlyArray<readonly [string, string]> = [
    ['an empty string', ''],
    ['whitespace', '   '],
    ['unparseable text', 'not json'],
    ['a truncated object', '{"a":'],
    ['single quotes', "{'a':1}"],
    ['a bare number', '5'],
    ['zero', '0'],
    ['a negative number', '-1.5'],
    ['null', 'null'],
    ['an empty array', '[]'],
    ['a populated array', '[1,2]'],
    ['a JSON string', '"hello"'],
    ['a boolean', 'true'],
    ['undefined literal', 'undefined'],
    ['NaN literal', 'NaN'],
  ];
  for (const [label, raw] of NON_OBJECTS) {
    it(`rejects ${label}`, () => {
      assert.equal(isJsonObject(raw), false);
    });
  }
});

describe('tool-call-arguments · unusable arguments are findings', () => {
  it('reports an empty-string arguments value', () => {
    const found = detect(...at(call({ arguments: '' })));
    assert.ok(found, 'expected a finding for arguments: ""');
    assert.equal(found.ruleId, 'tool-call-arguments');
    assert.match(found.reason, /not a parseable JSON object/i);
  });

  it('reports unparseable text', () => {
    assert.ok(detect(...at(call({ arguments: 'not json' }))));
  });

  it('reports a truncated object', () => {
    assert.ok(detect(...at(call({ arguments: '{"a":' }))));
  });

  it('reports a MISSING arguments key', () => {
    const found = detect(...at({ type: 'tool-call', id: 'call-1', name: 'read' }));
    assert.ok(found, 'expected a finding when the arguments key is absent');
    assert.match(found.reason, /no string "arguments"/i);
  });

  it('reports a non-string arguments value', () => {
    // `arguments` already an object is a different malformation; the rule reads
    // only strings, so it reports and then carries the block for `repair`.
    const found = detect(...at(call({ arguments: { path: '/tmp' } })));
    assert.ok(found);
    assert.match(found.reason, /no string "arguments"/i);
  });

  it('carries the whole block in detail so repair can rebuild it', () => {
    const block = call({ arguments: 'oops' });
    const found = detect(...at(block));
    assert.ok(found);
    assert.deepEqual(found.detail, { block });
  });
});

describe('tool-call-arguments · PINNED JSON edge cases', () => {
  // The decisive semantic: only a plain JSON object is acceptable. A JSON
  // array, a JSON primitive and JSON null all parse successfully but are NOT
  // objects, so all three are findings. These are pinned explicitly because
  // "JSON.parse succeeded" is the tempting-but-wrong test.
  it('treats the primitive "5" as a finding', () => {
    assert.ok(detect(...at(call({ arguments: '5' }))), '"5" parses to a number, not an object');
  });

  it('treats the literal "null" as a finding', () => {
    assert.ok(detect(...at(call({ arguments: 'null' }))), '"null" parses to null, not an object');
  });

  it('treats "[]" as a finding', () => {
    assert.ok(detect(...at(call({ arguments: '[]' }))), '"[]" parses to an array, not an object');
  });

  it('treats a populated array as a finding', () => {
    assert.ok(detect(...at(call({ arguments: '[{"path":"/tmp"}]' }))));
  });

  it('treats a JSON string literal as a finding', () => {
    assert.ok(detect(...at(call({ arguments: '"read"' }))));
  });

  it('treats the boolean literal "true" as a finding', () => {
    assert.ok(detect(...at(call({ arguments: 'true' }))));
  });

  it('does NOT report "{}"', () => {
    assert.equal(detect(...at(call({ arguments: '{}' }))), undefined);
  });

  it('does NOT report a populated object', () => {
    assert.equal(detect(...at(call({ arguments: '{"path":"/tmp","limit":5}' }))), undefined);
  });

  it('does NOT report an object with surrounding whitespace', () => {
    assert.equal(detect(...at(call({ arguments: '  {"a":1}  ' }))), undefined);
  });

  it('does NOT report a nested object', () => {
    assert.equal(detect(...at(call({ arguments: '{"a":{"b":[]}}' }))), undefined);
  });
});

describe('tool-call-arguments · every non-tool block type is ignored', () => {
  const NON_TOOL_BLOCKS: ReadonlyArray<readonly [string, unknown]> = [
    ['text', { type: 'text', text: 'hi', arguments: 'oops' }],
    ['reasoning', { type: 'reasoning', text: 'thinking', arguments: 'oops' }],
    ['image', { type: 'image', source: {} }],
    ['file', { type: 'file', filename: 'a.txt' }],
    ['tool-addition', { type: 'tool-addition', tools: [] }],
    ['tool-removal', { type: 'tool-removal', toolNames: [] }],
    ['tool-result', { type: 'tool-result', toolCallId: 'call-1', content: [] }],
  ];

  for (const [label, block] of NON_TOOL_BLOCKS) {
    it(`ignores a ${label} block`, () => {
      assert.equal(detect(...at(block)), undefined);
    });
  }

  it('ignores a legacy tool_result block', () => {
    assert.equal(
      detect(...at({ type: 'tool_result', tool_use_id: 'tu-1', content: [] })),
      undefined,
    );
  });
});

describe('tool-call-arguments · unknown and hostile input never throws', () => {
  const UNKNOWN_INPUTS: ReadonlyArray<readonly [string, unknown]> = [
    ['an unknown tag', { type: 'brand-new-block-type', arguments: 'oops' }],
    ['a non-string type', { type: 7, arguments: 'oops' }],
    ['a missing type', { arguments: 'oops' }],
    ['an empty object', {}],
    ['an array', []],
    ['a bare string', 'tool-call'],
    ['a bare number', 7],
    ['null', null],
  ];

  for (const [label, value] of UNKNOWN_INPUTS) {
    it(`returns undefined for ${label}`, () => {
      assert.doesNotThrow(() => detect(...at(value)));
      assert.equal(detect(...at(value)), undefined);
    });
  }
});

describe('tool-call-arguments · defensive on a missing envelope', () => {
  it('returns undefined for an undefined input', () => {
    assert.doesNotThrow(() => detect(undefined));
    assert.equal(detect(undefined), undefined);
  });

  it('returns undefined for a null input', () => {
    assert.doesNotThrow(() => detect(null));
    assert.equal(detect(null), undefined);
  });

  it('returns undefined for an empty envelope', () => {
    assert.doesNotThrow(() => detect({}));
    assert.equal(detect({}), undefined);
  });
});

describe('tool-call-arguments · repair replaces with {} and preserves every other field', () => {
  it('replaces a finding whose detail carries a full block', () => {
    const block = { type: 'tool-call', id: 'call-1', name: 'read', arguments: 'oops', extra: 1 };
    const found = detect(...at(block));
    assert.ok(found);

    const decision = repair(found);
    assert.equal(decision.action, 'replace');
    assert.deepEqual((decision as { value: unknown }).value, {
      type: 'tool-call',
      id: 'call-1',
      name: 'read',
      arguments: '{}',
      extra: 1,
    });
  });

  it('preserves nested fields by identity-bearing structure, not by dropping them', () => {
    const nested = { path: '/tmp', flags: ['a', 'b'] };
    const block = { type: 'tool_use', id: 'tu-1', name: 'read', arguments: 'nope', meta: nested };
    const found = detect(...at(block));
    assert.ok(found);

    const decision = repair(found);
    assert.equal(decision.action, 'replace');
    assert.deepEqual((decision as { value: unknown }).value, {
      type: 'tool_use',
      id: 'tu-1',
      name: 'read',
      arguments: '{}',
      meta: nested,
    });
  });

  it('does not mutate the original block', () => {
    const block = { type: 'tool-call', id: 'call-1', name: 'read', arguments: 'oops' };
    const snapshot = structuredClone(block);
    const found = detect(...at(block));
    assert.ok(found);
    repair(found);
    assert.deepEqual(block, snapshot, 'repair must not write through to the block');
    assert.equal(block.arguments, 'oops');
  });

  it('replaces for a block that was missing arguments entirely', () => {
    const block = { type: 'tool-call', id: 'call-1', name: 'read' };
    const found = detect(...at(block));
    assert.ok(found);

    const decision = repair(found);
    assert.equal(decision.action, 'replace');
    assert.deepEqual((decision as { value: unknown }).value, {
      type: 'tool-call',
      id: 'call-1',
      name: 'read',
      arguments: '{}',
    });
  });

  it('drops through the exported rule entry point', () => {
    const block = { type: 'tool-call', id: 'call-1', name: 'read', arguments: 'oops' };
    const found = detect(...at(block));
    assert.ok(found);

    const decision = rule.repair(found, { phase: 'content', messages: [] });
    assert.equal(decision.action, 'replace');
    assert.deepEqual((decision as { value: unknown }).value, { ...block, arguments: '{}' });
  });
});

describe('tool-call-arguments · repair is defensive when detail carries no usable block', () => {
  // Unreachable from `detect` today, because any block it reports is a record.
  // The rule's own contract is to fall back to a drop rather than throw or
  // return a replacement built from nothing.
  const DEFENSIVE_DETAILS: ReadonlyArray<readonly [string, unknown]> = [
    ['no detail at all', undefined],
    ['an empty detail object', {}],
    ['detail.block: undefined', { block: undefined }],
    ['detail.block: null', { block: null }],
    ['detail.block: a string', { block: 'tool-call' }],
    ['detail.block: a number', { block: 7 }],
    ['detail.block: an array', { block: [] }],
    ['detail as an array', []],
    ['detail as a string', 'nope'],
  ];

  for (const [label, detail] of DEFENSIVE_DETAILS) {
    it(`drops when given ${label}`, () => {
      assert.deepEqual(repair(finding(detail)), { action: 'drop' });
    });
  }

  it('never throws for any hand-built detail', () => {
    assert.doesNotThrow(() => repair(finding(undefined)));
    assert.doesNotThrow(() => repair(finding({ block: null })));
  });
});

describe('tool-call-arguments · order independence within the content phase', () => {
  it('gives a valid block the same verdict at any position', () => {
    const block = call({ arguments: '{"a":1}' });
    const verdicts = [
      detect(...at(block, 0, 0)),
      detect(...at(block, 0, 1)),
      detect(...at(block, 0, 99)),
      detect(...at(block, 114, 3)),
      detect(...at(block, 4810, 7)),
    ];
    assert.deepEqual(verdicts, [undefined, undefined, undefined, undefined, undefined]);
  });

  it('gives an invalid block the same verdict at any position', () => {
    const block = call({ arguments: 'oops' });
    for (const [messageIndex, blockIndex] of [
      [0, 0],
      [0, 1],
      [0, 99],
      [114, 3],
      [4810, 7],
    ] as const) {
      assert.ok(detect(...at(block, messageIndex, blockIndex)));
    }
  });

  it('judges each block of a mixed message independently, in both orders', () => {
    const good = call({ id: 'call-ok', arguments: '{}' });
    const bad = call({ id: 'call-bad', arguments: 'oops' });
    const forward = [good, bad].map((block, blockIndex) => detect(...at(block, 0, blockIndex)));
    const reverse = [bad, good].map((block, blockIndex) => detect(...at(block, 0, blockIndex)));

    assert.deepEqual(
      forward.map((f) => f === undefined),
      [true, false],
    );
    assert.deepEqual(
      reverse.map((f) => f === undefined),
      [false, true],
    );
  });
});
