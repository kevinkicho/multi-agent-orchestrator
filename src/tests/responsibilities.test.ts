import { describe, test, expect } from "bun:test"
import {
  RESPONSIBILITY_CATALOG,
  buildDefaultResponsibilities,
  reconcileResponsibilities,
  resolveValidationConfig,
  applyValidationConfig,
  type Responsibility,
} from "../responsibilities"

describe("responsibilities catalog", () => {
  test("catalog has unique ids", () => {
    const ids = RESPONSIBILITY_CATALOG.map(e => e.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  test("buildDefaultResponsibilities returns one entry per catalog item", () => {
    const defaults = buildDefaultResponsibilities()
    expect(defaults.length).toBe(RESPONSIBILITY_CATALOG.length)
    for (const entry of RESPONSIBILITY_CATALOG) {
      const r = defaults.find(d => d.id === entry.id)
      expect(r).toBeDefined()
      expect(r!.enabled).toBe(entry.defaultEnabled)
    }
  })
})

describe("reconcileResponsibilities", () => {
  test("preserves user state for known ids", () => {
    const existing: Responsibility[] = [{
      id: "supervisor.run-validation",
      owner: "supervisor",
      label: "(old label)",
      description: "(old)",
      category: "validation",
      enabled: true,
      config: { command: "bun test" },
    }]
    const reconciled = reconcileResponsibilities(existing)
    const r = reconciled.find(x => x.id === "supervisor.run-validation")!
    expect(r.enabled).toBe(true)
    expect(r.config).toEqual({ command: "bun test" })
    // Display fields refreshed from catalog
    expect(r.label).not.toBe("(old label)")
  })

  test("drops unknown ids", () => {
    const existing: Responsibility[] = [{
      id: "legacy.gone",
      owner: "supervisor",
      label: "x",
      description: "x",
      category: "review",
      enabled: true,
    }]
    const reconciled = reconcileResponsibilities(existing)
    expect(reconciled.find(r => r.id === "legacy.gone")).toBeUndefined()
  })

  test("adds missing catalog entries at defaults", () => {
    const reconciled = reconcileResponsibilities([])
    expect(reconciled.length).toBe(RESPONSIBILITY_CATALOG.length)
  })
})

describe("resolveValidationConfig", () => {
  test("returns responsibility config when enabled", () => {
    const resps = applyValidationConfig(undefined, { command: "bun test" })
    const resolved = resolveValidationConfig(resps, { command: "old legacy" })
    expect(resolved?.command).toBe("bun test")
  })

  test("falls back to legacy when responsibility is disabled", () => {
    const resps = buildDefaultResponsibilities() // run-validation defaultEnabled=false
    const resolved = resolveValidationConfig(resps, { command: "legacy" })
    expect(resolved?.command).toBe("legacy")
  })

  test("returns undefined when neither is configured", () => {
    const resolved = resolveValidationConfig(buildDefaultResponsibilities(), undefined)
    expect(resolved).toBeUndefined()
  })

  test("ignores responsibility with no command/preset", () => {
    const resps: Responsibility[] = [{
      id: "supervisor.run-validation",
      owner: "supervisor",
      label: "x", description: "x", category: "validation",
      enabled: true,
      config: {}, // enabled but empty
    }]
    const resolved = resolveValidationConfig(resps, { command: "legacy" })
    expect(resolved?.command).toBe("legacy")
  })
})

describe("applyValidationConfig", () => {
  test("enables the responsibility and sets its config", () => {
    const resps = applyValidationConfig(undefined, { preset: "test", failAction: "inject" })
    const r = resps.find(x => x.id === "supervisor.run-validation")!
    expect(r.enabled).toBe(true)
    expect(r.config).toEqual({ preset: "test", failAction: "inject" })
  })

  test("leaves other responsibilities untouched", () => {
    const before = buildDefaultResponsibilities()
    const after = applyValidationConfig(before, { command: "bun test" })
    for (const r of after) {
      if (r.id === "supervisor.run-validation") continue
      const prev = before.find(b => b.id === r.id)!
      expect(r.enabled).toBe(prev.enabled)
    }
  })
})
