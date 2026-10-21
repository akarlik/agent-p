#!/usr/bin/env bun
import { resolve } from "node:path"
import { Command } from "commander"
import { findProjectRoot } from "../core/fs/paths"
import { PRODUCT, VERSION } from "../core/version"
import { CliError } from "./errors"
import { runValidate } from "./commands/validate"
import { runExport } from "./commands/export"
import { runInit } from "./commands/init"
import { runSchema } from "./commands/schema"
import { c } from "./ui"

const program = new Command()

program
  .name("agentp")
  .description(`${PRODUCT} — design, validate, and export AI agent teams and SDLC pipelines.`)
  .version(VERSION, "-v, --version", "print the version")
  .option("-C, --cwd <dir>", "run as if started in <dir>", process.cwd())

function cwd(): string {
  return resolve(program.opts().cwd ?? process.cwd())
}

program
  .command("init")
  .description("Scaffold a full-SDLC pack in .agentp/")
  .option("-f, --force", "overwrite an existing .agentp directory")
  .option("--template <name>", "starter template", "sdlc")
  .action(async (options: { force?: boolean; template?: string }) => {
    await runInit(cwd(), options)
  })

program
  .command("validate")
  .description("Check schema, references, graph, and exporter compatibility")
  .option("--strict", "treat warnings as errors")
  .option("--json", "print machine-readable JSON")
  .option("-t, --target <targets>", "comma-separated export targets to check")
  .action(async (options: { strict?: boolean; json?: boolean; target?: string }) => {
    process.exitCode = await runValidate(cwd(), options)
  })

program
  .command("export")
  .description("Preview or write runtime configuration")
  .option("-t, --target <targets>", "comma-separated targets (opencode, claude-code, codex)")
  .option("--dry-run", "preview without writing")
  .option("-y, --yes", "write the generated files")
  .option("-f, --force", "overwrite files edited since the last export")
  .option("--all-integrations", "include integrations that no agent references")
  .action(
    async (options: {
      target?: string
      dryRun?: boolean
      yes?: boolean
      force?: boolean
      allIntegrations?: boolean
    }) => {
      process.exitCode = await runExport(cwd(), options)
    },
  )

program
  .command("ui")
  .description("Open the interactive terminal interface")
  .action(async () => {
    const { runUi } = await import("./commands/ui")
    process.exitCode = await runUi(cwd())
  })

program
  .command("schema")
  .description("Print or write the JSON Schema for the pack format")
  .option("-o, --out <path>", "write the schema to a file")
  .action(async (options: { out?: string }) => {
    process.exitCode = await runSchema(cwd(), options)
  })

program.action(async () => {
  if (process.stdout.isTTY && process.stdin.isTTY && findProjectRoot(cwd())) {
    const { runUi } = await import("./commands/ui")
    process.exitCode = await runUi(cwd())
    return
  }
  console.log(`${c.teal("Agent P")} ${c.dim(`v${VERSION}`)} — design, validate, and export AI agent teams.\n`)
  console.log(c.dim("Run inside a project with an .agentp/ pack to open the interactive interface."))
  console.log(c.dim("Run `agentp init` to create one.\n"))
  program.help()
})

async function main(): Promise<void> {
  try {
    await program.parseAsync(process.argv)
  } catch (error) {
    if (error instanceof CliError) {
      console.error(`${c.red("error:")} ${error.message}`)
      if (error.hint) console.error(c.dim(`hint: ${error.hint}`))
      process.exitCode = error.exitCode
      return
    }
    console.error(`${c.red("error:")} ${error instanceof Error ? error.message : String(error)}`)
    if (process.env.AGENTP_DEBUG && error instanceof Error && error.stack) {
      console.error(error.stack)
    }
    process.exitCode = 2
  }
}

await main()
