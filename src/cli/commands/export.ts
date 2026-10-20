import { resolve } from "node:path"
import { findProjectRoot, globalConfigDir } from "../../core/fs/paths"
import { resolvePack } from "../../core/resolve/resolve"
import { hasBlocking, validatePack } from "../../core/validate/validate"
import { getExporter } from "../../core/exporters"
import { applyPlan, DriftError } from "../../core/exporters/apply"
import { colorizeDiff } from "../../core/exporters/diff"
import type { ExportPlan } from "../../core/exporters/types"
import { VERSION } from "../../core/version"
import { CliError } from "../errors"
import { banner, c, heading, printCounts, printDiagnostics, useColor } from "../ui"
import { parseTargets } from "./validate"

export type ExportOptions = {
  target?: string
  dryRun?: boolean
  yes?: boolean
  force?: boolean
  allIntegrations?: boolean
}

function actionLabel(action: "create" | "update" | "unchanged"): string {
  if (action === "create") return c.green("create")
  if (action === "update") return c.yellow("update")
  return c.dim("unchanged")
}

function printPlan(plan: ExportPlan, includeUnchanged: boolean): void {
  const changed = plan.changes.filter((change) => change.action !== "unchanged")
  const unchanged = plan.changes.filter((change) => change.action === "unchanged")

  console.log(heading(`Export · ${plan.target}`))

  if (changed.length === 0) {
    console.log(c.dim("  Already up to date."))
  }

  for (const change of plan.changes) {
    if (change.action === "unchanged" && !includeUnchanged) continue
    const drift = change.drifted ? c.red(" (edited since last export)") : ""
    console.log(`  ${actionLabel(change.action)} ${change.path}${drift}`)
    if (change.diff) {
      console.log("")
      console.log(colorizeDiff(change.diff, useColor()))
      console.log("")
    }
  }

  if (plan.notes.length > 0) {
    console.log(heading("Notes"))
    for (const note of plan.notes) console.log(`  ${c.dim("·")} ${note}`)
  }

  if (plan.diagnostics.length > 0) {
    console.log("")
    printDiagnostics(plan.diagnostics)
  }

  console.log("")
  console.log(
    `  ${changed.filter((change) => change.action === "create").length} create · ` +
      `${changed.filter((change) => change.action === "update").length} update · ` +
      `${unchanged.length} unchanged`,
  )
}

export async function runExport(cwd: string, options: ExportOptions): Promise<number> {
  if (options.yes && options.dryRun) {
    throw new CliError("--yes and --dry-run cannot be used together.", 2)
  }

  const root = findProjectRoot(cwd)
  if (!root) {
    throw new CliError(
      `No .agentp directory found from ${resolve(cwd)}.`,
      2,
      "Run `agentp init` to create a pack, or pass -C <dir>.",
    )
  }

  const pack = await resolvePack({ root, globalDir: globalConfigDir() })
  const explicit = parseTargets(options.target)
  const configured = pack.pack.spec.export?.targets ?? []
  const targets = explicit.length > 0 ? explicit : configured.length > 0 ? configured : ["opencode"]

  const diagnostics = validatePack(pack, { targets })
  if (hasBlocking(diagnostics)) {
    console.log(`${banner(VERSION)} ${c.dim("· export")}`)
    console.log(c.dim(root))
    console.log("")
    printDiagnostics(diagnostics)
    console.log("")
    console.log(`${c.red("✗")} Fix the errors above before exporting. ${printCounts(diagnostics)}`)
    return 1
  }

  console.log(`${banner(VERSION)} ${c.dim("· export")}`)
  console.log(c.dim(root))
  if (diagnostics.length > 0) {
    console.log("")
    printDiagnostics(diagnostics)
  }

  const plans: ExportPlan[] = []
  for (const target of targets) {
    const exporter = getExporter(target)
    if (!exporter) {
      throw new CliError(
        `Unknown or unavailable export target "${target}".`,
        2,
        "Available targets: opencode. Claude Code and Codex exporters are planned.",
      )
    }

    const plan = await exporter.plan(pack, {
      includeUnusedIntegrations: options.allIntegrations,
    })
    plans.push(plan)
    printPlan(plan, false)

    if (hasBlocking(plan.diagnostics)) {
      console.log(`${c.red("✗")} ${target} export has errors; nothing was written.`)
      return 1
    }
  }

  const pending = plans.flatMap((plan) => plan.changes.filter((change) => change.action !== "unchanged"))

  if (options.dryRun || !options.yes) {
    console.log("")
    if (pending.length === 0) {
      console.log(c.green("✓") + " Nothing to write.")
    } else {
      console.log(
        `${c.cyan("Preview only.")} ${pending.length} file${pending.length === 1 ? "" : "s"} would be written. ` +
          c.dim("Re-run with --yes to apply."),
      )
    }
    return 0
  }

  if (pending.length === 0) {
    console.log("")
    console.log(c.green("✓") + " Nothing to write.")
    return 0
  }

  let written = 0
  let backups = 0
  for (const plan of plans) {
    try {
      const result = await applyPlan(plan, { force: options.force })
      written += result.written.length
      backups += result.backedUp.length
    } catch (error) {
      if (error instanceof DriftError) {
        console.log("")
        console.log(`${c.red("✗")} ${error.message}`)
        console.log(c.dim("Use --force to overwrite the hand-edited files, or revert them to the generated version."))
        return 1
      }
      throw error
    }
  }

  console.log("")
  console.log(`${c.green("✓")} Wrote ${written} file${written === 1 ? "" : "s"}.`)
  if (backups > 0) {
    console.log(c.dim(`  Backups: .agentp/state/backups/`))
  }
  console.log(c.dim("  Export manifest: .agentp/state/export.lock.json"))
  return 0
}
