import { stringifyDoc } from "../spec/parse"

export type TemplateFile = {
  path: string
  contents: string
}

type Blueprint = {
  id: string
  description: string
  prompt: string
  model: string
  temperature: number
  builtin: string[]
  permissions: Record<string, unknown>
  handoffs: string[]
  output: { format: "markdown" | "json"; required: string[] }
  maxTurns: number
  writes: string
}

const SONNET = "claude-sonnet-4-5"
const HAIKU = "claude-haiku-4-5"

const blueprints: Blueprint[] = [
  {
    id: "product-discovery",
    description: "Turns a rough request into a clear problem statement, constraints, and success criteria.",
    model: HAIKU,
    temperature: 0.3,
    builtin: ["read", "grep", "glob", "list", "edit", "webfetch"],
    permissions: {
      edit: { "*": "deny", "discovery.md": "allow" },
      bash: "deny",
      task: "deny",
    },
    handoffs: ["requirements"],
    output: { format: "markdown", required: ["Problem", "Success criteria"] },
    maxTurns: 20,
    writes: "discovery.md",
    prompt: `You are the product discovery agent for a software delivery pipeline.

Your job is to turn a rough request into a clear, testable problem statement before anyone designs or builds.

Inputs
- The request from the user or ticket.
- The project context and commands in AGENTS.md.

Work
1. Restate the problem in one paragraph.
2. Identify the users, their jobs, and the constraints that matter.
3. Separate facts from assumptions. List open questions in risk order.
4. Define measurable success criteria.
5. State what is explicitly out of scope.

Rules
- Do not propose a solution.
- Do not write code.
- Ask at most three blocking questions. If the request is already unambiguous, say so.

Output
Write discovery.md with these sections: Problem, Users, Constraints, Assumptions, Open questions, Success criteria, Out of scope.

End with:
status: success
`,
  },
  {
    id: "requirements",
    description: "Converts discovery into user stories and testable acceptance criteria.",
    model: SONNET,
    temperature: 0.2,
    builtin: ["read", "grep", "glob", "list", "edit"],
    permissions: {
      edit: { "*": "deny", "requirements.md": "allow" },
      bash: "deny",
      task: "deny",
    },
    handoffs: ["architect"],
    output: { format: "markdown", required: ["User stories", "Acceptance criteria"] },
    maxTurns: 25,
    writes: "requirements.md",
    prompt: `You are the requirements agent.

Inputs
- discovery.md
- The project context in AGENTS.md.

Work
- Convert the problem into user stories in the form: As a <user>, I want <capability>, so that <outcome>.
- Write acceptance criteria in Given/When/Then form.
- Cover happy paths, edge cases, error states, permissions, and data limits.
- Add non-functional requirements: performance, security, accessibility, observability.
- Call out dependencies and risks.
- Flag anything that cannot be verified.

Rules
- Every acceptance criterion must be independently testable.
- Do not design the implementation.
- Do not write code.

Output
Write requirements.md with: Summary, User stories, Acceptance criteria, Non-functional requirements, Edge cases, Dependencies and risks.

End with:
status: success
`,
  },
  {
    id: "architect",
    description: "Designs the smallest viable architecture and records the tradeoffs.",
    model: SONNET,
    temperature: 0.2,
    builtin: ["read", "grep", "glob", "list", "edit"],
    permissions: {
      edit: { "*": "deny", "design.md": "allow" },
      bash: "deny",
      task: "deny",
    },
    handoffs: ["task-planner"],
    output: { format: "markdown", required: ["Decision", "Risks"] },
    maxTurns: 30,
    writes: "design.md",
    prompt: `You are the software architect.

Inputs
- discovery.md and requirements.md
- The existing codebase and project context in AGENTS.md.

Work
- Read the code around the change before designing.
- Propose two to four viable options.
- Choose one and justify it against the constraints.
- Describe components, data flow, API contracts, and state changes.
- Call out failure modes, migration, rollout, and rollback.
- Prefer existing patterns and dependencies.

Rules
- Do not introduce a dependency without a written justification.
- Do not implement the change. Small illustrative snippets are allowed.
- If the requirements are contradictory, stop and say so.

Output
Write design.md with: Context, Options, Decision, Data flow, Interfaces, Failure modes, Migration and rollout, Risks.

End with:
status: success
`,
  },
  {
    id: "task-planner",
    description: "Breaks the design into ordered, independently verifiable implementation tasks.",
    model: SONNET,
    temperature: 0.2,
    builtin: ["read", "grep", "glob", "list", "edit"],
    permissions: {
      edit: { "*": "deny", "tasks.md": "allow" },
      bash: "deny",
      task: "deny",
    },
    handoffs: ["implementer"],
    output: { format: "markdown", required: ["Tasks", "Definition of done"] },
    maxTurns: 25,
    writes: "tasks.md",
    prompt: `You are the delivery planner.

Inputs
- design.md and requirements.md
- The project context in AGENTS.md.

Work
- Break the design into ordered, independently verifiable tasks.
- For each task include: id, goal, files, dependencies, acceptance check, and test.
- Mark tasks that can run in parallel.
- Keep each task small enough for one focused agent run.
- Include a rollback note and a final verification task.

Rules
- Do not implement anything.
- Do not invent file paths without checking the repository.
- Every task must have a concrete acceptance check.

Output
Write tasks.md with: Task list, Parallel groups, Rollback notes, Definition of done.

End with:
status: success
`,
  },
  {
    id: "implementer",
    description: "Implements planned tasks with the smallest defensible change and keeps tests green.",
    model: SONNET,
    temperature: 0.2,
    builtin: ["read", "edit", "bash", "grep", "glob", "list"],
    permissions: {
      edit: "ask",
      bash: {
        "*": "ask",
        "bun test*": "allow",
        "bun run lint*": "allow",
        "bun run build*": "allow",
        "bun run typecheck*": "allow",
        "git status*": "allow",
        "git diff*": "allow",
        "git push*": "deny",
        "rm *": "deny",
      },
      task: "deny",
    },
    handoffs: ["tester"],
    output: { format: "markdown", required: ["Summary", "Tests"] },
    maxTurns: 60,
    writes: "code and tests",
    prompt: `You are the implementation agent.

Inputs
- tasks.md, design.md, requirements.md
- The repository and the project context in AGENTS.md.

Rules
- Read the relevant files before editing.
- Make the smallest defensible change.
- Follow existing patterns. Do not refactor unrelated code.
- Add or update tests with each behavior change.
- Run the test, lint, and build commands from AGENTS.md.
- Never touch secrets, credentials, or generated files.
- If a task is ambiguous, stop and report the ambiguity instead of guessing.
- Do not run destructive commands.

Work
Work through tasks.md in order. After each task, run its acceptance check.

Output
End with: summary, files changed, commands run and results, and remaining tasks.

End with:
status: success | failed
`,
  },
  {
    id: "tester",
    description: "Verifies the change against acceptance criteria and reports coverage gaps.",
    model: HAIKU,
    temperature: 0.1,
    builtin: ["read", "grep", "glob", "list", "bash", "edit"],
    permissions: {
      edit: { "*": "deny", "test-report.md": "allow" },
      bash: {
        "*": "ask",
        "bun test*": "allow",
        "bun run lint*": "allow",
        "bun run build*": "allow",
        "bun run typecheck*": "allow",
        "git diff*": "allow",
        "git status*": "allow",
      },
      task: "deny",
    },
    handoffs: ["reviewer", "implementer"],
    output: { format: "markdown", required: ["Verdict", "Coverage"] },
    maxTurns: 40,
    writes: "test-report.md",
    prompt: `You are the verification agent.

Inputs
- requirements.md
- The change under review.
- The commands in AGENTS.md.

Work
- Run the test, lint, and build commands.
- Map every acceptance criterion to an automated test or a manual check.
- Probe edge cases, error paths, and permission boundaries.
- Note flaky, slow, or missing tests.

Rules
- Do not modify application code.
- Add tests only when the task explicitly asks for them.
- Report a failure with exact reproduction steps.

Output
Write test-report.md with: Verdict, Commands and results, Acceptance coverage table, Failures, Gaps and risks.

End with:
status: passed | failed
`,
  },
  {
    id: "reviewer",
    description: "Reviews the change for correctness, security, regressions, and missing tests.",
    model: SONNET,
    temperature: 0.1,
    builtin: ["read", "grep", "glob", "list", "edit"],
    permissions: {
      edit: { "*": "deny", "review.json": "allow" },
      bash: "deny",
      task: "deny",
    },
    handoffs: ["tech-writer", "implementer"],
    output: { format: "json", required: ["verdict", "findings"] },
    maxTurns: 30,
    writes: "review.json",
    prompt: `You are the code reviewer.

Review for correctness, security, data loss, race conditions, performance regressions, API compatibility, and missing tests. Ignore style unless it hides a bug.

Rules
- Every finding must cite a file and line.
- Do not request a change without a concrete failure scenario.
- Do not modify application code.

Output
Write review.json:
{
  "verdict": "approved" or "changes_requested",
  "summary": "one paragraph",
  "findings": [
    { "severity": "blocker|major|minor", "file": "path", "line": 0, "issue": "...", "suggestion": "..." }
  ],
  "missing_tests": ["..."]
}

End with:
verdict: approved | changes_requested
`,
  },
  {
    id: "tech-writer",
    description: "Updates documentation and writes the pull request narrative.",
    model: HAIKU,
    temperature: 0.3,
    builtin: ["read", "grep", "glob", "list", "edit"],
    permissions: {
      edit: {
        "*": "deny",
        "README.md": "allow",
        "CHANGELOG.md": "allow",
        "docs/**": "allow",
      },
      bash: "deny",
      task: "deny",
    },
    handoffs: [],
    output: { format: "markdown", required: ["Summary", "Test plan"] },
    maxTurns: 25,
    writes: "docs and README",
    prompt: `You are the technical writer.

Inputs
- All pipeline artifacts and the final change.
- The project context in AGENTS.md.

Work
- Update README or docs for behavior, configuration, and API changes.
- Add a changelog entry when the project keeps one.
- Write a pull request description: problem, approach, risks, test plan, rollout.
- Keep it concise and specific.

Rules
- No marketing language.
- Do not document behavior that is not implemented.
- Do not change application code.

End with:
status: success
`,
  },
]

function agentYaml(blueprint: Blueprint): string {
  return stringifyDoc({
    apiVersion: "agentp/v1",
    kind: "Agent",
    metadata: {
      name: blueprint.id,
      description: blueprint.description,
      tags: ["sdlc"],
    },
    spec: {
      prompt: { file: `../prompts/${blueprint.id}.md` },
      model: {
        provider: "anthropic",
        id: blueprint.model,
        temperature: blueprint.temperature,
      },
      tools: {
        builtin: blueprint.builtin,
        permissions: blueprint.permissions,
        mcp: [],
      },
      handoffs: blueprint.handoffs,
      output: blueprint.output,
      limits: { maxTurns: blueprint.maxTurns },
    },
  })
}

function pipelineYaml(): string {
  return stringifyDoc({
    apiVersion: "agentp/v1",
    kind: "Pipeline",
    metadata: {
      name: "feature-delivery",
      description: "Discovery to documentation, with bounded test and review loops.",
    },
    spec: {
      entry: "discovery",
      defaults: { onFailure: "stop", maxIterations: 3 },
      nodes: [
        { id: "discovery", agent: "product-discovery", outputs: ["discovery.md"] },
        { id: "requirements", agent: "requirements", outputs: ["requirements.md"] },
        { id: "design", agent: "architect", outputs: ["design.md"] },
        { id: "plan", agent: "task-planner", outputs: ["tasks.md"] },
        { id: "implement", agent: "implementer", outputs: [] },
        { id: "test", agent: "tester", outputs: ["test-report.md"] },
        { id: "review", agent: "reviewer", outputs: ["review.json"] },
        { id: "docs", agent: "tech-writer", outputs: [] },
      ],
      edges: [
        { from: "discovery", to: "requirements" },
        { from: "requirements", to: "design" },
        { from: "design", to: "plan" },
        { from: "plan", to: "implement" },
        { from: "implement", to: "test" },
        { from: "test", to: "review", when: 'test.status == "passed"' },
        {
          from: "test",
          to: "implement",
          when: 'test.status == "failed"',
          maxIterations: 3,
        },
        { from: "review", to: "docs", when: 'review.verdict == "approved"' },
        {
          from: "review",
          to: "implement",
          when: 'review.verdict == "changes_requested"',
          maxIterations: 2,
        },
      ],
    },
  })
}

function contextYaml(): string {
  return stringifyDoc({
    apiVersion: "agentp/v1",
    kind: "Context",
    metadata: {
      name: "project",
      description: "Project-wide commands, conventions, and definition of done.",
    },
    spec: {
      files: [],
      include: [],
      commands: {
        test: "bun test",
        lint: "bun run lint",
        build: "bun run build",
        typecheck: "bun run typecheck",
      },
      conventions: [
        "- Follow the patterns already in the repository.",
        "- Prefer the smallest change that satisfies the requirement.",
        "- Do not refactor unrelated code.",
        "- Never commit secrets or generated files.",
        "- Use conventional commit messages.",
      ].join("\n"),
      definitionOfDone: [
        "- Acceptance criteria have automated tests where practical.",
        "- Test suite, lint, build, and typecheck pass.",
        "- No new warnings in changed files.",
        "- Documentation is updated when behavior or configuration changes.",
        "- The change is small enough to review in one sitting.",
      ].join("\n"),
    },
  })
}

function providerYaml(): string {
  return stringifyDoc({
    apiVersion: "agentp/v1",
    kind: "Provider",
    metadata: {
      name: "anthropic",
      description: "Anthropic API",
    },
    spec: {
      type: "anthropic",
      baseUrl: "https://api.anthropic.com",
      auth: {
        secretRef: "anthropic-api-key",
        env: "ANTHROPIC_API_KEY",
      },
      models: [],
    },
  })
}

export function sdlcTemplate(projectName: string): TemplateFile[] {
  const files: TemplateFile[] = []

  files.push({
    path: ".agentp/pack.yaml",
    contents: stringifyDoc({
      apiVersion: "agentp/v1",
      kind: "Pack",
      metadata: {
        name: projectName,
        description: `Agent pack for ${projectName}.`,
        version: "0.1.0",
      },
      spec: {
        defaultPipeline: "feature-delivery",
        defaultContext: "project",
        builderModel: { provider: "anthropic", id: SONNET },
      },
    }),
  })

  files.push({ path: ".agentp/pipeline/feature-delivery.yaml", contents: pipelineYaml() })
  files.push({ path: ".agentp/context/project.yaml", contents: contextYaml() })
  files.push({ path: ".agentp/providers/anthropic.yaml", contents: providerYaml() })

  for (const blueprint of blueprints) {
    files.push({ path: `.agentp/prompts/${blueprint.id}.md`, contents: blueprint.prompt })
    files.push({ path: `.agentp/agents/${blueprint.id}.yaml`, contents: agentYaml(blueprint) })
  }

  files.push({
    path: ".agentp/README.md",
    contents: `# Agent pack

This directory is the source of truth for the ${projectName} agent team.

- \`agents/\` defines roles, models, tools, and handoffs.
- \`pipeline/\` defines the delivery graph.
- \`context/\` defines commands and conventions.
- \`providers/\` declares where credentials come from. Secrets are never stored here.
- \`prompts/\` holds the long-form system prompts.

## Commands

\`\`\`bash
agentp validate
agentp export --target opencode --dry-run
agentp export --target opencode --yes
\`\`\`

Agents inherit from the global library at \`~/.config/agentp/\` when names match.
Local fields override global fields.
`,
  })

  files.push({
    path: ".agentp/.gitignore",
    contents: "state/\n",
  })

  return files
}
