import { readTextIfExists, sha256 } from "../fs/paths"
import { unifiedDiff } from "./diff"
import { readManifest } from "./manifest"
import type { FileAction, FileChange, FileKind } from "./types"

export async function makeChange(options: {
  root: string
  path: string
  contents: string
  kind: FileKind
  target: string
  manifestFiles: Record<string, { hash: string }>
}): Promise<FileChange> {
  const existing = await readTextIfExists(`${options.root}/${options.path}`)
  const previous = options.manifestFiles[options.path]
  const action: FileAction = existing === null ? "create" : existing === options.contents ? "unchanged" : "update"
  // Only fully generated files are protected from hand edits. Config and AGENTS.md
  // preserve user content, so editing them should not require --force.
  const owned = options.kind === "agent" || options.kind === "orchestrator"
  const drifted =
    owned &&
    previous !== undefined &&
    existing !== null &&
    existing !== options.contents &&
    sha256(existing) !== previous.hash

  return {
    path: options.path,
    contents: options.contents,
    action,
    kind: options.kind,
    diff: action === "unchanged" ? undefined : unifiedDiff(options.path, existing ?? "", options.contents),
    drifted,
  }
}

export async function manifestFilesFor(root: string, target: string): Promise<Record<string, { hash: string }>> {
  const manifest = await readManifest(root)
  return manifest.targets[target]?.files ?? {}
}
