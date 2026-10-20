import { applyEdits, modify, parse as parseJsonc, type ParseError } from "jsonc-parser"
import YAML from "yaml"
import { error, warning, type Diagnostic } from "../diagnostics"
import { managedBlock, upsertManagedBlock } from "../fs/managed"
import { readTextIfExists } from "../fs/paths"
import type { ResolvedAgent, ResolvedPack } from "../resolve/resolve"
import type { IntegrationDoc, PermissionAction, PipelineDoc } from "../spec/schema"
import { isEnvPlaceholder, isSecretKey } from "../spec/secrets"
import { makeChange, manifestFilesFor } from "./changes"
import {
  pickContext,
  pickPipeline,
  referencedIntegrations,
  renderAgentsMarkdown,
  renderOrchestratorBody,
  truncate,
} from "./shared"
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

function renderOrchestrator(
  pack: ResolvedPack,
  pipeline: PipelineDoc,
  file: string | undefined,
  integrations: string[],
): { contents: string; notes: string[] } {
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

  const rendered = renderOrchestratorBody(pack, pipeline)
  notes.push(...rendered.notes)
  if (file) notes.push(`Orchestrator generated from ${file}.`)

  return {
    contents: `---\n${YAML.stringify(frontmatter, { lineWidth: 0 }).trimEnd()}\n---\n\n${rendered.body}\n`,
    notes,
  }
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

export { renderAgentFile, renderOrchestrator, mergeConfig }
