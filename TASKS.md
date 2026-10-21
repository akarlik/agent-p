# Tasks

Remaining work for Agent P. The authoring core is done; what is left is discovery,
generation, secrets, and shipping. Work top to bottom unless a dependency says
otherwise.

## Done

- [x] `agentp/v1` spec, JSON Schema, parser, resolver (global library + `extends`)
- [x] Static validation: schema, references, graph, conditions, target checks
- [x] OpenCode exporter (`ee01e36`)
- [x] Claude Code exporter (`8224d2c`)
- [x] Codex CLI exporter (`c74c88d`)
- [x] Export preview/diff, backups, manifest, drift detection, `--force`
- [x] Secret detection and never-embed guarantee for exports
- [x] Interactive TUI: overview, agents, pipeline, integrations, context, export (`00ba4e0`)

## 1. MCP catalog and live discovery

The pack can model MCP servers today, but you have to know the URL, transport, and
auth shape by hand.

- [ ] Ship a built-in catalog of common servers (GitHub, Linear, Sentry, Playwright,
      filesystem, Postgres, Slack, …) with transport, default scopes, and auth shape.
- [ ] `agentp integrations list` / `search <query>` to browse the catalog.
- [ ] `agentp integrations add <catalog-id>` writes a validated `Integration` document
      (prompting only for what cannot be defaulted).
- [ ] `agentp integrations discover <name>` connects to a remote (SSE / streamable HTTP)
      or local (stdio) server, performs the MCP handshake, and lists tools/resources.
- [ ] `--write-tools` persists discovered tool names into the integration document;
      discovery results are otherwise shown only.
- [ ] Timeouts, a `--timeout` flag, and actionable diagnostics when a server rejects
      auth or speaks an unsupported protocol version.
- [ ] Never print or persist tokens; reuse `secretRef`/env names and redact on error.
- [ ] TUI: Integrations detail gains a "Discover" action and shows cached tools, with a
      clear stale/unreachable state.
- [ ] Tests: catalog parsing, stdio JSON-RPC stub, HTTP/SSE stub, failure paths.

## 2. Repository scan

`agentp init` writes generic context. A scan should describe the actual repo.

- [ ] `agentp scan [path]` detects languages, framework, package manager, test/lint/build
      commands, CI provider, docs layout, and existing agent configs.
- [ ] Preview a diff for `.agentp/context/project.yaml`; write only with `--yes`.
- [ ] Merge policy: fill empty fields, never overwrite text the user wrote; report what
      was skipped instead of guessing.
- [ ] Optionally suggest agent/pipeline changes as a reviewable report (no auto-apply).
- [ ] TUI: Context section "Scan repo" action with the same preview → write flow.
- [ ] Tests: fixture repos (TypeScript/Node, Python, Go, monorepo) with deterministic
      output; no network.

## 3. Chat team-builder

Design a pack by describing the project, without hand-writing every YAML field.

- [ ] TUI chat panel that turns a project description into a proposed pack (agents,
      handoffs, pipeline, integrations).
- [ ] Provider adapter behind an interface, with a fake adapter for tests; credentials
      come from env or the secret store (task 4).
- [ ] Model output must be `agentp/v1` JSON/YAML: validate, repair once on failure,
      then show a preview — never write without confirmation.
- [ ] "Refine existing pack" mode in addition to greenfield, always as a diff.
- [ ] Cancel/apply/undo, and a clear error when no provider is configured.
- [ ] Tests: prompt → proposal, invalid output repair, refusal on unresolvable refs,
      no network in CI.

## 4. Secrets: storage and resolution

Exports already never embed a secret, and `secretRef` is declarative. Nothing resolves
it yet, and there is no way to store one.

- [ ] `agentp secret set <name>` (hidden prompt), `list` (names only), `remove`.
- [ ] Backends: macOS Keychain, Linux Secret Service (`secret-tool`) with a
      `~/.config/agentp/secrets.json` encrypted fallback (0600; passphrase from TTY or
      `AGENTP_PASSPHRASE`).
- [ ] Resolution order: environment variable → OS keychain → fallback store; document it.
- [ ] Resolve lazily: only discovery/scan/chat need values, exports never do.
- [ ] Redact values in logs, diagnostics, and error messages; test that no code path
      prints a resolved secret.
- [ ] Tests with mocked backends, precedence, missing-secret hints, and fallback file
      permissions.

## 5. TUI authoring

The TUI is read-only for specs; editing still means an external editor.

- [ ] `e` opens the selected document in `$EDITOR` and reloads on save (smallest useful
      step).
- [ ] Form editing for agent fields (description, model, tools, permissions, `maxTurns`)
      and pipeline nodes/edges, validated before save.
- [ ] Create / duplicate / delete agents, pipeline nodes, and integrations.
- [ ] Add a Providers section (name, kind, env var, `secretRef`, used-by agents).
- [ ] Writing to the project pack vs global library is an explicit scope switch; default
      is project.
- [ ] Preview the YAML diff before saving; keep the serializer stable (or use the YAML
      document API to preserve comments).
- [ ] Tests: edit → save → reload, invalid edit blocked, global scope, undo/cancel.

## 6. Packaging and release

- [ ] Publish `agent-p` to npm; add `repository`, `homepage`, `bugs`, and verify the
      `bin` works from a clean global install.
- [ ] Release workflow (GitHub Actions): compiled binaries for macOS arm64/x64 and
      Linux x64, checksums, and release notes.
- [ ] Bake the version at build time instead of the hard-coded `src/core/version.ts`.
- [ ] Smoke test the compiled binary in CI: PTY render, quit with `q`, screen restored,
      exit 0.
- [ ] Verify the published package ships `src`, `schemas/agentp.schema.json`, `README`,
      and `LICENSE`, and that the TUI's native dependency resolves per platform.
- [ ] Document install paths (npm, binary download, `bun link`).

## 7. Managed-file and workflow polish

- [ ] Prune stale managed MCP entries when an integration is deleted or denied for every
      agent — opt-in `agentp export --prune`, never touch unmanaged servers.
- [ ] `agentp export --all-targets` (and `W` in the TUI) to write every configured target
      in one pass with a combined summary.
- [ ] Backup retention: keep the last N runs, `agentp state clean` to prune
      `.agentp/state/backups`.
- [ ] A capability-matrix report (`agentp capabilities`) generated from the same data the
      exporters report, so the README tables cannot drift.
- [ ] Re-check `validate` exit codes and `--strict` behavior for target-only findings.

## 8. Documentation

- [ ] `docs/spec.md`: field reference for every document kind, camelCase names, defaults,
      and inheritance/merge rules.
- [ ] `docs/targets.md`: capability matrix and mapping tables per runtime, including the
      known limits in the README.
- [ ] `CONTRIBUTING.md`: setup, tests, fixture rules, release process.
- [ ] Keep `TASKS.md`, README status, and `agentp --help` in sync when milestones land.

## Later / ideas

- [ ] `agentp import`: reverse-engineer an existing `opencode.json`, `.claude/`, or
      `.codex/` setup into a pack.
- [ ] Promote a project agent to the global library (and vice versa) as a reviewable diff.
- [ ] Windows support: compiled binaries and a credential backend.
- [ ] Pack-level lint rules that can be enabled per project (e.g., require reviewers to
      lack write tools).
