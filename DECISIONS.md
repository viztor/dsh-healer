# dsh-healer — technical decisions, evidence, and evaluation

This document reviews [`SPEC.md`](SPEC.md) against the **installed** DSH source
(`0.2.0-rc.2`) and the **real** incident session logs, then evaluates every
technical decision point with alternatives and a decision.

Verification was performed by reading the shipped bundles in the pnpm dlx cache
and the session logs under `~/.dsh/sessions/`. Every claim below carries a
`path:line` citation or a log citation. Claims that could not be verified are
labelled **inference**.

Status: **spec reviewed; design amended.** The corrections in §B and the amended
definition of done in §D are requirements, not suggestions — three of the twelve
corrections fix defects that would otherwise ship.

---

## 0. Verification summary

### 0.1 Seam claims — CONFIRMED

| Spec claim                                                         | Verdict                                                           | Evidence                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------ | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `streamWithRegistration` is the single funnel for both call paths  | **CONFIRMED**                                                     | `dsh-agent-loop/lib/index.js:1072` — `preparedCall?.stream(request) ?? this.loopCtx.llm.stream(request)`; both reach `dsh-llm/lib/index.js:2370`                                                                                                                                                                                                              |
| The waterfall's final callback ignores listener return values      | **CONFIRMED**                                                     | `dsh-llm/lib/index.js:2371` — `() => this.adapterStream(options, prepared)` closes over `options`; `cordis/lib/index.js:317-325` — a listener's return value is the chain's result but cannot substitute `args`                                                                                                                                               |
| Messages are deeply frozen before dispatch                         | **PARTIALLY** — true for the loop paths, **false** for compaction | `dsh-agent-loop/lib/index.js:1263-1268` — `deepFreeze(message)`, `Object.freeze(boundaryMessages)`, `markAgentLoopRequest(Object.freeze({...}))`. But `dsh-compaction-basic/lib/index.js:305-322` builds a plain unfrozen object and passes it to `ctx.llm.stream(options)` at `:323` → see D-4a                                                              |
| `registerAdapter` throws `DUPLICATE_ADAPTER` for an owned provider | **CONFIRMED**                                                     | `dsh-llm/lib/index.js:1863` (in `prepareRoutes`), reached from `registerAdapter` at `:1833`                                                                                                                                                                                                                                                                   |
| `LlmRuntime` is exported named and default                         | **CONFIRMED**                                                     | `dsh-llm/lib/index.js:2390` — `LlmRuntime, LlmRuntime as default`                                                                                                                                                                                                                                                                                             |
| The retry policy excludes `INVALID_REQUEST`                        | **CONFIRMED**                                                     | `dsh-llm/lib/types/retry-policy.js:15-21`; live `policyKey` in the incident log reads `["normal",5,["EMPTY_RESPONSE","RATE_LIMIT","SERVER","TIMEOUT","TRANSPORT"],500,10000,0.1]`                                                                                                                                                                             |
| The prototype patch reaches the live class instance                | **CONFIRMED**                                                     | `createRequire` from the `web` profile root resolves `@deepseek-ai/dsh-llm` to the same physical file the base bundle loads. Only the base bundle instantiates the `llm` service; the `LlmRuntime` inlined into `dsh-repeat-tool-reminder/lib/index.js:799` is **dead code** (that module exports only `Config, apply, name` at `:1597`)                      |
| Options replacement is structurally impossible at the waterfall    | **CONFIRMED empirically**                                         | `cordis/lib/index.js:317-325` — `next` declares **no parameters**, so `next(newOptions)` discards its argument and downstream listeners plus the inner callback all receive the original `args`. Verified against real cordis 4.0.4: a listener calling `next({replaced:true})` left both the next listener and the inner callback seeing the original object |
| A listener must be `{ global: true }` to observe all calls         | **CONFIRMED**                                                     | `cordis/lib/index.js:258-264` filters by isolate scope; `LlmRuntime` extends `Service`, which defines the filter symbol (`:1785-1787`) → see D-7a                                                                                                                                                                                                             |

The chosen seam is therefore **correct and necessary**. No alternative seam
exists that can replace `options` before dispatch (§C).

### 0.2 Incident claims — PARTIALLY CONFIRMED, root cause corrected

| Spec claim                                                                              | Verdict                          | Evidence                                                                                                                                                                                                                                                |
| --------------------------------------------------------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Poison at seq 4810, block `{"type":"tool-call","id":"call-3","name":"","arguments":""}` | **CONFIRMED**                    | `~/.dsh/sessions/<project>/session-a6471351-808c-4722-8307-5db9535ea701/session.v4.jsonl.zstd`, line 4812                                                                                                                                               |
| Last `compaction/end` at seq 4745; nothing removed it                                   | **CONFIRMED**                    | 50 `compaction/end` events, last at seq 4745; zero after 4810                                                                                                                                                                                           |
| Never pruned; still present                                                             | **CONFIRMED**                    | block still on line 4812                                                                                                                                                                                                                                |
| Block at message index 975                                                              | **CONFIRMED**                    | 0-based over `user/message` + `assistant/message`                                                                                                                                                                                                       |
| "153 messages after it"                                                                 | **STALE**                        | the log has since grown to 1218 messages; the block's index is still 975, but 242 messages now follow. Label it a snapshot                                                                                                                              |
| `content.3` matches the block position                                                  | **CONFIRMED**                    | block index 3 in the message                                                                                                                                                                                                                            |
| "Every subsequent request re-sent it and was rejected"                                  | **FALSIFIED**                    | 18 `assistant/attempt` events after seq 4810: 11 errors, **7 successes**. Turns 17–20 succeeded on `opencode/space-bunny-free` with the poison still in history                                                                                         |
| Provider strictness table                                                               | **CONFIRMED**, one route missing | antigravity → `messages.115.content.3.tool_use.name: Field required`; opencode/muse-spark → `` `name` must be non-empty ``; opencode/space-bunny-free → passes. Missing: `opencode-go/space-bunny-free` failed with an unrelated `Model is unavailable` |
| "A model once emitted a degenerate tool call"                                           | **PARTIALLY FALSIFIED**          | see §0.3                                                                                                                                                                                                                                                |

### 0.3 Corrected root cause — this changes the fix strategy

The persisted block was **not** a verbatim model emission. It was **fabricated by
the harness's block assembler** from a bare `block-start` that never received a
name.

`dsh-llm/lib/types/assembler.js:100-105` (duplicated in the bundled
`dsh-llm/lib/index.js:1031-1036`):

```js
case 'tool-call': return {
    type: 'tool-call',
    id: partial.toolCallId ?? brandString(`call-${index}`),
    name: partial.toolCallName ?? '',
    arguments: partial.toolCallArguments,
};
```

In the incident stream, `block-start {index:3, blockType:'tool-call'}` is present
with **no `tool-call-delta` and no `block-end`** for index 3, so
`partial.toolCallId` and `partial.toolCallName` were never set. The block fell
out as id `call-3` — literally `call-${index}` — with `name: ''` and
`arguments: ''`. A second, independent occurrence was confirmed in a different
session (`zesto`), at log line 7363, event seq 7361, id `call-1` — and it is
**not** quite identical, which is instructive: there a **valid** tool call
(`call_1930875`, name `bash`) sits in the same message as the fabricated one, and
`source.replayState.blocks` records two `tool-call` entries with no fields at all.
So the defect can appear alongside a healthy call in one assistant message, and a
rule that dropped the whole message would destroy a real invocation. It is also
why the fixtures carry both occurrences.

> **Methodology note (a real near-miss).** An initial search for the second
> occurrence reported zero hits, because it looked only for files named
> `session.v4.jsonl.zstd` and matched the literal string `"name":""`. Both were
> wrong: the zesto payload is the **v4 event format stored in a file named
> `session.v3.jsonl.zstd`**, and its JSON has spaces after the colons
> (`"id": "call-1", "name": ""`). Only tolerant `JSON.parse` over every session
> file finds it. Literal grep over a guessed filename is not evidence of absence.

The accumulator **deliberately permits** this: `dsh-llm/lib/types/assistant-stream.js:70-73`

```js
if (chunk.id.length === 0 || chunk.name === '') {
  this.records.push({ type: 'chunk', time, chunk });
  return timed;
}
```

The harness already declares a non-empty-name invariant, but only for packed
records, and this branch routes around it —
`assistant-stream.js:404`: `throw new TypeError('tool-call-chunks name must be a non-empty string')`.

**Consequence for the plan.** The durable defect lives in
`BlockAssembler.assemble()` and the accumulator's empty-name escape hatch — **not**
in `buildRequest` validation, which is where SPEC.md §8 proposes landing the
upstream fix. A validation rule in `buildRequest` would convert a malformed
request into a loud local failure while still leaving the assembler free to
fabricate empty-name calls. The upstream fix must be re-targeted (D-11).

### 0.4 What the incident actually implies for the rules

- **The call was not an orphan.** The harness _dispatched_ the fabricated call
  and got a result — `seq 4812`, `toolCallId: "call-3"`, content
  `Error: unknown tool ""`, `isError: true`, code `UNKNOWN_TOOL`. So
  `orphan-tool-result` never fires on the primary defect; it fires **only as a
  cascade** after `tool-call-name` drops the call. This is precisely why the
  content-then-message phase ordering is structurally required (§D-5): without
  the orphan rule, dropping the call would strand a `role:"tool"` message and
  produce a _new_ 400.
- **`arguments: ""` was never the cause of any observed 400.** Every observed
  error names only `name`. Additionally the adapter already normalizes bad
  arguments: `dsh-llm-pi-ai/lib/index.js:27-34` `parseArguments` tolerates
  malformed JSON with `{}`, and `:1547-1556` re-serializes via
  `JSON.stringify(...)`, so the wire can never carry `arguments: ""`. The
  `tool-call-arguments` rule therefore duplicates existing tolerance (§D-8).
- **`tool_use` is never in the internal message list.** `ContentBlockMap`
  (`dsh-llm/lib/types/types.d.ts:114-122`) has no such key; the string occurs 0
  times in the incident session. The spec's §7 fuzz invariant phrased in terms of
  `tool_use` names the wrong vocabulary.
- **No client-side name validation exists anywhere on the request path.** The
  premise holds: the harness relies entirely on the provider. The one existing
  name invariant is bypassed by the very path that produced the poison.

---

## A. Decision register

Legend — **D-n** decision · **Decision** what to do · **Why** the deciding
evidence · **Rejected** the alternative and the reason it lost.

### A.1 Where to repair — layer

**D-1 · Repair the outbound request, never the stream.**
**Decision:** keep SPEC §2. Transform `options.messages` immediately before
dispatch; do not touch the chunk iterator.
**Why:** the defect is a request-shape defect; a 400 is returned before
inference (`inputTokens: 0, outputTokens: 0` at seq 4837), so no response-side
fix can reach it. Chunk filtering cannot repair a rejected request.
**Rejected:** stream-chunk rewriting. It requires buffering, which by
construction impairs first-token latency, and it targets the wrong layer.

**D-1a · History is preserved verbatim — and this is structurally guaranteed,
not merely asserted.**
**Decision:** keep SPEC §3. The repair produces a new message list for the
outbound request only; the session log, its projections, and every persisted
event stay byte-identical.
**Why the guarantee holds — verified:** `session.deriveMessages()`
(`dsh-session/lib/index.js:1554-1567`) returns a **fresh array** (`[...this.derived]`)
whose elements are either the log's own frozen event data or frozen derived
copies; the doc comment states the log cannot be mutated through either form. Its
only caller is `dsh-agent-loop/lib/index.js:1262` — nothing writes a request back
into the log. The patch sits strictly downstream of that derivation, so a healed
list has no path back to persistence. This is why "already-poisoned sessions are
still fixed": the repair re-derives from the untouched log on every request.
**Rejected:** repairing at write time (once, when the assistant message is
recorded). It would destroy the forensic record of the degenerate generation and
would not fix sessions already poisoned — the exact population this plugin exists
to rescue.
**Rejected:** treating the guarantee as a comment. It is asserted by a test that
hashes the fixtures before and after a heal (WORKFLOW N20) and by a live-session
byte-comparison in the release gate (G1).

**D-2 · The seam is `LlmRuntime.prototype.streamWithRegistration`.**
**Decision:** keep SPEC §4.
**Why:** verified single funnel (§0.1); the only point where `options` can be
replaced. The `llm/stream` waterfall cannot substitute options — its final
callback closes over the original frozen `options` (`dsh-llm/lib/index.js:2371`)
and cordis `waterfall` passes a fixed `args` array to listeners
(`cordis/lib/index.js:317-325`). A waterfall implementation would **silently
no-op**.
**Rejected:** (a) `ctx.waterfall(..., "llm/stream", ...)` — cannot replace
options, silent no-op; (b) `registerAdapter` — throws `DUPLICATE_ADAPTER`
(`dsh-llm/lib/index.js:1863`); (c) patching `LlmAdapter.prototype.stream` — the
base class **has no `stream` method** (`dsh-llm/lib/index.js:1670-1740`; it is
abstract), and `PiAiAdapter.prepareCall` returns a closure over
`streamWithSnapshot` (`dsh-llm-pi-ai/lib/index.js:1831-1840`) that bypasses any
`stream` override, so the patch would miss the dominant provider.

**D-3 · Patch the prototype, not the instance — and prove identity.**
**Decision:** patch `LlmRuntime.prototype`, and at `apply` time assert that the
live `llm` service actually inherits from the prototype we imported:
`Object.getPrototypeOf(ctx.get("llm")) === LlmRuntime.prototype` (walk the chain
for subclasses). Throw `SEAM_IDENTITY_MISMATCH` if not.
**Why:** module resolution currently yields the same physical
`dsh-llm/lib/index.js` (§0.1), so the patch works. But a duplicated `dsh-llm`
instance is a realistic packaging accident, and it fails **silently** — the
patch applies to an unused class and every poisoned request still 400s. This
guard converts that into a loud startup failure.
**Rejected:** (a) patching the instance's own method — avoids the duplicate-class
risk but loses the "one patch, all instances" property and complicates disposal;
(b) no guard — accepts the worst failure mode the spec itself names.

### A.2 Object identity and the agent-loop marker

**D-4 · The repair must return `{ ...options, messages }`, and MUST preserve the
agent-loop request marker.**
**Decision:** the wrapped method must forward the whole options object, never a
bare messages array, and when the input object is marked as an agent-loop
request it must re-mark the replacement object.

```js
// REQUIRED shape — SPEC §4's snippet is wrong (see below)
const healed = healer(options.messages);
if (healed.messages === options.messages) return original.call(this, options, prepared);
const next = { ...options, messages: healed.messages };
if (isAgentLoopRequest(options)) markAgentLoopRequest(next); // identity is a WeakSet
return original.call(this, next, prepared);
```

**Why — three independent reasons.**

1. **SPEC §4's code example does not run.** It reads
   `original.call(this, result.messages, prepared)` — passing the messages
   _array_ where the runtime expects the whole options object. `adapterStream`
   then reads `options.provider` and `options.messages`
   (`dsh-llm/lib/index.js:2286, 2309`), so this breaks **every** LLM call, not
   just poisoned ones. The surrounding prose ("`{ ...options, messages }` is a
   fresh unfrozen object") contradicts the snippet; the snippet is the defect.
   The spec's own integration test ("clean history → adapter receives the
   identical options object") only passes with the spread form.
2. **`markAgentLoopRequest` is identity-based.** `dsh-llm/lib/index.js:358`
   declares `const AGENT_LOOP_REQUESTS = new WeakSet()`, `:377` adds the exact
   object, `:386` tests `has(request)`. A spread creates a new object, so the
   marker is lost.
3. **Losing the marker is a live, silent regression in this profile — but
   fail-open and partly redundant, so calibrate the severity honestly.**
   `dsh-session-title` is enabled by the base bundle
   (`dsh-base/cordis.patch.yml:55-60`) and its listener runs on every call:
   `dsh-session-title/lib/index.js:262-268` → `onMainRequest(options)` at `:417`,
   which begins `if (!this.serviceActive() || options.sessionId === void 0 || !isAgentLoopRequest(options)) return;`
   (`:418`). With the marker gone, the unchanged-route title start is skipped for
   exactly the requests that were healed. It degrades rather than breaks, for two
   reasons: `session/event` → `onRequestHeader` (`:405-415`) still starts work from
   the appended `request/header` event, and the shipped provider is
   `first-prompt` (`dsh-session-title-first-prompt-llm/lib/index.js:27`), whose
   `onUserMessage` only creates pending work at `count === 1`
   (`dsh-session-title/lib/index.js:386`). So today the marker path is largely
   redundant; the exposure becomes real for an `all-prompts` provider. Note the
   listener still returns `next()` (`:264`), so the stream is untouched either way.
   `dsh-agent-loop/invariant.js:16` is the other consumer and is **not** active in
   the `web` profile — only `dsh-sdk-minimal` mounts `agent-loop-invariant`
   (`dsh-sdk-minimal/cordis.patch.yml:106-119`), and a store-wide grep finds that
   bundle is the sole mount. Its failure mode is the opposite of loud: because the
   whole listener is gated on `isAgentLoopRequest`, a spread object **silently
   disables every one of its checks** (frozen, sessionId, live session, frozen
   messages, log-reconstruction equality at `:28`) — fail-open, no throw. That
   makes the re-mark a correctness requirement rather than a hardening nicety: the
   one guard that would catch an outbound/durable divergence is exactly the guard
   the marker disables.

**Rejected:** plain `{ ...options, messages }` with no re-mark (SPEC as written).
**Rejected:** mutating `options.messages` in place — impossible for the loop path;
the array is `Object.freeze`d (`dsh-agent-loop/lib/index.js:1268`) — and forbidden
outright by D-4a.

**D-4a · Never mutate `options` or `options.messages`, even when mutation is
possible.**
**Decision:** the healer and the wrapper treat every input as immutable and only
ever produce new objects; no code path writes to `options` or to a message.
**Why:** the freeze is **not universal**. It holds for the agent-loop paths
(`dsh-agent-loop/lib/index.js:1261-1268`), `session-title-llm`
(`dsh-session-title-llm/lib/index.js:206`) and `experimental-auto-review`
(`dsh-experimental-auto-review/lib/index.js:401`) — but **not** for
`compaction-basic`, which builds a plain unfrozen object
(`dsh-compaction-basic/lib/index.js:305-322`) and passes it to
`ctx.llm.stream(options)` at `:323`. A plugin that relied on the freeze to keep it
honest would silently mutate the compaction request — a request whose shape has
nothing to do with the incident. Treating immutability as our own contract, not
the host's guarantee, removes that class of bug entirely.
**Rejected:** relying on `Object.isFrozen(options)` as a licence to mutate. It
makes behaviour depend on the caller, which is precisely how a repair plugin
introduces a defect in a path it was never meant to touch.

**D-5 · Preserve the fast path exactly, including object identity.**
**Decision:** when nothing is dropped, forward the **input reference** to
`original.call(this, options, prepared)` — no spread, no re-mark, zero
allocation.
**Why:** the spec's fast-path claim is correct and is the reason a clean session
pays nothing. It also keeps `isAgentLoopRequest` intact for the overwhelmingly
common clean case, narrowing D-4's fix to the case that needs it.
**Rejected:** always spreading. It allocates on every call and silently breaks
the marker for every request, not just healed ones.

### A.3 Streaming guarantee

**D-6 · Assert pass-through, not literal identity against the raw adapter
iterable.**
**Decision:** the streaming test must prove the patched method returns the
waterfall's value **unchanged**, and separately prove no listener was added,
removed, or reordered.
**Why:** SPEC §7 says "returned iterable is **the identical object** the
unpatched runtime produced — assert `===`". That assertion is **wrong as
written**, because `session-checkpoint-policy` is enabled by the base bundle
(`dsh-base/cordis.patch.yml:413-414`) and its listener returns a **wrapper
generator**, not the inner iterable
(`dsh-session-checkpoint-policy/lib/index.js:23-27`):

```js
function afterCheckpoint(ctx, session, next) {
  return (async function* () {
    await ctx.sessions.flush(session);
    yield* next();
  })();
}
```

So in a real profile the object a caller receives is never the adapter's own
iterable, patched or not. A `===` test against the unpatched baseline can still
be written (see below), but a `===` test against the _inner_ iterable would fail
for unrelated reasons and would likely be "fixed" by weakening the assertion.
**How to test it properly, cheaply, without a real cordis runtime:** install a
spy listener on `llm/stream` that returns a sentinel object, then call
`streamWithRegistration` through a stub context whose `waterfall` invokes that
listener. Assert the patched method returns **that same sentinel** (`===`). This
proves pass-through in isolation, with no provider, no adapter, and no network —
and it is the assertion the spec actually wants.
**Rejected:** asserting `===` on the adapter's inner iterable (fails in any
profile with a wrapping listener); asserting deep-equal chunk sequences only
(does not catch a listener being added or a wrapper being introduced).

**D-7 · The patch must add no `await` and no buffering before dispatch.**
**Decision:** the wrapper is a plain synchronous function; it must not be
`async`, must not `await`, and must not consume the iterable.
**Why:** first-token latency is the property the spec is protecting; a
synchronous heal preserves it by construction. This is testable by asserting the
wrapper's return value is the sentinel from D-6 with no microtask in between.
**Rejected:** an `async` wrapper, even one that only awaits once before calling
`original`. It converts a synchronous call into a promise, which changes the
method's return contract and inserts a microtask before dispatch for every call,
clean or not — paying the streaming cost on the common path to fix a rare one.
**Rejected:** consuming the iterable to validate it. Buffering is the exact
impairment SPEC §2 identifies; the repair happens before the stream exists and
must not observe it at all.

**D-7a · Any `llm/stream` listener this plugin adds must be `{ global: true }`,
and must never re-issue a nested call.**
**Decision:** the patch path needs no listener at all. If observation is added
later (e.g. to report findings), it must register with `{ global: true }`, and it
must never repair by calling `ctx.llm.stream(...)` itself.
**Why:** cordis filters listeners by isolate scope —
`cordis/lib/index.js:258-264` returns only hooks where
`hook.global || !filter || filter.call(thisArg, hook.ctx)`, and `LlmRuntime`
extends `Service`, which defines the filter symbol
(`cordis/lib/index.js:1785-1787`). A non-global listener would observe only its
own scope and silently miss most calls; both shipped precedent listeners pass
`{ global: true, prepend: true }` (`dsh-session-title/lib/index.js:266`,
`dsh-agent-loop/lib/invariant.js:31`). Separately, re-issuing the call from a
listener is a trap: it re-enters the same waterfall (so the listener sees its own
nested call and needs a recursion guard), and it loses the agent-loop marker,
because the shipped `dsh-opencode-patch` already does exactly this
(`{ ...options, provider: redirect }`, `lib/index.mjs:4137-4139`).
**Rejected:** repairing from a listener by re-dispatch. It converts a synchronous,
allocation-free repair into a nested request with a lost marker — strictly worse
than D-2's seam on every axis.

### A.4 Rule model, and the detection/repair split

**D-8 · Split detection from repair, as two independently callable functions per
rule, injected systematically by the engine.**
**Decision:** every rule exposes **two** pure functions — `detect` (observe,
never decide-and-mutate) and `repair` (produce the fix) — and the engine drives
both. Rules never mutate, never drop, never log; they only answer questions. The
engine owns phase ordering, role scoping (D-8a), application, accounting, and the
invariants.
**Why:** the user's requirement is that checking and fixing are separate
functions, injected systematically for different rulesets. This shape makes
"check only" a first-class operation rather than a debug flag: `check()` calls
`detect` and stops; `heal()` calls `detect` then `repair`. It also makes the
premise auditable — you can run detection over a live session and see what
_would_ be dropped before enabling repair, which is the only safe way to adopt a
rule set on a real history.
**Rejected:** the spec's split signature (`ContentRule: (block) => string |
undefined`, `MessageRule.repair(messages) => RuleResult`). It fuses detection and
repair into one call, so a checks-only mode must either re-implement every rule
or run the real repair and throw the result away. It also forces message rules to
return a whole new list, which duplicates engine work (index bookkeeping,
identity preservation) inside every rule and invites each rule to weaken the
engine's invariants.
**Rejected:** a single `rule(block) => Finding | undefined` with the engine
inferring the fix. It cannot express "replace with `{}`" (D-12) and it hides the
decision from the rule that understands it.

```ts
/** One observed defect. Pure data; carries no fix. */
export interface Finding {
  readonly ruleId: string;
  readonly reason: string;
  readonly messageIndex: number;
  readonly blockIndex?: number;
  /** Rule-owned, opaque to the engine. `repair` receives it back verbatim. */
  readonly detail?: unknown;
}

export interface DetectContext {
  readonly phase: 'content' | 'message';
}

export interface RepairContext extends DetectContext {
  /** The exact message list `detect` ran against. Never mutated. */
  readonly messages: readonly Message[];
}

/** A content rule judges ONE block; a message rule judges the WHOLE list. */
export interface Rule {
  readonly id: string;
  readonly kind: 'content' | 'message';
  /** Default enablement. A disabled rule is never called. */
  readonly enabledByDefault: boolean;
  /** Human-facing description, surfaced by the settings UI. */
  readonly description: string;
  /**
   * Roles this rule may inspect. The engine skips a message outside this set
   * before calling `detect`, so a rule cannot act on a role it does not
   * understand. `undefined` means every role.
   */
  readonly roles?: readonly MessageRole[];
  detect(target: unknown, ctx: DetectContext): Finding | readonly Finding[] | undefined;
  /** Drop the block/message, or return a replacement for it. */
  repair(finding: Finding, ctx: RepairContext): RepairDecision;
}

export type RepairDecision =
  | { readonly action: 'keep' }
  | { readonly action: 'drop' }
  | { readonly action: 'replace'; readonly value: unknown };
```

**D-8a · Content rules are role-scoped, and `tool-call-name` is scoped to
`assistant`.**
**Decision:** `tool-call-name` declares `roles: ['assistant']`; the engine skips
messages outside that set. `orphan-tool-result` declares `roles: ['tool']`.
**Why:** nothing structurally prevents a `tool-call` block from sitting in a
`user`, `tool`, or `developer` message — every role shares the same unconstrained
`content: readonly ContentBlock[]` (`dsh-llm/lib/types/message.d.ts:124-133`), and
the only role↔block enforcement on the path is
`assertSupportedHistory` (`dsh-llm-pi-ai/lib/index.js:1180-1187`), which never
mentions `tool-call`. Session-side, tool calls are scanned **only** on assistant
messages (`dsh-session/lib/index.js:824-829`). So an unscoped rule would drop a
block no provider ever treated as a tool call — editing history for no reason,
the exact over-sanitization risk SPEC §8 names. Scoping also makes the intent
readable: a rule that judges tool calls says so.
**Rejected:** leaving it to each rule to check `message.role` internally. Every
rule would repeat the check, and the engine could not report _why_ a message was
skipped. Making it declarative keeps the engine in charge of traversal.
**Rejected:** no role scope at all. It is simpler, but it silently couples the
rule to an assumption about role/block affinity that the type system does not
enforce.

**Boundary found by fuzzing, and why it stays where it is.** A generated
`tool-call` block can sit in a `developer` message, and `tool-call-name` will
not touch it. That is correct rather than a gap: the pi-ai adapter rejects a
developer message outright — `assertSupportedHistory` throws
`UNSUPPORTED_CONTENT` (`dsh-llm-pi-ai/lib/index.js:1180-1187`) before any block
is projected — so a malformed name in that role cannot be what breaks a request.
Widening the scope would edit a message for no reason, which is exactly the
over-sanitization risk SPEC §8 names. The boundary is pinned by
`test/fuzz.test.ts` I1b, and the invariant in I1 is scoped to assistant messages
to match the contract rather than overstating it.

**D-9 · Two engine entry points: `check` and `heal`, sharing one detection
implementation.**
**Decision:**

```ts
export interface HealReport {
  readonly messages: readonly Message[]; // input reference when nothing dropped
  readonly findings: readonly Finding[]; // every detection, enabled rules only
  readonly applied: readonly AppliedFix[]; // what repair actually changed
  /** Rules the engine declined to run, and why: 'disabled' | 'role'. */
  readonly skipped: readonly SkippedRule[];
}

export interface SkippedRule {
  readonly ruleId: string;
  readonly reason: 'disabled' | 'role';
  readonly messageIndex?: number; // present for 'role'
}

export function createHealer(rules: readonly Rule[]): {
  /** Detection only. Never calls repair. Never allocates a new list. */
  check(messages: readonly Message[]): readonly Finding[];
  /** Detection + repair. Returns the input reference when nothing changed. */
  heal(messages: readonly Message[]): HealReport;
};
```

**Why:** `check` is the "checks without healing" the user asked for, and it is
guaranteed to be side-effect-free and allocation-free, so it can run on every
request even in production. `heal` is the repair path. Both share one detection
implementation, so they cannot drift. `skipped` distinguishes "this rule is off"
from "this rule does not apply to that role", so a rule that appears not to fire
can be explained without reading its source (D-8a).
**Rejected:** a `mode: "check" | "heal"` boolean on a single entry point. It
works, but it makes the caller's intent a runtime value instead of a
compile-time one and tempts implementations to "check and stash" the findings.
Keep the mode in the **plugin config** (D-15) while keeping two distinct
functions in the engine.

**D-10 · Keep the two rule kinds; the phase order is structural.**
**Decision:** keep SPEC §5's content/message split and the content-then-message
ordering.
**Why:** the incident _proves_ the cascade is required (§0.4). Dropping the
empty-name `tool-call` strands its matching `role:"tool"` result, and a stranded
result is itself a 400 on strict providers. The orphan rule must observe the
**post-content-phase** list. Expressing that as a per-block rule is impossible:
answering "does this result still have a call?" needs the whole list.
**Rejected:** one uniform per-block rule kind with a hack (e.g. rules receiving a
shared mutable context) — it would make each rule responsible for engine-level
ordering and break the "rule never mutates" invariant.

### A.5 Rule content — evidence-driven

**D-11 · Ship `tool-call-name` enabled; make it the primary rule.**
**Decision:** drop a `tool-call` block whose `name` is not a non-empty string
after trimming. Keep accepting a legacy `tool_use` tag for
merge-extensibility, but name tests after `tool-call` (§0.4).
**Why:** it is the only defect implicated by every observed 400
(`messages.115.content.3.tool_use.name: Field required`; `` `name` must be non-empty ``).
**Note:** the durable fix belongs upstream in `BlockAssembler.assemble()`
(`assembler.js:100-105`) and the accumulator's empty-name branch
(`assistant-stream.js:70-73`), **not** in `buildRequest` as SPEC §8 proposes
(§0.3).
**Rejected:** repairing the name instead of dropping the block (e.g. substituting
a placeholder like `unknown_tool`). A fabricated name would be sent to the
provider as a real tool invocation the model never requested; the call would
either be rejected or — worse — resolve to an unrelated tool if the placeholder
collided with a real name. Dropping is the only repair that cannot cause an
unintended side effect.
**Rejected:** leaving the rule disabled until the upstream fix lands. The whole
point is to rescue histories that are already poisoned, and no upstream change
can reach them retroactively (D-1a).

**D-12 · `tool-call-arguments` ships DISABLED by default; prefer normalize over
drop when enabled.**
**Decision:** default `enabledByDefault: false`. When enabled, the repair action
is `replace` with `arguments: '{}'`, not `drop`.
**Why:** the adapter already implements exactly this tolerance —
`dsh-llm-pi-ai/lib/index.js:27-34` `parseArguments` returns `{}` for anything
that is not a JSON object, applied on both history-reconstruction paths
(`:159-165`, `:204-209`). The wire therefore never carries `arguments: ""`. So
the rule is **redundant for the pi-ai routes** and dropping the block would be a
behaviour change with no incident behind it — and worse, dropping the call
cascades through the orphan rule and deletes a real result message. Normalizing
to `{}` reproduces the adapter's existing semantics with no cascade.
**Rejected:** SPEC's drop. It is not evidence-backed and it destroys more history
than the adapter would have.

**D-13 · `orphan-tool-result` ships enabled.**
**Decision:** drop a `role:"tool"` message whose `toolCallId` matches no
surviving `tool-call`. Run it in the message phase, after content rules.
**Why:** it is the **required cascade terminator** for D-11 (§0.4). It is not a
primary detector for this incident — the fabricated call was dispatched and
answered (`UNKNOWN_TOOL`) — but without it the fix is incomplete and produces a
new malformed request.
**Caveat to encode as a test:** because ids can be **harness-synthesized**
(`assembler.js:101` — `call-3` is literally `call-${index}`), the rule must key
strictly on id equality and must not assume provider-issued ids. A synthesized
id that happens to collide with a live call would keep an unrelated result
alive; this is acceptable and must be documented, not "fixed" with heuristics.
**Rejected:** dropping a `role:"tool"` message by position instead of by id
(e.g. "a tool message that follows a removed call"). Position is not the
contract; the correlation is by `toolCallId`, and positional inference would
mis-fire on the legitimate case of several tool results in one turn.
**Rejected:** converting the stranded result into a `user`-role text message
rather than dropping it. That invents a turn the model never produced and
changes the conversation's role structure — a larger perturbation than removing
a result whose call no longer exists.

**D-14 · Keep the empty-assistant-message rule out of the default set.**
**Decision:** keep SPEC §5's stance — a separate, opt-in rule, shipped disabled.
**Why:** removing every block of an assistant message yields `content: []`, whose
validity is provider-dependent. SPEC §7 already requires gating it on real
provider shapes. Note it becomes _reachable_ once D-11 is enabled, so it must be
listed and tested even while disabled.
**Rejected:** enabling it by default as an "automatic consequence" of the content
phase. The spec is right that this is a separate decision — `content: []` is a
validation risk on some providers and harmless on others, and silently dropping
a whole assistant message is a much larger edit than the defect warrants.
**Rejected:** omitting the rule entirely because it ships disabled. It becomes
reachable the moment D-11 is enabled, so leaving it out would leave a real
post-condition untested.

### A.6 Configuration and injection

**D-15 · Every rule is individually toggleable, and the toggle is validated.**
**Decision:** expose a real settings schema, with a global mode plus a per-rule
map. Unknown rule ids are a **configuration error**, not a silent no-op.

```ts
export const Config = z.object({
  /** off = never called; check = detect and report only; heal = detect + repair. */
  mode: z.union([z.const('off'), z.const('check'), z.const('heal')]).default('heal'),
  /** Per-rule override. Absent = the rule's own enabledByDefault. */
  rules: z
    .dict(
      z.object({
        enabled: z.boolean().required(),
        /**
         * Rule-owned options, validated by the rule itself at apply time.
         * The engine never reads this — it only hands the value to `detect`/`repair`
         * through the rule context, so a rule can take parameters (e.g. a byte
         * ceiling) without any engine or schema change.
         */
        options: z.any(),
      }),
    )
    .default({}),
  /** What to do with findings. */
  onFindings: z.union([z.const('silent'), z.const('log'), z.const('throw')]).default('log'),
  /** Also fail when a configured rule id matches no registered rule. */
  strictRuleIds: z.boolean().default(true),
});
```

**Why:** the user's explicit requirement ("per-rule enable and disable to prevent
errors"). Two failure modes drive the validation: a typo'd rule id
(`tool_call_name`) would otherwise silently disable a protection the operator
believes is on; and a rule removed in a later version would leave a stale config
key. `strictRuleIds` makes both loud at `apply` time, before any request is
touched.
**Rejected:** a flat boolean per rule (`enableToolCallName`) — every new rule
becomes a schema change, which breaks the spec's own "adding a rule touches no
engine code" property. `z.dict` keeps the schema stable as rules are added.

**Verified:** the factory is `z.dict(inner, keySchema?)`, not `z.dictionary` —
`schemastery/lib/types/index.d.ts:75`. The 3.18.x public package has no
`dictionary` member, so the first draft of this schema would not have compiled.

**D-16 · Injection is via `inject: ["llm"]` plus a bundle row; the patch installs
once and disposes cleanly.**
**Decision:** `export const name`, `export const inject = ["llm"]`,
`export function apply(ctx, config)`. `apply` installs the patch once, returns a
disposer that restores the original method, and is guarded by a
`Symbol.for('dsh-healer.patched')` marker on the prototype.
**Why:** cordis may call `apply` more than once across HMR/reload
(`patchReload: "live"` is set in the `web` profile's `package.json`), and an
unguarded patch stacks — every request would be healed N times. `Symbol.for`
survives module duplication, so it is strictly safer than a module-local symbol.
Disposal-restores is what makes disabling the plugin a true revert.
**Rejected:** a module-local `let installed = false` — a second module instance
(two copies of dsh-healer) would patch twice.
**Rejected:** installing the patch at module import time — it would run before
the `llm` service exists and could not be disposed by cordis.

**D-17 · Package shape and resolution.**
**Decision:** follow the house local-plugin shape (`dsh-tinyfish` is the
in-repo precedent): `main: lib/index.mjs`, `exports` with a `./src/*` passthrough,
`dsh.bundle.patch: ./cordis.patch.yml`, and a `dsh.compatibility` manifest
naming the DSH versions. Declare `@deepseek-ai/dsh-llm` and
`@deepseek-ai/cordis` as **peerDependencies**, never as regular dependencies.
**Why:** resolution from the profile root currently reaches the same physical
`dsh-llm` the base bundle loads (§0.1), which is what makes D-3's prototype patch
work. A regular dependency invites pnpm to install a second copy under the
plugin, which would make the patch target an unused class — silently. D-3's
identity guard catches it, but the peer declaration is what prevents it.
**Rejected:** bundling dsh-llm, or relying on `--experimental-strip-types` at
runtime for a plugin the profile loads through the normal loader (keep the
`./src/*` passthrough for tests, but ship compiled `lib/`).

### A.7 Strategy

**D-18 · Ship the plugin as a session-repair tool, and pursue the upstream fix in
parallel — with a corrected target.**
**Decision:** keep SPEC §8's "prefer landing upstream" intent, but re-target it:
the upstream fix is in `BlockAssembler.assemble()` and the accumulator's
empty-name branch, **not** in `buildRequest` validation. The plugin's unique
value is repairing histories that are **already poisoned** — which an upstream
fix cannot do retroactively, since the poison is durable and never pruned.
**Why:** §0.3 shows the assembler fabricates the malformed block; a
`buildRequest` validator would fail the request locally while leaving the
fabrication in place. The plugin and the upstream fix address different halves of
the problem, so this is not either/or.
**Rejected:** plugin only — it treats the symptom and pays a permanent
prototype-patch cost. **Rejected:** upstream only — it cannot heal existing
sessions, which is the observed damage.

**D-19 · Accept the known, documented divergences rather than hiding them.**
**Decision:** document, in the plugin's README and in a code comment at the
patch site, that (a) the outbound request may deliberately diverge from the
durable session derivation, and (b) `dsh-agent-loop/invariant.js:28` asserts the
opposite and will fail if that companion is ever enabled alongside this plugin.
**Why:** the invariant's assertion
(`JSON.stringify(options.messages) !== JSON.stringify(expected)` → fail) is a
deliberate, correct guard against log-reconstruction desync. This plugin
intentionally violates it. Today it is latent (the invariant is only enabled by
`dsh-sdk-minimal`), but a future profile that enables both would break loudly
with a confusing message. Naming the conflict now is what keeps it from being
misdiagnosed later.
**Rejected:** disabling or weakening the invariant from this plugin — it belongs
to `dsh-agent-loop`, and a plugin must not edit another package's invariants.

### A.8 Plan hygiene

**D-20 · `SPEC.md` is annotated, not rewritten.**
**Decision:** leave the original spec text intact and add a short status header
that points at the corrections and names the two defects a worker must not copy.
The full corrections live in §B.
**Why:** the spec is the problem statement and the record of what was believed
before verification; silently rewriting it would erase the reasoning trail that
makes §B auditable. But a worker who opens `SPEC.md` alone would copy a code
sample that breaks every LLM call (correction 1) and a test assertion that cannot
pass (correction 3), so the file cannot be left unmarked either. A pointer
resolves both: the history stays, the trap is flagged at the point of use.
**Rejected:** rewriting `SPEC.md` in place — loses the before/after record and
makes it impossible to see which claims were wrong. **Rejected:** leaving it
unmarked — invites the two shipping defects above into the implementation.

---

## B. Corrections required in SPEC.md

| #   | Location           | Problem                                                                                                                       | Correction                                                                   |
| --- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 1   | §4 code block      | `original.call(this, result.messages, prepared)` passes an array where the options object is required — breaks **every** call | Use `{ ...options, messages: healed.messages }` (D-4)                        |
| 2   | §4 prose           | Spread loses the `markAgentLoopRequest` WeakSet identity, silently skipping `session-title`'s main-request path               | Re-mark when the input was marked (D-4)                                      |
| 3   | §7 streaming test  | `===` against the unpatched runtime's iterable cannot hold once `session-checkpoint-policy` wraps the stream                  | Assert pass-through of the waterfall's value via a sentinel listener (D-6)   |
| 4   | §5 rule signatures | Fused detect+repair prevents a real checks-only mode and pushes engine invariants into rules                                  | Split into `detect`/`repair` (D-8, D-9)                                      |
| 5   | §5 table           | `tool-call-arguments` duplicates `parseArguments`; drop is not evidence-backed and cascades                                   | Default disabled; normalize to `{}` when enabled (D-12)                      |
| 6   | §1                 | "Every subsequent request … was rejected" is false — 7 of 18 later attempts succeeded                                         | Restate as provider-dependent; keep the strictness table                     |
| 7   | §1                 | "153 messages after it" is a stale snapshot (now 242)                                                                         | Label the figures as of the snapshot seq                                     |
| 8   | §1, §8             | Root cause is the assembler's fabricated empty-name block, not a raw model emission; the upstream fix target is wrong         | Re-target upstream to `BlockAssembler.assemble()` + accumulator (D-18)       |
| 9   | §7 fuzz            | "no surviving `tool_use` has an empty `name`" names a vocabulary that never appears internally                                | Phrase in terms of `tool-call`                                               |
| 10  | §5                 | No role guard on content rules; a `tool-call` block in a non-assistant message would be dropped                               | **Pinned** — content rules are role-scoped (D-8a); test it                   |
| 11  | §6                 | No settings schema, so "per-rule enable/disable" is unimplementable                                                           | Add `Config` (D-15)                                                          |
| 12  | §7                 | No `check`-only test path                                                                                                     | Add: `check()` reports the same findings as `heal()` without changing output |

---

## C. Why no better seam exists

Recorded so this is not re-litigated:

| Candidate                                     | Can replace `options` before dispatch? | Why it loses                                                                                                                                                                                                                                     |
| --------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ctx.waterfall(..., 'llm/stream', ...)`       | **No**                                 | Final callback closes over frozen `options` (`dsh-llm/lib/index.js:2371`); cordis passes a fixed `args` array (`cordis/lib/index.js:317-325`). A listener's return value becomes the chain result but cannot substitute arguments → silent no-op |
| `registerAdapter` for affected providers      | **No**                                 | `DUPLICATE_ADAPTER` for every provider another adapter owns (`dsh-llm/lib/index.js:1863`)                                                                                                                                                        |
| `LlmAdapter.prototype.stream`                 | **No**                                 | Base class declares no `stream` (`dsh-llm/lib/index.js:1670-1740`); `PiAiAdapter.prepareCall` closes over `streamWithSnapshot` (`dsh-llm-pi-ai/lib/index.js:1831-1840`)                                                                          |
| Patch the `llm` service instance's own method | Yes                                    | Works, but loses one-patch-covers-all and complicates disposal; rejected in D-3 in favour of prototype + identity guard                                                                                                                          |
| Upstream validation in `buildRequest`         | N/A                                    | Would fail the request locally while leaving the assembler free to fabricate; re-targeted in D-18                                                                                                                                                |

**One more consequence worth stating:** the patch is host-wide. It affects every
`llm.stream()` caller in the process — including the auxiliary calls that share
the seam (`compaction-basic/lib/index.js:323`, `session-title-llm/lib/index.js:226`,
`experimental-auto-review/lib/index.js:415`). Those callers build their own
message lists, so healing them is harmless _and_ arguably desirable, but it means
the plugin's blast radius is "every model call in the host", not "the agent
loop". This is an argument for narrow rules and for `mode: 'check'` being the
safe first deployment (D-9, D-15).

---

## D. Amended definition of done

Supersedes SPEC §9. Each item is a gate in [`WORKFLOW.md`](WORKFLOW.md).

1. Each rule exports **both** `detect` and `repair` as pure functions; each
   rule's test imports only that rule file.
2. `check(messages)` returns findings and **does not** allocate a new message
   list and **never** calls `repair`.
3. `heal(messages)` returns the **input reference** when nothing is dropped
   (assert `===`).
4. Every enabled rule is individually disableable through `Config.rules`, and an
   unknown rule id fails `apply` when `strictRuleIds` is on.
5. The wrapped `streamWithRegistration` forwards the **whole options object** and
   re-marks agent-loop requests; a test asserts
   `isAgentLoopRequest(forwardedOptions) === true` after a repair.
6. Streaming pass-through: the patched method returns the waterfall's value
   unchanged (`===` on a sentinel listener), with no added `await`.
7. `apply` is idempotent under repeated invocation and its disposer restores the
   original method (assert identity of the restored function).
8. A missing or mismatched seam (`LlmRuntime` absent, or the live service not
   inheriting from the imported prototype) fails loudly at `apply`.
9. Adding a fourth rule requires editing **no** engine or patch file — only the
   default rule list and its own test.
10. The incident fixture (the real `seq 4810` block **and** its matching
    `UNKNOWN_TOOL` result) heals to a provider-valid request: no empty `name`,
    and no stranded `role:"tool"` message.
11. Cross-model: the same fixture heals to one identical result for the
    anthropic-messages, openai-completions, and opencode-responses shapes.
12. `mode: 'check'` reports the incident fixture's finding while leaving the
    outbound request **byte-identical** to the unhealed request.

---

## E. Coverage matrix

Every section of `SPEC.md`, mapped to its verification verdict, the decision that
governs it, and the workflow node that proves it. No spec section is left without
a verdict.

| SPEC § | Subject                                           | Verdict                                                                                                                                         | Decision         | Nodes         |
| ------ | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | ------------- |
| §1     | Problem statement, strictness table, retry policy | **PARTIALLY** — block, compaction seq, index and strictness confirmed; "every subsequent request rejected" **falsified**; "153 after" **stale** | —                | N2            |
| §1     | Root cause ("a model emitted")                    | **PARTIALLY FALSIFIED** — assembler-fabricated                                                                                                  | D-18             | N2, N21       |
| §2     | Repair the request, never the stream              | **CONFIRMED**                                                                                                                                   | D-1              | N14, N16      |
| §2     | Streaming guarantee                               | **CONFIRMED as a property; the stated test is wrong**                                                                                           | D-6, D-7         | N16           |
| §3     | History preserved verbatim                        | **CONFIRMED and structurally guaranteed**                                                                                                       | D-1a             | N20, G1       |
| §4     | Candidate seams / waterfall unusable              | **CONFIRMED**, strengthened empirically                                                                                                         | D-2              | N14           |
| §4     | `registerAdapter` unusable                        | **CONFIRMED** (`DUPLICATE_ADAPTER`)                                                                                                             | D-2              | —             |
| §4     | Chosen seam `streamWithRegistration`              | **CONFIRMED** as the only workable seam                                                                                                         | D-2, D-3         | N14, N17      |
| §4     | Code sample + "fresh unfrozen object"             | **BROKEN** — array passed where options required; spread loses the marker                                                                       | D-4, D-4a        | N14, N19      |
| §5     | Two rule kinds / phase order                      | **CONFIRMED**, and required by the cascade                                                                                                      | D-10             | N3, N6        |
| §5     | `tool-call-name`                                  | **CONFIRMED** as the primary rule                                                                                                               | D-11             | N4            |
| §5     | `tool-call-arguments`                             | **DUPLICATES** adapter tolerance; drop not evidence-backed                                                                                      | D-12             | N5            |
| §5     | `orphan-tool-result`                              | **CONFIRMED** as the cascade terminator                                                                                                         | D-13             | N6            |
| §5     | Empty assistant message, ship disabled            | **CONFIRMED**                                                                                                                                   | D-14             | N7            |
| §5     | Engine invariants, fast path, pluggability        | **CONFIRMED**, redesigned around `detect`/`repair`                                                                                              | D-5, D-8, D-9    | N3, N9, N10   |
| §5     | "No rule may log, throw, or perform I/O"          | **CONFIRMED**, extended to "never mutate"                                                                                                       | D-4a, D-8        | N11           |
| §6     | Package shape, plugin contract                    | **CONFIRMED**, extended with settings and peers                                                                                                 | D-15, D-16, D-17 | N13, N15, N18 |
| §6     | Idempotence guard, disposal restores              | **CONFIRMED**, `Symbol.for` chosen                                                                                                              | D-16             | N18           |
| §7     | Per-rule isolation                                | **CONFIRMED**                                                                                                                                   | D-8              | N11           |
| §7     | Engine invariants with fake rules                 | **CONFIRMED**                                                                                                                                   | D-9              | N9            |
| §7     | Streaming identity test                           | **WRONG as written**                                                                                                                            | D-6              | N16           |
| §7     | Cross-model fixtures                              | **CONFIRMED**                                                                                                                                   | —                | N12           |
| §7     | Integration on both call paths                    | **CONFIRMED**                                                                                                                                   | D-2              | N19           |
| §7     | Fuzz invariant phrased in `tool_use`              | **MISNAMED** — that tag never appears internally                                                                                                | D-11             | N11           |
| §8     | Prototype patch lost on upgrade                   | **CONFIRMED**, two guards added                                                                                                                 | D-3, D-17        | N17           |
| §8     | Double-patching on HMR                            | **CONFIRMED**                                                                                                                                   | D-16             | N18           |
| §8     | Over-sanitizing                                   | **CONFIRMED**, mitigated by per-rule defaults                                                                                                   | D-12, D-15       | N13, N18      |
| §8     | Prefer landing upstream in `buildRequest`         | **WRONG TARGET**                                                                                                                                | D-18             | N21           |
| §9     | Definition of done                                | **AMENDED** — §D supersedes                                                                                                                     | §D               | G1            |
| §10    | Out of scope                                      | **CONFIRMED**, unchanged                                                                                                                        | —                | —             |

### Objective → deliverable

| Objective element                              | Where                                                                     |
| ---------------------------------------------- | ------------------------------------------------------------------------- |
| Verify every falsifiable claim                 | §0.1–§0.4, and this matrix                                                |
| Evaluate each decision point with alternatives | §A.1–§A.8 (20 decisions, each with **Decision** / **Why** / **Rejected**) |
| Redesign around separated detection and repair | D-8, D-9 (`detect`/`repair`, `check`/`heal`)                              |
| Per-rule enable/disable and settings           | D-15 (`Config`, `z.dict`, `strictRuleIds`)                                |
| Node-based workflow with gates and acceptance  | `WORKFLOW.md` — 21 nodes, 2 gates, write-scope map, §4 traceability       |

---

## F. Where to heal — the four candidate seams, re-examined

Prompted by the question "can we sanitize the log on save, or what is the most
efficient and least intrusive way to auto-heal?" Every option below was located
in the installed source and, where it matters, measured.

### F.1 The save path, exactly

```
live.blocks()                                  ← the fabricated block exists here
  └─ createAssistantMessage({ content, source })
      └─ session.append("assistant/message", { turn, step, message, usage, stream })
```

`dsh-agent-loop/lib/index.js:1131-1148`. There **is** a clean seam before the
append, so sanitize-on-save is technically possible.

### F.2 Why sanitize-on-save is the wrong choice — and it is not a style objection

The durable event carries the assembled `message` **and** the raw `stream`.
Verified on the real incident event (`seq 4810`):

```
event keys      : ['message', 'step', 'stream', 'turn', 'usage']
message content : ["reasoning", "text", "text", "tool-call"]
the block       : [{"type":"tool-call","id":"call-3","name":"","arguments":""}]
stream present  : True | records: 12
stream has bare block-start idx3: True
stream has tool-call-delta      : False
```

So sanitizing `message` on the way in produces an event that **contradicts
itself**: the assembled message says the model emitted a valid call, while the raw
chunks beside it show a bare `block-start` that produced nothing.

Nothing reads `stream` today — a repository-wide search finds no consumer, and the
harness says so itself (`dsh-session/lib/types/index.d.ts:159-160`):

> Embedded Assistant streams remain opaque until a stream consumer or storage
> verifier reads them.

That phrasing is the argument, not a reassurance. The field is _waiting_ for a
consumer or a verifier; the day one lands, every session whose `message` was
sanitized on save becomes internally inconsistent, and a replay from `stream`
regenerates the very block the sanitizer removed. Writing a contradiction into a
durable record and relying on nobody reading it yet is a trap set for a future
maintainer.

To sanitize on save _consistently_ you would have to rewrite `stream` too, at
which point the log is no longer a record of what happened, and the forensic
evidence of the degenerate generation is gone. That is the outcome SPEC §3 exists
to prevent, and the reason has not changed.

It also does not fix the actual damage: sessions **already** poisoned, which is
the entire population the repair is for.

### F.3 The four options, ranked

| #   | Where                                             | Fixes existing poison? | Touches the log?                  | Cost             | Verdict                                                 |
| --- | ------------------------------------------------- | ---------------------- | --------------------------------- | ---------------- | ------------------------------------------------------- |
| 1   | `BlockAssembler.assemble()` — prevent fabrication | no                     | no                                | zero at dispatch | **Do it** — upstream, written and verified              |
| 2   | `streamWithRegistration` — repair at dispatch     | **yes**                | no                                | 0.72 ms p50      | **Do it** — this plugin                                 |
| 3   | `session.append` — sanitize on save               | no                     | **yes, and self-contradictorily** | ~0               | No, per F.2                                             |
| 4   | `createAssistantMessage`                          | no                     | yes                               | low              | No — broadest blast radius of all, and same F.2 problem |

Options 1 and 2 are complementary, not alternatives: 1 stops new poison, 2
recovers from existing poison. Both are built. Neither is a substitute for the
other, because only 2 reaches backwards in time and only 1 stops the cause.

### F.4 "Most efficient" is already satisfied — measured, not assumed

Real 2 343-message incident history, after the zero-copy pass (§3j):

| operation                                   | p50         |
| ------------------------------------------- | ----------- |
| `heal(clean, 2 342 msgs)` — the common case | **0.28 ms** |
| `heal(poisoned, 2 343 msgs)`                | **0.34 ms** |

The clean path returns the **input array reference**, and every message in it is
the input object — so it copies no list and no message. It does still allocate the
surviving-tool-call id set, ~84 KB, which is the orphan rule's index rather than a
copy; §3j bisects the cost by rule set and attributes all of it there.

Sub-millisecond, on the largest real history available, against a model call
measured in seconds. There is no efficiency problem to solve.

The figures here were 0.72 / 0.86 ms before the zero-copy pass. They are recorded
as the same measurement taken twice rather than as two different claims, because
the first set was taken with a projection that silently dropped ten system
messages (TESTPLAN §3m).

**The one optimisation that would help is not worth taking.** Memoising per
session — "verified clean at N messages, only check the delta" — would cut
0.28 ms to roughly nothing, at the cost of making the engine stateful. That state
would have to be keyed by session, invalidated when a message is replaced rather
than appended, and made safe under the concurrent requests the engine is currently
free of. Trading a tested statelessness property for an invisible saving is a bad
trade, so it is declined rather than deferred.

### F.5 Least intrusive, precisely

The current patch touches **one method**, at the last point before dispatch, and
changes only the value of one argument. It does not wrap the stream, does not run
on the response path, does not touch persistence, and adds no `await`. On a clean
request it forwards the identical object.

For comparison: option 4 would intercept every assistant message the harness ever
constructs, including ones unrelated to any tool call; option 3 would sit on the
persistence boundary that every event type crosses.

### F.6 If prevention lands upstream

Then the dispatch repair stops firing on newly-produced poison but stays correct
for two cases that remain: model-emitted empty names (which no assembler fix can
prevent), and histories poisoned before the fix. The plugin's own audit tooling —
`pnpm run audit:session` — tells you which sessions still need it, without a
provider call.

---

## G. The rule interface, after the zero-copy pass

The zero-copy work (TESTPLAN §3j) required changing what a rule is handed. This
records why, and what was rejected.

**Decision.** A rule's `detect(target, ctx)` receives:

- **target** — a content rule gets its **block**; a message rule gets its
  **message**. Both already exist; the engine builds neither.
- **ctx** — a discriminated context. For content: `messageIndex` and `blockIndex`.
  For a message rule: `index`, `messages` (the surviving list), and
  `survivingToolCallIds`. The object is **reused** across calls in a pass.

**Why.** The previous shape passed one freshly built object per message, holding
the message, its role, its content, its tool-call id, and the whole list. Every
field a rule read was copied out of the message into a wrapper that was discarded
immediately. On the real 2 342-message history that was ~219 KB per call — for a
plugin whose clean path is supposed to cost nothing.

**Rejected: a per-message view object, kept for ergonomics.** It is the shape that
reads best in a rule and it is what the first design used. It is also the single
largest allocation in the pass, and "the clean path allocates nothing" is a
property worth more than the ergonomics.

**Rejected: passing a mutable, reused _input_ object** (message plus coordinates
in one reused bag). It saves the same allocation but hands a rule a value that
changes underneath it — a rule that stashed `detail: input` would silently keep
the last message it saw. Reusing only the **context** keeps the target a real,
stable object, so the footgun is confined to the field the contract explicitly
names as non-retainable.

**Rejected: memoising per session** so the surviving-id set is built once. It
would remove the remaining 84 KB, at the cost of making the engine stateful —
keyed by session, invalidated when a message is replaced rather than appended, and
made safe under concurrent requests. The engine's statelessness is a tested
property (TESTPLAN §2.4); trading it for 84 KB of short-lived garbage is not worth
it.
