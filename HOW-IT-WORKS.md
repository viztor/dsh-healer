# dsh-healer — how it works

A precise specification of the mechanism, accurate to the current source. Written
to be reimplementable: every predicate, ordering rule and identity guarantee below
is stated exactly as the code implements it, and every claim is exercised by a
test.

For _why_ each decision was made, see [`DECISIONS.md`](DECISIONS.md). For what is
and is not verified, see [`TESTPLAN.md`](TESTPLAN.md).

---

## 1. The one-sentence version

A host plugin patches one method on the `LlmRuntime` prototype so that, on every
outbound model request, a rule pipeline is given the message list and may remove
blocks a provider would reject — returning a new list only when it actually
removed something.

---

## 2. Where it hooks, and why there

### 2.1 The seam

```
LlmRuntime.prototype.streamWithRegistration(options, prepared)
```

Both request paths funnel through it:

```
agent-loop  llm.stream(request)              ─┐
            preparedCall.stream(request)     ─┼─► streamWithRegistration(options, prepared)
                                               │        │
                                               │        └─► ctx.waterfall(this, "llm/stream", options,
                                               │                              () => adapterStream(options, prepared))
                                               └─► adapterStream builds the wire payload
```

It is the **last point before the wire payload exists**, and the only point where
`options` can be replaced.

### 2.2 Why the obvious alternatives do not work

| Candidate                                    | Why not                                                                                                                                                                                                                                                                               |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ctx.waterfall(…, "llm/stream", …)` listener | Cordis passes a fixed `args` array to listeners and the innermost callback closes over `options`. A listener's return value becomes the chain's result but cannot substitute the arguments, so replacing `options` is **structurally impossible** — the attempt would silently no-op. |
| `registerAdapter(providers, adapter)`        | Throws `DUPLICATE_ADAPTER` for any provider another adapter already owns, which is all of them.                                                                                                                                                                                       |
| `LlmAdapter.prototype.stream`                | The base class declares no `stream`; `PiAiAdapter.prepareCall` returns a closure over its own `streamWithSnapshot`, bypassing any `stream` override.                                                                                                                                  |
| Validating inside `buildRequest`             | Would fail the request locally while leaving the assembler free to fabricate the same malformed block again — and cannot repair already-poisoned histories.                                                                                                                           |

### 2.3 What the patch is

```js
LlmRuntime.prototype.streamWithRegistration = function (options, prepared) {
  const healed = heal(options.messages); // 1
  if (healed.messages === options.messages) {
    // 2  clean path
    return original.call(this, options, prepared);
  }
  const next = { ...options, messages: healed.messages }; // 3
  if (markers.isMarked(options)) markers.mark(next); // 4
  return original.call(this, next, prepared); // 5
};
```

Five properties, each load-bearing:

1. **The whole options object is passed on**, never a bare messages array.
2. **The clean path forwards the input object itself** — no spread, no
   allocation, and the identity-keyed agent-loop marker is untouched.
3. **A repaired request is a new object** with every other field preserved.
4. **The marker is re-applied.** `markAgentLoopRequest` records the _exact object_
   in a `WeakSet`, so a spread loses it. Losing it makes
   `isAgentLoopRequest` answer `false` downstream, which skips
   `dsh-session-title`'s main-request path and fail-opens `dsh-agent-loop`'s
   request invariant.
5. **The return value is passed through untouched** — not wrapped, buffered,
   re-emitted or reordered. The wrapper is a plain synchronous function: no
   `async`, no `await`, no iteration. First-token latency is unchanged by
   construction.

### 2.4 The seam is proactive only; recovery is reactive

The patch above runs on the way **out**. It cannot be the whole story, because a
history that is already poisoned will be rejected by the provider no matter how
carefully the request is assembled — and the patch sees a request, not a session.

Recovery therefore lives on a second, independent path in `index.ts`:

```
provider rejects the request
  └─ dsh-agent-loop dispatches ctx.waterfall("agent/request-error", …)
      └─ dsh-healer's listener
          ├─ is the failure a recoverable invalid-request rejection?
          ├─ repairSessionSurface(agent.session)
          │    ├─ derive the session's model-visible messages
          │    ├─ heal them
          │    └─ project each changed message into
          │       session.surfaceManager._state.projectedMessages
          └─ return { kind: "retry" }
              └─ agent-loop re-derives the request and retries
```

Two consequences are load-bearing:

- **The repair is durable for the session, not just the request.** The projection
  is what `deriveMessages()` folds, so every later request — including auxiliary
  calls such as compaction and titling — sees clean history. The append-only log
  on disk is never rewritten, so sequence numbers and the GUI projection cache
  stay consistent.
- **The seam must not swallow the error.** An earlier revision did exactly that:
  it watched the chunk stream for a provider error, healed, and retried _inside_
  `streamWithRegistration`. The retry succeeded, so `dsh-agent-loop` never saw a
  failure, never dispatched `agent/request-error`, and the session was never
  repaired — leaving every subsequent request to pay a failed round-trip plus a
  fresh heal, forever. `fail-safe` now passes the stream through by identity, and
  `test/patch.test.ts` pins that: it asserts the returned value _is_ the provider
  stream, not merely an equivalent one.

---

## 3. The rule contract

A rule is **two pure functions**, never a mutation. The engine drives both.

```ts
interface Rule {
  readonly id: string;
  readonly kind: 'content' | 'message';
  readonly enabledByDefault: boolean;
  readonly description: string;
  readonly roles?: readonly MessageRole[];
  /**
   * A content rule is handed one block; a message rule is handed one message.
   * Both already exist — the engine builds neither — which is what keeps a clean
   * pass allocation-free. The context is REUSED across calls: read it, do not
   * retain it.
   */
  detect(target: unknown, ctx: DetectContext): Finding | readonly Finding[] | undefined;
  repair(finding: Finding, ctx: RepairContext): RepairDecision;
}

type DetectContext =
  | { phase: 'content'; messageIndex: number; blockIndex: number }
  | {
      phase: 'message';
      index: number;
      messages: readonly MessageLike[];
      survivingToolCallIds: ReadonlySet<string>;
    };

type RepairDecision =
  | { action: 'keep' }
  | { action: 'drop' }
  | { action: 'replace'; value: unknown };
```

**`detect` observes and reports. `repair` says what to do.** Neither mutates
anything. A rule never performs I/O, never logs, and never throws for input it
did not expect — a rule that throws would take down the whole request, which is
strictly worse than reporting nothing.

### 3.1 Two kinds, because the data shape differs

| kind      | target          | context                                                       |
| --------- | --------------- | ------------------------------------------------------------- |
| `content` | **one block**   | `{ phase: 'content', messageIndex, blockIndex }`              |
| `message` | **one message** | `{ phase: 'message', index, messages, survivingToolCallIds }` |

A message rule reads `.content` and `.toolCallId` from the message it is handed,
and the list and ids from the context. The earlier shape put everything in one
per-message wrapper; §4.7 records what that cost and why it went.

Orphan detection _cannot_ be a per-block rule: answering "does this tool result
still have a matching call?" requires the whole list. Forcing it into a per-block
signature would mean either a hack or a rule that silently does nothing.

### 3.2 Role scoping

```
roleAllowed(rule, role)  ⇔  rule.roles === undefined || rule.roles.includes(role)
```

A message outside a rule's `roles` is never passed to `detect`, and the skip is
recorded in `HealReport.skipped` as `{ ruleId, reason: 'role', messageIndex }`.

### 3.3 Enablement

```
isEnabled(rule, options)  ⇔  options.rules[rule.id] === undefined
                              ? rule.enabledByDefault
                              : options.rules[rule.id].enabled
```

A disabled rule is never called, and is reported once as
`{ ruleId, reason: 'disabled' }`.

---

## 4. The engine algorithm

`createHealer(rules, options)` returns `{ check, heal, rules }`. Both entry points
share one implementation, `runPass(rules, messages, options, repair)`, where
`repair` decides whether `repair()` is consulted at all.

### 4.0 Guard

```
if (!Array.isArray(messages))
  check → []
  heal  → { messages, findings: [], applied: [], skipped: [] }
```

Fail safe, not loud. This runs inside the outbound path of every model call, so a
malformed list is passed through untouched rather than becoming an exception the
plugin caused.

### 4.1 Partition rules

Walk `rules` in registration order. Disabled rules are recorded as skipped; the
rest are split into `contentRules` and `messageRules`, each preserving
registration order.

### 4.2 Content phase

For each message, **in list order**:

1. Compute the applicable rules: those whose `roles` admit this message's role.
   Every excluded rule records a role skip **once for this message**.
2. If none apply, the message's content is the original reference.
3. Otherwise, for each block, **in content order**:
   - Consult each applicable rule, **in registration order**, until one decides
     to drop.
   - For each finding the rule reports, the engine **overwrites the
     coordinates** — `messageIndex` and `blockIndex` come from the engine, not
     the rule. A rule supplies only `reason` and optional `detail`.
   - In detection mode, nothing more happens for that finding.
   - In repair mode, call `repair(finding)` and collect the decision.
   - Once a rule's decision is `drop`, later rules are not consulted for that
     block: the block is gone, so their findings would describe a message that no
     longer exists.
4. Fold the collected decisions for that block:

   | decisions                  | outcome                                      |
   | -------------------------- | -------------------------------------------- |
   | any `drop`                 | dropped (the first drop is the one reported) |
   | else any `replace`         | replaced (the **last** replace wins)         |
   | else (all `keep`, or none) | unchanged                                    |

5. Build the message's projected content **copy-on-write**: the output array is
   created lazily at the first change, from `content.slice(0, blockIndex)`, and
   subsequent blocks are appended. If nothing changed, no array is allocated and
   the original content reference is reused.

### 4.3 Message phase

For each message rule, **in registration order**:

1. `surviving` = all views not yet dropped, in original order.
2. `survivingToolCallIds` = ids collected from **assistant** views, from blocks
   with `type === 'tool-call'` whose `id` is a non-empty string.
3. Record a role skip for every surviving view outside the rule's `roles`.
4. For each surviving view **in scope**, in order:
   - Hand the rule a `MessageDetectInput` carrying the post-content-phase
     `content` and the whole surviving list.
   - For each finding: in repair mode, call `repair(finding)`:
     - `keep` → nothing.
     - `replace` → record a **whole-message replacement** for that index.
     - `drop` → mark the index dropped.
   - A later message rule sees the reduced list, because `surviving` is
     recomputed per rule.

> A message rule that is not `keep` must not be read as a drop. Treating every
> non-`keep` decision as a drop would silently discard a message the rule asked to
> rewrite — data loss, from misreading an explicit instruction.

### 4.4 Projection

Only when repairing **and** at least one fix was applied. Otherwise `messages` is
`undefined` and the caller reuses the input.

For each view, in order:

```
dropped            → omit
has replacement    → push the replacement (it supersedes content edits)
content unchanged  → push view.original        (identity preserved)
otherwise          → push { ...view.original, content: view.content }
```

### 4.5 Identity guarantees

| Situation                 | Result                                                                              |
| ------------------------- | ----------------------------------------------------------------------------------- |
| `check()`                 | Returns findings only. Never calls `repair`, never builds a message object or list. |
| `heal()`, nothing dropped | Returns the **input array reference**.                                              |
| `heal()`, some dropped    | Returns a **new array**; untouched messages keep their **object identity**.         |
| Input                     | Never mutated. Not even when it is not frozen.                                      |
| Second pass over output   | Zero findings, zero fixes, identical reference.                                     |

The last row is idempotence, and it is the property that makes the repair safe to
run on every request. It is an **engine** property for drops (the defect is gone)
and a **rule author's** obligation for replacements: a replacement must not
re-trigger its own detection.

### 4.6 Accounting

- `findings` — every detection from an enabled rule, content phase before message
  phase, in consultation order. Present in both modes.
- `applied` — what `repair` actually changed, with `action: 'drop' | 'replace'`.
  Only in repair mode.
- `skipped` — `{ ruleId, reason: 'disabled' | 'role', messageIndex? }`.

`check()` and `heal()` return the **same findings** for the same input. `heal()`
may additionally apply the orphan cascade, which detection cannot see: a result
only becomes orphaned once the content phase removes its call.

### 4.7 Zero copy — what the engine does not allocate

On a clean history a pass allocates **no message, no message list, and no
per-message wrapper**. Measured on the real 2 342-message history, one call after
a forced collection:

|                      | bytes    | per message |
| -------------------- | -------- | ----------- |
| `check(clean)`       | ~0.9 KB  | 0.4         |
| `heal(clean)`        | ~84 KB   | 36          |
| engine with no rules | ~0.85 KB | 0.4         |

Three decisions produce that:

1. **A rule is handed the thing that already exists** — a content rule its block,
   a message rule its message. The context carries the coordinates and, for a
   message rule, the surviving list and ids. An earlier design built a view object
   per message; that alone was ~93 KB on this history, for objects discarded
   immediately.
2. **The context is reused**, its fields rewritten between calls. The rule
   contract says read it, do not retain it — that is the trade that buys the
   allocation away, and it is stated in the type's doc comment.
3. **Everything optional is created on demand**: content overrides live in a map
   that is never created unless a rule changes something, the projected list is
   built only when that map exists, and the per-block decision list only when a
   rule actually reports.

The remaining ~84 KB is the **surviving-tool-call id set**. It is not a copy — it
is an index the orphan rule needs to answer its question in one pass rather than
a quadratic scan, and bisecting by rule set confirms it is the entire remaining
cost. It is named here rather than left for someone to rediscover.

Two things the earlier version did that look harmless and were not:

- **A role-skip entry per message.** On this history that was 2 498 diagnostics
  to say "these two rules never applied here" — an allocation _and_ a flood. It is
  now one entry per rule per role with a count: 6 entries.
- **A fresh empty list or outcome object per call.** `asFindings` returning `[]`,
  and the fold returning `{ dropped: false }`, are each one allocation on a path
  that runs thousands of times. Both are now shared frozen constants.

---

## 5. The shipped rules

| id                        | kind    | roles       | default | `detect` reports when                                                                                                       | `repair`                                     |
| ------------------------- | ------- | ----------- | ------- | --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `tool-call-name`          | content | `assistant` | **on**  | block type is `tool-call` or `tool_use`, and `name` is missing, non-string, or blank after `trim()`                         | drop                                         |
| `tool-call-arguments`     | content | `assistant` | off     | block type is `tool-call` or `tool_use`, and `arguments` is not a string, or does not parse to a non-null, non-array object | replace with `{ ...block, arguments: '{}' }` |
| `orphan-tool-result`      | message | `tool`      | **on**  | `toolCallId` is a non-empty string, `survivingToolCallIds` is a usable membership set, and it does **not** contain that id  | drop                                         |
| `empty-assistant-message` | message | `assistant` | off     | `content` is an array and is empty                                                                                          | drop                                         |

`tool_use` is accepted alongside `tool-call` for forward compatibility, though the
internal vocabulary only ever produces `tool-call`.

Two defaults are evidence-driven and deliberate:

- **`tool-call-arguments` is off** because the adapter already normalises bad
  arguments to `{}` (`parseArguments`), and no observed provider error implicated
  `arguments`. Enabling it _normalises_ rather than drops, so it cannot cascade
  into deleting a real tool result.
- **`orphan-tool-result` is on** because it is the cascade terminator. Removing a
  call without removing its result strands a `role:"tool"` message and produces a
  fresh rejection.

### 5.1 Why the cascade needs the phase split

The real incident's fabricated call **was dispatched and answered**, so nothing
was orphaned until `tool-call-name` removed the call. On the real 2 325-message
history the healer applies **two** fixes, not one — the call, then its now-stranded
result. That is the content-then-message ordering doing its job, and it is why the
order is structural rather than configurable.

---

## 6. A request, end to end

```
model call
  └─ agent-loop builds the request, deep-freezes messages, marks the object
      └─ llm.stream(request)  or  preparedCall.stream(request)
          └─ streamWithRegistration(options, prepared)      ◄── PATCHED
              ├─ healer.heal(options.messages)
              │   ├─ guard: is it an array?
              │   ├─ partition rules by enablement and kind
              │   ├─ CONTENT PHASE   per message → per block → per rule
              │   │     findings; decisions; fold; copy-on-write rebuild
              │   ├─ MESSAGE PHASE   per rule → per surviving view
              │   │     findings; decisions; drop or replace
              │   └─ PROJECTION      only if something was applied
              ├─ if unchanged → original.call(this, options, prepared)
              └─ else → next = { ...options, messages }; re-mark; original.call(this, next, prepared)
                  └─ ctx.waterfall("llm/stream", …)  ← listeners run here
                      └─ adapterStream → forAdapter → dispatch → provider
```

Note the ordering consequence: because the patch runs **before** the waterfall,
`llm/stream` listeners see the repaired request. That is what keeps the
agent-loop marker re-application necessary and sufficient.

---

## 7. Configuration

```ts
{
  mode: 'off' | 'check' | 'heal',   // default 'heal'
  onFindings: 'silent' | 'log' | 'throw',  // default 'log'
  strictRuleIds: true,              // default true
  rules: { [ruleId]: { enabled: boolean, options?: unknown } },
}
```

Validation happens **before anything is installed**, so a bad config cannot leave
a half-installed patch:

- Unknown top-level keys and unknown keys inside a rule entry are rejected.
- `mode` and `onFindings` must be one of the listed values.
- `rules` must be an object; each entry needs a boolean `enabled`.
- With `strictRuleIds`, a rule id that no registered rule provides is a
  **`ConfigError`**. A typo must not silently disable a protection the operator
  believes is on.

### 7.1 Modes

| mode    | what the installed wrapper does                                                                                              |
| ------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `off`   | nothing is installed; `apply` returns `{ mode: 'off', dispose() {} }`                                                        |
| `check` | detects and reports, then returns the **identical** message list — the outbound request is byte-identical to an unhealed one |
| `heal`  | detects, repairs, reports                                                                                                    |

`check` is the safe way to adopt the rules against a real history before letting
them rewrite anything.

### 7.2 `onFindings`

| value    | behaviour                                                                      |
| -------- | ------------------------------------------------------------------------------ |
| `silent` | nothing recorded                                                               |
| `log`    | one line per finding via the host logger: `ruleId message N [block M]: reason` |
| `throw`  | throws a summary naming the count and every finding, **before** dispatch       |

---

## 8. Lifecycle

### 8.1 Install

`install(target, heal, markers, mode, seamName?)`:

1. If a patch marker exists on the target:
   - **same mode** → return the existing handle (idempotent).
   - **different mode** → throw `MODE_CONFLICT`. The wrapper closes over its
     healer, so a second install could not take effect; silently keeping the first
     configuration would leave an operator who changed `check` → `heal` seeing no
     change and no error.
2. Otherwise read `target[seamName]`. If it is not a function → throw
   `SEAM_MISSING`. A silent no-op is the worst failure mode, because the plugin
   would look healthy while every poisoned request still failed.
3. Wrap, preserve the method's `name`, assign, and record a non-enumerable handle
   under `Symbol.for('dsh-healer.patched')`.

### 8.2 Dispose

Restores the original method, but **only if this handle still owns the seam**
(`target[seamName] === wrapped`). Without that guard a stale handle — one whose
patch was replaced by a later install — would clobber the newer patch. Then the
marker is cleared. Idempotent.

### 8.3 Cordis entry point

`apply(ctx, config)`:

1. Resolve the `LlmRuntime` prototype from the harness.
2. **If the live `llm` service does not inherit from that prototype, throw
   `SEAM_IDENTITY_MISMATCH`** — _before_ installing. A duplicated `dsh-llm` copy
   would make the patch target a class the runtime never uses, which fails
   silently. Checking first means a rejected load leaves the seam untouched.
3. `applyWith(config, { runtimePrototype, logger })`.
4. Register the teardown as a `ctx.effect` generator that yields the disposer.
5. Return a **callable** disposer.

Two details that a fake-context test cannot reach:

- **The return value must be callable.** Cordis reads a plugin's return value as
  an effect; a bare object is rejected with `TypeError: Invalid effect`. The
  plugin would fail to load at all under the real loader.
- **`fork.dispose()` returns a promise.** Teardown is asynchronous; callers must
  await it.

### 8.4 Resolution

`loadLlmModule()` order:

1. `DSH_HEAL_LLM_MODULE` if set — and if it fails to load, **fail loudly**. A
   mistyped override that quietly fell back to the default copy would hide the
   very packaging problem the override exists to investigate.
2. A bare `@deepseek-ai/dsh-llm` import — the correct path when installed into a
   profile, because the peer dependency resolves to the runtime's own copy.
3. A bounded-depth scan of the pnpm dlx store, for a source checkout with no
   `node_modules`. No machine-specific path is written down. The store has
   appeared at `<root>/node_modules/.pnpm`, `<root>/<entry>/node_modules/.pnpm`,
   and `<root>/<hash>/<version>/node_modules/.pnpm`, so the search looks for the
   shape rather than encoding one.

The bare specifier is tried first deliberately: it is the path that guarantees the
**same physical module** the runtime uses.

---

## 9. Guarantees, and how each is enforced

| Guarantee                                       | Enforced by                                                                                                   |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| The session log is never modified               | The repair is an outbound projection. Nothing writes back; the durable log is only read.                      |
| Streaming is not impaired                       | The wrapper returns the waterfall's value unchanged and adds no `await`.                                      |
| A clean request costs nothing                   | The fast path forwards the input object; `heal()` returns the input reference.                                |
| The agent-loop marker survives                  | Explicit re-mark on the replacement object.                                                                   |
| The patch cannot silently no-op                 | `SEAM_MISSING` when the method is absent; `SEAM_IDENTITY_MISMATCH` when the live service is a different copy. |
| Double-loading cannot stack patches             | `Symbol.for` marker plus same-mode idempotence.                                                               |
| Changing mode cannot be silently ignored        | `MODE_CONFLICT`.                                                                                              |
| Disabling the plugin is a true revert           | `dispose()` restores the original, guarded against stale handles.                                             |
| The repair is safe to repeat                    | Engine-owned drop idempotence; rule-authored replacement idempotence.                                         |
| A malformed list cannot be blamed on the plugin | The engine's fail-safe guard.                                                                                 |

---

## 10. Boundaries

**Does:**

- Repair the **outbound request**, on every model call, for every provider.
- Repair histories that are **already poisoned**, because it runs per request
  rather than once at write time.

**Does not:**

- Modify the session log, persistence, or compaction.
- Touch the response stream.
- Retry anything. `INVALID_REQUEST` stays non-retryable by design: re-sending
  identical bytes cannot fix a malformed request.
- Fix the **cause**. `BlockAssembler` fabricates the malformed block; this plugin
  cleans up after it. The upstream fix is in
  [`upstream/REPORT.md`](upstream/REPORT.md) and is deliberately _not_ applied at
  runtime — that would be a second global patch changing what gets **recorded**,
  a much larger claim than intercepting one request.
- Improve gateway error reporting.

---

## 11. Failure modes

| Situation                                  | Behaviour                                                           | Why that is right                                                                   |
| ------------------------------------------ | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Seam method missing                        | throw `SEAM_MISSING` at install                                     | A no-op would leave every poisoned request failing while the plugin looked healthy. |
| Live service is a different `dsh-llm` copy | throw `SEAM_IDENTITY_MISMATCH` before installing                    | The patch would target an unused class.                                             |
| Second install, different mode             | throw `MODE_CONFLICT`                                               | The new config could not take effect.                                               |
| Config names an unknown rule id            | throw `ConfigError` before installing                               | A typo must not silently disable a protection.                                      |
| A rule throws                              | propagates                                                          | A half-repaired request is worse than a loud failure.                               |
| A rule returns garbage                     | the engine overwrites coordinates; unknown shapes yield `undefined` | A rule must survive a vocabulary it was not written against.                        |
| `options.messages` is not an array         | pass through untouched, consult no rule                             | The plugin must never be the thing that breaks a request.                           |
| `onFindings: 'throw'` and findings exist   | throw before dispatch                                               | Explicit operator choice, for CI.                                                   |

---

## 12. Verification map

| Section                   | Exercised by                                                              |
| ------------------------- | ------------------------------------------------------------------------- |
| §2.3 patch properties     | `test/patch.test.ts`, `test/integration.test.ts`                          |
| §3 rule contract          | `test/rules/*`, `test/engine.test.ts`                                     |
| §4 engine algorithm       | `test/engine.test.ts`, `test/engine-replace.test.ts`, `test/fuzz.test.ts` |
| §4.5 identity             | `test/engine.test.ts`, `test/scale.test.ts`                               |
| §5 shipped rules          | `test/rules/*`, `test/replay.test.ts`, `test/cross-model.test.ts`         |
| §5.1 cascade on real data | `scripts/audit-session.ts` over 2 real histories                          |
| §6 full chain             | `test/chain.test.ts` (raw stream → assembler → healer → valid request)    |
| §7 config and modes       | `test/config.test.ts`, `test/plugin.test.ts`                              |
| §8 lifecycle              | `test/loader.test.ts` (real cordis `Context`), `test/markers.test.ts`     |
| §8.4 resolution           | `test/resolve-harness.test.ts`                                            |
| §11 failure modes         | `test/patch.test.ts`, `test/plugin.test.ts`, `test/markers.test.ts`       |
| Every invariant above     | `scripts/mutate.ts` — 46 mutants, each must be caught                     |
