import { resolve } from "node:path"
import { findProjectRoot, globalConfigDir } from "../../core/fs/paths"
import { CliError } from "../errors"

export async function runUi(cwd: string): Promise<number> {
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    throw new CliError(
      "The interactive interface needs a terminal.",
      2,
      "Run `agentp validate` or `agentp export` in this environment instead.",
    )
  }

  const root = findProjectRoot(cwd)
  if (!root) {
    throw new CliError(
      `No .agentp directory found from ${resolve(cwd)}.`,
      2,
      "Run `agentp init` to create a pack, or pass -C <dir>.",
    )
  }

  const { runTui } = await import("../../tui")
  return runTui(root, globalConfigDir())
}
