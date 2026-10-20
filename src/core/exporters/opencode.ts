import { applyEdits, modify, parse as parseJsonc, type ParseError } from "jsonc-parser"
import YAML from "yaml"
import { error, warning, type Diagnostic } from "../diagnostics"
import { managedBlock, upsertManagedBlock } from "../fs/managed"
import { readTextIfExists } from "../fs/paths"
import { buildGraph, describeCondition, reachableFromEntry } from "../graph/graph"
import type { ResolvedAgent, ResolvedContext, ResolvedPack } from "../resolve/resolve"
import type {
  IntegrationDoc,
  PermissionAction,
  PipelineDoc,
} from "../spec/schema"
import { isEnvPlaceholder, isSecretKey } from "../spec/secrets"
import { makeChange, manifestFilesFor } from "./changes"
import type { ExportOptions, ExportPlan, Exporter, FileChange } from "./types"

const TARGET = "opencode"
const CONFIG_SCHEMA = "https://opencode.ai/config.json"

const PERMISSION_KEYS = [
  "read",
  "edit",
  "glob",
  "grep",
  "list",
  "bash",
  "task",
  "external_directory",
  "webfetch",
  "websearch",
  "lsp",
  "skill",
  "question",
] as const

const READ_ONLY_KEYS = new Set(["read", "glob", "grep", "list", "external_directory", "webfetch", "websearch", "lsp", "skill", "question"])

function mapPermissionKey(tool: string): string | null {
  if (tool === "write" || tool === "apply_patch" || tool === "edit") return "edit"
  return (PERMISSION_KEYS as readonly string[]).includes(tool) ? tool : null
}

function defaultAction(key: string): PermissionAction {
  return key === "edit" || key === "bash" || key === "task" ? "ask" : "allow"
}

function buildPermissions(
  agent: ResolvedAgent,
  integrations: string[],
): Record<string, PermissionAction | Record<string, PermissionAction>> {
  const builtin = new Set(agent.doc.spec.tools.builtin)
  const permission: Record<string, PermissionAction | Record<string, PermissionAction>> = {}

  for (const key of PERMISSION_KEYS) {
    const controlling = key === "edit" ? ["write", "edit", "apply_patch"] : [key]
    const enabled = controlling.some((tool) => builtin.has(tool))
    permission[key] = enabled ? defaultAction(key) : "deny"
  }

  for (const [tool, rule] of Object.entries(agent.doc.spec.tools.permissions)) {
    const key = mapPermissionKey(tool)
    if (!key) continue
    const controlling = key === "edit" ? ["write", "edit", "apply_patch"] : [key]
    if (!controlling.some((candidate) => builtin.has(candidate))) continue
    permission[key] = rule
  }

  for (const name of integrations) {
    const allowed = agent.doc.spec.tools.mcp.includes("*") || agent.doc.spec.tools.mcp.includes(name)
    permission[`${name}_*`] = allowed ? "allow" : "deny"
  }

  return permission
}

function renderAgentFile(agent: ResolvedAgent, integrations: string[]): string {
  const frontmatter: Record<string, unknown> = {
    description: agent.doc.metadata.description,
    mode: "subagent",
  }

  const model = agent.doc.spec.model
  if (model) {
    frontmatter.model = `${model.provider}/${model.id}`
    if (model.temperature !== undefined) frontmatter.temperature = model.temperature
    if (model.reasoningEffort) frontmatter.reasoningEffort = model.reasoningEffort
  }

  frontmatter.permission = buildPermissions(agent, integrations)
  if (agent.doc.spec.limits?.maxTurns) frontmatter.steps = agent.doc.spec.limits.maxTurns

  return `---\n${YAML.stringify(frontmatter, { lineWidth: 0 }).trimEnd()}\n---\n\n${agent.prompt.trim()}\n`
}

function mostCommonModel(pack: ResolvedPack): string | undefined {
  const counts = new Map<string, number>()
  for (const agent of pack.agents.values()) {
    const model = agent.doc.spec.model
    if (!model) continue
    const key = `${model.provider}/${model.id}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  let best: string | undefined
  let bestCount = 0
  for (const [key, count] of counts) {
    if (count > bestCount) {
      best = key
      bestCount = count
    }
  }
  return best
}

function truncate(input: string, max: number): string {
  return input.length <= max ? input : `${input.slice(0, max - 1)}…`
}

function pickPipeline(pack: ResolvedPack): { pipeline?: PipelineDoc; diagnostic?: Diagnostic } {
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

function pickContext(pack: ResolvedPack): ResolvedContext | undefined {
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

function renderOrchestrator(
  pack: ResolvedPack,
  pipeline: PipelineDoc,
  file: string | undefined,
  integrations: string[],
): { contents: string; notes: string[] } {
  const graph = buildGraph(pipeline)
  const notes: string[] = []
  const taskAgents = new Set<string>()

  for (const node of pipeline.spec.nodes) {
    taskAgents.add(node.agent)
    const agent = pack.agents.get(node.agent)
    for (const handoff of agent?.doc.spec.handoffs ?? []) {
      if (pack.agents.has(handoff)) taskAgents.add(handoff)
    }
  }

  const permission: Record<string, unknown> = {
    read: "allow",
    glob: "allow",
    grep: "allow",
    list: "allow",
    edit: "deny",
    bash: "deny",
    webfetch: "deny",
    websearch: "deny",
    task: { "*": "deny", ...Object.fromEntries([...taskAgents].sort().map((name) => [name, "allow"])) },
  }
  for (const name of integrations) {
    permission[`${name}_*`] = "deny"
  }

  const model = mostCommonModel(pack)
  const frontmatter: Record<string, unknown> = {
    description: truncate(
      `Runs the ${pipeline.metadata.name} pipeline: ${pipeline.metadata.description}`,
      240,
    ),
    mode: "primary",
    color: "accent",
  }
  if (model) frontmatter.model = model
  frontmatter.permission = permission

  const lines: string[] = []
  lines.push(
    `You are the orchestrator for the "${pipeline.metadata.name}" pipeline in the "${pack.pack.metadata.name}" project.`,
  )
  lines.push("")
  lines.push(
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

  const contents = `---\n${YAML.stringify(frontmatter, { lineWidth: 0 }).trimEnd()}\n---\n\n${lines.join("\n").trim()}\n`

  if (loops.length > 0) {
    notes.push(`Compiled ${loops.length} bounded loop(s) into orchestrator instructions.`)
  }
  if (pipeline.spec.nodes.length > 0) {
    const omitted = pipeline.spec.nodes.filter((node) => !reachable.has(node.id))
    if (omitted.length > 0) {
      notes.push(`Skipped unreachable node(s) in the orchestrator prompt: ${omitted.map((n) => n.id).join(", ")}.`)
    }
  }
  if (file) notes.push(`Orchestrator generated from ${file}.`)

  return { contents, notes }
}

function renderAgentsMarkdown(
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

function escapeTableCell(input: string): string {
  return input.replace(/\|/g, "\\|").replace(/\n/g, " ")
}

function integrationEntry(doc: IntegrationDoc): Record<string, unknown> {
  const auth = doc.spec.auth

  if (doc.spec.transport === "remote") {
    const entry: Record<string, unknown> = {
      type: "remote",
      url: doc.spec.url,
      enabled: true,
    }
    if (auth?.kind === "oauth2") entry.oauth = {}
    if (auth?.kind === "bearer" && auth.env) {
      entry.headers = { Authorization: `Bearer {env:${auth.env}}` }
    }
    if (auth?.kind === "apiKey" && auth.env) {
      entry.headers = { [auth.header ?? "Authorization"]: `{env:${auth.env}}` }
    }
    if (auth?.kind === "basic" && auth.env) {
      entry.headers = { Authorization: `Basic {env:${auth.env}}` }
    }
    return entry
  }

  const entry: Record<string, unknown> = {
    type: "local",
    command: doc.spec.command,
    enabled: true,
  }
  const environment: Record<string, string> = { ...doc.spec.environment }
  for (const [key, value] of Object.entries(environment)) {
    if (isSecretKey(key) && !isEnvPlaceholder(value)) {
      environment[key] = `{env:${key}}`
    }
  }
  if (auth?.env) environment[auth.env] = `{env:${auth.env}}`
  if (Object.keys(environment).length > 0) entry.environment = environment
  return entry
}

type ConfigResult = {
  path: string
  before: string
  after: string
  diagnostics: Diagnostic[]
}

async function existingMcpServers(root: string): Promise<string[]> {
  const text =
    (await readTextIfExists(`${root}/opencode.jsonc`)) ?? (await readTextIfExists(`${root}/opencode.json`))
  if (!text || text.trim().length === 0) return []

  const errors: ParseError[] = []
  const parsed = parseJsonc(text, errors, { allowTrailingComma: true, disallowComments: false })
  if (errors.length > 0 || parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return []

  const mcp = (parsed as Record<string, unknown>).mcp
  if (mcp === null || typeof mcp !== "object" || Array.isArray(mcp)) return []

  return Object.keys(mcp as Record<string, unknown>)
}

async function mergeConfig(pack: ResolvedPack, names: string[]): Promise<ConfigResult | null> {
  const jsoncPath = "opencode.jsonc"
  const jsonPath = "opencode.json"
  const existingJsonc = await readTextIfExists(`${pack.root}/${jsoncPath}`)
  const existingJson = await readTextIfExists(`${pack.root}/${jsonPath}`)

  const path = existingJsonc !== null ? jsoncPath : jsonPath
  const before = existingJsonc ?? existingJson ?? ""
  const diagnostics: Diagnostic[] = []

  const entries: [string, Record<string, unknown>][] = []
  for (const name of names) {
    const integration = pack.integrations.get(name)
    if (!integration) continue
    if (integration.doc.spec.auth?.secretRef && !integration.doc.spec.auth.env) {
      diagnostics.push(
        warning(
          "EXPORT_INTEGRATION_ENV_MISSING",
          `Integration "${name}" has a secretRef but no env var; the exported config cannot reference the key.`,
          { pointer: "spec.auth.env", hint: "Set auth.env so exports can write an environment placeholder." },
        ),
      )
    }
    entries.push([name, integrationEntry(integration.doc)])
  }

  if (entries.length === 0 && before.trim().length === 0) return null

  const parseErrors: ParseError[] = []
  const parsed = before.trim().length > 0 ? parseJsonc(before, parseErrors, { allowTrailingComma: true, disallowComments: false }) : {}
  if (parseErrors.length > 0) {
    diagnostics.push(
      error("EXPORT_CONFIG_INVALID", `Could not parse ${path}; leaving it untouched.`, {
        file: path,
        hint: parseErrors.map((e) => `offset ${e.offset}: ${e.error}`).join("; "),
      }),
    )
    return { path, before, after: before, diagnostics }
  }
  if (parsed !== null && typeof parsed !== "object") {
    diagnostics.push(error("EXPORT_CONFIG_INVALID", `${path} must contain a JSON object.`, { file: path }))
    return { path, before, after: before, diagnostics }
  }

  let text = before.trim().length > 0 ? before : "{}\n"
  const formatting = { formattingOptions: { insertSpaces: true, tabSize: 2 } }

  if ((parsed as Record<string, unknown> | null)?.$schema === undefined) {
    text = applyEdits(text, modify(text, ["$schema"], CONFIG_SCHEMA, formatting))
  }

  for (const [name, entry] of entries) {
    text = applyEdits(text, modify(text, ["mcp", name], entry, formatting))
  }

  return { path, before, after: text, diagnostics }
}

export const opencodeExporter: Exporter = {
  id: "opencode",
  label: "OpenCode",
  capabilities: {
    subagents: true,
    orchestrator: true,
    mcp: true,
    perToolPermissions: true,
    perAgentMcp: true,
    commands: false,
    skills: false,
  },

  async plan(pack: ResolvedPack, options: ExportOptions = {}): Promise<ExportPlan> {
    const diagnostics: Diagnostic[] = []
    const notes: string[] = []
    const changes: FileChange[] = []
    const manifestFiles = await manifestFilesFor(pack.root, TARGET)

    const picked = pickPipeline(pack)
    if (picked.diagnostic) diagnostics.push(picked.diagnostic)
    const pipeline = picked.pipeline

    const context = pickContext(pack)
    const integrations = referencedIntegrations(pack, options.includeUnusedIntegrations ?? false)
    // Every server the runtime can see is denied by default, including ones the user added
    // to opencode.json by hand. Declaring an integration in the pack is what grants access.
    const configuredIntegrations = await existingMcpServers(pack.root)
    const allIntegrations = [...new Set([...pack.integrations.keys(), ...configuredIntegrations])].sort()

    const undeclared = configuredIntegrations.filter((name) => !pack.integrations.has(name))
    if (undeclared.length > 0) {
      notes.push(
        `Denied MCP servers that exist in opencode.json but are not declared in the pack: ${undeclared.join(", ")}.`,
      )
    }

    if (integrations.length > 0) {
      notes.push(`MCP servers exported: ${integrations.join(", ")}.`)
      notes.push("OpenCode loads MCP tools globally; Agent P scopes them with per-agent permission globs.")
    }

    for (const agent of [...pack.agents.values()].sort((a, b) => a.id.localeCompare(b.id))) {
      const path = `.opencode/agents/${agent.id}.md`
      const contents = renderAgentFile(agent, allIntegrations)
      changes.push(
        await makeChange({
          root: pack.root,
          path,
          contents,
          kind: "agent",
          target: TARGET,
          manifestFiles,
        }),
      )

      if (agent.doc.spec.tools.builtin.includes("apply_patch")) {
        notes.push(`Agent "${agent.id}" uses apply_patch; OpenCode maps it to the edit permission.`)
      }
      if (agent.doc.spec.model?.maxOutputTokens) {
        notes.push(`Agent "${agent.id}" sets maxOutputTokens, which OpenCode does not accept per agent; it was omitted.`)
      }
    }

    if (pipeline) {
      const orchestratorName = `${pipeline.metadata.name}-orchestrator`
      if (pack.agents.has(orchestratorName)) {
        diagnostics.push(
          error("EXPORT_ORCHESTRATOR_COLLISION", `An agent already uses the name "${orchestratorName}".`, {
            hint: "Rename the agent or the pipeline so the generated orchestrator has a unique name.",
          }),
        )
      } else {
        const file = pack.pipelines.get(pipeline.metadata.name)?.sources.at(-1)?.path
        const rendered = renderOrchestrator(pack, pipeline, file, allIntegrations)
        notes.push(...rendered.notes)
        const path = `.opencode/agents/${orchestratorName}.md`
        changes.push(
          await makeChange({
            root: pack.root,
            path,
            contents: rendered.contents,
            kind: "orchestrator",
            target: TARGET,
            manifestFiles,
          }),
        )
      }
    }

    const contextBody = renderAgentsMarkdown(pack, pipeline, context)
    const existingAgentsMd = await readTextIfExists(`${pack.root}/AGENTS.md`)
    const agentsMd =
      existingAgentsMd === null || existingAgentsMd.trim().length === 0
        ? `# ${pack.pack.metadata.name}\n\n${managedBlock("context", contextBody)}\n`
        : upsertManagedBlock(existingAgentsMd, "context", contextBody)

    changes.push(
      await makeChange({
        root: pack.root,
        path: "AGENTS.md",
        contents: agentsMd,
        kind: "context",
        target: TARGET,
        manifestFiles,
      }),
    )

    const config = await mergeConfig(pack, integrations)
    if (config) {
      diagnostics.push(...config.diagnostics)
      changes.push(
        await makeChange({
          root: pack.root,
          path: config.path,
          contents: config.after,
          kind: "config",
          target: TARGET,
          manifestFiles,
        }),
      )
    }

    return {
      target: TARGET,
      root: pack.root,
      changes,
      notes: [...new Set(notes)],
      diagnostics,
    }
  },
}

export { renderAgentFile, renderAgentsMarkdown, renderOrchestrator, mergeConfig }
