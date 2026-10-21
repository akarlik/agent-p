import { useCallback, useEffect, useMemo, useState } from "react"
import { useKeyboard, useTerminalDimensions } from "@opentui/react"
import { TextAttributes } from "@opentui/core"
import { VERSION } from "../core/version"
import { getExporter } from "../core/exporters"
import { applyPlan, DriftError } from "../core/exporters/apply"
import type { ExportPlan } from "../core/exporters/types"
import { hasBlocking, validatePack } from "../core/validate/validate"
import {
  SECTIONS,
  TARGET_LABELS,
  agentAt,
  agentDetailLines,
  agentRows,
  clampCursor,
  contextLines,
  diffLines,
  exportCheckLines,
  exportNoteLines,
  exportRows,
  exportSummaryLines,
  integrationAt,
  integrationDetailLines,
  integrationRows,
  loadTuiData,
  overviewLines,
  pipelineDetailLines,
  pipelineMermaidLines,
  pipelineOf,
  pipelineRows,
  type SectionId,
  type TuiData,
} from "./model"
import { theme } from "./theme"
import { LineView } from "./components"
import { clamp, truncateTo, windowStart } from "./text"

type Pane = "list" | "detail"
type Focus = "nav" | "body"
type Flash = { kind: "ok" | "error" | "info"; text: string }

const LIST_SECTIONS: SectionId[] = ["agents", "pipeline", "integrations", "export"]

const ZERO: Record<SectionId, number> = {
  overview: 0,
  agents: 0,
  pipeline: 0,
  integrations: 0,
  context: 0,
  export: 0,
}

export type AppProps = {
  root: string
  globalDir: string
  initialData: TuiData
  onQuit: () => void
}

function defaultTarget(data: TuiData): number {
  const configured = data.pack.pack.spec.export?.targets?.[0]
  const index = configured ? data.targets.indexOf(configured) : -1
  return index >= 0 ? index : 0
}

export function App({ root, globalDir, initialData, onQuit }: AppProps) {
  const dimensions = useTerminalDimensions()
  const [data, setData] = useState<TuiData>(initialData)
  const [section, setSection] = useState<SectionId>("overview")
  const [focus, setFocus] = useState<Focus>("nav")
  const [pane, setPane] = useState<Pane>("list")
  const [cursors, setCursors] = useState<Record<SectionId, number>>(ZERO)
  const [scrolls, setScrolls] = useState<Record<SectionId, number>>(ZERO)
  const [targetIndex, setTargetIndex] = useState(() => defaultTarget(initialData))
  const [plans, setPlans] = useState<Record<string, ExportPlan>>({})
  const [fileIndex, setFileIndex] = useState(0)
  const [force, setForce] = useState(false)
  const [busy, setBusy] = useState(false)
  const [flash, setFlash] = useState<Flash | null>(null)
  const [help, setHelp] = useState(false)
  const [mermaid, setMermaid] = useState(false)

  /* ---------------------------------------------------------------------- */
  /* Layout                                                                  */
  /* ---------------------------------------------------------------------- */

  const columns = Math.max(40, dimensions.width)
  const rows = Math.max(12, dimensions.height)
  const bodyHeight = rows - 2
  const innerHeight = Math.max(4, bodyHeight - 2)
  const navWidth = 18
  const navContent = navWidth - 2
  const listWidth = 24
  const innerWidth = columns - 2
  const afterNav = innerWidth - navWidth
  const showList = afterNav >= listWidth + 34
  const detailWidth = showList ? afterNav - listWidth : afterNav
  const detailContent = Math.max(12, detailWidth - 2)
  const listContent = listWidth - 2
  const isListSection = LIST_SECTIONS.includes(section)
  const hasList = isListSection && showList

  /* ---------------------------------------------------------------------- */
  /* Derived data                                                            */
  /* ---------------------------------------------------------------------- */

  const targetId = data.targets[targetIndex] ?? data.targets[0]
  const plan = targetId ? plans[targetId] : undefined
  const agentList = useMemo(() => agentRows(data.pack), [data])
  const pipeline = useMemo(() => pipelineOf(data.pack), [data])
  const pipelineList = useMemo(() => pipelineRows(pipeline), [pipeline])
  const integrationList = useMemo(() => integrationRows(data.pack), [data])
  const exportList = useMemo(() => exportRows(plan), [plan])
  const filePos = clampCursor(fileIndex, exportList.length)

  const listRows =
    section === "agents"
      ? agentList
      : section === "pipeline"
        ? pipelineList
        : section === "integrations"
          ? integrationList
          : section === "export"
            ? exportList
            : []

  const listCursor = section === "export" ? filePos : clampCursor(cursors[section], listRows.length)

  const detailLines = useMemo(() => {
    switch (section) {
      case "overview":
        return overviewLines(data, detailContent)
      case "agents": {
        const agent = agentAt(data.pack, clampCursor(cursors.agents, agentList.length))
        return agent
          ? agentDetailLines(agent, detailContent)
          : [{ text: "No agents defined.", fg: theme.yellow }]
      }
      case "pipeline":
        return mermaid
          ? pipelineMermaidLines(pipeline, detailContent)
          : pipelineDetailLines(pipeline, cursors.pipeline, detailContent)
      case "integrations": {
        const integration = integrationAt(data.pack, clampCursor(cursors.integrations, integrationList.length))
        return integration
          ? integrationDetailLines(integration, data.pack, detailContent)
          : [{ text: "No integrations defined.", fg: theme.dim }]
      }
      case "context":
        return contextLines(data.pack, detailContent)
      case "export": {
        if (!plan) return [{ text: "Planning…", fg: theme.dim }]
        const change = plan.changes[filePos]
        return [
          ...exportSummaryLines(plan),
          ...diffLines(change, detailContent),
          ...exportNoteLines(plan, detailContent),
          ...exportCheckLines(plan, detailContent),
        ]
      }
    }
  }, [section, data, cursors, detailContent, mermaid, pipeline, plan, filePos, agentList.length, integrationList.length])

  const maxScroll = Math.max(0, detailLines.length - innerHeight)
  const scroll = Math.min(scrolls[section], maxScroll)
  const listStart = windowStart(listCursor, innerHeight, listRows.length)

  /* ---------------------------------------------------------------------- */
  /* Actions                                                                 */
  /* ---------------------------------------------------------------------- */

  const goSection = useCallback((id: SectionId) => {
    setSection(id)
    setPane("list")
    setMermaid(false)
    setFocus("nav")
  }, [])

  const reload = useCallback(async () => {
    setBusy(true)
    try {
      const next = await loadTuiData(root, globalDir)
      setData(next)
      setPlans({})
      setFileIndex(0)
      setTargetIndex((index) => (next.targets.length > 0 ? Math.min(index, next.targets.length - 1) : 0))
      setFlash({
        kind: "ok",
        text: `Reloaded ${next.pack.agents.size} agent(s), ${next.pack.pipelines.size} pipeline(s).`,
      })
    } catch (error) {
      setFlash({ kind: "error", text: error instanceof Error ? error.message : String(error) })
    } finally {
      setBusy(false)
    }
  }, [root, globalDir])

  const switchTarget = useCallback(
    (delta: number) => {
      if (data.targets.length === 0) return
      setTargetIndex((index) => (index + delta + data.targets.length) % data.targets.length)
      setFileIndex(0)
      setScrolls((state) => ({ ...state, export: 0 }))
    },
    [data.targets.length],
  )

  const write = useCallback(async () => {
    if (busy) return
    if (!plan || !targetId) {
      setFlash({ kind: "info", text: "The export plan is still loading." })
      return
    }
    const exporter = getExporter(targetId)
    if (!exporter) return

    const targetDiagnostics = validatePack(data.pack, { targets: [targetId] })
    if (hasBlocking(targetDiagnostics)) {
      const errors = targetDiagnostics.filter((diagnostic) => diagnostic.severity === "error").length
      setFlash({ kind: "error", text: `Fix ${errors} error(s) before writing ${TARGET_LABELS[targetId]}.` })
      return
    }

    setBusy(true)
    try {
      // Re-plan immediately before writing so a file edited after the preview
      // was rendered is caught as drift instead of being overwritten.
      const fresh = await exporter.plan(data.pack)
      setPlans((state) => ({ ...state, [targetId]: fresh }))
      const result = await applyPlan(fresh, { force })
      const after = await exporter.plan(data.pack)
      setPlans((state) => ({ ...state, [targetId]: after }))
      const backedUp = result.backedUp.length > 0 ? ` · ${result.backedUp.length} backed up` : ""
      setFlash({
        kind: "ok",
        text: `Wrote ${result.written.length} file(s) for ${TARGET_LABELS[targetId]}${backedUp}.`,
      })
      setForce(false)
    } catch (error) {
      if (error instanceof DriftError) {
        setFlash({
          kind: "error",
          text: `${error.paths.length} generated file(s) were edited since export. Press f to force.`,
        })
      } else {
        setFlash({ kind: "error", text: error instanceof Error ? error.message : String(error) })
      }
    } finally {
      setBusy(false)
    }
  }, [plan, targetId, busy, data.pack, force])

  const setListCursor = useCallback(
    (value: number) => {
      if (section === "export") setFileIndex(clampCursor(value, exportList.length))
      else setCursors((state) => ({ ...state, [section]: clampCursor(value, listRows.length) }))
    },
    [section, exportList.length, listRows.length],
  )

  const moveCursor = useCallback(
    (delta: number) => {
      setListCursor(listCursor + delta)
      setScrolls((state) => ({ ...state, [section]: 0 }))
    },
    [setListCursor, listCursor, section],
  )

  const scrollBy = useCallback(
    (delta: number) => {
      setScrolls((state) => ({ ...state, [section]: clamp((state[section] ?? 0) + delta, 0, maxScroll) }))
    },
    [section, maxScroll],
  )

  /* ---------------------------------------------------------------------- */
  /* Export plans                                                            */
  /* ---------------------------------------------------------------------- */

  useEffect(() => {
    if (!targetId || plans[targetId]) return
    const exporter = getExporter(targetId)
    if (!exporter) return
    let cancelled = false
    void exporter
      .plan(data.pack)
      .then((next) => {
        if (!cancelled) setPlans((state) => ({ ...state, [targetId]: next }))
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setFlash({ kind: "error", text: error instanceof Error ? error.message : String(error) })
        }
      })
    return () => {
      cancelled = true
    }
  }, [targetId, plans, data])

  /* ---------------------------------------------------------------------- */
  /* Keyboard                                                                */
  /* ---------------------------------------------------------------------- */

  useKeyboard((key) => {
    const name = key.name

    if (help) {
      setHelp(false)
      return
    }
    if ((key.ctrl && name === "c") || name === "q") {
      onQuit()
      return
    }
    if (busy) return
    if (flash) setFlash(null)

    if (name === "?" || (name === "/" && key.shift)) {
      setHelp(true)
      return
    }
    if (name === "r") {
      void reload()
      return
    }
    if (name === "tab") {
      setFocus((state) => (state === "nav" ? "body" : "nav"))
      return
    }

    const sectionIndex = SECTIONS.findIndex((entry) => entry.id === section)
    if (/^[1-6]$/.test(name)) {
      const target = SECTIONS[Number(name) - 1]
      if (target) goSection(target.id)
      return
    }

    if (section === "export") {
      if (name === "]") {
        switchTarget(1)
        return
      }
      if (name === "[") {
        switchTarget(-1)
        return
      }
      if (name === "w") {
        void write()
        return
      }
      if (name === "f") {
        setForce((value) => !value)
        setFlash({ kind: "info", text: `Force ${force ? "off" : "on"} for the next write.` })
        return
      }
    }

    if (section === "pipeline" && name === "m" && focus === "body") {
      setMermaid((value) => !value)
      setScrolls((state) => ({ ...state, pipeline: 0 }))
      return
    }

    if (focus === "nav") {
      if (name === "up" || name === "k") {
        const next = SECTIONS[clamp(sectionIndex - 1, 0, SECTIONS.length - 1)]
        if (next) goSection(next.id)
        return
      }
      if (name === "down" || name === "j") {
        const next = SECTIONS[clamp(sectionIndex + 1, 0, SECTIONS.length - 1)]
        if (next) goSection(next.id)
        return
      }
      if (name === "right" || name === "l" || name === "return") {
        setFocus("body")
        if (LIST_SECTIONS.includes(section)) setPane("list")
        return
      }
      return
    }

    if (name === "escape") {
      setFocus("nav")
      return
    }

    if (section === "export" && (name === "right" || name === "l")) {
      switchTarget(1)
      return
    }
    if (section === "export" && (name === "left" || name === "h")) {
      switchTarget(-1)
      return
    }

    // With a narrow terminal the list pane is hidden, so the body's arrow keys
    // keep selecting items and paging scrolls the detail.
    const listFocused = isListSection && (showList ? pane === "list" : true)

    if (name === "return") {
      if (hasList) setPane((state) => (state === "list" ? "detail" : "list"))
      return
    }
    if (name === "left" || name === "h") {
      if (hasList && pane === "detail") setPane("list")
      else setFocus("nav")
      return
    }

    if (name === "up" || name === "k") {
      if (listFocused) moveCursor(-1)
      else scrollBy(-1)
      return
    }
    if (name === "down" || name === "j") {
      if (listFocused) moveCursor(1)
      else scrollBy(1)
      return
    }
    if (name === "pageup" || (key.ctrl && name === "u")) {
      scrollBy(-Math.max(1, innerHeight - 2))
      return
    }
    if (name === "pagedown" || (key.ctrl && name === "d")) {
      scrollBy(Math.max(1, innerHeight - 2))
      return
    }
    if (name === "home" || name === "g") {
      if (listFocused) moveCursor(-listRows.length)
      else setScrolls((state) => ({ ...state, [section]: 0 }))
      return
    }
    if (name === "end" || name === "G") {
      if (listFocused) moveCursor(listRows.length)
      else setScrolls((state) => ({ ...state, [section]: maxScroll }))
      return
    }
  })

  /* ---------------------------------------------------------------------- */
  /* Render                                                                  */
  /* ---------------------------------------------------------------------- */

  if (help) return <HelpView columns={columns} rows={rows} />

  const sectionLabel = SECTIONS.find((entry) => entry.id === section)?.label ?? section
  const bodyTitle =
    section === "export" && targetId
      ? ` Export · ${TARGET_LABELS[targetId]} (${targetIndex + 1}/${data.targets.length}) `
      : ` ${sectionLabel} `

  const headerTitle = `Agent P v${VERSION}`
  const headerRest = truncateTo(` · ${data.pack.pack.metadata.name} · ${data.root}`, Math.max(0, columns - headerTitle.length))

  return (
    <box width={columns} height={rows} flexDirection="column">
      <box height={1}>
        <text wrapMode="none">
          <strong>
            <span fg={theme.accent}>{headerTitle}</span>
          </strong>
          <span fg={theme.dim}>{headerRest}</span>
        </text>
      </box>

      <box
        height={bodyHeight}
        flexDirection="row"
        border
        borderStyle="rounded"
        borderColor={focus === "body" ? theme.borderFocus : theme.border}
        title={bodyTitle}
        titleColor={theme.accent}
      >
        <box
          width={navWidth}
          height={innerHeight}
          flexDirection="column"
          border={["right"]}
          borderColor={theme.border}
          paddingLeft={1}
        >
          {SECTIONS.map((entry) => {
            const selected = entry.id === section
            const highlighted = selected && focus === "nav"
            return (
              <text
                key={entry.id}
                fg={selected ? (highlighted ? theme.accent : undefined) : theme.dim}
                attributes={selected ? TextAttributes.BOLD : 0}
                wrapMode="none"
              >
                {truncateTo(`${selected ? "› " : "  "}${entry.label}`, navContent)}
              </text>
            )
          })}
        </box>

        {hasList ? (
          <box width={listWidth} height={innerHeight} flexDirection="column" paddingLeft={1} paddingRight={1}>
            {listRows.length === 0 ? (
              <text fg={theme.dim} wrapMode="none">
                {truncateTo("(none)", listContent)}
              </text>
            ) : (
              listRows
                .slice(listStart, listStart + innerHeight)
                .map((row, offset) => {
                  const index = listStart + offset
                  const selected = index === listCursor
                  const inverted = selected && focus === "body" && pane === "list"
                  return (
                    <text
                      key={`${row.id}-${index}`}
                      fg={selected ? (inverted ? undefined : theme.accent) : row.fg}
                      attributes={
                        inverted
                          ? TextAttributes.INVERSE | TextAttributes.BOLD
                          : selected
                            ? TextAttributes.BOLD
                            : TextAttributes.NONE
                      }
                      wrapMode="none"
                    >
                      {truncateTo(`${selected ? "›" : " "} ${row.label ?? row.id}`, listContent)}
                    </text>
                  )
                })
            )}
          </box>
        ) : null}

        <box flexGrow={1} height={innerHeight} flexDirection="column" paddingLeft={2}>
          {detailLines.slice(scroll, scroll + innerHeight).map((line, index) => (
            <LineView key={`${scroll + index}`} line={line} width={detailContent} />
          ))}
        </box>
      </box>

      <box height={1}>
        <text fg={flash ? (flash.kind === "error" ? theme.red : flash.kind === "ok" ? theme.green : theme.dim) : theme.dim} wrapMode="none">
          {truncateTo(footerText(flash, busy, section, focus, pane, hasList, force), columns)}
        </text>
      </box>
    </box>
  )
}

function footerText(
  flash: Flash | null,
  busy: boolean,
  section: SectionId,
  focus: Focus,
  pane: Pane,
  hasList: boolean,
  force: boolean,
): string {
  if (busy) return "Working…"
  if (flash) return flash.text
  if (section === "export") {
    return `[ ] target · ↑↓ file · enter pane · w write${force ? " · FORCE" : ""} · f force · r reload · ? help · q quit`
  }
  if (focus === "nav") return "↑↓ section · → open · tab body · ? help · q quit"
  if (hasList) {
    return pane === "list"
      ? "↑↓ select · → detail · ← back · tab nav · ? help · q quit"
      : "↑↓ scroll · ← list · tab nav · ? help · q quit"
  }
  return "↑↓ scroll · tab nav · ? help · q quit"
}

function HelpView({ columns, rows }: { columns: number; rows: number }) {
  const width = Math.max(20, columns - 6)
  const lines: { text: string; bold?: boolean; fg?: string }[] = [
    { text: "Sections", bold: true, fg: theme.accent },
    { text: "  1 Overview   2 Agents   3 Pipeline   4 Integrations   5 Context   6 Export" },
    { text: "" },
    { text: "Navigation", bold: true, fg: theme.accent },
    { text: "  ↑/↓ or j/k     move in the sidebar, a list, or scroll the detail pane" },
    { text: "  → / enter      open the selected item or move into the body" },
    { text: "  ← / esc        go back (detail → list → sidebar)" },
    { text: "  tab            switch between sidebar and body" },
    { text: "  pgup / pgdn    scroll a page · home / end or g / G jump" },
    { text: "  m              in Pipeline, toggle the Mermaid source" },
    { text: "" },
    { text: "Validation & export", bold: true, fg: theme.accent },
    { text: "  In Export, [ and ] (or ←/→) switch target." },
    { text: "  w writes the current plan; generated files are backed up first." },
    { text: "  f toggles force, needed when a generated agent or orchestrator" },
    { text: "  file was edited since the last export. A pack with errors cannot" },
    { text: "  be written." },
    { text: "" },
    { text: "General", bold: true, fg: theme.accent },
    { text: "  r reload the pack from disk · ? close help · q quit" },
  ]
  return (
    <box width={columns} height={rows} flexDirection="column" padding={1}>
      <text fg={theme.accent} attributes={TextAttributes.BOLD} wrapMode="none">
        Agent P v{VERSION} · help
      </text>
      <box flexGrow={1} border borderStyle="rounded" borderColor={theme.border} flexDirection="column" padding={1}>
        {lines.map((line, index) => (
          <text key={index} fg={line.fg} attributes={line.bold ? TextAttributes.BOLD : 0} wrapMode="none">
            {truncateTo(line.text, width)}
          </text>
        ))}
      </box>
      <text fg={theme.dim} wrapMode="none">
        any key to close
      </text>
    </box>
  )
}
