import { TextAttributes } from "@opentui/core"
import type { Line } from "./text"
import { padRight, truncateTo } from "./text"

export function LineView({ line, width }: { line: Line; width: number }) {
  let attributes = TextAttributes.NONE
  if (line.bold) attributes |= TextAttributes.BOLD
  if (line.dim) attributes |= TextAttributes.DIM

  return (
    <text fg={line.fg} attributes={attributes} wrapMode="none">
      {padRight(truncateTo(line.text, width), width)}
    </text>
  )
}
