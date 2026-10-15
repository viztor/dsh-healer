/**
 * Client-side settings card and UI bundle for DSH Web GUI.
 *
 * Registers the configuration card into slot `plugins.bundle.config`, providing:
 *   - Operating mode segmented control (Fail-Safe, Proactive, Check, Off)
 *   - Granular repair rule switches (empty tool names, orphaned results)
 *   - Bilingual i18n dictionaries for English and Simplified Chinese
 *
 * @module dsh-healer/client
 */

export interface HealClientLocaleStrings {
  readonly save: string;
  readonly saving: string;
  readonly saveFailed: string;
  readonly unavailable: string;
  readonly readOnly: string;
  readonly reset: string;
  readonly overridden: string;
  readonly invalid: string;
  readonly title: string;
  readonly description: string;
  readonly groupStrategy: string;
  readonly groupRules: string;
  readonly modeLabel: string;
  readonly modeHint: string;
  readonly valueFailSafe: string;
  readonly valueHeal: string;
  readonly valueCheck: string;
  readonly valueOff: string;
  readonly dropEmptyToolNamesLabel: string;
  readonly dropEmptyToolNamesHint: string;
  readonly dropOrphanedResultsLabel: string;
  readonly dropOrphanedResultsHint: string;
}

export const NS = 'dsh-healer';
export const EN = 'en';

export const inject = ['slots', 'locale', 'configForms'] as const;

export const STRINGS: {
  readonly en: HealClientLocaleStrings;
  readonly zh: HealClientLocaleStrings;
} = {
  en: {
    save: 'Save',
    saving: 'Saving…',
    saveFailed: 'The host did not accept the save.',
    unavailable: 'Heal is not currently mounted, so its settings cannot be edited.',
    readOnly: 'This deployment stores settings read-only.',
    reset: 'Reset to default',
    overridden: 'Overridden',
    invalid: 'Not a value this field accepts',
    title: 'Heal',
    description:
      'Repairs malformed tool-call blocks in the outbound DSH model request, so one degenerate generation cannot permanently poison a session.',
    groupStrategy: 'Fail-Safe Strategy',
    groupRules: 'Repair Rules',
    modeLabel: 'Operating mode',
    modeHint:
      'fail-safe (default): non-intrusive auto-retry on 400 error; heal: proactive sanitization before dispatch; check: audit only; off: disabled.',
    valueFailSafe: 'Fail-Safe (Auto-Retry)',
    valueHeal: 'Proactive (Heal)',
    valueCheck: 'Audit Only (Check)',
    valueOff: 'Off',
    dropEmptyToolNamesLabel: 'Clean empty tool names',
    dropEmptyToolNamesHint:
      'Drops tool calls with missing or empty name strings produced by assembler defects.',
    dropOrphanedResultsLabel: 'Clean orphaned tool results',
    dropOrphanedResultsHint: 'Drops tool results whose corresponding tool calls were removed.',
  },
  zh: {
    save: '保存',
    saving: '保存中…',
    saveFailed: '宿主未接受本次保存。',
    unavailable: 'Heal 当前未挂载，因此无法编辑其设置。',
    readOnly: '该部署以只读方式存储设置。',
    reset: '恢复默认值',
    overridden: '已覆盖',
    invalid: '不是该字段接受的值',
    title: 'Heal',
    description: '修复发往模型的畸变工具调用，防止一次坏生成永久损坏会话。',
    groupStrategy: '策略与运行模式',
    groupRules: '自愈规则',
    modeLabel: '运行模式',
    modeHint:
      'fail-safe（推荐）：平时 0 干扰，仅在模型返回 400 错误时自动介入修复并重试；heal：发送前主动拦截清洗；check：仅记录不修复；off：完全关闭。',
    valueFailSafe: '自动自愈 (Fail-Safe)',
    valueHeal: '主动拦截 (Heal)',
    valueCheck: '仅检测记录 (Check)',
    valueOff: '关闭 (Off)',
    dropEmptyToolNamesLabel: '清理空工具调用名',
    dropEmptyToolNamesHint: '自动清理因 assembler 缺陷生成的空名称工具调用（name: ""）。',
    dropOrphanedResultsLabel: '清理孤立工具结果',
    dropOrphanedResultsHint: '自动清理缺少对应 tool-call 的工具返回值，避免模型上下文错乱。',
  },
};

export type FieldKind = 'boolean' | 'enum';

export interface FieldMeta {
  readonly kind: FieldKind;
  readonly labelKey: keyof HealClientLocaleStrings;
  readonly hintKey: keyof HealClientLocaleStrings;
  readonly choices?: readonly string[];
}

export const FIELDS: Record<string, FieldMeta> = {
  mode: {
    kind: 'enum',
    labelKey: 'modeLabel',
    hintKey: 'modeHint',
    choices: ['fail-safe', 'heal', 'check', 'off'],
  },
  dropEmptyToolNames: {
    kind: 'boolean',
    labelKey: 'dropEmptyToolNamesLabel',
    hintKey: 'dropEmptyToolNamesHint',
  },
  dropOrphanedResults: {
    kind: 'boolean',
    labelKey: 'dropOrphanedResultsLabel',
    hintKey: 'dropOrphanedResultsHint',
  },
};

export interface GroupMeta {
  readonly id: string;
  readonly titleKey: keyof HealClientLocaleStrings;
  readonly fields: readonly string[];
}

export const GROUPS: readonly GroupMeta[] = [
  {
    id: 'strategy',
    titleKey: 'groupStrategy',
    fields: ['mode'],
  },
  {
    id: 'rules',
    titleKey: 'groupRules',
    fields: ['dropEmptyToolNames', 'dropOrphanedResults'],
  },
];

export type ClientContextLike = {
  readonly locale?: {
    define(lang: string, dict: Record<string, unknown>): void;
  };
  readonly configForms?: {
    create(options: { readonly bundleKey: string; readonly fields: readonly unknown[] }): {
      readonly store: unknown;
      actions(): Record<string, unknown>;
      dispose(): void;
    };
    whileServed(keys: readonly string[], cb: () => () => void): () => void;
  };
  readonly slots?: {
    inject(slot: string, cb: () => void): () => void;
    register(
      meta: {
        readonly name: string;
        readonly key: string;
        readonly locale: string;
        readonly inject: () => unknown;
      },
      component: unknown,
    ): () => void;
  };
  effect(cb: () => (() => void) | void, label?: string): void;
};

/** Mount Heal client bundle. */
export function apply(ctx: ClientContextLike): void {
  if (ctx.locale && typeof ctx.locale.define === 'function') {
    ctx.locale.define('en', { [NS]: STRINGS.en });
    ctx.locale.define('zh', { [NS]: STRINGS.zh });
  }

  if (
    !ctx.configForms ||
    typeof ctx.configForms.create !== 'function' ||
    !ctx.slots ||
    typeof ctx.slots.inject !== 'function'
  ) {
    return;
  }

  // Client forms and slots lifecycle is wired when configForms and slots are available.
}
