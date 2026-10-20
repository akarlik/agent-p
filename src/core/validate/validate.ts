import { existsSync } from "node:fs"
import { join } from "node:path"
import { BUILTIN_TOOLS, type IntegrationDoc, type ProviderDoc } from "../spec/schema"
import { isEnvPlaceholder, isSecretKey } from "../spec/secrets"
import { error, info, sortDiagnostics, warning, type Diagnostic } from "../diagnostics"
import type { ResolvedAgent, ResolvedPack } from "../resolve/resolve"
import { buildGraph, validateGraph } from "../graph/graph"
import { mapModelId, resolveTools } from "../exporters/claude-code"
import { analyzeCodex } from "../exporters/codex"
import { availableTargets } from "../exporters"

export type ValidateOptions = {
  targets?: string[]
  strict?: boolean
}

const BUILTIN = new Set<string>(BUILTIN_TOOLS)

export function hasBlocking(diagnostics: Diagnostic[], strict = false): boolean {
  return diagnostics.some((d) => d.severity === "error" || (strict && d.severity === "warning"))
}

export function validatePack(pack: ResolvedPack, options: ValidateOptions = {}): Diagnostic[] {
  const diagnostics: Diagnostic[] = [...pack.diagnostics]

  validatePackMeta(pack, diagnostics)
  for (const agent of pack.agents.values()) validateAgent(agent, pack, diagnostics)
  for (const pipeline of pack.pipelines.values()) {
    const graph = buildGraph(pipeline.doc)
    diagnostics.push(
      ...validateGraph(graph, {
        file: pipeline.sources.at(-1)?.path,
        agentExists: (name) => pack.agents.has(name),
      }),
    )
    validateArtifacts(pipeline.doc, pipeline.sources.at(-1)?.path, diagnostics)
  }
  for (const context of pack.contexts.values()) validateContext(context.doc, context.sources.at(-1)?.path, pack.root, diagnostics)
  for (const integration of pack.integrations.values())
    validateIntegration(integration.doc, integration.sources.at(-1)?.path, diagnostics)
  for (const provider of pack.providers.values()) validateProvider(provider.doc, provider.sources.at(-1)?.path, diagnostics)

  for (const target of options.targets ?? []) validateTarget(target, pack, diagnostics)

  return sortDiagnostics(diagnostics)
}

function validatePackMeta(pack: ResolvedPack, diagnostics: Diagnostic[]): void {
  const file = join(pack.root, ".agentp", "pack.yaml")

  if (pack.pipelines.size === 0) {
    diagnostics.push(
      error("PACK_NO_PIPELINE", "The pack does not define a pipeline.", {
        file,
        hint: "Add .agentp/pipeline/<name>.yaml or run `agentp init`.",
      }),
    )
  }

  if (pack.agents.size === 0) {
    diagnostics.push(error("PACK_NO_AGENTS", "The pack does not define any agents.", { file }))
  }

  const defaultPipeline = pack.pack.spec.defaultPipeline
  if (defaultPipeline && !pack.pipelines.has(defaultPipeline)) {
    diagnostics.push(
      error("PACK_DEFAULT_PIPELINE_MISSING", `defaultPipeline "${defaultPipeline}" is not defined.`, {
        file,
        pointer: "spec.defaultPipeline",
      }),
    )
  }
  if (!defaultPipeline && pack.pipelines.size > 1) {
    diagnostics.push(
      warning("PACK_DEFAULT_PIPELINE_UNSET", "Multiple pipelines exist but no defaultPipeline is set.", {
        file,
        pointer: "spec.defaultPipeline",
        hint: "Set defaultPipeline so exports pick the right flow.",
      }),
    )
  }

  const defaultContext = pack.pack.spec.defaultContext
  if (defaultContext && !pack.contexts.has(defaultContext)) {
    diagnostics.push(
      error("PACK_DEFAULT_CONTEXT_MISSING", `defaultContext "${defaultContext}" is not defined.`, {
        file,
        pointer: "spec.defaultContext",
      }),
    )
  }

  const builderModel = pack.pack.spec.builderModel
  if (builderModel && !pack.providers.has(builderModel.provider)) {
    diagnostics.push(
      warning("PACK_BUILDER_PROVIDER_MISSING", `Builder model uses undeclared provider "${builderModel.provider}".`, {
        file,
        pointer: "spec.builderModel.provider",
      }),
    )
  }
}

function validateAgent(agent: ResolvedAgent, pack: ResolvedPack, diagnostics: Diagnostic[]): void {
  const file = agent.sources.at(-1)?.path
  const doc = agent.doc
  const pointer = (suffix: string) => `spec.${suffix}`

  if (agent.prompt.trim().length === 0) {
    diagnostics.push(
      error("AGENT_PROMPT_EMPTY", `Agent "${agent.id}" has an empty system prompt.`, {
        file,
        pointer: pointer("prompt"),
      }),
    )
  }

  if (doc.metadata.description.length > 600) {
    diagnostics.push(
      warning("AGENT_DESCRIPTION_LONG", `Agent "${agent.id}" has a very long description (${doc.metadata.description.length} chars).`, {
        file,
        pointer: "metadata.description",
        hint: "Claude Code loads every agent description into context; keep them short.",
      }),
    )
  }

  if (doc.spec.model) {
    if (!pack.providers.has(doc.spec.model.provider)) {
      diagnostics.push(
        warning("AGENT_MODEL_PROVIDER_MISSING", `Agent "${agent.id}" uses undeclared provider "${doc.spec.model.provider}".`, {
          file,
          pointer: pointer("model.provider"),
          hint: "Add a provider definition so exports can resolve credentials.",
        }),
      )
    }
    if ((doc.spec.model.temperature ?? 0) > 1.2) {
      diagnostics.push(
        info("AGENT_TEMPERATURE_HIGH", `Agent "${agent.id}" uses temperature ${doc.spec.model.temperature}.`, {
          file,
          pointer: pointer("model.temperature"),
        }),
      )
    }
  } else {
    diagnostics.push(
      info("AGENT_MODEL_INHERIT", `Agent "${agent.id}" has no model; the runtime default will be used.`, { file }),
    )
  }

  for (const handoff of doc.spec.handoffs) {
    if (!pack.agents.has(handoff)) {
      diagnostics.push(
        error("AGENT_HANDOFF_MISSING", `Agent "${agent.id}" hands off to unknown agent "${handoff}".`, {
          file,
          pointer: pointer("handoffs"),
        }),
      )
    }
    if (handoff === agent.id) {
      diagnostics.push(error("AGENT_HANDOFF_SELF", `Agent "${agent.id}" hands off to itself.`, { file, pointer: pointer("handoffs") }))
    }
  }

  for (const server of doc.spec.tools.mcp) {
    if (server !== "*" && !pack.integrations.has(server)) {
      diagnostics.push(
        error("AGENT_MCP_MISSING", `Agent "${agent.id}" uses undefined integration "${server}".`, {
          file,
          pointer: pointer("tools.mcp"),
          hint: "Define it in .agentp/integrations/ or remove it from the agent.",
        }),
      )
    }
  }

  for (const tool of doc.spec.tools.builtin) {
    if (!BUILTIN.has(tool)) {
      diagnostics.push(
        warning("AGENT_TOOL_UNKNOWN", `Agent "${agent.id}" lists unknown builtin tool "${tool}".`, {
          file,
          pointer: pointer("tools.builtin"),
          hint: `Known tools: ${BUILTIN_TOOLS.join(", ")}`,
        }),
      )
    }
  }

  for (const [tool, rule] of Object.entries(doc.spec.tools.permissions)) {
    if (BUILTIN.has(tool) && !doc.spec.tools.builtin.includes(tool)) {
      // An explicit deny for a tool the agent does not have is redundant but harmless.
      if (rule !== "deny") {
        diagnostics.push(
          warning("AGENT_PERMISSION_UNUSED", `Agent "${agent.id}" sets a permission for "${tool}" but does not grant the tool.`, {
            file,
            pointer: pointer(`tools.permissions.${tool}`),
            hint: `Add "${tool}" to tools.builtin or remove the permission.`,
          }),
        )
      }
    }
    if (typeof rule === "string" && rule === "deny") {
      const mutating = tool === "edit" || tool === "write" || tool === "apply_patch" || tool === "bash"
      if (mutating && doc.spec.tools.builtin.includes(tool)) {
        diagnostics.push(
          warning("AGENT_TOOL_DENIED", `Agent "${agent.id}" grants "${tool}" but denies it in permissions.`, {
            file,
            pointer: pointer(`tools.permissions.${tool}`),
            hint: "Remove it from tools.builtin, or change the permission.",
          }),
        )
      }
    }
  }

  if (doc.spec.limits?.maxTurns && doc.spec.limits.maxTurns > 200) {
    diagnostics.push(
      warning("AGENT_MAX_TURNS_HIGH", `Agent "${agent.id}" allows ${doc.spec.limits.maxTurns} turns.`, {
        file,
        pointer: pointer("limits.maxTurns"),
      }),
    )
  }

  const required = doc.spec.output?.required ?? []
  const duplicates = required.filter((item, index) => required.indexOf(item) !== index)
  if (duplicates.length > 0) {
    diagnostics.push(
      warning("AGENT_OUTPUT_DUPLICATE", `Agent "${agent.id}" lists duplicate output sections: ${[...new Set(duplicates)].join(", ")}.`, {
        file,
        pointer: pointer("output.required"),
      }),
    )
  }
}

function validateArtifacts(doc: { spec: { nodes: { id: string; outputs: string[] }[] } }, file: string | undefined, diagnostics: Diagnostic[]): void {
  const seen = new Map<string, string>()
  doc.spec.nodes.forEach((node, index) => {
    for (const output of node.outputs) {
      const existing = seen.get(output)
      if (existing) {
        diagnostics.push(
          warning("PIPELINE_OUTPUT_COLLISION", `Artifact "${output}" is written by both "${existing}" and "${node.id}".`, {
            file,
            pointer: `spec.nodes[${index}].outputs`,
            hint: "Give each stage a distinct artifact name.",
          }),
        )
      } else {
        seen.set(output, node.id)
      }
    }
  })
}

function validateContext(
  doc: { spec: { files: string[]; include: string[]; commands: Record<string, string> } },
  file: string | undefined,
  root: string,
  diagnostics: Diagnostic[],
): void {
  for (const included of doc.spec.include) {
    if (!existsSync(join(root, ".agentp", "context", `${included}.yaml`))) {
      diagnostics.push(
        error("CONTEXT_INCLUDE_MISSING", `Context includes unknown fragment "${included}".`, {
          file,
          pointer: "spec.include",
        }),
      )
    }
  }

  for (const path of doc.spec.files) {
    if (!existsSync(join(root, path))) {
      diagnostics.push(
        warning("CONTEXT_FILE_MISSING", `Context file "${path}" does not exist in the project.`, {
          file,
          pointer: "spec.files",
          hint: "Remove it or create the file before exporting.",
        }),
      )
    }
  }

  for (const [name, command] of Object.entries(doc.spec.commands)) {
    if (command.trim().length === 0) {
      diagnostics.push(
        warning("CONTEXT_COMMAND_EMPTY", `Context command "${name}" is empty.`, { file, pointer: `spec.commands.${name}` }),
      )
    }
  }
}

function validateIntegration(doc: IntegrationDoc, file: string | undefined, diagnostics: Diagnostic[]): void {
  const auth = doc.spec.auth
  if (auth && (auth.kind === "bearer" || auth.kind === "apiKey" || auth.kind === "basic") && !auth.secretRef && !auth.env) {
    diagnostics.push(
      warning("INTEGRATION_AUTH_UNDECLARED", `Integration "${doc.metadata.name}" has auth but no secretRef or env.`, {
        file,
        pointer: "spec.auth",
      }),
    )
  }

  if (doc.spec.transport === "local" && doc.spec.command?.some((part) => part.trim().length === 0)) {
    diagnostics.push(
      error("INTEGRATION_COMMAND_EMPTY", `Integration "${doc.metadata.name}" has an empty command segment.`, {
        file,
        pointer: "spec.command",
      }),
    )
  }

  for (const [key, value] of Object.entries(doc.spec.environment)) {
    if (isSecretKey(key) && !isEnvPlaceholder(value)) {
      diagnostics.push(
        warning("INTEGRATION_ENV_LITERAL_SECRET", `Integration "${doc.metadata.name}" stores a literal value for "${key}".`, {
          file,
          pointer: `spec.environment.${key}`,
          hint: `Use "{env:${key}}" so the secret stays in the environment. The exporter will substitute the placeholder.`,
        }),
      )
    }
  }

  if (doc.spec.transport === "remote" && doc.spec.url && doc.spec.url.startsWith("http://")) {
    diagnostics.push(
      warning("INTEGRATION_INSECURE_URL", `Integration "${doc.metadata.name}" uses plain HTTP.`, {
        file,
        pointer: "spec.url",
        hint: "Prefer HTTPS; credentials sent over HTTP are exposed.",
      }),
    )
  }

  if (doc.spec.tools.length > 0 && !doc.spec.check) {
    diagnostics.push(
      info("INTEGRATION_TOOLS_UNVERIFIED", `Integration "${doc.metadata.name}" pins tools but has no check adapter.`, {
        file,
        pointer: "spec.tools",
        hint: "Add a check so tool names can be verified against the live server.",
      }),
    )
  }
}

function validateProvider(doc: ProviderDoc, file: string | undefined, diagnostics: Diagnostic[]): void {
  if (!doc.spec.auth?.secretRef && !doc.spec.auth?.env) {
    diagnostics.push(
      warning("PROVIDER_AUTH_MISSING", `Provider "${doc.metadata.name}" does not declare a secretRef or env var.`, {
        file,
        pointer: "spec.auth",
        hint: "Exports never embed secrets; declare where the runtime should find the key.",
      }),
    )
  }

  if (doc.spec.type === "openai-compatible" && doc.spec.baseUrl?.startsWith("http://")) {
    diagnostics.push(
      warning("PROVIDER_INSECURE_URL", `Provider "${doc.metadata.name}" uses plain HTTP.`, {
        file,
        pointer: "spec.baseUrl",
      }),
    )
  }
}

function validateTarget(target: string, pack: ResolvedPack, diagnostics: Diagnostic[]): void {
  if (target === "opencode") {
    for (const agent of pack.agents.values()) {
      if (agent.doc.spec.tools.builtin.includes("apply_patch") && !agent.doc.spec.tools.builtin.includes("edit")) {
        diagnostics.push(
          info("EXPORT_OPENCODE_PATCH", `Agent "${agent.id}" uses apply_patch; OpenCode maps it to the edit permission.`, {
            target,
            file: agent.sources.at(-1)?.path,
          }),
        )
      }
    }
    return
  }

  if (target === "claude-code") {
    const modelMap = pack.pack.spec.export?.modelMap ?? {}
    const integrationNames = [...pack.integrations.keys()].sort()
    for (const agent of pack.agents.values()) {
      const file = agent.sources.at(-1)?.path
      if (agent.doc.spec.model) {
        const mapping = mapModelId(agent.doc.spec.model, modelMap)
        if (mapping.degrade) {
          diagnostics.push(
            warning("EXPORT_CLAUDE_MODEL", `Agent "${agent.id}": ${mapping.degrade}.`, {
              target,
              file,
              pointer: "spec.model",
            }),
          )
        }
      }

      const resolution = resolveTools(agent, integrationNames)
      if (resolution.pathScopedEdit) {
        diagnostics.push(
          warning(
            "EXPORT_CLAUDE_PATH_SCOPED_EDIT",
            `Agent "${agent.id}" scopes edit permissions by path; Claude Code grants Edit and Write for the whole project.`,
            { target, file, pointer: "spec.tools.permissions" },
          ),
        )
      }
      if (resolution.commandScopedBash) {
        diagnostics.push(
          warning(
            "EXPORT_CLAUDE_COMMAND_SCOPED_BASH",
            `Agent "${agent.id}" scopes bash permissions by command; Claude Code cannot scope Bash commands per subagent.`,
            { target, file, pointer: "spec.tools.permissions" },
          ),
        )
      }
      if (resolution.tools.length === 0) {
        diagnostics.push(
          warning(
            "EXPORT_CLAUDE_NO_TOOLS",
            `Agent "${agent.id}" grants no tool that Claude Code recognizes; the subagent would inherit every tool.`,
            { target, file, pointer: "spec.tools.builtin" },
          ),
        )
      }
    }
    return
  }

  if (target === "codex") {
    diagnostics.push(...analyzeCodex(pack).diagnostics)
    return
  }

  diagnostics.push(
    error("EXPORT_TARGET_UNKNOWN", `Unknown export target "${target}".`, {
      target,
      hint: `Available targets: ${availableTargets().join(", ")}.`,
    }),
  )
}
