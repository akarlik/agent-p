import { describe, expect, test } from "bun:test"
import { sdlcTemplate } from "../src/core/templates/sdlc"
import { parseWithSchema } from "../src/core/spec/parse"
import {
  AgentSchema,
  ContextSchema,
  PackSchema,
  PipelineSchema,
  ProviderSchema,
} from "../src/core/spec/schema"

describe("SDLC template", () => {
  test("is complete and parses cleanly", () => {
    const files = sdlcTemplate("demo")
    expect(files).toHaveLength(22)

    const byPath = new Map(files.map((file) => [file.path, file.contents]))
    const agentFiles = files.filter((file) => file.path.startsWith(".agentp/agents/"))
    expect(agentFiles).toHaveLength(8)

    for (const file of agentFiles) {
      const parsed = parseWithSchema(file.contents, AgentSchema)
      expect({ path: file.path, ok: parsed.ok }).toEqual({ path: file.path, ok: true })
    }

    const pipeline = parseWithSchema(byPath.get(".agentp/pipeline/feature-delivery.yaml") ?? "", PipelineSchema)
    expect(pipeline.ok).toBe(true)
    if (pipeline.ok) {
      expect(pipeline.data.spec.nodes).toHaveLength(8)
      expect(pipeline.data.spec.edges).toHaveLength(9)
      expect(pipeline.data.spec.edges.filter((edge) => edge.maxIterations !== undefined)).toHaveLength(2)
    }

    expect(parseWithSchema(byPath.get(".agentp/pack.yaml") ?? "", PackSchema).ok).toBe(true)
    expect(parseWithSchema(byPath.get(".agentp/context/project.yaml") ?? "", ContextSchema).ok).toBe(true)
    expect(parseWithSchema(byPath.get(".agentp/providers/anthropic.yaml") ?? "", ProviderSchema).ok).toBe(true)

    for (const file of files.filter((candidate) => candidate.path.startsWith(".agentp/prompts/"))) {
      expect(file.contents.length).toBeGreaterThan(200)
    }

    expect(byPath.get(".agentp/.gitignore")).toBe("state/\n")
  })
})
