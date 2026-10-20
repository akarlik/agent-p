import { describe, expect, test } from "bun:test"
import type { PipelineDoc } from "../src/core/spec/schema"
import { buildGraph, reachableFromEntry, toMermaid, validateGraph } from "../src/core/graph/graph"

function pipeline(overrides: Partial<PipelineDoc["spec"]> = {}): PipelineDoc {
  return {
    apiVersion: "agentp/v1",
    kind: "Pipeline",
    metadata: { name: "test-flow", description: "A small pipeline used by tests." },
    spec: {
      entry: "discover",
      defaults: { onFailure: "stop", maxIterations: 3 },
      nodes: [
        { id: "discover", agent: "discovery", outputs: ["discovery.md"] },
        { id: "build", agent: "builder", outputs: [] },
        { id: "verify", agent: "tester", outputs: ["test-report.md"] },
      ],
      edges: [
        { from: "discover", to: "build", when: "always" },
        { from: "build", to: "verify", when: "always" },
      ],
      ...overrides,
    },
  }
}

describe("graph", () => {
  test("orders forward stages and identifies terminals", () => {
    const graph = buildGraph(pipeline())
    expect(graph.order.map((node) => node.id)).toEqual(["discover", "build", "verify"])
    expect([...reachableFromEntry(graph)]).toEqual(["discover", "build", "verify"])
    expect(toMermaid(pipeline())).toContain("flowchart TD")
  })

  test("flags an uncapped loop", () => {
    const doc = pipeline({
      edges: [
        { from: "discover", to: "build", when: "always" },
        { from: "build", to: "verify", when: "always" },
        { from: "verify", to: "build", when: 'test.status == "failed"' },
      ],
    })
    const diagnostics = validateGraph(buildGraph(doc), { agentExists: () => true })
    expect(diagnostics.some((d) => d.code === "PIPELINE_LOOP_UNCAPPED" && d.severity === "error")).toBe(true)
  })

  test("accepts a capped loop", () => {
    const doc = pipeline({
      edges: [
        { from: "discover", to: "build", when: "always" },
        { from: "build", to: "verify", when: "always" },
        { from: "verify", to: "build", when: 'test.status == "failed"', maxIterations: 3 },
      ],
    })
    const diagnostics = validateGraph(buildGraph(doc), { agentExists: () => true })
    expect(diagnostics.some((d) => d.code === "PIPELINE_LOOP_UNCAPPED")).toBe(false)
  })

  test("flags unreachable nodes", () => {
    const doc = pipeline({
      nodes: [
        { id: "discover", agent: "discovery", outputs: [] },
        { id: "build", agent: "builder", outputs: [] },
        { id: "orphan", agent: "writer", outputs: [] },
      ],
      edges: [{ from: "discover", to: "build", when: "always" }],
    })
    const diagnostics = validateGraph(buildGraph(doc), { agentExists: () => true })
    expect(diagnostics.some((d) => d.code === "PIPELINE_NODE_UNREACHABLE")).toBe(true)
  })

  test("flags unknown agents and condition nodes", () => {
    const doc = pipeline({
      edges: [
        { from: "discover", to: "build", when: "always" },
        { from: "build", to: "verify", when: 'ghost.status == "ok"' },
      ],
    })
    const diagnostics = validateGraph(buildGraph(doc), { agentExists: (name) => name !== "tester" })
    expect(diagnostics.some((d) => d.code === "PIPELINE_AGENT_MISSING")).toBe(true)
    expect(diagnostics.some((d) => d.code === "PIPELINE_CONDITION_UNKNOWN_NODE")).toBe(true)
  })

  test("flags invalid conditions", () => {
    const doc = pipeline({
      edges: [{ from: "discover", to: "build", when: "status ==" }],
    })
    const diagnostics = validateGraph(buildGraph(doc), { agentExists: () => true })
    expect(diagnostics.some((d) => d.code === "PIPELINE_CONDITION_INVALID")).toBe(true)
  })
})
