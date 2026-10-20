import type { ExportTargetId, Exporter } from "./types"
import { opencodeExporter } from "./opencode"
import { claudeCodeExporter } from "./claude-code"

export const exporters: Partial<Record<ExportTargetId, Exporter>> = {
  opencode: opencodeExporter,
  "claude-code": claudeCodeExporter,
}

export function getExporter(id: string): Exporter | undefined {
  return exporters[id as ExportTargetId]
}

export function availableTargets(): ExportTargetId[] {
  return Object.keys(exporters) as ExportTargetId[]
}
