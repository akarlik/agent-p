import { createHash, randomBytes } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, readdir, readFile, rename, rm, stat, writeFile, copyFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"

export function expandHome(input: string): string {
  if (input === "~") return homedir()
  if (input.startsWith("~/")) return join(homedir(), input.slice(2))
  return input
}

export function globalConfigDir(): string {
  if (process.env.AGENTP_HOME) return resolve(expandHome(process.env.AGENTP_HOME))
  const base = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config")
  return join(base, "agentp")
}

export function projectDir(root: string): string {
  return join(root, ".agentp")
}

/** Walks up from `start` looking for a `.agentp` directory. */
export function findProjectRoot(start = process.cwd()): string | null {
  let current = resolve(start)
  while (true) {
    if (existsSync(join(current, ".agentp"))) return current
    const parent = dirname(current)
    if (parent === current) return null
    current = parent
  }
}

export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true })
}

export async function readText(path: string): Promise<string> {
  return readFile(path, "utf8")
}

export async function readTextIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8")
  } catch {
    return null
  }
}

export async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

export async function writeTextAtomic(path: string, contents: string): Promise<void> {
  await ensureDir(dirname(path))
  const temp = `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`
  await writeFile(temp, contents, "utf8")
  try {
    await rename(temp, path)
  } catch (err) {
    await rm(temp, { force: true })
    throw err
  }
}

export async function backupFile(root: string, rel: string, stamp: string): Promise<string | null> {
  const source = join(root, rel)
  if (!existsSync(source)) return null
  const target = join(root, ".agentp", "state", "backups", stamp, rel)
  await ensureDir(dirname(target))
  await copyFile(source, target)
  return target
}

export async function listYamlFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    return entries
      .filter((e) => e.isFile() && (e.name.endsWith(".yaml") || e.name.endsWith(".yml")))
      .map((e) => join(dir, e.name))
      .sort()
  } catch {
    return []
  }
}

export function sha256(contents: string): string {
  return createHash("sha256").update(contents).digest("hex")
}

export function toRelative(root: string, path: string): string {
  const rel = relative(root, path)
  return rel.length === 0 ? "." : rel
}

export function resolveWithin(root: string, path: string): string {
  return isAbsolute(path) ? path : resolve(root, path)
}

export function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel)
}

export function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-")
}
