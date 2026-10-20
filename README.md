# Agent P

> Agent P is Perry the Platypus: he shows up, does the job, and leaves no trace.

**Agent P** is a terminal tool for designing, validating, and exporting a team of AI agents and the pipeline they work through. It is an authoring tool, not a runtime: you define the pack once, validate it, and export native configuration for the agent runtime you already use.

```
┌ Agent P ─ my-service ────────────────────────────── v0.1.0 ┐
│ ◆ Overview   Providers   Agents   Pipeline   Integrations   │
│   Context    Export      Builder    Settings                │
└─────────────────────────────────────────────────────────────┘
```

## Status

The spec, resolver, validator, and the **OpenCode, Claude Code, and Codex CLI exporters** are implemented and covered by tests. The TUI is next. The current interface is the CLI.

## Quickstart

Requires [Bun](https://bun.sh) 1.3.14 or newer.

```bash
bun install
bun run src/cli/index.ts init
bun run src/cli/index.ts validate
bun run src/cli/index.ts export --target opencode --dry-run
```

Or link the binary:

```bash
bun link
agentp init
agentp validate
agentp export --target opencode --yes
```

Run any command against another directory with the global `-C` flag (`agentp -C ../service validate`).

## The starter pack

`agentp init` writes a full SDLC pack:

| Agent | Purpose | Writes |
| --- | --- | --- |
| `product-discovery` | Problem statement, constraints, success criteria | `discovery.md` |
| `requirements` | User stories and testable acceptance criteria | `requirements.md` |
| `architect` | Smallest viable design and its tradeoffs | `design.md` |
| `task-planner` | Ordered, independently verifiable tasks | `tasks.md` |
| `implementer` | Smallest defensible change, tests kept green | code and tests |
| `tester` | Verification against acceptance criteria | `test-report.md` |
| `reviewer` | Correctness, security, regressions, missing tests | `review.json` |
| `tech-writer` | Docs and the pull request narrative | docs |

The pipeline runs discovery → requirements → design → plan → implement → test → review → docs, with a bounded loop from `test` back to `implement` and from `review` back to `implement`.

The template assumes the Anthropic provider and `claude-sonnet-4-5` / `claude-haiku-4-5`. Change `spec.model` in `.agentp/agents/*.yaml` or replace `.agentp/providers/anthropic.yaml`. The pack keeps credentials as a `secretRef` plus an environment variable name; exports reference it indirectly (`{env:VAR}` for OpenCode, `${VAR}` for Claude Code, `bearer_token_env_var` / `env_vars` for Codex) and never embed a key.

## What gets created

```
.agentp/
  pack.yaml                 # project pack metadata
  agents/*.yaml             # eight SDLC roles
  pipeline/*.yaml           # feature-delivery DAG
  context/project.yaml      # commands, conventions, definition of done
  providers/*.yaml          # where credentials come from
  prompts/*.md              # system prompts
  state/                    # local caches and export manifest (gitignored)
```

`agentp export --target opencode` writes:

- `.opencode/agents/<name>.md` — one subagent per role, with a model, tool allowlist, and permissions
- `.opencode/agents/<pipeline>-orchestrator.md` — a primary agent that walks the DAG
- `AGENTS.md` — project context in a managed block
- `opencode.json` — MCP server entries, merged without touching the rest of your config

`agentp export --target claude-code` writes:

- `.claude/agents/<name>.md` — one subagent per role, with a `tools` allowlist, model alias, `maxTurns`, and a color
- `.claude/commands/<pipeline>.md` — a slash command that runs in the main thread and delegates to the subagents with the Agent tool
- `CLAUDE.md` — project context in a managed block
- `.mcp.json` — MCP server entries, merged without touching the rest of your config

Claude Code has no primary-agent file that can spawn subagents by name, so the pipeline is compiled into `/feature-delivery` instead of an orchestrator agent. MCP servers are scoped per subagent through the `tools` allowlist (`mcp__<server>__*`): a server that is not listed is unreachable. `.mcp.json` entries use `${VAR}` placeholders, and local servers keep non-secret environment values as written. Servers you add to `.mcp.json` need a one-time approval the next time Claude Code starts.

`agentp export --target codex` writes:

- `.codex/agents/<name>.toml` — one custom agent per role, with instructions, model, reasoning effort, and `shell_tool` disabled when the role has no `bash`
- `.agents/skills/<pipeline>/SKILL.md` — the pipeline as a Codex skill that delegates to those agents
- `AGENTS.md` — project context in a managed block
- `.codex/config.toml` — MCP server entries inside a managed region, merged with your existing config

Codex custom agents inherit the session's provider, permissions, and MCP servers, so this target can enforce less than the other two. It disables the shell tool for roles without `bash`, adds a read-only instruction for roles without write tools, and warns when a role withholds something Codex cannot take away. MCP credentials use Codex's name-based mechanisms (`bearer_token_env_var`, `env_http_headers`, `env_vars` for stdio), so no secret is written. Codex loads `.codex/` only for trusted projects.

Nothing is written without a preview and a backup. Regenerating a hand-edited generated file requires `--force`, while context and config files (`AGENTS.md`, `CLAUDE.md`, `opencode.json`, `.mcp.json`, `.codex/config.toml`) are updated in place.

## Commands

| Command | Purpose |
| --- | --- |
| `agentp init` | Scaffold a full-SDLC pack |
| `agentp validate` | Schema, reference, graph, and exporter checks (`--strict`, `--json`, `--target`) |
| `agentp export --target opencode` | Preview the export (`--yes` writes, `--dry-run` never does) |
| `agentp export --target claude-code` | Same, for Claude Code (`.claude/`, `CLAUDE.md`, `.mcp.json`) |
| `agentp export --target codex` | Same, for Codex CLI (`.codex/`, `.agents/skills/`, `AGENTS.md`) |
| `agentp schema --out schemas/agentp.schema.json` | Write the JSON Schema for the pack format |
| `bun run check` | Typecheck and test |

## How it works

1. **The spec is the source of truth.** A pack is plain YAML documents (`Agent`, `Pipeline`, `Context`, `Integration`, `Provider`, `Pack`) under `apiVersion: agentp/v1`. The JSON Schema is generated from the same Zod definitions the tool uses, so the two cannot drift.
2. **Inheritance over duplication.** A global library at `~/.config/agentp/` merges into each project, field by field, before schema defaults apply. An agent can also `extends` another agent by name.
3. **Honest fidelity.** No target has a declarative graph, so the DAG is compiled into an orchestrator prompt (or slash command, or skill) with explicit routing rules, loop caps, and a handoff contract. Where a runtime cannot express a rule, the export says so: path-scoped edits, command-scoped bash, unscoped MCP servers, and unrecognized models are reported as warnings or notes instead of being silently dropped. The capability matrix is reported per target.
4. **No secrets in exports.** A `secretRef` names a key in the OS keychain or encrypted store. Exports write environment placeholders (`{env:VAR}` for OpenCode, `${VAR}` for Claude Code) or environment variable names (`bearer_token_env_var`, `env_vars` for Codex). Secret-looking environment literals are replaced with placeholders at export time.
5. **Preview everything.** Every export shows a unified diff, keeps backups, and detects hand edits to generated files.

## Known limits

- Stale MCP entries are not pruned from `opencode.json`, `.mcp.json`, or `.codex/config.toml`; Agent P only adds and updates the servers it manages.
- `maxOutputTokens` and per-agent `temperature` have no equivalent in any target and are reported as notes instead.
- Claude Code subagent permissions are an allowlist, so a path-scoped edit rule grants `Edit` and `Write` for the whole project. The export warns and leaves session-wide rules to `.claude/settings.json`.
- Bash command patterns cannot be scoped per Claude Code subagent; the export warns.
- A neutral `list` tool maps to Claude Code's `Glob`, and `question`/`external_directory` have no subagent equivalent; both are reported.
- Codex custom agents inherit the session's provider, permissions, and MCP servers. A path- or command-scoped rule, a withheld web tool, or a server granted to only some agents is reported, not enforced.
- Codex has no per-agent `maxTurns`, `temperature`, or output cap, so those settings are omitted and reported.
- Codex loads `.codex/` only when the project is trusted; MCP servers in `.codex/config.toml` stay inactive until then.
- The interactive TUI has not landed yet.

## License

MIT
