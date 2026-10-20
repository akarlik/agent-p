import type { Diagnostic } from "../diagnostics"
import type { ResolvedPack } from "../resolve/resolve"

export type FileAction = "create" | "update" | "unchanged"

export type FileKind = "agent" | "orchestrator" | "context" | "config" | "other"

export type FileChange = {
  /** Path relative to the project root. */
  path: string
  contents: string
  action: FileAction
  kind: FileKind
  diff?: string
  drifted?: boolean
}

export type ExportPlan = {
  target: ExportTargetId
  root: string
  changes: FileChange[]
  notes: string[]
  diagnostics: Diagnostic[]
}

export type ExportTargetId = "opencode" | "claude-code" | "codex"

export type ExportOptions = {
  includeUnusedIntegrations?: boolean
  outDir?: string
}

export type ExporterCapabilities = {
  subagents: boolean
  orchestrator: boolean
  mcp: boolean
  perToolPermissions: boolean
  perAgentMcp: boolean
  commands: boolean
  skills: boolean
}

export type Exporter = {
  id: ExportTargetId
  label: string
  capabilities: ExporterCapabilities
  plan(pack: ResolvedPack, options?: ExportOptions): Promise<ExportPlan>
}

export type ApplyResult = {
  written: string[]
  backedUp: string[]
  unchanged: string[]
}
