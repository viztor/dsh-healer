(function () {
  var factory = function (require) {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const primitives = require('@deepseek-ai/dsh-client-ui-primitives');
    const react = require('react');
    const h = react.createElement;

    const NS = 'dsh-healer';
    const EN = 'en';

    const inject = ['slots', 'locale', 'configForms'];

    const STRINGS = {
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

    const FIELDS = {
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

    const GROUPS = [
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

    function booleanField(field) {
      return {
        field: field,
        format: function (value) {
          return typeof value === 'boolean' ? String(value) : '';
        },
        parse: function (text) {
          const t = String(text).trim().toLowerCase();
          if (t === 'true') return { kind: 'set', value: true };
          if (t === 'false') return { kind: 'set', value: false };
        },
      };
    }

    function enumField(field, choices) {
      return {
        field: field,
        format: function (value) {
          return typeof value === 'string' ? value : '';
        },
        parse: function (text) {
          const t = String(text).trim();
          return choices.indexOf(t) !== -1 ? { kind: 'set', value: t } : undefined;
        },
      };
    }

    function buildSpecs() {
      return Object.keys(FIELDS).map(function (name) {
        const meta = FIELDS[name];
        if (meta.kind === 'boolean') return booleanField(name);
        if (meta.kind === 'enum') return enumField(name, meta.choices || []);
        return primitives.settingsTextField(name);
      });
    }

    function translator(props) {
      const t = props.t;
      return function (key) {
        if (typeof t !== 'function') return key;
        const value = t(key);
        return typeof value === 'string' && value.length > 0 ? value : key;
      };
    }

    function fieldShell(meta, state, controlNode, props, shell, t) {
      const hint = t(meta.hintKey);
      const hasMessage = state.invalid || hint !== '';
      return h(
        'div',
        {
          key: meta.labelKey,
          style: {
            display: 'flex',
            flexDirection: 'column',
            gap: '6px',
            padding: '12px 0',
          },
        },
        h(
          'div',
          { style: { alignItems: 'center', display: 'flex', gap: '8px' } },
          h(
            'div',
            {
              style: { alignItems: 'center', display: 'flex', flex: '1', gap: '4px', minWidth: 0 },
            },
            h(
              'label',
              {
                htmlFor: 'dsh-healer-' + meta.labelKey,
                style: {
                  color: 'var(--dsw-alias-label-primary)',
                  flex: '0 1 auto',
                  fontSize: '13px',
                  fontWeight: 500,
                  lineHeight: 1.5,
                },
              },
              t(meta.labelKey),
            ),
            state.overridden
              ? h(
                  'span',
                  { style: { alignItems: 'center', display: 'inline-flex', gap: '8px' } },
                  h(primitives.Tag, { tone: 'neutral' }, t('overridden')),
                  h(
                    primitives.Button,
                    {
                      disabled: shell.writable !== true,
                      onClick: function () {
                        props.resetField(meta.labelKey);
                      },
                      size: 'sm',
                      variant: 'ghost',
                    },
                    t('reset'),
                  ),
                )
              : null,
          ),
          controlNode,
        ),
        hasMessage
          ? h(
              'p',
              {
                style: {
                  color: state.invalid
                    ? 'var(--dsw-alias-state-error-primary)'
                    : 'var(--dsw-alias-label-tertiary)',
                  fontSize: '12px',
                  lineHeight: 1.5,
                  margin: 0,
                },
              },
              state.invalid ? t('invalid') : hint,
            )
          : null,
      );
    }

    function valueKey(value) {
      if (value === 'fail-safe') return 'valueFailSafe';
      return 'value' + value.charAt(0).toUpperCase() + value.slice(1);
    }

    function control(name, state, props, shell, t) {
      const meta = FIELDS[name];
      const id = 'dsh-healer-' + meta.labelKey;
      const disabled = shell.writable !== true;
      if (meta.kind === 'boolean') {
        return fieldShell(
          meta,
          state,
          h(primitives.Switch, {
            checked: state.text === 'true',
            disabled: disabled,
            label: t(meta.labelKey),
            onChange: function (next) {
              props.edit(name, String(next));
            },
          }),
          props,
          shell,
          t,
        );
      }
      if (meta.kind === 'enum') {
        const choices = meta.choices || [];
        return fieldShell(
          meta,
          state,
          h(primitives.SegmentedControl, {
            id: id,
            value: state.text,
            disabled: disabled,
            label: t(meta.labelKey),
            options: choices.map(function (value) {
              return {
                value: value,
                label: t(valueKey(value)),
              };
            }),
            onChange: function (next) {
              props.edit(name, next);
            },
          }),
          props,
          shell,
          t,
        );
      }
      throw new Error('dsh-healer: no control for field kind ' + String(meta.kind));
    }

    function Group(props) {
      try {
        return renderGroup(props);
      } catch (error) {
        return h(
          'p',
          { role: 'alert' },
          'dsh-healer: the ' +
            props.group.id +
            ' group failed to render. ' +
            (error instanceof Error ? error.message : String(error)),
        );
      }
    }

    function renderGroup(props) {
      const pair = react.useState(true);
      const open = pair[0];
      const setOpen = pair[1];
      const t = props.t;
      return h(
        primitives.DisclosureRow,
        {
          icon: null,
          title: t(props.group.titleKey),
          open: open,
          expandable: true,
          onToggle: function () {
            setOpen(!open);
          },
          expandOnRowClick: true,
        },
        props.group.fields.map(function (name) {
          return control(name, props.fields[name], props.props, props.shell, t);
        }),
      );
    }

    function Panel(props) {
      try {
        return render(props);
      } catch (error) {
        return h(
          'p',
          { role: 'alert' },
          'dsh-healer: settings panel failed to render: ' +
            (error instanceof Error ? error.message : String(error)),
        );
      }
    }

    function render(props) {
      const absent = [
        'SettingsForm',
        'SettingsFormModel',
        'settingsTextField',
        'DisclosureRow',
        'Switch',
        'SegmentedControl',
        'Tag',
        'Button',
      ].filter(function (name) {
        return primitives[name] === undefined;
      });
      if (absent.length > 0) {
        return h(
          'p',
          { role: 'alert' },
          'dsh-healer: client primitives missing: ' + absent.join(', '),
        );
      }

      const t = translator(props);
      const state = react.useSyncExternalStore(
        props.store.subscribe,
        props.store.getSnapshot,
        props.store.getSnapshot,
      );
      const shell = state.shell;
      const blocks = GROUPS.map(function (group) {
        return h(Group, {
          key: group.id,
          group: group,
          fields: state.fields,
          props: props,
          shell: shell,
          t: t,
        });
      });

      return h(
        primitives.SettingsForm,
        {
          labels: {
            save: t('save'),
            saving: t('saving'),
            saveFailed: t('saveFailed'),
            unavailable: t('unavailable'),
            readOnly: t('readOnly'),
          },
          state: shell,
          onSave: props.save,
          onDiscard: props.discard,
        },
        blocks,
      );
    }

    function apply(ctx) {
      ctx.effect(function () {
        try {
          return ctx.locale.register(NS, {
            en: STRINGS[EN],
            zh: STRINGS.zh,
          });
        } catch (error) {
          console.error('[dsh-healer] locale registration failed:', error);
          return;
        }
      }, 'dsh-healer: dictionaries');

      const scope = ctx.configForms.get(NS);
      if (scope === undefined) return;
      const specs = buildSpecs();
      const model = new primitives.SettingsFormModel(scope, specs, []);
      const store = model.bind(function () {
        return {
          fields: Object.fromEntries(
            specs.map(function (spec) {
              return [spec.field, model.field(spec.field)];
            }),
          ),
          shell: model.shell(),
        };
      });

      ctx.effect(function () {
        return function () {
          model.dispose();
        };
      }, 'dsh-healer: form');

      ctx.effect(function () {
        const stop = ctx.configForms.whileServed([NS], function () {
          const dispose = ctx.slots.inject('plugins.bundle.config', function () {
            return ctx.slots.register(
              {
                name: 'plugins.bundle.config',
                key: NS,
                locale: NS,
                inject: function () {
                  return {
                    store: store,
                    ...model.actions(),
                  };
                },
              },
              Panel,
            );
          });
          return function () {
            if (typeof dispose === 'function') dispose();
          };
        });
        return function () {
          if (typeof stop === 'function') stop();
        };
      }, 'dsh-healer: panel');
    }

    exports.apply = apply;
    exports.inject = inject;
    exports.Panel = Panel;
    exports.STRINGS = STRINGS;
    exports.FIELDS = FIELDS;
    exports.GROUPS = GROUPS;

    return module.exports;
  };

  if (typeof window !== 'undefined' && window.__ModuleLoader__) {
    window.__ModuleLoader__.load({ id: 'dsh-healer', factory: factory });
  } else if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory(require);
  }
})();
