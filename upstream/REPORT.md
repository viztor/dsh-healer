# Upstream report — `BlockAssembler` fabricates a durable, empty-name tool call

**Package:** `@deepseek-ai/dsh-llm`
**Version observed:** `0.2.0-rc.2`
**Files:** `lib/types/assembler.js` (source of truth), duplicated in the bundled `lib/index.js`
**Severity:** high — one malformed stream permanently poisons a session
**Status:** verified fix available; see §5 and `assembler-fix.ts`

---

## 1. Summary

`BlockAssembler.assemble()` manufactures a `tool-call` block from whatever partial
state exists. When an adapter emits `block-start` for a tool call but never a
`tool-call-delta` carrying a name, the assembler emits:

```json
{ "type": "tool-call", "id": "call-3", "name": "", "arguments": "" }
```

The id is synthesised as `call-${index}` and the name is the empty string. The
block is written into the assistant message, persisted, **never pruned**, and
re-sent on every subsequent request. Strict providers reject the entire request
before inference — `inputTokens: 0, outputTokens: 0` — with errors naming only the
name:

```
messages.115.content.3.tool_use.name: Field required     (Vertex / antigravity)
`name` must be non-empty   param: "name"                  (opencode)
```

Tolerant providers accept it, so the failure presents as intermittent and is
easily misattributed to the provider.

## 2. The asymmetry

The harness already declares the invariant this violates, and enforces it
everywhere except here.

`lib/types/assistant-stream.js:404` — the stream recorder **refuses** an
empty-name tool call:

```js
if (record.name !== undefined && (typeof record.name !== 'string' || record.name.length === 0)) {
  throw new TypeError('tool-call-chunks name must be a non-empty string');
}
```

And the accumulator deliberately routes _around_ that check for the empty case
(`assistant-stream.js:70-73`):

```js
if (chunk.id.length === 0 || chunk.name === '') {
  this.records.push({ type: 'chunk', time, chunk });
  return timed;
}
```

So the recorder will not store an empty-name tool call, while the assembler
happily **manufactures** one — and `assemble()` already throws for every _other_
incomplete block type:

```js
default: throw new Error(`cannot assemble incomplete block of type "${partial.blockType}"`);
```

A tool call with no name is an incomplete block by the same standard.

## 3. Reproduction

Feeding a bare `block-start` is sufficient:

```js
import { BlockAssembler } from '@deepseek-ai/dsh-llm';

const assembler = new BlockAssembler();
assembler.push({ type: 'block-start', index: 3, blockType: 'tool-call' });
assembler.push({ type: 'finish', reason: { kind: 'tool-calls' } });

console.log(assembler.blocks());
// [ { type: 'tool-call', id: 'call-3', name: '', arguments: '' } ]
```

Verified against the installed `0.2.0-rc.2`. `test/upstream-assembler.test.ts`
runs this as executable evidence.

### Real-world trace

A real session recorded exactly this, from an `antigravity`
(`gemini-3.8-flash-high`) stream:

- `block-start {index: 3, blockType: 'tool-call'}` is present,
- **no** `tool-call-delta` and **no** `block-end` for index 3,
- so `partial.toolCallId` and `partial.toolCallName` were never set,
- the persisted block is `{"type":"tool-call","id":"call-3","name":"","arguments":""}`
  — `call-3` is literally `call-${index}`.

A second, independent occurrence in another session (id `call-1`, index 1) shows
the same mechanism, and shows the block can sit **beside a healthy call in the
same message** — so a fix must not discard the whole assistant message.

## 4. Impact

|                         |                                                                                                                |
| ----------------------- | -------------------------------------------------------------------------------------------------------------- |
| **Durability**          | The malformed block is persisted and never pruned. Compaction does not remove it.                              |
| **Persistence of harm** | Every later request re-sends it, so a single bad stream poisons the session indefinitely.                      |
| **Blast radius**        | Any session on a strict provider; the failure looks intermittent because tolerance varies by provider.         |
| **Diagnosis cost**      | The error names a wire-level path (`messages.115.content.3.tool_use.name`) with no link back to the assembler. |
| **Secondary**           | The fabricated id can collide with a real one, since it is derived from the block index.                       |

## 5. Proposed fix

Make `assemble()` enforce the invariant the recorder already enforces, rather
than inventing a name-less call. Fail the step loudly instead of writing a poison
that outlives it.

```js
case 'tool-call': {
    // A tool call with no name cannot be executed or replayed, and a
    // synthesised id would mask the adapter defect that produced it.
    if (typeof partial.toolCallName !== 'string' || partial.toolCallName.length === 0) {
        throw new TypeError(
            `cannot assemble a tool-call block with no name (index ${index}); ` +
            'the adapter emitted block-start without a tool-call-delta carrying a name'
        );
    }
    if (typeof partial.toolCallId !== 'string' || partial.toolCallId.length === 0) {
        throw new TypeError(`cannot assemble a tool-call block with no id (index ${index})`);
    }
    return {
        type: 'tool-call',
        id: partial.toolCallId,
        name: partial.toolCallName,
        arguments: partial.toolCallArguments,
    };
}
```

**Why throw rather than drop.** Dropping would hide an adapter bug and leave the
stream internally inconsistent; throwing surfaces the real defect at the point it
occurs. The step fails, but the session survives — which is strictly better than
a session that fails on every future turn.

**Why this is small.** `assembled()` already carries a keep/drop decision for
tool calls under `max-tokens` truncation, so the shape of the invariant is
established. This extends it to the incomplete case.

**Also fix the bundled copy** at `lib/index.js` (same code, double quotes,
different indentation). The exact strings for both are in
[`assembler-fix.ts`](assembler-fix.ts), which the verification script consumes
directly so the patch cannot drift from what was tested.

### Verification

```sh
node scripts/verify-upstream-fix.mjs
```

Builds a sandbox from the installed package, proves it reproduces the defect,
applies the fix to the sandbox only, runs the spec, and removes the sandbox. The
live installation is never written to. Output on `0.2.0-rc.2`:

```
defect reproduced in the sandbox
fix applied to the sandbox copy
  ✔ SPEC: an incomplete tool call is rejected rather than fabricated
  ✔ SPEC: the emitted block carries no empty name
  ✔ a well-formed tool call still assembles correctly
  ✔ text and reasoning blocks are unaffected
PASS: the fix produces the required behaviour
```

## 6. Related, not part of this fix

- **The accumulator's empty-name escape hatch** (`assistant-stream.js:70-73`)
  is what lets the incomplete chunk through without recording it. It may be
  intentional tolerance for delta-only protocols, so it is called out rather
  than changed. If the intent is to tolerate an empty name at the _chunk_ level
  while forbidding it in the _assembled block_, the fix above is exactly the
  right boundary.
- **The synthesised id** (`call-${index}`) is reasonable as a fallback for a
  block that is otherwise complete, but it should not be reachable at all once an
  unnamed call is rejected.

## 7. Workaround shipped separately

`dsh-healer` repairs such blocks in the **outbound request** so sessions already
poisoned can recover — which an upstream fix cannot do retroactively, because the
block is already durable. The two are complementary, not alternatives. This
report covers the cause; the plugin covers the existing damage.
