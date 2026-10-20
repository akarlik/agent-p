import { error, type Diagnostic } from "../diagnostics"
import { buildGraph, describeCondition, reachableFromEntry } from "../graph/graph"
import { managedBlock, upsertManagedBlock } from "../fs/managed"
import { readTextIfExists } from "../fs/paths"
import type { ResolvedContext, ResolvedPack } from "../resolve/resolve"
import type { PipelineDoc } from "../spec/schema"

export function truncate(input: string, max: number): string {
  return input.length <= max ? input : `${input.slice(0, max - 1)}…`
}

export function escapeTableCell(input: string): string {
  return input.replace(/\|/g, "\\|").replace(/\n/g, " ")
}

export function pickPipeline(pack: ResolvedPack): { pipeline?: PipelineDoc; diagnostic?: Diagnostic } {
  const name = pack.pack.spec.defaultPipeline ?? [...pack.pipelines.keys()][0]
  if (!name) {
    return {
      diagnostic: error("EXPORT_NO_PIPELINE", "The pack has no pipeline to compile.", {
        hint: "Add .agentp/pipeline/<name>.yaml or run `agentp init`.",
      }),
    }
  }
  const entry = pack.pipelines.get(name)
  if (!entry) {
    return {
      diagnostic: error("EXPORT_PIPELINE_MISSING", `Pipeline "${name}" is not defined.`, {
        hint: "Fix spec.defaultPipeline or add the pipeline file.",
      }),
    }
  }
  return { pipeline: entry.doc }
}

export function pickContext(pack: ResolvedPack): ResolvedContext | undefined {
  const name = pack.pack.spec.defaultContext ?? [...pack.contexts.keys()][0]
  return name ? pack.contexts.get(name) : undefined
}

export function referencedIntegrations(pack: ResolvedPack, includeAll: boolean): string[] {
  if (includeAll) return [...pack.integrations.keys()].sort()
  const used = new Set<string>()
  for (const agent of pack.agents.values()) {
    for (const name of agent.doc.spec.tools.mcp) {
      if (name === "*") return [...pack.integrations.keys()].sort()
      used.add(name)
    }
  }
  return [...used].filter((name) => pack.integrations.has(name)).sort()
}

/** The context body written into AGENTS.md (OpenCode) and CLAUDE.md (Claude Code). */
export function renderAgentsMarkdown(
  pack: ResolvedPack,
  pipeline: PipelineDoc | undefined,
  context: ResolvedContext | undefined,
): string {
  const lines: string[] = []
  lines.push("## Agent P context")
  lines.push("")
  lines.push(`**${pack.pack.metadata.name}** — ${pack.pack.metadata.description}`)
  lines.push("")

  if (context) {
    const commands = Object.entries(context.doc.spec.commands)
    if (commands.length > 0) {
      lines.push("### Commands")
      lines.push("")
      lines.push("| Task | Command |")
      lines.push("| --- | --- |")
      for (const [task, command] of commands) {
        lines.push(`| ${task} | \`${command}\` |`)
      }
      lines.push("")
    }

    if (context.doc.spec.conventions) {
      lines.push("### Conventions")
      lines.push("")
      lines.push(context.doc.spec.conventions.trim())
      lines.push("")
    }

    if (context.doc.spec.definitionOfDone) {
      lines.push("### Definition of done")
      lines.push("")
      lines.push(context.doc.spec.definitionOfDone.trim())
      lines.push("")
    }

    if (context.doc.spec.files.length > 0) {
      lines.push("### Context files")
      lines.push("")
      for (const file of context.doc.spec.files) lines.push(`- \`${file}\``)
      lines.push("")
    }
  }

  lines.push("### Agents")
  lines.push("")
  lines.push("| Agent | Purpose | Writes |")
  lines.push("| --- | --- | --- |")
  for (const agent of [...pack.agents.values()].sort((a, b) => a.id.localeCompare(b.id))) {
    const writes = pipeline
      ? pipeline.spec.nodes
          .filter((node) => node.agent === agent.id)
          .flatMap((node) => node.outputs)
          .filter((value, index, arr) => arr.indexOf(value) === index)
      : []
    lines.push(
      `| \`${agent.id}\` | ${escapeTableCell(agent.doc.metadata.description)} | ${writes.length > 0 ? writes.map((w) => `\`${w}\``).join(", ") : "—"} |`,
    )
  }
  lines.push("")

  if (pipeline) {
    const graph = buildGraph(pipeline)
    lines.push(`### Pipeline: ${pipeline.metadata.name}`)
    lines.push("")
    lines.push(graph.order.map((node) => `\`${node.id}\``).join(" → "))
    lines.push("")
    lines.push(pipeline.metadata.description)
    lines.push("")
  }

  return lines.join("\n").trim()
}

export type ContextFileOptions = {
  root: string
  /** Repo-relative path the runtime reads: AGENTS.md, CLAUDE.md, ... */
  path: string
  pack: ResolvedPack
  pipeline?: PipelineDoc
  context?: ResolvedContext
}

/**
 * Renders the project context file, preserving anything the user wrote outside the
 * managed block. Shared by every target that reads a repo-level instruction file.
 */
export async function renderContextFile(options: ContextFileOptions): Promise<string> {
  const body = renderAgentsMarkdown(options.pack, options.pipeline, options.context)
  const existing = await readTextIfExists(`${options.root}/${options.path}`)
  if (existing === null || existing.trim().length === 0) {
    return `# ${options.pack.pack.metadata.name}\n\n${managedBlock("context", body)}\n`
  }
  return upsertManagedBlock(existing, "context", body)
}

export type OrchestratorBodyOptions = {  /** Overrides the paragraph that explains how work is delegated. */
  delegation?: string
  /** Extra paragraph inserted after the opening, e.g. the request placeholder. */
  invocation?: string
}

/**
 * The runtime-neutral half of an orchestrator prompt: stages, routing rules, the handoff
 * contract, loop caps, and completion criteria. Runtimes differ only in how the body is
 * wrapped (frontmatter, file name) and how delegation is phrased.
 */
export function renderOrchestratorBody(
  pack: ResolvedPack,
  pipeline: PipelineDoc,
  options: OrchestratorBodyOptions = {},
): { body: string; notes: string[] } {
  const graph = buildGraph(pipeline)
  const notes: string[] = []
  const lines: string[] = []

  lines.push(
    `You are the orchestrator for the "${pipeline.metadata.name}" pipeline in the "${pack.pack.metadata.name}" project.`,
  )
  lines.push("")
  if (options.invocation) {
    lines.push(options.invocation)
    lines.push("")
  }
  lines.push(
    options.delegation ??
      "You do not implement work yourself. Delegate every stage to the named subagent, pass it the artifacts it needs, and route based on the report it returns.",
  )
  lines.push("")
  lines.push("## Stages")
  lines.push("")

  const terminal = pipeline.spec.nodes.filter((node) => (graph.outgoing.get(node.id) ?? []).length === 0)
  const reachable = reachableFromEntry(graph)
  let step = 1
  for (const node of graph.order) {
    if (!reachable.has(node.id)) continue
    const agent = pack.agents.get(node.agent)
    lines.push(`${step}. \`${node.id}\` → subagent \`${node.agent}\``)
    if (agent) lines.push(`   Purpose: ${agent.doc.metadata.description}`)
    if (node.outputs.length > 0) {
      lines.push(`   Artifacts: ${node.outputs.map((output) => `\`${output}\``).join(", ")}`)
    }
    lines.push("")
    step += 1
  }

  lines.push("## Routing")
  lines.push("")
  lines.push(
    "Evaluate conditions against the stage report, keyed by node id. For example, `test.status` means the `status` field reported by the `test` stage.",
  )
  lines.push("")
  for (const node of graph.order) {
    const outgoing = graph.outgoing.get(node.id) ?? []
    if (outgoing.length === 0) continue
    lines.push(`- \`${node.id}\`:`)
    for (const edge of outgoing) {
      const condition = describeCondition(edge)
      const cap = edge.maxIterations ? ` (max ${edge.maxIterations} times)` : ""
      const label = condition === "always" ? "always" : `if \`${condition}\``
      lines.push(`  - ${label} → \`${edge.to}\`${cap}`)
    }
  }
  lines.push("")

  lines.push("## Handoff contract")
  lines.push("")
  lines.push("1. Invoke exactly one stage at a time.")
  lines.push("2. Before invoking a stage, read every artifact it needs from earlier stages.")
  lines.push("3. Require the subagent to finish with a report in this shape:")
  lines.push("   - `status`: `success` or `failed`")
  lines.push("   - `artifacts`: the files it wrote")
  lines.push("   - `summary`: two or three sentences")
  lines.push("   - `verdict`: `approved` or `changes_requested` when the stage is a review")
  lines.push("4. Route using the reported fields. Do not guess a field that was not reported.")
  lines.push("5. Never invent an artifact name and never skip a stage.")
  lines.push("")

  const loops = pipeline.spec.edges.filter((edge) => edge.maxIterations !== undefined)
  lines.push("## Loops and failure policy")
  lines.push("")
  if (loops.length > 0) {
    for (const edge of loops) {
      lines.push(`- \`${edge.from}\` → \`${edge.to}\` may repeat at most **${edge.maxIterations}** times.`)
    }
  } else {
    lines.push("- This pipeline has no loops.")
  }
  lines.push(
    `- If a stage fails and no failure route matches, **${pipeline.spec.defaults.onFailure === "stop" ? "stop and report the failure" : "continue along the best available route and record the failure"}**.`,
  )
  lines.push("")

  lines.push("## Completion")
  lines.push("")
  if (terminal.length > 0) {
    lines.push(`Finish at ${terminal.map((node) => `\`${node.id}\``).join(" or ")}.`)
  }
  lines.push(
    "When the pipeline completes, summarize what changed, list the artifacts that exist, and call out anything that still needs a human decision.",
  )

  if (loops.length > 0) {
    notes.push(`Compiled ${loops.length} bounded loop(s) into orchestrator instructions.`)
  }
  const omitted = pipeline.spec.nodes.filter((node) => !reachable.has(node.id))
  if (omitted.length > 0) {
    notes.push(`Skipped unreachable node(s) in the orchestrator prompt: ${omitted.map((n) => n.id).join(", ")}.`)
  }

  return { body: lines.join("\n").trim(), notes }
}
