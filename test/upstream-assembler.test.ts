/**
 * The upstream defect this plugin works around, pinned as executable evidence.
 *
 * `BlockAssembler.assemble()` fabricates a tool-call block with an empty name
 * when an adapter emits `block-start` for a tool call but no `tool-call-delta`
 * carrying a name. That block is durable, never pruned, and re-sent on every
 * later request — the incident this whole plugin exists for.
 *
 * This file states the behaviour the assembler *should* have. Against the
 * installed harness it runs the defect case as a **reproduction** (proving the
 * defect is real) and the fixed case as a **specification**, skipped until the
 * upstream fix is applied. Run it with the fix applied to verify the fix:
 *
 *     node scripts/verify-upstream-fix.ts
 *
 * @see ../upstream/REPORT.md
 */

import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, it } from 'vite-plus/test';
import { resolveHarnessEntry } from '../src/resolve-harness.ts';
import type { StoreFs } from '../src/resolve-harness.ts';

/** Locate the installed `BlockAssembler`, without naming a user-specific path. */
/** The installed assembler, via the shared resolver. */
function findAssembler(): string | undefined {
  // An explicit assembler path wins: `scripts/verify-upstream-fix.ts` points this
  // at a patched sandbox copy so the specification can run without touching the
  // live harness. `DSH_LLM_MODULE` is honoured for the same reason, one level up.
  //
  // Both were dropped when this was migrated onto the shared resolver, and nothing
  // failed: the override is only exercised by the verifier, which is not part of
  // `node --test`. Consolidating a resolver means keeping every input it had, not
  // only the ones the suite happens to use.
  const sandbox = process.env.DSH_HEAL_ASSEMBLER_MODULE;
  if (sandbox !== undefined && sandbox.length > 0) return sandbox;
  const override = process.env.DSH_LLM_MODULE;
  if (override !== undefined && override.length > 0) return override;
  return resolveHarnessEntry('@deepseek-ai/dsh-llm', 'lib/types/assembler.js', storeFs, homedir());
}
const storeFs: StoreFs = {
  readdir: (dir) => readdirSync(dir),
  exists: (path) => existsSync(path),
  join: (...parts) => join(...parts),
};

const assemblerPath = findAssembler();
const fixed = process.env.DSH_HEAL_ASSEMBLER_FIXED === '1';

interface AssemblerModule {
  BlockAssembler: new () => {
    push(chunk: unknown): void;
    blocks(): readonly { type: string; id?: string; name?: string; arguments?: string }[];
  };
}

const module =
  assemblerPath === undefined
    ? undefined
    : ((await import(pathToFileURL(assemblerPath).href)) as unknown as AssemblerModule);

/** The exact chunk sequence the incident's adapter produced. */
function feedBareBlockStart(): AssemblerModule['BlockAssembler'] extends new () => infer T
  ? T
  : never {
  const assembler = new module!.BlockAssembler();
  // block-start with no following tool-call-delta: neither id nor name is set.
  assembler.push({ type: 'block-start', index: 3, blockType: 'tool-call' });
  assembler.push({ type: 'finish', reason: { kind: 'tool-calls' } });
  return assembler as never;
}

/** A well-formed tool call, which must keep working. */
function feedCompleteToolCall() {
  const assembler = new module!.BlockAssembler();
  assembler.push({ type: 'block-start', index: 0, blockType: 'tool-call' });
  assembler.push({
    type: 'tool-call-delta',
    index: 0,
    id: 'call_abc',
    name: 'bash',
    argumentsDelta: '{"command":"ls"}',
  });
  assembler.push({
    type: 'block-end',
    index: 0,
    block: { type: 'tool-call', id: 'call_abc', name: 'bash', arguments: '{"command":"ls"}' },
  });
  assembler.push({ type: 'finish', reason: { kind: 'tool-calls' } });
  return assembler;
}

/**
 * The requirement is gated on the fix being applied. Against an unfixed harness
 * these two cases MUST fail — that is what makes them a specification rather
 * than a restatement of current behaviour — so they are skipped with an explicit
 * reason instead of quietly passing. `node scripts/verify-upstream-fix.ts`
 * applies the fix to a sandbox and runs this file with the gate open.
 */
const specSkipReason =
  module === undefined
    ? 'the installed harness was not found'
    : fixed
      ? false
      : 'upstream fix not applied — run scripts/verify-upstream-fix.ts to verify it';

// Vitest's `skip` takes a boolean, where `node --test` accepted the reason and
// printed it beside the skipped case. Reporting it once here keeps a waiting
// specification distinguishable from a broken one; without this the output says
// only "2 skipped", which is exactly the ambiguity the reason existed to remove.
if (specSkipReason !== false) {
  console.log(`skipping the upstream specification: ${specSkipReason}`);
}

const specSkip = specSkipReason !== false;

describe(
  'upstream: BlockAssembler must not fabricate an empty-name tool call',
  { skip: module === undefined },
  () => {
    it('reproduces the defect on the installed harness (evidence, not a requirement)', () => {
      if (fixed) return; // the fix is applied; the defect case is covered below
      const blocks = feedBareBlockStart().blocks();
      const toolCalls = blocks.filter((block) => block.type === 'tool-call');
      assert.equal(toolCalls.length, 1, 'the defective assembler emits a block');
      assert.equal(toolCalls[0]!.name, '', 'the emitted name is empty — this is the defect');
      assert.equal(toolCalls[0]!.id, 'call-3', 'the id is synthesised from the index');
      assert.equal(toolCalls[0]!.arguments, '', 'arguments are empty too');
    });

    it(
      'SPEC: an incomplete tool call is rejected rather than fabricated',
      { skip: specSkip },
      () => {
        assert.throws(
          () => feedBareBlockStart().blocks(),
          (error: unknown) => {
            assert.ok(error instanceof TypeError, 'the failure must be a TypeError');
            assert.match((error as Error).message, /tool-call block with no name/);
            return true;
          },
        );
      },
    );

    it('SPEC: the emitted block carries no empty name', { skip: specSkip }, () => {
      let blocks: readonly { type: string; name?: string }[] = [];
      try {
        blocks = feedBareBlockStart().blocks();
      } catch {
        return; // rejected, which is the required behaviour
      }
      for (const block of blocks) {
        if (block.type !== 'tool-call') continue;
        assert.notEqual(
          block.name,
          '',
          'no tool-call block may reach a provider with an empty name',
        );
      }
    });

    it('a well-formed tool call still assembles correctly', () => {
      const blocks = feedCompleteToolCall().blocks();
      assert.deepEqual(blocks, [
        { type: 'tool-call', id: 'call_abc', name: 'bash', arguments: '{"command":"ls"}' },
      ]);
    });

    it('text and reasoning blocks are unaffected', () => {
      const assembler = new module!.BlockAssembler();
      assembler.push({ type: 'block-start', index: 0, blockType: 'text' });
      assembler.push({ type: 'text-delta', index: 0, text: 'hello' });
      assembler.push({ type: 'block-end', index: 0, block: { type: 'text', text: 'hello' } });
      assembler.push({ type: 'finish', reason: { kind: 'stop' } });
      assert.deepEqual(assembler.blocks(), [{ type: 'text', text: 'hello' }]);
    });
  },
);
