export type Line = {
  text: string
  fg?: string
  bold?: boolean
  dim?: boolean
}

export function truncateTo(text: string, width: number): string {
  if (width <= 0) return ""
  if (text.length <= width) return text
  if (width === 1) return "…"
  return `${text.slice(0, width - 1)}…`
}

export function padRight(text: string, width: number): string {
  if (text.length >= width) return text
  return text + " ".repeat(width - text.length)
}

/** Greedy word wrap. Long words are split at the width so nothing is dropped. */
export function wrapText(text: string, width: number): string[] {
  if (width <= 0) return []
  const out: string[] = []

  for (const raw of text.replace(/\r\n/g, "\n").split("\n")) {
    if (raw.length === 0) {
      out.push("")
      continue
    }

    let line = ""
    for (const word of raw.split(/\s+/).filter(Boolean)) {
      if (word.length > width) {
        if (line) {
          out.push(line)
          line = ""
        }
        for (let index = 0; index < word.length; index += width) {
          out.push(word.slice(index, index + width))
        }
        continue
      }
      if (!line) line = word
      else if (line.length + 1 + word.length <= width) line += ` ${word}`
      else {
        out.push(line)
        line = word
      }
    }
    if (line) out.push(line)
  }

  return out
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

/** Keeps the cursor visible inside a scrolling list of `rows` visible rows. */
export function windowStart(cursor: number, rows: number, total: number): number {
  if (rows <= 0) return 0
  return clamp(cursor - rows + 1, 0, Math.max(0, total - rows))
}
