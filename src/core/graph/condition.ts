export type ConditionValue = string | number | boolean | null

export type Expr =
  | { type: "literal"; value: ConditionValue }
  | { type: "path"; path: string[] }
  | { type: "not"; expr: Expr }
  | { type: "and"; left: Expr; right: Expr }
  | { type: "or"; left: Expr; right: Expr }
  | { type: "cmp"; op: ComparisonOp; left: Expr; right: Expr }

export type ComparisonOp = "==" | "!=" | ">" | ">=" | "<" | "<="

export type ParseConditionResult =
  | { ok: true; ast: Expr }
  | { ok: false; error: { message: string; position: number } }

type Token =
  | { type: "ident"; value: string; pos: number }
  | { type: "string"; value: string; pos: number }
  | { type: "number"; value: number; pos: number }
  | { type: "op"; value: ComparisonOp; pos: number }
  | { type: "lparen"; pos: number }
  | { type: "rparen"; pos: number }
  | { type: "eof"; pos: number }

const KEYWORDS = new Set(["and", "or", "not", "true", "false", "null", "always"])
const OPERATORS: ComparisonOp[] = ["==", "!=", ">=", "<=", ">", "<"]

function tokenize(input: string): { tokens: Token[] } | { error: { message: string; position: number } } {
  const tokens: Token[] = []
  let i = 0

  while (i < input.length) {
    const ch = input[i]!

    if (/\s/.test(ch)) {
      i += 1
      continue
    }

    if (ch === "(") {
      tokens.push({ type: "lparen", pos: i })
      i += 1
      continue
    }
    if (ch === ")") {
      tokens.push({ type: "rparen", pos: i })
      i += 1
      continue
    }

    const op = OPERATORS.find((candidate) => input.startsWith(candidate, i))
    if (op) {
      tokens.push({ type: "op", value: op, pos: i })
      i += op.length
      continue
    }

    if (ch === '"' || ch === "'") {
      const quote = ch
      let value = ""
      let j = i + 1
      let closed = false
      while (j < input.length) {
        const next = input[j]!
        if (next === "\\") {
          const escaped = input[j + 1]
          if (escaped === undefined) break
          value += escaped === "n" ? "\n" : escaped === "t" ? "\t" : escaped
          j += 2
          continue
        }
        if (next === quote) {
          closed = true
          j += 1
          break
        }
        value += next
        j += 1
      }
      if (!closed) return { error: { message: "Unterminated string literal.", position: i } }
      tokens.push({ type: "string", value, pos: i })
      i = j
      continue
    }

    if (/[0-9]/.test(ch) || (ch === "-" && /[0-9]/.test(input[i + 1] ?? ""))) {
      const match = /^-?[0-9]+(\.[0-9]+)?/.exec(input.slice(i))
      if (!match) return { error: { message: "Invalid number.", position: i } }
      tokens.push({ type: "number", value: Number(match[0]), pos: i })
      i += match[0].length
      continue
    }

    if (/[A-Za-z_]/.test(ch)) {
      // Dots are folded into the identifier and split into path segments by the parser.
      const match = /^[A-Za-z_][A-Za-z0-9_.-]*/.exec(input.slice(i))
      if (!match) return { error: { message: "Invalid identifier.", position: i } }
      tokens.push({ type: "ident", value: match[0], pos: i })
      i += match[0].length
      continue
    }

    if (ch === ".") {
      return { error: { message: "Unexpected '.'.", position: i } }
    }

    return { error: { message: `Unexpected character "${ch}".`, position: i } }
  }

  tokens.push({ type: "eof", pos: input.length })
  return { tokens }
}

class Parser {
  private index = 0

  constructor(private readonly tokens: Token[]) {}

  parse(): Expr {
    const expr = this.parseOr()
    const next = this.peek()
    if (next.type !== "eof") {
      throw new ConditionParseError(`Unexpected token after expression.`, next.pos)
    }
    return expr
  }

  private parseOr(): Expr {
    let left = this.parseAnd()
    while (this.matchKeyword("or")) {
      const right = this.parseAnd()
      left = { type: "or", left, right }
    }
    return left
  }

  private parseAnd(): Expr {
    let left = this.parseNot()
    while (this.matchKeyword("and")) {
      const right = this.parseNot()
      left = { type: "and", left, right }
    }
    return left
  }

  private parseNot(): Expr {
    if (this.matchKeyword("not")) {
      return { type: "not", expr: this.parseNot() }
    }
    return this.parseComparison()
  }

  private parseComparison(): Expr {
    const left = this.parsePrimary()
    const token = this.peek()
    if (token.type === "op") {
      this.index += 1
      const right = this.parsePrimary()
      return { type: "cmp", op: token.value, left, right }
    }
    return left
  }

  private parsePrimary(): Expr {
    const token = this.peek()

    if (token.type === "lparen") {
      this.index += 1
      const expr = this.parseOr()
      if (this.peek().type !== "rparen") {
        throw new ConditionParseError("Expected ')'.", this.peek().pos)
      }
      this.index += 1
      return expr
    }

    if (token.type === "string") {
      this.index += 1
      return { type: "literal", value: token.value }
    }

    if (token.type === "number") {
      this.index += 1
      return { type: "literal", value: token.value }
    }

    if (token.type === "ident") {
      this.index += 1
      if (token.value === "true") return { type: "literal", value: true }
      if (token.value === "false") return { type: "literal", value: false }
      if (token.value === "null") return { type: "literal", value: null }
      if (token.value === "always") return { type: "literal", value: true }
      if (token.value === "and" || token.value === "or" || token.value === "not") {
        throw new ConditionParseError(`Unexpected keyword "${token.value}".`, token.pos)
      }

      const path = token.value.split(".")
      if (path.some((part) => part.length === 0)) {
        throw new ConditionParseError(`Invalid path "${token.value}".`, token.pos)
      }
      return { type: "path", path }
    }

    throw new ConditionParseError("Expected a value, field, or '(' expression.", token.pos)
  }

  private matchKeyword(keyword: string): boolean {
    const token = this.peek()
    if (token.type === "ident" && token.value === keyword) {
      this.index += 1
      return true
    }
    return false
  }

  private peek(): Token {
    return this.tokens[this.index] ?? { type: "eof", pos: 0 }
  }
}

class ConditionParseError extends Error {
  constructor(message: string, readonly position: number) {
    super(message)
  }
}

export function parseCondition(source: string): ParseConditionResult {
  const trimmed = source.trim()
  if (trimmed.length === 0) {
    return { ok: false, error: { message: "Condition is empty.", position: 0 } }
  }

  const tokenized = tokenize(trimmed)
  if ("error" in tokenized) return { ok: false, error: tokenized.error }

  try {
    return { ok: true, ast: new Parser(tokenized.tokens).parse() }
  } catch (err) {
    if (err instanceof ConditionParseError) {
      return { ok: false, error: { message: err.message, position: err.position } }
    }
    throw err
  }
}

export type EvalContext = Record<string, unknown>

function getPath(context: EvalContext, path: string[]): unknown {
  let current: unknown = context
  for (const part of path) {
    if (typeof current !== "object" || current === null) return undefined
    current = (current as Record<string, unknown>)[part]
  }
  return current
}

function truthy(value: unknown): boolean {
  if (value === null || value === undefined) return false
  if (typeof value === "boolean") return value
  if (typeof value === "number") return value !== 0
  if (typeof value === "string") return value.length > 0
  return true
}

function compare(op: ComparisonOp, left: unknown, right: unknown): boolean {
  if (left === undefined || right === undefined) return false

  if (op === "==") return left === right
  if (op === "!=") return left !== right

  if (typeof left === "number" && typeof right === "number") {
    return op === ">" ? left > right : op === ">=" ? left >= right : op === "<" ? left < right : left <= right
  }
  if (typeof left === "string" && typeof right === "string") {
    return op === ">" ? left > right : op === ">=" ? left >= right : op === "<" ? left < right : left <= right
  }
  return false
}

export function evaluateCondition(expr: Expr, context: EvalContext): boolean {
  switch (expr.type) {
    case "literal":
      return truthy(expr.value)
    case "path":
      return truthy(getPath(context, expr.path))
    case "not":
      return !evaluateCondition(expr.expr, context)
    case "and":
      return evaluateCondition(expr.left, context) && evaluateCondition(expr.right, context)
    case "or":
      return evaluateCondition(expr.left, context) || evaluateCondition(expr.right, context)
    case "cmp":
      return compare(expr.op, evaluateConditionValue(expr.left, context), evaluateConditionValue(expr.right, context))
  }
}

function evaluateConditionValue(expr: Expr, context: EvalContext): unknown {
  if (expr.type === "literal") return expr.value
  if (expr.type === "path") return getPath(context, expr.path)
  return evaluateCondition(expr, context)
}

export function collectPaths(expr: Expr, out: string[] = []): string[] {
  switch (expr.type) {
    case "path":
      out.push(expr.path.join("."))
      break
    case "not":
      collectPaths(expr.expr, out)
      break
    case "and":
    case "or":
      collectPaths(expr.left, out)
      collectPaths(expr.right, out)
      break
    case "cmp":
      collectPaths(expr.left, out)
      collectPaths(expr.right, out)
      break
    case "literal":
      break
  }
  return out
}

export function collectRootNodes(expr: Expr): Set<string> {
  const roots = new Set<string>()
  for (const path of collectPaths(expr)) {
    const root = path.split(".")[0]
    if (root) roots.add(root)
  }
  return roots
}

export function formatExpr(expr: Expr): string {
  switch (expr.type) {
    case "literal":
      return typeof expr.value === "string" ? JSON.stringify(expr.value) : String(expr.value)
    case "path":
      return expr.path.join(".")
    case "not":
      return `not ${formatExpr(expr.expr)}`
    case "and":
      return `${formatExpr(expr.left)} and ${formatExpr(expr.right)}`
    case "or":
      return `${formatExpr(expr.left)} or ${formatExpr(expr.right)}`
    case "cmp":
      return `${formatExpr(expr.left)} ${expr.op} ${formatExpr(expr.right)}`
  }
}
