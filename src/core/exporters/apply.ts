import { join } from "node:path"
import { backupFile, timestamp, writeTextAtomic } from "../fs/paths"
import { recordFiles, readManifest, writeManifest } from "./manifest"
import type { ApplyResult, ExportPlan } from "./types"

export class DriftError extends Error {
  constructor(readonly paths: string[]) {
    super(`Generated files changed since the last export: ${paths.join(", ")}`)
  }
}

export async function applyPlan(
  plan: ExportPlan,
  options: { force?: boolean; dryRun?: boolean } = {},
): Promise<ApplyResult> {
  const pending = plan.changes.filter((change) => change.action !== "unchanged")

  const drifted = pending.filter((change) => change.drifted).map((change) => change.path)
  if (drifted.length > 0 && !options.force) {
    throw new DriftError(drifted)
  }

  const manifest = await readManifest(plan.root)
  const written: string[] = []
  const backedUp: string[] = []
  const unchanged = plan.changes.filter((change) => change.action === "unchanged").map((change) => change.path)
  const stamp = timestamp()

  if (options.dryRun) {
    return { written: [], backedUp: [], unchanged }
  }

  for (const change of pending) {
    const absolute = join(plan.root, change.path)
    const backup = await backupFile(plan.root, change.path, stamp)
    if (backup) backedUp.push(backup)
    await writeTextAtomic(absolute, change.contents)
    written.push(change.path)
  }

  recordFiles(
    manifest,
    plan.target,
    plan.changes.map((change) => ({ path: change.path, contents: change.contents, kind: change.kind })),
  )
  await writeManifest(plan.root, manifest)

  return { written, backedUp, unchanged }
}
