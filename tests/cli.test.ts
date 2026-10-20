import { afterAll, describe, expect, test } from "bun:test"
import { join } from "node:path"
import { readTextIfExists, writeTextAtomic } from "../src/core/fs/paths"
import { cleanupTempDirs, tempDir } from "./helpers"

afterAll(cleanupTempDirs)

const CLI = join(import.meta.dir, "../src/cli/index.ts")

async function run(args: string[], cwd: string) {
  const proc = Bun.spawn(["bun", "run", CLI, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { stdout, stderr, exitCode }
}

describe("CLI", () => {
  test(
    "init, validate, export, drift, and force",
    async () => {
      const root = await tempDir()

      const init = await run(["-C", root, "init"], root)
      expect(init.exitCode).toBe(0)
      expect(init.stdout).toContain("Created an Agent P pack")

      const validate = await run(["-C", root, "validate", "--json"], root)
      expect(validate.exitCode).toBe(0)
      const report = JSON.parse(validate.stdout)
      expect(report.ok).toBe(true)
      expect(report.summary.agents).toHaveLength(8)
      expect(report.counts.error).toBe(0)

      const schema = await run(["-C", root, "schema"], root)
      expect(schema.exitCode).toBe(0)
      expect(schema.stdout).toContain('"title": "Agent P pack document"')

      const exported = await run(["-C", root, "export", "--target", "opencode", "--yes"], root)
      expect(exported.exitCode).toBe(0)
      expect(await readTextIfExists(join(root, ".opencode/agents/reviewer.md"))).toContain("mode: subagent")
      expect(await readTextIfExists(join(root, ".opencode/agents/feature-delivery-orchestrator.md"))).toContain(
        "mode: primary",
      )

      const target = join(root, ".opencode/agents/reviewer.md")
      const original = await readTextIfExists(target)
      await writeTextAtomic(target, `${original}\n<!-- hand edit -->\n`)

      const drift = await run(["-C", root, "export", "--target", "opencode", "--yes"], root)
      expect(drift.exitCode).toBe(1)
      expect(drift.stdout).toContain("changed since the last export")

      const forced = await run(["-C", root, "export", "--target", "opencode", "--yes", "--force"], root)
      expect(forced.exitCode).toBe(0)
      expect(await readTextIfExists(target)).not.toContain("<!-- hand edit -->")

      const empty = await tempDir()
      const missing = await run(["-C", empty, "validate"], empty)
      expect(missing.exitCode).toBe(2)
      expect(missing.stderr).toContain("No .agentp directory")
    },
    30_000,
  )
})
