import { createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"
import { App } from "./app"
import { loadTuiData } from "./model"

/**
 * Starts the interactive interface. The pack is resolved before the first frame
 * so the TUI never renders a loading state on startup.
 */
export async function runTui(root: string, globalDir: string): Promise<number> {
  const data = await loadTuiData(root, globalDir)
  const renderer = await createCliRenderer({ exitOnCtrlC: false, useMouse: false })
  renderer.setTerminalTitle(`Agent P · ${data.pack.pack.metadata.name}`)

  const reactRoot = createRoot(renderer)

  await new Promise<void>((resolve) => {
    let closed = false
    const quit = () => {
      if (closed) return
      closed = true
      renderer.destroy()
      void renderer.closed.then(() => resolve())
    }
    reactRoot.render(<App root={root} globalDir={globalDir} initialData={data} onQuit={quit} />)
  })

  return 0
}
