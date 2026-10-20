export function managedBlock(id: string, body: string): string {
  return `<!-- agentp:begin id=${id} -->\n${body.trim()}\n<!-- agentp:end id=${id} -->`
}

function blockPattern(id: string): RegExp {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return new RegExp(`<!-- agentp:begin id=${escaped} -->[\\s\\S]*?<!-- agentp:end id=${escaped} -->`)
}

export function hasManagedBlock(text: string, id: string): boolean {
  return blockPattern(id).test(text)
}

export function upsertManagedBlock(text: string, id: string, body: string): string {
  const block = managedBlock(id, body)
  const pattern = blockPattern(id)
  if (pattern.test(text)) {
    return text.replace(pattern, block)
  }
  if (text.trim().length === 0) return `${block}\n`
  return `${text.replace(/\s+$/, "")}\n\n${block}\n`
}
