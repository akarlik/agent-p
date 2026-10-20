import { describe, expect, test } from "bun:test"
import { hasManagedBlock, managedBlock, upsertManagedBlock } from "../src/core/fs/managed"

describe("managed blocks", () => {
  test("creates a block for an empty file", () => {
    const text = upsertManagedBlock("", "context", "Hello")
    expect(text).toBe(`${managedBlock("context", "Hello")}\n`)
    expect(hasManagedBlock(text, "context")).toBe(true)
  })

  test("appends to existing content", () => {
    const text = upsertManagedBlock("# Repo\n\nKeep me.\n", "context", "Hello")
    expect(text.startsWith("# Repo\n\nKeep me.")).toBe(true)
    expect(text).toContain("<!-- agentp:begin id=context -->")
    expect(hasManagedBlock(text, "context")).toBe(true)
  })

  test("replaces a block without touching surrounding text", () => {
    const first = upsertManagedBlock("# Repo\n\nKeep me.\n", "context", "One")
    const second = upsertManagedBlock(`before\n\n${first}\n\nafter\n`, "context", "Two")
    expect(second).toContain("before")
    expect(second).toContain("after")
    expect(second).toContain("Two")
    expect(second).not.toContain("One")
    expect(second.split("<!-- agentp:begin id=context -->").length).toBe(2)
  })

  test("keeps different ids independent", () => {
    const text = upsertManagedBlock(upsertManagedBlock("", "context", "One"), "agents", "Two")
    expect(hasManagedBlock(text, "context")).toBe(true)
    expect(hasManagedBlock(text, "agents")).toBe(true)
  })
})
