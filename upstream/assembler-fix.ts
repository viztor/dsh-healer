/**
 * Upstream fix for the defect this plugin works around.
 *
 * Apply to: `@deepseek-ai/dsh-llm` — `lib/types/assembler.js` and its bundled
 * copy in `lib/index.js`. See `upstream/REPORT.md` for the full analysis.
 *
 * The defect
 * ----------
 * `BlockAssembler.assemble()` fabricates a tool-call block from whatever partial
 * state exists. When an adapter emits `block-start` for a tool call but never a
 * `tool-call-delta` — so neither id nor name was ever set — it emits:
 *
 *     { type: 'tool-call', id: 'call-3', name: '', arguments: '' }
 *
 * The id is synthesised as `call-${index}`, and the empty name violates an
 * invariant the harness enforces elsewhere: `assistant-stream.js` throws
 * `'tool-call-chunks name must be a non-empty string'` for exactly this shape.
 * So the accumulator refuses to *record* an empty-name tool call while the
 * assembler happily *manufactures* one.
 *
 * The consequence is a durable, never-pruned malformed block that every later
 * request re-sends. Strict providers reject the whole request before inference
 * with `inputTokens: 0, outputTokens: 0`.
 *
 * The fix
 * -------
 * Make `assemble()` enforce the same non-empty-name invariant the accumulator
 * already enforces, instead of inventing a name-less call. An incomplete
 * tool-call block is a stream defect, and the function already throws for every
 * other incomplete block type:
 *
 *     default: throw new Error(`cannot assemble incomplete block of type "${partial.blockType}"`);
 *
 * Throwing is the right failure: it fails the step loudly instead of writing a
 * poison that outlives the step. Dropping the block silently would be worse — it
 * would hide an adapter bug and still leave the stream inconsistent.
 *
 * Why this is a smaller change than it looks: `assembled()` already has a
 * keep/drop decision for tool calls under `max-tokens` truncation, so the shape
 * of the invariant is established; this only extends it to the incomplete case.
 */

/** The exact text to replace, in both `lib/types/assembler.js` and `lib/index.js`. */
export const FIND = `case 'tool-call': return {
                type: 'tool-call',
                id: partial.toolCallId ?? brandString(\`call-\${index}\`),
                name: partial.toolCallName ?? '',
                arguments: partial.toolCallArguments,
            };`;

/** The replacement: enforce the invariant rather than fabricate a broken block. */
export const REPLACE = `case 'tool-call': {
                // A tool call with no name cannot be executed or replayed, and a
                // synthesised id would mask the adapter defect that produced it.
                // The accumulator already rejects this shape; the assembler must
                // not manufacture what the recorder refuses to store.
                if (typeof partial.toolCallName !== 'string' || partial.toolCallName.length === 0) {
                    throw new TypeError(
                        \`cannot assemble a tool-call block with no name (index \${index}); \` +
                        'the adapter emitted block-start without a tool-call-delta carrying a name'
                    );
                }
                if (typeof partial.toolCallId !== 'string' || partial.toolCallId.length === 0) {
                    throw new TypeError(
                        \`cannot assemble a tool-call block with no id (index \${index})\`
                    );
                }
                return {
                    type: 'tool-call',
                    id: partial.toolCallId,
                    name: partial.toolCallName,
                    arguments: partial.toolCallArguments,
                };
            }`;

/** The bundled form in `lib/index.js` uses double quotes and deeper indentation. */
export const FIND_BUNDLED = `case "tool-call": return {
				type: "tool-call",
				id: partial.toolCallId ?? brandString(\`call-\${index}\`),
				name: partial.toolCallName ?? "",
				arguments: partial.toolCallArguments
			};`;

export const REPLACE_BUNDLED = `case "tool-call": {
				if (typeof partial.toolCallName !== "string" || partial.toolCallName.length === 0) throw new TypeError(\`cannot assemble a tool-call block with no name (index \${index}); the adapter emitted block-start without a tool-call-delta carrying a name\`);
				if (typeof partial.toolCallId !== "string" || partial.toolCallId.length === 0) throw new TypeError(\`cannot assemble a tool-call block with no id (index \${index})\`);
				return {
					type: "tool-call",
					id: partial.toolCallId,
					name: partial.toolCallName,
					arguments: partial.toolCallArguments
				};
			}`;
