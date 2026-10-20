import { createTwoFilesPatch } from "diff"

export function unifiedDiff(path: string, before: string, after: string): string | undefined {
  if (before === after) return undefined
  return createTwoFilesPatch(path, path, before, after, "", "", { context: 3 })
}

export function colorizeDiff(diff: string, color: boolean): string {
  if (!color) return diff
  return diff
    .split("\n")
    .map((line) => {
      if (line.startsWith("+++") || line.startsWith("---")) return `\u001b[1m${line}\u001b[0m`
      if (line.startsWith("@@")) return `\u001b[36m${line}\u001b[0m`
      if (line.startsWith("+")) return `\u001b[32m${line}\u001b[0m`
      if (line.startsWith("-")) return `\u001b[31m${line}\u001b[0m`
      return line
    })
    .join("\n")
}
