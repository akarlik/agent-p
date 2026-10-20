import YAML from "yaml"
import type { z } from "zod"
import { formatPointer, type Diagnostic } from "../diagnostics"

export type SpecIssue = {
  code: string
  message: string
  path: PropertyKey[]
}

export type ParseResult<T> =
  | { ok: true; data: T; value: unknown }
  | { ok: false; issues: SpecIssue[] }

export function parseYamlText(text: string): { ok: true; value: unknown } | { ok: false; issues: SpecIssue[] } {
  const doc = YAML.parseDocument(text, { prettyErrors: true })
  if (doc.errors.length > 0) {
    return {
      ok: false,
      issues: doc.errors.map((err) => {
        const pos = err.linePos?.[0]
        const location = pos ? ` at line ${pos.line}, column ${pos.col}` : ""
        return {
          code: "YAML_PARSE",
          message: `${err.message}${location}`,
          path: [],
        }
      }),
    }
  }
  try {
    return { ok: true, value: doc.toJS({ maxAliasCount: 100 }) }
  } catch (err) {
    return {
      ok: false,
      issues: [
        {
          code: "YAML_PARSE",
          message: err instanceof Error ? err.message : String(err),
          path: [],
        },
      ],
    }
  }
}

export function parseWithSchema<T>(text: string, schema: z.ZodType<T>): ParseResult<T> {
  const parsed = parseYamlText(text)
  if (!parsed.ok) return parsed

  const result = schema.safeParse(parsed.value)
  if (result.success) {
    return { ok: true, data: result.data, value: parsed.value }
  }

  return {
    ok: false,
    issues: result.error.issues.map((issue) => ({
      code: issue.code.toUpperCase(),
      message: issue.message,
      path: [...issue.path],
    })),
  }
}

export function issuesToDiagnostics(issues: SpecIssue[], file: string): Diagnostic[] {
  return issues.map((issue) => ({
    code: issue.code,
    severity: issue.code === "UNRECOGNIZED_KEYS" ? "warning" : "error",
    message: issue.message,
    file,
    pointer: issue.path.length > 0 ? formatPointer(issue.path) : undefined,
  }))
}

/** Serializes a document with stable formatting and no line wrapping. */
export function stringifyDoc(value: unknown): string {
  return YAML.stringify(value, {
    lineWidth: 0,
    minContentWidth: 0,
    indent: 2,
  })
}
