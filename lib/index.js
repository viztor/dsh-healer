import { createRequire } from "node:module";
import { delimiter } from "node:path";
//#region \0rolldown/runtime.js
var __defProp = Object.defineProperty;
var __exportAll = (all, no_symbols) => {
	let target = {};
	for (var name in all) __defProp(target, name, {
		get: all[name],
		enumerable: true
	});
	if (!no_symbols) __defProp(target, Symbol.toStringTag, { value: "Module" });
	return target;
};
//#endregion
//#region src/narrow.ts
/**
* Shape-narrowing helpers shared by rules and the engine.
*
* These live here, and not in `engine.ts`, so a rule can be genuinely
* standalone: a rule's test must be able to import its rule without pulling in
* the engine. This module depends on nothing.
*
* Everything here is defensive by contract. A rule must survive a harness
* vocabulary it was not written against, so these never throw and never assume a
* shape.
*
* @module dsh-healer/narrow
*/
/** True when a value is a plain (non-array, non-null) object. */
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
/** Read a string field off an unknown value, or `undefined`. */
function readString(source, key) {
	if (!isRecord(source)) return void 0;
	const value = source[key];
	return typeof value === "string" ? value : void 0;
}
/** True when a value carries the given `type` tag. */
function hasType(block, type) {
	return readString(block, "type") === type;
}
/**
* True when a value behaves like a `Set` for membership testing.
*
* Used where a rule receives a collection it did not build: calling `.has` on a
* non-Set would throw and take down the request, which is strictly worse than
* declining to answer.
*/
function isMembershipSet(value) {
	if (value === null || value === void 0) return false;
	if (typeof value !== "object" && typeof value !== "function") return false;
	return typeof value.has === "function";
}
//#endregion
//#region src/config.ts
/**
* The plugin's settings schema.
*
* Every rule is individually toggleable, and the toggle set is validated: a
* configuration that names a rule which does not exist is a startup error, not a
* silent no-op. That matters because the failure mode of a typo here is a
* protection the operator believes is on but which is not.
*
* The schema is plain data plus a small validator, so the plugin carries no
* runtime dependency on a schema library and the rules stay testable alone.
*
* @module dsh-healer/config
*/
/**
* Load `@deepseek-ai/schemastery`, or `null` when it is not installed.
*
* Schemastery is deliberately **not** a dependency: the formal Config schema is
* an enhancement, and a host without it still runs — just without a settings
* projection. Two roots are tried because the harness is loaded from a pnpm dlx
* store where schemastery is a sibling of `dsh`, not of this plugin, so a
* require rooted at this module finds nothing. The `NODE_PATH` entries the host
* exports are what actually reach it; measured, not assumed.
*/
function loadSchemastery() {
	const roots = [import.meta.url, ...(process.env.NODE_PATH ?? "").split(delimiter).filter(Boolean).map((entry) => `${entry}/dsh-healer.cjs`)];
	for (const root of roots) try {
		return createRequire(root)("@deepseek-ai/schemastery");
	} catch {}
	return null;
}
const z = loadSchemastery();
/**
* Formal Cordis Config schema.
*
* Exported so DSH config editor recognizes the plugin as configurable,
* and sets `status: "schema"` in `Config.listConfigs`. Every field carries
* `.volatile()` and `.description(...)` so DSH settings projects it.
*/
const Config = z ? z.object({
	mode: z.union([
		z.const("fail-safe"),
		z.const("heal"),
		z.const("check"),
		z.const("off")
	]).default("fail-safe").description("Operating mode: 'fail-safe' (non-intrusive auto-retry on 400 error), 'heal' (proactive sanitization), 'check' (audit only), or 'off' (disabled).").volatile(),
	dropEmptyToolNames: z.boolean().default(true).description("Drop tool calls with an empty name string produced by assembler defects.").volatile(),
	dropOrphanedResults: z.boolean().default(true).description("Drop orphaned tool results answering calls that were dropped.").volatile()
}) : void 0;
/** The defaults, which are also the documented behaviour. */
const DEFAULT_CONFIG = {
	mode: "fail-safe",
	rules: {},
	onFindings: "log",
	strictRuleIds: true
};
const MODES = [
	"off",
	"check",
	"heal",
	"fail-safe"
];
const ACTIONS = [
	"silent",
	"log",
	"throw"
];
function isHealMode(value) {
	return typeof value === "string" && MODES.includes(value);
}
function isFindingAction(value) {
	return typeof value === "string" && ACTIONS.includes(value);
}
/** Raised for a configuration the plugin refuses to run with. */
var ConfigError = class extends Error {
	code = "INVALID_CONFIG";
	constructor(message) {
		super(message);
		this.name = "ConfigError";
	}
};
function unwrapVolatile(value) {
	if (typeof value === "object" && value !== null && "get" in value && typeof value.get === "function") return value.get();
	return value;
}
/**
* Validate and normalise raw settings.
*
* Unknown top-level keys and malformed rule entries are rejected rather than
* ignored, so a mistake surfaces at startup with a precise message.
*/
function resolveConfig(raw) {
	if (raw === void 0 || raw === null) return DEFAULT_CONFIG;
	if (!isRecord(raw)) throw new ConfigError(`dsh-healer: config must be an object, got ${typeof raw}`);
	const rawMode = unwrapVolatile(raw.mode);
	const mode = rawMode ?? DEFAULT_CONFIG.mode;
	if (!isHealMode(mode)) throw new ConfigError(`dsh-healer: config.mode must be one of ${MODES.join(", ")}; got ${JSON.stringify(rawMode)}`);
	const rawOnFindings = unwrapVolatile(raw.onFindings);
	const onFindings = rawOnFindings ?? DEFAULT_CONFIG.onFindings;
	if (!isFindingAction(onFindings)) throw new ConfigError(`dsh-healer: config.onFindings must be one of ${ACTIONS.join(", ")}; got ${JSON.stringify(rawOnFindings)}`);
	const strictRuleIds = unwrapVolatile(raw.strictRuleIds) ?? DEFAULT_CONFIG.strictRuleIds;
	if (typeof strictRuleIds !== "boolean") throw new ConfigError("dsh-healer: config.strictRuleIds must be a boolean");
	const rules = {};
	const rawRules = unwrapVolatile(raw.rules) ?? {};
	if (!isRecord(rawRules)) throw new ConfigError("dsh-healer: config.rules must be an object keyed by rule id");
	for (const [ruleId, rawValue] of Object.entries(rawRules)) {
		const value = unwrapVolatile(rawValue);
		if (!isRecord(value)) throw new ConfigError(`dsh-healer: config.rules["${ruleId}"] must be an object`);
		const enabled = unwrapVolatile(value.enabled);
		if (typeof enabled !== "boolean") throw new ConfigError(`dsh-healer: config.rules["${ruleId}"].enabled must be a boolean`);
		const known = Object.keys(value).filter((key) => key !== "enabled" && key !== "options");
		if (known.length > 0) throw new ConfigError(`dsh-healer: config.rules["${ruleId}"] has unknown key(s): ${known.join(", ")}`);
		rules[ruleId] = {
			enabled,
			...value.options === void 0 ? {} : { options: unwrapVolatile(value.options) }
		};
	}
	return {
		mode,
		rules,
		onFindings,
		strictRuleIds
	};
}
/** The engine options implied by a resolved config. */
function healerOptions(config) {
	return { rules: config.rules };
}
//#endregion
//#region src/engine.ts
/**
* The rule-agnostic healer engine.
*
* The engine owns everything that must hold no matter which rules are
* registered: phase ordering, role scoping, enablement, identity preservation,
* immutability, application, accounting, and diagnostics. A rule owns exactly
* one thing: judging what it is shown, and saying what to do about it.
*
* Two entry points share one detection implementation, so they cannot drift:
*
*   `check(messages)` detects and reports, and never repairs.
*   `heal(messages)` detects, repairs, and reports what it changed.
*
* ## Zero copy
*
* On a clean history a pass allocates **no message, no message list, and no
* per-message wrapper**. Three decisions get it there:
*
*   1. A content rule is handed the existing block, and a message rule the
*      existing message, as its target. The engine builds no view object — the
*      earlier design built one per message, which measured ~100 KB of garbage
*      on a 2 300-message history even when nothing changed.
*   2. The only per-call object is a **reused context** whose fields are
*      rewritten between calls. Rules read it; the contract says not to retain
*      it, and that is what buys the allocation away.
*   3. Content changes are recorded sparsely in a map that is not created unless
*      a rule actually changes something, and the projected list is built only
*      when that map exists.
*
* One thing is deliberately **not** free: `survivingToolCallIds`, a `Set` derived
* from the assistant messages. A message rule needs it to answer "does this tool
* result still have a matching call?" in one pass instead of a quadratic scan. It
* is a derived index rather than a copy, and it is named here rather than left
* for someone to rediscover.
*
* @module dsh-healer/engine
*/
function roleOf(message) {
	return message.role;
}
/** Whether a rule may be shown a message with this role. */
function roleAllowed(rule, role) {
	return rule.roles === void 0 || rule.roles.includes(role);
}
/**
* A shared empty list, returned instead of a fresh `[]`.
*
* `asFindings` is called once per rule per block. On a 2 342-message history that
* is thousands of calls, and a new empty array each time was measurable garbage.
* The result is never mutated, so one frozen instance is safe.
*/
const NO_FINDINGS = Object.freeze([]);
/** Normalise `detect`'s return into a list. */
function asFindings(result) {
	if (result === void 0) return NO_FINDINGS;
	return Array.isArray(result) ? result : [result];
}
/** Whether a rule is enabled under the resolved configuration. */
function isEnabled(rule, options) {
	const override = options?.rules?.[rule.id];
	return override === void 0 ? rule.enabledByDefault : override.enabled;
}
/** Configured rule ids that no registered rule provides. */
function unknownRuleIds(rules, options) {
	const known = new Set(rules.map((rule) => rule.id));
	return Object.keys(options?.rules ?? {}).filter((id) => !known.has(id));
}
/**
* Every tool-call id that survives, from assistant messages only.
*
* A `tool-call` parked in another role does not count: only the assistant's
* calls are sent as calls, so a result answering a non-assistant "call" is
* genuinely orphaned.
*/
function collectToolCallIds(messages) {
	const ids = /* @__PURE__ */ new Set();
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		for (const block of message.content) {
			if (!hasType(block, "tool-call")) continue;
			const id = readString(block, "id");
			if (id !== void 0 && id.length > 0) ids.add(id);
		}
	}
	return ids;
}
/**
* The outcome when no rule decided anything about a block.
*
* Shared, and returned by identity. Building `{ dropped: false }` per block looks
* expensive and is not: re-injecting it measures ~56 bytes more, because V8
* eliminates an object that never escapes. An earlier comment here claimed
* ~270 KB; that figure came from a flawed measurement and does not reproduce.
* The constant stays because it is free and honest, not because it is load-bearing.
*/
const KEPT = Object.freeze({ dropped: false });
/**
* Fold one block's repair decisions into a single outcome, in rule order.
*
* The engine — not the rule — decides precedence, so rule ordering cannot
* produce a surprising result: a drop wins immediately over any replacement, and
* a replacement from an earlier rule can be superseded by a later one.
*/
function foldDecisions(decisions) {
	if (decisions.length === 0) return KEPT;
	let replacement;
	let hasReplacement = false;
	let source;
	for (const entry of decisions) {
		if (entry.decision.action === "drop") return { dropped: true };
		if (entry.decision.action === "replace") {
			replacement = entry.decision.value;
			hasReplacement = true;
			source = entry;
		}
	}
	return hasReplacement ? {
		dropped: false,
		replacement,
		source
	} : { dropped: false };
}
/**
* Run one full pass: content phase, then message phase.
*
* `repair` decides whether `repair()` is consulted. When it is `false` this is a
* pure detection pass: no message object and no message list is constructed.
*/
function runPass(rules, messages, options, repair) {
	const findings = [];
	const applied = [];
	const skipped = [];
	/**
	* Role skips, counted per rule per role.
	*
	* Counted rather than listed: on the real 2 342-message history, one entry per
	* message produced 2 498 diagnostics to say "these two rules never applied
	* here". Counting keeps the same information in six entries.
	*
	* This is a **reporting** fix, not an allocation fix. Re-injecting the
	* per-message form measures ~344 bytes more, because V8 eliminates the
	* short-lived entries; an earlier comment here claimed it saved ~40 KB, which
	* does not reproduce.
	*/
	const roleSkips = [];
	/**
	* Count one role skip.
	*
	* A linear scan over a handful of entries, deliberately: keying a `Map` by
	* `${ruleId}\u0000${role}` built a fresh string for **every message**, which
	* measured ~40 bytes per message — more than the bookkeeping it saved. With a
	* rule set this small, the scan is free and allocates nothing.
	*/
	const noteRoleSkip = (ruleId, role) => {
		for (let i = 0; i < roleSkips.length; i += 1) {
			const entry = roleSkips[i];
			if (entry.ruleId === ruleId && entry.role === role) {
				entry.count += 1;
				return;
			}
		}
		roleSkips.push({
			ruleId,
			role,
			count: 1
		});
	};
	const contentRules = [];
	const messageRules = [];
	for (let r = 0; r < rules.length; r += 1) {
		const rule = rules[r];
		if (!isEnabled(rule, options)) {
			skipped.push({
				ruleId: rule.id,
				reason: "disabled"
			});
			continue;
		}
		(rule.kind === "content" ? contentRules : messageRules).push(rule);
	}
	/**
	* Content changes, keyed by message index.
	*
	* `undefined` until a rule actually changes something, which is what makes a
	* clean history free: no map, no projected list, no copied message.
	*/
	let contentOverrides;
	/**
	* One reused context for the whole phase. `phase` never changes; the
	* coordinates are rewritten before each call. A content rule reads the block
	* it is handed and, at most, the phase.
	*/
	const contentCtx = {
		phase: "content",
		messageIndex: 0,
		blockIndex: 0
	};
	for (let index = 0; index < messages.length; index += 1) {
		const message = messages[index];
		const role = roleOf(message);
		let anyApplicable = false;
		for (let r = 0; r < contentRules.length; r += 1) {
			const rule = contentRules[r];
			if (roleAllowed(rule, role)) anyApplicable = true;
			else noteRoleSkip(rule.id, role);
		}
		if (!anyApplicable) continue;
		let next;
		const content = message.content;
		for (let blockIndex = 0; blockIndex < content.length; blockIndex += 1) {
			const block = content[blockIndex];
			contentCtx.messageIndex = index;
			contentCtx.blockIndex = blockIndex;
			let decisions;
			let dropped = false;
			for (let r = 0; r < contentRules.length; r += 1) {
				const rule = contentRules[r];
				if (!roleAllowed(rule, role)) continue;
				if (dropped) break;
				const reported = asFindings(rule.detect(block, contentCtx));
				for (let f = 0; f < reported.length; f += 1) {
					const raw = reported[f];
					const finding = {
						ruleId: rule.id,
						reason: raw.reason,
						messageIndex: index,
						blockIndex,
						...raw.detail === void 0 ? {} : { detail: raw.detail }
					};
					findings.push(finding);
					if (!repair) continue;
					const decision = rule.repair(finding, {
						phase: "content",
						messages
					});
					(decisions ??= []).push({
						ruleId: rule.id,
						reason: finding.reason,
						decision
					});
					if (decision.action === "drop") dropped = true;
				}
			}
			if (!repair) continue;
			if (decisions === void 0) {
				next?.push(block);
				continue;
			}
			const outcome = foldDecisions(decisions);
			if (outcome.dropped) {
				const winner = decisions.find((entry) => entry.decision.action === "drop");
				if (winner !== void 0) applied.push({
					ruleId: winner.ruleId,
					reason: winner.reason,
					messageIndex: index,
					blockIndex,
					action: "drop"
				});
				next ??= message.content.slice(0, blockIndex);
				continue;
			}
			if (outcome.source !== void 0) {
				next ??= message.content.slice(0, blockIndex);
				next.push(outcome.replacement);
				applied.push({
					ruleId: outcome.source.ruleId,
					reason: outcome.source.reason,
					messageIndex: index,
					blockIndex,
					action: "replace"
				});
				continue;
			}
			next?.push(block);
		}
		if (next !== void 0) (contentOverrides ??= /* @__PURE__ */ new Map()).set(index, next);
	}
	/**
	* The post-content-phase list.
	*
	* Returns the **input array** when the content phase changed nothing, which is
	* the common case and the reason a clean pass copies no list.
	*/
	const projectContent = () => {
		const overrides = contentOverrides;
		if (overrides === void 0) return messages;
		return messages.map((message, index) => {
			const content = overrides.get(index);
			return content === void 0 ? message : {
				...message,
				content
			};
		});
	};
	let droppedIndexes;
	let replacedMessages;
	/** The post-content-phase list, built once and only if a rule needs it. */
	let base;
	/**
	* One reused context per pass. Only `index` and `survivingToolCallIds` change
	* between calls; `messages` is fixed for the rule.
	*/
	const messageCtx = {
		phase: "message",
		index: 0,
		messages,
		survivingToolCallIds: /* @__PURE__ */ new Set()
	};
	for (let r = 0; r < messageRules.length; r += 1) {
		const rule = messageRules[r];
		const list = base ??= projectContent();
		const dropped = droppedIndexes;
		const surviving = dropped === void 0 ? list : list.filter((_, index) => !dropped.has(index));
		messageCtx.messages = surviving;
		messageCtx.survivingToolCallIds = collectToolCallIds(surviving);
		for (let position = 0; position < list.length; position += 1) {
			const message = list[position];
			if (droppedIndexes?.has(position) === true) continue;
			if (!roleAllowed(rule, message.role)) {
				noteRoleSkip(rule.id, message.role);
				continue;
			}
			messageCtx.index = position;
			const reported = asFindings(rule.detect(message, messageCtx));
			for (let f = 0; f < reported.length; f += 1) {
				const raw = reported[f];
				const finding = {
					ruleId: rule.id,
					reason: raw.reason,
					messageIndex: position,
					...raw.blockIndex === void 0 ? {} : { blockIndex: raw.blockIndex },
					...raw.detail === void 0 ? {} : { detail: raw.detail }
				};
				findings.push(finding);
				if (!repair) continue;
				const decision = rule.repair(finding, {
					phase: "message",
					messages
				});
				if (decision.action === "keep") continue;
				if (decision.action === "replace") {
					(replacedMessages ??= /* @__PURE__ */ new Map()).set(position, decision.value);
					applied.push({
						ruleId: rule.id,
						reason: finding.reason,
						messageIndex: position,
						...finding.blockIndex === void 0 ? {} : { blockIndex: finding.blockIndex },
						action: "replace"
					});
					continue;
				}
				(droppedIndexes ??= /* @__PURE__ */ new Set()).add(position);
				applied.push({
					ruleId: rule.id,
					reason: finding.reason,
					messageIndex: position,
					...finding.blockIndex === void 0 ? {} : { blockIndex: finding.blockIndex },
					action: "drop"
				});
			}
		}
	}
	for (let i = 0; i < roleSkips.length; i += 1) {
		const entry = roleSkips[i];
		skipped.push({
			ruleId: entry.ruleId,
			reason: "role",
			role: entry.role,
			count: entry.count
		});
	}
	if (!repair || applied.length === 0) return {
		findings,
		applied,
		skipped,
		messages: void 0
	};
	const projected = [];
	const finalList = base ?? projectContent();
	for (let index = 0; index < finalList.length; index += 1) {
		const message = finalList[index];
		if (droppedIndexes?.has(index) === true) continue;
		const replacement = replacedMessages?.get(index);
		if (replacedMessages?.has(index) === true) {
			projected.push(replacement);
			continue;
		}
		projected.push(message);
	}
	return {
		findings,
		applied,
		skipped,
		messages: projected
	};
}
/**
* Build a healer over a fixed rule set.
*
* The engine never inspects a rule beyond the {@link Rule} contract, so adding,
* removing or reordering rules requires no engine change.
*/
function createHealer(rules, options) {
	const frozenRules = [...rules];
	return {
		rules: frozenRules,
		check(messages) {
			if (!Array.isArray(messages)) return [];
			return runPass(frozenRules, messages, options, false).findings;
		},
		heal(messages) {
			if (!Array.isArray(messages)) return {
				messages,
				findings: [],
				applied: [],
				skipped: []
			};
			const result = runPass(frozenRules, messages, options, true);
			return {
				messages: result.messages ?? messages,
				findings: result.findings,
				applied: result.applied,
				skipped: result.skipped
			};
		}
	};
}
//#endregion
//#region src/rules/tool-call-name.ts
/** Block tags that denote a model-requested tool invocation. */
const TOOL_CALL_TAGS = ["tool-call", "tool_use"];
const id$3 = "tool-call-name";
/**
* Tool calls are produced by the model, so only assistant messages are judged.
*
* The scope is deliberate, and the reason is stronger than "that is where they
* usually are". A `tool-call` block can sit in a `developer` message, but the
* pi-ai adapter rejects a developer message outright —
* `assertSupportedHistory` throws `UNSUPPORTED_CONTENT` before any block is
* projected — so a malformed name there cannot be the thing that breaks a
* request. Widening the scope would edit a message for no reason, which is the
* over-sanitization risk the design exists to avoid. Fuzzing found this
* boundary; `test/fuzz.test.ts` I1b pins it.
*/
const roles$3 = ["assistant"];
/**
* Report one block when it is a tool call with an unusable name.
*
* The engine hands the block itself, so there is nothing to unwrap — which is
* what keeps a clean pass allocation-free.
*/
function detect$3(block, _ctx) {
	if (block === void 0 || block === null) return void 0;
	const tag = readString(block, "type");
	if (tag === void 0 || tag !== TOOL_CALL_TAGS[0] && tag !== TOOL_CALL_TAGS[1]) return;
	const name = readString(block, "name");
	if (name === void 0) return {
		ruleId: id$3,
		reason: `${tag} has no string "name"`,
		messageIndex: -1,
		detail: {
			tag,
			name: null
		}
	};
	if (name.trim().length === 0) return {
		ruleId: id$3,
		reason: `${tag} has an empty "name"`,
		messageIndex: -1,
		detail: {
			tag,
			name
		}
	};
}
/** Removal is the only repair that cannot cause an unintended side effect. */
function repair$3() {
	return { action: "drop" };
}
const rule$3 = {
	id: id$3,
	kind: "content",
	enabledByDefault: true,
	description: "Drop a tool call whose name is missing, empty, or whitespace-only.",
	roles: roles$3,
	detect: (block) => detect$3(block),
	repair: () => repair$3()
};
//#endregion
//#region src/rules/tool-call-arguments.ts
const id$2 = "tool-call-arguments";
/** Tool calls are produced by the model, so only assistant messages are judged. */
const roles$2 = ["assistant"];
/** True when the string parses to a plain JSON object. */
function isJsonObject(raw) {
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return false;
	}
	return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
}
/** Report one block when it is a tool call with unusable arguments. */
function detect$2(block, _ctx) {
	if (block === void 0 || block === null) return void 0;
	if (!hasType(block, "tool-call") && !hasType(block, "tool_use")) return void 0;
	const raw = readString(block, "arguments");
	if (raw === void 0) return {
		ruleId: id$2,
		reason: "tool-call has no string \"arguments\"",
		messageIndex: -1,
		detail: { block }
	};
	if (!isJsonObject(raw)) return {
		ruleId: id$2,
		reason: "tool-call \"arguments\" is not a parseable JSON object",
		messageIndex: -1,
		detail: { block }
	};
}
/**
* Replace with `{}` — the value the pi-ai adapter already substitutes — so the
* repair reproduces existing semantics without removing the call or orphaning
* its result.
*/
function repair$2(finding) {
	const detail = finding.detail;
	if (typeof detail === "object" && detail !== null && "block" in detail) {
		const block = detail.block;
		if (typeof block === "object" && block !== null && !Array.isArray(block)) return {
			action: "replace",
			value: {
				...block,
				arguments: "{}"
			}
		};
	}
	return { action: "drop" };
}
const rule$2 = {
	id: id$2,
	kind: "content",
	enabledByDefault: false,
	description: "Normalise tool-call arguments that are not a parseable JSON object to {}. Disabled by default: the adapter already tolerates them.",
	roles: roles$2,
	detect: (block) => detect$2(block),
	repair: (finding) => repair$2(finding)
};
//#endregion
//#region src/rules/orphan-tool-result.ts
/**
* `orphan-tool-result` — drop a tool result whose tool call no longer exists.
*
* This rule is the cascade terminator, not a primary detector. In the real
* incident the fabricated call *was* dispatched and answered (`Error: unknown
* tool ""`), so nothing was orphaned until `tool-call-name` removed the call.
* Removing a call without removing its result would strand a `role:"tool"`
* message — which is why the message phase must run after the content phase.
*
* ## Whether the stranded result is fatal depends on the protocol
*
* Measured live against Anthropic Messages (`scripts/live-acceptance.mjs`,
* TESTPLAN §3l): an empty tool name is rejected with 400, while a `tool_result`
* answering a call absent from the request is **accepted**. An earlier version of
* this comment claimed it "would produce a fresh 400"; that is false for the one
* protocol we can measure, and it is corrected rather than left standing.
*
* The rule stays enabled for two reasons that do not depend on that measurement:
*
*   1. OpenAI-compatible protocols reject an unmatched tool result by contract —
*      each assistant `tool_calls` entry must be answered by a matching `tool`
*      message. That contract is **not** verified here.
*   2. A history where a result answers no call is internally inconsistent, and
*      sending it forward makes the next reader rediscover why.
*
* What the rule must never do is fire on a result whose call is still present.
* That is what the surviving-id set is for, and why a missing or non-Set
* collection means "report nothing" rather than "assume orphan".
*
* Ids may be harness-synthesised rather than provider-issued: the assembler
* falls back to `call-${index}` when a block never received an id. The rule
* therefore compares ids literally and makes no assumption about provenance.
*
* @module dsh-healer/rules/orphan-tool-result
*/
const id$1 = "orphan-tool-result";
/** Only tool-role messages carry a result to correlate. */
const roles$1 = ["tool"];
/**
* Report one message when its result answers a call that did not survive.
*
* The engine hands the message itself, so `.toolCallId` is read directly and the
* context supplies only the position and the surviving ids. Reading the message
* rather than a wrapper is what keeps a clean pass allocation-free.
*/
function detect$1(message, ctx) {
	if (message === void 0 || message === null) return void 0;
	const callId = message.toolCallId;
	if (typeof callId !== "string" || callId.length === 0) return;
	const surviving = ctx?.survivingToolCallIds;
	if (!isMembershipSet(surviving)) return void 0;
	if (surviving.has(callId)) return void 0;
	return {
		ruleId: id$1,
		reason: `tool result "${callId}" has no surviving tool call`,
		messageIndex: ctx.index,
		detail: { toolCallId: callId }
	};
}
/** A result with no call cannot be sent; the whole message goes. */
function repair$1() {
	return { action: "drop" };
}
const rule$1 = {
	id: id$1,
	kind: "message",
	enabledByDefault: true,
	description: "Drop a tool result whose tool call did not survive the content phase (the cascade terminator).",
	roles: roles$1,
	detect: (message, ctx) => detect$1(message, ctx),
	repair: () => repair$1()
};
//#endregion
//#region src/rules/empty-assistant-message.ts
const id = "empty-assistant-message";
/** Only assistant messages can be emptied by the content phase. */
const roles = ["assistant"];
/** Report one message when the content phase left it with nothing to say. */
function detect(message, ctx) {
	if (message === void 0 || message === null) return void 0;
	const candidate = message;
	const content = candidate.content;
	if (!Array.isArray(content)) return void 0;
	if (content.length > 0) return void 0;
	return {
		ruleId: id,
		reason: "assistant message has no content blocks left",
		messageIndex: ctx.index,
		detail: { role: candidate.role }
	};
}
/** An empty assistant turn carries no information; drop it. */
function repair() {
	return { action: "drop" };
}
//#endregion
//#region src/rules/index.ts
/** Every rule this package ships, enabled or not. */
const DEFAULT_RULES = [
	rule$3,
	rule$2,
	rule$1,
	{
		id,
		kind: "message",
		enabledByDefault: false,
		description: "Drop an assistant message whose content is empty after the content phase. Disabled by default: some providers accept content: [].",
		roles,
		detect: (message, ctx) => detect(message, ctx),
		repair: () => repair()
	}
];
//#endregion
//#region src/command.ts
/**
* Read a live session's model-visible messages.
*
* Prefers the session's own projection: it is exactly what the harness would
* send. Falls back to folding the raw event log when the session exposes no
* `deriveMessages` — a detached session or a test double. Returns an empty list
* for anything else, so every caller degrades to "nothing found" rather than
* throwing inside a slash command.
*/
function sessionMessages(session) {
	if (typeof session !== "object" || session === null) return [];
	const s = session;
	if (typeof s.deriveMessages === "function") try {
		const derived = s.deriveMessages();
		if (Array.isArray(derived)) return derived;
	} catch {}
	if (typeof s.seq === "number" && typeof s.eventAt === "function") {
		const messages = [];
		for (let i = 0; i < s.seq; i += 1) try {
			const msg = s.eventAt(i)?.data?.message;
			if (typeof msg === "object" && msg !== null) messages.push(msg);
		} catch {}
		return messages;
	}
	return [];
}
/** Audit a session in memory for known assembler corruption. */
function auditSessionHistory(session) {
	let emptyNames = 0;
	let orphanedResults = 0;
	const messages = sessionMessages(session);
	const totalMessages = messages.length;
	const survivingCalls = /* @__PURE__ */ new Set();
	const toolResults = [];
	for (const message of messages) {
		if (typeof message !== "object" || message === null) continue;
		if (message.role === "assistant" && Array.isArray(message.content)) for (const block of message.content) {
			if (typeof block !== "object" || block === null) continue;
			const b = block;
			if (b.type === "tool-call" || b.type === "tool_use") {
				if (typeof b.name !== "string" || b.name.trim().length === 0) emptyNames += 1;
				else if (typeof b.id === "string" && b.id.length > 0) survivingCalls.add(b.id);
			}
		}
		else if (message.role === "tool") {
			const callId = message.toolCallId;
			if (typeof callId === "string" && callId.length > 0) toolResults.push(callId);
		}
	}
	for (const callId of toolResults) if (!survivingCalls.has(callId)) orphanedResults += 1;
	return {
		emptyNames,
		orphanedResults,
		totalMessages
	};
}
/**
* Apply in-memory message projection repair to an active DSH Session.
*
* Cleans the model-visible message surface in RAM without modifying the durable
* log on disk, so the GUI cache, event sequences, and session storage remain
* 100% in sync and uncorrupted.
*
* @param session - the live session object from invocation.agent.session
* @returns number of messages repaired and projected
*/
function repairSessionSurface(session) {
	const s = session ?? {};
	const projected = s.surfaceManager?._state?.projectedMessages;
	if (projected === void 0) return 0;
	const messages = sessionMessages(s);
	if (messages.length === 0) return 0;
	const healed = createHealer(DEFAULT_RULES).heal(messages);
	if (healed.messages === messages) return 0;
	const nodes = s.surface?.nodes ?? [];
	let repaired = 0;
	for (let i = 0; i < nodes.length; i += 1) {
		const seq = nodes[i];
		const healedMessage = healed.messages[i];
		if (seq === void 0 || healedMessage === void 0) continue;
		if (messages[i] === healedMessage) continue;
		projected.set(seq, healedMessage);
		repaired += 1;
	}
	if (repaired > 0 && typeof s.surfaceManager?._state?.contentGeneration === "number") s.surfaceManager._state.contentGeneration += 1;
	return repaired;
}
/** Join a Chinese and an English phrasing of one fact. */
const bi = (zh, en) => `${zh} · ${en}`;
/** One indented bilingual phrase line. */
const fact = (zh, en) => `  ${bi(zh, en)}\n`;
/**
* One indented `label = value` line, for a value that is language-neutral.
*
* A mode name, a count or a rule id reads the same in both languages, so it
* appears once and only the label is translated. Repeating it in both halves —
* `生效规则 tool-call-name · rules tool-call-name` — is pure noise.
*/
const setting = (zh, en, value) => `  ${zh} ${en} = ${value}\n`;
/**
* Execute `/heal` given the raw input and the active controller.
*
* Every message is bilingual, one line per fact. That is a response to a
* platform limit rather than a style choice: `CommandInvocation` carries no
* locale, and the locale plugin keeps its `preference` in a settings namespace
* that is unset unless the user picks a language explicitly — so a host command
* handler cannot know which language to answer in. The first version restated
* each sentence in full in both languages, which doubled the output and read as
* noise; one line per fact carries the same information in half the space.
*/
function executeHealCommand(invocation, controller) {
	const input = invocation.rawInput.trim().toLowerCase();
	if (input === "auto on" || input === "on") {
		controller.setMode("fail-safe");
		return {
			kind: "success",
			text: `✓ ${bi("自动自愈已开启", "Auto fail-safe ON")}\n` + fact("遇到 400 拒绝时自动修复历史并重试", "heals history and retries on a 400")
		};
	}
	if (input === "auto off" || input === "off") {
		controller.setMode("off");
		return {
			kind: "success",
			text: `✓ ${bi("自动自愈已关闭", "Auto fail-safe OFF")}\n` + fact("仅手动修复", "manual repair only — run `/heal`")
		};
	}
	if (input === "status") {
		const mode = controller.getMode();
		const rules = controller.activeRules?.() ?? [];
		const autoEn = mode === "off" ? "OFF" : "ON";
		return {
			kind: "success",
			text: `⚙ ${bi("Heal 状态", "Heal status")}\n` + setting("运行模式", "mode", mode) + setting("自动自愈", "auto fail-safe", autoEn) + setting("生效规则", "rules", rules.join(", ") || "—") + "\n" + fact("运行 `/heal help` 查看全部指令", "run `/heal help` for commands")
		};
	}
	if (input === "help") return {
		kind: "success",
		text: `📖 ${bi("Heal 指令", "Heal commands")}\n  \`/heal\`           ${bi("检查并修复会话日志", "audit and repair the session log")}\n  \`/heal auto on\`   ${bi("开启自动自愈", "enable automatic recovery")}\n  \`/heal auto off\`  ${bi("关闭自动自愈", "disable automatic recovery")}\n  \`/heal status\`    ${bi("查看当前配置", "show current configuration")}\n`
	};
	const mode = controller.getMode();
	const session = invocation.agent?.session;
	const audit = auditSessionHistory(session);
	const autoEn = mode === "off" ? "OFF" : "ON";
	if (audit.emptyNames === 0 && audit.orphanedResults === 0) return {
		kind: "success",
		text: `✓ ${bi("会话历史健康", "Session history healthy")}\n` + setting("已扫描", "scanned", audit.totalMessages) + setting("空工具名", "empty tool names", 0) + setting("孤立结果", "orphaned results", 0) + setting("自动自愈", "auto fail-safe", autoEn)
	};
	const projected = repairSessionSurface(session);
	controller.setMode("heal");
	return {
		kind: "success",
		text: `🔧 ${bi("会话日志已修复", "Session log repaired")}\n\n${bi("诊断", "diagnosis")}\n` + setting("已扫描", "scanned", audit.totalMessages) + setting("空工具名", "empty tool names", `${audit.emptyNames} (name: "")`) + setting("孤立结果", "orphaned results", audit.orphanedResults) + fact("严格模型会以 400 拒绝此类历史", "strict providers reject this history with 400") + `\n${bi("修复", "repair")}\n` + fact("坏块已从消息表层剥离", "defective blocks stripped from the surface") + fact(projected > 0 ? `内存投影已更新（${projected} 条）` : "已进入主动清洗模式", projected > 0 ? `in-memory projection updated (${projected})` : "proactive repair armed") + fact("磁盘日志未改动，界面缓存保持同步", "durable log untouched, UI cache in sync") + `\n${bi("下一步", "next")}\n` + fact("点击「继续执行目标」或直接发送消息", "click Continue, or just send a message")
	};
}
/** Register the `/heal` command with the DSH commands service. */
function registerHealCommand(commands, controller) {
	return commands.register({
		name: "heal",
		description: "修复损坏的会话日志，或管理自动故障自愈 (Fix broken session log / fail-safe)",
		input: { hint: "[status | auto on | auto off]" },
		handler: (invocation) => executeHealCommand(invocation, controller)
	});
}
//#endregion
//#region src/resolve-harness.ts
var resolve_harness_exports = /* @__PURE__ */ __exportAll({
	findHarnessInStore: () => findHarnessInStore,
	llmSpecifier: () => llmSpecifier,
	loadLlmModule: () => loadLlmModule,
	searchForHarness: () => searchForHarness,
	storePrefixFor: () => storePrefixFor
});
/**
* Locating the installed harness.
*
* Two callers need this: the plugin resolving `LlmRuntime` to patch, and the
* marker bridge resolving `isAgentLoopRequest`. Both must reach the **same
* physical module** the runtime uses — a second copy would make the prototype
* patch target an unused class, which fails silently.
*
* Resolution order:
*
*   1. `DSH_HEAL_LLM_MODULE` — an explicit override (tests, and unusual hosts).
*   2. A bare `@deepseek-ai/dsh-llm` import — the correct path when this package
*      is installed into a profile, because the peer dependency resolves to the
*      runtime's own copy.
*   3. A scan of the pnpm dlx store — development ergonomics for a source
*      checkout with no `node_modules`. No machine-specific path is written
*      down; the store is found from the home directory.
*
* @module dsh-healer/resolve-harness
*/
const DEFAULT_LLM_PACKAGE = "@deepseek-ai/dsh-llm";
/** The module specifier to load, honouring the override. */
function llmSpecifier() {
	const override = process.env.DSH_HEAL_LLM_MODULE;
	return override !== void 0 && override.length > 0 ? override : DEFAULT_LLM_PACKAGE;
}
/**
* The pnpm store directory prefix for a `@deepseek-ai` package.
*
* Generalised from the llm-only original so the session package can be resolved
* the same portable way. Two resolvers with different reach is how one test ends
* up failing on a clean checkout while its neighbours pass.
*/
function storePrefixFor(packageName) {
	return `${packageName.startsWith("@") ? packageName.replace("/", "+") : packageName}@`;
}
/** A package name's path segments under `node_modules`. */
function packageSegments(packageName) {
	return packageName.split("/");
}
/**
* Path of a `@deepseek-ai` package entry point inside one `.pnpm` store.
*
* Defaults to the llm package, which is what the plugin patches. Package names are
* always **fully qualified** (`@deepseek-ai/dsh-llm`): a bare `dsh-llm` would
* encode to the wrong store prefix and silently find nothing.
*/
function findHarnessInStore(store, fs, packageName = DEFAULT_LLM_PACKAGE) {
	let packages;
	try {
		packages = fs.readdir(store);
	} catch {
		return;
	}
	const prefix = storePrefixFor(packageName);
	for (const pkg of packages) {
		if (!pkg.startsWith(prefix)) continue;
		const candidate = fs.join(store, pkg, "node_modules", ...packageSegments(packageName), "lib", "index.js");
		if (fs.exists(candidate)) return candidate;
	}
}
/**
* Search one directory for a `.pnpm` store, descending at most `depth` levels.
*
* The dlx layout is not fixed — the store has appeared at
* `<root>/node_modules/.pnpm`, `<root>/<entry>/node_modules/.pnpm`, and
* `<root>/<hash>/<version>/node_modules/.pnpm` — so rather than encode one
* shape, the search walks a bounded depth. Returns the first harness found.
*
* Defensive by contract: a missing directory, an unreadable one, or a partially
* written entry must all degrade to "not found" rather than throwing.
*/
function searchForHarness(dir, depth, fs, packageName = DEFAULT_LLM_PACKAGE) {
	const direct = fs.join(dir, "node_modules", ".pnpm");
	if (fs.exists(direct)) {
		const found = findHarnessInStore(direct, fs, packageName);
		if (found !== void 0) return found;
	}
	if (depth <= 0) return void 0;
	let entries;
	try {
		entries = fs.readdir(dir);
	} catch {
		return;
	}
	for (const entry of entries) {
		if (entry === "node_modules" || entry === ".pnpm" || entry.startsWith(".")) continue;
		const found = searchForHarness(fs.join(dir, entry), depth - 1, fs, packageName);
		if (found !== void 0) return found;
	}
}
/**
* The in-flight or completed scan, cached so it runs at most once.
*
* Caching the *promise* rather than a three-state value (`null` unscanned,
* `undefined` not found, `string` found) fixes two things at once: the result is
* plainly `string | undefined`, which a typecheck can verify, and two concurrent
* callers share one scan instead of the second returning "not found" while the
* first is still running.
*/
let scanPromise;
/** Find the harness inside a pnpm store, or `undefined`. */
function scanStore() {
	scanPromise ??= (async () => {
		try {
			const { readdirSync, existsSync } = await import("node:fs");
			const { homedir } = await import("node:os");
			const { join } = await import("node:path");
			const { pathToFileURL } = await import("node:url");
			const fs = {
				readdir: (dir) => readdirSync(dir),
				exists: (path) => existsSync(path),
				join: (...parts) => join(...parts)
			};
			const roots = [
				join(homedir(), "Library", "Caches", "pnpm", "dlx"),
				join(homedir(), ".cache", "pnpm", "dlx"),
				join(homedir(), ".local", "share", "pnpm", "dlx")
			];
			for (const root of roots) {
				if (!existsSync(root)) continue;
				const found = searchForHarness(root, 3, fs);
				if (found !== void 0) return pathToFileURL(found).href;
			}
		} catch {}
	})();
	return scanPromise;
}
/**
* Load the harness module, or throw a diagnostic naming the real cause.
*
* An explicit override must fail loudly rather than silently falling back: a
* mistyped override that quietly resolved to the default copy would hide the
* very packaging problem the override exists to investigate.
*
* The bare-specifier failure message is deliberately explicit about the peer
* dependency, because the failure it describes (a second copy, or none) is the
* one that would otherwise manifest as a patch that quietly does nothing.
*/
async function loadLlmModule() {
	const override = process.env.DSH_HEAL_LLM_MODULE;
	if (override !== void 0 && override.length > 0) try {
		return await import(override);
	} catch (error) {
		throw new Error(`dsh-healer: cannot import the module named by DSH_HEAL_LLM_MODULE (${override}). Underlying error: ${error.message}`);
	}
	const nodePaths = (process.env.NODE_PATH ?? "").split(":").filter(Boolean);
	if (nodePaths.length > 0) try {
		const { createRequire } = await import("node:module");
		const { pathToFileURL } = await import("node:url");
		for (const p of nodePaths) try {
			return await import(pathToFileURL(createRequire(p + "/dummy.js").resolve(DEFAULT_LLM_PACKAGE)).href);
		} catch {}
	} catch {}
	try {
		return await import(DEFAULT_LLM_PACKAGE);
	} catch (bareError) {
		const scannedUrl = await scanStore();
		if (scannedUrl !== void 0) return await import(scannedUrl);
		throw new Error(`dsh-healer: cannot import ${DEFAULT_LLM_PACKAGE}. Declare it as a peerDependency so the plugin resolves the same copy the runtime uses. Underlying error: ${bareError.message}`);
	}
}
//#endregion
//#region src/markers.ts
let cached;
/** Load the marker functions, or throw a diagnostic error. */
async function loadMarkers() {
	if (cached !== void 0) return cached;
	const loaded = await loadLlmModule();
	const isAgentLoopRequest = loaded.isAgentLoopRequest;
	const markAgentLoopRequest = loaded.markAgentLoopRequest;
	if (typeof isAgentLoopRequest !== "function" || typeof markAgentLoopRequest !== "function") throw new Error(`dsh-healer: ${llmSpecifier()} does not export isAgentLoopRequest/markAgentLoopRequest. The DSH version may have changed; refusing to run without marker preservation.`);
	cached = {
		isAgentLoopRequest,
		markAgentLoopRequest
	};
	return cached;
}
/**
* A `MarkerPort` that preserves the marker by delegating to the harness.
*
* Marking is what makes the repaired request indistinguishable, to downstream
* listeners, from the loop-built request it replaces.
*/
async function createMarkerPort() {
	const markers = await loadMarkers();
	return {
		isMarked: (request) => markers.isAgentLoopRequest(request),
		mark: (request) => markers.markAgentLoopRequest(request)
	};
}
//#endregion
//#region src/patch.ts
/** Key under which the installed patch records itself on the prototype. */
const PATCH_MARKER = Symbol.for("dsh-healer.patched");
/** Raised when the seam is absent or is not the one we resolved. */
var SeamError = class extends Error {
	code;
	constructor(message, code) {
		super(message);
		this.name = "SeamError";
		this.code = code;
	}
};
/** Determine whether a thrown error or failure payload indicates a provider invalid-request rejection. */
function isRecoverableError(err) {
	if (err === null || err === void 0) return false;
	if (typeof err === "object") {
		const errorObj = err;
		if (errorObj.status === 400 || errorObj.statusCode === 400) return true;
		const code = String(errorObj.code ?? errorObj.name ?? "");
		if (code === "INVALID_ARGUMENT" || code === "BAD_REQUEST" || code === "INVALID_REQUEST" || code === "400") return true;
	}
	const str = typeof err === "string" ? err : JSON.stringify(err);
	return str.includes("400") || str.includes("INVALID_ARGUMENT") || str.includes("invalid_request_error") || str.includes("INVALID_REQUEST") || str.includes("bad_request") || str.includes("tool_call") || str.includes("tool call") || str.includes("invalid argument");
}
/**
* Build the wrapped method.
*
* The wrapper does **proactive** work only: `heal` rewrites the request before
* dispatch, `check` reports without rewriting, and `off`/`fail-safe` pass the
* request and the stream straight through.
*
* `fail-safe` deliberately does **not** intercept the stream. An earlier version
* watched for a provider error chunk and healed-and-retried inside this method,
* which hid the failure from `dsh-agent-loop` — so the `agent/request-error`
* hook that repairs the *session* never ran. Every later request then paid a
* failed round-trip plus a fresh heal, indefinitely, because the durable history
* was still poisoned. Letting the error surface is what lets the hook fix the
* cause rather than one symptom of it.
*/
function wrapStreamWithRegistration(original, heal, markers, mode = "fail-safe") {
	const getMode = typeof mode === "function" ? mode : () => mode;
	return function streamWithRegistration(options, prepared) {
		const currentMode = getMode();
		if (currentMode === "check") {
			heal(options.messages);
			return original.call(this, options, prepared);
		}
		if (currentMode === "heal") {
			const healed = heal(options.messages);
			if (healed.messages === options.messages) return original.call(this, options, prepared);
			const next = {
				...options,
				messages: healed.messages
			};
			if (markers.isMarked(options)) markers.mark(next);
			return original.call(this, next, prepared);
		}
		return original.call(this, options, prepared);
	};
}
/**
* Install the patch on a prototype, once.
*
* Throws rather than no-ops when the seam is missing: a silent no-op is the
* worst failure mode here, because the plugin would appear healthy while every
* poisoned request still fails.
*
* A second install with a **different** `mode` also throws. The wrapper closes
* over its healer, so returning the existing handle would leave the new
* configuration silently inert — an operator who changed `mode: check` to
* `mode: heal` would see no change and no error. Refusing is the only outcome
* that cannot mislead. Installing again with the *same* mode is still a no-op,
* which is what makes a repeated `apply` idempotent.
*/
function install(target, heal, markers, mode = "fail-safe", seamName = "streamWithRegistration") {
	let dynamicMode = typeof mode === "function" ? mode() : mode;
	const getMode = typeof mode === "function" ? mode : () => dynamicMode;
	const existing = target[PATCH_MARKER];
	if (existing !== void 0) {
		const requestedMode = getMode();
		if (existing.mode !== requestedMode) throw new SeamError(`dsh-healer: the patch is already installed in mode "${existing.mode}", so a second install in mode "${requestedMode}" could not take effect. Dispose the existing install before changing mode.`, "MODE_CONFLICT");
		return existing;
	}
	const original = target[seamName];
	if (typeof original !== "function") throw new SeamError(`dsh-healer: ${seamName} is not a function on the resolved LlmRuntime prototype; the DSH version may have changed. Refusing to install a patch that would silently no-op.`, "SEAM_MISSING");
	const wrapped = wrapStreamWithRegistration(original, heal, markers, getMode);
	Object.defineProperty(wrapped, "name", {
		value: seamName,
		configurable: true
	});
	target[seamName] = wrapped;
	let disposed = false;
	const handle = {
		get mode() {
			return getMode();
		},
		setMode(newMode) {
			dynamicMode = newMode;
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			if (target[seamName] === wrapped) target[seamName] = original;
			delete target[PATCH_MARKER];
		}
	};
	Object.defineProperty(target, PATCH_MARKER, {
		value: handle,
		configurable: true,
		enumerable: false,
		writable: true
	});
	return handle;
}
/**
* Assert the live service really inherits from the prototype we patched.
*
* A duplicated copy of `@deepseek-ai/dsh-llm` would make `install` patch a class
* the runtime never uses, which fails silently. This turns that packaging
* accident into a loud startup error.
*/
function assertSeamIdentity(service, prototype) {
	let current = typeof service === "object" && service !== null ? service : null;
	while (current !== null) {
		if (current === prototype) return;
		current = Object.getPrototypeOf(current);
	}
	throw new SeamError("dsh-healer: the live `llm` service does not inherit from the LlmRuntime prototype this plugin resolved, so the patch would target an unused class. This usually means two copies of @deepseek-ai/dsh-llm are installed. Refusing to install.", "SEAM_IDENTITY_MISMATCH");
}
//#endregion
//#region src/index.ts
/**
* The cordis plugin: `dsh-healer`.
*
* Wires the healer, the rule set, the settings, and the prototype patch into the
* host. The heavy lifting lives in `engine.ts` (rules and invariants) and
* `patch.ts` (the seam); this module owns policy: what to install, what to
* report, and what to refuse.
*
* @module dsh-healer
*/
/** Cordis plugin name used by loader diagnostics. */
const name = "dsh-healer";
/** The service this plugin needs before it can install its patch. */
const inject = ["llm"];
/** Wrap a patch handle as a cordis-shaped disposer. */
function toDisposer(handle) {
	const disposer = (() => handle.dispose());
	disposer.dispose = () => handle.dispose();
	return disposer;
}
/**
* Used when the host supplies no logger.
*
* Deliberately silent: a library module must not assume `console` exists, and
* findings are already surfaced through the `onFindings` policy. A host that
* wants the lines passes its own logger.
*/
const silentLogger = {
	info: () => {},
	warn: () => {}
};
/**
* Resolve the `LlmRuntime` prototype from the harness.
*
* When the live service is present, its prototype chain holds the exact
* `LlmRuntime` class running in the host. Otherwise, delegates to
* `resolve-harness`.
*/
async function resolveRuntimePrototype(service) {
	if (service !== void 0 && typeof service === "object" && service !== null) {
		let current = Object.getPrototypeOf(service);
		while (current !== null && current !== Object.prototype) {
			if (typeof current.streamWithRegistration === "function") return current;
			current = Object.getPrototypeOf(current);
		}
	}
	const { loadLlmModule } = await Promise.resolve().then(() => resolve_harness_exports);
	const loaded = await loadLlmModule();
	const runtime = loaded.LlmRuntime ?? loaded.default;
	if (runtime === void 0 || runtime.prototype === void 0) throw new Error("dsh-healer: the resolved @deepseek-ai/dsh-llm does not export LlmRuntime (named or default). The DSH version may have changed; refusing to install a patch that would silently no-op.");
	return runtime.prototype;
}
/** Apply one pass's findings to the configured sink. */
function report(findings, config, logger) {
	if (findings.length === 0) return;
	if (config.onFindings === "throw") {
		const detail = findings.map((finding) => `${finding.ruleId} at message ${finding.messageIndex}` + (finding.blockIndex === void 0 ? "" : ` block ${finding.blockIndex}`) + `: ${finding.reason}`).join("; ");
		throw new Error(`dsh-healer: ${findings.length} malformed block(s) detected (${detail})`);
	}
	if (config.onFindings === "log") for (const finding of findings) logger.warn(`dsh-healer: ${finding.ruleId} message ${finding.messageIndex}` + (finding.blockIndex === void 0 ? "" : ` block ${finding.blockIndex}`) + `: ${finding.reason}`);
}
/**
* Install the healer with explicitly supplied dependencies.
*
* Separated from `apply` so the whole plugin can be exercised with a fake
* prototype and marker port, and so the seam-identity assertion is testable
* without a second copy of the harness.
*/
async function applyWith(rawConfig, deps, rules = DEFAULT_RULES) {
	const logger = deps.logger ?? silentLogger;
	const config = resolveConfig(rawConfig);
	if (config.strictRuleIds) {
		const unknown = unknownRuleIds(rules, healerOptions(config));
		if (unknown.length > 0) throw new ConfigError(`dsh-healer: config.rules names unknown rule id(s): ${unknown.join(", ")}. Known rules: ${rules.map((rule) => rule.id).join(", ")}`);
	}
	let currentMode = config.mode;
	if (currentMode === "off") {
		logger.info("dsh-healer: mode \"off\" — no patch installed");
		return {
			get mode() {
				return currentMode;
			},
			setMode(m) {
				currentMode = m;
			},
			dispose() {}
		};
	}
	const markers = deps.markers ?? await createMarkerPort();
	const target = deps.runtimePrototype ?? await resolveRuntimePrototype();
	const healer = createHealer(rules, healerOptions(config));
	const handle = install(target, (messages) => {
		if (currentMode === "check") {
			report(healer.check(messages), config, logger);
			return { messages };
		}
		const result = healer.heal(messages);
		report(result.findings, config, logger);
		return { messages: result.messages };
	}, markers, () => currentMode);
	logger.info(`dsh-healer: installed (mode=${config.mode}, rules=${rules.filter((rule) => config.rules[rule.id]?.enabled ?? rule.enabledByDefault).map((rule) => rule.id).join(", ") || "none"})`);
	return handle;
}
/**
* Cordis entry point.
*
* `apply` installs the patch once and returns its disposer, so disabling the
* plugin is a true revert rather than a permanent behavioural change.
*/
async function apply(ctx, rawConfig) {
	const context = ctx;
	const service = context.get?.("llm");
	const runtimePrototype = await resolveRuntimePrototype(service);
	if (service !== void 0) assertSeamIdentity(service, runtimePrototype);
	const logger = context.logger ?? silentLogger;
	const resolvedConfig = resolveConfig(rawConfig);
	const handle = await applyWith(rawConfig, {
		runtimePrototype,
		logger
	});
	const controller = {
		getMode: () => handle.mode,
		setMode: (m) => {
			handle.setMode?.(m);
			logger.info(`dsh-healer: mode changed to "${m}" via /heal command`);
		},
		activeRules: () => DEFAULT_RULES.filter((rule) => resolvedConfig.rules[rule.id]?.enabled ?? rule.enabledByDefault).map((rule) => rule.id)
	};
	let unregisterCommand;
	const tryRegister = (registry) => {
		if (registry && typeof registry.register === "function") unregisterCommand = registerHealCommand(registry, controller) ?? void 0;
	};
	const directCommands = context.get?.("commands");
	if (directCommands) tryRegister(directCommands);
	else if (typeof context.inject === "function") context.inject(["commands"], (commandCtx) => {
		const cmdService = commandCtx.commands ?? commandCtx.get?.("commands");
		tryRegister(cmdService);
	});
	let unregisterErrorHook;
	if (typeof context.on === "function") unregisterErrorHook = context.on("agent/request-error", async ({ agent, failure, signal }, next) => {
		if (signal?.aborted) return next();
		if (controller.getMode() === "off") return next();
		if (!isRecoverableError(failure)) return next();
		const session = agent?.session;
		if (session === void 0) return next();
		const repaired = repairSessionSurface(session);
		if (repaired === 0) return next();
		logger.info(`dsh-healer: post-failure hook repaired ${repaired} defective message(s) in memory; retrying`);
		return { kind: "retry" };
	});
	const patchDisposer = toDisposer(handle);
	const combinedDisposer = (() => {
		patchDisposer();
		if (typeof unregisterCommand === "function") unregisterCommand();
		if (typeof unregisterErrorHook === "function") unregisterErrorHook();
	});
	combinedDisposer.dispose = () => combinedDisposer();
	return combinedDisposer;
}
//#endregion
export { Config, apply, applyWith, inject, name };
