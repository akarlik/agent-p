import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { sdlcTemplate, type TemplateFile } from "../src/core/templates/sdlc"

const created: string[] = []

export async function tempDir(prefix = "agentp-test-"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  created.push(dir)
  return dir
}

export async function cleanupTempDirs(): Promise<void> {
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
}

export async function writeFiles(root: string, files: TemplateFile[]): Promise<void> {
  for (const file of files) {
    const path = join(root, file.path)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, file.contents, "utf8")
  }
}

export async function scaffold(root: string): Promise<void> {
  await writeFiles(root, sdlcTemplate("test-project"))
}
