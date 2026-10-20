import { applyEdits, modify, parse as parseJsonc, type ParseError } from "jsonc-parser"
import YAML from "yaml"
import { error, warning, type Diagnostic } from "../diagnostics"
import { readTextIfExists } from "../fs/paths"
import type { ResolvedAgent, ResolvedPack } from "../resolve/resolve"
import type { IntegrationDoc, ModelRef, PipelineDoc } from "../spec/schema"
import { isEnvPlaceholder, isSecretKey } from "../spec/secrets"
import { makeChange, manifestFilesFor } from "./changes"
import {
  pickContext,
  pickPipeline,
  referencedIntegrations,
  renderContextFile,
  renderOrchestratorBody,
  truncate,
} from "./shared"
import type { ExportOptions, ExportPlan, Exporter, FileChange } from "./types"

const TARGET = "claude-code"

/**
 * Neutral tool -> Claude Code tool. Tools without an entry have no per-subagent
 * equivalent (question, external_directory) and are reported instead of mapped.
 */
export const CLAUDE_TOOL_MAP: Record<string, string> = {
  read: "Read",
  write: "Write",
  edit: "Edit",
  apply_patch: "Edit",
  bash: "Bash",
  grep: "Grep",
  glob: "Glob",
  list: "Glob",
  webfetch: "WebFetch",
  websearch: "WebSearch",
  task: "Agent",
  skill: "Skill",
  lsp: "LSP",
}

const TOOL_ORDER = [
  "Read",
  "Write",
  "Edit",
  "Glob",
  "Grep",
  "Bash",
  "WebFetch",
  "WebSearch",
  "LSP",
  "Skill",
  "Agent",
]

const COLORS = ["blue", "green", "yellow", "purple", "orange", "pink", "cyan", "red"]

function placeholder(name: string): string {
  return `\${${name}}`
}

function colorFor(id: string): string {
  let hash = 0
  for (let index = 0; index < id.length; index += 1) {
    hash = (hash * 31 + id.charCodeAt(index)) % 100000
  }
  return COLORS[hash % COLORS.length] ?? "blue"
}

export type ModelMapping = { model?: string; degrade?: string }

/**
 * Maps a neutral model reference to a Claude Code `model` value: an alias when the
 * family is known, a full id for unrecognized Claude models, and `inherit` otherwise.
 */
export function mapModelId(model: ModelRef | undefined, modelMap: Record<string, string> = {}): ModelMapping {
  if (!model) return {}

  const mapped = modelMap[`${model.provider}/${model.id}`] ?? modelMap[model.id]
  if (mapped) return { model: mapped }

  const provider = model.provider.toLowerCase()
  const id = model.id.toLowerCase()
  const hosted =
    provider === "anthropic" || provider === "bedrock" || provider === "vertex" || provider === "vertex-ai"

  if (id.includes("opus")) return { model: "opus" }
  if (id.includes("sonnet")) return { model: "sonnet" }
  if (id.includes("haiku")) return { model: "haiku" }
  if (id.includes("fable")) return { model: "fable" }
  if (hosted && id.startsWith("claude")) return { model: model.id }

  if (!hosted) {
    return {
      model: "inherit",
      degrade: `provider "${model.provider}" is not Anthropic; Claude Code subagents run Anthropic models, so "${model.id}" falls back to inherit`,
    }
  }
  return {
    model: "inherit",
    degrade: `model "${model.id}" is not a recognized Claude model; it falls back to inherit`,
  }
}

export type ToolResolution = {
  tools: string[]
  unmapped: string[]
  pathScopedEdit: boolean
  commandScopedBash: boolean
  delegates: boolean
  widensListing: boolean
}

/**
 * Resolves the neutral tool grant into a Claude Code `tools` allowlist. MCP access is
 * granted with `mcp__<server>__*` entries, which makes the allowlist the scoping
 * mechanism: a server that is not listed is not reachable by the subagent.
 */
export function resolveTools(agent: ResolvedAgent, integrationNames: string[]): ToolResolution {
  const enabled = new Set<string>()
  const unmapped: string[] = []
  const permissions = agent.doc.spec.tools.permissions
  let pathScopedEdit = false
  let commandScopedBash = false
  let delegates = false
  let widensListing = false

  for (const tool of agent.doc.spec.tools.builtin) {
    const rule = permissions[tool]
    if (rule === "deny") continue
    const isRecord = rule !== undefined && typeof rule === "object"

    if (isRecord && (tool === "edit" || tool === "write" || tool === "apply_patch")) pathScopedEdit = true
    if (isRecord && tool === "bash") commandScopedBash = true
    if (tool === "task") delegates = true
    if (tool === "list") widensListing = true

    const mapped = CLAUDE_TOOL_MAP[tool]
    if (mapped) enabled.add(mapped)
    else unmapped.push(tool)
  }

  const requested = agent.doc.spec.tools.mcp
  const servers = requested.includes("*") ? integrationNames : integrationNames.filter((name) => requested.includes(name))
  for (const name of servers) enabled.add(`mcp__${name}__*`)

  const tools = [
    ...TOOL_ORDER.filter((name) => enabled.has(name)),
    ...[...enabled].filter((name) => name.startsWith("mcp__")).sort(),
  ]

  return { tools, unmapped, pathScopedEdit, commandScopedBash, delegates, widensListing }
}

type RenderResult = { contents: string; diagnostics: Diagnostic[]; notes: string[] }

function renderAgent(
  agent: ResolvedAgent,
  integrationNames: string[],
  modelMap: Record<string, string>,
  file: string | undefined,
): RenderResult {
  const diagnostics: Diagnostic[] = []
  const notes: string[] = []
  const resolution = resolveTools(agent, integrationNames)

  const frontmatter: Record<string, unknown> = {
    name: agent.id,
    description: agent.doc.metadata.description,
  }

  if (resolution.tools.length > 0) {
    frontmatter.tools = resolution.tools.join(", ")
  } else {
    diagnostics.push(
      warning(
        "EXPORT_CLAUDE_NO_TOOLS",
        `Agent "${agent.id}" grants no tool that Claude Code recognizes; omitting \`tools\` lets it inherit every subagent tool.`,
        { target: TARGET, file, pointer: "spec.tools.builtin", hint: "Add at least one supported tool, or accept the wider grant." },
      ),
    )
  }

  const mapping = mapModelId(agent.doc.spec.model, modelMap)
  if (mapping.model) frontmatter.model = mapping.model
  if (mapping.degrade) {
    diagnostics.push(
      warning("EXPORT_CLAUDE_MODEL", `Agent "${agent.id}": ${mapping.degrade}.`, {
        target: TARGET,
        file,
        pointer: "spec.model",
        hint: "Add a mapping under spec.export.modelMap in pack.yaml to choose the model explicitly.",
      }),
    )
  }

  if (agent.doc.spec.model?.reasoningEffort) frontmatter.effort = agent.doc.spec.model.reasoningEffort
  if (agent.doc.spec.limits?.maxTurns) frontmatter.maxTurns = agent.doc.spec.limits.maxTurns
  frontmatter.color = colorFor(agent.id)

  if (resolution.pathScopedEdit) {
    diagnostics.push(
      warning(
        "EXPORT_CLAUDE_PATH_SCOPED_EDIT",
        `Agent "${agent.id}" scopes edit permissions by path; Claude Code grants Edit and Write for the whole project.`,
        {
          target: TARGET,
          file,
          pointer: "spec.tools.permissions",
          hint: "Add a path deny rule in .claude/settings.json; permission rules are session-wide, not per subagent.",
        },
      ),
    )
  }
  if (resolution.commandScopedBash) {
    diagnostics.push(
      warning(
        "EXPORT_CLAUDE_COMMAND_SCOPED_BASH",
        `Agent "${agent.id}" scopes bash permissions by command; Claude Code cannot scope Bash commands per subagent.`,
        {
          target: TARGET,
          file,
          pointer: "spec.tools.permissions",
          hint: "Add Bash deny rules in .claude/settings.json; they apply to the whole session.",
        },
      ),
    )
  }
  if (resolution.unmapped.length > 0) {
    notes.push(
      `Agent "${agent.id}" lists tools with no Claude Code equivalent: ${resolution.unmapped.join(", ")}.`,
    )
  }
  if (resolution.widensListing) {
    notes.push(`Agent "${agent.id}" lists \`list\`, which maps to Glob on Claude Code.`)
  }
  if (resolution.delegates) {
    notes.push(`Agent "${agent.id}" lists \`task\`, which maps to Agent; Claude Code limits subagent nesting depth.`)
  }
  if (agent.doc.spec.model?.temperature !== undefined) {
    notes.push(`Agent "${agent.id}" sets a temperature; Claude Code subagents have no temperature field, so it was omitted.`)
  }
  if (agent.doc.spec.model?.maxOutputTokens) {
    notes.push(`Agent "${agent.id}" sets maxOutputTokens; Claude Code subagents have no equivalent, so it was omitted.`)
  }

  return {
    contents: `---\n${YAML.stringify(frontmatter, { lineWidth: 0 }).trimEnd()}\n---\n\n${agent.prompt.trim()}\n`,
    diagnostics,
    notes,
  }
}

function mostCommonAlias(pack: ResolvedPack, modelMap: Record<string, string>): string | undefined {
  const counts = new Map<string, number>()
  for (const agent of pack.agents.values()) {
    const mapping = mapModelId(agent.doc.spec.model, modelMap)
    if (!mapping.model) continue
    counts.set(mapping.model, (counts.get(mapping.model) ?? 0) + 1)
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

/**
 * The pipeline is compiled into a slash command that runs in the main thread, because
 * Claude Code has no primary-agent file that can spawn subagents by name.
 */
function renderCommand(pack: ResolvedPack, pipeline: PipelineDoc, modelMap: Record<string, string>): RenderResult {
  const rendered = renderOrchestratorBody(pack, pipeline, {
    invocation:
      "The request that invoked this command is available as `$ARGUMENTS`. Treat it as the pipeline input; if it is empty, ask the user what to build before starting.",
    delegation:
      "You run in the main thread. Delegate each stage to its subagent with the Agent tool, passing the subagent name as `subagent_type` and the artifacts it needs, then route on the report it returns. Do not implement work yourself.",
  })

  const frontmatter: Record<string, unknown> = {
    description: truncate(`Run the ${pipeline.metadata.name} pipeline: ${pipeline.metadata.description}`, 240),
    "argument-hint": "<feature request or issue>",
    "allowed-tools": "Agent Read Grep Glob",
    "disable-model-invocation": true,
  }
  const model = mostCommonAlias(pack, modelMap)
  if (model) frontmatter.model = model

  return {
    contents: `---\n${YAML.stringify(frontmatter, { lineWidth: 0 }).trimEnd()}\n---\n\n${rendered.body}\n`,
    diagnostics: [],
    notes: rendered.notes,
  }
}

function integrationEntry(doc: IntegrationDoc): Record<string, unknown> {
  const auth = doc.spec.auth

  if (doc.spec.transport === "remote") {
    const entry: Record<string, unknown> = { type: "http", url: doc.spec.url }
    // oauth2 needs no header: Claude Code runs the OAuth flow from /mcp.
    if (auth?.kind === "bearer" && auth.env) {
      entry.headers = { Authorization: `Bearer ${placeholder(auth.env)}` }
    }
    if (auth?.kind === "apiKey" && auth.env) {
      entry.headers = { [auth.header ?? "Authorization"]: placeholder(auth.env) }
    }
    if (auth?.kind === "basic" && auth.env) {
      entry.headers = { Authorization: `Basic ${placeholder(auth.env)}` }
    }
    return entry
  }

  const command = doc.spec.command ?? []
  const entry: Record<string, unknown> = { command: command[0], args: command.slice(1) }

  const environment: Record<string, string> = { ...doc.spec.environment }
  for (const [key, value] of Object.entries(environment)) {
    if (isSecretKey(key) && !isEnvPlaceholder(value)) environment[key] = placeholder(key)
  }
  if (auth?.env) environment[auth.env] = placeholder(auth.env)
  if (Object.keys(environment).length > 0) entry.env = environment

  return entry
}

type McpConfigResult = {
  path: string
  before: string
  after: string
  diagnostics: Diagnostic[]
  notes: string[]
}

async function mergeMcpConfig(pack: ResolvedPack, names: string[]): Promise<McpConfigResult | null> {
  const path = ".mcp.json"
  const before = (await readTextIfExists(`${pack.root}/${path}`)) ?? ""
  const diagnostics: Diagnostic[] = []
  const notes: string[] = []

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
  const parsed =
    before.trim().length > 0
      ? parseJsonc(before, parseErrors, { allowTrailingComma: true, disallowComments: false })
      : {}
  if (parseErrors.length > 0) {
    diagnostics.push(
      error("EXPORT_CONFIG_INVALID", `Could not parse ${path}; leaving it untouched.`, {
        file: path,
        hint: parseErrors.map((e) => `offset ${e.offset}: ${e.error}`).join("; "),
      }),
    )
    return { path, before, after: before, diagnostics, notes }
  }
  if (parsed !== null && (typeof parsed !== "object" || Array.isArray(parsed))) {
    diagnostics.push(error("EXPORT_CONFIG_INVALID", `${path} must contain a JSON object.`, { file: path }))
    return { path, before, after: before, diagnostics, notes }
  }

  const existingServers =
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? ((parsed as Record<string, unknown>).mcpServers as Record<string, unknown> | undefined)
      : undefined
  const existingNames = existingServers && typeof existingServers === "object" ? Object.keys(existingServers) : []

  let text = before.trim().length > 0 ? before : "{}\n"
  const formatting = { formattingOptions: { insertSpaces: true, tabSize: 2 } }

  for (const [name, entry] of entries) {
    text = applyEdits(text, modify(text, ["mcpServers", name], entry, formatting))
    if (existingNames.includes(name)) notes.push(`Updated the existing MCP server "${name}" in ${path}.`)
  }

  return { path, before, after: text, diagnostics, notes }
}

export const claudeCodeExporter: Exporter = {
  id: "claude-code",
  label: "Claude Code",
  capabilities: {
    subagents: true,
    orchestrator: true,
    mcp: true,
    perToolPermissions: true,
    perAgentMcp: true,
    commands: true,
    skills: true,
  },

  async plan(pack: ResolvedPack, options: ExportOptions = {}): Promise<ExportPlan> {
    const diagnostics: Diagnostic[] = []
    const notes: string[] = []
    const changes: FileChange[] = []
    const manifestFiles = await manifestFilesFor(pack.root, TARGET)
    const modelMap = pack.pack.spec.export?.modelMap ?? {}

    const picked = pickPipeline(pack)
    if (picked.diagnostic) diagnostics.push(picked.diagnostic)
    const pipeline = picked.pipeline
    const context = pickContext(pack)
    const integrations = referencedIntegrations(pack, options.includeUnusedIntegrations ?? false)
    const integrationNames = [...pack.integrations.keys()].sort()

    for (const agent of [...pack.agents.values()].sort((a, b) => a.id.localeCompare(b.id))) {
      const file = agent.sources.at(-1)?.path
      const rendered = renderAgent(agent, integrationNames, modelMap, file)
      diagnostics.push(...rendered.diagnostics)
      notes.push(...rendered.notes)

      changes.push(
        await makeChange({
          root: pack.root,
          path: `.claude/agents/${agent.id}.md`,
          contents: rendered.contents,
          kind: "agent",
          target: TARGET,
          manifestFiles,
        }),
      )
    }

    if (pipeline) {
      const commandName = pipeline.metadata.name
      if (pack.agents.has(commandName)) {
        notes.push(
          `The pipeline "${commandName}" shares a name with a subagent; commands and subagents use separate namespaces, so /${commandName} still works.`,
        )
      }
      const rendered = renderCommand(pack, pipeline, modelMap)
      notes.push(...rendered.notes)
      const file = pack.pipelines.get(commandName)?.sources.at(-1)?.path
      if (file) notes.push(`Command generated from ${file}.`)

      changes.push(
        await makeChange({
          root: pack.root,
          path: `.claude/commands/${commandName}.md`,
          contents: rendered.contents,
          kind: "orchestrator",
          target: TARGET,
          manifestFiles,
        }),
      )
    }

    const claudeMd = await renderContextFile({ root: pack.root, path: "CLAUDE.md", pack, pipeline, context })

    changes.push(
      await makeChange({
        root: pack.root,
        path: "CLAUDE.md",
        contents: claudeMd,
        kind: "context",
        target: TARGET,
        manifestFiles,
      }),
    )

    if (integrations.length > 0) {
      notes.push(`MCP servers exported: ${integrations.join(", ")}.`)
      notes.push("Claude Code scopes MCP tools per subagent through the tools allowlist.")
      notes.push("Servers added to .mcp.json need a one-time approval the next time you start Claude Code.")
    }

    const config = await mergeMcpConfig(pack, integrations)
    if (config) {
      diagnostics.push(...config.diagnostics)
      notes.push(...config.notes)
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
