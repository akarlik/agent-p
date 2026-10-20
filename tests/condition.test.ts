import { describe, expect, test } from "bun:test"
import {
  collectRootNodes,
  evaluateCondition,
  formatExpr,
  parseCondition,
  type EvalContext,
} from "../src/core/graph/condition"

function evaluate(source: string, context: EvalContext = {}): boolean {
  const parsed = parseCondition(source)
  if (!parsed.ok) throw new Error(parsed.error.message)
  return evaluateCondition(parsed.ast, context)
}

describe("condition parser", () => {
  test("always is true", () => {
    expect(evaluate("always")).toBe(true)
    expect(evaluate("true")).toBe(true)
    expect(evaluate("false")).toBe(false)
  })

  test("compares strings", () => {
    expect(evaluate('test.status == "passed"', { test: { status: "passed" } })).toBe(true)
    expect(evaluate('test.status != "passed"', { test: { status: "failed" } })).toBe(true)
    expect(evaluate('test.status == "passed"', { test: { status: "failed" } })).toBe(false)
  })

  test("compares numbers", () => {
    expect(evaluate("review.findings > 0", { review: { findings: 2 } })).toBe(true)
    expect(evaluate("review.findings >= 2", { review: { findings: 2 } })).toBe(true)
    expect(evaluate("review.findings < 2", { review: { findings: 2 } })).toBe(false)
    expect(evaluate("review.findings <= 1", { review: { findings: 2 } })).toBe(false)
  })

  test("supports and, or, not, and parentheses", () => {
    const context = { test: { status: "passed" }, review: { verdict: "approved" } }
    expect(evaluate('test.status == "passed" and review.verdict == "approved"', context)).toBe(true)
    expect(evaluate('test.status == "failed" or review.verdict == "approved"', context)).toBe(true)
    expect(evaluate('not (test.status == "failed")', context)).toBe(true)
    expect(evaluate('test.status == "passed" and (review.verdict == "rejected" or true)', context)).toBe(true)
  })

  test("bare paths use truthiness", () => {
    expect(evaluate("review.approved", { review: { approved: true } })).toBe(true)
    expect(evaluate("review.approved", { review: { approved: false } })).toBe(false)
    expect(evaluate("review.notes", { review: { notes: "ok" } })).toBe(true)
    expect(evaluate("review.notes", { review: { notes: "" } })).toBe(false)
    expect(evaluate("review.notes", { review: {} })).toBe(false)
  })

  test("missing paths never satisfy comparisons", () => {
    expect(evaluate('test.status == "passed"', {})).toBe(false)
    expect(evaluate('test.status != "passed"', {})).toBe(false)
    expect(evaluate("test.count > 0", {})).toBe(false)
  })

  test("respects operator precedence", () => {
    // and binds tighter than or
    expect(evaluate("true or false and false")).toBe(true)
    expect(evaluate("(true or false) and false")).toBe(false)
  })

  test("collects root nodes", () => {
    const parsed = parseCondition('test.status == "passed" and review.verdict == "approved"')
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect([...collectRootNodes(parsed.ast)].sort()).toEqual(["review", "test"])
    expect(formatExpr(parsed.ast)).toBe('test.status == "passed" and review.verdict == "approved"')
  })

  test("reports malformed expressions", () => {
    const invalid = ["", "a ==", "a b", 'a == "unterminated', "a.", "a and", "(a", "a == b == c"]
    for (const source of invalid) {
      const parsed = parseCondition(source)
      expect({ source, ok: parsed.ok }).toEqual({ source, ok: false })
    }
  })

  test("supports hyphenated node names", () => {
    expect(evaluate('product-discovery.status == "success"', { "product-discovery": { status: "success" } })).toBe(true)
  })
})
