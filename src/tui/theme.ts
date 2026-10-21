import type { Severity } from "../core/diagnostics"

/**
 * Colors are chosen to stay legible on both dark and light terminals. Body text
 * deliberately keeps the terminal's default foreground; only emphasis, accents,
 * and severity markers are colored.
 */
export const theme = {
  accent: "#3fb6a8",
  border: "#3f5266",
  borderFocus: "#3fb6a8",
  dim: "#7f8fa2",
  muted: "#5f7080",
  green: "#5fbf7f",
  yellow: "#d9a73f",
  red: "#e06c75",
  cyan: "#61afef",
  purple: "#c678dd",
} as const

export function severityColor(severity: Severity): string {
  if (severity === "error") return theme.red
  if (severity === "warning") return theme.yellow
  return theme.dim
}

export function actionColor(action: "create" | "update" | "unchanged"): string {
  if (action === "create") return theme.green
  if (action === "update") return theme.yellow
  return theme.dim
}
