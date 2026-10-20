export type Severity = "error" | "warning" | "info"

export type Diagnostic = {
  code: string
  severity: Severity
  message: string
  file?: string
  pointer?: string
  hint?: string
  target?: string
}

export function diag(
  code: string,
  severity: Severity,
  message: string,
  extra: Omit<Diagnostic, "code" | "severity" | "message"> = {},
): Diagnostic {
  return { code, severity, message, ...extra }
}

export const error = (code: string, message: string, extra?: Omit<Diagnostic, "code" | "severity" | "message">) =>
  diag(code, "error", message, extra)

export const warning = (code: string, message: string, extra?: Omit<Diagnostic, "code" | "severity" | "message">) =>
  diag(code, "warning", message, extra)

export const info = (code: string, message: string, extra?: Omit<Diagnostic, "code" | "severity" | "message">) =>
  diag(code, "info", message, extra)

const RANK: Record<Severity, number> = { error: 0, warning: 1, info: 2 }

export function severityRank(severity: Severity): number {
  return RANK[severity]
}

export function compareDiagnostics(a: Diagnostic, b: Diagnostic): number {
  const bySeverity = severityRank(a.severity) - severityRank(b.severity)
  if (bySeverity !== 0) return bySeverity
  const byFile = (a.file ?? "").localeCompare(b.file ?? "")
  if (byFile !== 0) return byFile
  return (a.pointer ?? "").localeCompare(b.pointer ?? "")
}

export function sortDiagnostics(list: Diagnostic[]): Diagnostic[] {
  return [...list].sort(compareDiagnostics)
}

export function countBySeverity(list: Diagnostic[]) {
  return list.reduce(
    (acc, d) => {
      acc[d.severity] += 1
      return acc
    },
    { error: 0, warning: 0, info: 0 } as Record<Severity, number>,
  )
}

/** Renders `["spec", "nodes", 2, "agent"]` as `spec.nodes[2].agent`. */
export function formatPointer(path: readonly PropertyKey[]): string {
  let out = ""
  for (const part of path) {
    if (typeof part === "number") {
      out += `[${part}]`
    } else if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(String(part))) {
      out += out.length === 0 ? String(part) : `.${String(part)}`
    } else {
      out += `[${JSON.stringify(String(part))}]`
    }
  }
  return out
}

export function formatDiagnostic(d: Diagnostic, color = false): string {
  const paint = (code: string, text: string) => (color ? `\u001b[${code}m${text}\u001b[0m` : text)
  const label =
    d.severity === "error" ? paint("31", "error") : d.severity === "warning" ? paint("33", "warning") : paint("36", "info")
  const location = [d.file, d.pointer].filter(Boolean).join(":")
  const head = `${label} ${paint("2", `[${d.code}]`)}${location ? ` ${location}` : ""}`
  const lines = [`${head}\n  ${d.message}`]
  if (d.hint) lines.push(`  ${paint("2", `hint: ${d.hint}`)}`)
  return lines.join("\n")
}
