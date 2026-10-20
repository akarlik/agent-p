import { join } from "node:path"
import { readTextIfExists, sha256, writeTextAtomic } from "../fs/paths"

export type ManifestFile = {
  hash: string
  kind: string
}

export type Manifest = {
  version: 1
  tool: string
  generatedAt?: string
  targets: Record<string, { files: Record<string, ManifestFile> }>
}

export function emptyManifest(): Manifest {
  return { version: 1, tool: "agent-p", targets: {} }
}

export function manifestPath(root: string): string {
  return join(root, ".agentp", "state", "export.lock.json")
}

export async function readManifest(root: string): Promise<Manifest> {
  const text = await readTextIfExists(manifestPath(root))
  if (!text) return emptyManifest()
  try {
    const parsed = JSON.parse(text) as Partial<Manifest>
    if (parsed.version !== 1 || typeof parsed.targets !== "object" || parsed.targets === null) {
      return emptyManifest()
    }
    return {
      version: 1,
      tool: parsed.tool ?? "agent-p",
      generatedAt: parsed.generatedAt,
      targets: parsed.targets as Manifest["targets"],
    }
  } catch {
    return emptyManifest()
  }
}

export async function writeManifest(root: string, manifest: Manifest): Promise<void> {
  manifest.tool = "agent-p"
  manifest.generatedAt = new Date().toISOString()
  await writeTextAtomic(manifestPath(root), `${JSON.stringify(manifest, null, 2)}\n`)
}

export function recordFiles(
  manifest: Manifest,
  target: string,
  files: { path: string; contents: string; kind: string }[],
): void {
  const existing = manifest.targets[target] ?? { files: {} }
  const next: Record<string, ManifestFile> = { ...existing.files }
  for (const file of files) {
    next[file.path] = { hash: sha256(file.contents), kind: file.kind }
  }
  manifest.targets[target] = { files: next }
}
