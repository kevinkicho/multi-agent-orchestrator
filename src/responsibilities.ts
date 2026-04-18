// Unified model for agent capabilities that users toggle per project.
// Backs the responsibility-checklist UI and, later, the orchestrator's
// ability to reason uniformly about what each agent is expected to do.

export type ResponsibilityOwner = "supervisor" | "worker"
export type ResponsibilityCategory = "planning" | "git" | "validation" | "review" | "testing"
export type ResponsibilityStatus = "success" | "failure" | "skipped" | "unknown"

export type ResponsibilityEnforcement =
  | { kind: "directive-clause"; clause: string }
  | { kind: "post-cycle-hook"; hookId: string }
  | { kind: "capability-flag"; flag: string }

/** Per-project instance — the state the user toggles and the system observes. */
export type Responsibility = {
  id: string
  owner: ResponsibilityOwner
  label: string
  description: string
  category: ResponsibilityCategory
  enabled: boolean
  config?: Record<string, unknown>
  lastStatus?: ResponsibilityStatus
  lastRunAt?: number
  lastDetail?: string
}

/** Catalog entry — the template for a responsibility. Instantiated per project. */
export type ResponsibilityCatalogEntry = {
  id: string
  owner: ResponsibilityOwner
  label: string
  description: string
  category: ResponsibilityCategory
  defaultEnabled: boolean
  defaultConfig?: Record<string, unknown>
  enforcement: ResponsibilityEnforcement
}

export type ValidationConfigShape = {
  command?: string
  preset?: "test" | "typecheck" | "lint" | "build" | "test+typecheck"
  timeoutMs?: number
  failAction?: "warn" | "inject" | "pause"
}

export const RESPONSIBILITY_CATALOG: ResponsibilityCatalogEntry[] = [
  {
    id: "supervisor.run-validation",
    owner: "supervisor",
    label: "Run validation after each cycle",
    description: "Runs a shell command (e.g. test suite) after every CYCLE_DONE. Failures are fed back to the supervisor.",
    category: "validation",
    defaultEnabled: false,
    enforcement: { kind: "post-cycle-hook", hookId: "post-cycle-validation" },
  },
  {
    id: "supervisor.git-commit",
    owner: "supervisor",
    label: "Commit code after each cycle",
    description: "Supervisor is responsible for committing the worker's changes when the cycle completes cleanly.",
    category: "git",
    defaultEnabled: true,
    enforcement: { kind: "capability-flag", flag: "supervisorCommits" },
  },
  {
    id: "supervisor.merge-branch",
    owner: "supervisor",
    label: "Merge agent branch when stable",
    description: "Supervisor may merge the agent branch into the base branch when the project reaches a stable point.",
    category: "git",
    defaultEnabled: false,
    enforcement: { kind: "capability-flag", flag: "supervisorMerges" },
  },
  {
    id: "supervisor.plan-next-cycle",
    owner: "supervisor",
    label: "Plan next cycle actively",
    description: "Supervisor outlines concrete next steps before signalling CYCLE_DONE.",
    category: "planning",
    defaultEnabled: true,
    enforcement: {
      kind: "directive-clause",
      clause: "Before ending each cycle, outline what the next cycle should accomplish — list concrete next steps.",
    },
  },
  {
    id: "worker.write-tests",
    owner: "worker",
    label: "Write tests for new code",
    description: "Worker is expected to add tests whenever it introduces new functionality.",
    category: "testing",
    defaultEnabled: false,
    enforcement: {
      kind: "directive-clause",
      clause: "When you add new functionality, also add tests that cover the new behavior.",
    },
  },
]

function instantiate(entry: ResponsibilityCatalogEntry, enabled: boolean, config?: Record<string, unknown>): Responsibility {
  return {
    id: entry.id,
    owner: entry.owner,
    label: entry.label,
    description: entry.description,
    category: entry.category,
    enabled,
    ...(config ? { config } : entry.defaultConfig ? { config: { ...entry.defaultConfig } } : {}),
  }
}

/** Build a project's default responsibilities list from the catalog. */
export function buildDefaultResponsibilities(): Responsibility[] {
  return RESPONSIBILITY_CATALOG.map(entry => instantiate(entry, entry.defaultEnabled))
}

export function findCatalogEntry(id: string): ResponsibilityCatalogEntry | undefined {
  return RESPONSIBILITY_CATALOG.find(e => e.id === id)
}

/** Reconcile a persisted list with the current catalog:
 *  — keep user state (enabled, config, lastStatus) for known ids,
 *  — add missing catalog entries at their defaults,
 *  — drop ids no longer in the catalog,
 *  — refresh display fields (label, description, category) from the catalog. */
export function reconcileResponsibilities(existing: Responsibility[] | undefined): Responsibility[] {
  const prevById = new Map((existing ?? []).map(r => [r.id, r]))
  return RESPONSIBILITY_CATALOG.map(entry => {
    const prev = prevById.get(entry.id)
    if (prev) {
      return {
        ...prev,
        owner: entry.owner,
        label: entry.label,
        description: entry.description,
        category: entry.category,
      }
    }
    return instantiate(entry, entry.defaultEnabled)
  })
}

/** Resolve the post-cycle validation config from a project's responsibilities,
 *  falling back to the legacy `postCycleValidation` field when the responsibility
 *  isn't enabled. Returns `undefined` when no validation is configured. */
export function resolveValidationConfig(
  responsibilities: Responsibility[] | undefined,
  legacy: ValidationConfigShape | undefined,
): ValidationConfigShape | undefined {
  const r = responsibilities?.find(x => x.id === "supervisor.run-validation")
  if (r?.enabled && r.config && (r.config.command || r.config.preset)) {
    return r.config as ValidationConfigShape
  }
  return legacy
}

/** Merge a new validation config into the responsibilities list — enables the
 *  responsibility and sets its config. Returns a new list (does not mutate). */
export function applyValidationConfig(
  responsibilities: Responsibility[] | undefined,
  config: ValidationConfigShape,
): Responsibility[] {
  const list = reconcileResponsibilities(responsibilities)
  return list.map(r =>
    r.id === "supervisor.run-validation"
      ? { ...r, enabled: true, config: { ...config } }
      : r,
  )
}
