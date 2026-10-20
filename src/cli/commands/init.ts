import { basename, join, resolve } from "node:path"
import { exists, writeTextAtomic } from "../../core/fs/paths"
import { sdlcTemplate } from "../../core/templates/sdlc"
import { CliError } from "../errors"
import { c } from "../ui"

export async function runInit(cwd: string, options: { force?: boolean; template?: string }): Promise<void> {
  const root = resolve(cwd)
  const dir = join(root, ".agentp")

  if ((await exists(dir)) && !options.force) {
    throw new CliError(
      `${dir} already exists.`,
      1,
      "Use --force to overwrite the generated files, or run `agentp validate` to check the existing pack.",
    )
  }

  const template = options.template ?? "sdlc"
  if (template !== "sdlc") {
    throw new CliError(`Unknown template "${template}".`, 2, "Available templates: sdlc")
  }

  const projectName = basename(root) || "agent-pack"
  const files = sdlcTemplate(projectName)

  for (const file of files) {
    await writeTextAtomic(join(root, file.path), file.contents)
  }

  console.log(`${c.green("✓")} Created an Agent P pack in ${c.bold(".agentp/")}`)
  const agentCount = files.filter((file) => file.path.startsWith(".agentp/agents/")).length
  const pipelineCount = files.filter((file) => file.path.startsWith(".agentp/pipeline/")).length
  console.log(
    c.dim(
      `  ${files.length} files · ${agentCount} agents · ${pipelineCount} pipeline · template: ${template}`,
    ),
  )
  console.log("")
  console.log("Next:")
  console.log(`  ${c.cyan("agentp validate")}                         check the pack`)
  console.log(`  ${c.cyan("agentp export --target opencode")}        preview the export`)
  console.log(`  ${c.cyan("agentp export --target opencode --yes")}  write the files`)
  console.log("")
  console.log(c.dim("Edit the prompts in .agentp/prompts/ and the roles in .agentp/agents/."))
}
