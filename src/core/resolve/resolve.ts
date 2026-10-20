import { basename, dirname, join, resolve } from "node:path"
import type { z } from "zod"
import { error, warning, type Diagnostic } from "../diagnostics"
import { listYamlFiles, readTextIfExists } from "../fs/paths"
import { issuesToDiagnostics, parseWithSchema } from "../spec/parse"
import {
  AgentSchema,
  SCHEMA_BY_KIND,
  type AgentDoc,
  type ContextDoc,
  type IntegrationDoc,
  type PackDoc,
  type PipelineDoc,
  type ProviderDoc,
} from "../spec/schema"

export type SourceScope = "global" | "project"
export type SourceRef = { path: string; scope: SourceScope }

export type ResolvedAgent = {
  id: string
  doc: AgentDoc
  prompt: string
  sources: SourceRef[]
}

export type ResolvedPipeline = {
  id: string
  doc: PipelineDoc
  sources: SourceRef[]
}

export type ResolvedContext = {
  id: string
  doc: ContextDoc
  sources: SourceRef[]
}

export type ResolvedIntegration = {
  id: string
  doc: IntegrationDoc
  sources: SourceRef[]
}

export type ResolvedProvider = {
  id: string
  doc: ProviderDoc
  sources: SourceRef[]
}

export type ResolvedPack = {
  root: string
  pack: PackDoc
  agents: Map<string, ResolvedAgent>
  pipelines: Map<string, ResolvedPipeline>
  contexts: Map<string, ResolvedContext>
  integrations: Map<string, ResolvedIntegration>
  providers: Map<string, ResolvedProvider>
  diagnostics: Diagnostic[]
}

type RawDoc = Record<string, unknown>
type RawEntry = { raw: RawDoc; source: SourceRef }
type MergedRaw = { raw: RawDoc; sources: SourceRef[] }

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return isPlainObject(value) ? value : undefined
}

function getName(raw: RawDoc): string | undefined {
  const metadata = asObject(raw.metadata)
  const name = metadata?.name
  return typeof name === "string" ? name : undefined
}

/**
 * Merges raw documents before schema defaults are applied. Arrays replace, objects merge,
 * and explicit values (including null) win. This preserves field-level inheritance when a
 * project overrides only part of a global document.
 */
export function deepMerge<T>(base: T, override: T): T {
  if (Array.isArray(base) || Array.isArray(override)) return override
  if (isPlainObject(base) && isPlainObject(override)) {
    const out: Record<string, unknown> = { ...base }
    for (const [key, value] of Object.entries(override)) {
      if (value === undefined) continue
      out[key] = key in out ? deepMerge(out[key], value) : value
    }
    return out as T
  }
  return override
}

async function loadRawDoc<T extends { metadata: { name: string } }>(
  path: string,
  schema: z.ZodType<T>,
  diagnostics: Diagnostic[],
): Promise<{ raw: RawDoc; doc: T } | null> {
  const text = await readTextIfExists(path)
  if (text === null) {
    diagnostics.push(error("FILE_UNREADABLE", "Could not read file.", { file: path }))
    return null
  }

  const parsed = parseWithSchema(text, schema)
  if (!parsed.ok) {
    diagnostics.push(...issuesToDiagnostics(parsed.issues, path))
    return null
  }
  if (!isPlainObject(parsed.value)) {
    diagnostics.push(error("DOC_NOT_OBJECT", "A pack document must be a YAML object.", { file: path }))
    return null
  }

  return { raw: parsed.value, doc: parsed.data }
}

async function loadCollectionRaw<T extends { metadata: { name: string } }>(
  dir: string,
  scope: SourceScope,
  schema: z.ZodType<T>,
  diagnostics: Diagnostic[],
  kindLabel: string,
): Promise<Map<string, RawEntry>> {
  const out = new Map<string, RawEntry>()
  const files = await listYamlFiles(dir)

  for (const file of files) {
    const loaded = await loadRawDoc(file, schema, diagnostics)
    if (!loaded) continue
    const name = loaded.doc.metadata.name

    if (out.has(name)) {
      diagnostics.push(
        error("DUPLICATE_NAME", `Duplicate ${kindLabel} name "${name}" in the ${scope} scope.`, {
          file,
          hint: "Names must be unique within a scope; the project scope overrides the global one.",
        }),
      )
      continue
    }
    out.set(name, { raw: loaded.raw, source: { path: file, scope } })
  }

  return out
}

async function loadAgentsRaw(
  dir: string,
  scope: SourceScope,
  diagnostics: Diagnostic[],
): Promise<Map<string, RawEntry>> {
  const out = new Map<string, RawEntry>()
  const files = await listYamlFiles(dir)

  for (const file of files) {
    const loaded = await loadRawDoc(file, AgentSchema, diagnostics)
    if (!loaded) continue

    const name = loaded.doc.metadata.name
    const raw = loaded.raw
    const spec = asObject(raw.spec) ?? {}
    const prompt = asObject(spec.prompt)

    if (prompt && typeof prompt.file === "string") {
      const promptPath = resolve(dirname(file), prompt.file)
      const content = await readTextIfExists(promptPath)
      if (content === null) {
        diagnostics.push(
          error("AGENT_PROMPT_MISSING", `Prompt file "${prompt.file}" was not found.`, {
            file,
            pointer: "spec.prompt.file",
            hint: `Expected it at ${promptPath}.`,
          }),
        )
        spec.prompt = { inline: "(missing prompt)" }
      } else {
        spec.prompt = { inline: content }
      }
      raw.spec = spec
    }

    if (out.has(name)) {
      diagnostics.push(
        error("DUPLICATE_NAME", `Duplicate agent name "${name}" in the ${scope} scope.`, {
          file,
          hint: "Names must be unique within a scope; the project scope overrides the global one.",
        }),
      )
      continue
    }

    out.set(name, { raw, source: { path: file, scope } })
  }

  return out
}

function mergeScopes(
  global: Map<string, RawEntry>,
  project: Map<string, RawEntry>,
  replaceWhole = false,
): Map<string, MergedRaw> {
  const out = new Map<string, MergedRaw>()
  for (const [name, entry] of global) {
    out.set(name, { raw: entry.raw, sources: [entry.source] })
  }
  for (const [name, entry] of project) {
    const existing = out.get(name)
    if (!existing) {
      out.set(name, { raw: entry.raw, sources: [entry.source] })
      continue
    }
    out.set(name, {
      raw: replaceWhole ? entry.raw : deepMerge(existing.raw, entry.raw),
      sources: [...existing.sources, entry.source],
    })
  }
  return out
}

function resolveRawInheritance(entries: Map<string, MergedRaw>, diagnostics: Diagnostic[]): void {
  const resolved = new Map<string, RawDoc>()
  const resolving = new Set<string>()

  const resolveAgent = (name: string): RawDoc | null => {
    const cached = resolved.get(name)
    if (cached) return cached

    const entry = entries.get(name)
    if (!entry) return null

    if (resolving.has(name)) {
      diagnostics.push(
        error("AGENT_EXTENDS_CYCLE", `Agent "${name}" extends itself through a cycle.`, {
          file: entry.sources.at(-1)?.path,
          hint: "Remove one of the extends links.",
        }),
      )
      return entry.raw
    }

    resolving.add(name)
    const spec = asObject(entry.raw.spec) ?? {}
    const parentName = typeof spec.extends === "string" ? spec.extends : undefined
    let base: RawDoc | null = null

    if (parentName) {
      base = resolveAgent(parentName)
      if (!base) {
        diagnostics.push(
          error("AGENT_EXTENDS_MISSING", `Agent "${name}" extends "${parentName}", which does not exist.`, {
            file: entry.sources.at(-1)?.path,
            pointer: "spec.extends",
          }),
        )
      }
    }
    resolving.delete(name)

    const merged = base ? deepMerge(base, entry.raw) : entry.raw
    const mergedSpec = asObject(merged.spec) ?? {}
    if ("extends" in mergedSpec) {
      const nextSpec = { ...mergedSpec }
      delete nextSpec.extends
      merged.spec = nextSpec
    }

    resolved.set(name, merged)
    entry.raw = merged
    return merged
  }

  for (const name of entries.keys()) resolveAgent(name)
}

function parseMerged<T>(
  raw: RawDoc,
  schema: z.ZodType<T>,
  file: string | undefined,
  diagnostics: Diagnostic[],
): T | null {
  const parsed = schema.safeParse(raw)
  if (parsed.success) return parsed.data
  diagnostics.push(...issuesToDiagnostics(parsed.error.issues.map((issue) => ({
    code: issue.code.toUpperCase(),
    message: issue.message,
    path: [...issue.path],
  })), file ?? "(merged)"))
  return null
}

export async function resolvePack(options: {
  root: string
  globalDir: string
  diagnostics?: Diagnostic[]
}): Promise<ResolvedPack> {
  const diagnostics: Diagnostic[] = [...(options.diagnostics ?? [])]
  const projectBase = join(options.root, ".agentp")

  const [globalAgents, projectAgents] = await Promise.all([
    loadAgentsRaw(join(options.globalDir, "agents"), "global", diagnostics),
    loadAgentsRaw(join(projectBase, "agents"), "project", diagnostics),
  ])

  const agentRaw = mergeScopes(globalAgents, projectAgents)
  resolveRawInheritance(agentRaw, diagnostics)

  const agents = new Map<string, ResolvedAgent>()
  for (const [name, entry] of agentRaw) {
    const doc = parseMerged(entry.raw, AgentSchema, entry.sources.at(-1)?.path, diagnostics)
    if (!doc) continue
    const prompt = doc.spec.prompt && "inline" in doc.spec.prompt ? doc.spec.prompt.inline : ""
    agents.set(name, { id: name, doc, prompt, sources: entry.sources })
  }

  const [
    globalPipelines,
    projectPipelines,
    globalContexts,
    projectContexts,
    globalIntegrations,
    projectIntegrations,
    globalProviders,
    projectProviders,
  ] = await Promise.all([
    loadCollectionRaw(join(options.globalDir, "pipeline"), "global", SCHEMA_BY_KIND.Pipeline, diagnostics, "pipeline"),
    loadCollectionRaw(join(projectBase, "pipeline"), "project", SCHEMA_BY_KIND.Pipeline, diagnostics, "pipeline"),
    loadCollectionRaw(join(options.globalDir, "context"), "global", SCHEMA_BY_KIND.Context, diagnostics, "context"),
    loadCollectionRaw(join(projectBase, "context"), "project", SCHEMA_BY_KIND.Context, diagnostics, "context"),
    loadCollectionRaw(join(options.globalDir, "integrations"), "global", SCHEMA_BY_KIND.Integration, diagnostics, "integration"),
    loadCollectionRaw(join(projectBase, "integrations"), "project", SCHEMA_BY_KIND.Integration, diagnostics, "integration"),
    loadCollectionRaw(join(options.globalDir, "providers"), "global", SCHEMA_BY_KIND.Provider, diagnostics, "provider"),
    loadCollectionRaw(join(projectBase, "providers"), "project", SCHEMA_BY_KIND.Provider, diagnostics, "provider"),
  ])

  const pipelines = parseCollection(
    mergeScopes(globalPipelines, projectPipelines, true),
    SCHEMA_BY_KIND.Pipeline,
    diagnostics,
  )
  const contexts = parseCollection(mergeScopes(globalContexts, projectContexts), SCHEMA_BY_KIND.Context, diagnostics)
  const integrations = parseCollection(
    mergeScopes(globalIntegrations, projectIntegrations),
    SCHEMA_BY_KIND.Integration,
    diagnostics,
  )
  const providers = parseCollection(mergeScopes(globalProviders, projectProviders), SCHEMA_BY_KIND.Provider, diagnostics)

  let pack: PackDoc
  const packPath = join(projectBase, "pack.yaml")
  const packText = await readTextIfExists(packPath)
  if (packText !== null) {
    const parsed = parseWithSchema(packText, SCHEMA_BY_KIND.Pack)
    if (parsed.ok) {
      pack = parsed.data
    } else {
      diagnostics.push(...issuesToDiagnostics(parsed.issues, packPath))
      pack = fallbackPack(options.root)
    }
  } else {
    pack = fallbackPack(options.root)
    diagnostics.push(
      warning("PACK_MISSING", `No pack.yaml found at ${packPath}; using defaults.`, {
        hint: "Run `agentp init` to scaffold a pack.",
      }),
    )
  }

  return {
    root: options.root,
    pack,
    agents,
    pipelines,
    contexts,
    integrations,
    providers,
    diagnostics,
  }
}

function parseCollection<T>(
  input: Map<string, MergedRaw>,
  schema: z.ZodType<T>,
  diagnostics: Diagnostic[],
): Map<string, { id: string; doc: T; sources: SourceRef[] }> {
  const out = new Map<string, { id: string; doc: T; sources: SourceRef[] }>()
  for (const [id, entry] of input) {
    const doc = parseMerged(entry.raw, schema, entry.sources.at(-1)?.path, diagnostics)
    if (doc) out.set(id, { id, doc, sources: entry.sources })
  }
  return out
}

function fallbackPack(root: string): PackDoc {
  const fallbackName = basename(root) || "agent-pack"
  return {
    apiVersion: "agentp/v1",
    kind: "Pack",
    metadata: {
      name: fallbackName,
      description: `Agent pack for ${fallbackName}.`,
      version: "0.1.0",
    },
    spec: {},
  }
}

export function sourceLabel(source: SourceRef): string {
  return `${source.scope}:${source.path}`
}
