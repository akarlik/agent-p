import { z } from "zod"

export const API_VERSION = "agentp/v1"
export const KINDS = ["Agent", "Pipeline", "Context", "Integration", "Provider", "Pack"] as const

export const NameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*$/, "Use lowercase letters, digits, and dashes; start with a letter or digit.")

export const BUILTIN_TOOLS = [
  "read",
  "write",
  "edit",
  "apply_patch",
  "bash",
  "grep",
  "glob",
  "list",
  "webfetch",
  "websearch",
  "task",
  "skill",
  "question",
  "external_directory",
  "lsp",
] as const

export type BuiltinTool = (typeof BUILTIN_TOOLS)[number]

export const PermissionActionSchema = z.enum(["allow", "ask", "deny"])
export type PermissionAction = z.infer<typeof PermissionActionSchema>

const PermissionRuleSchema = z.union([
  PermissionActionSchema,
  z.record(z.string(), PermissionActionSchema),
])

export const ModelRefSchema = z
  .object({
    provider: z.string().min(1),
    id: z.string().min(1),
    temperature: z.number().min(0).max(2).optional(),
    maxOutputTokens: z.number().int().positive().optional(),
    reasoningEffort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
  })
  .strict()

export const PromptSchema = z.union([
  z.object({ file: z.string().min(1) }).strict(),
  z.object({ inline: z.string().min(1) }).strict(),
])

export const ToolsSchema = z
  .object({
    builtin: z.array(z.string()).default([]),
    permissions: z.record(z.string(), PermissionRuleSchema).default({}),
    mcp: z.array(z.string()).default([]),
  })
  .strict()

export const AgentSchema = z
  .object({
    apiVersion: z.literal(API_VERSION),
    kind: z.literal("Agent"),
    metadata: z
      .object({
        name: NameSchema,
        description: z.string().min(10, "Describe when this agent should be used (at least 10 characters)."),
        tags: z.array(z.string()).default([]),
        owner: z.string().optional(),
      })
      .strict(),
    spec: z
      .object({
        extends: NameSchema.optional(),
        prompt: PromptSchema.optional(),
        model: ModelRefSchema.optional(),
        tools: ToolsSchema.default({ builtin: [], permissions: {}, mcp: [] }),
        handoffs: z.array(NameSchema).default([]),
        output: z
          .object({
            format: z.enum(["markdown", "json", "text"]).default("markdown"),
            required: z.array(z.string()).default([]),
          })
          .strict()
          .optional(),
        limits: z
          .object({
            maxTurns: z.number().int().positive().optional(),
          })
          .strict()
          .optional(),
        notes: z.string().optional(),
      })
      .strict(),
  })
  .strict()

export const PipelineNodeSchema = z
  .object({
    id: NameSchema,
    agent: NameSchema,
    outputs: z.array(z.string()).default([]),
    notes: z.string().optional(),
  })
  .strict()

export const PipelineEdgeSchema = z
  .object({
    from: NameSchema,
    to: NameSchema,
    when: z.string().default("always"),
    label: z.string().optional(),
    maxIterations: z.number().int().positive().optional(),
  })
  .strict()

export const PipelineSchema = z
  .object({
    apiVersion: z.literal(API_VERSION),
    kind: z.literal("Pipeline"),
    metadata: z
      .object({
        name: NameSchema,
        description: z.string().min(10),
      })
      .strict(),
    spec: z
      .object({
        entry: NameSchema,
        defaults: z
          .object({
            onFailure: z.enum(["stop", "continue"]).default("stop"),
            maxIterations: z.number().int().positive().default(3),
          })
          .strict()
          .default({ onFailure: "stop", maxIterations: 3 }),
        nodes: z.array(PipelineNodeSchema).min(1),
        edges: z.array(PipelineEdgeSchema).default([]),
      })
      .strict(),
  })
  .strict()

export const AuthSchema = z
  .object({
    kind: z.enum(["bearer", "basic", "oauth2", "apiKey", "aws", "gcp", "none"]),
    secretRef: z.string().optional(),
    env: z.string().optional(),
    header: z.string().optional(),
  })
  .strict()

export const IntegrationSchema = z
  .object({
    apiVersion: z.literal(API_VERSION),
    kind: z.literal("Integration"),
    metadata: z
      .object({
        name: NameSchema,
        description: z.string().min(5),
        category: z.string().optional(),
      })
      .strict(),
    spec: z
      .object({
        type: z.literal("mcp").default("mcp"),
        transport: z.enum(["remote", "local"]),
        url: z.string().url().optional(),
        command: z.array(z.string()).optional(),
        environment: z.record(z.string(), z.string()).default({}),
        auth: AuthSchema.optional(),
        scopes: z.array(z.string()).default([]),
        tools: z.array(z.string()).default([]),
        check: z
          .object({
            adapter: z.string().optional(),
            path: z.string().optional(),
          })
          .strict()
          .optional(),
        notes: z.string().optional(),
      })
      .strict(),
  })
  .strict()
  .superRefine((doc, ctx) => {
    if (doc.spec.transport === "remote" && !doc.spec.url) {
      ctx.addIssue({
        code: "custom",
        path: ["spec", "url"],
        message: "Remote integrations require a URL.",
      })
    }
    if (doc.spec.transport === "local" && (!doc.spec.command || doc.spec.command.length === 0)) {
      ctx.addIssue({
        code: "custom",
        path: ["spec", "command"],
        message: "Local integrations require a command.",
      })
    }
  })

export const ContextSchema = z
  .object({
    apiVersion: z.literal(API_VERSION),
    kind: z.literal("Context"),
    metadata: z
      .object({
        name: NameSchema,
        description: z.string().optional(),
      })
      .strict(),
    spec: z
      .object({
        files: z.array(z.string()).default([]),
        include: z.array(z.string()).default([]),
        commands: z.record(z.string(), z.string()).default({}),
        conventions: z.string().optional(),
        definitionOfDone: z.string().optional(),
      })
      .strict(),
  })
  .strict()

export const ProviderSchema = z
  .object({
    apiVersion: z.literal(API_VERSION),
    kind: z.literal("Provider"),
    metadata: z
      .object({
        name: NameSchema,
        description: z.string().optional(),
      })
      .strict(),
    spec: z
      .object({
        type: z.enum(["anthropic", "openai", "openai-compatible", "ollama"]),
        baseUrl: z.string().url().optional(),
        auth: z
          .object({
            secretRef: z.string().optional(),
            env: z.string().optional(),
          })
          .strict()
          .optional(),
        models: z.array(z.string()).default([]),
      })
      .strict(),
  })
  .strict()
  .superRefine((doc, ctx) => {
    if (doc.spec.type === "openai-compatible" && !doc.spec.baseUrl) {
      ctx.addIssue({
        code: "custom",
        path: ["spec", "baseUrl"],
        message: "openai-compatible providers require a baseUrl.",
      })
    }
  })

export const PackSchema = z
  .object({
    apiVersion: z.literal(API_VERSION),
    kind: z.literal("Pack"),
    metadata: z
      .object({
        name: z.string().min(1),
        description: z.string().min(1),
        version: z.string().default("0.1.0"),
      })
      .strict(),
    spec: z
      .object({
        defaultPipeline: NameSchema.optional(),
        defaultContext: NameSchema.optional(),
        builderModel: ModelRefSchema.optional(),
        export: z
          .object({
            targets: z.array(z.enum(["opencode", "claude-code", "codex"])).default([]),
            modelMap: z.record(z.string(), z.string()).default({}),
          })
          .strict()
          .optional(),
      })
      .strict()
      .default({}),
  })
  .strict()

export const DocumentSchema = z.discriminatedUnion("kind", [
  AgentSchema,
  PipelineSchema,
  ContextSchema,
  IntegrationSchema,
  ProviderSchema,
  PackSchema,
])

export type AgentDoc = z.infer<typeof AgentSchema>
export type PipelineDoc = z.infer<typeof PipelineSchema>
export type ContextDoc = z.infer<typeof ContextSchema>
export type IntegrationDoc = z.infer<typeof IntegrationSchema>
export type ProviderDoc = z.infer<typeof ProviderSchema>
export type PackDoc = z.infer<typeof PackSchema>
export type ModelRef = z.infer<typeof ModelRefSchema>
export type PipelineNode = z.infer<typeof PipelineNodeSchema>
export type PipelineEdge = z.infer<typeof PipelineEdgeSchema>

export const SCHEMA_BY_KIND = {
  Agent: AgentSchema,
  Pipeline: PipelineSchema,
  Context: ContextSchema,
  Integration: IntegrationSchema,
  Provider: ProviderSchema,
  Pack: PackSchema,
} as const

export type Kind = keyof typeof SCHEMA_BY_KIND
