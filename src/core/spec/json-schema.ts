import { z } from "zod"
import { DocumentSchema } from "./schema"

export function generateJsonSchema(): Record<string, unknown> {
  const schema = z.toJSONSchema(DocumentSchema, {
    target: "draft-2020-12",
    io: "output",
  }) as Record<string, unknown>

  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://agentp.dev/schemas/agentp.schema.json",
    title: "Agent P pack document",
    description: "One document from an Agent P pack: Agent, Pipeline, Context, Integration, Provider, or Pack.",
    ...schema,
  }
}
