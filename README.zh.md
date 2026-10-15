# Heal (`dsh-healer`)

[![npm](https://img.shields.io/npm/v/dsh-healer.svg)](https://www.npmjs.com/package/dsh-healer)
[![downloads](https://img.shields.io/npm/dm/dsh-healer.svg)](https://www.npmjs.com/package/dsh-healer)
[![CI](https://github.com/viztor/dsh-healer/actions/workflows/ci.yml/badge.svg)](https://github.com/viztor/dsh-healer/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/%E8%AE%B8%E5%8F%AF%E8%AF%81-MIT-blue.svg)](LICENSE)

DeepSeek Harness (DSH) 零拷贝、非侵入式 Cordis 宿主自愈插件。

自动修复发往大模型的请求历史中畸变的空名称工具调用（`name: ""`）及未配对的
孤立工具结果：正常请求原样透传，仅在模型服务商真正拒绝请求后才介入恢复。

---

## 解决的问题

在 `@deepseek-ai/dsh-llm` 的模型流式传输过程中，若工具调用被意外中断或生成不完整，可能仅产生一个空的 `block-start`。DSH 的 `BlockAssembler`（组装器）会将该碎片误拼装为一个畸变的工具调用块：

```json
{
  "type": "tool-call",
  "id": "call-3",
  "name": "",
  "arguments": ""
}
```

这会导致两个连环问题：

1. **会话历史永久毒化**：该异常块被直接写入追加式持久化会话日志（`session.v4.jsonl.zstd`）。由于会话历史不可篡改，之后的每一次用户对话与请求都会带上这个损坏的工具块。
2. **模型提供商 400 报错拦截**：主流模型服务商（如 Gemini、Anthropic Messages、OpenAI 接口）在收到包含空名称工具调用的上下文时，会在推理前直接拒绝请求（`inputTokens: 0, outputTokens: 0`）：
   ```text
   400 INVALID_ARGUMENT: Request contains an invalid argument.
   Field required: messages.N.content.M.tool_use.name
   ```
   此时用户即使多次点击「继续执行目标」或输入 `continue`，请求依然会因历史坏块被拒绝，导致长会话永久卡死。

---

## 核心设计与架构

Heal 采用**非侵入式故障自愈（Fail-Safe）**多层防御体系，在保证正常对话 0 干扰的前提下实现全自动恢复。

```
  模型请求
     │
     ├─ 200 OK ──────────► 响应流按原对象返回给智能体主循环
     │                     （不包装、不缓冲、不重放）
     │
     └─ 400 被拒绝
           │
           └─ dsh-agent-loop 派发 "agent/request-error"
                 │
                 └─ dsh-healer
                       ├─ 判断是否为可恢复的无效请求错误
                       ├─ 修复会话中模型可见的消息
                       ├─ 将每条变更投影进
                       │    session.surfaceManager._state.projectedMessages
                       └─ 返回 { kind: "retry" }
                             │
                             └─ 主循环重新推导请求并重试
```

### 1. 正常请求 0 介入 (`mode: "fail-safe"`)

在默认的 `fail-safe` 模式下，Heal 对正常请求**不做任何主动拦截或预处理**。所有请求原样直发模型提供商，不增加任何额外 await、缓冲区或首字延迟（TTFT），也不破坏 KV Cache 命中。

### 2. 原生 DSH 故障后自动修复钩子

当且仅当模型提供商因历史坏块返回 400 拒绝时：

1. `dsh-agent-loop` 触发 `agent/request-error` 事件瀑布流。
2. Heal 捕获该错误，扫描当前会话历史中的异常调用（`name: ""`）与孤立工具结果。
3. Heal 利用 DSH 原生机制在内存中对会话表层完成清洁投影（`session.surfaceManager._state.projectedMessages`）。
4. Heal 返回 `{ kind: 'retry' }`，智能体主循环捕获后立即以清洗后的整洁消息重新发起请求。
5. **不修改磁盘日志**：避免直接改写 `.zstd` 造成的序列号错位或 Web 界面会话丢失问题，缓存与界面 100% 保持同步。

### 3. 原生 `/heal` 快捷斜杠指令

在输入框输入 `/heal` 即可直接审计与管理当前会话：

| 指令                 | 作用                             | 说明 / 效果                                                                      |
| -------------------- | -------------------------------- | -------------------------------------------------------------------------------- |
| **`/heal`**          | 审计当前会话并立即应用内存修复。 | 给出中英双语的诊断报告，列出扫描消息数、坏块数量，并立即在内存表层完成清洁投影。 |
| **`/heal auto on`**  | 开启自动故障自愈。               | 发生 400 错误时自动拦截坏块、自动修复并无缝重试。                                |
| **`/heal auto off`** | 关闭自动故障自愈。               | 后台保持 0 介入，仅支持手动执行 `/heal` 修复。                                   |
| **`/heal status`**   | 查看当前配置与规则。             | 显示当前运行模式（`fail-safe` 或 `off`）与生效的修复规则。                       |
| **`/heal help`**     | 查看帮助说明。                   | 列出所有可用指令。                                                               |

### 4. 完整的 Web UI 交互卡片

内置客户端模块（`lib/client.js`），在 DSH 的「插件管理」页面中直接呈现原生设置卡片：

- **运行模式**：分段控制器（`自动自愈 (Fail-Safe)`、`主动拦截 (Heal)`、`仅检测记录 (Check)`、`完全关闭 (Off)`）。
- **自愈规则**：空工具名清理开关、孤立结果清理开关。
- 完全采用 DSH 原生 UI 组件（`SettingsForm`, `SegmentedControl`, `Switch`, `DisclosureRow`）开发。

---

## 自愈规则清单

| 规则标识 (ID)             | 阶段             | 默认状态      | 行为说明                                               |
| ------------------------- | ---------------- | ------------- | ------------------------------------------------------ |
| `tool-call-name`          | 内容级 (Content) | **开启 (On)** | 剔除 `name` 为空、仅含空格或缺失的异常工具调用块。     |
| `orphan-tool-result`      | 消息级 (Message) | **开启 (On)** | 剔除对应的工具调用已被移除的孤立 `role: "tool"` 结果。 |
| `tool-call-arguments`     | 内容级 (Content) | 关闭 (Off)    | 将非标准 JSON 对象的工具调用参数标准化为 `{}`。        |
| `empty-assistant-message` | 消息级 (Message) | 关闭 (Off)    | 剔除内容块被完全清空后的空 assistant 消息。            |

内容规则先于消息规则执行。这种顺序确保 `orphan-tool-result` 能够准确识别哪些工具调用已被 `tool-call-name` 移除，避免级联破坏。

---

## 配置示例

在 `cordis.patch.yml` 或 Web UI 中配置：

```yaml
- id: dsh-healer
  name: dsh-healer
  config:
    mode: fail-safe # fail-safe (默认推荐) | heal | check | off
    onFindings: log # silent | log | throw
    strictRuleIds: true # 启动时严格校验规则名称
    rules:
      tool-call-name:
        enabled: true
      orphan-tool-result:
        enabled: true
      tool-call-arguments:
        enabled: false
      empty-assistant-message:
        enabled: false
```

- **`fail-safe`（推荐）**：平时 0 干扰，仅在遇到 400 报错时自动介入修复并重试。
- **`heal`**：每次请求发送前主动扫描并剔除畸变块。
- **`check`**：仅在控制台与日志中记录发现的坏块，不修改请求内容。
- **`off`**：完全停用。

---

## 安装方式

### 添加至 DSH Profile

编辑你的 Profile `package.json`（如 `~/.dsh/profiles/web/package.json`）：

```json
{
  "dependencies": {
    "dsh-healer": "link:/path/to/dsh-healer"
  },
  "dsh": {
    "profile": {
      "bundles": ["dsh-healer"]
    }
  }
}
```

或在 `cordis.patch.yml` 中引入：

```yaml
- insert:
    - id: dsh-healer
      name: dsh-healer
      config:
        mode: fail-safe
```

---

## 开发与质量验证

Heal 无任何外部运行时依赖，Node ≥24 原生直接执行 TypeScript 源码，测试与开发脚本
都不需要构建。只有对外入口需要打包，因为 harness 通过 `package.json` 加载它。

整个工具链统一由 [Vite+](https://viteplus.dev) 提供：

```sh
vp check                     # 格式化 + 检查
vp fmt                       # 仅格式化
vp lint                      # 仅检查
vp test                      # 测试套件 (Vitest)
vp test --coverage           # 覆盖率
vp test <pattern>            # 指定文件或名称

vp run ci                    # 质量门禁：全部类型检查 + 测试用例 + 上游验证
vp run test:mutation         # 突变测试门禁 (46/46 个变异体必须全部捕获)
vp run test:upstream         # 在沙箱中验证针对上游 BlockAssembler 的根因修复
vp run typecheck:src         # 源码严格类型检查
vp run typecheck             # 严格类型检查：src/ + test/
vp run typecheck:scripts     # 严格类型检查：scripts/、upstream/、vite.config.ts
vp run build                 # 用 `vp pack` 打包 lib/index.js 并校验两个产物
vp run audit:session <f>     # 离线端到端审计真实的 session.v4.jsonl.zstd 日志
```

测试从 `vite-plus/test` 导入 Vitest，因此类型来自工具链本身，而不是另一份独立
版本的 Vitest。Git 钩子会对暂存文件执行格式化与检查。

### 质量门禁指标

- **测试通过率**：完整测试套件由 CI 在每次推送时执行。
- **突变测试覆盖**：**100%（46/46 个变异体全部被测试击杀）**，覆盖所有规则、核心调度与切面缝隙。
- **类型检查覆盖**：`src/`、`test/`、`scripts/`、`upstream/` 均以严格模式检查。
- **绝对路径安全**：内置路径安全扫描器，确保代码与测试中不泄漏任何本地开发者机器绝对路径。
- **上游修复经过沙箱验证**：针对 `BlockAssembler.assemble` 的根因修复通过独立沙箱验证。

测试用例总数刻意不在文档中写死：它随每次新增用例而变化，而没有任何校验的数字
会静默过期。突变体数量则写死，因为 `test/spec-conformance.test.ts` 会从门禁中
读回该数字，文档不一致时会直接失败。

---

## 上游根因修复说明

Heal 修复的是已经损坏的会话。最根本的修复应当提交至上游 `@deepseek-ai/dsh-llm`：

- [`upstream/REPORT.md`](upstream/REPORT.md) —— 根因分析。
- [`upstream/assembler-fix.ts`](upstream/assembler-fix.ts) —— 精确补丁，由
  `pnpm run test:upstream` 直接消费，确保补丁不会与验证过的内容发生偏移。

该补丁让 `BlockAssembler.assemble()` 强制执行流记录器早已执行的约束——
工具调用必须携带非空名称——而不是凭空拼装一个无名称的调用块。让该步骤明确
失败，远好于写入一个会比它活得更久的坏块。

---

## 开源协议

MIT © 2026 Leo（[viztor](https://github.com/viztor)）—— 详见 [LICENSE](LICENSE)。
