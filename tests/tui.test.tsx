import { describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { act } from "react"
import { testRender } from "@opentui/react/test-utils"
import { App } from "../src/tui/app"
import { loadTuiData } from "../src/tui/model"
import { scaffold } from "./helpers"

async function setup(
  width = 110,
  height = 32,
  mutate?: (root: string) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), "agentp-tui-"))
  const globalDir = join(root, "global")
  await mkdir(globalDir, { recursive: true })
  await scaffold(root)
  if (mutate) await mutate(root)
  const data = await loadTuiData(root, globalDir)
  let quit = false
  const view = await testRender(
    <App
      root={root}
      globalDir={globalDir}
      initialData={data}
      onQuit={() => {
        quit = true
      }}
    />,
    { width, height },
  )
  // Keyboard input is wired up in the renderer's constructor; rendering is
  // driven manually so every React update happens inside act().
  // Let the startup export plan resolve before the first assertion.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50))
    await view.renderOnce()
  })
  await view.flush()

  const settle = async () => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
      await view.renderOnce()
      await view.flush()
    })
  }
  const press = async (key: string) => {
    await act(async () => {
      view.mockInput.pressKey(key)
    })
    await settle()
  }
  const arrow = async (direction: "up" | "down" | "left" | "right") => {
    await act(async () => {
      view.mockInput.pressArrow(direction)
    })
    await settle()
  }
  const waitFor = async (text: string) => {
    await act(async () => {
      for (let pass = 0; pass < 50; pass++) {
        if (view.captureCharFrame().includes(text)) return
        await new Promise((resolve) => setTimeout(resolve, 20))
        await view.renderOnce()
      }
      throw new Error(`timed out waiting for "${text}"`)
    })
    // Drain follow-up work (for example the re-plan after a write) inside act.
    await act(async () => {
      for (let pass = 0; pass < 4; pass++) {
        await new Promise((resolve) => setTimeout(resolve, 20))
        await view.renderOnce()
      }
      await view.flush()
    })
  }

  return {
    view,
    root,
    frame: () => view.captureCharFrame(),
    press,
    arrow,
    waitFor,
    settle,
    quitCalled: () => quit,
    async dispose() {
      await act(async () => {
        await view.dispose()
      })
      await rm(root, { recursive: true, force: true })
    },
  }
}

describe("tui", () => {
  test("renders the overview with the pack summary", async () => {
    const app = await setup()
    try {
      const frame = app.frame()
      expect(frame).toContain("Agent P v")
      expect(frame).toContain("test-project")
      expect(frame).toContain("Overview")
      expect(frame).toContain("feature-delivery")
      expect(frame).toContain("Agents")
      expect(frame).toContain("Export targets")
      expect(frame).toContain("OpenCode")
    } finally {
      await app.dispose()
    }
  })

  test("navigates to an agent and shows its configuration", async () => {
    const app = await setup()
    try {
      await app.arrow("down")
      await app.arrow("right")
      expect(app.frame()).toContain("architect")

      const first = app.frame()
      expect(first).toContain("Configuration")
      expect(first).toContain("Tools")
      expect(first).toContain("Prompt")

      await app.arrow("down")
      const second = app.frame()
      expect(second).toContain("implementer")
      expect(second).not.toEqual(first)
    } finally {
      await app.dispose()
    }
  })

  test("scrolls long content", async () => {
    const app = await setup()
    try {
      await app.press("5")
      await app.arrow("right")
      expect(app.frame()).toContain("Rendered instructions")

      await app.press("\x1B[6~")
      expect(app.frame()).not.toContain("Rendered instructions")
    } finally {
      await app.dispose()
    }
  })

  test("shows the pipeline flow and toggles the Mermaid source", async () => {
    const app = await setup()
    try {
      await app.press("3")
      await app.arrow("right")
      expect(app.frame()).toContain("feature-delivery")
      expect(app.frame()).toContain("Stage")
      expect(app.frame()).toContain("Flow")

      await app.press("m")
      expect(app.frame()).toContain("Mermaid")
      expect(app.frame()).toContain("flowchart")

      await app.press("m")
      expect(app.frame()).toContain("Flow")
    } finally {
      await app.dispose()
    }
  })

  test("switches export target and writes the plan", async () => {
    const app = await setup()
    try {
      await app.press("6")
      await app.waitFor("create")
      expect(app.frame()).toContain("Export · OpenCode")

      await app.press("]")
      await app.waitFor(".claude/agents/architect.md")
      expect(app.frame()).toContain("Export · Claude Code")

      await app.press("]")
      await app.waitFor(".codex/agents/architect.toml")
      expect(app.frame()).toContain("Export · Codex CLI")

      await app.press("[")
      await app.press("[")
      await app.waitFor(".opencode/agents/architect.md")

      await app.press("w")
      await app.waitFor("Wrote")
      await stat(join(app.root, ".opencode", "agents", "architect.md"))
      const generated = join(app.root, ".opencode", "agents", "architect.md")
      const written = await readFile(generated, "utf8")
      expect(written).toContain("mode: subagent")

      // A hand edit is caught on the next write instead of being overwritten.
      await writeFile(generated, `${written}\n<!-- edited by hand -->\n`)
      await app.press("w")
      await app.waitFor("Press f to force")
      expect(await readFile(generated, "utf8")).toContain("edited by hand")

      await app.press("f")
      await app.press("w")
      await app.waitFor("Wrote")
      expect(await readFile(generated, "utf8")).not.toContain("edited by hand")
    } finally {
      await app.dispose()
    }
  })

  test("refuses to write while the pack has errors", async () => {
    const app = await setup(110, 32, async (root) => {
      const path = join(root, ".agentp", "pipeline", "feature-delivery.yaml")
      const text = await readFile(path, "utf8")
      await writeFile(path, text.replace("agent: architect", "agent: ghost"))
    })
    try {
      expect(app.frame()).toContain("1 error")
      await app.press("6")
      await app.waitFor("create")
      await app.press("w")
      await app.waitFor("before writing")
      expect(app.frame()).toContain("Fix 1 error(s) before writing")
      await expect(stat(join(app.root, ".opencode", "agents", "architect.md"))).rejects.toThrow()
    } finally {
      await app.dispose()
    }
  })

  test("lists integrations with connection and auth details", async () => {
    const app = await setup(110, 32, async (root) => {
      await mkdir(join(root, ".agentp", "integrations"), { recursive: true })
      await writeFile(
        join(root, ".agentp", "integrations", "linear.yaml"),
        [
          "apiVersion: agentp/v1",
          "kind: Integration",
          "metadata:",
          "  name: linear",
          "  description: Linear issue tracking over MCP",
          "spec:",
          "  type: mcp",
          "  transport: remote",
          "  url: https://mcp.linear.example/sse",
          "  auth:",
          "    kind: bearer",
          "    env: LINEAR_API_KEY",
          "  scopes: [read, write]",
          "",
        ].join("\n"),
      )
    })
    try {
      await app.press("4")
      await app.arrow("right")
      const frame = app.frame()
      expect(frame).toContain("Linear issue tracking over MCP")
      expect(frame).toContain("https://mcp.linear.example/sse")
      expect(frame).toContain("LINEAR_API_KEY")
      expect(frame).toContain("no agent grants this server")
    } finally {
      await app.dispose()
    }
  })

  test("reloads the pack from disk", async () => {
    const app = await setup()
    try {
      expect(app.frame()).toContain("8")

      const source = join(app.root, ".agentp", "agents", "architect.yaml")
      const copy = join(app.root, ".agentp", "agents", "auditor.yaml")
      const text = await readFile(source, "utf8")
      await writeFile(copy, text.replace("name: architect", "name: auditor"))

      await app.press("r")
      await app.waitFor("Reloaded")
      expect(app.frame()).toContain("9")
    } finally {
      await app.dispose()
    }
  })

  test("keeps working when the terminal is narrow", async () => {
    const app = await setup()
    try {
      await app.press("2")
      await app.arrow("right")
      expect(app.frame()).toContain("Configuration")

      await act(async () => {
        app.view.resize(70, 20)
      })
      await app.settle()
      await app.arrow("down")
      const frame = app.frame()
      expect(frame).toContain("Agent P")
      expect(frame).toContain("implementer")
    } finally {
      await app.dispose()
    }
  })

  test("shows help and quits", async () => {
    const app = await setup()
    try {
      await app.press("?")
      expect(app.frame()).toContain("Navigation")
      expect(app.frame()).toContain("Validation & export")

      await app.press("escape")
      expect(app.frame()).not.toContain("Validation & export")

      await app.press("q")
      expect(app.quitCalled()).toBe(true)
    } finally {
      await app.dispose()
    }
  })
})
