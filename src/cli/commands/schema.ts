import { resolve } from "node:path"
import { writeTextAtomic } from "../../core/fs/paths"
import { generateJsonSchema } from "../../core/spec/json-schema"
import { c } from "../ui"

export async function runSchema(cwd: string, options: { out?: string }): Promise<number> {
  const schema = generateJsonSchema()
  const text = `${JSON.stringify(schema, null, 2)}\n`

  if (options.out) {
    const target = resolve(cwd, options.out)
    await writeTextAtomic(target, text)
    console.log(`${c.green("✓")} Wrote ${target}`)
  } else {
    process.stdout.write(text)
  }

  return 0
}
