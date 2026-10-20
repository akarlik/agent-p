export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode = 2,
    readonly hint?: string,
  ) {
    super(message)
  }
}
