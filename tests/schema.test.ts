import { describe, expect, test } from "bun:test"
import { generateJsonSchema } from "../src/core/spec/json-schema"
import { issuesToDiagnostics, parseWithSchema } from "../src/core/spec/parse"
import { SCHEMA_BY_KIND } from "../src/core/spec/schema"

describe("JSON Schema", () => {
  test("describes every document kind", () => {
    const schema = generateJsonSchema()
    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema")
    expect(schema.title).toContain("Agent P")

    const serialized = JSON.stringify(schema)
    for (const kind of ["Agent", "Pipeline", "Context", "Integration", "Provider", "Pack"]) {
      expect(serialized).toContain(kind)
    }
    expect(Boolean(schema.oneOf ?? schema.anyOf)).toBe(true)
  })
})

describe("schema diagnostics", () => {
  test("unknown keys become warnings, not errors", () => {
    const parsed = parseWithSchema(
      `apiVersion: agentp/v1
kind: Pack
metadata:
  name: test
  description: Test pack
spec: {}
unexpected: true
`,
      SCHEMA_BY_KIND.Pack,
    )
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    const diagnostics = issuesToDiagnostics(parsed.issues, "pack.yaml")
    expect(diagnostics.some((diagnostic) => diagnostic.code === "UNRECOGNIZED_KEYS" && diagnostic.severity === "warning")).toBe(true)
  })

  test("invalid enum values are errors with a pointer", () => {
    const parsed = parseWithSchema(
      `apiVersion: agentp/v1
kind: Integration
metadata:
  name: bad
  description: Bad transport
spec:
  transport: carrier-pigeon
`,
      SCHEMA_BY_KIND.Integration,
    )
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    const diagnostics = issuesToDiagnostics(parsed.issues, "integration.yaml")
    expect(diagnostics.some((diagnostic) => diagnostic.pointer === "spec.transport" && diagnostic.severity === "error")).toBe(true)
  })
})
