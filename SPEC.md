# dsh-healer — spec

A DSH host plugin that repairs malformed tool-call blocks in the **outbound** model
request, so a single degenerate model generation cannot permanently poison a session.

Status: **spec only — not implemented.** A separate worker takes this from here.

> **Reviewed against DSH `0.2.0-rc.2` and the real incident logs.**
> The seam decision (§4) is **correct and verified**. Twelve corrections are
> required before implementing; see [`DECISIONS.md`](DECISIONS.md) §B and the
> node plan in [`WORKFLOW.md`](WORKFLOW.md).
>
> Two defects in this document must **not** be copied into code:
>
> 1. **§4's code sample breaks every LLM call.** It passes `result.messages` (an
>    array) where `streamWithRegistration` expects the whole options object.
>    The correct form is `{ ...options, messages }` — and the replacement object
>    must be re-marked with `markAgentLoopRequest`, or the identity-keyed marker
>    is silently lost. See D-4.
> 2. **§7's streaming test cannot pass as written.** It asserts `===` against the
>    unpatched runtime's iterable, but `session-checkpoint-policy` (enabled by
>    `dsh-base`) returns a wrapper generator. Assert pass-through of the
>    waterfall's value instead. See D-6.
>
> Two further findings change the plan rather than the code: the poisoned block
> was **fabricated by `BlockAssembler`**, not emitted verbatim by the model
> (§0.3), so the upstream fix target in §8 is wrong; and §1's claim that every
> subsequent request was rejected is **false** — 7 of 18 later attempts
> succeeded. See §0.2.

---

## 1. Problem

A model once emitted a degenerate tool call:

```json
{ "type": "tool-call", "id": "call-3", "name": "", "arguments": "" }
```

The harness recorded it into conversation history and, critically, **never pruned
it**. Observed in a real session:

- Poison written at seq 4810; all compaction had already run (last `compaction/end`
  seq 4745), so nothing ever removed it
- Block sat at message index 975 of 1129, with 153 messages after it
- Every subsequent request re-sent it and was rejected at **validation, before
  inference** — `inputTokens: 0, outputTokens: 0`

Provider responses:

```
messages.115.content.3.tool_use.name: Field required     (Vertex / antigravity)
`name` must be non-empty   param: "name"                  (opencode)
```

`content.3` matches the offending block position exactly — verified positionally.

### Why it looked intermittent

Provider strictness differs, so the same poisoned history produced different results:

| Provider                    | Outcome                                               |
| --------------------------- | ----------------------------------------------------- |
| antigravity (Vertex)        | 400 — strict                                          |
| opencode / muse-spark       | 400 — strict                                          |
| opencode / space-bunny-free | **passes** — tolerant                                 |
| workbuddy                   | 503 `no_healthy_account` (unrelated capacity failure) |

### Why it never self-healed

The retry policy is:

```
["normal", 5, ["EMPTY_RESPONSE","RATE_LIMIT","SERVER","TIMEOUT","TRANSPORT"], 500, 10000, 0.1]
```

`INVALID_REQUEST` / 400 is deliberately absent. That is **correct** — retrying
identical bytes cannot fix a malformed request. It also means nothing retries a
_repaired_ request, because nothing repairs one.

### Gateway masking (secondary, not in scope)

Some gateways log `Request: null, Response: null` and substitute a generic
`displayMsg` ("request parameters do not meet the current model requirements"),
conflating schema failures with capacity failures. Out of scope here; noted so the
next person does not chase turns 22–23 as parameter bugs.

---

## 2. Design decision: repair the request, never the stream

**Chosen:** transform `options.messages` at the last point before wire dispatch.

**Rejected:** filtering/rewriting chunk output as it streams.

Reasons:

1. The defect is in the **request**, not the response. Chunk filtering is the wrong
   layer and would not fix the 400.
2. Touching the stream risks the properties that matter — first-token latency,
   time-to-first-visible-chunk, `AssistantStreamAccumulator` behaviour. A plugin
   that must not impair streaming should not be anywhere near the chunk iterator.
3. Rewriting stream chunks means buffering, which _by construction_ impairs streaming.

### Streaming guarantee

The plugin returns **the exact async iterable the runtime produced**. It does not
wrap, buffer, re-emit, or reorder. There is no consumer-visible change to the chunk
sequence, and no added latency on the first chunk — the repair happens once,
synchronously, before dispatch.

This must be enforced by test (see §7), not just asserted here.

---

## 3. History is preserved, verbatim

Repair applies to an **outbound projection only**. The session log, the projection,
and every persisted event stay byte-identical.

Rationale:

- The session log is the forensic record; silently rewriting it destroys the
  evidence of the degenerate generation that caused the problem.
- Persistence, compaction, and projection carry their own invariants. Mutating them
  from a plugin risks violating invariants this plugin does not own.
- Already-poisoned sessions are still fixed, because the repair happens on every
  outbound request, not once at write time.

---

## 4. The seam

### Finding the packages (do not hardcode paths)

```bash
pnpm root -g                       # or the dlx cache root
find <root>/node_modules/.pnpm -maxdepth 6 -type d -name "dsh-llm" | head
```

Verify against the running DSH version before editing assumptions; line numbers
below are from `0.2.0-rc.2`.

### Candidate seams, and why the obvious one fails

**`ctx.waterfall(..., "llm/stream", ...)` — unusable.**
`LlmRuntime.streamWithRegistration` ends with:

```js
return this.ctx.waterfall(this, 'llm/stream', options, () => this.adapterStream(options, prepared));
```

The final callback closes over `options` and **ignores any value a listener
returns**, so replacement-by-return cannot work. And the arguments are **deeply
frozen** before dispatch — `agent-loop`'s `buildRequest` does:

```js
deepFreeze(message);
Object.freeze(boundaryMessages);
markAgentLoopRequest(Object.freeze({ ..., messages: boundaryMessages, ... }));
```

so a listener cannot mutate in place either. A waterfall-based implementation would
**silently no-op** — the worst possible failure mode.

**`registerAdapter` — unusable for this.**
Throws `DUPLICATE_ADAPTER` for any provider another adapter already owns
(`pi-ai` owns them all). Verified in `prepareRoutes`.

### Chosen seam: `LlmRuntime.prototype.streamWithRegistration`

Two call paths exist in `agent-loop` — `llm.stream(request)` and
`preparedCall.stream(request)` — and **both funnel through this one method**. It is
the last point before `forAdapter(...)` builds the wire payload.

`LlmRuntime` is exported from `@deepseek-ai/dsh-llm` (named and default), so the
prototype is reachable.

```js
const original = LlmRuntime.prototype.streamWithRegistration;
LlmRuntime.prototype.streamWithRegistration = function (options, prepared) {
  const result = heal(options.messages);
  return original.call(this, result.messages, prepared);
};
```

Returning `original.call(...)`'s value directly is what preserves §2's streaming
guarantee. `{ ...options, messages }` is a fresh unfrozen object; the runtime then
builds its own projection from it as normal.

Note `heal()` returns the input reference unchanged when nothing was dropped, so
the clean path allocates nothing (§5).

---

## 5. Repair rules — a pipeline, not a hardcoded list

Rules are **independent, pure, individually testable units**. The engine knows
nothing about any specific rule; adding, removing, or reordering rules never
touches engine code.

### Two rule kinds, because the data shape genuinely differs

This split is structural, not stylistic. Orphan detection (`orphan-tool-result`)
_cannot_ be expressed as a per-block rule — answering "does this tool result still
have a matching call?" requires seeing the whole message list. Forcing it into a
per-block signature would mean either a hack or a rule that silently does nothing.

```ts
/** Content rule: judges ONE block. Returns a reason to drop it, or undefined to keep. */
export type ContentRule = (block: unknown) => string | undefined;

/** Message rule: judges the WHOLE list after content rules have run. */
export interface MessageRule {
  readonly id: string;
  repair(messages: readonly Message[]): RuleResult;
}

export interface RuleResult {
  /** May be the input reference unchanged — identity is meaningful. */
  readonly messages: readonly Message[];
  readonly dropped: readonly DroppedItem[];
}

export interface DroppedItem {
  readonly ruleId: string;
  readonly reason: string;
  readonly messageIndex: number;
  readonly blockIndex?: number;
}
```

`block: unknown` is deliberate. A content rule must survive a harness vocabulary
change it was not written against, so it narrows defensively rather than trusting a
union that may have gained a member.

### Shipped rules

| id                    | kind    | Condition                                                                  | Action       |
| --------------------- | ------- | -------------------------------------------------------------------------- | ------------ |
| `tool-call-name`      | content | `tool-call`/`tool_use` whose `name` is not a non-empty (after trim) string | drop block   |
| `tool-call-arguments` | content | `tool-call` whose `arguments` is not a parseable JSON **object**           | drop block   |
| `orphan-tool-result`  | message | `role: "tool"` whose `toolCallId` matches no surviving tool-call           | drop message |

Ordering is **structural, not incidental**: content rules run first, message rules
second. So a result orphaned _by_ a content rule is also removed, with no
hand-maintained priority list to get wrong.

### Engine

```ts
export function createHealer(rules: {
  content: readonly ContentRule[];
  message: readonly MessageRule[];
}): (messages: readonly Message[]) => RuleResult;
```

The engine enforces the invariants that must hold regardless of which rules are
registered:

- **Identity preservation.** If no rule reports a drop, return the **input
  reference**, not a copy. This is engine policy — no individual rule may weaken it.
- **Never mutate.** Input is deep-frozen and shared. New arrays only on change.
- **Idempotence.** A second pass over output must report zero drops. Assertable as
  an engine property, independent of the rule set.

### Pluggability

- Default export ships the three rules above as an ordinary array — adding one is a
  one-line change in a list, not an edit to engine code.
- `apply(ctx, { rules? })` accepts a caller-supplied set, so a user can add a rule
  (e.g. "drop blocks over N bytes") without forking.
- A rule never sees the provider, model, adapter, or protocol. Model-agnostic
  property is structural here, not a convention someone has to remember.

### Constraints that survive rule composition

- **Empty assistant message** (all blocks removed): dropping the message is a
  _separate opt-in rule_, not an automatic consequence. `content: []` is a
  validation risk on some providers and harmless on others. Ship it disabled;
  see §8.
- **No rule may log, throw, or perform I/O.** Pure in → pure out. Diagnostics flow
  through `RuleResult.dropped`, and the caller decides what to do with them.

### Fast path

```js
const result = healer(options.messages);
return original.call(this, result.messages, prepared); // same object when clean
```

Zero allocation when history is clean — the common case. `result.messages` is the
input reference whenever nothing was dropped, so the fast path needs no special
casing at the call site.

---

## 6. Package shape

```
dsh-healer/
  package.json
  src/
    types.ts          # ContentRule / MessageRule / RuleResult / DroppedItem
    engine.ts         # createHealer — rule-agnostic, owns the invariants
    rules/
      tool-call-name.ts
      tool-call-arguments.ts
      orphan-tool-result.ts
      index.ts        # DEFAULT_RULES: the shipped set, an ordinary array
    patch.ts          # prototype patch + idempotence guard
    index.ts          # cordis plugin: name / inject / apply
  test/
    rules/            # one file per rule — no engine needed
      tool-call-name.test.ts
      tool-call-arguments.test.ts
      orphan-tool-result.test.ts
    engine.test.ts    # invariants, run against a synthetic dummy rule
    streaming.test.ts
    integration.test.ts
```

The `rules/` split is what buys unit isolation: each rule file exports one pure
function and its test imports **only** that file. No engine, no plugin, no cordis
context, no DSH runtime.

`engine.test.ts` should test the engine with a **fake rule set** (a rule that drops
everything, one that drops nothing, one that throws) so engine invariants are
proven independent of the shipped rules.

`package.json` follows the house shape (see any `@deepseek-ai/dsh-*` package):
`main: lib/index.js`, `exports` with `./src/*` passthrough so the worker can run
sources directly under `--experimental-strip-types` without a build step.

Plugin contract: `export const name`, `export const inject`, `export const apply(ctx)`.
`apply` installs the patch once and returns its disposer. `inject: ["llm"]`.

**Idempotence guard is mandatory.** Cordis may call `apply` more than once across
HMR/reload; without a guard the patch stacks and every request sanitizes N times.
Guard on a symbol-keyed flag or a WeakSet on the prototype.

**Disposal must restore** the original method, so disabling the plugin is a true
revert rather than a permanent behavioural change.

---

## 7. Test plan

The user requirement is thorough testing. `engine.ts` and every rule being pure
and dependency-free is what makes most of this cheap — and `rules/` being separate
files (§6) is what makes per-rule isolation possible at all.

### Unit — each rule in isolation

Each rule's test imports **only that rule file**. No engine, no plugin, no cordis,
no DSH runtime. A rule is a function in → reason-out; that is the whole contract.

- `tool-call-name`: empty-string `name` → reason; whitespace-only → reason;
  non-string (`null` / number / object / missing) → reason; valid name → `undefined`
- `tool-call-arguments`: empty string → reason; unparseable → reason; parses to a
  non-object (`"5"`, `"null"`, `"[]"` vs `{}` — decide and pin) → reason; valid
  object → `undefined`
- `orphan-tool-result`: no matching call → drops; matching surviving call → kept;
  matching call removed by another rule → drops
- every rule: non-tool blocks, unknown block types, and `undefined`/`null` input
  return `undefined` (never throw)
- rules are **order-independent within the content phase** — assert this with a
  pair of orders, because it is the property that keeps the set extensible

### Unit — engine invariants, proven with fake rules

Test the engine against synthetic rules, never against the shipped ones, so
engine behaviour survives any rule being added, removed, or fixed.

- **Identity**: no rule drops → returned `messages` is the **input reference**
- **No mutation**: input deep-frozen; output correct; input unchanged after
- **Accumulation**: multiple rules each dropping → all `DroppedItem`s reported,
  with correct `ruleId`, `reason`, `messageIndex`, `blockIndex`
- **Phase order**: a content rule's drop is visible to the message phase
- **Idempotence**: `heal(heal(x).messages).messages` has zero drops — asserted
  with the fake rule set _and_ the shipped set
- **Failing rule**: a rule that throws propagates (does not silently yield a
  half-repaired request, which would be worse than failing loudly)
- **Empty rule set**: a healer with no rules is a pass-through identity function

### Shipped rules — integration through the engine

Now and only now, run the real rules through the real engine:

- the poisoned fixture from §1 repairs to well-formed output
- the §1 fixture, asserted against the **exact** shape that 400'd
  (`name` non-empty, `arguments` parseable)
- mixed valid/invalid messages → only invalid removed, valid byte-identical

### Immutability & identity

- clean input → **same array reference** returned (fast path, §5)
- dirty input → new array; input array and its messages unchanged
- input is deep-frozen → still correct (never mutates)
- repeated application is idempotent
- original session projection object untouched after a call

### Streaming safety (the property the user called out)

- returned iterable is **the identical object** the unpatched runtime produced —
  assert `===`, not deep-equality
- chunk sequence (types, order, count, text) identical to unpatched baseline
- time-to-first-visible-chunk unchanged within tolerance
- the patch adds no `await` before dispatch

### Coverage across models

Run the same fixture through the repair for several provider shapes —
`anthropic-messages`, `openai-completions`, and the opencode-responses shape — and
assert one identical output. This is what backs the "works across models" claim;
without it, that claim is untested.

### Integration (against a live `LlmRuntime`)

- poisoned history → request reaches the adapter already well-formed
- clean history → adapter receives the identical options object (no needless clone)
- **both** call paths repaired: `llm.stream(request)` and `preparedCall.stream(request)`
- `prepareCall(...).stream()` after a prior `prepareCall` still repaired
- a real session poisoned the way the incident session was → next request succeeds
  where it previously 400'd

### Property / fuzz

- random malformed-block corpus never yields output containing an empty `name`
- invariant after every case: no surviving `tool_use` has an empty `name`

---

## 8. Risks

| Risk                                                              | Mitigation                                                                                                                                         |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Prototype patch lost on DSH upgrade                               | Fail loudly at `apply` if the method is absent; do not silently no-op. Re-verify line/behavior against the installed version.                      |
| Double-patching on HMR                                            | Idempotence guard (§6)                                                                                                                             |
| Over-sanitizing drops legitimate content                          | Rules are narrow and structural; every rule has a positive test that must survive. Keep them evidence-driven — each maps to a real provider error. |
| Divergence from upstream `dsh-llm`                                | Prefer landing upstream as a validation step in `buildRequest`; the plugin is the shipping-fast path, not the destination.                         |
| Empty-assistant-message rule may break a provider that accepts it | Rule is gated behind a test against real provider shapes before adoption (§7).                                                                     |

## 9. Definition of done

1. Each rule in `rules/` is a pure function whose test imports **only that file**.
2. `engine.ts` passes its invariant matrix (§7) against a fake rule set, with no
   DSH runtime involved.
3. The shipped rule set passes its own unit matrix and the §1 poisoned fixture.
4. Streaming identity test passes (`===` on the returned iterable).
5. Cross-model fixture test passes for the three protocol shapes.
6. Integration test proves a previously-400'ing request now dispatches, via **both**
   `llm.stream()` and `preparedCall.stream()`.
7. `apply` is idempotent and disposal restores the original method.
8. Missing-seam case fails loudly, not silently.
9. Adding a fourth rule requires editing no engine or patch file.

## 10. Explicitly out of scope

- Rewriting or pruning persisted session history (§3)
- Improving gateway error reporting / the `displayMsg` masking (§1)
- Retrying failed requests — 400 remains non-retryable by design; this plugin makes
  the _next_ request well-formed rather than re-sending a broken one
- Any change to `agent-loop`, `dsh-session`, or persistence internals
