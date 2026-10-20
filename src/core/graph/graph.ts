import { error, info, warning, type Diagnostic } from "../diagnostics"
import type { PipelineDoc, PipelineEdge, PipelineNode } from "../spec/schema"
import { collectRootNodes, parseCondition, formatExpr, type Expr } from "./condition"

export type GraphModel = {
  pipeline: PipelineDoc
  byId: Map<string, PipelineNode>
  outgoing: Map<string, PipelineEdge[]>
  incoming: Map<string, PipelineEdge[]>
  backEdges: Set<PipelineEdge>
  order: PipelineNode[]
  conditions: Map<PipelineEdge, Expr>
}

export function buildGraph(pipeline: PipelineDoc): GraphModel {
  const byId = new Map<string, PipelineNode>()
  for (const node of pipeline.spec.nodes) byId.set(node.id, node)

  const outgoing = new Map<string, PipelineEdge[]>()
  const incoming = new Map<string, PipelineEdge[]>()
  for (const node of pipeline.spec.nodes) {
    outgoing.set(node.id, [])
    incoming.set(node.id, [])
  }
  for (const edge of pipeline.spec.edges) {
    outgoing.get(edge.from)?.push(edge)
    incoming.get(edge.to)?.push(edge)
  }

  const backEdges = new Set<PipelineEdge>()
  const color = new Map<string, 0 | 1 | 2>()

  const visit = (id: string): void => {
    color.set(id, 1)
    for (const edge of outgoing.get(id) ?? []) {
      const state = color.get(edge.to) ?? 0
      if (state === 1) backEdges.add(edge)
      else if (state === 0) visit(edge.to)
    }
    color.set(id, 2)
  }

  const entry = pipeline.spec.entry
  if (byId.has(entry)) visit(entry)
  for (const id of byId.keys()) {
    if ((color.get(id) ?? 0) === 0) visit(id)
  }

  const order = topologicalOrder(pipeline, backEdges)

  const conditions = new Map<PipelineEdge, Expr>()
  for (const edge of pipeline.spec.edges) {
    const parsed = parseCondition(edge.when)
    if (parsed.ok) conditions.set(edge, parsed.ast)
  }

  return { pipeline, byId, outgoing, incoming, backEdges, order, conditions }
}

function topologicalOrder(pipeline: PipelineDoc, backEdges: Set<PipelineEdge>): PipelineNode[] {
  const order: PipelineNode[] = []
  const indegree = new Map<string, number>()
  const byId = new Map<string, PipelineNode>()

  for (const node of pipeline.spec.nodes) {
    byId.set(node.id, node)
    indegree.set(node.id, 0)
  }
  for (const edge of pipeline.spec.edges) {
    if (backEdges.has(edge)) continue
    if (!byId.has(edge.to)) continue
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1)
  }

  const queue = pipeline.spec.nodes.filter((node) => (indegree.get(node.id) ?? 0) === 0)
  const seen = new Set<string>()

  while (queue.length > 0) {
    const node = queue.shift()!
    if (seen.has(node.id)) continue
    seen.add(node.id)
    order.push(node)
    for (const edge of pipeline.spec.edges) {
      if (edge.from !== node.id || backEdges.has(edge)) continue
      const next = indegree.get(edge.to)
      if (next === undefined) continue
      indegree.set(edge.to, next - 1)
      if (next - 1 === 0) {
        const target = byId.get(edge.to)
        if (target) queue.push(target)
      }
    }
  }

  for (const node of pipeline.spec.nodes) {
    if (!seen.has(node.id)) order.push(node)
  }
  return order
}

export function reachableFromEntry(graph: GraphModel): Set<string> {
  const seen = new Set<string>()
  const stack = [graph.pipeline.spec.entry]
  while (stack.length > 0) {
    const id = stack.pop()!
    if (seen.has(id)) continue
    seen.add(id)
    for (const edge of graph.outgoing.get(id) ?? []) {
      if (!seen.has(edge.to)) stack.push(edge.to)
    }
  }
  return seen
}

export function validateGraph(
  graph: GraphModel,
  options: { file?: string; agentExists?: (name: string) => boolean; initial?: Diagnostic[] } = {},
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [...(options.initial ?? [])]
  const { pipeline, byId, backEdges } = graph
  const file = options.file

  if (!byId.has(pipeline.spec.entry)) {
    diagnostics.push(
      error("PIPELINE_ENTRY_MISSING", `Entry node "${pipeline.spec.entry}" does not exist.`, {
        file,
        pointer: "spec.entry",
        hint: `Available nodes: ${[...byId.keys()].join(", ")}`,
      }),
    )
  }

  const seenNodeIds = new Set<string>()
  pipeline.spec.nodes.forEach((node, index) => {
    if (seenNodeIds.has(node.id)) {
      diagnostics.push(
        error("PIPELINE_NODE_DUPLICATE", `Duplicate node id "${node.id}".`, {
          file,
          pointer: `spec.nodes[${index}].id`,
        }),
      )
    }
    seenNodeIds.add(node.id)

    if (options.agentExists && !options.agentExists(node.agent)) {
      diagnostics.push(
        error("PIPELINE_AGENT_MISSING", `Node "${node.id}" references unknown agent "${node.agent}".`, {
          file,
          pointer: `spec.nodes[${index}].agent`,
          hint: "Define the agent in .agentp/agents/ or the global library.",
        }),
      )
    }
  })

  const edgeKeys = new Set<string>()
  pipeline.spec.edges.forEach((edge, index) => {
    const pointer = `spec.edges[${index}]`

    if (!byId.has(edge.from)) {
      diagnostics.push(
        error("PIPELINE_EDGE_UNKNOWN_NODE", `Edge starts at unknown node "${edge.from}".`, { file, pointer: `${pointer}.from` }),
      )
    }
    if (!byId.has(edge.to)) {
      diagnostics.push(
        error("PIPELINE_EDGE_UNKNOWN_NODE", `Edge points to unknown node "${edge.to}".`, { file, pointer: `${pointer}.to` }),
      )
    }

    const key = `${edge.from}->${edge.to}:${edge.when}`
    if (edgeKeys.has(key)) {
      diagnostics.push(
        warning("PIPELINE_EDGE_DUPLICATE", `Duplicate edge from "${edge.from}" to "${edge.to}".`, {
          file,
          pointer,
        }),
      )
    }
    edgeKeys.add(key)

    if (edge.from === edge.to && !edge.maxIterations) {
      diagnostics.push(
        error("PIPELINE_LOOP_UNCAPPED", `Self-loop on "${edge.from}" must set maxIterations.`, {
          file,
          pointer: `${pointer}.maxIterations`,
        }),
      )
    }

    if (backEdges.has(edge) && !edge.maxIterations) {
      diagnostics.push(
        error("PIPELINE_LOOP_UNCAPPED", `Edge "${edge.from}" → "${edge.to}" creates a loop without a maxIterations cap.`, {
          file,
          pointer: `${pointer}.maxIterations`,
          hint: "Loops must be bounded so the runtime cannot spin forever.",
        }),
      )
    }

    const parsed = parseCondition(edge.when)
    if (!parsed.ok) {
      diagnostics.push(
        error("PIPELINE_CONDITION_INVALID", `Invalid condition: ${parsed.error.message}`, {
          file,
          pointer: `${pointer}.when`,
          hint: "Use comparisons such as `test.status == \"passed\"`.",
        }),
      )
    } else {
      for (const root of collectRootNodes(parsed.ast)) {
        if (!byId.has(root)) {
          diagnostics.push(
            error("PIPELINE_CONDITION_UNKNOWN_NODE", `Condition references unknown node "${root}".`, {
              file,
              pointer: `${pointer}.when`,
              hint: `Conditions may only read outputs of: ${[...byId.keys()].join(", ")}`,
            }),
          )
        }
      }
    }
  })

  const reachable = reachableFromEntry(graph)
  pipeline.spec.nodes.forEach((node, index) => {
    if (!reachable.has(node.id)) {
      diagnostics.push(
        warning("PIPELINE_NODE_UNREACHABLE", `Node "${node.id}" cannot be reached from the entry node.`, {
          file,
          pointer: `spec.nodes[${index}]`,
        }),
      )
    }
  })

  const terminals = pipeline.spec.nodes.filter((node) => (graph.outgoing.get(node.id) ?? []).length === 0)
  if (terminals.length === 0) {
    diagnostics.push(
      error("PIPELINE_NO_TERMINAL", "The pipeline has no terminal node.", {
        file,
        pointer: "spec.nodes",
        hint: "Add a node with no outgoing edges, such as a documentation or release step.",
      }),
    )
  }

  // Two unconditional edges leaving the same node make routing ambiguous.
  for (const node of pipeline.spec.nodes) {
    const outgoing = graph.outgoing.get(node.id) ?? []
    const unconditional = outgoing.filter((edge) => {
      const parsed = parseCondition(edge.when)
      return parsed.ok && parsed.ast.type === "literal" && parsed.ast.value === true
    })
    if (unconditional.length > 1) {
      diagnostics.push(
        warning("PIPELINE_AMBIGUOUS_ROUTING", `Node "${node.id}" has ${unconditional.length} unconditional outgoing edges.`, {
          file,
          pointer: `spec.nodes`,
          hint: "Give each branch a distinct condition so routing is deterministic.",
        }),
      )
    }
  }

  const stageOrder = graph.order.map((node) => node.id)
  if (stageOrder.length > 0) {
    diagnostics.push(
      info("PIPELINE_ORDER", `Forward stage order: ${stageOrder.join(" → ")}`, { file }),
    )
  }

  return diagnostics
}

export function describeCondition(edge: PipelineEdge): string {
  const parsed = parseCondition(edge.when)
  if (!parsed.ok) return edge.when
  if (parsed.ast.type === "literal" && parsed.ast.value === true) return "always"
  return formatExpr(parsed.ast)
}

export function toMermaid(pipeline: PipelineDoc): string {
  const ids = new Map<string, string>()
  pipeline.spec.nodes.forEach((node, index) => ids.set(node.id, `n${index}`))

  const lines = ["flowchart TD"]
  for (const node of pipeline.spec.nodes) {
    lines.push(`  ${ids.get(node.id)}["${escapeLabel(node.id)}<br/><small>${escapeLabel(node.agent)}</small>"]`)
  }
  for (const edge of pipeline.spec.edges) {
    const from = ids.get(edge.from)
    const to = ids.get(edge.to)
    if (!from || !to) continue
    const label = edge.label ?? describeCondition(edge)
    const cap = edge.maxIterations ? ` (max ${edge.maxIterations})` : ""
    lines.push(`  ${from} -->|"${escapeLabel(label)}${cap}"| ${to}`)
  }
  return `${lines.join("\n")}\n`
}

function escapeLabel(input: string): string {
  return input.replace(/"/g, "&quot;").replace(/\|/g, "&#124;")
}
