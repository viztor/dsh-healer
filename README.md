<div align="center">
  <p><b>English</b> &nbsp;·&nbsp; <a href="./README.zh.md">简体中文</a></p>

  <img src="icon.svg" alt="Heal on DeepSeek Harness" width="112" />
  <h1>dsh-healer</h1>
  <p><b>A zero-copy, non-intrusive Cordis host plugin for DeepSeek Harness.</b><br />Repairs malformed tool-call blocks and orphaned tool results in flight.</p>

  <p>
    <a href="https://www.npmjs.com/package/dsh-healer"><img src="https://img.shields.io/npm/v/dsh-healer.svg" alt="npm version" /></a>
    <a href="https://www.npmjs.com/package/dsh-healer"><img src="https://img.shields.io/npm/dm/dsh-healer.svg" alt="npm downloads" /></a>
    <a href="https://github.com/viztor/dsh-healer/actions/workflows/ci.yml"><img src="https://github.com/viztor/dsh-healer/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
    <a href="https://github.com/viztor/dsh-healer/actions/workflows/release.yml"><img src="https://github.com/viztor/dsh-healer/actions/workflows/release.yml/badge.svg" alt="Release" /></a>
    <a href="https://github.com/viztor/dsh-healer/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/dsh-healer.svg" alt="license" /></a>
    <a href="https://nodejs.org"><img src="https://img.shields.io/node/v/dsh-healer.svg" alt="node" /></a>
  </p>
</div>

---

It repairs malformed outbound tool-call blocks (`name: ""`) and orphaned tool
results, without rewriting durable session logs and without touching healthy
conversations. Normal requests pass through untouched; recovery runs only after a
provider actually rejects one.

## The Problem

While streaming from `@deepseek-ai/dsh-llm`, an interrupted or incomplete tool
call can arrive as a bare `block-start` carrying no name. The harness's
`BlockAssembler` then fabricates a placeholder block rather than rejecting the
incomplete call:

```json
{
  "type": "tool-call",
  "id": "call-3",
  "name": "",
  "arguments": ""
}
```

Two things follow, and the second is what makes the failure permanent:

1. **The block is appended to the durable session log.** History in DSH is
   append-only, so every later request re-sends it.
2. **Strict providers reject the whole request before inference**
   (`inputTokens: 0, outputTokens: 0`):

   ```text
   400 INVALID_ARGUMENT: Request contains an invalid argument.
   Field required: messages.N.content.M.tool_use.name
   ```

   Retrying cannot help, because the poison is in the history the retry replays.
   In a long session, every attempt fails until the block is removed.

---

## How Heal Solves It

Two independent paths, one proactive and one reactive. Normal traffic uses
neither.

```
  request
     │
     ├─ 200 OK ──────────► stream returned to the agent loop by identity
     │                     (never wrapped, buffered or re-emitted)
     │
     └─ 400 rejected
           │
           └─ dsh-agent-loop dispatches "agent/request-error"
                 │
                 └─ dsh-healer
                       ├─ is the failure a recoverable invalid-request rejection?
                       ├─ heal the session's model-visible messages
                       ├─ project each change into
                       │    session.surfaceManager._state.projectedMessages
                       └─ return { kind: "retry" }
                             │
                             └─ the loop re-derives the request and retries
```

### 1. Healthy traffic is untouched (`mode: "fail-safe"`, the default)

No proactive transformation runs on a healthy request. The outbound options
object is forwarded to the provider as-is, and the provider's stream is returned
by identity — not wrapped, buffered or re-emitted. First-token latency and KV
cache alignment are unchanged by construction, and there is a test that asserts
the returned value _is_ the provider's stream.

### 2. A rejected request is repaired, then retried

When a provider rejects a request, `dsh-agent-loop` dispatches the
`agent/request-error` waterfall and retries the step if a listener returns
`{ kind: 'retry' }`. Heal's listener:

1. Checks the failure is a recoverable invalid-request rejection.
2. Heals the session's model-visible messages.
3. Projects each changed message into
   `session.surfaceManager._state.projectedMessages` — the store the harness
   folds into `deriveMessages()`.
4. Returns `{ kind: 'retry' }`.

The repair is therefore **durable for the session**, not just for one request:
every later request, including auxiliary calls such as compaction and session
titling, sees clean history. The append-only `.zstd` log is never rewritten, so
sequence numbers and the GUI projection cache stay consistent.

### 3. `/heal` for inspection and manual repair

| Command              | Effect                                                              |
| -------------------- | ------------------------------------------------------------------- |
| **`/heal`**          | Audits the session, and repairs it in place when defects are found. |
| **`/heal auto on`**  | Enables reactive recovery (the `fail-safe` mode).                   |
| **`/heal auto off`** | Disables it; manual repair only, zero background intervention.      |
| **`/heal status`**   | Shows the active mode and rule set.                                 |
| **`/heal help`**     | Lists the commands.                                                 |

Output is bilingual, one line per fact. That is a response to a platform limit
rather than a preference: `CommandInvocation` carries no locale, and the locale
plugin's `preference` lives in a settings namespace that is unset unless the user
picks a language explicitly — so a host command handler cannot know which
language to answer in.

### 4. A settings card in the DSH Web UI

A client module (`lib/client.js`) contributes to the Plugins settings page:

- **Operating mode** — a segmented control: `Fail-Safe (Auto-Retry)`,
  `Proactive (Heal)`, `Audit Only (Check)`, `Off`.
- **Repair rules** — switches for empty-name and orphaned-result cleanup.

It is built from DSH's own UI primitives (`SettingsForm`, `SegmentedControl`,
`Switch`, `DisclosureRow`) and ships English and Simplified Chinese dictionaries.

---

## Repair Rules

| Rule ID                   | Phase   | Default     | Behavior                                                                |
| ------------------------- | ------- | ----------- | ----------------------------------------------------------------------- |
| `tool-call-name`          | Content | **Enabled** | Drops any tool call whose `name` is missing, empty, or whitespace-only. |
| `orphan-tool-result`      | Message | **Enabled** | Drops any `role: "tool"` result whose matching tool call was removed.   |
| `tool-call-arguments`     | Content | Disabled    | Normalizes arguments that are not a valid JSON object into `{}`.        |
| `empty-assistant-message` | Message | Disabled    | Drops assistant messages that have no remaining content blocks.         |

Content rules execute first; message rules execute second. This ordering allows `orphan-tool-result` to see which calls were dropped by `tool-call-name`.

---

## Configuration

In `cordis.patch.yml` or the Web UI:

```yaml
- id: dsh-healer
  name: dsh-healer
  config:
    mode: fail-safe # fail-safe (default) | heal | check | off
    onFindings: log # silent | log | throw
    strictRuleIds: true # validate rule IDs on startup
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

- **`fail-safe` (Recommended)**: Non-intrusive. Intercepts provider 400 rejections, repairs history in memory, and retries.
- **`heal`**: Proactive. Sanitizes message history before every outbound request.
- **`check`**: Audit only. Logs detected defects without modifying requests.
- **`off`**: Completely disabled.

---

## Installation

### Add to DSH Profile

In your profile's `package.json` (e.g. `~/.dsh/profiles/web/package.json`):

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

Or configure via `cordis.patch.yml`:

```yaml
- insert:
    - id: dsh-healer
      name: dsh-healer
      config:
        mode: fail-safe
```

---

## Development & Verification

Heal has no runtime dependencies, and Node ≥24 runs the TypeScript sources
directly — the suite and the developer scripts need no build. Only the published
entry point is bundled, because the harness loads it through `package.json`.

The whole toolchain is [Vite+](https://viteplus.dev):

```sh
vp check                     # Format + lint
vp fmt                       # Format only
vp lint                      # Lint only
vp test                      # The suite (Vitest)
vp test --coverage           # Coverage
vp test <pattern>            # One file or a name pattern

vp run ci                    # All typechecks + suite + upstream spec
vp run test:mutation         # Mutation gate (46/46 mutants must be caught)
vp run test:upstream         # Verify the upstream BlockAssembler fix in a sandbox
vp run typecheck:src         # Strict typecheck: src/
vp run typecheck             # Strict typecheck: src/ + test/
vp run typecheck:scripts     # Strict typecheck: scripts/, upstream/, vite.config.ts
vp run build                 # Bundle lib/index.js with `vp pack`, verify both artifacts
vp run audit:session <f>     # Offline audit of a real session.v4.jsonl.zstd log
```

The suite imports Vitest from `vite-plus/test`, so its types come from the
toolchain rather than a second, separately-versioned copy of Vitest. A Git hook
formats and lints staged files; see [Commit conventions](#commit-conventions).

### Releasing

Releases are cut by [release-please](https://github.com/googleapis/release-please).
It reads the Conventional Commit subjects on `main` (`feat:`, `fix:`, …) and keeps
a version-bump pull request open with the next version and the changelog. Merging
that pull request creates the tag and the GitHub Release, which fires
[`.github/workflows/release.yml`](.github/workflows/release.yml) — the workflow
checks the tag against `package.json`, runs the full gate and the mutation gate,
and publishes through npm
[trusted publishing](https://docs.npmjs.com/trusted-publishers): OIDC, so there
is no `NPM_TOKEN` secret to leak or rotate.

Two settings live outside this repository, and each is configured once:

1. **`RELEASE_PLEASE_TOKEN`** — a fine-grained PAT with Contents and Pull requests
   read/write on this repository only, set under _Settings → Secrets and
   variables → Actions_. Tags created with the built-in `GITHUB_TOKEN` do not
   trigger downstream workflows, so without the PAT a release looks cut and never
   publishes. Until the secret exists, the `release-please` job skips with a
   warning naming it rather than failing every push.

2. **The trusted publisher** —
   [npmjs.com](https://www.npmjs.com/package/dsh-healer/access) → Trusted
   Publisher → GitHub Actions:

   | Field                | Value                  |
   | -------------------- | ---------------------- |
   | Organization or user | `viztor`               |
   | Repository           | `dsh-healer`           |
   | Workflow filename    | `release.yml`          |
   | Allowed actions      | **tick `npm publish`** |

   The last row is easy to miss: trusted publishers created after 2026-09-03
   default to `npm stage publish` only, which stages each release for manual
   approval instead of publishing it.

A local `npm publish --otp=…` remains the break-glass path — it is how the first
release (0.1.0) went out, before this pipeline existed. Provenance is generated
automatically: the repository is public, and the publish runs through OIDC from a
public workflow.

### Commit conventions

Commits follow [Conventional Commits](https://www.conventionalcommits.org),
enforced by commitlint from a `commit-msg` hook. The types are the standard set;
release-please derives the next version from the `feat` and `fix` subjects (see
[Releasing](#releasing)).

Hooks are installed by Vite+:

```sh
vp hooks enable               # install the dispatcher
vp hooks status               # show what is active
VP_GIT_HOOKS=0 git commit …   # skip hooks for one command
```

The `pre-commit` hook formats and lints **only the staged files**. The full gate
runs in CI, where it cannot be skipped — a pre-commit hook that takes two minutes
is one everybody learns to bypass with `--no-verify`, which is worse than a fast
hook that always runs.

### Quality Metrics

- **Unit & Integration Tests**: the full suite, run on every push by CI.
- **Mutation Coverage**: **100% (46/46 mutants caught)** across all rules, engine phases, and patch seams.
- **Typecheck Coverage**: `src/`, `test/`, `scripts/` and `upstream/` are each checked strictly.
- **Machine Path Leak Guard**: automated scan confirms zero developer machine paths in code or tests.
- **Upstream Verified**: the root-cause fix for `BlockAssembler.assemble` is tested in an isolated sandbox.

The suite size is deliberately not quoted here: it changes with every test, and a
number in prose that nothing verifies goes stale silently. The mutant count _is_
quoted, because `test/spec-conformance.test.ts` reads it back from the gate and
fails if the documents disagree.

---

## Upstream Bug Report

Heal repairs sessions that are already damaged. The durable fix belongs upstream
in `@deepseek-ai/dsh-llm`:

- [`upstream/REPORT.md`](upstream/REPORT.md) — the root-cause analysis.
- [`upstream/assembler-fix.ts`](upstream/assembler-fix.ts) — the exact patch,
  consumed by `pnpm run test:upstream` so it cannot drift from what was tested.

The patch makes `BlockAssembler.assemble()` enforce the invariant the stream
recorder already enforces — a tool call must carry a non-empty name — instead of
inventing a name-less call. Failing the step loudly is strictly better than
writing a block that outlives it.

---

## License

MIT © 2026 Leo ([viztor](https://github.com/viztor)) — see [LICENSE](LICENSE).
