import { basename } from "node:path"
import { countBySeverity, type Diagnostic } from "../core/diagnostics"
import { availableTargets } from "../core/exporters"
import type { ExportPlan, ExportTargetId, FileChange } from "../core/exporters/types"
import { buildGraph, describeCondition, toMermaid } from "../core/graph/graph"
import { renderAgentsMarkdown } from "../core/exporters/shared"
import type {
  ResolvedAgent,
  ResolvedIntegration,
  ResolvedPack,
  ResolvedPipeline,
} from "../core/resolve/resolve"
import { resolvePack } from "../core/resolve/resolve"
import { validatePack } from "../core/validate/validate"
import { isSecretKey } from "../core/spec/secrets"
import type { PermissionAction } from "../core/spec/schema"
import { severityColor, theme, actionColor } from "./theme"
import { type Line, wrapText } from "./text"

export type TuiData = {
  root: string
  pack: ResolvedPack
  diagnostics: Diagnostic[]
  targets: ExportTargetId[]
}

export type SectionId = "overview" | "agents" | "pipeline" | "integrations" | "context" | "export"

export const SECTIONS: { id: SectionId; label: string; key: string }[] = [
  { id: "overview", label: "Overview", key: "1" },
  { id: "agents", label: "Agents", key: "2" },
  { id: "pipeline", label: "Pipeline", key: "3" },
  { id: "integrations", label: "Integrations", key: "4" },
  { id: "context", label: "Context", key: "5" },
  { id: "export", label: "Export", key: "6" },
]

export const TARGET_LABELS: Record<ExportTargetId, string> = {
  opencode: "OpenCode",
  "claude-code": "Claude Code",
  codex: "Codex CLI",
}

export async function loadTuiData(root: string, globalDir: string): Promise<TuiData> {
  const pack = await resolvePack({ root, globalDir })
  const configured = pack.pack.spec.export?.targets ?? []
  const targets = configured.length > 0 ? configured : availableTargets()
  // Target-specific findings live in each export plan; the overview reports
  // pack-level problems only.
  const diagnostics = validatePack(pack)
  return { root, pack, diagnostics, targets }
}

/* -------------------------------------------------------------------------- */
/* Document builder                                                           */
/* -------------------------------------------------------------------------- */

class Doc {
  readonly lines: Line[] = []

  push(text = "", extra: Omit<Line, "text"> = {}): void {
    this.lines.push({ text, ...extra })
  }

  blank(): void {
    if (this.lines.length > 0 && this.lines[this.lines.length - 1]?.text !== "") this.push("")
  }

  heading(text: string): void {
    this.blank()
    this.push(text, { bold: true, fg: theme.accent })
  }

  sub(text: string): void {
    this.blank()
    this.push(text, { bold: true })
  }

  kv(label: string, value: string, width: number): void {
    const prefix = `  ${label.padEnd(12)} `
    const wrapped = wrapText(value, Math.max(8, width - prefix.length))
    this.push(`${prefix}${wrapped[0] ?? ""}`)
    for (const rest of wrapped.slice(1)) this.push(" ".repeat(prefix.length) + rest)
  }

  para(text: string, width: number, indent = 2): void {
    for (const line of wrapText(text, Math.max(8, width - indent))) {
      this.push(`${" ".repeat(indent)}${line}`)
    }
  }

  bullets(items: string[], width: number): void {
    for (const item of items) {
      const wrapped = wrapText(item, Math.max(8, width - 4))
      this.push(`  • ${wrapped[0] ?? ""}`)
      for (const rest of wrapped.slice(1)) this.push(`    ${rest}`)
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Shared pieces                                                              */
/* -------------------------------------------------------------------------- */

export function diagnosticLines(
  diagnostics: Diagnostic[],
  width: number,
  options: { limit?: number } = {},
): Line[] {
  const doc = new Doc()
  const limit = options.limit ?? diagnostics.length

  for (const diagnostic of diagnostics.slice(0, limit)) {
    const where = diagnostic.file ? ` · ${basename(diagnostic.file)}` : ""
    doc.push(`  ${diagnostic.severity.toUpperCase().padEnd(7)} ${diagnostic.code}${where}`, {
      fg: severityColor(diagnostic.severity),
    })
    for (const line of wrapText(diagnostic.message, Math.max(8, width - 6))) {
      doc.push(`        ${line}`)
    }
    if (diagnostic.pointer) doc.push(`        at ${diagnostic.pointer}`, { dim: true, fg: theme.dim })
    if (diagnostic.hint) {
      for (const line of wrapText(`hint: ${diagnostic.hint}`, Math.max(8, width - 8))) {
        doc.push(`        ${line}`, { fg: theme.dim })
      }
    }
  }

  if (diagnostics.length > limit) {
    doc.push(`  … ${diagnostics.length - limit} more`, { fg: theme.dim })
  }

  return doc.lines
}

export function diagnosticCounts(diagnostics: Diagnostic[]): string {
  const counts = countBySeverity(diagnostics)
  const parts: string[] = []
  if (counts.error > 0) parts.push(`${counts.error} error${counts.error === 1 ? "" : "s"}`)
  if (counts.warning > 0) parts.push(`${counts.warning} warning${counts.warning === 1 ? "" : "s"}`)
  if (counts.info > 0) parts.push(`${counts.info} info`)
  return parts.length > 0 ? parts.join(" · ") : "no issues"
}

function describePermission(rule: PermissionAction | Record<string, PermissionAction>): string {
  if (typeof rule === "string") return rule
  const entries = Object.entries(rule)
  if (entries.length === 0) return "empty rule"
  return `${entries.length} pattern${entries.length === 1 ? "" : "s"}`
}

function describeSources(sources: { path: string; scope: string }[] | undefined): string {
  if (!sources || sources.length === 0) return "—"
  return sources.map((source) => `${source.path} (${source.scope})`).join(", ")
}

export function pipelineOf(pack: ResolvedPack): ResolvedPipeline | undefined {
  const name = pack.pack.spec.defaultPipeline ?? [...pack.pipelines.keys()][0]
  return name ? pack.pipelines.get(name) : undefined
}

/* -------------------------------------------------------------------------- */
/* Overview                                                                   */
/* -------------------------------------------------------------------------- */

export function overviewLines(data: TuiData, width: number): Line[] {
  const doc = new Doc()
  const { pack } = data
  const pipeline = pipelineOf(pack)

  doc.heading("Pack")
  doc.kv("Name", pack.pack.metadata.name, width)
  doc.kv("Version", pack.pack.metadata.version, width)
  doc.kv("Description", pack.pack.metadata.description, width)
  doc.kv("Root", data.root, width)
  doc.kv("Pipeline", pipeline?.id ?? "—", width)

  doc.heading("Team")
  doc.kv("Agents", String(pack.agents.size), width)
  doc.kv("Pipelines", String(pack.pipelines.size), width)
  doc.kv("Contexts", String(pack.contexts.size), width)
  doc.kv("Integrations", String(pack.integrations.size), width)
  doc.kv("Providers", String(pack.providers.size), width)

  doc.heading("Validation")
  doc.push(`  ${diagnosticCounts(data.diagnostics)}`)
  if (data.diagnostics.length > 0) {
    doc.blank()
    for (const line of diagnosticLines(data.diagnostics, width, { limit: 4 })) doc.push(line.text, line)
  } else {
    doc.push("  ✓ The pack is valid.", { fg: theme.green })
  }

  doc.heading("Export targets")
  doc.bullets(data.targets.map((target) => `${TARGET_LABELS[target]} (${target})`), width)

  doc.heading("Keys")
  doc.bullets(
    [
      "1–6 or ↑/↓ switch section · tab switch pane · enter open",
      "r reload the pack · ? help · q quit",
      "In Export: [ ] target · ↑/↓ file · w write · f force",
    ],
    width,
  )

  return doc.lines
}

/* -------------------------------------------------------------------------- */
/* Agents                                                                     */
/* -------------------------------------------------------------------------- */

export type Row = { id: string; label?: string; detail: string; fg?: string }

export function agentRows(pack: ResolvedPack): Row[] {
  return [...pack.agents.values()]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((agent) => ({
      id: agent.id,
      detail: agent.doc.spec.model?.id ?? "inherited model",
    }))
}

export function agentAt(pack: ResolvedPack, index: number): ResolvedAgent | undefined {
  return [...pack.agents.values()].sort((a, b) => a.id.localeCompare(b.id))[index]
}

export function agentDetailLines(agent: ResolvedAgent, width: number): Line[] {
  const doc = new Doc()
  const model = agent.doc.spec.model
  const tools = agent.doc.spec.tools

  doc.push(agent.id, { bold: true })
  doc.para(agent.doc.metadata.description, width, 0)

  doc.heading("Configuration")
  doc.kv("Model", model ? `${model.provider} / ${model.id}` : "inherited", width)
  if (model?.reasoningEffort) doc.kv("Reasoning", model.reasoningEffort, width)
  if (model?.temperature !== undefined) doc.kv("Temperature", String(model.temperature), width)
  if (model?.maxOutputTokens) doc.kv("Max output", String(model.maxOutputTokens), width)
  if (agent.doc.spec.limits?.maxTurns) doc.kv("Max turns", String(agent.doc.spec.limits.maxTurns), width)
  doc.kv("Source", describeSources(agent.sources), width)

  doc.heading("Tools")
  doc.kv("Builtin", tools.builtin.length > 0 ? tools.builtin.join(", ") : "none", width)
  doc.kv("MCP", tools.mcp.length > 0 ? tools.mcp.join(", ") : "none", width)

  const permissions = Object.entries(tools.permissions)
  if (permissions.length > 0) {
    doc.blank()
    doc.push("  Permissions", { bold: true })
    for (const [tool, rule] of permissions) {
      doc.push(`    ${tool}: ${describePermission(rule)}`)
      if (typeof rule === "object") {
        for (const [pattern, action] of Object.entries(rule)) {
          const color = action === "deny" ? theme.red : action === "ask" ? theme.yellow : theme.green
          doc.push(`      ${pattern} → ${action}`, { fg: color })
        }
      }
    }
  }

  if (agent.doc.spec.handoffs.length > 0) {
    doc.heading("Handoffs")
    doc.para(agent.doc.spec.handoffs.join(", "), width)
  }

  doc.heading("Prompt")
  doc.para(agent.prompt, width)

  return doc.lines
}

/* -------------------------------------------------------------------------- */
/* Pipeline                                                                   */
/* -------------------------------------------------------------------------- */

export function pipelineRows(pipeline: ResolvedPipeline | undefined): Row[] {
  if (!pipeline) return []
  const graph = buildGraph(pipeline.doc)
  const ordered = [...graph.order]
  for (const node of pipeline.doc.spec.nodes) {
    if (!ordered.some((entry) => entry.id === node.id)) ordered.push(node)
  }
  return ordered.map((node) => ({ id: node.id, detail: node.agent }))
}

export function pipelineDetailLines(
  pipeline: ResolvedPipeline | undefined,
  selected: number,
  width: number,
): Line[] {
  const doc = new Doc()
  if (!pipeline) {
    doc.push("No pipeline defined.", { fg: theme.yellow })
    doc.para("Add .agentp/pipeline/<name>.yaml, or run `agentp init`.", width)
    return doc.lines
  }

  const graph = buildGraph(pipeline.doc)
  const rows = pipelineRows(pipeline)
  const selectedRow = rows[clampCursor(selected, rows.length)]
  const node = selectedRow ? graph.byId.get(selectedRow.id) : undefined

  doc.push(pipeline.id, { bold: true })
  doc.para(pipeline.doc.metadata.description, width, 0)
  doc.blank()
  doc.push(
    `  entry ${pipeline.doc.spec.entry} · ${pipeline.doc.spec.nodes.length} stages · ` +
      `${pipeline.doc.spec.edges.length} edges · ${graph.backEdges.size} loops`,
    { fg: theme.dim },
  )

  if (node) {
    doc.heading(`Stage · ${node.id}`)
    doc.kv("Agent", node.agent, width)
    doc.kv("Outputs", node.outputs.length > 0 ? node.outputs.join(", ") : "none", width)
    if (node.notes) doc.kv("Notes", node.notes, width)

    const incoming = graph.incoming.get(node.id) ?? []
    const outgoing = graph.outgoing.get(node.id) ?? []
    doc.blank()
    doc.push("  Incoming", { bold: true })
    if (incoming.length === 0) doc.push("    (entry stage)")
    for (const edge of incoming) {
      const loop = graph.backEdges.has(edge) ? " ↺" : ""
      doc.push(`    ${edge.from} → ${node.id}  ${describeCondition(edge)}${loop}`, {
        fg: graph.backEdges.has(edge) ? theme.yellow : undefined,
      })
    }
    doc.blank()
    doc.push("  Outgoing", { bold: true })
    if (outgoing.length === 0) doc.push("    (terminal stage)")
    for (const edge of outgoing) {
      const loop = graph.backEdges.has(edge) ? " ↺" : ""
      const cap = edge.maxIterations ? ` (max ${edge.maxIterations})` : ""
      doc.push(`    ${node.id} → ${edge.to}  ${describeCondition(edge)}${cap}${loop}`, {
        fg: graph.backEdges.has(edge) ? theme.yellow : undefined,
      })
    }
  }

  doc.heading("Flow")
  for (const row of rows) {
    const stage = graph.byId.get(row.id)
    if (!stage) continue
    const marker = row.id === pipeline.doc.spec.entry ? "◆" : "•"
    doc.push(`  ${marker} ${stage.id}  (${stage.agent})`, {
      bold: row.id === pipeline.doc.spec.entry,
    })
    for (const edge of graph.outgoing.get(stage.id) ?? []) {
      const loop = graph.backEdges.has(edge) ? " ↺" : ""
      const cap = edge.maxIterations ? ` (max ${edge.maxIterations})` : ""
      doc.push(`      → ${edge.to}  ${describeCondition(edge)}${cap}${loop}`, {
        fg: graph.backEdges.has(edge) ? theme.yellow : theme.dim,
      })
    }
  }

  return doc.lines
}

export function pipelineMermaidLines(pipeline: ResolvedPipeline | undefined, width: number): Line[] {
  const doc = new Doc()
  if (!pipeline) return pipelineDetailLines(undefined, 0, width)
  doc.push(`${pipeline.id} · Mermaid`, { bold: true })
  doc.para("Press m to return to the stage view. Copy this into docs or a pull request.", width, 0)
  doc.blank()
  for (const line of toMermaid(pipeline.doc).trimEnd().split("\n")) {
    doc.push(`  ${line}`, { fg: theme.cyan })
  }
  return doc.lines
}

/* -------------------------------------------------------------------------- */
/* Integrations                                                               */
/* -------------------------------------------------------------------------- */

export function integrationRows(pack: ResolvedPack): Row[] {
  return [...pack.integrations.values()]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((integration) => ({
      id: integration.id,
      detail: integration.doc.spec.transport,
    }))
}

export function integrationAt(pack: ResolvedPack, index: number): ResolvedIntegration | undefined {
  return [...pack.integrations.values()].sort((a, b) => a.id.localeCompare(b.id))[index]
}

export function integrationDetailLines(
  integration: ResolvedIntegration,
  pack: ResolvedPack,
  width: number,
): Line[] {
  const doc = new Doc()
  const spec = integration.doc.spec
  const auth = spec.auth

  doc.push(integration.id, { bold: true })
  doc.para(integration.doc.metadata.description, width, 0)

  doc.heading("Connection")
  if (spec.transport === "remote") doc.kv("Transport", "remote (HTTP)", width)
  else doc.kv("Transport", "local (stdio)", width)
  if (spec.url) doc.kv("URL", spec.url, width)
  if (spec.command) doc.kv("Command", spec.command.join(" "), width)
  doc.kv("Source", describeSources(integration.sources), width)

  doc.heading("Auth")
  if (!auth || auth.kind === "none") {
    doc.push("  none")
  } else {
    doc.kv("Kind", auth.kind, width)
    if (auth.env) doc.kv("Env var", auth.env, width)
    if (auth.header) doc.kv("Header", auth.header, width)
    if (auth.secretRef) doc.kv("Secret ref", auth.secretRef, width)
  }

  if (spec.scopes.length > 0) {
    doc.heading("Scopes")
    doc.para(spec.scopes.join(", "), width)
  }
  if (spec.tools.length > 0) {
    doc.heading("Enabled tools")
    doc.para(spec.tools.join(", "), width)
  }

  const environment = Object.keys(spec.environment)
  if (environment.length > 0) {
    doc.heading("Environment")
    for (const key of environment) {
      if (isSecretKey(key)) {
        doc.push(`  ${key}`, { fg: theme.dim })
        doc.push("    value is passed through by name; nothing is written to the export", {
          fg: theme.dim,
        })
      } else {
        doc.push(`  ${key} = ${spec.environment[key] ?? ""}`)
      }
    }
  }

  doc.heading("Used by")
  const users = [...pack.agents.values()]
    .filter((agent) => {
      const mcp = agent.doc.spec.tools.mcp
      return mcp.includes("*") || mcp.includes(integration.id)
    })
    .map((agent) => agent.id)
    .sort()
  if (users.length === 0) doc.push("  no agent grants this server", { fg: theme.yellow })
  else doc.bullets(users, width)

  return doc.lines
}

/* -------------------------------------------------------------------------- */
/* Context                                                                    */
/* -------------------------------------------------------------------------- */

export function contextLines(pack: ResolvedPack, width: number): Line[] {
  const doc = new Doc()
  const name = pack.pack.spec.defaultContext ?? [...pack.contexts.keys()][0]
  const context = name ? pack.contexts.get(name) : undefined
  const pipeline = pipelineOf(pack)

  doc.push(context?.id ?? "No context", { bold: true })
  if (context) {
    doc.para(context.doc.metadata.description ?? "", width, 0)
    doc.blank()
    doc.push(`  Source ${describeSources(context.sources)}`, { fg: theme.dim })
  }

  doc.heading("Rendered instructions")
  doc.para(
    "This is the managed block Agent P writes into AGENTS.md (OpenCode, Codex) or CLAUDE.md (Claude Code).",
    width,
  )
  doc.blank()

  const rendered = renderAgentsMarkdown(pack, pipeline?.doc, context)
  for (const line of rendered.split("\n")) {
    if (line.startsWith("## ")) doc.push(line, { bold: true, fg: theme.accent })
    else if (line.startsWith("- ")) doc.push(`  ${line}`)
    else doc.push(line)
  }

  return doc.lines
}

/* -------------------------------------------------------------------------- */
/* Export                                                                     */
/* -------------------------------------------------------------------------- */

export function exportSummaryLines(plan: ExportPlan): Line[] {
  const doc = new Doc()
  const create = plan.changes.filter((change) => change.action === "create").length
  const update = plan.changes.filter((change) => change.action === "update").length
  const unchanged = plan.changes.filter((change) => change.action === "unchanged").length
  const drifted = plan.changes.filter((change) => change.drifted).length

  doc.push(
    `  ${create} create · ${update} update · ${unchanged} unchanged` +
      (drifted > 0 ? ` · ${drifted} edited since export` : ""),
    { fg: drifted > 0 ? theme.red : undefined },
  )

  if (plan.diagnostics.length > 0) {
    const errors = plan.diagnostics.filter((entry) => entry.severity === "error").length
    const warnings = plan.diagnostics.filter((entry) => entry.severity === "warning").length
    const parts: string[] = []
    if (errors > 0) parts.push(`${errors} error${errors === 1 ? "" : "s"}`)
    if (warnings > 0) parts.push(`${warnings} warning${warnings === 1 ? "" : "s"}`)
    doc.push(`  Target checks: ${parts.join(" · ")} (after the diff)`, {
      fg: errors > 0 ? theme.red : theme.yellow,
    })
  }

  return doc.lines
}

/** Export-wide notes, shown after the diff so they never bury it. */
export function exportNoteLines(plan: ExportPlan, width: number): Line[] {
  const doc = new Doc()
  if (plan.notes.length === 0) return doc.lines
  doc.heading("Notes")
  doc.bullets(plan.notes, width)
  return doc.lines
}

/** Target-specific findings, shown after the diff so they never bury it. */
export function exportCheckLines(plan: ExportPlan, width: number): Line[] {
  const doc = new Doc()
  if (plan.diagnostics.length === 0) return doc.lines
  doc.heading(`Target checks · ${TARGET_LABELS[plan.target]}`)
  for (const line of diagnosticLines(plan.diagnostics, width)) doc.push(line.text, line)
  return doc.lines
}

export function exportRows(plan: ExportPlan | undefined): Row[] {
  if (!plan) return []
  return plan.changes.map((change) => ({
    id: change.path,
    label: basename(change.path),
    detail: change.drifted ? `${change.action} · edited` : change.action,
    fg: change.drifted ? theme.red : actionColor(change.action),
  }))
}

export function diffLines(change: FileChange | undefined, width: number): Line[] {
  const doc = new Doc()
  if (!change) {
    doc.push("No file selected.", { fg: theme.dim })
    return doc.lines
  }

  doc.push(change.path, { bold: true })
  doc.push(`  ${change.action} · ${change.kind}${change.drifted ? " · edited since last export" : ""}`, {
    fg: change.drifted ? theme.red : theme.dim,
  })
  doc.blank()

  if (!change.diff) {
    doc.push("  No changes.", { fg: theme.dim })
    return doc.lines
  }

  for (const line of change.diff.trimEnd().split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) doc.push(`  ${line}`, { bold: true })
    else if (line.startsWith("@@")) doc.push(`  ${line}`, { fg: theme.cyan })
    else if (line.startsWith("+")) doc.push(`  ${line}`, { fg: theme.green })
    else if (line.startsWith("-")) doc.push(`  ${line}`, { fg: theme.red })
    else doc.push(`  ${line}`, { fg: theme.dim })
  }

  return doc.lines
}

export function clampCursor(index: number, length: number): number {
  if (length <= 0) return 0
  return Math.max(0, Math.min(index, length - 1))
}
