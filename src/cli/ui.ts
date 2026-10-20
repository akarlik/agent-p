import { countBySeverity, formatDiagnostic, type Diagnostic } from "../core/diagnostics"

const colorEnabled =
  Boolean(process.stdout.isTTY) && !process.env.NO_COLOR && process.env.TERM !== "dumb"

export function useColor(): boolean {
  return colorEnabled
}

export function paint(code: string, text: string): string {
  return colorEnabled ? `\u001b[${code}m${text}\u001b[0m` : text
}

export const c = {
  bold: (text: string) => paint("1", text),
  dim: (text: string) => paint("2", text),
  red: (text: string) => paint("31", text),
  green: (text: string) => paint("32", text),
  yellow: (text: string) => paint("33", text),
  cyan: (text: string) => paint("36", text),
  teal: (text: string) => paint("38;5;37", text),
}

export function banner(version: string): string {
  return `${c.teal("Agent P")} ${c.dim(`v${version}`)}`
}

export function heading(text: string): string {
  return `\n${c.bold(text)}`
}

export function printDiagnostics(diagnostics: Diagnostic[]): void {
  if (diagnostics.length === 0) return
  for (const diagnostic of diagnostics) {
    console.log(formatDiagnostic(diagnostic, colorEnabled))
  }
}

export function printCounts(diagnostics: Diagnostic[]): string {
  const counts = countBySeverity(diagnostics)
  const parts: string[] = []
  if (counts.error > 0) parts.push(c.red(`${counts.error} error${counts.error === 1 ? "" : "s"}`))
  if (counts.warning > 0) parts.push(c.yellow(`${counts.warning} warning${counts.warning === 1 ? "" : "s"}`))
  if (counts.info > 0) parts.push(c.dim(`${counts.info} info`))
  return parts.length > 0 ? parts.join(c.dim(" · ")) : c.green("no issues")
}

export function printPackSummary(summary: {
  agents: number
  pipelines: number
  contexts: number
  integrations: number
  providers: number
}): string {
  return [
    `${summary.agents} agent${summary.agents === 1 ? "" : "s"}`,
    `${summary.pipelines} pipeline${summary.pipelines === 1 ? "" : "s"}`,
    `${summary.contexts} context${summary.contexts === 1 ? "" : "s"}`,
    `${summary.integrations} integration${summary.integrations === 1 ? "" : "s"}`,
    `${summary.providers} provider${summary.providers === 1 ? "" : "s"}`,
  ].join(c.dim(" · "))
}
