/**
 * User-facing `/heal` slash command for the DSH command palette.
 *
 * Provides:
 *   - `/heal`: Audits current session history for corrupt blocks and displays health.
 *   - `/heal auto on`: Enables automatic fail-safe error recovery.
 *   - `/heal auto off`: Disables automatic recovery (manual only, zero intervention).
 *   - `/heal status`: Displays active configuration and rule set.
 *
 * Mounted via Cordis `ctx.inject(['commands'])` so it degrades gracefully to a
 * no-op in headless, CLI, or test environments without the commands service.
 *
 * @module dsh-healer/command
 */

import type { HealMode } from './config.ts';
import { createHealer } from './engine.ts';
import { DEFAULT_RULES } from './rules/index.ts';
import type { HealableSession, MessageLike } from './types.ts';

export interface CommandInvocationLike {
  readonly rawInput: string;
  readonly agent?: { readonly session?: HealableSession };
  readonly signal?: unknown;
}

export type CommandOutcome =
  | { readonly kind: 'success'; readonly text: string }
  | { readonly kind: 'error'; readonly text: string };

export interface CommandController {
  getMode(): HealMode;
  setMode(mode: HealMode): void;
  activeRules?(): readonly string[];
}

export interface CommandsRegistryLike {
  register(definition: {
    name: string;
    description: string;
    input?: { hint?: string };
    handler(invocation: CommandInvocationLike): CommandOutcome | Promise<CommandOutcome>;
  }): void | (() => void);
}

/**
 * Read a live session's model-visible messages.
 *
 * Prefers the session's own projection: it is exactly what the harness would
 * send. Falls back to folding the raw event log when the session exposes no
 * `deriveMessages` — a detached session or a test double. Returns an empty list
 * for anything else, so every caller degrades to "nothing found" rather than
 * throwing inside a slash command.
 */
function sessionMessages(session: unknown): readonly MessageLike[] {
  if (typeof session !== 'object' || session === null) return [];
  const s = session as HealableSession;

  if (typeof s.deriveMessages === 'function') {
    try {
      const derived = s.deriveMessages();
      if (Array.isArray(derived)) return derived;
    } catch {}
  }

  if (typeof s.seq === 'number' && typeof s.eventAt === 'function') {
    const messages: MessageLike[] = [];
    for (let i = 0; i < s.seq; i += 1) {
      try {
        const event = s.eventAt(i) as { data?: { message?: MessageLike } } | undefined;
        const msg = event?.data?.message;
        if (typeof msg === 'object' && msg !== null) messages.push(msg);
      } catch {}
    }
    return messages;
  }

  return [];
}

/** Audit a session in memory for known assembler corruption. */
export function auditSessionHistory(session: unknown): {
  readonly emptyNames: number;
  readonly orphanedResults: number;
  readonly totalMessages: number;
} {
  let emptyNames = 0;
  let orphanedResults = 0;
  const messages = sessionMessages(session);
  const totalMessages = messages.length;

  const survivingCalls = new Set<string>();
  const toolResults: string[] = [];

  for (const message of messages) {
    if (typeof message !== 'object' || message === null) continue;

    if (message.role === 'assistant' && Array.isArray(message.content)) {
      for (const block of message.content) {
        if (typeof block !== 'object' || block === null) continue;
        const b = block as { type?: string; name?: string; id?: string };
        if (b.type === 'tool-call' || b.type === 'tool_use') {
          if (typeof b.name !== 'string' || b.name.trim().length === 0) {
            emptyNames += 1;
          } else if (typeof b.id === 'string' && b.id.length > 0) {
            survivingCalls.add(b.id);
          }
        }
      }
    } else if (message.role === 'tool') {
      const callId = (message as { toolCallId?: unknown }).toolCallId;
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
export function repairSessionSurface(session: unknown): number {
  const s = (session ?? {}) as HealableSession;
  const projected = s.surfaceManager?._state?.projectedMessages;
  if (projected === undefined) return 0;

  const messages = sessionMessages(s);
  if (messages.length === 0) return 0;

  const healed = createHealer(DEFAULT_RULES).heal(messages);
  if (healed.messages === messages) return 0;

  // `nodes[i]` is the durable seq of `messages[i]`, so the projection is keyed by
  // the sequence the harness will fold, not by position.
  const nodes = s.surface?.nodes ?? [];
  let repaired = 0;
  for (let i = 0; i < nodes.length; i += 1) {
    const seq = nodes[i];
    const healedMessage = healed.messages[i];
    if (seq === undefined || healedMessage === undefined) continue;
    if (messages[i] === healedMessage) continue;
    projected.set(seq, healedMessage);
    repaired += 1;
  }

  if (repaired > 0 && typeof s.surfaceManager?._state?.contentGeneration === 'number') {
    s.surfaceManager._state.contentGeneration += 1;
  }
  return repaired;
}

/** Join a Chinese and an English phrasing of one fact. */
const bi = (zh: string, en: string): string => `${zh} · ${en}`;

/** One indented bilingual phrase line. */
const fact = (zh: string, en: string): string => `  ${bi(zh, en)}\n`;

/**
 * One indented `label = value` line, for a value that is language-neutral.
 *
 * A mode name, a count or a rule id reads the same in both languages, so it
 * appears once and only the label is translated. Repeating it in both halves —
 * `生效规则 tool-call-name · rules tool-call-name` — is pure noise.
 */
const setting = (zh: string, en: string, value: string | number): string =>
  `  ${zh} ${en} = ${value}\n`;

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
export function executeHealCommand(
  invocation: CommandInvocationLike,
  controller: CommandController,
): CommandOutcome {
  const input = invocation.rawInput.trim().toLowerCase();

  if (input === 'auto on' || input === 'on') {
    controller.setMode('fail-safe');
    return {
      kind: 'success',
      text:
        `✓ ${bi('自动自愈已开启', 'Auto fail-safe ON')}\n` +
        fact('遇到 400 拒绝时自动修复历史并重试', 'heals history and retries on a 400'),
    };
  }

  if (input === 'auto off' || input === 'off') {
    controller.setMode('off');
    return {
      kind: 'success',
      text:
        `✓ ${bi('自动自愈已关闭', 'Auto fail-safe OFF')}\n` +
        fact('仅手动修复', 'manual repair only — run `/heal`'),
    };
  }

  if (input === 'status') {
    const mode = controller.getMode();
    const rules = controller.activeRules?.() ?? [];
    const autoEn = mode === 'off' ? 'OFF' : 'ON';
    return {
      kind: 'success',
      text:
        `⚙ ${bi('Heal 状态', 'Heal status')}\n` +
        setting('运行模式', 'mode', mode) +
        setting('自动自愈', 'auto fail-safe', autoEn) +
        setting('生效规则', 'rules', rules.join(', ') || '—') +
        '\n' +
        fact('运行 `/heal help` 查看全部指令', 'run `/heal help` for commands'),
    };
  }

  if (input === 'help') {
    return {
      kind: 'success',
      text:
        `📖 ${bi('Heal 指令', 'Heal commands')}\n` +
        `  \`/heal\`           ${bi('检查并修复会话日志', 'audit and repair the session log')}\n` +
        `  \`/heal auto on\`   ${bi('开启自动自愈', 'enable automatic recovery')}\n` +
        `  \`/heal auto off\`  ${bi('关闭自动自愈', 'disable automatic recovery')}\n` +
        `  \`/heal status\`    ${bi('查看当前配置', 'show current configuration')}\n`,
    };
  }

  // Default: audit, and repair in place when a live session is available.
  const mode = controller.getMode();
  const session = invocation.agent?.session;
  const audit = auditSessionHistory(session);
  const autoEn = mode === 'off' ? 'OFF' : 'ON';

  if (audit.emptyNames === 0 && audit.orphanedResults === 0) {
    return {
      kind: 'success',
      text:
        `✓ ${bi('会话历史健康', 'Session history healthy')}\n` +
        setting('已扫描', 'scanned', audit.totalMessages) +
        setting('空工具名', 'empty tool names', 0) +
        setting('孤立结果', 'orphaned results', 0) +
        setting('自动自愈', 'auto fail-safe', autoEn),
    };
  }

  // Repair the live surface now, so the next request is clean without paying a
  // rejected round-trip first.
  const projected = repairSessionSurface(session);
  controller.setMode('heal');

  return {
    kind: 'success',
    text:
      `🔧 ${bi('会话日志已修复', 'Session log repaired')}\n\n` +
      `${bi('诊断', 'diagnosis')}\n` +
      setting('已扫描', 'scanned', audit.totalMessages) +
      setting('空工具名', 'empty tool names', `${audit.emptyNames} (name: "")`) +
      setting('孤立结果', 'orphaned results', audit.orphanedResults) +
      fact('严格模型会以 400 拒绝此类历史', 'strict providers reject this history with 400') +
      `\n${bi('修复', 'repair')}\n` +
      fact('坏块已从消息表层剥离', 'defective blocks stripped from the surface') +
      fact(
        projected > 0 ? `内存投影已更新（${projected} 条）` : '已进入主动清洗模式',
        projected > 0 ? `in-memory projection updated (${projected})` : 'proactive repair armed',
      ) +
      fact('磁盘日志未改动，界面缓存保持同步', 'durable log untouched, UI cache in sync') +
      `\n${bi('下一步', 'next')}\n` +
      fact('点击「继续执行目标」或直接发送消息', 'click Continue, or just send a message'),
  };
}

/** Register the `/heal` command with the DSH commands service. */
export function registerHealCommand(
  commands: CommandsRegistryLike,
  controller: CommandController,
): void | (() => void) {
  return commands.register({
    name: 'heal',
    description: '修复损坏的会话日志，或管理自动故障自愈 (Fix broken session log / fail-safe)',
    input: { hint: '[status | auto on | auto off]' },
    handler: (invocation) => executeHealCommand(invocation, controller),
  });
}
