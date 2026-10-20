import { afterAll, describe, expect, test } from "bun:test"
import { join } from "node:path"
import { resolvePack } from "../src/core/resolve/resolve"
import { cleanupTempDirs, tempDir, writeFiles } from "./helpers"

afterAll(cleanupTempDirs)

const pack = `apiVersion: agentp/v1
kind: Pack
metadata:
  name: test
  description: Test pack
spec: {}
`

describe("resolver", () => {
  test("merges raw fields before Zod defaults can erase them", async () => {
    const root = await tempDir()
    const globalDir = join(root, "global")

    await writeFiles(root, [
      { path: ".agentp/pack.yaml", contents: pack },
      {
        path: "global/agents/shared.yaml",
        contents: `apiVersion: agentp/v1
kind: Agent
metadata:
  name: shared
  description: Global description for the shared agent.
spec:
  prompt:
    inline: Global prompt.
  model:
    provider: anthropic
    id: claude-sonnet-4-5
    temperature: 0.2
  tools:
    builtin: [read, edit]
    permissions:
      edit: ask
    mcp: []
  handoffs: [other]
  output:
    format: markdown
    required: [Summary]
  limits:
    maxTurns: 20
`,
      },
      {
        path: ".agentp/agents/shared.yaml",
        contents: `apiVersion: agentp/v1
kind: Agent
metadata:
  name: shared
  description: Project description for the shared agent.
spec:
  prompt:
    inline: Project prompt.
  model:
    provider: anthropic
    id: claude-haiku-4-5
`,
      },
    ])

    const resolved = await resolvePack({ root, globalDir })
    const agent = resolved.agents.get("shared")
    expect(agent).toBeDefined()
    if (!agent) return

    expect(agent.prompt).toBe("Project prompt.")
    expect(agent.doc.metadata.description).toBe("Project description for the shared agent.")
    expect(agent.doc.spec.model?.id).toBe("claude-haiku-4-5")
    expect(agent.doc.spec.model?.temperature).toBe(0.2)
    expect(agent.doc.spec.tools.builtin).toEqual(["read", "edit"])
    expect(agent.doc.spec.handoffs).toEqual(["other"])
    expect(agent.doc.spec.output?.required).toEqual(["Summary"])
    expect(agent.sources).toHaveLength(2)
  })

  test("resolves extends with field-level inheritance", async () => {
    const root = await tempDir()
    await writeFiles(root, [
      { path: ".agentp/pack.yaml", contents: pack },
      {
        path: ".agentp/agents/base.yaml",
        contents: `apiVersion: agentp/v1
kind: Agent
metadata:
  name: base
  description: Base agent with shared defaults.
spec:
  prompt:
    inline: Base prompt.
  model:
    provider: anthropic
    id: claude-sonnet-4-5
    temperature: 0.4
  tools:
    builtin: [read, grep]
    permissions:
      read: allow
    mcp: []
  handoffs: [next]
  output:
    format: markdown
    required: [Summary]
  limits:
    maxTurns: 12
`,
      },
      {
        path: ".agentp/agents/child.yaml",
        contents: `apiVersion: agentp/v1
kind: Agent
metadata:
  name: child
  description: Child agent that inherits most of its configuration.
spec:
  extends: base
  prompt:
    inline: Child prompt.
  model:
    provider: anthropic
    id: claude-haiku-4-5
`,
      },
    ])

    const resolved = await resolvePack({ root, globalDir: join(root, "global") })
    const child = resolved.agents.get("child")
    expect(child).toBeDefined()
    if (!child) return

    expect(child.prompt).toBe("Child prompt.")
    expect(child.doc.spec.extends).toBeUndefined()
    expect(child.doc.spec.model?.id).toBe("claude-haiku-4-5")
    expect(child.doc.spec.model?.temperature).toBe(0.4)
    expect(child.doc.spec.tools.builtin).toEqual(["read", "grep"])
    expect(child.doc.spec.handoffs).toEqual(["next"])
    expect(child.doc.spec.limits?.maxTurns).toBe(12)
    expect(resolved.diagnostics.some((diagnostic) => diagnostic.severity === "error")).toBe(false)
  })

  test("loads prompt files relative to the agent file", async () => {
    const root = await tempDir()
    await writeFiles(root, [
      { path: ".agentp/pack.yaml", contents: pack },
      {
        path: ".agentp/prompts/writer.md",
        contents: "You are a careful writer.\n",
      },
      {
        path: ".agentp/agents/writer.yaml",
        contents: `apiVersion: agentp/v1
kind: Agent
metadata:
  name: writer
  description: A writer agent loaded from a prompt file.
spec:
  prompt:
    file: ../prompts/writer.md
`,
      },
    ])

    const resolved = await resolvePack({ root, globalDir: join(root, "global") })
    expect(resolved.agents.get("writer")?.prompt).toBe("You are a careful writer.\n")
  })

  test("reports missing prompt files but keeps the agent", async () => {
    const root = await tempDir()
    await writeFiles(root, [
      { path: ".agentp/pack.yaml", contents: pack },
      {
        path: ".agentp/agents/broken.yaml",
        contents: `apiVersion: agentp/v1
kind: Agent
metadata:
  name: broken
  description: An agent whose prompt file is missing.
spec:
  prompt:
    file: ../prompts/nope.md
`,
      },
    ])

    const resolved = await resolvePack({ root, globalDir: join(root, "global") })
    expect(resolved.agents.get("broken")?.prompt).toBe("(missing prompt)")
    expect(resolved.diagnostics.some((diagnostic) => diagnostic.code === "AGENT_PROMPT_MISSING")).toBe(true)
  })

  test("project pipelines replace global pipelines by name", async () => {
    const root = await tempDir()
    await writeFiles(root, [
      { path: ".agentp/pack.yaml", contents: pack },
      {
        path: "global/pipeline/flow.yaml",
        contents: `apiVersion: agentp/v1
kind: Pipeline
metadata:
  name: flow
  description: Global flow description.
spec:
  entry: a
  nodes:
    - id: a
      agent: one
`,
      },
      {
        path: ".agentp/pipeline/flow.yaml",
        contents: `apiVersion: agentp/v1
kind: Pipeline
metadata:
  name: flow
  description: Project flow description.
spec:
  entry: a
  nodes:
    - id: a
      agent: one
    - id: b
      agent: two
  edges:
    - from: a
      to: b
      when: always
`,
      },
    ])

    const resolved = await resolvePack({ root, globalDir: join(root, "global") })
    const flow = resolved.pipelines.get("flow")
    expect(flow?.doc.metadata.description).toBe("Project flow description.")
    expect(flow?.doc.spec.nodes).toHaveLength(2)
    expect(flow?.sources).toHaveLength(2)
  })

  test("reports unknown extends targets", async () => {
    const root = await tempDir()
    await writeFiles(root, [
      { path: ".agentp/pack.yaml", contents: pack },
      {
        path: ".agentp/agents/child.yaml",
        contents: `apiVersion: agentp/v1
kind: Agent
metadata:
  name: child
  description: Child with a missing parent.
spec:
  extends: ghost
  prompt:
    inline: Hello.
`,
      },
    ])

    const resolved = await resolvePack({ root, globalDir: join(root, "global") })
    expect(resolved.diagnostics.some((diagnostic) => diagnostic.code === "AGENT_EXTENDS_MISSING")).toBe(true)
  })

  test("reports duplicate names within a scope", async () => {
    const root = await tempDir()
    await writeFiles(root, [
      { path: ".agentp/pack.yaml", contents: pack },
      {
        path: ".agentp/agents/one.yaml",
        contents: `apiVersion: agentp/v1
kind: Agent
metadata:
  name: dup
  description: First definition of the duplicate.
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
  name: dup
  description: Second definition of the duplicate.
spec:
  prompt:
    inline: Two.
`,
      },
    ])

    const resolved = await resolvePack({ root, globalDir: join(root, "global") })
    expect(resolved.diagnostics.some((diagnostic) => diagnostic.code === "DUPLICATE_NAME")).toBe(true)
    expect(resolved.agents.size).toBe(1)
  })
})
