import YAML from "yaml"
import { parse as parseToml } from "smol-toml"
import { error, info, warning, type Diagnostic } from "../diagnostics"
import { readTextIfExists } from "../fs/paths"
import type { ResolvedAgent, ResolvedPack } from "../resolve/resolve"
import { BUILTIN_TOOLS, type IntegrationDoc, type ModelRef, type PipelineDoc } from "../spec/schema"
import { isSecretKey } from "../spec/secrets"
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

const TARGET = "codex"
const CONFIG_PATH = ".codex/config.toml"
const REGION_ID = "codex"

const OPENAI_PROVIDERS = new Set(["openai", "azure", "azure-openai"])

/** Tools a Codex custom agent cannot withhold, and that carry real risk if inherited. */
const RISKY_TOOLS = new Set(["webfetch", "websearch", "task", "external_directory", "question", "skill", "lsp"])

/* -------------------------------------------------------------------------- */
/* TOML rendering                                                             */
/* -------------------------------------------------------------------------- */

function tomlString(value: string): string {
  // JSON string escaping is a subset of TOML basic-string escaping.
  return JSON.stringify(value)
}

function tomlKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : tomlString(key)
}

function tomlArray(values: string[]): string {
  return `[${values.map(tomlString).join(", ")}]`
}

function tomlInlineTable(entries: [string, string][]): string {
  return `{ ${entries.map(([key, value]) => `${tomlKey(key)} = ${tomlString(value)}`).join(", ")} }`
}

/**
 * Multiline literal strings keep backslashes exactly as written, which matters for
 * prompts containing regexes or Windows paths. Fall back to an escaped basic string
 * only when the prompt itself contains a triple quote.
 */
function tomlMultiline(value: string): string {
  const normalized = value.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim()
  if (!normalized.includes("'''")) return `'''\n${normalized}\n'''`
  const escaped = normalized.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
  return `"""\n${escaped}\n"""`
}

const REGION_PATTERN = /^# agentp:begin id=codex[^\n]*\n[\s\S]*?^# agentp:end id=codex[^\n]*\n?/m

function hasRegion(text: string): boolean {
  return /^# agentp:begin id=codex/m.test(text)
}

function stripRegion(text: string): string {
  return text.replace(REGION_PATTERN, "").replace(/^\n+/, "")
}

function upsertRegion(base: string, body: string): string {
  const trimmed = base.replace(/\s+$/, "")
  if (body.trim().length === 0) return trimmed.length > 0 ? `${trimmed}\n` : ""
  const region = `# agentp:begin id=${REGION_ID}\n${body.trim()}\n# agentp:end id=${REGION_ID}`
  return trimmed.length > 0 ? `${trimmed}\n\n${region}\n` : `${region}\n`
}

function isTable(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

/* -------------------------------------------------------------------------- */
/* Model and capability mapping                                               */
/* -------------------------------------------------------------------------- */

export type CodexModelMapping = { model?: string; effort?: string; degrade?: string }

/**
 * Codex custom agents can pick a model and reasoning effort, but not a provider:
 * the provider comes from the parent session. A non-OpenAI provider therefore
 * degrades to inheriting the parent model.
 */
export function mapModelId(model: ModelRef | undefined, modelMap: Record<string, string> = {}): CodexModelMapping {
  if (!model) return {}

  const effort = model.reasoningEffort
  const mapped = modelMap[`${model.provider}/${model.id}`] ?? modelMap[model.id]
  if (mapped) return { model: mapped, effort }

  const provider = model.provider.toLowerCase()
  if (!OPENAI_PROVIDERS.has(provider)) {
    return {
      effort,
      degrade: `provider "${model.provider}" is not an OpenAI provider, and a Codex custom agent inherits the session's provider`,
    }
  }
  return { model: model.id, effort }
}

export type CodexCapabilities = {
  shell: boolean
  readOnly: boolean
  /** Tools whose permission rule is path- or command-scoped, which Codex cannot express. */
  scoped: string[]
  /** Withheld tools Codex still exposes through the parent session. */
  unsafeWithheld: string[]
  delegates: boolean
}

export function resolveCapabilities(agent: ResolvedAgent): CodexCapabilities {
  const granted = new Set<string>()
  const scoped: string[] = []

  for (const tool of agent.doc.spec.tools.builtin) {
    const rule = agent.doc.spec.tools.permissions[tool]
    if (rule === "deny") continue
    if (rule !== undefined && typeof rule === "object") scoped.push(tool)
    granted.add(tool)
  }

  const readOnly = !granted.has("write") && !granted.has("edit") && !granted.has("apply_patch")
  // bash, edit, and write are handled separately: shell_tool disables bash, and a
  // read-only instruction covers edits. The rest are silently inherited.
  const handled = new Set(["bash", "write", "edit", "apply_patch"])
  const unsafeWithheld = BUILTIN_TOOLS.filter(
    (tool) => !granted.has(tool) && !handled.has(tool) && RISKY_TOOLS.has(tool),
  )

  return {
    shell: granted.has("bash"),
    readOnly,
    scoped,
    unsafeWithheld,
    delegates: granted.has("task"),
  }
}

/* -------------------------------------------------------------------------- */
/* Rendering                                                                  */
/* -------------------------------------------------------------------------- */

const READ_ONLY_NOTE =
  "## Read-only role\n\nDo not create or modify files. Report findings and proposed changes instead."

function renderAgent(agent: ResolvedAgent, modelMap: Record<string, string>): string {
  const capabilities = resolveCapabilities(agent)
  const mapping = mapModelId(agent.doc.spec.model, modelMap)

  const lines: string[] = []
  lines.push(`name = ${tomlString(agent.id)}`)
  lines.push(`description = ${tomlString(agent.doc.metadata.description)}`)
  if (mapping.model) lines.push(`model = ${tomlString(mapping.model)}`)
  if (mapping.effort) lines.push(`model_reasoning_effort = ${tomlString(mapping.effort)}`)

  const instructions = capabilities.readOnly ? `${agent.prompt.trim()}\n\n${READ_ONLY_NOTE}` : agent.prompt.trim()
  lines.push(`developer_instructions = ${tomlMultiline(instructions)}`)

  // A table header ends the current table, so features must come after the
  // scalar keys and the instructions string.
  if (!capabilities.shell) {
    lines.push("")
    lines.push("[features]")
    lines.push("shell_tool = false")
  }

  return `${lines.join("\n")}\n`
}

function renderSkill(pack: ResolvedPack, pipeline: PipelineDoc): { contents: string; notes: string[] } {
  const rendered = renderOrchestratorBody(pack, pipeline, {
    invocation:
      "This skill runs a multi-stage pipeline. The request that invoked it is the pipeline input; if it is empty, ask the user what to build before starting.",
    delegation:
      "You run in the main thread. For each stage, spawn the named custom agent (defined under `.codex/agents/`), give it the artifacts and context it needs, wait for its result, then route on the report it returns. Do not implement work yourself.",
  })

  const frontmatter = {
    name: pipeline.metadata.name,
    description: truncate(
      `Run the ${pipeline.metadata.name} pipeline: ${pipeline.metadata.description}`,
      240,
    ),
  }

  return {
    contents: `---\n${YAML.stringify(frontmatter, { lineWidth: 0 }).trimEnd()}\n---\n\n${rendered.body}\n`,
    notes: rendered.notes,
  }
}

function integrationToml(name: string, doc: IntegrationDoc, diagnostics: Diagnostic[]): string {
  const auth = doc.spec.auth
  const lines: string[] = [`[mcp_servers.${tomlKey(name)}]`]

  if (auth && (auth.kind === "bearer" || auth.kind === "apiKey" || auth.kind === "basic") && !auth.env) {
    diagnostics.push(
      warning(
        "EXPORT_CODEX_AUTH_MISSING_ENV",
        `Integration "${name}" uses ${auth.kind} auth without auth.env, so the exported server has no credential.`,
        {
          target: TARGET,
          pointer: "spec.auth.env",
          hint: "Set auth.env to the environment variable that holds the credential.",
        },
      ),
    )
  }
  if (auth && (auth.kind === "aws" || auth.kind === "gcp")) {
    diagnostics.push(
      info(
        "EXPORT_CODEX_AUTH_UNSUPPORTED",
        `Integration "${name}" uses ${auth.kind} auth, which Codex MCP servers do not model; no auth field was written.`,
        { target: TARGET, pointer: "spec.auth.kind" },
      ),
    )
  }

  if (doc.spec.transport === "remote") {
    lines.push(`url = ${tomlString(doc.spec.url ?? "")}`)
    // Codex reads the credential from the environment by name, so no placeholder
    // syntax is needed and no secret can end up in the file.
    if (auth?.kind === "bearer" && auth.env) {
      lines.push(`bearer_token_env_var = ${tomlString(auth.env)}`)
    } else if (auth?.kind === "apiKey" && auth.env) {
      lines.push(`env_http_headers = ${tomlInlineTable([[auth.header ?? "Authorization", auth.env]])}`)
    } else if (auth?.kind === "basic" && auth.env) {
      // The env var must contain the full header value, e.g. "Basic <base64>".
      lines.push(`env_http_headers = ${tomlInlineTable([["Authorization", auth.env]])}`)
    } else if (auth?.kind === "oauth2") {
      lines.push(`auth = "oauth"`)
    }
    if (doc.spec.scopes.length > 0) lines.push(`scopes = ${tomlArray(doc.spec.scopes)}`)
  } else {
    const [binary, ...args] = doc.spec.command ?? []
    if (binary) lines.push(`command = ${tomlString(binary)}`)
    if (args.length > 0) lines.push(`args = ${tomlArray(args)}`)

    const environment: [string, string][] = []
    const envVars: string[] = []
    for (const [key, value] of Object.entries(doc.spec.environment)) {
      // Secret-looking keys become a pass-through whitelist so the value never
      // has to be written into the config file.
      if (isSecretKey(key)) envVars.push(key)
      else environment.push([key, value])
    }
    if (auth?.env) envVars.push(auth.env)
    if (environment.length > 0) lines.push(`env = ${tomlInlineTable(environment)}`)
    if (envVars.length > 0) lines.push(`env_vars = ${tomlArray([...new Set(envVars)])}`)
  }

  if (doc.spec.tools.length > 0) lines.push(`enabled_tools = ${tomlArray(doc.spec.tools)}`)
  return lines.join("\n")
}

type ConfigResult = {
  path: string
  before: string
  after: string
  diagnostics: Diagnostic[]
  notes: string[]
}

async function mergeConfig(pack: ResolvedPack, names: string[]): Promise<ConfigResult | null> {
  const path = CONFIG_PATH
  const before = (await readTextIfExists(`${pack.root}/${path}`)) ?? ""
  const diagnostics: Diagnostic[] = []
  const notes: string[] = []

  // Only the text outside our managed region is the user's, so only that text can
  // conflict with the tables we are about to write.
  const base = stripRegion(before)
  let parsed: Record<string, unknown> = {}
  if (base.trim().length > 0) {
    try {
      parsed = parseToml(base) as Record<string, unknown>
    } catch (cause) {
      diagnostics.push(
        error("EXPORT_CONFIG_INVALID", `Could not parse ${path}; leaving it untouched.`, {
          target: TARGET,
          file: path,
          hint: cause instanceof Error ? cause.message.slice(0, 200) : String(cause),
        }),
      )
      return { path, before, after: before, diagnostics, notes }
    }
  }

  const existing = parsed.mcp_servers
  if (existing !== undefined && !isTable(existing)) {
    diagnostics.push(
      error("EXPORT_CONFIG_INVALID", `mcp_servers in ${path} must be a table.`, { target: TARGET, file: path }),
    )
    return { path, before, after: before, diagnostics, notes }
  }
  const existingNames = isTable(existing) ? Object.keys(existing) : []

  const blocks: string[] = []
  for (const name of names) {
    const integration = pack.integrations.get(name)
    if (!integration) continue
    if (existingNames.includes(name)) {
      diagnostics.push(
        warning(
          "EXPORT_CODEX_CONFIG_CONFLICT",
          `MCP server "${name}" is already defined in ${path}; the existing definition was left untouched.`,
          {
            target: TARGET,
            file: path,
            hint: "Remove the existing table, or rename the integration, to let Agent P manage it.",
          },
        ),
      )
      continue
    }
    notes.push(`Added MCP server "${name}" to ${path}.`)
    blocks.push(integrationToml(name, integration.doc, diagnostics))
  }

  if (blocks.length === 0 && !hasRegion(before)) return null

  const after = upsertRegion(base, blocks.join("\n\n"))
  return { path, before, after, diagnostics, notes }
}

/* -------------------------------------------------------------------------- */
/* Fidelity analysis                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Everything Codex cannot express, computed once so `agentp validate --target codex`
 * reports the same gaps that an export would.
 */
export function analyzeCodex(pack: ResolvedPack): { diagnostics: Diagnostic[]; notes: string[] } {
  const diagnostics: Diagnostic[] = []
  const notes: string[] = []
  const modelMap = pack.pack.spec.export?.modelMap ?? {}
  const declared = [...pack.integrations.keys()].sort()

  const mcpUnscoped: { id: string; servers: string[] }[] = []
  const toolsUnscoped: { id: string; tools: string[] }[] = []

  for (const agent of [...pack.agents.values()].sort((a, b) => a.id.localeCompare(b.id))) {
    const file = agent.sources.at(-1)?.path
    const capabilities = resolveCapabilities(agent)
    const mapping = mapModelId(agent.doc.spec.model, modelMap)

    if (mapping.degrade) {
      diagnostics.push(
        warning("EXPORT_CODEX_MODEL", `Agent "${agent.id}": ${mapping.degrade}.`, {
          target: TARGET,
          file,
          pointer: "spec.model",
          hint: "Map it under spec.export.modelMap in pack.yaml to choose a Codex model explicitly.",
        }),
      )
    }

    if (capabilities.readOnly) {
      diagnostics.push(
        info(
          "EXPORT_CODEX_READ_ONLY_INSTRUCTIONS",
          `Agent "${agent.id}" grants no write tools; the export adds a read-only instruction because Codex has no per-agent filesystem scope.`,
          { target: TARGET, file, pointer: "spec.tools.builtin" },
        ),
      )
    }

    if (capabilities.scoped.length > 0) {
      diagnostics.push(
        warning(
          "EXPORT_CODEX_PERMISSIONS_UNSCOPED",
          `Agent "${agent.id}" scopes ${capabilities.scoped.join(", ")} by path or command; Codex applies the parent session's sandbox and approval policy, so the rule is not enforced per agent.`,
          {
            target: TARGET,
            file,
            pointer: "spec.tools.permissions",
            hint: "Set sandbox_mode and approval_policy for the session, or run the agent in a narrower sandbox.",
          },
        ),
      )
    }

    if (capabilities.unsafeWithheld.length > 0) {
      toolsUnscoped.push({ id: agent.id, tools: capabilities.unsafeWithheld })
    }
    if (declared.length > 0) {
      const requested = agent.doc.spec.tools.mcp
      const extra = requested.includes("*") ? [] : declared.filter((name) => !requested.includes(name))
      if (extra.length > 0) mcpUnscoped.push({ id: agent.id, servers: extra })
    }

    if (agent.doc.spec.model?.temperature !== undefined) {
      notes.push(`Agent "${agent.id}" sets a temperature; Codex has no per-agent temperature, so it was omitted.`)
    }
    if (agent.doc.spec.model?.maxOutputTokens) {
      notes.push(`Agent "${agent.id}" sets maxOutputTokens; Codex has no per-agent output cap, so it was omitted.`)
    }
    if (agent.doc.spec.limits?.maxTurns) {
      notes.push(`Agent "${agent.id}" sets maxTurns; Codex has no turn cap for custom agents, so it was omitted.`)
    }
    if (capabilities.delegates) {
      notes.push(`Agent "${agent.id}" can delegate; Codex subagent nesting follows the session's multi-agent settings.`)
    }
  }

  if (toolsUnscoped.length > 0) {
    const sample = toolsUnscoped
      .slice(0, 4)
      .map((entry) => `${entry.id} (${entry.tools.join(", ")})`)
      .join("; ")
    const more = toolsUnscoped.length > 4 ? ` and ${toolsUnscoped.length - 4} more` : ""
    diagnostics.push(
      warning(
        "EXPORT_CODEX_TOOLS_UNSCOPED",
        `Codex custom agents inherit the parent's tools. Agents that withhold tools Codex cannot disable still have them: ${sample}${more}.`,
        {
          target: TARGET,
          hint: "Rely on the parent session's sandbox and approval policy, or keep sensitive tools out of the session.",
        },
      ),
    )
  }

  if (mcpUnscoped.length > 0) {
    const sample = mcpUnscoped
      .slice(0, 4)
      .map((entry) => `${entry.id} (${entry.servers.join(", ")})`)
      .join("; ")
    const more = mcpUnscoped.length > 4 ? ` and ${mcpUnscoped.length - 4} more` : ""
    diagnostics.push(
      warning(
        "EXPORT_CODEX_MCP_NOT_SCOPED",
        `Codex custom agents inherit every MCP server, so these agents will still see servers they were not granted: ${sample}${more}.`,
        {
          target: TARGET,
          hint: "Narrow a server for the whole session with mcp_servers.<id>.enabled_tools or disabled_tools.",
        },
      ),
    )
  }

  return { diagnostics, notes }
}

/* -------------------------------------------------------------------------- */
/* Exporter                                                                   */
/* -------------------------------------------------------------------------- */

export const codexExporter: Exporter = {
  id: "codex",
  label: "Codex CLI",
  capabilities: {
    subagents: true,
    orchestrator: true,
    mcp: true,
    perToolPermissions: false,
    perAgentMcp: false,
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

    const analysis = analyzeCodex(pack)
    diagnostics.push(...analysis.diagnostics)
    notes.push(...analysis.notes)

    for (const agent of [...pack.agents.values()].sort((a, b) => a.id.localeCompare(b.id))) {
      changes.push(
        await makeChange({
          root: pack.root,
          path: `.codex/agents/${agent.id}.toml`,
          contents: renderAgent(agent, modelMap),
          kind: "agent",
          target: TARGET,
          manifestFiles,
        }),
      )
    }

    if (pipeline) {
      const rendered = renderSkill(pack, pipeline)
      notes.push(...rendered.notes)
      const file = pack.pipelines.get(pipeline.metadata.name)?.sources.at(-1)?.path
      if (file) notes.push(`Skill generated from ${file}.`)

      changes.push(
        await makeChange({
          root: pack.root,
          path: `.agents/skills/${pipeline.metadata.name}/SKILL.md`,
          contents: rendered.contents,
          kind: "orchestrator",
          target: TARGET,
          manifestFiles,
        }),
      )
    }

    const agentsMd = await renderContextFile({ root: pack.root, path: "AGENTS.md", pack, pipeline, context })
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

    if (integrations.length > 0) {
      notes.push(`Codex reads project MCP servers from ${CONFIG_PATH}, and only when the project is trusted.`)
    }

    const config = await mergeConfig(pack, integrations)
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

export { CONFIG_PATH as CODEX_CONFIG_PATH }
