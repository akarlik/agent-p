import { afterAll, describe, expect, test } from "bun:test"
import { join } from "node:path"
import { readFile } from "node:fs/promises"
import YAML from "yaml"
import { parse as parseToml } from "smol-toml"
import { resolvePack, type ResolvedAgent, type ResolvedPack } from "../src/core/resolve/resolve"
import { validatePack } from "../src/core/validate/validate"
import { analyzeCodex, codexExporter, mapModelId, resolveCapabilities } from "../src/core/exporters/codex"
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

function has(diagnostics: { code: string }[], code: string): boolean {
  return diagnostics.some((diagnostic) => diagnostic.code === code)
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

function resolvedAgent(doc: AgentDoc): ResolvedAgent {
  return { id: doc.metadata.name, doc, prompt: "Test prompt.", sources: [] }
}

const PACK = `apiVersion: agentp/v1
kind: Pack
metadata:
  name: test
  description: Codex test pack
spec:
  defaultPipeline: flow
`

const PIPELINE = `apiVersion: agentp/v1
kind: Pipeline
metadata:
  name: flow
  description: A one-stage flow for tests.
spec:
  entry: work
  nodes:
    - id: work
      agent: worker
      outputs: [out.md]
`

const WORKER = `apiVersion: agentp/v1
kind: Agent
metadata:
  name: worker
  description: A worker agent for Codex tests.
spec:
  prompt:
    inline: Do the work.
  model:
    provider: openai
    id: gpt-6.1-sol
    reasoningEffort: high
  tools:
    builtin: [read, edit, bash]
    permissions: {}
    mcp: []
`

async function minimalPack(options: {
  root: string
  agent?: string
  extra?: { path: string; contents: string }[]
}): Promise<ResolvedPack> {
  await writeFiles(options.root, [
    { path: ".agentp/pack.yaml", contents: PACK },
    { path: ".agentp/agents/worker.yaml", contents: options.agent ?? WORKER },
    { path: ".agentp/pipeline/flow.yaml", contents: PIPELINE },
    ...(options.extra ?? []),
  ])
  return resolvePack({ root: options.root, globalDir: join(options.root, "global") })
}

describe("Codex model mapping", () => {
  test("passes OpenAI models through with reasoning effort", () => {
    expect(mapModelId({ provider: "openai", id: "gpt-6.1-sol", reasoningEffort: "high" })).toEqual({
      model: "gpt-6.1-sol",
      effort: "high",
    })
    expect(mapModelId({ provider: "azure", id: "gpt-6-luna" }).model).toBe("gpt-6-luna")
  })

  test("honors modelMap and degrades other providers", () => {
    const mapping = mapModelId({ provider: "anthropic", id: "claude-sonnet-4-5" })
    expect(mapping.model).toBeUndefined()
    expect(mapping.degrade).toContain("not an OpenAI provider")

    expect(
      mapModelId({ provider: "anthropic", id: "claude-sonnet-4-5" }, { "anthropic/claude-sonnet-4-5": "gpt-6-luna" })
        .model,
    ).toBe("gpt-6-luna")
    expect(mapModelId(undefined)).toEqual({})
  })
})

describe("Codex capability mapping", () => {
  test("disables the shell only when bash is not granted", () => {
    const withBash = resolvedAgent(agentDoc({ tools: { builtin: ["read", "bash"], permissions: {}, mcp: [] } }))
    expect(resolveCapabilities(withBash).shell).toBe(true)

    const deniedBash = resolvedAgent(
      agentDoc({ tools: { builtin: ["read", "bash"], permissions: { bash: "deny" }, mcp: [] } }),
    )
    expect(resolveCapabilities(deniedBash).shell).toBe(false)
  })

  test("treats an agent without write tools as read-only", () => {
    const readOnly = resolvedAgent(agentDoc({ tools: { builtin: ["read", "grep"], permissions: {}, mcp: [] } }))
    expect(resolveCapabilities(readOnly).readOnly).toBe(true)

    const writer = resolvedAgent(agentDoc({ tools: { builtin: ["read", "edit"], permissions: {}, mcp: [] } }))
    expect(resolveCapabilities(writer).readOnly).toBe(false)
  })

  test("reports scoped permissions and withheld risky tools", () => {
    const agent = resolvedAgent(
      agentDoc({
        tools: {
          builtin: ["read", "edit"],
          permissions: { edit: { "*": "deny", "a.md": "allow" } },
          mcp: [],
        },
      }),
    )
    const capabilities = resolveCapabilities(agent)
    expect(capabilities.scoped).toEqual(["edit"])
    expect(capabilities.unsafeWithheld).toContain("webfetch")
    expect(capabilities.unsafeWithheld).not.toContain("bash")
  })
})

describe("Codex exporter", () => {
  test("exports custom agents, a pipeline skill, and AGENTS.md", async () => {
    const root = await tempDir()
    await scaffold(root)
    const pack = await resolvePack({ root, globalDir: join(root, "global") })

    const plan = await codexExporter.plan(pack)
    expect(plan.target).toBe("codex")
    expect(plan.changes).toHaveLength(10)
    expect(plan.changes.every((change) => change.action === "create")).toBe(true)

    const paths = plan.changes.map((change) => change.path)
    expect(paths).toContain(".codex/agents/architect.toml")
    expect(paths).toContain(".agents/skills/feature-delivery/SKILL.md")
    expect(paths).toContain("AGENTS.md")
    expect(paths).not.toContain(".codex/config.toml")

    await applyPlan(plan)

    const architect = parseToml(await readFile(join(root, ".codex/agents/architect.toml"), "utf8")) as Record<
      string,
      any
    >
    expect(architect.name).toBe("architect")
    expect(architect.description).toContain("architecture")
    expect(architect.developer_instructions).toContain("You are the software architect.")
    expect(architect.features.shell_tool).toBe(false)
    // The template is Anthropic-hosted, so no Codex model is written.
    expect(architect.model).toBeUndefined()

    const implementer = parseToml(await readFile(join(root, ".codex/agents/implementer.toml"), "utf8")) as Record<
      string,
      any
    >
    expect(implementer.features).toBeUndefined()

    const skill = (await readTextIfExists(join(root, ".agents/skills/feature-delivery/SKILL.md"))) ?? ""
    const meta = frontmatter(skill)
    expect(meta.name).toBe("feature-delivery")
    expect(String(meta.description)).toContain("Run the feature-delivery pipeline")
    expect(skill).toContain("spawn the named custom agent")
    expect(skill).toContain("max 3 times")
    expect(skill).toContain("test.status")

    expect(await readTextIfExists(join(root, "AGENTS.md"))).toContain("<!-- agentp:begin id=context -->")

    expect(has(plan.diagnostics, "EXPORT_CODEX_MODEL")).toBe(true)
    expect(has(plan.diagnostics, "EXPORT_CODEX_TOOLS_UNSCOPED")).toBe(true)
    expect(has(validatePack(pack, { targets: ["codex"] }), "EXPORT_CODEX_MODEL")).toBe(true)

    const second = await codexExporter.plan(pack)
    expect(second.changes.every((change) => change.action === "unchanged")).toBe(true)
  })

  test("protects generated agents but not AGENTS.md", async () => {
    const root = await tempDir()
    await scaffold(root)
    const pack = await resolvePack({ root, globalDir: join(root, "global") })
    await applyPlan(await codexExporter.plan(pack))

    const agentPath = join(root, ".codex/agents/reviewer.toml")
    await writeTextAtomic(agentPath, `${await readFile(agentPath, "utf8")}\n# hand edit\n`)

    const plan = await codexExporter.plan(pack)
    expect(plan.changes.find((change) => change.path === ".codex/agents/reviewer.toml")?.drifted).toBe(true)
    await expect(applyPlan(plan)).rejects.toBeInstanceOf(DriftError)

    const agentsPath = join(root, "AGENTS.md")
    await writeTextAtomic(agentsPath, `${await readFile(agentsPath, "utf8")}\n## Mine\n\nKeep me.\n`)
    const after = await codexExporter.plan(pack)
    const change = after.changes.find((entry) => entry.path === "AGENTS.md")
    expect(change?.drifted).toBe(false)
    expect(change?.action).toBe("unchanged")
  })

  test("adds a read-only instruction because Codex has no per-agent filesystem scope", async () => {
    const root = await tempDir()
    const pack = await minimalPack({
      root,
      agent: `apiVersion: agentp/v1
kind: Agent
metadata:
  name: worker
  description: A read-only research agent for Codex tests.
spec:
  prompt:
    inline: Research the change and report findings.
  model:
    provider: openai
    id: gpt-6-luna
  tools:
    builtin: [read, grep]
    permissions: {}
    mcp: []
`,
    })

    const plan = await codexExporter.plan(pack)
    expect(has(plan.diagnostics, "EXPORT_CODEX_READ_ONLY_INSTRUCTIONS")).toBe(true)

    const contents = plan.changes.find((change) => change.path === ".codex/agents/worker.toml")?.contents ?? ""
    const doc = parseToml(contents) as Record<string, any>
    expect(doc.model).toBe("gpt-6-luna")
    expect(doc.developer_instructions).toContain("Read-only role")
    expect(doc.features.shell_tool).toBe(false)
  })

  test("round-trips prompts containing triple quotes and backslashes", async () => {
    const root = await tempDir()
    const prompt = "Read C:\\temp\\new\\file, match \\d+\\s*, and keep '''three quotes''' intact."
    const pack = await minimalPack({
      root,
      agent: `apiVersion: agentp/v1
kind: Agent
metadata:
  name: worker
  description: A worker agent with a tricky prompt.
spec:
  prompt:
    file: ../prompts/worker.md
  model:
    provider: openai
    id: gpt-6.1-sol
  tools:
    builtin: [read]
    permissions: {}
    mcp: []
`,
      extra: [{ path: ".agentp/prompts/worker.md", contents: prompt }],
    })

    const plan = await codexExporter.plan(pack)
    const contents = plan.changes.find((change) => change.path === ".codex/agents/worker.toml")?.contents ?? ""
    const doc = parseToml(contents) as Record<string, any>
    expect(doc.developer_instructions).toContain("C:\\temp\\new\\file")
    expect(doc.developer_instructions).toContain("'''three quotes'''")
    expect(doc.developer_instructions).toContain("\\d+\\s*")
  })

  test("merges MCP servers into .codex/config.toml without writing secrets", async () => {
    const root = await tempDir()
    await writeFiles(root, [
      {
        path: ".codex/config.toml",
        contents: `# My local settings
[agents]
max_concurrent_threads_per_session = 4

# keep this one
[mcp_servers.context7]
command = "npx"
args = ["-y", "@upstash/context7-mcp"]
`,
      },
    ])

    const pack = await minimalPack({
      root,
      agent: WORKER.replace("    mcp: []", "    mcp: [github, files]"),
      extra: [
        {
          path: ".agentp/integrations/github.yaml",
          contents: `apiVersion: agentp/v1
kind: Integration
metadata:
  name: github
  description: GitHub MCP server for issues and pull requests.
spec:
  transport: remote
  url: https://api.githubcopilot.com/mcp/
  auth:
    kind: bearer
    secretRef: ghp_super_secret_value
    env: GITHUB_TOKEN
  scopes: [repo]
  tools: [list_issues, create_issue]
`,
        },
        {
          path: ".agentp/integrations/files.yaml",
          contents: `apiVersion: agentp/v1
kind: Integration
metadata:
  name: files
  description: Local filesystem MCP server.
spec:
  transport: local
  command: [npx, -y, "@modelcontextprotocol/server-filesystem", .]
  environment:
    LOG_LEVEL: info
    API_KEY: literal-secret-value
`,
        },
      ],
    })

    // The local integration needs a second agent reference; grant it on the worker.
    const plan = await codexExporter.plan(pack)
    const config = plan.changes.find((change) => change.path === ".codex/config.toml")
    expect(config).toBeDefined()
    expect(config?.contents).toContain("# My local settings")
    expect(config?.contents).toContain("# keep this one")
    expect(config?.contents).toContain('bearer_token_env_var = "GITHUB_TOKEN"')
    expect(config?.contents).toContain('scopes = ["repo"]')
    expect(config?.contents).toContain('enabled_tools = ["list_issues", "create_issue"]')
    expect(config?.contents).toContain('env = { LOG_LEVEL = "info" }')
    expect(config?.contents).toContain('env_vars = ["API_KEY"]')
    expect(config?.contents).not.toContain("ghp_super_secret_value")
    expect(config?.contents).not.toContain("literal-secret-value")

    await applyPlan(plan)
    const merged = parseToml(await readFile(join(root, ".codex/config.toml"), "utf8")) as Record<string, any>
    expect(merged.agents.max_concurrent_threads_per_session).toBe(4)
    expect(merged.mcp_servers.context7.command).toBe("npx")
    expect(merged.mcp_servers.github.bearer_token_env_var).toBe("GITHUB_TOKEN")
    expect(merged.mcp_servers.files.env_vars).toEqual(["API_KEY"])

    // Re-export is a no-op: no duplicated tables and no drifting region.
    const second = await codexExporter.plan(pack)
    expect(second.changes.find((change) => change.path === ".codex/config.toml")?.action).toBe("unchanged")
  })

  test("leaves a user-defined server alone and warns", async () => {
    const root = await tempDir()
    const pack = await minimalPack({
      root,
      agent: WORKER.replace("    mcp: []", "    mcp: [github]"),
      extra: [
        {
          path: ".agentp/integrations/github.yaml",
          contents: `apiVersion: agentp/v1
kind: Integration
metadata:
  name: github
  description: GitHub MCP server for issues and pull requests.
spec:
  transport: remote
  url: https://api.githubcopilot.com/mcp/
`,
        },
      ],
    })

    // First export creates the managed region, then the user adds their own table.
    await applyPlan(await codexExporter.plan(pack))
    const configPath = join(root, ".codex/config.toml")
    await writeTextAtomic(
      configPath,
      `${await readFile(configPath, "utf8")}\n[mcp_servers.github]\nurl = "https://mine.example"\n`,
    )

    const plan = await codexExporter.plan(pack)
    expect(has(plan.diagnostics, "EXPORT_CODEX_CONFIG_CONFLICT")).toBe(true)
    await applyPlan(plan)
    const merged = parseToml(await readFile(configPath, "utf8")) as Record<string, any>
    expect(merged.mcp_servers.github.url).toBe("https://mine.example")
  })

  test("leaves an unparseable config untouched", async () => {
    const root = await tempDir()
    const agent = WORKER.replace("    mcp: []", "    mcp: [github]")
    const pack = await minimalPack({
      root,
      agent,
      extra: [
        {
          path: ".agentp/integrations/github.yaml",
          contents: `apiVersion: agentp/v1
kind: Integration
metadata:
  name: github
  description: GitHub MCP server for issues and pull requests.
spec:
  transport: remote
  url: https://api.githubcopilot.com/mcp/
`,
        },
      ],
    })

    const broken = "# user config\n[broken\nx=\n"
    await writeTextAtomic(join(root, ".codex/config.toml"), broken)

    const plan = await codexExporter.plan(pack)
    expect(has(plan.diagnostics, "EXPORT_CONFIG_INVALID")).toBe(true)
    expect(plan.changes.find((change) => change.path === ".codex/config.toml")?.contents).toBe(broken)
  })

  test("warns that MCP servers are not scoped per agent", async () => {
    const root = await tempDir()
    const pack = await minimalPack({
      root,
      agent: WORKER.replace("    mcp: []", "    mcp: [github]"),
      extra: [
        {
          path: ".agentp/integrations/github.yaml",
          contents: `apiVersion: agentp/v1
kind: Integration
metadata:
  name: github
  description: GitHub MCP server for issues and pull requests.
spec:
  transport: remote
  url: https://api.githubcopilot.com/mcp/
`,
        },
        {
          path: ".agentp/integrations/linear.yaml",
          contents: `apiVersion: agentp/v1
kind: Integration
metadata:
  name: linear
  description: Linear issue tracker MCP server.
spec:
  transport: remote
  url: https://mcp.linear.app/mcp
`,
        },
      ],
    })

    const analysis = analyzeCodex(pack)
    expect(has(analysis.diagnostics, "EXPORT_CODEX_MCP_NOT_SCOPED")).toBe(true)
    expect(
      analysis.diagnostics.find((diagnostic) => diagnostic.code === "EXPORT_CODEX_MCP_NOT_SCOPED")?.message,
    ).toContain("linear")
  })

  test("is available from the CLI", async () => {
    const root = await tempDir()
    const init = Bun.spawn(["bun", "run", CLI, "-C", root, "init"], { cwd: root, stdout: "pipe", stderr: "pipe" })
    await init.exited

    const proc = Bun.spawn(["bun", "run", CLI, "-C", root, "export", "--target", "codex", "--yes"], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    })
    expect(await proc.exited).toBe(0)

    const contents = (await readTextIfExists(join(root, ".codex/agents/architect.toml"))) ?? ""
    expect(contents).toContain('name = "architect"')
    expect(contents).toContain("shell_tool = false")
  }, 30_000)
})
