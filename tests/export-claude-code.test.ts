import { afterAll, describe, expect, test } from "bun:test"
import { join } from "node:path"
import { readFile } from "node:fs/promises"
import YAML from "yaml"
import { parse as parseJsonc } from "jsonc-parser"
import { resolvePack } from "../src/core/resolve/resolve"
import { validatePack } from "../src/core/validate/validate"
import { claudeCodeExporter, mapModelId, resolveTools } from "../src/core/exporters/claude-code"
import { applyPlan, DriftError } from "../src/core/exporters/apply"
import type { AgentDoc } from "../src/core/spec/schema"
import { readTextIfExists, writeTextAtomic } from "../src/core/fs/paths"
import { cleanupTempDirs, scaffold, tempDir, writeFiles } from "./helpers"

afterAll(cleanupTempDirs)

const CLI = join(import.meta.dir, "../src/cli/index.ts")

function frontmatter(contents: string): Record<string, unknown> {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(contents)
  if (!match) throw new Error("no frontmatter")
  return YAML.parse(match[1] ?? "") as Record<string, unknown>
}

function errors(diagnostics: { severity: string }[]) {
  return diagnostics.filter((diagnostic) => diagnostic.severity === "error")
}

function agentDoc(overrides: Partial<AgentDoc["spec"]> = {}, name = "a"): AgentDoc {
  return {
    apiVersion: "agentp/v1",
    kind: "Agent",
    metadata: { name, description: "A test agent used to exercise mapping.", tags: [] },
    spec: {
      tools: { builtin: [], permissions: {}, mcp: [] },
      handoffs: [],
      ...overrides,
    },
  }
}

describe("Claude Code model mapping", () => {
  test("maps model families to aliases", () => {
    expect(mapModelId({ provider: "anthropic", id: "claude-sonnet-4-5" }).model).toBe("sonnet")
    expect(mapModelId({ provider: "anthropic", id: "claude-opus-5" }).model).toBe("opus")
    expect(mapModelId({ provider: "anthropic", id: "claude-haiku-4-5" }).model).toBe("haiku")
    expect(mapModelId({ provider: "bedrock", id: "claude-sonnet-4-5" }).model).toBe("sonnet")
  })

  test("honors modelMap and passes through unknown Claude ids", () => {
    expect(mapModelId({ provider: "anthropic", id: "claude-sonnet-4-5" }, { "anthropic/claude-sonnet-4-5": "opus" }).model).toBe("opus")
    expect(mapModelId({ provider: "anthropic", id: "claude-nova-1" }).model).toBe("claude-nova-1")
  })

  test("degrades non-Anthropic providers to inherit", () => {
    const mapping = mapModelId({ provider: "openai", id: "gpt-5" })
    expect(mapping.model).toBe("inherit")
    expect(mapping.degrade).toContain("not Anthropic")
  })
})

describe("Claude Code tool mapping", () => {
  test("maps neutral tools and MCP servers", () => {
    const agent: Parameters<typeof resolveTools>[0] = {
      id: "a",
      doc: agentDoc({
        tools: {
          builtin: ["read", "grep", "glob", "bash", "webfetch", "task", "skill", "lsp"],
          permissions: {},
          mcp: ["github"],
        },
      }),
      prompt: "x",
      sources: [],
    }
    const resolution = resolveTools(agent, ["github", "linear"])
    expect(resolution.tools).toEqual(["Read", "Glob", "Grep", "Bash", "WebFetch", "LSP", "Skill", "Agent", "mcp__github__*"])
    expect(resolution.tools).not.toContain("mcp__linear__*")
    expect(resolution.delegates).toBe(true)
  })

  test("reports tools without an equivalent and widening of list", () => {
    const agent: Parameters<typeof resolveTools>[0] = {
      id: "a",
      doc: agentDoc({ tools: { builtin: ["list", "question", "external_directory"], permissions: {}, mcp: [] } }),
      prompt: "x",
      sources: [],
    }
    const resolution = resolveTools(agent, [])
    expect(resolution.unmapped).toEqual(["question", "external_directory"])
    expect(resolution.widensListing).toBe(true)
    expect(resolution.tools).toEqual(["Glob"])
  })

  test("flags path-scoped edit and command-scoped bash", () => {
    const agent: Parameters<typeof resolveTools>[0] = {
      id: "a",
      doc: agentDoc({
        tools: {
          builtin: ["read", "edit", "bash"],
          permissions: { edit: { "*": "deny", "a.md": "allow" }, bash: { "*": "ask" } },
          mcp: [],
        },
      }),
      prompt: "x",
      sources: [],
    }
    const resolution = resolveTools(agent, [])
    expect(resolution.pathScopedEdit).toBe(true)
    expect(resolution.commandScopedBash).toBe(true)
    expect(resolution.tools).toContain("Edit")
    expect(resolution.tools).toContain("Bash")
  })

  test("an explicit deny removes the tool", () => {
    const agent: Parameters<typeof resolveTools>[0] = {
      id: "a",
      doc: agentDoc({ tools: { builtin: ["read", "bash"], permissions: { bash: "deny" }, mcp: [] } }),
      prompt: "x",
      sources: [],
    }
    const resolution = resolveTools(agent, [])
    expect(resolution.tools).toEqual(["Read"])
  })
})

describe("Claude Code exporter", () => {
  test("exports subagents, a pipeline command, and CLAUDE.md", async () => {
    const root = await tempDir()
    await scaffold(root)

    const pack = await resolvePack({ root, globalDir: join(root, "global") })
    expect(errors(validatePack(pack, { targets: ["claude-code"] }))).toEqual([])

    const plan = await claudeCodeExporter.plan(pack)
    expect(plan.target).toBe("claude-code")
    expect(plan.changes).toHaveLength(10)
    expect(plan.changes.every((change) => change.action === "create")).toBe(true)

    const paths = plan.changes.map((change) => change.path)
    expect(paths).toContain(".claude/agents/architect.md")
    expect(paths).toContain(".claude/commands/feature-delivery.md")
    expect(paths).toContain("CLAUDE.md")
    expect(paths).not.toContain(".mcp.json")

    await applyPlan(plan)

    const architect = frontmatter((await readTextIfExists(join(root, ".claude/agents/architect.md"))) ?? "")
    expect(architect.name).toBe("architect")
    expect(architect.model).toBe("sonnet")
    expect(architect.maxTurns).toBe(30)
    expect(String(architect.tools).split(", ")).toEqual(["Read", "Edit", "Glob", "Grep"])

    const implementer = frontmatter((await readTextIfExists(join(root, ".claude/agents/implementer.md"))) ?? "")
    expect(String(implementer.tools)).toContain("Bash")

    const command = await readTextIfExists(join(root, ".claude/commands/feature-delivery.md"))
    const commandFrontmatter = frontmatter(command ?? "")
    expect(commandFrontmatter["disable-model-invocation"]).toBe(true)
    expect(String(commandFrontmatter["allowed-tools"])).toContain("Agent")
    expect(commandFrontmatter.model).toBe("sonnet")
    expect(command).toContain("$ARGUMENTS")
    expect(command).toContain("max 3 times")
    expect(command).toContain("test.status")

    const claudeMd = await readTextIfExists(join(root, "CLAUDE.md"))
    expect(claudeMd).toContain("<!-- agentp:begin id=context -->")
    expect(claudeMd).toContain("### Pipeline: feature-delivery")

    // Fidelity warnings are surfaced during validation and export.
    expect(plan.diagnostics.some((diagnostic) => diagnostic.code === "EXPORT_CLAUDE_PATH_SCOPED_EDIT")).toBe(true)
    expect(plan.diagnostics.some((diagnostic) => diagnostic.code === "EXPORT_CLAUDE_COMMAND_SCOPED_BASH")).toBe(true)

    const second = await claudeCodeExporter.plan(pack)
    expect(second.changes.every((change) => change.action === "unchanged")).toBe(true)
  })

  test("protects generated agents from hand edits but not CLAUDE.md", async () => {
    const root = await tempDir()
    await scaffold(root)
    const pack = await resolvePack({ root, globalDir: join(root, "global") })
    await applyPlan(await claudeCodeExporter.plan(pack))

    const agentPath = join(root, ".claude/agents/reviewer.md")
    await writeTextAtomic(agentPath, `${await readFile(agentPath, "utf8")}\n<!-- hand edit -->\n`)
    const plan = await claudeCodeExporter.plan(pack)
    const changed = plan.changes.find((change) => change.path === ".claude/agents/reviewer.md")
    expect(changed?.drifted).toBe(true)
    await expect(applyPlan(plan)).rejects.toBeInstanceOf(DriftError)

    const claudePath = join(root, "CLAUDE.md")
    await writeTextAtomic(claudePath, `${await readFile(claudePath, "utf8")}\n## My own notes\n\nKeep me.\n`)
    const after = await claudeCodeExporter.plan(pack)
    const claudeChange = after.changes.find((change) => change.path === "CLAUDE.md")
    expect(claudeChange?.drifted).toBe(false)
    expect(claudeChange?.action).toBe("unchanged")
  })

  test("write subagents are warned that path scoping is not enforced", async () => {
    const root = await tempDir()
    await writeFiles(root, [
      {
        path: ".agentp/pack.yaml",
        contents: `apiVersion: agentp/v1\nkind: Pack\nmetadata:\n  name: scope\n  description: Scoping test\nspec:\n  defaultPipeline: flow\n`,
      },
      {
        path: ".agentp/agents/writer.yaml",
        contents: `apiVersion: agentp/v1\nkind: Agent\nmetadata:\n  name: writer\n  description: Writes a single artifact only.\nspec:\n  prompt:\n    inline: Write one file.\n  model:\n    provider: anthropic\n    id: claude-sonnet-4-5\n  tools:\n    builtin: [read, edit]\n    permissions:\n      edit:\n        "*": deny\n        out.md: allow\n    mcp: []\n`,
      },
      {
        path: ".agentp/pipeline/flow.yaml",
        contents: `apiVersion: agentp/v1\nkind: Pipeline\nmetadata:\n  name: flow\n  description: A one-stage flow.\nspec:\n  entry: write\n  nodes:\n    - id: write\n      agent: writer\n      outputs: [out.md]\n`,
      },
    ])

    const pack = await resolvePack({ root, globalDir: join(root, "global") })
    const plan = await claudeCodeExporter.plan(pack)
    expect(plan.diagnostics.some((d) => d.code === "EXPORT_CLAUDE_PATH_SCOPED_EDIT")).toBe(true)

    const contents = plan.changes.find((change) => change.path === ".claude/agents/writer.md")?.contents ?? ""
    expect(String(frontmatter(contents).tools).split(", ")).toEqual(["Read", "Edit"])
  })

  test("warns about non-Anthropic models and inherits", async () => {
    const root = await tempDir()
    await writeFiles(root, [
      {
        path: ".agentp/pack.yaml",
        contents: `apiVersion: agentp/v1\nkind: Pack\nmetadata:\n  name: models\n  description: Model mapping test\nspec:\n  defaultPipeline: flow\n`,
      },
      {
        path: ".agentp/agents/local.yaml",
        contents: `apiVersion: agentp/v1\nkind: Agent\nmetadata:\n  name: local\n  description: Runs on a local model backend.\nspec:\n  prompt:\n    inline: Local model.\n  model:\n    provider: ollama\n    id: llama-3.3\n  tools:\n    builtin: [read]\n    permissions: {}\n    mcp: []\n`,
      },
      {
        path: ".agentp/pipeline/flow.yaml",
        contents: `apiVersion: agentp/v1\nkind: Pipeline\nmetadata:\n  name: flow\n  description: A one-stage flow.\nspec:\n  entry: run\n  nodes:\n    - id: run\n      agent: local\n`,
      },
    ])

    const pack = await resolvePack({ root, globalDir: join(root, "global") })
    const plan = await claudeCodeExporter.plan(pack)
    expect(plan.diagnostics.some((d) => d.code === "EXPORT_CLAUDE_MODEL")).toBe(true)

    const contents = plan.changes.find((change) => change.path === ".claude/agents/local.md")?.contents ?? ""
    expect(frontmatter(contents).model).toBe("inherit")
    expect(validatePack(pack, { targets: ["claude-code"] }).some((d) => d.code === "EXPORT_CLAUDE_MODEL")).toBe(true)
  })

  test("merges .mcp.json, scopes MCP per agent, and never writes a secret", async () => {
    const root = await tempDir()
    await writeFiles(root, [
      {
        path: ".agentp/pack.yaml",
        contents: `apiVersion: agentp/v1\nkind: Pack\nmetadata:\n  name: mcp\n  description: MCP merge test\nspec:\n  defaultPipeline: research\n`,
      },
      {
        path: ".agentp/agents/researcher.yaml",
        contents: `apiVersion: agentp/v1\nkind: Agent\nmetadata:\n  name: researcher\n  description: Researches issues with the GitHub server.\nspec:\n  prompt:\n    inline: Research.\n  tools:\n    builtin: [read, grep]\n    permissions: {}\n    mcp: [github]\n`,
      },
      {
        path: ".agentp/integrations/github.yaml",
        contents: `apiVersion: agentp/v1\nkind: Integration\nmetadata:\n  name: github\n  description: GitHub MCP server\nspec:\n  transport: remote\n  url: https://api.githubcopilot.com/mcp/\n  auth:\n    kind: bearer\n    secretRef: ghp_super_secret_value\n    env: GITHUB_TOKEN\n`,
      },
      {
        path: ".agentp/integrations/linear.yaml",
        contents: `apiVersion: agentp/v1\nkind: Integration\nmetadata:\n  name: linear\n  description: Linear MCP server\nspec:\n  transport: remote\n  url: https://mcp.linear.app/mcp\n`,
      },
      {
        path: ".agentp/pipeline/research.yaml",
        contents: `apiVersion: agentp/v1\nkind: Pipeline\nmetadata:\n  name: research\n  description: A one-stage research pipeline.\nspec:\n  entry: research\n  nodes:\n    - id: research\n      agent: researcher\n`,
      },
      {
        path: ".mcp.json",
        contents: `{\n  "mcpServers": {\n    "existing": { "command": "keep-me" }\n  }\n}\n`,
      },
    ])

    const pack = await resolvePack({ root, globalDir: join(root, "global") })
    const plan = await claudeCodeExporter.plan(pack)
    const config = plan.changes.find((change) => change.path === ".mcp.json")
    expect(config).toBeDefined()
    expect(config?.contents).toContain('"Authorization": "Bearer ${GITHUB_TOKEN}"')
    expect(config?.contents).not.toContain("ghp_super_secret_value")
    expect(config?.contents).toContain('"keep-me"')
    expect(config?.contents).not.toContain("mcp.linear.app")
    expect(plan.notes.some((note) => note.includes("Updated the existing MCP server"))).toBe(false)

    const agent = plan.changes.find((change) => change.path === ".claude/agents/researcher.md")
    const tools = String(frontmatter(agent?.contents ?? "").tools)
    expect(tools).toContain("mcp__github__*")
    expect(tools).not.toContain("mcp__linear__*")

    const all = await claudeCodeExporter.plan(pack, { includeUnusedIntegrations: true })
    expect(all.changes.find((change) => change.path === ".mcp.json")?.contents).toContain("mcp.linear.app")

    await applyPlan(plan)
    const merged = parseJsonc((await readTextIfExists(join(root, ".mcp.json"))) ?? "", [])
    expect(merged.mcpServers.existing.command).toBe("keep-me")
    expect(merged.mcpServers.github.type).toBe("http")
    expect(merged.mcpServers.github.headers.Authorization).toBe("Bearer ${GITHUB_TOKEN}")
    expect(merged.mcpServers.linear).toBeUndefined()
  })

  test("substitutes secret-looking local environment values", async () => {
    const root = await tempDir()
    await writeFiles(root, [
      {
        path: ".agentp/pack.yaml",
        contents: `apiVersion: agentp/v1\nkind: Pack\nmetadata:\n  name: env\n  description: Environment test\nspec:\n  defaultPipeline: flow\n`,
      },
      {
        path: ".agentp/agents/user.yaml",
        contents: `apiVersion: agentp/v1\nkind: Agent\nmetadata:\n  name: user\n  description: Uses a local filesystem server.\nspec:\n  prompt:\n    inline: Use files.\n  tools:\n    builtin: [read]\n    permissions: {}\n    mcp: [files]\n`,
      },
      {
        path: ".agentp/integrations/files.yaml",
        contents: `apiVersion: agentp/v1\nkind: Integration\nmetadata:\n  name: files\n  description: Local filesystem server\nspec:\n  transport: local\n  command: [npx, -y, "@modelcontextprotocol/server-filesystem", .]\n  environment:\n    LOG_LEVEL: info\n    API_KEY: literal-secret-value\n`,
      },
      {
        path: ".agentp/pipeline/flow.yaml",
        contents: `apiVersion: agentp/v1\nkind: Pipeline\nmetadata:\n  name: flow\n  description: A one-stage flow.\nspec:\n  entry: use\n  nodes:\n    - id: use\n      agent: user\n`,
      },
    ])

    const pack = await resolvePack({ root, globalDir: join(root, "global") })
    expect(validatePack(pack).some((d) => d.code === "INTEGRATION_ENV_LITERAL_SECRET")).toBe(true)

    const plan = await claudeCodeExporter.plan(pack)
    const config = plan.changes.find((change) => change.path === ".mcp.json")?.contents ?? ""
    expect(config).toContain('"command": "npx"')
    expect(config).toContain('"API_KEY": "${API_KEY}"')
    expect(config).toContain('"LOG_LEVEL": "info"')
    expect(config).not.toContain("literal-secret-value")
  })

  test("warns when a secretRef has no environment variable", async () => {
    const root = await tempDir()
    await writeFiles(root, [
      {
        path: ".agentp/pack.yaml",
        contents: `apiVersion: agentp/v1\nkind: Pack\nmetadata:\n  name: secret\n  description: Secret reference test\nspec:\n  defaultPipeline: flow\n`,
      },
      {
        path: ".agentp/agents/user.yaml",
        contents: `apiVersion: agentp/v1\nkind: Agent\nmetadata:\n  name: user\n  description: Uses a private remote server.\nspec:\n  prompt:\n    inline: Use private.\n  tools:\n    builtin: [read]\n    permissions: {}\n    mcp: [private]\n`,
      },
      {
        path: ".agentp/integrations/private.yaml",
        contents: `apiVersion: agentp/v1\nkind: Integration\nmetadata:\n  name: private\n  description: Private remote server\nspec:\n  transport: remote\n  url: https://example.com/mcp\n  auth:\n    kind: bearer\n    secretRef: ghp_super_secret_value\n`,
      },
      {
        path: ".agentp/pipeline/flow.yaml",
        contents: `apiVersion: agentp/v1\nkind: Pipeline\nmetadata:\n  name: flow\n  description: A one-stage flow.\nspec:\n  entry: use\n  nodes:\n    - id: use\n      agent: user\n`,
      },
    ])

    const pack = await resolvePack({ root, globalDir: join(root, "global") })
    const plan = await claudeCodeExporter.plan(pack)
    expect(plan.diagnostics.some((d) => d.code === "EXPORT_INTEGRATION_ENV_MISSING")).toBe(true)
    const config = plan.changes.find((change) => change.path === ".mcp.json")?.contents ?? ""
    expect(config).not.toContain("ghp_super_secret_value")
    expect(config).not.toContain("headers")
  })

  test("is available from the CLI", async () => {
    const root = await tempDir()
    const init = Bun.spawn(["bun", "run", CLI, "-C", root, "init"], { cwd: root, stdout: "pipe", stderr: "pipe" })
    await init.exited

    const proc = Bun.spawn(["bun", "run", CLI, "-C", root, "export", "--target", "claude-code", "--yes"], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    })
    const exitCode = await proc.exited
    expect(exitCode).toBe(0)
    expect(await readTextIfExists(join(root, ".claude/commands/feature-delivery.md"))).toContain("$ARGUMENTS")
  }, 30_000)
})
