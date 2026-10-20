/**
 * Keys that conventionally hold credentials. These are replaced with an
 * environment placeholder at export time so literal values never reach disk.
 */
export function isSecretKey(key: string): boolean {
  return (
    /(^|_)(TOKEN|SECRET|PASSWORD)$/i.test(key) ||
    /(^|_)(API|PRIVATE)_KEY$/i.test(key) ||
    /(^|_)SECRET.*(KEY|TOKEN)$/i.test(key)
  )
}

export function isEnvPlaceholder(value: string): boolean {
  return /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(value) || /^\{env:[A-Za-z_][A-Za-z0-9_]*\}$/.test(value)
}
