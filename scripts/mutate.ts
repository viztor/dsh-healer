#!/usr/bin/env node
/**
 * Mutation testing: does the suite actually detect a broken invariant?
 *
 * Line coverage proves a line ran. It does not prove any test would fail if that
 * line were wrong. This script breaks one invariant at a time in a throwaway
 * copy of `src/` and asserts the suite goes red. A mutation that survives is a
 * gap in the tests, not a gap in the code.
 *
 * Usage:  node scripts/mutate.mjs [--verbose]
 * Exit:   0 when every mutation is caught, 1 otherwise.
 *
 * Nothing in the workspace is modified: the copy lives in the OS temp directory.
 */

import { execFileSync } from 'node:child_process';
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const verbose = process.argv.includes('--verbose');

/** One invariant, one edit that breaks it, and what should notice. */
interface Mutation {
  readonly name: string;
  readonly file: string;
  readonly find: string;
  readonly replace: string;
  readonly caughtBy: string;
}

/** The fields every entry must carry, checked before the run. */
const REQUIRED_FIELDS: readonly (keyof Mutation)[] = [
  'name',
  'file',
  'find',
  'replace',
  'caughtBy',
];

/**
 * Every mutation the gate applies.
 *
 * `find` must appear exactly once in `file` — a mutation that cannot be applied
 * unambiguously is reported as an error rather than silently skipped.
 */
const MUTATIONS: readonly Mutation[] = [
  {
    name: 'identity: return a copy instead of the input reference',
    file: 'src/engine.ts',
    find: 'messages: result.messages ?? messages,',
    replace: 'messages: result.messages ?? [...messages],',
    caughtBy: 'engine: identity preservation',
  },
  {
    name: 'engine: repair even in detection-only mode',
    file: 'src/engine.ts',
    find: '  const result = runPass(frozenRules, messages, options, true);\n      return {',
    replace: '  const result = runPass(frozenRules, messages, options, false);\n      return {',
    caughtBy: 'engine: check() reports the same findings as heal() applies',
  },
  {
    name: 'engine: shift the finding coordinates a rule reported',
    file: 'src/engine.ts',
    find: '            blockIndex,\n            ...(raw.detail === undefined ? {} : { detail: raw.detail }),',
    replace:
      '            blockIndex: blockIndex + 1,\n            ...(raw.detail === undefined ? {} : { detail: raw.detail }),',
    caughtBy: 'engine: finding coordinates',
  },
  {
    name: 'engine: keep consulting rules after a block is dropped',
    file: 'src/engine.ts',
    find: '        if (dropped) break;',
    replace: '          if (false) break;',
    caughtBy: 'engine-replace: stops consulting rules once one has dropped',
  },
  {
    name: 'engine: let a replace beat a drop',
    file: 'src/engine.ts',
    find: "    if (entry.decision.action === 'drop') return { dropped: true };",
    replace: "    if (entry.decision.action === 'drop' && false) return { dropped: true };",
    caughtBy: 'engine-replace: drop wins over replace',
  },
  {
    name: 'engine: ignore role scoping entirely',
    file: 'src/engine.ts',
    find: '  return rule.roles === undefined || rule.roles.includes(role);',
    replace: '  return true;',
    caughtBy: 'engine: role skips',
  },
  {
    name: 'engine: ignore the configured enablement override',
    file: 'src/engine.ts',
    find: '  return override === undefined ? rule.enabledByDefault : override.enabled;',
    replace: '  return rule.enabledByDefault;',
    caughtBy: 'engine: config override',
  },
  {
    name: 'engine: let a message rule see the pre-content-phase list',
    file: 'src/engine.ts',
    find: '    const list = (base ??= projectContent());',
    replace: '    const list = (base ??= messages);',
    caughtBy: 'engine: cascade into the message phase',
  },
  {
    name: 'patch: never re-mark a repaired request',
    file: 'src/patch.ts',
    find:
      '      const next: StreamOptions = { ...options, messages: healed.messages };\n' +
      '      if (markers.isMarked(options)) markers.mark(next);',
    replace:
      '      const next: StreamOptions = { ...options, messages: healed.messages };\n' +
      '      if (false) markers.mark(next);',
    caughtBy: 'patch: marker preservation',
  },
  {
    name: 'patch: clone even on the clean path',
    file: 'src/patch.ts',
    find: '      if (healed.messages === options.messages) {',
    replace: '      if (false) {',
    caughtBy: 'patch: clean-path identity',
  },
  {
    name: 'patch: forward a bare messages array instead of the options object',
    file: 'src/patch.ts',
    find: '      return original.call(this, next, prepared);',
    replace: '      return original.call(this, next.messages, prepared);',
    caughtBy: 'patch: forwards the whole options object',
  },
  {
    name: 'patch: swallow a missing seam instead of throwing',
    file: 'src/patch.ts',
    find: "      'SEAM_MISSING',",
    replace: "      'SEAM_MISSING_UNUSED',",
    caughtBy: 'patch: SEAM_MISSING guard',
  },
  {
    name: 'patch: let install wrap an already-wrapped seam',
    file: 'src/patch.ts',
    find: '  const existing = target[PATCH_MARKER] as PatchHandle | undefined;',
    replace: '  const existing = undefined;',
    caughtBy: 'patch: install idempotence',
  },
  {
    name: 'patch: never restore the original on dispose',
    file: 'src/patch.ts',
    find: '      target[seamName] = original;',
    replace: '      target[seamName] = wrapped;',
    caughtBy: 'patch: dispose restores',
  },
  {
    name: 'patch: ignore a mode conflict on a second install',
    file: 'src/patch.ts',
    find: '    if (existing.mode !== requestedMode) {',
    replace: '    if (false) {',
    caughtBy: 'patch: refuses a second install in a different mode',
  },
  {
    name: 'patch: let a stale handle clobber a newer patch',
    file: 'src/patch.ts',
    find: '      if (target[seamName] === wrapped) {',
    replace: '      if (true) {',
    caughtBy: 'patch: a stale handle does not clobber a newer patch',
  },
  {
    // The bug this reproduces: a second caller arriving while the first scan is
    // still running concludes "not found" instead of awaiting the same scan.
    // Re-creating the promise (`??=` -> `=`) does NOT reproduce it — every caller
    // still finds the harness — which is why the mutation is written this way.
    name: 'resolve-harness: let a concurrent caller conclude "not found"',
    file: 'src/resolve-harness.ts',
    find: 'function scanStore(): Promise<string | undefined> {\n  scanPromise ??= (async (): Promise<string | undefined> => {',
    replace:
      'let mutatedInFlight = false;\n' +
      'function scanStore(): Promise<string | undefined> {\n' +
      '  if (mutatedInFlight) return Promise.resolve(undefined);\n' +
      '  mutatedInFlight = true;\n' +
      '  scanPromise ??= (async (): Promise<string | undefined> => {',
    caughtBy: 'resolve-harness: the real scan path is shared',
  },
  {
    name: 'session-history: read `data` for every event, dropping tool results',
    file: 'scripts/session-history.ts',
    // Anchored on the tool/result case: `data?.message` appears in two branches,
    // so a bare anchor is ambiguous and the runner rejects it.
    find:
      "    case 'tool/result': {\n" +
      '      const message = data?.message;\n' +
      '      return message?.role === undefined ? undefined : (message as SessionMessage);',
    replace:
      "    case 'tool/result': {\n" +
      '      const message = data;\n' +
      '      return message?.role === undefined ? undefined : (message as SessionMessage);',
    caughtBy: 'session-history: keeps every role, in log order',
  },
  {
    name: 'engine: throw on a malformed message list instead of failing safe',
    file: 'src/engine.ts',
    find: '      if (!Array.isArray(messages)) return [];',
    replace: '      if (false) return [];',
    caughtBy: 'engine: fail safe on a malformed message list',
  },
  {
    name: 'engine: return a new list for a malformed input',
    file: 'src/engine.ts',
    find: '        return { messages, findings: [], applied: [], skipped: [] };',
    replace: '        return { messages: [], findings: [], applied: [], skipped: [] };',
    caughtBy: 'engine: fail safe on a malformed message list',
  },
  {
    // Zero copy: a wrapper object per message was the original design and cost
    // ~100 KB on a 2 300-message history even when nothing changed.
    name: 'engine: build a per-message wrapper (breaks zero copy)',
    file: 'src/engine.ts',
    find: "  const contentCtx = { phase: 'content' as const, messageIndex: 0, blockIndex: 0 };",
    replace:
      "  const contentCtx = { phase: 'content' as const, messageIndex: 0, blockIndex: 0 };\n" +
      '  const views: unknown[] = [];\n' +
      '  for (let i = 0; i < messages.length; i += 1) { const m = messages[i]!; views.push({ index: i, role: m.role, content: m.content, original: m }); }\n' +
      "  if (views.length !== messages.length) throw new Error('unreachable');",
    caughtBy: 'scale: a clean pass with no tool calls allocates almost nothing',
  },
  {
    // Zero copy: the fold used to run for every block even when no rule had
    // reported, allocating a fresh outcome each time (~270 KB on the real
    // history). The early-continue is what keeps it off the clean path, so the
    // mutant removes it and supplies a fresh empty array per block.
    name: 'engine: fold every block, allocating on the clean path',
    file: 'src/engine.ts',
    find:
      '      // No rule reported on this block: nothing to fold, nothing to allocate.\n' +
      '      if (decisions === undefined) {\n' +
      '        next?.push(block);\n' +
      '        continue;\n' +
      '      }\n' +
      '\n' +
      '      const outcome = foldDecisions(decisions);',
    replace: '      const outcome = foldDecisions(decisions ?? []);',
    caughtBy: 'scale: a clean pass with no tool calls allocates almost nothing',
  },
  {
    name: 'engine: ignore a content replacement whose value is undefined',
    file: 'src/engine.ts',
    find: '      if (outcome.source !== undefined) {',
    replace: '        if (outcome.replacement !== undefined) {',
    caughtBy: 'engine: replace with an undefined value',
  },
  {
    name: 'engine: treat a message replace as a drop',
    file: 'src/engine.ts',
    find: "        if (decision.action === 'replace') {\n          (replacedMessages ??= new Map()).set(position, decision.value);",
    replace: '        if (false) {\n          replacedMessages.set(view.index, decision.value);',
    caughtBy: 'engine: a message rule that replaces a whole message',
  },
  {
    name: 'patch: accept a foreign prototype in the identity guard',
    file: 'src/patch.ts',
    find: '    if (current === prototype) return;',
    replace: '    if (current !== null) return;',
    caughtBy: 'patch: seam identity mismatch',
  },
  {
    name: 'rule/tool-call-name: accept an empty name',
    file: 'src/rules/tool-call-name.ts',
    find: '  if (name.trim().length === 0) {',
    replace: '  if (false) {',
    caughtBy: 'rule/tool-call-name: empty name',
  },
  {
    name: 'rule/tool-call-name: reject a valid name',
    file: 'src/rules/tool-call-name.ts',
    find: '  return undefined;\n}\n\n/** Removal is the only repair',
    replace:
      '  return { ruleId: id, reason: "always", messageIndex: -1 };\n}\n\n/** Removal is the only repair',
    caughtBy: 'rule/tool-call-name: valid name survives',
  },
  {
    name: 'rule/tool-call-arguments: treat an array as a valid object',
    file: 'src/rules/tool-call-arguments.ts',
    find: "  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed);",
    replace: "  return typeof parsed === 'object' && parsed !== null;",
    caughtBy: 'rule/tool-call-arguments: array is not an object',
  },
  {
    name: 'rule/tool-call-arguments: drop instead of normalising',
    file: 'src/rules/tool-call-arguments.ts',
    find: '        value: { ...(block as Record<string, unknown>), arguments: NORMALISED_ARGUMENTS },',
    replace: '        value: block,',
    caughtBy: 'rule/tool-call-arguments: normalises to {}',
  },
  {
    name: 'rule/orphan-tool-result: drop a result whose call survived',
    file: 'src/rules/orphan-tool-result.ts',
    find: '  if (surviving.has(callId)) return undefined;',
    replace: '  if (false) return undefined;',
    caughtBy: 'rule/orphan-tool-result: matched result survives',
  },
  {
    name: 'rule/orphan-tool-result: guess when the set is missing',
    file: 'src/rules/orphan-tool-result.ts',
    find: '  if (!isMembershipSet(surviving)) return undefined;',
    replace: '  if (surviving === undefined) return undefined;',
    caughtBy: 'rule/orphan-tool-result: non-Set input',
  },
  {
    name: 'rule/empty-assistant-message: drop a non-empty message',
    file: 'src/rules/empty-assistant-message.ts',
    find: '  if (content.length > 0) return undefined;',
    replace: '  if (false) return undefined;',
    caughtBy: 'rule/empty-assistant-message: non-empty survives',
  },
  {
    name: 'resolve-harness: ignore the search depth limit',
    file: 'src/resolve-harness.ts',
    find:
      '    if (found !== undefined) return found;\n' +
      '  }\n' +
      '  if (depth <= 0) return undefined;',
    replace:
      '    if (found !== undefined) return found;\n' + '  }\n' + '  if (false) return undefined;',
    caughtBy: 'resolve-harness: does not descend past the depth limit',
  },
  {
    name: 'resolve-harness: match any package, not just the harness',
    file: 'src/resolve-harness.ts',
    // The anchor is the guard *plus* the call it guards, because the guard alone
    // appears twice. A template literal keeps it readable now that the formatter
    // wraps the call across lines, and makes the next reformat a readable diff
    // instead of a wall of escaped string concatenation.
    find: `    if (!pkg.startsWith(prefix)) continue;
    const candidate = fs.join(
      store,
      pkg,
      'node_modules',
      ...packageSegments(packageName),
      'lib',
      'index.js',
    );`,
    replace: `    if (false) continue;
    const candidate = fs.join(
      store,
      pkg,
      'node_modules',
      ...packageSegments(packageName),
      'lib',
      'index.js',
    );`,
    caughtBy: 'resolve-harness: ignores unrelated packages',
  },
  {
    name: 'narrow: treat an array as a record',
    file: 'src/narrow.ts',
    find: "  return typeof value === 'object' && value !== null && !Array.isArray(value);",
    replace: "  return typeof value === 'object' && value !== null;",
    caughtBy: 'narrow: isRecord',
  },
  {
    name: 'narrow: accept a non-string tag',
    file: 'src/narrow.ts',
    find: "  return typeof value === 'string' ? value : undefined;",
    replace: '  return String(value);',
    caughtBy: 'narrow: readString',
  },
  {
    name: 'config: accept a rule entry with no enabled flag',
    file: 'src/config.ts',
    find: "    if (typeof enabled !== 'boolean') {",
    replace: '    if (false) {',
    caughtBy: 'config: enabled must be a boolean',
  },
  {
    name: 'apply: return a no-op disposer that never tears down',
    file: 'src/index.ts',
    find: '  const patchDisposer = toDisposer(handle);',
    replace: '  void handle;\n  const patchDisposer = toDisposer({ dispose() {} });',
    caughtBy: 'loader: disposal restores the seam',
  },
  {
    name: 'apply: return a bare handle instead of a callable disposer',
    file: 'src/index.ts',
    find: '  return combinedDisposer;\n}',
    replace: '  return handle as unknown as Disposer;\n}',
    caughtBy: 'loader: the cordis effect contract',
  },
  {
    name: 'apply: install before checking seam identity',
    file: 'src/index.ts',
    find: '  if (service !== undefined) {\n    assertSeamIdentity(service, runtimePrototype);\n  }',
    replace: '  void assertSeamIdentity;',
    caughtBy: 'integration: seam identity mismatch',
  },
  {
    name: 'config: default strictRuleIds to false',
    file: 'src/config.ts',
    find: '  strictRuleIds: true,',
    replace: '  strictRuleIds: false,',
    caughtBy: 'config: strict defaults',
  },
  {
    // markers.ts had no mutants at all: the file was well covered by tests, but
    // the mutation gate never looked at it. A file the gate skips is a file whose
    // tests are only as good as their author's optimism.
    name: 'markers: accept a module that exports no marker functions',
    file: 'src/markers.ts',
    find: "  if (typeof isAgentLoopRequest !== 'function' || typeof markAgentLoopRequest !== 'function') {",
    replace: '  if (false) {',
    caughtBy: 'markers: refuses to run when the harness exports neither marker function',
  },
  {
    // `&&` instead of `||`: only a module missing *both* is rejected, so a module
    // missing one is accepted and fails later, somewhere less obvious.
    name: 'markers: require both functions to be missing before refusing',
    file: 'src/markers.ts',
    find: "  if (typeof isAgentLoopRequest !== 'function' || typeof markAgentLoopRequest !== 'function') {",
    replace:
      "  if (typeof isAgentLoopRequest !== 'function' && typeof markAgentLoopRequest !== 'function') {",
    caughtBy: 'markers: refuses to run when only one marker function is present',
  },
  {
    // The divergence this pins: `String(block.id)` for an id-less call puts the
    // literal "undefined" in the set, so a result referencing that string looks
    // correlated when it answers nothing.
    name: 'audit-invariants: let an id-less call provide a matchable id',
    file: 'scripts/session-history.ts',
    find:
      "      if (typeof block.id !== 'string' || block.id.length === 0) {\n" +
      '        malformedCalls += 1;\n' +
      '        continue;\n' +
      '      }\n' +
      '      ids.add(block.id);',
    replace:
      "      if (typeof block.id !== 'string' || block.id.length === 0) malformedCalls += 1;\n" +
      '      ids.add(String(block.id));',
    caughtBy: 'audit-invariants: does not let an id-less call provide a matchable id',
  },
  {
    name: 'audit-invariants: stop counting malformed calls',
    file: 'scripts/session-history.ts',
    find: '        malformedCalls += 1;',
    replace: '        malformedCalls += 0;',
    caughtBy: 'audit-invariants: counts a missing id',
  },
  {
    name: 'audit-invariants: count an id-less result as stranded',
    file: 'scripts/session-history.ts',
    find: "    if (typeof reference !== 'string' || reference.length === 0) continue;",
    replace: '    if (false) continue;',
    caughtBy: 'audit-invariants: does not count a result with no reference at all',
  },
];

/**
 * Fail fast on a malformed list.
 *
 * A hole in the array — easy to produce with a stray `},,` while adding an entry —
 * used to surface as `Cannot read properties of undefined (reading 'file')` forty
 * mutations into the run, which names neither the entry nor the mistake. The list
 * is data, so it gets validated like data.
 */
for (const [index, mutation] of MUTATIONS.entries()) {
  // `mutation` is typed as non-nullable, but a hole in the literal is exactly
  // what this loop exists to catch, so the optional chain stays.
  const missing = REQUIRED_FIELDS.filter((key) => mutation?.[key] === undefined);
  if (missing.length > 0) {
    console.error(
      `FATAL: mutation ${index + 1} is malformed (missing ${missing.join(', ')}). ` +
        'A stray comma produces an array hole; check the entry before it.',
    );
    process.exit(1);
  }
}

/**
 * Validate every anchor against the checkout before running anything.
 *
 * The loop below already reports an anchor that matches zero times or several,
 * but only once it reaches that entry — two minutes to learn that a reformat
 * moved one line. A broken anchor is a fact about the checkout, not a result of
 * the mutations before it, so it is checked up front and named immediately.
 */
for (const [index, mutation] of MUTATIONS.entries()) {
  const source = readFileSync(join(ROOT, mutation.file), 'utf8');
  const occurrences = source.split(mutation.find).length - 1;
  if (occurrences !== 1) {
    console.error(
      `FATAL: mutation ${index + 1} (${mutation.name}) anchors ${occurrences} times in ` +
        `${mutation.file}; expected exactly 1. If the file was reformatted, update the anchor.`,
    );
    process.exit(1);
  }
}

/**
 * Trees the sandbox does not need: heavy or version-control only.
 *
 * `lib/` **is** copied. It was excluded as "built output", but the suite reads
 * `lib/client.js` — the shipped client bundle is hand-written and a test asserts
 * it agrees with `src/client.ts` — so excluding it made the baseline fail with
 * nothing naming the cause. Nothing imports `lib/index.js`, so carrying it
 * cannot mask a mutation: every mutation lands in `src/`, which the tests import
 * directly.
 */
const SANDBOX_EXCLUDES = new Set(['.git', '.github']);

/**
 * Copy the repo into a temp dir so mutations never touch the workspace.
 *
 * Everything is copied except {@link SANDBOX_EXCLUDES}, rather than a
 * hand-written allowlist. The allowlist version drifted twice — first a document
 * `spec-conformance.test.ts` reads, then `locale/`, which the client dictionary
 * test reads — and each time the only symptom was "the unmutated sandbox does
 * not pass", with nothing naming the missing file. Copying by exclusion cannot
 * drift that way: a new file the suite reads is already there.
 *
 * `node_modules` is **symlinked**, not copied. The suite runs on Vitest, which
 * resolves from there, so the sandbox needs it — but copying the tree once per
 * gate is pointless when the dependencies are identical.
 */
function makeSandbox(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-healer-mutate-'));
  for (const entry of readdirSync(ROOT)) {
    if (SANDBOX_EXCLUDES.has(entry) || entry === 'node_modules') continue;
    cpSync(join(ROOT, entry), join(dir, entry), { recursive: true });
  }
  symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'), 'dir');
  return dir;
}

/**
 * Run the suite in the sandbox. Returns true when it passes.
 *
 * Through the sandbox's own `node_modules/.bin/vp`, so the run uses the pinned
 * toolchain and the sandbox's `vite.config.ts` — which is what makes a mutation
 * to a test file, or to that config, observable here.
 */
function suitePasses(dir: string): boolean {
  try {
    execFileSync(join(dir, 'node_modules', '.bin', 'vp'), ['test'], {
      cwd: dir,
      stdio: 'pipe',
      env: { ...process.env, DSH_HEAL_LLM_MODULE: undefined },
      timeout: 120_000,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * `--list` is a pure query, answered before anything is copied or run.
 *
 * `test/spec-conformance.test.ts` calls this to read the real mutant count back
 * from the gate instead of trusting a number in prose. It used to run the
 * baseline suite first — which meant the suite ran `spec-conformance`, which ran
 * this, which ran the suite: the gate recursed into itself, and the only symptom
 * was "the unmutated sandbox does not pass" after fifty seconds. A count needs
 * no sandbox, and the baseline is still enforced by every real run.
 */
if (process.argv.includes('--list')) {
  console.log(String(MUTATIONS.length));
  process.exit(0);
}

const sandbox = makeSandbox();
const survivors = [];
const errors = [];
let caught = 0;

// Baseline: the sandbox must be green before any mutation, or every result is
// meaningless.
if (!suitePasses(sandbox)) {
  console.error('FATAL: the unmutated sandbox does not pass. Fix that first.');
  rmSync(sandbox, { recursive: true, force: true });
  process.exit(1);
}

console.log(`baseline: green (${MUTATIONS.length} mutations to apply)\n`);

for (const [index, mutation] of MUTATIONS.entries()) {
  const path = join(sandbox, mutation.file);
  const original = readFileSync(path, 'utf8');
  const occurrences = original.split(mutation.find).length - 1;

  if (occurrences !== 1) {
    errors.push(`${mutation.name}: anchor appears ${occurrences} times in ${mutation.file}`);
    console.log(`??  [${index + 1}/${MUTATIONS.length}] ${mutation.name} — ANCHOR ERROR`);
    continue;
  }

  writeFileSync(path, original.replace(mutation.find, mutation.replace));
  const passed = suitePasses(sandbox);
  writeFileSync(path, original);

  if (passed) {
    survivors.push(mutation);
    console.log(`SURVIVED  [${index + 1}/${MUTATIONS.length}] ${mutation.name}`);
    if (verbose) console.log(`          expected to be caught by: ${mutation.caughtBy}`);
  } else {
    caught += 1;
    console.log(`caught    [${index + 1}/${MUTATIONS.length}] ${mutation.name}`);
  }
}

rmSync(sandbox, { recursive: true, force: true });

console.log(`\ncaught ${caught}/${MUTATIONS.length - errors.length} mutations`);
if (errors.length > 0) {
  console.log(`\nanchor errors (${errors.length}):`);
  for (const error of errors) console.log(`  - ${error}`);
}
if (survivors.length > 0) {
  console.log(`\nSURVIVORS (${survivors.length}) — these invariants are untested:`);
  for (const survivor of survivors) {
    console.log(`  - ${survivor.name}`);
    console.log(`    expected to be caught by: ${survivor.caughtBy}`);
  }
}

process.exit(survivors.length === 0 && errors.length === 0 ? 0 : 1);
