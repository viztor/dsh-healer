var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res, err) =>
  function __init() {
    if (err) throw err[0];
    try {
      return (fn && (res = (0, fn[__getOwnPropNames(fn)[0]])((fn = 0))), res);
    } catch (e) {
      throw ((err = [e]), e);
    }
  };
var __export = (target, all) => {
  for (var name2 in all) __defProp(target, name2, { get: all[name2], enumerable: true });
};

// src/resolve-harness.ts
var resolve_harness_exports = {};
__export(resolve_harness_exports, {
  dlxRoots: () => dlxRoots,
  findHarnessInStore: () => findHarnessInStore,
  llmSpecifier: () => llmSpecifier,
  loadLlmModule: () => loadLlmModule,
  resolveHarnessEntry: () => resolveHarnessEntry,
  searchForHarness: () => searchForHarness,
  storePrefixFor: () => storePrefixFor,
});
function llmSpecifier() {
  const override = process.env.DSH_HEAL_LLM_MODULE;
  return override !== void 0 && override.length > 0 ? override : DEFAULT_LLM_PACKAGE;
}
function storePrefixFor(packageName) {
  const encoded = packageName.startsWith('@') ? packageName.replace('/', '+') : packageName;
  return `${encoded}@`;
}
function packageSegments(packageName) {
  return packageName.split('/');
}
function findHarnessInStore(store, fs, packageName = DEFAULT_LLM_PACKAGE) {
  let packages;
  try {
    packages = fs.readdir(store);
  } catch {
    return void 0;
  }
  const prefix = storePrefixFor(packageName);
  for (const pkg of packages) {
    if (!pkg.startsWith(prefix)) continue;
    const candidate = fs.join(
      store,
      pkg,
      'node_modules',
      ...packageSegments(packageName),
      'lib',
      'index.js',
    );
    if (fs.exists(candidate)) return candidate;
  }
  return void 0;
}
function dlxRoots(homedirPath, join) {
  return [
    join(homedirPath, 'Library', 'Caches', 'pnpm', 'dlx'),
    join(homedirPath, '.cache', 'pnpm', 'dlx'),
    join(homedirPath, '.local', 'share', 'pnpm', 'dlx'),
  ];
}
function resolveHarnessEntry(packageName, innerPath, fs, homedirPath, depth = 3) {
  for (const root of dlxRoots(homedirPath, fs.join)) {
    if (!fs.exists(root)) continue;
    const store = fs.join(root, 'node_modules', '.pnpm');
    if (fs.exists(store)) {
      const direct = entryIn(store, packageName, innerPath, fs);
      if (direct !== void 0) return direct;
    }
    const found = searchForHarnessEntry(root, depth, fs, packageName, innerPath);
    if (found !== void 0) return found;
  }
  return void 0;
}
function entryIn(store, packageName, innerPath, fs) {
  let packages;
  try {
    packages = fs.readdir(store);
  } catch {
    return void 0;
  }
  const prefix = storePrefixFor(packageName);
  for (const pkg of packages) {
    if (!pkg.startsWith(prefix)) continue;
    const candidate = fs.join(
      store,
      pkg,
      'node_modules',
      ...packageSegments(packageName),
      ...innerPath.split('/'),
    );
    if (fs.exists(candidate)) return candidate;
  }
  return void 0;
}
function searchForHarnessEntry(dir, depth, fs, packageName, innerPath) {
  if (depth <= 0) return void 0;
  let entries;
  try {
    entries = fs.readdir(dir);
  } catch {
    return void 0;
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === '.pnpm' || entry.startsWith('.')) continue;
    const nested = fs.join(dir, entry);
    const store = fs.join(nested, 'node_modules', '.pnpm');
    if (fs.exists(store)) {
      const found = entryIn(store, packageName, innerPath, fs);
      if (found !== void 0) return found;
    }
    const deeper = searchForHarnessEntry(nested, depth - 1, fs, packageName, innerPath);
    if (deeper !== void 0) return deeper;
  }
  return void 0;
}
function searchForHarness(dir, depth, fs, packageName = DEFAULT_LLM_PACKAGE) {
  const direct = fs.join(dir, 'node_modules', '.pnpm');
  if (fs.exists(direct)) {
    const found = findHarnessInStore(direct, fs, packageName);
    if (found !== void 0) return found;
  }
  if (depth <= 0) return void 0;
  let entries;
  try {
    entries = fs.readdir(dir);
  } catch {
    return void 0;
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === '.pnpm' || entry.startsWith('.')) continue;
    const found = searchForHarness(fs.join(dir, entry), depth - 1, fs, packageName);
    if (found !== void 0) return found;
  }
  return void 0;
}
function scanStore() {
  scanPromise ??= (async () => {
    try {
      const { readdirSync, existsSync } = await import('node:fs');
      const { homedir } = await import('node:os');
      const { join } = await import('node:path');
      const { pathToFileURL } = await import('node:url');
      const fs = {
        readdir: (dir) => readdirSync(dir),
        exists: (path) => existsSync(path),
        join: (...parts) => join(...parts),
      };
      const roots = [
        join(homedir(), 'Library', 'Caches', 'pnpm', 'dlx'),
        join(homedir(), '.cache', 'pnpm', 'dlx'),
        join(homedir(), '.local', 'share', 'pnpm', 'dlx'),
      ];
      for (const root of roots) {
        if (!existsSync(root)) continue;
        const found = searchForHarness(root, 3, fs);
        if (found !== void 0) return pathToFileURL(found).href;
      }
    } catch {}
    return void 0;
  })();
  return scanPromise;
}
async function loadLlmModule() {
  const override = process.env.DSH_HEAL_LLM_MODULE;
  if (override !== void 0 && override.length > 0) {
    try {
      return await import(override);
    } catch (error) {
      throw new Error(
        `dsh-healer: cannot import the module named by DSH_HEAL_LLM_MODULE (${override}). Underlying error: ${error.message}`,
      );
    }
  }
  const nodePaths = (process.env.NODE_PATH ?? '').split(':').filter(Boolean);
  if (nodePaths.length > 0) {
    try {
      const { createRequire: createRequire2 } = await import('node:module');
      const { pathToFileURL } = await import('node:url');
      for (const p of nodePaths) {
        try {
          const req = createRequire2(p + '/dummy.js');
          const resolved = req.resolve(DEFAULT_LLM_PACKAGE);
          return await import(pathToFileURL(resolved).href);
        } catch {}
      }
    } catch {}
  }
  try {
    return await import(DEFAULT_LLM_PACKAGE);
  } catch (bareError) {
    const scannedUrl = await scanStore();
    if (scannedUrl !== void 0) {
      return await import(scannedUrl);
    }
    throw new Error(
      `dsh-healer: cannot import ${DEFAULT_LLM_PACKAGE}. Declare it as a peerDependency so the plugin resolves the same copy the runtime uses. Underlying error: ${bareError.message}`,
    );
  }
}
var DEFAULT_LLM_PACKAGE, scanPromise;
var init_resolve_harness = __esm({
  'src/resolve-harness.ts'() {
    DEFAULT_LLM_PACKAGE = '@deepseek-ai/dsh-llm';
  },
});

// src/config.ts
import { createRequire } from 'node:module';
import { delimiter } from 'node:path';

// src/narrow.ts
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function readString(source, key) {
  if (!isRecord(source)) return void 0;
  const value = source[key];
  return typeof value === 'string' ? value : void 0;
}
function hasType(block, type) {
  return readString(block, 'type') === type;
}
function isMembershipSet(value) {
  if (value === null || value === void 0) return false;
  if (typeof value !== 'object' && typeof value !== 'function') return false;
  return typeof value.has === 'function';
}

// src/config.ts
function loadSchemastery() {
  const roots = [
    import.meta.url,
    ...(process.env.NODE_PATH ?? '')
      .split(delimiter)
      .filter(Boolean)
      .map((entry) => `${entry}/dsh-healer.cjs`),
  ];
  for (const root of roots) {
    try {
      return createRequire(root)('@deepseek-ai/schemastery');
    } catch {}
  }
  return null;
}
var z = loadSchemastery();
var Config = z
  ? z.object({
      mode: z
        .union([z.const('fail-safe'), z.const('heal'), z.const('check'), z.const('off')])
        .default('fail-safe')
        .description(
          "Operating mode: 'fail-safe' (non-intrusive auto-retry on 400 error), 'heal' (proactive sanitization), 'check' (audit only), or 'off' (disabled).",
        )
        .volatile(),
      dropEmptyToolNames: z
        .boolean()
        .default(true)
        .description('Drop tool calls with an empty name string produced by assembler defects.')
        .volatile(),
      dropOrphanedResults: z
        .boolean()
        .default(true)
        .description('Drop orphaned tool results answering calls that were dropped.')
        .volatile(),
    })
  : void 0;
var DEFAULT_CONFIG = {
  mode: 'fail-safe',
  rules: {},
  onFindings: 'log',
  strictRuleIds: true,
};
var MODES = ['off', 'check', 'heal', 'fail-safe'];
var ACTIONS = ['silent', 'log', 'throw'];
function isHealMode(value) {
  return typeof value === 'string' && MODES.includes(value);
}
function isFindingAction(value) {
  return typeof value === 'string' && ACTIONS.includes(value);
}
var ConfigError = class extends Error {
  code = 'INVALID_CONFIG';
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
};
function unwrapVolatile(value) {
  if (
    typeof value === 'object' &&
    value !== null &&
    'get' in value &&
    typeof value.get === 'function'
  ) {
    return value.get();
  }
  return value;
}
function resolveConfig(raw) {
  if (raw === void 0 || raw === null) return DEFAULT_CONFIG;
  if (!isRecord(raw)) {
    throw new ConfigError(`dsh-healer: config must be an object, got ${typeof raw}`);
  }
  const rawMode = unwrapVolatile(raw.mode);
  const mode = rawMode ?? DEFAULT_CONFIG.mode;
  if (!isHealMode(mode)) {
    throw new ConfigError(
      `dsh-healer: config.mode must be one of ${MODES.join(', ')}; got ${JSON.stringify(rawMode)}`,
    );
  }
  const rawOnFindings = unwrapVolatile(raw.onFindings);
  const onFindings = rawOnFindings ?? DEFAULT_CONFIG.onFindings;
  if (!isFindingAction(onFindings)) {
    throw new ConfigError(
      `dsh-healer: config.onFindings must be one of ${ACTIONS.join(', ')}; got ${JSON.stringify(rawOnFindings)}`,
    );
  }
  const rawStrict = unwrapVolatile(raw.strictRuleIds);
  const strictRuleIds = rawStrict ?? DEFAULT_CONFIG.strictRuleIds;
  if (typeof strictRuleIds !== 'boolean') {
    throw new ConfigError('dsh-healer: config.strictRuleIds must be a boolean');
  }
  const rules = {};
  const rawRules = unwrapVolatile(raw.rules) ?? {};
  if (!isRecord(rawRules)) {
    throw new ConfigError('dsh-healer: config.rules must be an object keyed by rule id');
  }
  for (const [ruleId, rawValue] of Object.entries(rawRules)) {
    const value = unwrapVolatile(rawValue);
    if (!isRecord(value)) {
      throw new ConfigError(`dsh-healer: config.rules["${ruleId}"] must be an object`);
    }
    const enabled = unwrapVolatile(value.enabled);
    if (typeof enabled !== 'boolean') {
      throw new ConfigError(`dsh-healer: config.rules["${ruleId}"].enabled must be a boolean`);
    }
    const known = Object.keys(value).filter((key) => key !== 'enabled' && key !== 'options');
    if (known.length > 0) {
      throw new ConfigError(
        `dsh-healer: config.rules["${ruleId}"] has unknown key(s): ${known.join(', ')}`,
      );
    }
    rules[ruleId] = {
      enabled,
      ...(value.options === void 0 ? {} : { options: unwrapVolatile(value.options) }),
    };
  }
  return { mode, rules, onFindings, strictRuleIds };
}
function healerOptions(config) {
  return { rules: config.rules };
}

// src/engine.ts
function roleOf(message) {
  return message.role;
}
function roleAllowed(rule5, role) {
  return rule5.roles === void 0 || rule5.roles.includes(role);
}
var NO_FINDINGS = Object.freeze([]);
function asFindings(result) {
  if (result === void 0) return NO_FINDINGS;
  return Array.isArray(result) ? result : [result];
}
function isEnabled(rule5, options) {
  const override = options?.rules?.[rule5.id];
  return override === void 0 ? rule5.enabledByDefault : override.enabled;
}
function unknownRuleIds(rules, options) {
  const known = new Set(rules.map((rule5) => rule5.id));
  return Object.keys(options?.rules ?? {}).filter((id5) => !known.has(id5));
}
function collectToolCallIds(messages) {
  const ids = /* @__PURE__ */ new Set();
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    for (const block of message.content) {
      if (!hasType(block, 'tool-call')) continue;
      const id5 = readString(block, 'id');
      if (id5 !== void 0 && id5.length > 0) ids.add(id5);
    }
  }
  return ids;
}
var KEPT = Object.freeze({ dropped: false });
function foldDecisions(decisions) {
  if (decisions.length === 0) return KEPT;
  let replacement;
  let hasReplacement = false;
  let source;
  for (const entry of decisions) {
    if (entry.decision.action === 'drop') return { dropped: true };
    if (entry.decision.action === 'replace') {
      replacement = entry.decision.value;
      hasReplacement = true;
      source = entry;
    }
  }
  return hasReplacement ? { dropped: false, replacement, source } : { dropped: false };
}
function runPass(rules, messages, options, repair5) {
  const findings = [];
  const applied = [];
  const skipped = [];
  const roleSkips = [];
  const noteRoleSkip = (ruleId, role) => {
    for (let i = 0; i < roleSkips.length; i += 1) {
      const entry = roleSkips[i];
      if (entry.ruleId === ruleId && entry.role === role) {
        entry.count += 1;
        return;
      }
    }
    roleSkips.push({ ruleId, role, count: 1 });
  };
  const contentRules = [];
  const messageRules = [];
  for (let r = 0; r < rules.length; r += 1) {
    const rule5 = rules[r];
    if (!isEnabled(rule5, options)) {
      skipped.push({ ruleId: rule5.id, reason: 'disabled' });
      continue;
    }
    (rule5.kind === 'content' ? contentRules : messageRules).push(rule5);
  }
  let contentOverrides;
  const contentCtx = { phase: 'content', messageIndex: 0, blockIndex: 0 };
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    const role = roleOf(message);
    let anyApplicable = false;
    for (let r = 0; r < contentRules.length; r += 1) {
      const rule5 = contentRules[r];
      if (roleAllowed(rule5, role)) anyApplicable = true;
      else noteRoleSkip(rule5.id, role);
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
        const rule5 = contentRules[r];
        if (!roleAllowed(rule5, role)) continue;
        if (dropped) break;
        const reported = asFindings(rule5.detect(block, contentCtx));
        for (let f = 0; f < reported.length; f += 1) {
          const raw = reported[f];
          const finding = {
            ruleId: rule5.id,
            reason: raw.reason,
            messageIndex: index,
            blockIndex,
            ...(raw.detail === void 0 ? {} : { detail: raw.detail }),
          };
          findings.push(finding);
          if (!repair5) continue;
          const decision = rule5.repair(finding, { phase: 'content', messages });
          (decisions ??= []).push({ ruleId: rule5.id, reason: finding.reason, decision });
          if (decision.action === 'drop') dropped = true;
        }
      }
      if (!repair5) continue;
      if (decisions === void 0) {
        next?.push(block);
        continue;
      }
      const outcome = foldDecisions(decisions);
      if (outcome.dropped) {
        const winner = decisions.find((entry) => entry.decision.action === 'drop');
        if (winner !== void 0) {
          applied.push({
            ruleId: winner.ruleId,
            reason: winner.reason,
            messageIndex: index,
            blockIndex,
            action: 'drop',
          });
        }
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
          action: 'replace',
        });
        continue;
      }
      next?.push(block);
    }
    if (next !== void 0) (contentOverrides ??= /* @__PURE__ */ new Map()).set(index, next);
  }
  const projectContent = () => {
    const overrides = contentOverrides;
    if (overrides === void 0) return messages;
    return messages.map((message, index) => {
      const content = overrides.get(index);
      return content === void 0 ? message : { ...message, content };
    });
  };
  let droppedIndexes;
  let replacedMessages;
  let base;
  const messageCtx = {
    phase: 'message',
    index: 0,
    messages,
    survivingToolCallIds: /* @__PURE__ */ new Set(),
  };
  for (let r = 0; r < messageRules.length; r += 1) {
    const rule5 = messageRules[r];
    const list = (base ??= projectContent());
    const dropped = droppedIndexes;
    const surviving = dropped === void 0 ? list : list.filter((_, index) => !dropped.has(index));
    messageCtx.messages = surviving;
    messageCtx.survivingToolCallIds = collectToolCallIds(surviving);
    for (let position = 0; position < list.length; position += 1) {
      const message = list[position];
      if (droppedIndexes?.has(position) === true) continue;
      if (!roleAllowed(rule5, message.role)) {
        noteRoleSkip(rule5.id, message.role);
        continue;
      }
      messageCtx.index = position;
      const reported = asFindings(rule5.detect(message, messageCtx));
      for (let f = 0; f < reported.length; f += 1) {
        const raw = reported[f];
        const finding = {
          ruleId: rule5.id,
          reason: raw.reason,
          messageIndex: position,
          ...(raw.blockIndex === void 0 ? {} : { blockIndex: raw.blockIndex }),
          ...(raw.detail === void 0 ? {} : { detail: raw.detail }),
        };
        findings.push(finding);
        if (!repair5) continue;
        const decision = rule5.repair(finding, { phase: 'message', messages });
        if (decision.action === 'keep') continue;
        if (decision.action === 'replace') {
          (replacedMessages ??= /* @__PURE__ */ new Map()).set(position, decision.value);
          applied.push({
            ruleId: rule5.id,
            reason: finding.reason,
            messageIndex: position,
            ...(finding.blockIndex === void 0 ? {} : { blockIndex: finding.blockIndex }),
            action: 'replace',
          });
          continue;
        }
        (droppedIndexes ??= /* @__PURE__ */ new Set()).add(position);
        applied.push({
          ruleId: rule5.id,
          reason: finding.reason,
          messageIndex: position,
          ...(finding.blockIndex === void 0 ? {} : { blockIndex: finding.blockIndex }),
          action: 'drop',
        });
      }
    }
  }
  for (let i = 0; i < roleSkips.length; i += 1) {
    const entry = roleSkips[i];
    skipped.push({ ruleId: entry.ruleId, reason: 'role', role: entry.role, count: entry.count });
  }
  if (!repair5 || applied.length === 0) {
    return { findings, applied, skipped, messages: void 0 };
  }
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
  return { findings, applied, skipped, messages: projected };
}
function createHealer(rules, options) {
  const frozenRules = [...rules];
  return {
    rules: frozenRules,
    check(messages) {
      if (!Array.isArray(messages)) return [];
      return runPass(frozenRules, messages, options, false).findings;
    },
    heal(messages) {
      if (!Array.isArray(messages)) {
        return { messages, findings: [], applied: [], skipped: [] };
      }
      const result = runPass(frozenRules, messages, options, true);
      return {
        // Identity preservation is engine policy: reuse the input reference
        // whenever nothing was applied.
        messages: result.messages ?? messages,
        findings: result.findings,
        applied: result.applied,
        skipped: result.skipped,
      };
    },
  };
}

// src/rules/tool-call-name.ts
var TOOL_CALL_TAGS = ['tool-call', 'tool_use'];
var id = 'tool-call-name';
var roles = ['assistant'];
function detect(block, _ctx) {
  if (block === void 0 || block === null) return void 0;
  const tag = readString(block, 'type');
  if (tag === void 0 || (tag !== TOOL_CALL_TAGS[0] && tag !== TOOL_CALL_TAGS[1])) {
    return void 0;
  }
  const name2 = readString(block, 'name');
  if (name2 === void 0) {
    return {
      ruleId: id,
      reason: `${tag} has no string "name"`,
      messageIndex: -1,
      detail: { tag, name: null },
    };
  }
  if (name2.trim().length === 0) {
    return {
      ruleId: id,
      reason: `${tag} has an empty "name"`,
      messageIndex: -1,
      detail: { tag, name: name2 },
    };
  }
  return void 0;
}
function repair() {
  return { action: 'drop' };
}
var rule = {
  id,
  kind: 'content',
  enabledByDefault: true,
  description: 'Drop a tool call whose name is missing, empty, or whitespace-only.',
  roles,
  detect: (block) => detect(block),
  repair: () => repair(),
};

// src/rules/tool-call-arguments.ts
var id2 = 'tool-call-arguments';
var roles2 = ['assistant'];
var NORMALISED_ARGUMENTS = '{}';
function isJsonObject(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false;
  }
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed);
}
function detect2(block, _ctx) {
  if (block === void 0 || block === null) return void 0;
  if (!hasType(block, 'tool-call') && !hasType(block, 'tool_use')) return void 0;
  const raw = readString(block, 'arguments');
  if (raw === void 0) {
    return {
      ruleId: id2,
      reason: 'tool-call has no string "arguments"',
      messageIndex: -1,
      // `repair` needs the whole block to rebuild it, so carry it here.
      detail: { block },
    };
  }
  if (!isJsonObject(raw)) {
    return {
      ruleId: id2,
      reason: 'tool-call "arguments" is not a parseable JSON object',
      messageIndex: -1,
      detail: { block },
    };
  }
  return void 0;
}
function repair2(finding) {
  const detail = finding.detail;
  if (typeof detail === 'object' && detail !== null && 'block' in detail) {
    const block = detail.block;
    if (typeof block === 'object' && block !== null && !Array.isArray(block)) {
      return {
        action: 'replace',
        value: { ...block, arguments: NORMALISED_ARGUMENTS },
      };
    }
  }
  return { action: 'drop' };
}
var rule2 = {
  id: id2,
  kind: 'content',
  enabledByDefault: false,
  description:
    'Normalise tool-call arguments that are not a parseable JSON object to {}. Disabled by default: the adapter already tolerates them.',
  roles: roles2,
  detect: (block) => detect2(block),
  repair: (finding) => repair2(finding),
};

// src/rules/orphan-tool-result.ts
var id3 = 'orphan-tool-result';
var roles3 = ['tool'];
function detect3(message, ctx) {
  if (message === void 0 || message === null) return void 0;
  const callId = message.toolCallId;
  if (typeof callId !== 'string' || callId.length === 0) {
    return void 0;
  }
  const surviving = ctx?.survivingToolCallIds;
  if (!isMembershipSet(surviving)) return void 0;
  if (surviving.has(callId)) return void 0;
  return {
    ruleId: id3,
    reason: `tool result "${callId}" has no surviving tool call`,
    messageIndex: ctx.index,
    detail: { toolCallId: callId },
  };
}
function repair3() {
  return { action: 'drop' };
}
var rule3 = {
  id: id3,
  kind: 'message',
  enabledByDefault: true,
  description:
    'Drop a tool result whose tool call did not survive the content phase (the cascade terminator).',
  roles: roles3,
  detect: (message, ctx) => detect3(message, ctx),
  repair: () => repair3(),
};

// src/rules/empty-assistant-message.ts
var id4 = 'empty-assistant-message';
var roles4 = ['assistant'];
function detect4(message, ctx) {
  if (message === void 0 || message === null) return void 0;
  const candidate = message;
  const content = candidate.content;
  if (!Array.isArray(content)) return void 0;
  if (content.length > 0) return void 0;
  return {
    ruleId: id4,
    reason: 'assistant message has no content blocks left',
    messageIndex: ctx.index,
    detail: { role: candidate.role },
  };
}
function repair4() {
  return { action: 'drop' };
}
var rule4 = {
  id: id4,
  kind: 'message',
  enabledByDefault: false,
  description:
    'Drop an assistant message whose content is empty after the content phase. Disabled by default: some providers accept content: [].',
  roles: roles4,
  detect: (message, ctx) => detect4(message, ctx),
  repair: () => repair4(),
};

// src/rules/index.ts
var DEFAULT_RULES = [rule, rule2, rule3, rule4];

// src/command.ts
function sessionMessages(session) {
  if (typeof session !== 'object' || session === null) return [];
  const s = session;
  if (typeof s.deriveMessages === 'function') {
    try {
      const derived = s.deriveMessages();
      if (Array.isArray(derived)) return derived;
    } catch {}
  }
  if (typeof s.seq === 'number' && typeof s.eventAt === 'function') {
    const messages = [];
    for (let i = 0; i < s.seq; i += 1) {
      try {
        const event = s.eventAt(i);
        const msg = event?.data?.message;
        if (typeof msg === 'object' && msg !== null) messages.push(msg);
      } catch {}
    }
    return messages;
  }
  return [];
}
function auditSessionHistory(session) {
  let emptyNames = 0;
  let orphanedResults = 0;
  const messages = sessionMessages(session);
  const totalMessages = messages.length;
  const survivingCalls = /* @__PURE__ */ new Set();
  const toolResults = [];
  for (const message of messages) {
    if (typeof message !== 'object' || message === null) continue;
    if (message.role === 'assistant' && Array.isArray(message.content)) {
      for (const block of message.content) {
        if (typeof block !== 'object' || block === null) continue;
        const b = block;
        if (b.type === 'tool-call' || b.type === 'tool_use') {
          if (typeof b.name !== 'string' || b.name.trim().length === 0) {
            emptyNames += 1;
          } else if (typeof b.id === 'string' && b.id.length > 0) {
            survivingCalls.add(b.id);
          }
        }
      }
    } else if (message.role === 'tool') {
      const callId = message.toolCallId;
      if (typeof callId === 'string' && callId.length > 0) {
        toolResults.push(callId);
      }
    }
  }
  for (const callId of toolResults) {
    if (!survivingCalls.has(callId)) {
      orphanedResults += 1;
    }
  }
  return { emptyNames, orphanedResults, totalMessages };
}
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
  if (repaired > 0 && typeof s.surfaceManager?._state?.contentGeneration === 'number') {
    s.surfaceManager._state.contentGeneration += 1;
  }
  return repaired;
}
var bi = (zh, en) => `${zh} \xB7 ${en}`;
var fact = (zh, en) => `  ${bi(zh, en)}
`;
var setting = (zh, en, value) => `  ${zh} ${en} = ${value}
`;
function executeHealCommand(invocation, controller) {
  const input = invocation.rawInput.trim().toLowerCase();
  if (input === 'auto on' || input === 'on') {
    controller.setMode('fail-safe');
    return {
      kind: 'success',
      text:
        `\u2713 ${bi('\u81EA\u52A8\u81EA\u6108\u5DF2\u5F00\u542F', 'Auto fail-safe ON')}
` +
        fact(
          '\u9047\u5230 400 \u62D2\u7EDD\u65F6\u81EA\u52A8\u4FEE\u590D\u5386\u53F2\u5E76\u91CD\u8BD5',
          'heals history and retries on a 400',
        ),
    };
  }
  if (input === 'auto off' || input === 'off') {
    controller.setMode('off');
    return {
      kind: 'success',
      text:
        `\u2713 ${bi('\u81EA\u52A8\u81EA\u6108\u5DF2\u5173\u95ED', 'Auto fail-safe OFF')}
` + fact('\u4EC5\u624B\u52A8\u4FEE\u590D', 'manual repair only \u2014 run `/heal`'),
    };
  }
  if (input === 'status') {
    const mode2 = controller.getMode();
    const rules = controller.activeRules?.() ?? [];
    const autoEn2 = mode2 === 'off' ? 'OFF' : 'ON';
    return {
      kind: 'success',
      text:
        `\u2699 ${bi('Heal \u72B6\u6001', 'Heal status')}
` +
        setting('\u8FD0\u884C\u6A21\u5F0F', 'mode', mode2) +
        setting('\u81EA\u52A8\u81EA\u6108', 'auto fail-safe', autoEn2) +
        setting('\u751F\u6548\u89C4\u5219', 'rules', rules.join(', ') || '\u2014') +
        '\n' +
        fact(
          '\u8FD0\u884C `/heal help` \u67E5\u770B\u5168\u90E8\u6307\u4EE4',
          'run `/heal help` for commands',
        ),
    };
  }
  if (input === 'help') {
    return {
      kind: 'success',
      text: `\u{1F4D6} ${bi('Heal \u6307\u4EE4', 'Heal commands')}
  \`/heal\`           ${bi('\u68C0\u67E5\u5E76\u4FEE\u590D\u4F1A\u8BDD\u65E5\u5FD7', 'audit and repair the session log')}
  \`/heal auto on\`   ${bi('\u5F00\u542F\u81EA\u52A8\u81EA\u6108', 'enable automatic recovery')}
  \`/heal auto off\`  ${bi('\u5173\u95ED\u81EA\u52A8\u81EA\u6108', 'disable automatic recovery')}
  \`/heal status\`    ${bi('\u67E5\u770B\u5F53\u524D\u914D\u7F6E', 'show current configuration')}
`,
    };
  }
  const mode = controller.getMode();
  const session = invocation.agent?.session;
  const audit = auditSessionHistory(session);
  const autoEn = mode === 'off' ? 'OFF' : 'ON';
  if (audit.emptyNames === 0 && audit.orphanedResults === 0) {
    return {
      kind: 'success',
      text:
        `\u2713 ${bi('\u4F1A\u8BDD\u5386\u53F2\u5065\u5EB7', 'Session history healthy')}
` +
        setting('\u5DF2\u626B\u63CF', 'scanned', audit.totalMessages) +
        setting('\u7A7A\u5DE5\u5177\u540D', 'empty tool names', 0) +
        setting('\u5B64\u7ACB\u7ED3\u679C', 'orphaned results', 0) +
        setting('\u81EA\u52A8\u81EA\u6108', 'auto fail-safe', autoEn),
    };
  }
  const projected = repairSessionSurface(session);
  controller.setMode('heal');
  return {
    kind: 'success',
    text:
      `\u{1F527} ${bi('\u4F1A\u8BDD\u65E5\u5FD7\u5DF2\u4FEE\u590D', 'Session log repaired')}

${bi('\u8BCA\u65AD', 'diagnosis')}
` +
      setting('\u5DF2\u626B\u63CF', 'scanned', audit.totalMessages) +
      setting('\u7A7A\u5DE5\u5177\u540D', 'empty tool names', `${audit.emptyNames} (name: "")`) +
      setting('\u5B64\u7ACB\u7ED3\u679C', 'orphaned results', audit.orphanedResults) +
      fact(
        '\u4E25\u683C\u6A21\u578B\u4F1A\u4EE5 400 \u62D2\u7EDD\u6B64\u7C7B\u5386\u53F2',
        'strict providers reject this history with 400',
      ) +
      `
${bi('\u4FEE\u590D', 'repair')}
` +
      fact(
        '\u574F\u5757\u5DF2\u4ECE\u6D88\u606F\u8868\u5C42\u5265\u79BB',
        'defective blocks stripped from the surface',
      ) +
      fact(
        projected > 0
          ? `\u5185\u5B58\u6295\u5F71\u5DF2\u66F4\u65B0\uFF08${projected} \u6761\uFF09`
          : '\u5DF2\u8FDB\u5165\u4E3B\u52A8\u6E05\u6D17\u6A21\u5F0F',
        projected > 0 ? `in-memory projection updated (${projected})` : 'proactive repair armed',
      ) +
      fact(
        '\u78C1\u76D8\u65E5\u5FD7\u672A\u6539\u52A8\uFF0C\u754C\u9762\u7F13\u5B58\u4FDD\u6301\u540C\u6B65',
        'durable log untouched, UI cache in sync',
      ) +
      `
${bi('\u4E0B\u4E00\u6B65', 'next')}
` +
      fact(
        '\u70B9\u51FB\u300C\u7EE7\u7EED\u6267\u884C\u76EE\u6807\u300D\u6216\u76F4\u63A5\u53D1\u9001\u6D88\u606F',
        'click Continue, or just send a message',
      ),
  };
}
function registerHealCommand(commands, controller) {
  return commands.register({
    name: 'heal',
    description:
      '\u4FEE\u590D\u635F\u574F\u7684\u4F1A\u8BDD\u65E5\u5FD7\uFF0C\u6216\u7BA1\u7406\u81EA\u52A8\u6545\u969C\u81EA\u6108 (Fix broken session log / fail-safe)',
    input: { hint: '[status | auto on | auto off]' },
    handler: (invocation) => executeHealCommand(invocation, controller),
  });
}

// src/markers.ts
init_resolve_harness();
var cached;
async function loadMarkers() {
  if (cached !== void 0) return cached;
  const loaded = await loadLlmModule();
  const isAgentLoopRequest = loaded.isAgentLoopRequest;
  const markAgentLoopRequest = loaded.markAgentLoopRequest;
  if (typeof isAgentLoopRequest !== 'function' || typeof markAgentLoopRequest !== 'function') {
    throw new Error(
      `dsh-healer: ${llmSpecifier()} does not export isAgentLoopRequest/markAgentLoopRequest. The DSH version may have changed; refusing to run without marker preservation.`,
    );
  }
  cached = {
    isAgentLoopRequest,
    markAgentLoopRequest,
  };
  return cached;
}
async function createMarkerPort() {
  const markers = await loadMarkers();
  return {
    isMarked: (request) => markers.isAgentLoopRequest(request),
    mark: (request) => markers.markAgentLoopRequest(request),
  };
}

// src/patch.ts
var PATCH_MARKER = /* @__PURE__ */ Symbol.for('dsh-healer.patched');
var SeamError = class extends Error {
  code;
  constructor(message, code) {
    super(message);
    this.name = 'SeamError';
    this.code = code;
  }
};
function isRecoverableError(err) {
  if (err === null || err === void 0) return false;
  if (typeof err === 'object') {
    const errorObj = err;
    if (errorObj.status === 400 || errorObj.statusCode === 400) return true;
    const code = String(errorObj.code ?? errorObj.name ?? '');
    if (
      code === 'INVALID_ARGUMENT' ||
      code === 'BAD_REQUEST' ||
      code === 'INVALID_REQUEST' ||
      code === '400'
    ) {
      return true;
    }
  }
  const str = typeof err === 'string' ? err : JSON.stringify(err);
  return (
    str.includes('400') ||
    str.includes('INVALID_ARGUMENT') ||
    str.includes('invalid_request_error') ||
    str.includes('INVALID_REQUEST') ||
    str.includes('bad_request') ||
    str.includes('tool_call') ||
    str.includes('tool call') ||
    str.includes('invalid argument')
  );
}
function wrapStreamWithRegistration(original, heal, markers, mode = 'fail-safe') {
  const getMode = typeof mode === 'function' ? mode : () => mode;
  return function streamWithRegistration(options, prepared) {
    const currentMode = getMode();
    if (currentMode === 'check') {
      heal(options.messages);
      return original.call(this, options, prepared);
    }
    if (currentMode === 'heal') {
      const healed = heal(options.messages);
      if (healed.messages === options.messages) {
        return original.call(this, options, prepared);
      }
      const next = { ...options, messages: healed.messages };
      if (markers.isMarked(options)) markers.mark(next);
      return original.call(this, next, prepared);
    }
    return original.call(this, options, prepared);
  };
}
function install(target, heal, markers, mode = 'fail-safe', seamName = 'streamWithRegistration') {
  let dynamicMode = typeof mode === 'function' ? mode() : mode;
  const getMode = typeof mode === 'function' ? mode : () => dynamicMode;
  const existing = target[PATCH_MARKER];
  if (existing !== void 0) {
    const requestedMode = getMode();
    if (existing.mode !== requestedMode) {
      throw new SeamError(
        `dsh-healer: the patch is already installed in mode "${existing.mode}", so a second install in mode "${requestedMode}" could not take effect. Dispose the existing install before changing mode.`,
        'MODE_CONFLICT',
      );
    }
    return existing;
  }
  const original = target[seamName];
  if (typeof original !== 'function') {
    throw new SeamError(
      `dsh-healer: ${seamName} is not a function on the resolved LlmRuntime prototype; the DSH version may have changed. Refusing to install a patch that would silently no-op.`,
      'SEAM_MISSING',
    );
  }
  const wrapped = wrapStreamWithRegistration(original, heal, markers, getMode);
  Object.defineProperty(wrapped, 'name', { value: seamName, configurable: true });
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
      if (target[seamName] === wrapped) {
        target[seamName] = original;
      }
      delete target[PATCH_MARKER];
    },
  };
  Object.defineProperty(target, PATCH_MARKER, {
    value: handle,
    configurable: true,
    enumerable: false,
    writable: true,
  });
  return handle;
}
function assertSeamIdentity(service, prototype) {
  let current = typeof service === 'object' && service !== null ? service : null;
  while (current !== null) {
    if (current === prototype) return;
    current = Object.getPrototypeOf(current);
  }
  throw new SeamError(
    'dsh-healer: the live `llm` service does not inherit from the LlmRuntime prototype this plugin resolved, so the patch would target an unused class. This usually means two copies of @deepseek-ai/dsh-llm are installed. Refusing to install.',
    'SEAM_IDENTITY_MISMATCH',
  );
}

// src/index.ts
var name = 'dsh-healer';
var inject = ['llm'];
function toDisposer(handle) {
  const disposer = () => handle.dispose();
  disposer.dispose = () => handle.dispose();
  return disposer;
}
var silentLogger = {
  info: () => {},
  warn: () => {},
};
async function resolveRuntimePrototype(service) {
  if (service !== void 0 && typeof service === 'object' && service !== null) {
    let current = Object.getPrototypeOf(service);
    while (current !== null && current !== Object.prototype) {
      if (typeof current.streamWithRegistration === 'function') {
        return current;
      }
      current = Object.getPrototypeOf(current);
    }
  }
  const { loadLlmModule: loadLlmModule2 } = await Promise.resolve().then(
    () => (init_resolve_harness(), resolve_harness_exports),
  );
  const loaded = await loadLlmModule2();
  const runtime = loaded.LlmRuntime ?? loaded.default;
  if (runtime === void 0 || runtime.prototype === void 0) {
    throw new Error(
      'dsh-healer: the resolved @deepseek-ai/dsh-llm does not export LlmRuntime (named or default). The DSH version may have changed; refusing to install a patch that would silently no-op.',
    );
  }
  return runtime.prototype;
}
function report(findings, config, logger) {
  if (findings.length === 0) return;
  if (config.onFindings === 'throw') {
    const detail = findings
      .map(
        (finding) =>
          `${finding.ruleId} at message ${finding.messageIndex}` +
          (finding.blockIndex === void 0 ? '' : ` block ${finding.blockIndex}`) +
          `: ${finding.reason}`,
      )
      .join('; ');
    throw new Error(`dsh-healer: ${findings.length} malformed block(s) detected (${detail})`);
  }
  if (config.onFindings === 'log') {
    for (const finding of findings) {
      logger.warn(
        `dsh-healer: ${finding.ruleId} message ${finding.messageIndex}` +
          (finding.blockIndex === void 0 ? '' : ` block ${finding.blockIndex}`) +
          `: ${finding.reason}`,
      );
    }
  }
}
async function applyWith(rawConfig, deps, rules = DEFAULT_RULES) {
  const logger = deps.logger ?? silentLogger;
  const config = resolveConfig(rawConfig);
  if (config.strictRuleIds) {
    const unknown = unknownRuleIds(rules, healerOptions(config));
    if (unknown.length > 0) {
      throw new ConfigError(
        `dsh-healer: config.rules names unknown rule id(s): ${unknown.join(', ')}. Known rules: ${rules.map((rule5) => rule5.id).join(', ')}`,
      );
    }
  }
  let currentMode = config.mode;
  if (currentMode === 'off') {
    logger.info('dsh-healer: mode "off" \u2014 no patch installed');
    return {
      get mode() {
        return currentMode;
      },
      setMode(m) {
        currentMode = m;
      },
      dispose() {},
    };
  }
  const markers = deps.markers ?? (await createMarkerPort());
  const target = deps.runtimePrototype ?? (await resolveRuntimePrototype());
  const healer = createHealer(rules, healerOptions(config));
  const handle = install(
    target,
    (messages) => {
      if (currentMode === 'check') {
        report(healer.check(messages), config, logger);
        return { messages };
      }
      const result = healer.heal(messages);
      report(result.findings, config, logger);
      return { messages: result.messages };
    },
    markers,
    () => currentMode,
  );
  logger.info(
    `dsh-healer: installed (mode=${config.mode}, rules=${
      rules
        .filter((rule5) => config.rules[rule5.id]?.enabled ?? rule5.enabledByDefault)
        .map((rule5) => rule5.id)
        .join(', ') || 'none'
    })`,
  );
  return handle;
}
async function apply(ctx, rawConfig) {
  const context = ctx;
  const service = context.get?.('llm');
  const runtimePrototype = await resolveRuntimePrototype(service);
  if (service !== void 0) {
    assertSeamIdentity(service, runtimePrototype);
  }
  const logger = context.logger ?? silentLogger;
  const resolvedConfig = resolveConfig(rawConfig);
  const handle = await applyWith(rawConfig, {
    runtimePrototype,
    logger,
  });
  const controller = {
    getMode: () => handle.mode,
    setMode: (m) => {
      handle.setMode?.(m);
      logger.info(`dsh-healer: mode changed to "${m}" via /heal command`);
    },
    activeRules: () =>
      DEFAULT_RULES.filter(
        (rule5) => resolvedConfig.rules[rule5.id]?.enabled ?? rule5.enabledByDefault,
      ).map((rule5) => rule5.id),
  };
  let unregisterCommand;
  const tryRegister = (registry) => {
    if (registry && typeof registry.register === 'function') {
      unregisterCommand = registerHealCommand(registry, controller) ?? void 0;
    }
  };
  const directCommands = context.get?.('commands');
  if (directCommands) {
    tryRegister(directCommands);
  } else if (typeof context.inject === 'function') {
    context.inject(['commands'], (commandCtx) => {
      const cmdService = commandCtx.commands ?? commandCtx.get?.('commands');
      tryRegister(cmdService);
    });
  }
  let unregisterErrorHook;
  if (typeof context.on === 'function') {
    const errorListener = context.on(
      'agent/request-error',
      async ({ agent, failure, signal }, next) => {
        if (signal?.aborted) return next();
        if (controller.getMode() === 'off') return next();
        if (!isRecoverableError(failure)) return next();
        const session = agent?.session;
        if (session === void 0) return next();
        const repaired = repairSessionSurface(session);
        if (repaired === 0) return next();
        logger.info(
          `dsh-healer: post-failure hook repaired ${repaired} defective message(s) in memory; retrying`,
        );
        return { kind: 'retry' };
      },
    );
    unregisterErrorHook = errorListener;
  }
  const patchDisposer = toDisposer(handle);
  const combinedDisposer = () => {
    patchDisposer();
    if (typeof unregisterCommand === 'function') unregisterCommand();
    if (typeof unregisterErrorHook === 'function') unregisterErrorHook();
  };
  combinedDisposer.dispose = () => combinedDisposer();
  return combinedDisposer;
}
export { Config, apply, applyWith, inject, name };
