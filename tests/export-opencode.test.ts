import { afterAll, describe, expect, test } from "bun:test"
import { join } from "node:path"
import { readFile } from "node:fs/promises"
import { parse as parseJsonc } from "jsonc-parser"
import { resolvePack } from "../src/core/resolve/resolve"
import { validatePack } from "../src/core/validate/validate"
import { opencodeExporter } from "../src/core/exporters/opencode"
import { applyPlan, DriftError } from "../src/core/exporters/apply"
import { readTextIfExists, writeTextAtomic } from "../src/core/fs/paths"
import { cleanupTempDirs, scaffold, tempDir, writeFiles } from "./helpers"

afterAll(cleanupTempDirs)

function errors(diagnostics: { severity: string }[]) {
  return diagnostics.filter((diagnostic) => diagnostic.severity === "error")
}

function warnings(diagnostics: { severity: string }[]) {
  return diagnostics.filter((diagnostic) => diagnostic.severity === "warning")
}

describe("OpenCode exporter", () => {
  test("exports a fresh SDLC pack and is idempotent", async () => {
    const root = await tempDir()
    await scaffold(root)

    const pack = await resolvePack({ root, globalDir: join(root, "global") })
    expect(errors(validatePack(pack))).toEqual([])
    expect(warnings(validatePack(pack))).toEqual([])

    const plan = await opencodeExporter.plan(pack)
    expect(plan.changes).toHaveLength(10)
    expect(plan.changes.every((change) => change.action === "create")).toBe(true)
    expect(plan.changes.map((change) => change.path)).toContain(".opencode/agents/feature-delivery-orchestrator.md")
    expect(plan.changes.map((change) => change.path)).toContain("AGENTS.md")
    expect(plan.changes.map((change) => change.path)).not.toContain("opencode.json")

    const applied = await applyPlan(plan)
    expect(applied.written).toHaveLength(10)

    const architect = await readTextIfExists(join(root, ".opencode/agents/architect.md"))
    expect(architect).toContain("mode: subagent")
    expect(architect).toContain("model: anthropic/claude-sonnet-4-5")
    expect(architect).toContain('"*": deny')
    expect(architect).toContain("design.md: allow")

    const orchestrator = await readTextIfExists(join(root, ".opencode/agents/feature-delivery-orchestrator.md"))
    expect(orchestrator).toContain("mode: primary")
    expect(orchestrator).toContain("max 3 times")
    expect(orchestrator).toContain("test.status")
    expect(orchestrator).toContain("review.verdict")

    const agentsMd = await readTextIfExists(join(root, "AGENTS.md"))
    expect(agentsMd).toContain("agentp:begin id=context")
    expect(agentsMd).toContain("### Pipeline: feature-delivery")

    const manifest = JSON.parse((await readFile(join(root, ".agentp/state/export.lock.json"), "utf8")) as string)
    expect(manifest.targets.opencode.files[".opencode/agents/architect.md"].kind).toBe("agent")

    const second = await opencodeExporter.plan(pack)
    expect(second.changes.every((change) => change.action === "unchanged")).toBe(true)
    const secondApply = await applyPlan(second)
    expect(secondApply.written).toEqual([])
  })

  test("detects hand edits and requires --force", async () => {
    const root = await tempDir()
    await scaffold(root)
    const pack = await resolvePack({ root, globalDir: join(root, "global") })

    await applyPlan(await opencodeExporter.plan(pack))
    const target = join(root, ".opencode/agents/implementer.md")
    await writeTextAtomic(target, `${await readFile(target, "utf8")}\n<!-- hand edit -->\n`)

    const plan = await opencodeExporter.plan(pack)
    const change = plan.changes.find((candidate) => candidate.path === ".opencode/agents/implementer.md")
    expect(change?.action).toBe("update")
    expect(change?.drifted).toBe(true)

    await expect(applyPlan(plan)).rejects.toBeInstanceOf(DriftError)
    await applyPlan(plan, { force: true })
    expect(await readTextIfExists(target)).not.toContain("<!-- hand edit -->")
  })

  test("preserves existing AGENTS.md content and updates the managed block in place", async () => {
    const root = await tempDir()
    await scaffold(root)
    await writeTextAtomic(join(root, "AGENTS.md"), "# Existing repo\n\nKeep this line.\n")

    const pack = await resolvePack({ root, globalDir: join(root, "global") })
    await applyPlan(await opencodeExporter.plan(pack))

    const once = await readTextIfExists(join(root, "AGENTS.md"))
    expect(once).toContain("Keep this line.")
    expect(once?.split("<!-- agentp:begin id=context -->").length).toBe(2)

    await applyPlan(await opencodeExporter.plan(pack))
    const twice = await readTextIfExists(join(root, "AGENTS.md"))
    expect(twice?.split("<!-- agentp:begin id=context -->").length).toBe(2)
  })

  test("merges MCP config without wiping comments or unrelated keys", async () => {
    const root = await tempDir()
    await writeFiles(root, [
      {
        path: ".agentp/pack.yaml",
        contents: `apiVersion: agentp/v1
kind: Pack
metadata:
  name: mcp-test
  description: MCP merge test
spec:
  defaultPipeline: research
`,
      },
      {
        path: ".agentp/agents/researcher.yaml",
        contents: `apiVersion: agentp/v1
kind: Agent
metadata:
  name: researcher
  description: Researches issues using the GitHub integration.
spec:
  prompt:
    inline: Research carefully.
  tools:
    builtin: [read, grep]
    permissions: {}
    mcp: [github]
`,
      },
      {
        path: ".agentp/integrations/github.yaml",
        contents: `apiVersion: agentp/v1
kind: Integration
metadata:
  name: github
  description: GitHub MCP server
spec:
  transport: remote
  url: https://api.githubcopilot.com/mcp/
  auth:
    kind: bearer
    secretRef: ghp_super_secret_value
    env: GITHUB_TOKEN
`,
      },
      {
        path: ".agentp/integrations/linear.yaml",
        contents: `apiVersion: agentp/v1
kind: Integration
metadata:
  name: linear
  description: Linear MCP server
spec:
  transport: remote
  url: https://mcp.linear.app/mcp
`,
      },
      {
        path: ".agentp/pipeline/research.yaml",
        contents: `apiVersion: agentp/v1
kind: Pipeline
metadata:
  name: research
  description: A one-stage research pipeline.
spec:
  entry: research
  nodes:
    - id: research
      agent: researcher
`,
      },
      {
        path: "opencode.json",
        contents: `{
  // keep my theme
  "$schema": "https://opencode.ai/config.json",
  "theme": "dark",
  "mcp": {
    "existing": { "type": "remote", "url": "https://example.com/mcp", "enabled": true }
  }
}
`,
      },
    ])

    const pack = await resolvePack({ root, globalDir: join(root, "global") })
    expect(errors(validatePack(pack))).toEqual([])

    const plan = await opencodeExporter.plan(pack)
    const config = plan.changes.find((change) => change.path === "opencode.json")
    expect(config).toBeDefined()
    expect(config?.contents).toContain("Bearer {env:GITHUB_TOKEN}")
    expect(config?.contents).not.toContain("ghp_super_secret_value")
    expect(config?.contents).toContain("https://api.githubcopilot.com/mcp/")
    expect(config?.contents).not.toContain("mcp.linear.app")

    const agent = plan.changes.find((change) => change.path === ".opencode/agents/researcher.md")
    expect(agent?.contents).toContain("github_*: allow")
    expect(agent?.contents).toContain("linear_*: deny")
    expect(agent?.contents).toContain("existing_*: deny")
    expect(plan.notes.some((note) => note.includes("not declared in the pack"))).toBe(true)

    const all = await opencodeExporter.plan(pack, { includeUnusedIntegrations: true })
    const allConfig = all.changes.find((change) => change.path === "opencode.json")
    expect(allConfig?.contents).toContain("mcp.linear.app")

    await applyPlan(plan)
    const merged = await readTextIfExists(join(root, "opencode.json"))
    expect(merged).toContain("// keep my theme")
    expect(merged).not.toContain("ghp_super_secret_value")

    const parsed = parseJsonc(merged ?? "", [])
    expect(parsed.theme).toBe("dark")
    expect(parsed.mcp.existing.url).toBe("https://example.com/mcp")
    expect(parsed.mcp.github.type).toBe("remote")
    expect(parsed.mcp.github.headers.Authorization).toBe("Bearer {env:GITHUB_TOKEN}")
    expect(parsed.mcp.linear).toBeUndefined()
  })

  test("never writes a secretRef into the exported config", async () => {
    const root = await tempDir()
    await writeFiles(root, [
      {
        path: ".agentp/pack.yaml",
        contents: `apiVersion: agentp/v1
kind: Pack
metadata:
  name: secret-test
  description: Secret leakage test
spec:
  defaultPipeline: research
`,
      },
      {
        path: ".agentp/agents/researcher.yaml",
        contents: `apiVersion: agentp/v1
kind: Agent
metadata:
  name: researcher
  description: Researches using a private integration.
spec:
  prompt:
    inline: Research.
  tools:
    builtin: [read]
    permissions: {}
    mcp: [private]
`,
      },
      {
        path: ".agentp/integrations/private.yaml",
        contents: `apiVersion: agentp/v1
kind: Integration
metadata:
  name: private
  description: Private integration without an env var.
spec:
  transport: remote
  url: https://example.com/mcp
  auth:
    kind: bearer
    secretRef: ghp_super_secret_value
`,
      },
      {
        path: ".agentp/pipeline/research.yaml",
        contents: `apiVersion: agentp/v1
kind: Pipeline
metadata:
  name: research
  description: A one-stage research pipeline.
spec:
  entry: research
  nodes:
    - id: research
      agent: researcher
`,
      },
    ])

    const pack = await resolvePack({ root, globalDir: join(root, "global") })
    const plan = await opencodeExporter.plan(pack)
    const config = plan.changes.find((change) => change.path === "opencode.json")
    expect(config).toBeDefined()
    expect(config?.contents).not.toContain("ghp_super_secret_value")
    expect(config?.contents).not.toContain("secretRef")
    expect(plan.diagnostics.some((diagnostic) => diagnostic.code === "EXPORT_INTEGRATION_ENV_MISSING")).toBe(true)

    for (const change of plan.changes) {
      expect(change.contents).not.toContain("ghp_super_secret_value")
    }
  })

  test("replaces secret-looking environment literals with placeholders", async () => {
    const root = await tempDir()
    await writeFiles(root, [
      {
        path: ".agentp/pack.yaml",
        contents: `apiVersion: agentp/v1
kind: Pack
metadata:
  name: env-test
  description: Environment placeholder test
spec:
  defaultPipeline: research
`,
      },
      {
        path: ".agentp/agents/researcher.yaml",
        contents: `apiVersion: agentp/v1
kind: Agent
metadata:
  name: researcher
  description: Researches using a local filesystem server.
spec:
  prompt:
    inline: Research.
  tools:
    builtin: [read]
    permissions: {}
    mcp: [files]
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
    GITHUB_TOKEN: ghp_literal_value
`,
      },
      {
        path: ".agentp/pipeline/research.yaml",
        contents: `apiVersion: agentp/v1
kind: Pipeline
metadata:
  name: research
  description: A one-stage research pipeline.
spec:
  entry: research
  nodes:
    - id: research
      agent: researcher
`,
      },
    ])

    const pack = await resolvePack({ root, globalDir: join(root, "global") })
    const diagnostics = validatePack(pack)
    expect(diagnostics.some((diagnostic) => diagnostic.code === "INTEGRATION_ENV_LITERAL_SECRET")).toBe(true)

    const plan = await opencodeExporter.plan(pack)
    const config = plan.changes.find((change) => change.path === "opencode.json")
    expect(config?.contents).toContain('"{env:GITHUB_TOKEN}"')
    expect(config?.contents).toContain('"LOG_LEVEL": "info"')
    expect(config?.contents).not.toContain("ghp_literal_value")
  })

  test("flags uncapped loops before export", async () => {
    const root = await tempDir()
    await writeFiles(root, [
      {
        path: ".agentp/pack.yaml",
        contents: `apiVersion: agentp/v1
kind: Pack
metadata:
  name: loop-test
  description: Loop validation test
spec:
  defaultPipeline: loop
`,
      },
      {
        path: ".agentp/agents/one.yaml",
        contents: `apiVersion: agentp/v1
kind: Agent
metadata:
  name: one
  description: The first agent in the loop.
spec:
  prompt:
    inline: One.
`,
      },
      {
        path: ".agentp/agents/two.yaml",
        contents: `apiVersion: agentp/v1
kind: Agent
metadata:
  name: two
  description: The second agent in the loop.
spec:
  prompt:
    inline: Two.
`,
      },
      {
        path: ".agentp/pipeline/loop.yaml",
        contents: `apiVersion: agentp/v1
kind: Pipeline
metadata:
  name: loop
  description: A pipeline with an uncapped loop.
spec:
  entry: one
  nodes:
    - id: one
      agent: one
    - id: two
      agent: two
  edges:
    - from: one
      to: two
    - from: two
      to: one
      when: two.status == "again"
`,
      },
    ])

    const pack = await resolvePack({ root, globalDir: join(root, "global") })
    const diagnostics = validatePack(pack)
    expect(diagnostics.some((diagnostic) => diagnostic.code === "PIPELINE_LOOP_UNCAPPED")).toBe(true)
  })
})
