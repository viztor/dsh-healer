/**
 * Tests for the `/heal` slash command and session auditing.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'vite-plus/test';

import { auditSessionHistory, executeHealCommand, registerHealCommand } from '../src/command.ts';
import type {
  CommandController,
  CommandInvocationLike,
  CommandsRegistryLike,
} from '../src/command.ts';
import type { HealMode } from '../src/config.ts';

function createMockController(initialMode: HealMode = 'fail-safe'): CommandController & {
  mode: HealMode;
} {
  return {
    mode: initialMode,
    getMode() {
      return this.mode;
    },
    setMode(newMode: HealMode) {
      this.mode = newMode;
    },
    activeRules() {
      return ['tool-call-name', 'orphan-tool-result'];
    },
  };
}

describe('auditSessionHistory', () => {
  it('handles null, undefined, or empty sessions safely', () => {
    assert.deepEqual(auditSessionHistory(undefined), {
      emptyNames: 0,
      orphanedResults: 0,
      totalMessages: 0,
    });
    assert.deepEqual(auditSessionHistory(null), {
      emptyNames: 0,
      orphanedResults: 0,
      totalMessages: 0,
    });
    assert.deepEqual(auditSessionHistory({ seq: 0, eventAt: () => undefined }), {
      emptyNames: 0,
      orphanedResults: 0,
      totalMessages: 0,
    });
  });

  it('scans a clean session history and finds 0 defects', () => {
    const events = [
      { data: { message: { role: 'user', content: [{ type: 'text', text: 'hello' }] } } },
      {
        data: {
          message: {
            role: 'assistant',
            content: [{ type: 'tool-call', id: 'call-1', name: 'bash', arguments: '{}' }],
          },
        },
      },
      {
        data: {
          message: { role: 'tool', toolCallId: 'call-1', content: [{ type: 'text', text: 'ok' }] },
        },
      },
    ];

    const session = {
      seq: events.length,
      eventAt(seq: number) {
        return events[seq];
      },
    };

    const audit = auditSessionHistory(session);
    assert.equal(audit.totalMessages, 3);
    assert.equal(audit.emptyNames, 0);
    assert.equal(audit.orphanedResults, 0);
  });

  it('detects empty tool-call names and orphaned tool results', () => {
    const events = [
      { data: { message: { role: 'user', content: [{ type: 'text', text: 'run' }] } } },
      {
        data: {
          message: {
            role: 'assistant',
            content: [
              { type: 'tool-call', id: 'call-valid', name: 'read', arguments: '{}' },
              { type: 'tool-call', id: 'call-bad', name: '', arguments: '{}' },
            ],
          },
        },
      },
      {
        data: {
          message: {
            role: 'tool',
            toolCallId: 'call-valid',
            content: [{ type: 'text', text: 'content' }],
          },
        },
      },
      {
        data: {
          message: {
            role: 'tool',
            toolCallId: 'call-unmatched',
            content: [{ type: 'text', text: 'error' }],
          },
        },
      },
    ];

    const session = {
      seq: events.length,
      eventAt(seq: number) {
        return events[seq];
      },
    };

    const audit = auditSessionHistory(session);
    assert.equal(audit.totalMessages, 4);
    assert.equal(audit.emptyNames, 1);
    assert.equal(audit.orphanedResults, 1);
  });
});

describe('executeHealCommand', () => {
  it('/heal auto on switches mode to fail-safe', () => {
    const controller = createMockController('off');
    const outcome = executeHealCommand({ rawInput: 'auto on' }, controller);
    assert.equal(outcome.kind, 'success');
    assert.match(outcome.text, /自动自愈已开启/);
    assert.match(outcome.text, /Auto fail-safe ON/);
    assert.equal(controller.getMode(), 'fail-safe');
  });

  it('/heal auto off switches mode to off', () => {
    const controller = createMockController('fail-safe');
    const outcome = executeHealCommand({ rawInput: 'auto off' }, controller);
    assert.equal(outcome.kind, 'success');
    assert.match(outcome.text, /自动自愈已关闭/);
    assert.match(outcome.text, /Auto fail-safe OFF/);
    assert.equal(controller.getMode(), 'off');
  });

  it('/heal status reports active mode and rules', () => {
    const controller = createMockController('fail-safe');
    const outcome = executeHealCommand({ rawInput: 'status' }, controller);
    assert.equal(outcome.kind, 'success');
    assert.match(outcome.text, /Heal 状态/);
    assert.match(outcome.text, /运行模式 mode = fail-safe/);
    assert.match(outcome.text, /rules = tool-call-name, orphan-tool-result/);
  });

  it('/heal help lists the commands, and only the commands', () => {
    const controller = createMockController('fail-safe');
    const outcome = executeHealCommand({ rawInput: 'help' }, controller);
    assert.equal(outcome.kind, 'success');
    assert.match(outcome.text, /Heal 指令/);
    assert.match(outcome.text, /Heal commands/);
    for (const command of ['/heal`', '/heal auto on', '/heal auto off', '/heal status']) {
      assert.ok(outcome.text.includes(command), `help must list ${command}`);
    }
  });

  it('states each fact once, bilingually, instead of restating sentences', () => {
    // The first version printed every sentence twice, once per language, which
    // doubled the output for no extra information. Each line must now carry both
    // languages, and no line may repeat another.
    const outcome = executeHealCommand({ rawInput: 'status' }, createMockController('fail-safe'));
    const lines = outcome.text.split('\n').filter((line) => line.trim() !== '');
    const seen = new Set<string>();
    for (const line of lines) {
      assert.ok(!seen.has(line), `duplicate line: ${line}`);
      seen.add(line);
    }
  });

  it('/heal with clean session reports healthy', () => {
    const controller = createMockController('fail-safe');
    const invocation: CommandInvocationLike = {
      rawInput: '',
      agent: {
        session: {
          seq: 1,
          eventAt: () => ({
            data: { message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } },
          }),
        },
      },
    };
    const outcome = executeHealCommand(invocation, controller);
    assert.equal(outcome.kind, 'success');
    assert.match(outcome.text, /会话历史健康/);
    assert.match(outcome.text, /Session history healthy/);
    assert.match(outcome.text, /empty tool names = 0/);
    assert.match(outcome.text, /orphaned results = 0/);
  });

  it('/heal with defects reports defect counts and advice', () => {
    const controller = createMockController('fail-safe');
    const events = [
      {
        data: {
          message: {
            role: 'assistant',
            content: [{ type: 'tool-call', id: 'call-1', name: '', arguments: '{}' }],
          },
        },
      },
    ];
    const invocation: CommandInvocationLike = {
      rawInput: '',
      agent: {
        session: {
          seq: 1,
          eventAt: (i) => events[i],
        },
      },
    };
    const outcome = executeHealCommand(invocation, controller);
    assert.equal(outcome.kind, 'success');
    assert.match(outcome.text, /会话日志已修复/);
    assert.match(outcome.text, /Session log repaired/);
    assert.match(outcome.text, /empty tool names = 1 \(name: ""\)/);
    assert.equal(controller.getMode(), 'heal');
  });

  it('immediately applies in-memory projection repair to a live session', () => {
    const controller = createMockController('fail-safe');
    const dirtyMessages = [
      {
        role: 'assistant' as const,
        content: [
          { type: 'text', text: 'analyzing...' },
          { type: 'tool-call', id: 'call-err', name: '', arguments: '{}' },
        ],
      },
    ];

    const projected = new Map<number, unknown>();
    const session = {
      surface: { nodes: [100] },
      surfaceManager: {
        _state: {
          projectedMessages: projected,
          contentGeneration: 1,
        },
      },
      deriveMessages: () => dirtyMessages,
    };

    const invocation: CommandInvocationLike = {
      rawInput: '',
      agent: { session },
    };

    const outcome = executeHealCommand(invocation, controller);
    assert.equal(outcome.kind, 'success');
    assert.match(outcome.text, /in-memory projection updated \(1\)/);
    assert.equal(projected.has(100), true);
    assert.equal(session.surfaceManager._state.contentGeneration, 2);
  });
});

describe('registerHealCommand', () => {
  it('registers the heal definition on the registry', () => {
    let registeredName = '';
    let registeredDesc = '';
    let registeredHint = '';

    const registry: CommandsRegistryLike = {
      register(def) {
        registeredName = def.name;
        registeredDesc = def.description;
        registeredHint = def.input?.hint ?? '';
      },
    };

    const controller = createMockController();
    registerHealCommand(registry, controller);

    assert.equal(registeredName, 'heal');
    assert.match(registeredDesc, /修复损坏的会话日志/);
    assert.ok(registeredHint.includes('auto on'));
  });
});
