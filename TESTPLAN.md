# dsh-healer — test plan, coverage audit, and what cannot be tested

Every number here was produced by a command in §6, not estimated. The point of
this document is the third column: a suite that silently omits a check reads as
"verified" when it is not, so the limits are named rather than hidden.

**Headline: 515 tests, 46/46 mutations caught, 99.4% lines / 97.4% branches,
upstream fix verified against the real harness.**

---

## 1. What the evidence is worth

Three techniques, weakest to strongest:

| Technique            | Proves                                       | Does not prove                            |
| -------------------- | -------------------------------------------- | ----------------------------------------- |
| **Line coverage**    | the line ran                                 | that any test would fail if it were wrong |
| **Property / fuzz**  | invariants hold for inputs nobody wrote down | that the invariants are the right ones    |
| **Mutation testing** | the suite detects a _broken invariant_       | that an untested area is correct          |

Coverage alone is a floor. Mutation testing is the one that distinguishes a real
test from a test that restates the implementation, so it is the gate that matters
most here.

---

## 2. Executed results

### 2.1 Coverage

| file                     | line %    | branch %  | funcs %   | residual gap                    |
| ------------------------ | --------- | --------- | --------- | ------------------------------- |
| `src/config.ts`          | 100.00    | 100.00    | 100.00    | —                               |
| `src/engine.ts`          | 100.00    | 96.67     | 100.00    | defensive branches              |
| `src/index.ts`           | 100.00    | 95.74     | 100.00    | —                               |
| `src/markers.ts`         | 100.00    | 100.00    | 100.00    | —                               |
| `src/narrow.ts`          | 100.00    | 100.00    | 100.00    | —                               |
| `src/patch.ts`           | 100.00    | 100.00    | 100.00    | —                               |
| `src/resolve-harness.ts` | 94.22     | 88.37     | 100.00    | the async scan wrapper (see C9) |
| `src/rules/*`            | 100.00    | 100.00    | 100.00    | —                               |
| **all**                  | **99.44** | **96.39** | **96.63** |                                 |

### 2.2 Mutation testing — 46/46 caught

`node scripts/mutate.mjs` breaks one invariant at a time in a throwaway copy and
asserts the suite goes red. The mutant count is **checked, not just stated**: `scripts/mutate.mjs --list` prints
the number the gate actually applies, and a test walks every documented figure in
`README.md`, `TESTPLAN.md`, `WORKFLOW.md` and `HOW-IT-WORKS.md` against it. Three
documents carried three different stale numbers when this was added — 26, 39 and 46
for a gate with 46 — because a number in prose is only updated by someone who reads
it as a number.

The 46 mutants cover:

- **Identity**: returning a copy instead of the input reference; cloning on the
  clean path.
- **Phase order**: letting a message rule see the pre-content-phase list.
- **Precedence**: letting a replace beat a drop; consulting rules after a drop.
- **Scoping**: ignoring role scope; ignoring the enablement override.
- **Accounting**: shifting a reported coordinate.
- **The seam**: never re-marking; forwarding a bare array instead of the options
  object; swallowing a missing seam; double-wrapping; not restoring on dispose;
  accepting a foreign prototype.
- **Every rule's decisive branch**, including the ones that ship disabled.
- **The narrowing helpers and the config guards.**

Two of these were only caught after the audit found the tests were too weak (see
§3), which is the whole point of running it.

### 2.3 Fuzz / property — 400 seeds, 11 invariants

`test/fuzz.test.ts` generates malformed histories (empty/whitespace names, bad
JSON, hostile block shapes, phantom tool results) from a seeded PRNG, so any
failure is reproducible. Invariants:

| id  | invariant                                                                       |
| --- | ------------------------------------------------------------------------------- |
| I1  | no surviving tool call in an assistant message has an empty name                |
| I1b | a malformed call outside the role scope is left alone, and the skip is reported |
| I2  | no tool result is stranded                                                      |
| I3  | healing is idempotent                                                           |
| I4  | the input is never mutated                                                      |
| I5  | order is preserved; nothing invented or duplicated                              |
| I6  | every applied fix is accounted for and names a real rule                        |
| —   | `check()` is a subset of `heal()`, the only extra being the documented cascade  |
| —   | `check()` never mutates                                                         |
| —   | never throws on any generated history                                           |
| —   | output is never larger than the input                                           |

### 2.4 Scale and concurrency

- A clean 1,200-message history returns the **input reference** — no copy.
- 10× the messages costs well under 40× the time, which rules out an accidental
  quadratic (linear would be 10×, quadratic 100×).
- A poisoned history heals at the recorded position, 976 of 1,200.
- Two heals in flight, and interleaved heals, do not contaminate each other.
- Two healers over the same rules with different config stay independent.

---

### 2.5 The real cordis loader path — and two bugs it found

`test/loader.test.ts` loads the plugin the way the host does —
`ctx.plugin(module, config)` against a **real cordis Context** — rather than
calling `applyWith` with a fake context. It covers the module contract
(`name`/`inject`/`apply`), `inject: ['llm']` actually gating the load, config
resolution through cordis, and disposal through the fiber.

It found two real defects in `apply`, both of which the fake-context tests could
never have caught:

1. **`apply` returned a bare object.** Cordis reads a plugin's return value as an
   effect and rejects anything that is not a function:
   `TypeError: Invalid effect`. The plugin failed to load at all under the real
   loader while every fake-context test passed. `apply` now returns a **callable**
   disposer — the `PatchHandle` object it used to return is not callable.
2. **A test that passed for the wrong reason.** The loader cases all patch the
   same `LlmRuntime.prototype`, and Node runs cases in a file concurrently, so
   one case's install or teardown could satisfy another's assertion. They are now
   serialized with `concurrency: 1`.

A third, smaller fix: the seam-identity assertion now runs **before** the patch is
installed, so a rejected load leaves the prototype untouched instead of
installing and then failing.

**A correction to an earlier claim in this document.** While chasing the second
finding I asserted that cordis only runs a disposer _yielded_ from `ctx.effect`,
and rewrote `apply` to yield one. That was wrong. A probe against cordis 4.0.4
shows **both** a returned disposer and a yielded one are invoked on unload. The
yield-based rewrite was unnecessary and has been reverted; the real defect was
only that the return value was not callable. The mistake is recorded here because
it is exactly the kind of plausible-but-unverified reasoning this audit exists to
catch — it was caught by a mutation that survived.

One behaviour worth knowing: `fork.dispose()` returns a promise and the teardown
runs asynchronously. Callers must await it; the first version of the test did not,
and asserted against a half-torn-down fiber.

## 3. What the audit found

Five real defects, all fixed:

| #   | Finding                                                                                                    | Why it mattered                                                                                                                                            |
| --- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **All four rules threw on malformed input.** They dereferenced `input` before narrowing.                   | A throw takes down the whole request — strictly worse than reporting nothing. Violated the rule contract.                                                  |
| 2   | **The rules imported the engine.** Two of them pulled narrowing helpers out of `engine.ts`.                | A rule could not be tested without the engine, defeating the isolation the test design rests on. Helpers moved to `narrow.ts`.                             |
| 3   | **The engine's replace path was untested end-to-end.** The only replacing rule ships disabled.             | A defect there would sit dormant until someone enabled the rule.                                                                                           |
| 4   | **`noteRoleSkip`'s deduplication was dead code**, and its comment claimed a protection it did not provide. | It was called once per rule per message per phase, so it could never dedupe. Mutation testing exposed it: the mutant survived. Removed, comment corrected. |
| 5   | **A misleading test.** "reports role skips once per rule per message" passed for the wrong reason.         | It never exercised the case the comment described. Replaced with one that does.                                                                            |

Two more findings that were _not_ defects, and are now pinned:

- **The store-scan fallback can resolve a different `dsh-llm` copy** than the
  running runtime uses. `assertSeamIdentity` catches it and fails loudly — which
  is the designed behaviour, not a bug. It is why the peer dependency is the
  primary path and the scan is explicitly a development convenience.
- **`tool-call-name` does not touch a `tool-call` block in a `developer`
  message.** That is correct: the pi-ai adapter rejects developer messages
  outright (`UNSUPPORTED_CONTENT`), so a malformed name there cannot be what
  breaks a request. Widening the scope would edit a message for no reason.
  Pinned by fuzz I1b.

---

### 2.6 The complete causal chain, and the resolver

Two more evidence gaps closed after the first audit.

**`test/chain.test.ts` — the end-to-end claim, tested rather than asserted.**
Every earlier test covered one link: the assembler fabricates the bad block, the
healer removes a bad block from a fixture, the seam hands the healed request to an
adapter. **None of them connected the links.** This file feeds the real assembler
the exact chunk sequence the incident's adapter produced, takes the assistant
message the assembler actually builds, feeds _that_ into the healer, and asserts
the result is a request a provider accepts — six steps from raw stream to valid
request. That was previously true only by construction, which is the weakest kind
of truth.

**`test/resolve-harness.test.ts` — which copy gets patched.** The resolver decides
which physical `dsh-llm` the plugin patches; getting it wrong is the silent-no-op
failure the design exists to prevent. The search is now a pure function over an
injected filesystem, so it is tested against synthetic stores covering all three
dlx layouts, the depth limit, unreadable directories, and unrelated packages —
without needing any of those conditions to exist on the real machine.

**`test/manifest.test.ts` — the patch as parsed YAML.** The original checks
matched the patch as _text_. That catches a typo but cannot tell whether the
document parses, whether `insert` is a list, or whether the row has the shape the
loader reads. A patch that fails to parse is a boot failure. The file is now
parsed with a real YAML parser resolved from the store (skipping if absent), and
its `config` is fed through the plugin's own `resolveConfig` — so a patch that
parses but the plugin would reject fails here rather than at load.

### 2.7 Compensating for a missing typechecker

Two checks stand in for the typecheck that could not run this session, targeting
the errors a compiler would have caught and nothing else would.

**`test/shims.test.ts` — the hand-written `node:` types are a claim about someone
else's API.** The shims exist so the suite typechecks with no dependencies, which
is a real trade: a shim declaring a member the real module lacks, or naming it
wrongly, would let a test typecheck while the runtime call fails. The file is
parsed, every member it declares is confirmed against the installed
`@types/node`, and a ceiling on the shim surface keeps it from quietly growing
into a second, wrong copy of the standard library.

**Shape conformance in `test/chain.test.ts` — the local `MessageLike` view could
drift from the real `Message` union.** `src/types.ts` defines a deliberately
minimal structural view, which is what keeps the engine dependency-free; the risk
is that it accepts a shape the harness forbids. Healed messages are now checked
against the harness's own declaration file: every role is one the harness
declares, every `tool` message carries the required `toolCallId`, and every block
type is in the declared vocabulary.

Neither is a substitute for `tsc`, and they did **not** catch what `tsc` caught: a
three-state `null` cache whose return type did not match, plus two test-tree
errors. See T17 — the typecheck has since been run and is clean. The lesson is
that these checks narrow a gap rather than close it.

**Addendum — the gap is now closed, and it was still open where it mattered.**
The gate runs three separate strict typechecks (`typecheck:src`, `typecheck`,
`typecheck:scripts`). Adding the third was not bookkeeping: `scripts/` had been
converted to TypeScript but no config included it, so five of six scripts were
never checked. The first run found a live bug — `scripts/audit-session.ts` read
`report.fixes`, which does not exist on `HealReport` (the field is `applied`), so
`pnpm run audit:session` threw on every invocation. Nothing else would have
caught it, because that script is not part of `node --test`.

The shim ceiling in `test/shims.test.ts` remains worthwhile for the reason it was
written: the shims are still hand-written claims about `@types/node`, and a claim
nobody checks is how the suite typechecks against an API that does not exist.

## 3b. The upstream fix, verified

The root cause is upstream: `BlockAssembler.assemble()` fabricates a
`tool-call` block with an empty name from a bare `block-start`, which the stream
recorder itself refuses to store
(`assistant-stream.js:404` — `'tool-call-chunks name must be a non-empty string'`).
The full analysis is in [`upstream/REPORT.md`](upstream/REPORT.md).

A patch that has never been run is a guess, so the fix is verified:

```sh
node scripts/verify-upstream-fix.mjs
```

It builds a sandbox from the installed package, **proves the sandbox reproduces
the defect before the fix**, applies the fix to the sandbox copy only, runs the
spec, and removes the sandbox. The live DSH installation is never written to —
the first version of this script tried to patch it in place and was correctly
refused by the file sandbox, which is the outcome to design for rather than work
around.

`test/upstream-assembler.test.ts` holds the requirement. Against an unfixed
harness it reproduces the defect as evidence and **skips** the two spec cases with
an explicit reason, so the suite never passes by restating current behaviour.

## 3c. A deliberate non-decision: the plugin does not patch the assembler

Now that the root-cause fix exists and is verified, the obvious next question is
whether the plugin should apply it at runtime — patch `BlockAssembler.assemble()`
so the poison is never written, rather than repairing the request afterwards.

**Decision: no.** Three reasons, in order of weight:

1. **It is the wrong owner.** The defect is in `dsh-llm`, and a host plugin
   patching another package's core assembly algorithm is a larger claim on
   correctness than this plugin should make. The upstream patch is the right
   home and it is ready.
2. **The blast radius is worse.** The existing patch intercepts one method at the
   request boundary and is a pure projection — it cannot change what is recorded.
   Patching `assemble()` changes how the assistant message is built, which is
   upstream of persistence, replay metadata, and truncation handling. A defect
   there corrupts sessions rather than merely failing a request.
3. **The value is already captured.** The request-side repair handles both new
   and existing poison. Prevention would add a second global patch to gain
   nothing that is not already covered, while adding a second way to fail.

If the upstream fix lands, the plugin's `tool-call-name` rule stops firing on
newly-produced poison but remains correct for model-emitted empty names and for
histories poisoned before the fix — so the rule stays either way.

## 3d. Five defects found by reading, after the tests were already green

The suite was passing and the mutation score was 100% when this pass started.
These were found by reading the code against its own contract, not by a failing
test — which is the point: a green suite proves the behaviours it asserts, not
that the code is right.

| #   | Defect                                                                                                                                                                          | Consequence                                                                                                                              | Fix                                                                                                            |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| 1   | **A second load in a different mode silently kept the first.** The wrapper closes over its healer, so `install` returning the existing handle left the new configuration inert. | An operator changing `mode: check` to `mode: heal` would see **no change and no error** — the worst kind of failure for a repair plugin. | The handle records its mode; a conflicting install throws `MODE_CONFLICT`. Same-mode installs stay idempotent. |
| 2   | **A content replacement of `undefined` was silently ignored.** The guard tested `replacement !== undefined`, which conflates "no replacement" with "replacement is undefined".  | The finding was reported and **nothing changed** — the original block was pushed instead.                                                | Test `source !== undefined`, which is set only when a replace was folded in.                                   |
| 3   | **A message rule's `replace` was treated as a `drop`.** Anything not `keep` was a drop.                                                                                         | **Data loss**: a rule that explicitly asked to rewrite a message had it deleted instead.                                                 | Handle `replace` explicitly; whole-message replacements supersede content edits.                               |
| 4   | **The `mode: 'off'` handle omitted `mode`.**                                                                                                                                    | A type error the missing typecheck would have caught; a caller could not tell "nothing installed" from "installed in some mode".         | Carry `mode: 'off'`.                                                                                           |
| 5   | **The engine threw on a malformed message list.**                                                                                                                               | It runs inside the outbound path of **every** model call. A caller passing no array would get a stack trace blamed on the repair.        | Fail safe: pass the input through untouched, consult no rule.                                                  |

Two of these — 2 and 3 — are the same mistake in different places: inferring
intent from a value that cannot distinguish the cases. The third is its mirror:
treating a shared union's unhandled member as the handled one.

A sixth fix came out of the same reading: the stale-handle guard in `dispose`.
Its first test **did not reach the guard** (it disposed an already-disposed
handle, which returns early), so the guard was unverified until the mutation gate
survived it.

## 3e. Real-history validation — the closest thing to the live check

Every fixture in this repo is a handful of messages. The incident's real history
is thousands. `scripts/audit-session.mjs` derives the provider-visible history
from a real `session.v4.jsonl.zstd` and heals it, so the repair is exercised at
the size and shape it will actually meet.

It prints only counts and coordinates — never message content — so its output is
safe to paste into a report.

```
node scripts/audit-session.mjs <session.v4.jsonl.zstd> [--verbose]
```

**A scanning step first confirmed the population.** Across **227** session logs
on this machine, exactly **two** contain an empty-name tool call — the two known
occurrences. So the corpus is not hypothetical, and the two results below are the
whole of it.

| session                     | derived messages | roles                                   | before       | after               | fixes                                    |
| --------------------------- | ---------------- | --------------------------------------- | ------------ | ------------------- | ---------------------------------------- |
| `zesonet` (the incident)    | **2 325**        | 164 user / 1 054 assistant / 1 107 tool | 1 empty name | 0 empty, 0 stranded | 2 — the call **and** its stranded result |
| `zesto` (second occurrence) | **2 797**        | 1 467 user / 1 327 assistant            | 1 empty name | 0 empty, 0 stranded | 1 — the call alone                       |

Both PASS, both non-mutating and idempotent.

Two things this establishes that no fixture could:

1. **The cascade works on real data.** In the incident session the fabricated
   call _had_ been dispatched and answered, so the healer removed the call and
   then removed the now-stranded result — 2 fixes, not 1. That is the phase
   ordering doing its job at scale, on the actual history that failed.
2. **Extraction shape matters, and is easy to get wrong.** A first version read
   `data.message` for every event and produced an **assistant-only** history of
   1 054 messages — silently dropping all 1 107 tool results, which would have
   hidden the cascade entirely. The three event types differ: `user/message`
   carries the message _as_ `data`, while `assistant/message` and `tool/result`
   carry it as `data.message`. The script documents this at the point of use.

**What this still is not.** No provider is contacted. It proves the request is
_well-formed_ by the invariants a strict provider enforces; it cannot prove a
provider accepts it. That remains C1/C4.

## 3f. The specification is executable

[`HOW-IT-WORKS.md`](HOW-IT-WORKS.md) states the mechanism precisely: the seam and
why the alternatives fail, the rule contract, the engine algorithm step by step,
the identity guarantees, the lifecycle, and the failure modes.

A spec that describes behaviour the code no longer has is worse than no spec,
because it is trusted. So `test/spec-conformance.test.ts` asserts every factual
claim, organised by document section — a failure names the paragraph at fault
rather than just a function.

It is deliberately somewhat duplicative of `engine.test.ts`: those tests exist to
catch defects, these exist to catch a **document becoming wrong**. Verified to
have teeth — making a replace beat a drop fails 4 spec claims; treating a message
replace as a drop fails 1.

## 3g. The suite is no longer allowed to under-report

Five files (`integration`, `loader`, `chain`, `upstream-assembler`, `shims`) skip
when the installed `@deepseek-ai/dsh-llm` cannot be resolved. That is right for
portability and wrong for honesty: the suite could report **green while its most
valuable tests never ran**.

This is not hypothetical — it happened during this work. The pnpm dlx cache was
cleared while a running DSH host kept working from memory, the resolver found
nothing, and the count silently fell from **450 to 409 with no failure**. The
project's own warning ("a suite that silently omits a check reads as verified when
it is not") applied to the suite itself.

`test/harness-required.test.ts` now **fails** when the harness is absent, with a
message naming the five affected files and the usual cause. A machine that
genuinely has no DSH acknowledges it explicitly:

```sh
pnpm run test:no-harness      # DSH_HEAL_ALLOW_NO_HARNESS=1
```

| condition                    | tests | result                            |
| ---------------------------- | ----- | --------------------------------- |
| harness present              | 515   | pass                              |
| harness absent               | 427   | **fail**, naming what did not run |
| harness absent, acknowledged | 426   | pass                              |

## 3h. The two "unclosable" gaps were both closed

Both were reported as environmental limits. Both turned out to be reachable.

**The typecheck.** Reported as "no compiler installed, escalation disabled". A
compiler was reachable via `pnpm dlx`, and running it found **three real type
errors** that reading had missed:

1. `resolve-harness.ts` — a three-state `null`/`undefined`/`string` cache whose
   return type was `string | undefined`. TypeScript could not narrow it.
2. The same cache was a **concurrency bug**: a second caller arriving while the
   first scan was running read `undefined` — "not found" — and concluded the
   harness was absent. Verified by restoring the old code: **5 of 6 concurrent
   callers** saw "not found" while one found it. Fixed by caching the promise.
3. Two test-tree errors (an untyped `.mjs` import, and a readonly-to-mutable cast).

Both configs are now clean under `strict` + `noUncheckedIndexedAccess`.

**The harness.** Reported as "deleted while the host runs from memory". Running
`pnpm dlx` recreated the dlx cache from the pnpm content-addressable store, and
the harness came back — the five dependent files went from contributing 0 tests
to 41. Line coverage rose from 97.0% to **99.4%** as a result.

The lesson is the same one this document keeps relearning: "environmental limit"
is a hypothesis, not a finding. Both were checked rather than assumed, and both
were wrong.

## 3i. A leak form the existing audit did not catch

Every audit up to this point grepped for `/Users/`, `/home/`, `C:\Users`. All
three were clean. What they missed was the **DSH session directory encoding**,
which replaces a path's separators with dashes:

```
<a-home>/<user>/dev/<project>   ->   --<home>-<user>-dev-<project>--
```

(The example is written with placeholders because writing the real one here
would put the very thing this section is about back into the repository — which
is what happened on the first attempt, and the guard caught it.)

Three files carried that form — two documents and an earlier version of the audit
script — and every grep said clean. It leaks a username and a directory layout
exactly as much as the literal form does.

`test/no-machine-paths.test.ts` now checks both forms across every text file in
the repository, excludes itself (it necessarily contains the patterns as
samples), and **proves each pattern matches a sample of the form it claims to
catch** — because a guard that cannot fail is not a guard. Verified by injecting
both leak forms and watching it go red.

The general lesson, again: a check only covers the shapes it was written for.
"Grep says clean" means "clean of the four patterns I thought of".

## 3j. Zero copy — measured, fixed, and guarded

The requirement was "zero copy, and filter on the stream as much as possible".
Measuring first showed the claim was **false** in a way no test had caught: a
clean `heal` on the real incident history allocated far more than it should,
despite returning the input array by reference. It returned the right object and
threw away a wrapper per message on the way there.

### What the clean path allocates now

Real history, 2 342 messages, one call immediately after a forced collection,
bisected by rule set:

| rules                               | bytes  | per message |
| ----------------------------------- | ------ | ----------- |
| none                                | 984    | 0.4         |
| `tool-call-name` only (content)     | 1 648  | 0.7         |
| `orphan-tool-result` only (message) | 83 864 | 35.8        |
| both (the shipped set)              | 84 368 | 36.0        |

The engine itself is free, the content phase is free, and the **entire remaining
cost is the surviving-tool-call id set** — an index the orphan rule needs to
answer its question in one pass instead of a quadratic scan. It is a derived
index, not a copy, and it is named here rather than left to be rediscovered.

Timing on the same history: p50 clean `heal` **0.28 ms**, p50 poisoned **0.34 ms**.

### Regressions, re-measured with one method

The first version of this section mixed two measurement methods and reported
three figures that do not reproduce. Re-injecting each regression and measuring
the same way gives:

| regression                                  | measured    | note                                                        |
| ------------------------------------------- | ----------- | ----------------------------------------------------------- |
| a wrapper object per message                | **+219 KB** | the original design; reproducible                           |
| a `Map` keyed by a built string per message | **+407 KB** | the largest single cost found                               |
| a fresh fold outcome per block              | +56 B       | V8 eliminates it; **the earlier "~270 KB" claim was wrong** |
| a role-skip entry per message               | +344 B      | V8 eliminates it; **the earlier "~40 KB" claim was wrong**  |

The last two are still worth having, but for a different reason than the one
first written down: the role-skip aggregation turns **2 498 diagnostics into 6**,
which is a reporting fix, not an allocation fix. Keeping the wrong justification
next to a correct change is how a codebase acquires folklore.

The method matters more than the number. The original guard measured total heap
growth across many runs — which measures _retained_ growth, because short-lived
garbage is collected mid-run. A per-message wrapper vanished from that figure
entirely and the guard passed against a deliberately injected regression. The
working measure is one call immediately after a forced collection.

### The guard

`test/scale.test.ts` runs on a **tool-call-free** history, where the honest cost is
a few hundred bytes and a wrapper would cost ~80 KB — an order of magnitude either
way. It is verified by injecting the wrapper and watching it fail.

## ## 3n. Eleven tests were silently not running

The availability guard (§2.5) exists because the suite once fell from 450 tests to
409 with no failure: the harness became unresolvable, five files skipped, and the
suite stayed green. The guard was written to make that a failure instead.

It happened again, in a way the guard could not see. `integration.test.ts` carried
its **own** store scan, looking for the pnpm store at a fixed one level below each
dlx root. The real layout is deeper:

```
<root>/<hash>/<version>/node_modules/.pnpm      <- where it actually is
<root>/<entry>/node_modules/.pnpm               <- where it looked
```

So `integration` found nothing, `HARNESS` came back `undefined`, and the whole file
skipped — while `harness-required.test.ts`, which scans with `searchForHarness`,
found the harness and reported it present. **Eleven tests did not run and the suite
was green.**

Found by running the suite in a clean room and diffing the test names:

```sh
env -u NODE_PATH node --test test/     # 457 tests
node --test test/                      # 468 tests
```

The 11-test gap was invisible in a normal shell because `NODE_PATH` is set by the
DSH host, which let `createRequire` resolve the harness and hid the broken scan
entirely.

### The fix is one resolver, not one patch

Six files each carried their own scan, with at least three different depths and
root lists. `src/resolve-harness.ts` now exposes `resolveHarnessEntry(packageName,
innerPath, fs, homedir)`, and every harness-dependent file calls it — including the
guard itself, so the guard's claim and the tests' behaviour cannot disagree.

Package names are fully qualified (`@deepseek-ai/dsh-llm`). A bare `dsh-llm`
encodes to the wrong store prefix and silently finds nothing, which is the same
class of bug in miniature.

### The guard

A structural check, because the defect is structural: no test file may name the dlx
roots. If a file needs a path inside the installed harness it calls the shared
resolver, or the test fails. Verified by reintroducing a root literal into
`chain.test.ts` and watching it fail.

Both environments now agree exactly — 470 tests, 468 passing — with and without
`NODE_PATH`.

## 3m. The offline projection, checked against the harness's own

Every offline claim in this file — the message counts, the cascade, the fix counts
— rests on `scripts/session-history.mjs`. It is a **reimplementation** of the
harness's `deriveEventMessage`, written by reading the event shapes. Nothing was
comparing the two.

Comparing them found a real omission. On the incident session:

```
harness projection : 2343 messages  {system:10, user:166, assistant:1057, tool:1110}
mirror projection  : 2333 messages  {           user:166, assistant:1057, tool:1110}
```

Ten `system/message` events were dropped, and `developer/message` was not handled
at all. Every message the mirror _did_ read was **byte-identical** to the
harness's — 0 differences across 2 333 messages — which is precisely why nothing
caught it: the failure was an omission, and omissions do not announce themselves.

The mirror now handles `system/message` and `developer/message`, and drops an
assistant message whose content is empty, matching the harness's own rule. Both
projections now agree exactly: 2 343 = 2 343, role sequences identical.

`test/session-history.test.ts` pins this with a shape fixture covering every
branch, and asserts message-for-message equality against the real harness when it
is installed. Verified by reintroducing the omission and watching it fail.

The corrected counts ripple: the incident session is 2 343 messages, not 2 333,
and the second session 2 797, not 2 794. The zero-copy measurements and the live
acceptance window were re-run rather than relabelled.

## 3k. The bundle patch, composed by the real loader

`test/manifest.test.ts` proves the patch parses as YAML and that its config passes
the plugin's own schema. It cannot prove the **DSH loader** accepts it — that the
patch dialect is right, that the row lands where it should, and that the composed
tree is what a host would mount.

The CLI can, without mounting anything and therefore without a model call:

```sh
dsh --profile web --patch ./cordis.patch.yml --dump-config
```

`--dump-config` composes the profile tree and exits. Against the real `web`
profile, the output ends with:

```
# == <this repo>/cordis.patch.yml
- id: dsh-healer
  name: dsh-healer
  config:
    mode: heal
    onFindings: log
    strictRuleIds: true
```

So the patch is accepted by the loader, attributed to this file, and composed as a
row. This is a **manual** check rather than a test because it needs a DSH
installation and a profile, neither of which is guaranteed on a contributor's
machine — the same reason `test/harness-required.test.ts` exists.

It is not a mount. It proves the patch is valid and lands; it does not prove the
plugin's module resolves inside a host, that `inject: ['llm']` is satisfied there,
or that a real request heals. Those remain C4.

## 3l. Live acceptance — a real provider, a real poisoned history

This is the check that closes the loop. Everything else proves the repair against
fakes, against the real seam with a fake adapter, or against real histories
offline. Here the provider itself decides.

`scripts/live-acceptance.mjs`, against the real incident session (2 343 messages),
a window centred on the defect, and Anthropic Messages served locally:

```
defect       : message 30, block 3, call id "call-3"
healer       : 2 fix(es) — tool-call-name@30/drop, orphan-tool-result@31/drop
ok   1 original             HTTP 400
ok   2 result removed only  HTTP 400
obs  3 call removed only    HTTP 200   <- the finding
ok   4 both removed (heal)  HTTP 200
ok   5 heal is idempotent   HTTP 200
```

### The finding: the second half of the cascade is protocol-dependent

The first run asserted that a stranded tool result is fatal — the assumption
`orphan-tool-result` is justified by — and the provider **accepted** it. Only the
empty tool name is fatal for Anthropic Messages.

That claim was in two places (`src/rules/orphan-tool-result.ts`, `README.md`) as
"would produce a fresh 400". Both are corrected. The rule stays enabled, because
OpenAI-compatible protocols reject an unmatched tool result **by contract** (each
assistant `tool_calls` entry must be answered by a matching `tool` message) and
because a history where a result answers no call is internally inconsistent — but
neither of those is verified by this endpoint, and the check no longer pretends
they are. Step 3 is reported as an observation, not an assertion.

This is the third time in this work that running the thing contradicted what the
documentation said. It is also the reason the decomposition exists: a single
"poisoned 400, healed 200" pair would have passed, confirmed the wrong belief, and
left the false claim in the README.

### Two independent real incidents

Both real poisoned sessions were run, and they have different shapes:

| session | messages | fixes                                       | step 3                                                        |
| ------- | -------- | ------------------------------------------- | ------------------------------------------------------------- |
| one     | 2 343    | 2 — `tool-call-name` + `orphan-tool-result` | applicable (stranded result present)                          |
| two     | 2 797    | 1 — `tool-call-name`                        | **not applicable** — the fabricated call was never dispatched |

The second session is why the stranded-result check is conditional rather than a
precondition. A poisoned session without a stranded result is a different shape,
not a broken one, and the script used to skip it entirely — which would have
hidden the fact that the healer handles both shapes correctly.

### Why a window

The full 2 343-message history is 6.7 MB and exceeds the provider's 1M-token
limit, so both requests return 400 for size and the experiment proves nothing.
The first live run did exactly that and was reported as INCONCLUSIVE rather than
as a pass. A window centred on the defect keeps the poison, its stranded result,
and enough surrounding history to be well-formed otherwise.

### Running it

```sh
DSH_SESSION_LOG=<session.v4.jsonl.zstd> node scripts/live-acceptance.mjs
```

It skips with an explanation when there is no session log, and it is deliberately
not part of `node --test`: it needs a live endpoint and a real session, neither of
which a contributor is guaranteed to have.

## 3o. The leak guard was rejecting the house style

`test/no-machine-paths.test.ts` flags `/home/<name>/` as a Linux home path. The
global instructions tell contributors to write exactly that form as a **neutral
placeholder**:

> In prose and examples, use a neutral placeholder — `/home/you/projects/my-app`

So the guard was failing on the style the repository is told to use. It surfaced
when a new resolver test used `/home/u/...` for a synthetic home and the guard
reported three machine paths in a file that contains none.

A guard that rejects its own house style is a guard somebody disables, so the fix
is in the guard: an explicit placeholder allowlist (`you`, `user`, `u`, `me`,
`name`, `example`, …) checked against the captured home segment.

`someone` is deliberately **not** on that list. It is the realistic-looking sample
the self-proof uses, and a name that is both allowed and used as a positive sample
would make the proof vacuous.

Two tests pin the boundary: one asserts every real form is still flagged, the other
asserts the documented placeholder forms are not. Verified by injecting all three
real leak forms into `README.md` — each one still fails the guard.

## 3p. The availability guard covered one package out of seven

`harness-required.test.ts` asserts that `@deepseek-ai/dsh-llm` resolves, and its
failure message names the five files that would contribute nothing without it. That
was accurate when it was written and is no longer complete: six more packages are
resolved from the same store, and a file that cannot find its package skips
silently — the same failure, pointed at a different package.

| package                                         | files it would take down                              |
| ----------------------------------------------- | ----------------------------------------------------- |
| `@deepseek-ai/dsh-llm` `lib/index.js`           | integration, loader, chain, shims, upstream-assembler |
| `@deepseek-ai/dsh-llm` `lib/types/assembler.js` | chain, upstream-assembler                             |
| `@deepseek-ai/dsh-llm` `lib/types/message.d.ts` | chain                                                 |
| `@deepseek-ai/dsh-session`                      | session-history                                       |
| `@deepseek-ai/cordis`                           | loader                                                |
| `@types/node`                                   | shims                                                 |
| `js-yaml`                                       | manifest                                              |

Each is now asserted individually, and each failure names what stopped running rather
than only what went missing. Verified by pointing one entry at a path that does not
exist and watching it fail.

## 3q. The mutation gate was skipping a file

`src/markers.ts` had **no mutants**. Its tests were thorough — the failure paths are
covered, including a module exporting only one marker function — but the gate never
looked at the file, so "43/43 caught" was really "43/43 of the files the gate <!-- count-exempt: a past state -->
happens to name".

Two mutants added, both caught:

- accept a module exporting no marker functions (the guard never fires)
- require _both_ functions to be missing before refusing (`||` becomes `&&`, so a
  module missing one is accepted and fails later, somewhere less obvious)

The list is now checked for holes at startup. A stray `},,` while adding an entry
used to surface as `Cannot read properties of undefined (reading 'file')` forty
mutations into the run, naming neither the entry nor the mistake; it now fails
immediately with `mutation 42 is malformed (missing name, file, ...)`. Verified by
injecting the hole.

The broader point is the same one as §3n and §3p: a gate's coverage is a claim, and
"every mutant is caught" says nothing about the code no mutant targets.

## 3r. The script that produced every offline number was untested

`scripts/audit-session.mjs` is where "2 343 provider-visible messages, 2 fixes
applied, PASS" comes from — the number quoted throughout this file. Its invariant
check was an inline, unexported, untested function. Nineteen tests and three
mutants later it is a tested export, `auditInvariants` in `session-history.mjs`.

It is deliberately an **independent** implementation from the rules, because its job
is to cross-check them and sharing the code would make the check circular. That
makes testing it more important, not less: an independent implementation nobody
verified is a second opinion with no credentials. A test now asserts the two agree
on every case where they overlap, including the real cascade.

### The divergence, and how narrow it turned out to be

The original collected ids with `ids.add(String(block.id))`, so an id-less call put
the literal string `"undefined"` into the set. The rules skip unusable ids. Working
through the cases, the two implementations differ in **exactly one** situation: a
call with no id paired with a result whose reference is the literal string
`"undefined"`.

That is contrived, and it is worth saying so rather than dressing it up. The fix is
correct and the test pins it, but the honest finding here is not the divergence — it
is that a script producing published numbers had no test at all.

### A vacuous test, caught by checking

The first version of the divergence test asserted that an id-less call and an id-less
result are not paired. That is true of **both** implementations, because the result
side skips an absent reference either way — so the test passed against the
reintroduced bug. It now asserts the one case that actually differs, and fails when
the bug is put back.

## 3s. Consolidating the resolver broke a feature no test covered

The "one resolver" commit migrated five test files onto `resolveHarnessEntry`. It
also silently dropped the environment overrides from one of them.

`upstream-assembler.test.ts` used to honour `DSH_HEAL_ASSEMBLER_MODULE` and
`DSH_LLM_MODULE`, which `scripts/verify-upstream-fix.mjs` sets to point the
specification at a patched sandbox copy. After the migration it ignored both, so the
verifier applied the fix to the sandbox and then tested the live harness — and
reported FAIL on a fix that works.

Nothing caught it, because **the verifier is not part of `node --test`**. The suite
stayed green for two commits while the script that validates the upstream fix was
broken. It was found by running the verifier by hand, which is exactly the sort of
thing that stops happening.

### The lesson, stated plainly

Consolidating a resolver means keeping **every input it had**, not only the ones the
suite exercises. Two overrides were invisible to the suite and load-bearing for a
script outside it.

### The guard

A structural check that each resolver still reads its override:

| file                         | override                                      |
| ---------------------------- | --------------------------------------------- |
| `upstream-assembler.test.ts` | `DSH_HEAL_ASSEMBLER_MODULE`, `DSH_LLM_MODULE` |
| `integration.test.ts`        | `DSH_HEAL_LLM_MODULE`                         |
| `session-history.test.ts`    | `DSH_SESSION_MODULE`                          |
| `harness-required.test.ts`   | `DSH_HEAL_LLM_MODULE`                         |

It is weaker than a behavioural test and is written down as such — the real coverage
for those paths is the verifier itself. Verified by renaming one override and
watching the guard fail.

`scripts/verify-upstream-fix.mjs` also carried the **fourth** independent copy of the
store walk. It now uses the shared resolver too.

## 3u. A gap that was not a gap — adding the rule was the wrong fix

A previous pass found what looked like a real defect: the audit treats a tool call
with no usable id as a violation (`malformedCalls`), and no rule repaired it. A rule
`tool-call-id` was written, shipped, tested, and given four mutants.

**It was reverting that fixed the problem.** The gap was in the _report_, not the
healer.

### What the evidence says

Every session log on the development machine, 243 of them:

```
tool-call blocks : 86,322
NO usable id     : 0
id provenance    : {provider-issued: 86,319, synthesised call-N: 3}
```

And structurally there is no path to one: the adapter assigns provider ids, and the
assembler's fallback for a block that never received one is `call-${index}` — which
carries an id. Every tool-call block that can reach the healer has one.

### Why the rule was the wrong answer

`tool-call-id` could never fire on real data. It was not defence in depth; it was a
rule that no one can ever exercise, costing a pass over every assistant block, a
test file, four mutants, and a plausible-looking entry in the rules table that
suggests a failure mode that does not exist.

The instinct behind it was reasonable and wrong in the same way: _"the audit names a
violation, so the healer must repair it."_ The premise is the error. The audit is a
**diagnostic**, not a specification — and a diagnostic that reports a state the system
never produces is not incomplete, it is over-specified.

### What the report should say instead

`scripts/audit-session.mjs` now separates the two:

- `emptyNames` and `strandedResults` are the plugin's **subject** — what the rules
  exist to repair. The verdict depends on them.
- `malformedCalls` is a **canary**. It is still reported, because a non-zero value
  would mean the log shape is outside what this plugin models and that is worth
  knowing — but it no longer fails the audit, and it no longer implies a rule should
  exist.

### The scope, stated

This plugin repairs **provider-visible histories corrupted by the assembler**. The
defects it exists for are the ones observed in the wild: a fabricated tool call with
an empty name, and the stranded result that removing it would otherwise create. It
does not handle arbitrary malformed input, and inventing rules for shapes the
corruption cannot produce is scope creep dressed as thoroughness.

The orphan rule is the one place where the scope is deliberately a little wider than
the observed incident: a stranded result is protocol-dependent rather than
demonstrably fatal on the tested protocol (TESTPLAN §3l), so it is kept on the
OpenAI-compatible contract and on history consistency, not on evidence from this
machine.

## 4. Testable but not tested — recommended

| #   | Gap                                                        | Cost                                                                                                                                                                                                                                                                                                                                                                        | Value                                                         |
| --- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| T15 | `resolveRuntimePrototype`'s "no `LlmRuntime` export" error | small                                                                                                                                                                                                                                                                                                                                                                       | low — needs a fake harness exporting everything but the class |
| T16 | Cross-platform behaviour (Linux, Windows)                  | needs CI runners                                                                                                                                                                                                                                                                                                                                                            | medium — `os.homedir()` and path handling differ              |
| T17 | ~~Typechecking~~ **CLOSED**                                | A compiler was reachable after all (`pnpm dlx --package=typescript`), and running it found **three real type errors** that reading had missed: a three-state `null` cache in `resolve-harness.ts` whose return type was `string \| undefined` (also a concurrency flaw — two callers would not share a scan), plus two test-tree errors. All fixed; both configs are clean. | —                                                             |

## 5. Cannot be tested here

| #   | Cannot test                                        | Why not                                                                                                                                                                                                                                                                                                                                                                                                                                                | What would close it                                                                                     |
| --- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| C1  | **That a real provider stops returning 400**       | Needs a live credentialed endpoint. The incident's 400s came from `antigravity` and `opencode`; reproducing them means sending a malformed request to a paid provider.                                                                                                                                                                                                                                                                                 | One live request per provider against the poisoned fixture. **Recommended as a manual pre-ship check.** |
| C2  | **The exact wire bytes per provider**              | Would need each adapter plus network capture. `cross-model.test.ts` models the mapping, but that is our reimplementation, not the adapter's.                                                                                                                                                                                                                                                                                                           | Adapter-level golden tests in `dsh-llm-pi-ai`, upstream.                                                |
| C3  | **That the assembler stops fabricating the block** | That is the upstream defect. This plugin cleans up after it; it cannot fix or test the cause.                                                                                                                                                                                                                                                                                                                                                          | The upstream patch in `BlockAssembler.assemble()`.                                                      |
| C4  | **A real DSH session end to end**                  | **Closed by §3l, with one honest caveat.** A real provider now rejects the poisoned history (400) and accepts the healed one (200), with the empty tool name isolated as the fatal defect. Still not exercised: the real agent loop and session store driving the request, as opposed to the plugin's own output being sent. The cordis-Context test, the real-prototype integration test, and the loader's patch composition cover the mounting path. | None required.                                                                                          |
| C5  | **HMR / double-`apply` under the real loader**     | The loader's _reload_ path is not reproducible in a unit test. **Partly closed:** two loads of the same plugin through a real context are asserted to produce one wrap, and disposal through the fiber is asserted to restore the seam.                                                                                                                                                                                                                | Load the profile, trigger `patchReload`, confirm one wrap.                                              |
| C6  | **That session titling still works after a heal**  | The consumer is live in the `web` profile, but proving it needs a session that produces a title. We prove the mechanism: the marker survives, checked with the harness's own predicate.                                                                                                                                                                                                                                                                | A live session asserting a title appears on a healed request.                                           |
| C7  | **Provider tolerance for `content: []`**           | The disabled empty-message rule depends on it, and it was explicitly deferred (D-14). Unknown per provider.                                                                                                                                                                                                                                                                                                                                            | A documented per-provider probe matrix.                                                                 |
| C8  | **A provider that accepts the poisoned block**     | The tolerant route (`opencode/space-bunny-free`) is an observation from one incident, not a contract.                                                                                                                                                                                                                                                                                                                                                  | Live probing.                                                                                           |
| C9  | **The dlx store scan's real layout**               | The layout is not a contract and has already appeared in three shapes; the scan is a development fallback. Its failure is loud, not silent.                                                                                                                                                                                                                                                                                                            | Not worth testing; keep the loud guard.                                                                 |

## 6. Commands

```sh
node --test test/                                   # 347 tests
pnpm run ci                                         # the gate: typechecks + suite + upstream
pnpm run ci:full                                    # adds the mutation gate
pnpm run test:coverage                              # coverage table
node scripts/audit-session.mjs <log>                # a real session, offline
pnpm run accept:live                                # a real session, real provider
```

### What is in the gate, and why the upstream verifier moved into it

`pnpm run ci` runs the typechecks, the suite, **and `test:upstream`**. The verifier
used to live only in `ci:full`, and that cost two commits: a resolver consolidation
dropped the environment overrides the verifier depends on, the verifier broke, and
`node --test test/` stayed green the whole time because the verifier is not part of
it.

It costs 0.5 s, against 1.6 s for the suite. A check that is not in the gate is a
check that is already broken — you just do not know it yet.

`pnpm run ci:full` adds the mutation gate, which is slow (one suite run per mutant,
46 of them) and belongs on a pre-merge run rather than on every save.

Two checks remain outside every gate because they need things a contributor may not
have, and both skip with an explanation rather than failing:

| script                        | needs                                  |
| ----------------------------- | -------------------------------------- |
| `scripts/audit-session.mjs`   | a real session log                     |
| `scripts/live-acceptance.mjs` | a real session log and a live provider |

## 7. Coverage as a gate

The gate is **not** a percentage. It is:

1. every mutation caught — otherwise an invariant is untested;
2. every gap in §5 named in writing — otherwise the suite overstates itself.

A new rule is not done until it has a mutant that dies.
