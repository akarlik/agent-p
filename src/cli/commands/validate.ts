import { resolve } from "node:path"
import { findProjectRoot, globalConfigDir } from "../../core/fs/paths"
import { resolvePack } from "../../core/resolve/resolve"
import { hasBlocking, validatePack } from "../../core/validate/validate"
import { countBySeverity } from "../../core/diagnostics"
import { VERSION } from "../../core/version"
import { CliError } from "../errors"
import { banner, c, printCounts, printDiagnostics, printPackSummary } from "../ui"

export function parseTargets(input?: string): string[] {
  if (!input) return []
  return [...new Set(input.split(",").map((part) => part.trim()).filter(Boolean))]
}

export type ValidateOptions = {
  strict?: boolean
  json?: boolean
  target?: string
}

export async function runValidate(cwd: string, options: ValidateOptions): Promise<number> {
  const root = findProjectRoot(cwd)
  if (!root) {
    throw new CliError(
      `No .agentp directory found from ${resolve(cwd)}.`,
      2,
      "Run `agentp init` to create a pack, or pass -C <dir>.",
    )
  }

  const pack = await resolvePack({ root, globalDir: globalConfigDir() })
  const targets = parseTargets(options.target)
  const diagnostics = validatePack(pack, { targets, strict: options.strict })
  const blocking = hasBlocking(diagnostics, options.strict)

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          ok: !blocking,
          version: VERSION,
          project: { root, name: pack.pack.metadata.name },
          counts: countBySeverity(diagnostics),
          diagnostics,
          summary: {
            agents: [...pack.agents.keys()],
            pipelines: [...pack.pipelines.keys()],
            contexts: [...pack.contexts.keys()],
            integrations: [...pack.integrations.keys()],
            providers: [...pack.providers.keys()],
          },
        },
        null,
        2,
      ),
    )
    return blocking ? 1 : 0
  }

  console.log(`${banner(VERSION)} ${c.dim("· validate")}`)
  console.log(c.dim(root))
  console.log("")

  printDiagnostics(diagnostics)

  if (diagnostics.length === 0) {
    console.log(`${c.green("✓")} No issues found.`)
  }

  console.log("")
  console.log(
    `${printPackSummary({
      agents: pack.agents.size,
      pipelines: pack.pipelines.size,
      contexts: pack.contexts.size,
      integrations: pack.integrations.size,
      providers: pack.providers.size,
    })} ${c.dim("·")} ${printCounts(diagnostics)}`,
  )

  if (options.strict && diagnostics.some((diagnostic) => diagnostic.severity === "warning")) {
    console.log(c.yellow("Strict mode: warnings are treated as errors."))
  }

  return blocking ? 1 : 0
}
