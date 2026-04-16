// ---------------------------------------------------------------------------
// Analytics — session tracking, snapshots, AI evaluation, A/B comparison
// ---------------------------------------------------------------------------

import { resolve } from "path"
import { readJsonFile, writeJsonFile } from "./file-utils"
import { chatCompletion } from "./brain"
import { gitExec } from "./git-utils"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Point-in-time capture of project git state */
export type Snapshot = {
  id: string
  timestamp: number
  agentName: string
  projectDirectory: string
  trigger: "session_start" | "cycle_complete" | "session_end" | "manual"
  cycleNumber: number
  git: {
    branch: string
    commitHash: string
    diffStat: string
    filesChanged: number
    insertions: number
    deletions: number
  }
  cycleSummary?: string
  directive: string
}

/** One supervisor run from start to stop */
export type AnalyticsSession = {
  id: string
  agentName: string
  projectDirectory: string
  model: string
  directive: string
  startedAt: number
  endedAt?: number
  status: "running" | "completed" | "failed" | "stopped"
  startSnapshotId: string
  endSnapshotId?: string
  metrics: {
    totalCycles: number
    totalErrors: number
    totalRestarts: number
    totalRoundsUsed: number
    durationMs: number
    cycleDurations: number[]
    commandBreakdown: Record<string, number>
    filesChanged: number
    insertions: number
    deletions: number
  }
  cycleSummaries: Array<{
    cycleNumber: number
    timestamp: number
    summary: string
    durationMs: number
  }>
  evaluation?: SessionEvaluation
}

/** AI-generated quality assessment */
export type SessionEvaluation = {
  evaluatedAt: number
  evaluatorModel: string
  scores: {
    taskCompletion: number
    codeQuality: number
    correctness: number
    progressEfficiency: number
    overall: number
  }
  feedback: {
    strengths: string[]
    weaknesses: string[]
    suggestions: string[]
    summary: string
  }
}

/** A/B comparison between two sessions */
export type SessionComparison = {
  id: string
  createdAt: number
  sessionAId: string
  sessionBId: string
  aiComparison?: {
    evaluatedAt: number
    winner: "A" | "B" | "tie"
    reasoning: string
    dimensionComparison: Array<{
      dimension: string
      sessionAScore: number
      sessionBScore: number
      notes: string
    }>
  }
}

export type AnalyticsStore = {
  sessions: AnalyticsSession[]
  snapshots: Snapshot[]
  comparisons: SessionComparison[]
  abTests?: ABTestResult[]
}

// ---------------------------------------------------------------------------
// A/B Testing types
// ---------------------------------------------------------------------------

export type ABTestVariant = {
  label: string       // "A" or "B"
  model: string
  directive: string
  maxCycles: number
}

export type ABTestConfig = {
  projectId: string
  agentName: string
  projectDirectory: string
  variants: [ABTestVariant, ABTestVariant]
  ollamaUrl: string
  evalModel: string
}

export type ABTestStatus =
  | "pending"
  | "pausing-for-baseline"
  | "running-variant-a"
  | "pausing-after-a"
  | "resetting-to-baseline"
  | "running-variant-b"
  | "pausing-after-b"
  | "comparing"
  | "completed"
  | "failed"

export type ABTestResult = {
  id: string
  config: ABTestConfig
  status: ABTestStatus
  startedAt: number
  completedAt?: number
  baselineCommit?: string
  variantASessionId?: string
  variantBSessionId?: string
  comparisonId?: string
  error?: string
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

const ANALYTICS_FILE = "orchestrator-analytics.json"
const MAX_SESSIONS = 100
const MAX_SNAPSHOTS = 500
const MAX_COMPARISONS = 50

function getPath(): string {
  return resolve(process.cwd(), ANALYTICS_FILE)
}

let writeLock: Promise<void> = Promise.resolve()
function withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = writeLock.then(fn, fn)
  writeLock = next.then(() => {}, () => {})
  return next
}

const DEFAULT_STORE: AnalyticsStore = { sessions: [], snapshots: [], comparisons: [] }

export async function loadAnalytics(): Promise<AnalyticsStore> {
  return readJsonFile<AnalyticsStore>(getPath(), { ...DEFAULT_STORE })
}

async function saveAnalytics(store: AnalyticsStore): Promise<void> {
  store.sessions = store.sessions.slice(-MAX_SESSIONS)
  store.snapshots = store.snapshots.slice(-MAX_SNAPSHOTS)
  store.comparisons = store.comparisons.slice(-MAX_COMPARISONS)
  await writeJsonFile(getPath(), store)
}

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

async function runGit(directory: string, args: string[]): Promise<string> {
  try {
    const proc = Bun.spawn(["git", ...args], {
      cwd: directory,
      stdout: "pipe",
      stderr: "pipe",
    })
    const output = await new Response(proc.stdout).text()
    await proc.exited
    return output.trim()
  } catch {
    return ""
  }
}

function parseDiffStat(stat: string): { filesChanged: number; insertions: number; deletions: number } {
  // Last line of git diff --stat looks like: "5 files changed, 120 insertions(+), 30 deletions(-)"
  const m = stat.match(/(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/)
  if (!m) return { filesChanged: 0, insertions: 0, deletions: 0 }
  return {
    filesChanged: parseInt(m[1] ?? "0", 10),
    insertions: parseInt(m[2] ?? "0", 10),
    deletions: parseInt(m[3] ?? "0", 10),
  }
}

// ---------------------------------------------------------------------------
// Snapshot capture
// ---------------------------------------------------------------------------

export async function captureSnapshot(
  agentName: string,
  directory: string,
  trigger: Snapshot["trigger"],
  cycleNumber: number,
  directive: string,
  startCommit?: string,
  cycleSummary?: string,
): Promise<Snapshot> {
  const [branch, commitHash, diffStat] = await Promise.all([
    runGit(directory, ["rev-parse", "--abbrev-ref", "HEAD"]),
    runGit(directory, ["rev-parse", "HEAD"]),
    startCommit
      ? runGit(directory, ["diff", "--stat", `${startCommit}..HEAD`])
      : "",
  ])

  const parsed = parseDiffStat(diffStat)
  const snapshot: Snapshot = {
    id: `snap-${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${agentName}`,
    timestamp: Date.now(),
    agentName,
    projectDirectory: directory,
    trigger,
    cycleNumber,
    git: { branch, commitHash, diffStat, ...parsed },
    directive,
    ...(cycleSummary ? { cycleSummary } : {}),
  }

  await withWriteLock(async () => {
    const store = await loadAnalytics()
    store.snapshots.push(snapshot)
    await saveAnalytics(store)
  })

  return snapshot
}

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

export async function startSession(
  agentName: string,
  directory: string,
  model: string,
  directive: string,
): Promise<string> {
  const snapshot = await captureSnapshot(agentName, directory, "session_start", 0, directive)

  const session: AnalyticsSession = {
    id: `sess-${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${agentName}`,
    agentName,
    projectDirectory: directory,
    model,
    directive,
    startedAt: Date.now(),
    status: "running",
    startSnapshotId: snapshot.id,
    metrics: {
      totalCycles: 0,
      totalErrors: 0,
      totalRestarts: 0,
      totalRoundsUsed: 0,
      durationMs: 0,
      cycleDurations: [],
      commandBreakdown: {},
      filesChanged: 0,
      insertions: 0,
      deletions: 0,
    },
    cycleSummaries: [],
  }

  await withWriteLock(async () => {
    const store = await loadAnalytics()
    store.sessions.push(session)
    await saveAnalytics(store)
  })

  return session.id
}

export async function recordCycle(
  sessionId: string,
  cycleNumber: number,
  summary: string,
  durationMs: number,
  commands: Record<string, number>,
): Promise<void> {
  // Container to capture snapshot context inside the lock (avoids a second read that could race).
  // Using a mutable container so TypeScript doesn't narrow the outer variable to `never`.
  const ctx: { agentName?: string; dir?: string; directive?: string; startCommit?: string } = {}

  await withWriteLock(async () => {
    const store = await loadAnalytics()
    const session = store.sessions.find(s => s.id === sessionId)
    if (!session) return

    session.metrics.totalCycles++
    session.metrics.cycleDurations.push(durationMs)
    session.metrics.totalRoundsUsed += Object.values(commands).reduce((a, b) => a + b, 0)

    // Merge command counts
    for (const [cmd, count] of Object.entries(commands)) {
      session.metrics.commandBreakdown[cmd] = (session.metrics.commandBreakdown[cmd] ?? 0) + count
    }

    session.metrics.totalErrors += commands["error"] ?? 0
    session.metrics.totalRestarts += commands["restart"] ?? 0

    session.cycleSummaries.push({
      cycleNumber,
      timestamp: Date.now(),
      summary,
      durationMs,
    })

    // Capture context for the snapshot while we still hold the lock
    const startSnap = store.snapshots.find(s => s.id === session.startSnapshotId)
    ctx.agentName = session.agentName
    ctx.dir = session.projectDirectory
    ctx.directive = session.directive
    ctx.startCommit = startSnap?.git.commitHash

    await saveAnalytics(store)
  })

  // Take a cycle snapshot outside the write lock (separate git I/O)
  // using context captured inside the lock — no second read needed
  if (ctx.agentName && ctx.dir && ctx.directive) {
    await captureSnapshot(
      ctx.agentName, ctx.dir,
      "cycle_complete", cycleNumber, ctx.directive,
      ctx.startCommit, summary,
    ).catch(() => {})
  }
}

export async function endSession(
  sessionId: string,
  status: "completed" | "failed" | "stopped",
): Promise<void> {
  // Take end snapshot first
  const store = await loadAnalytics()
  const session = store.sessions.find(s => s.id === sessionId)
  if (!session) return

  const startSnap = store.snapshots.find(s => s.id === session.startSnapshotId)
  const endSnap = await captureSnapshot(
    session.agentName, session.projectDirectory,
    "session_end", session.metrics.totalCycles, session.directive,
    startSnap?.git.commitHash,
  ).catch(() => null)

  await withWriteLock(async () => {
    const fresh = await loadAnalytics()
    const sess = fresh.sessions.find(s => s.id === sessionId)
    if (!sess) return

    sess.status = status
    sess.endedAt = Date.now()
    sess.metrics.durationMs = sess.endedAt - sess.startedAt
    if (endSnap) {
      sess.endSnapshotId = endSnap.id
      sess.metrics.filesChanged = endSnap.git.filesChanged
      sess.metrics.insertions = endSnap.git.insertions
      sess.metrics.deletions = endSnap.git.deletions
    }

    await saveAnalytics(fresh)
  })
}

// ---------------------------------------------------------------------------
// AI Evaluation
// ---------------------------------------------------------------------------

const EVAL_SYSTEM_PROMPT = `You are a code quality evaluator. You assess an AI coding agent's work session and provide structured feedback.

You MUST respond with ONLY a JSON object in this exact format (no markdown, no extra text):
{
  "scores": {
    "taskCompletion": <1-10>,
    "codeQuality": <1-10>,
    "correctness": <1-10>,
    "progressEfficiency": <1-10>,
    "overall": <1-10>
  },
  "feedback": {
    "strengths": ["...", "..."],
    "weaknesses": ["...", "..."],
    "suggestions": ["...", "..."],
    "summary": "2-3 sentence overall assessment"
  }
}

Scoring guide:
- taskCompletion: Did the agent make meaningful progress toward the directive? 10 = fully completed, 1 = no progress.
- codeQuality: Based on the work description, is the approach sound and well-structured? 10 = excellent, 1 = poor.
- correctness: Any signs of bugs, errors, or failures? 10 = no issues, 1 = many failures.
- progressEfficiency: How effectively did the agent use its cycles? 10 = every cycle productive, 1 = mostly wasted cycles.
- overall: Weighted composite considering all dimensions.`

export async function evaluateSession(
  sessionId: string,
  ollamaUrl: string,
  model: string,
): Promise<SessionEvaluation | null> {
  const store = await loadAnalytics()
  const session = store.sessions.find(s => s.id === sessionId)
  if (!session) return null

  const startSnap = store.snapshots.find(s => s.id === session.startSnapshotId)
  const endSnap = session.endSnapshotId ? store.snapshots.find(s => s.id === session.endSnapshotId) : null

  const cycleNarrative = session.cycleSummaries
    .map(c => `  Cycle ${c.cycleNumber} (${Math.round(c.durationMs / 1000)}s): ${c.summary}`)
    .join("\n")

  const cmdBreakdown = Object.entries(session.metrics.commandBreakdown)
    .map(([cmd, count]) => `${cmd}: ${count}`)
    .join(", ")

  const userPrompt = [
    `## Directive`,
    session.directive,
    ``,
    `## Session Overview`,
    `Agent: ${session.agentName}`,
    `Model: ${session.model}`,
    `Duration: ${Math.round(session.metrics.durationMs / 60000)}m`,
    `Total cycles: ${session.metrics.totalCycles}`,
    `Errors: ${session.metrics.totalErrors}, Restarts: ${session.metrics.totalRestarts}`,
    `Commands used: ${cmdBreakdown || "none recorded"}`,
    ``,
    `## Git Changes`,
    `Start: ${startSnap?.git.commitHash?.slice(0, 8) ?? "unknown"} on ${startSnap?.git.branch ?? "unknown"}`,
    `End: ${endSnap?.git.commitHash?.slice(0, 8) ?? "unknown"}`,
    `Delta: ${session.metrics.filesChanged} files changed, +${session.metrics.insertions} -${session.metrics.deletions}`,
    endSnap?.git.diffStat ? `\nDiff stat:\n${endSnap.git.diffStat}` : "",
    ``,
    `## Cycle-by-Cycle Progress`,
    cycleNarrative || "  No cycle summaries recorded.",
    ``,
    `## Status`,
    `Session ended: ${session.status}`,
  ].join("\n")

  try {
    const response = await chatCompletion(ollamaUrl, model, [
      { role: "system", content: EVAL_SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ])

    const parsed = parseEvalResponse(response)
    if (!parsed) return null

    const evaluation: SessionEvaluation = {
      evaluatedAt: Date.now(),
      evaluatorModel: model,
      scores: parsed.scores,
      feedback: parsed.feedback,
    }

    // Save evaluation to the session
    await withWriteLock(async () => {
      const fresh = await loadAnalytics()
      const sess = fresh.sessions.find(s => s.id === sessionId)
      if (sess) {
        sess.evaluation = evaluation
        await saveAnalytics(fresh)
      }
    })

    return evaluation
  } catch (err) {
    console.error(`[analytics] Evaluation failed for ${sessionId}:`, err)
    return null
  }
}

function parseEvalResponse(response: string): { scores: SessionEvaluation["scores"]; feedback: SessionEvaluation["feedback"] } | null {
  try {
    // Strip markdown code fences if present
    let json = response
    const fenceMatch = json.match(/```(?:json)?\s*([\s\S]*?)```/)
    if (fenceMatch) json = fenceMatch[1]!

    const data = JSON.parse(json.trim())
    const scores = data.scores
    const feedback = data.feedback

    if (!scores || !feedback) return null

    // Clamp scores to 1-10
    const clamp = (v: unknown) => Math.max(1, Math.min(10, typeof v === "number" ? Math.round(v) : 5))

    return {
      scores: {
        taskCompletion: clamp(scores.taskCompletion),
        codeQuality: clamp(scores.codeQuality),
        correctness: clamp(scores.correctness),
        progressEfficiency: clamp(scores.progressEfficiency),
        overall: clamp(scores.overall),
      },
      feedback: {
        strengths: Array.isArray(feedback.strengths) ? feedback.strengths.map(String) : [],
        weaknesses: Array.isArray(feedback.weaknesses) ? feedback.weaknesses.map(String) : [],
        suggestions: Array.isArray(feedback.suggestions) ? feedback.suggestions.map(String) : [],
        summary: typeof feedback.summary === "string" ? feedback.summary : "No summary provided.",
      },
    }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// A/B Comparison
// ---------------------------------------------------------------------------

const COMPARE_SYSTEM_PROMPT = `You are evaluating two AI coding sessions (A and B) that worked on similar tasks. Compare their quality and determine which performed better.

Respond with ONLY a JSON object:
{
  "winner": "A" | "B" | "tie",
  "reasoning": "2-3 sentence explanation of the verdict",
  "dimensionComparison": [
    { "dimension": "Task Completion", "sessionAScore": <1-10>, "sessionBScore": <1-10>, "notes": "brief comparison" },
    { "dimension": "Code Quality", "sessionAScore": <1-10>, "sessionBScore": <1-10>, "notes": "..." },
    { "dimension": "Efficiency", "sessionAScore": <1-10>, "sessionBScore": <1-10>, "notes": "..." },
    { "dimension": "Error Handling", "sessionAScore": <1-10>, "sessionBScore": <1-10>, "notes": "..." }
  ]
}`

export async function compareSessions(
  sessionAId: string,
  sessionBId: string,
  ollamaUrl: string,
  model: string,
): Promise<SessionComparison | null> {
  const store = await loadAnalytics()
  const sessionA = store.sessions.find(s => s.id === sessionAId)
  const sessionB = store.sessions.find(s => s.id === sessionBId)
  if (!sessionA || !sessionB) return null

  const formatSession = (s: AnalyticsSession, label: string) => {
    const summaries = s.cycleSummaries.map(c => `  Cycle ${c.cycleNumber}: ${c.summary}`).join("\n")
    const evalScores = s.evaluation
      ? `Evaluation scores: completion=${s.evaluation.scores.taskCompletion}, quality=${s.evaluation.scores.codeQuality}, correctness=${s.evaluation.scores.correctness}, efficiency=${s.evaluation.scores.progressEfficiency}, overall=${s.evaluation.scores.overall}`
      : "Not yet evaluated"
    return [
      `## Session ${label}`,
      `Agent: ${s.agentName}, Model: ${s.model}`,
      `Directive: ${s.directive}`,
      `Duration: ${Math.round(s.metrics.durationMs / 60000)}m, Cycles: ${s.metrics.totalCycles}`,
      `Errors: ${s.metrics.totalErrors}, Restarts: ${s.metrics.totalRestarts}`,
      `Git: ${s.metrics.filesChanged} files, +${s.metrics.insertions} -${s.metrics.deletions}`,
      `Status: ${s.status}`,
      evalScores,
      `Progress:`,
      summaries || "  No summaries",
    ].join("\n")
  }

  const userPrompt = formatSession(sessionA, "A") + "\n\n" + formatSession(sessionB, "B")

  try {
    const response = await chatCompletion(ollamaUrl, model, [
      { role: "system", content: COMPARE_SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ])

    let json = response
    const fenceMatch = json.match(/```(?:json)?\s*([\s\S]*?)```/)
    if (fenceMatch) json = fenceMatch[1]!
    const data = JSON.parse(json.trim())

    const comparison: SessionComparison = {
      id: `cmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      createdAt: Date.now(),
      sessionAId,
      sessionBId,
      aiComparison: {
        evaluatedAt: Date.now(),
        winner: ["A", "B", "tie"].includes(data.winner) ? data.winner : "tie",
        reasoning: String(data.reasoning ?? ""),
        dimensionComparison: Array.isArray(data.dimensionComparison)
          ? data.dimensionComparison.map((d: any) => ({
              dimension: String(d.dimension ?? ""),
              sessionAScore: Math.max(1, Math.min(10, Number(d.sessionAScore) || 5)),
              sessionBScore: Math.max(1, Math.min(10, Number(d.sessionBScore) || 5)),
              notes: String(d.notes ?? ""),
            }))
          : [],
      },
    }

    await withWriteLock(async () => {
      const fresh = await loadAnalytics()
      fresh.comparisons.push(comparison)
      await saveAnalytics(fresh)
    })

    return comparison
  } catch (err) {
    console.error(`[analytics] Comparison failed:`, err)
    return null
  }
}

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

export async function getTimelineData(): Promise<Array<{
  sessionId: string
  agentName: string
  model: string
  cycleNumber: number
  timestamp: number
  durationMs: number
  hadError: boolean
  hadRestart: boolean
}>> {
  const store = await loadAnalytics()
  const timeline: ReturnType<typeof getTimelineData> extends Promise<infer T> ? T : never = []

  for (const session of store.sessions) {
    for (const cycle of session.cycleSummaries) {
      timeline.push({
        sessionId: session.id,
        agentName: session.agentName,
        model: session.model,
        cycleNumber: cycle.cycleNumber,
        timestamp: cycle.timestamp,
        durationMs: cycle.durationMs,
        hadError: /error|fail|broke/i.test(cycle.summary),
        hadRestart: /restart/i.test(cycle.summary),
      })
    }
  }

  return timeline
}

// ---------------------------------------------------------------------------
// A/B Testing — orchestration
// ---------------------------------------------------------------------------

/** Minimal interface to avoid circular dependency on ProjectManager */
type ABProjectManager = {
  pauseProject(id: string): void
  resumeProject(id: string): void
  getPauseState(id: string): { status: string } | undefined
  restartSupervisor(id: string, directive?: string, model?: string): void
  getProject(id: string): { agentName: string; model?: string; directive: string } | undefined
  setCycleLimit(id: string, maxCycles: number): void
  clearCycleLimit(id: string): void
}

// gitExec imported from "./git-utils"

async function waitForPause(
  pm: ABProjectManager,
  projectId: string,
  timeoutMs = 300_000,
): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const ps = pm.getPauseState(projectId)
    if (ps?.status === "paused") return
    await new Promise(r => setTimeout(r, 2000))
  }
  throw new Error(`Timed out waiting for project ${projectId} to pause (${timeoutMs / 1000}s)`)
}

export async function runABTest(
  config: ABTestConfig,
  pm: ABProjectManager,
  onStatus?: (status: ABTestStatus, result: ABTestResult) => void,
): Promise<ABTestResult> {
  const result: ABTestResult = {
    id: `ab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    config,
    status: "pending",
    startedAt: Date.now(),
  }

  const setStatus = (s: ABTestStatus) => {
    result.status = s
    onStatus?.(s, result)
  }

  try {
    // 1. Pause for baseline
    setStatus("pausing-for-baseline")
    pm.pauseProject(config.projectId)
    await waitForPause(pm, config.projectId)

    // 2. Verify clean git state
    const gitStatus = await gitExec(config.projectDirectory, "status --porcelain")
    if (gitStatus.length > 0) {
      throw new Error(`Git working directory is not clean:\n${gitStatus}`)
    }

    // 3. Capture baseline
    result.baselineCommit = await gitExec(config.projectDirectory, "rev-parse HEAD")
    const originalBranch = await gitExec(config.projectDirectory, "rev-parse --abbrev-ref HEAD")

    // 4. Run Variant A
    setStatus("running-variant-a")
    const varA = config.variants[0]

    // Set cycle limit — supervisor auto-pauses after N cycles via onCycleComplete
    pm.setCycleLimit(config.projectId, varA.maxCycles)
    pm.restartSupervisor(config.projectId, varA.directive, varA.model)

    // Wait for the auto-pause to trigger (cycle limit reached)
    setStatus("pausing-after-a")
    await waitForPause(pm, config.projectId)

    // Find the most recent session for this agent
    const storeAfterA = await loadAnalytics()
    const sessionsA = storeAfterA.sessions
      .filter(s => s.agentName === config.agentName)
      .sort((a, b) => b.startedAt - a.startedAt)
    result.variantASessionId = sessionsA[0]?.id

    // 5. Reset to baseline
    setStatus("resetting-to-baseline")
    // Stash any changes variant A made (may fail if no changes — that's fine)
    try { await gitExec(config.projectDirectory, "stash") } catch {}
    // Create a temp branch for variant B from baseline
    const tempBranch = `ab-test-${result.id}-variant-b`
    // Delete temp branch if it exists from a previous failed run
    try { await gitExec(config.projectDirectory, `branch -D ${tempBranch}`) } catch {}
    await gitExec(config.projectDirectory, `checkout -b ${tempBranch} ${result.baselineCommit}`)

    // 6. Run Variant B
    setStatus("running-variant-b")
    const varB = config.variants[1]
    pm.setCycleLimit(config.projectId, varB.maxCycles)
    pm.restartSupervisor(config.projectId, varB.directive, varB.model)

    setStatus("pausing-after-b")
    await waitForPause(pm, config.projectId)

    const storeAfterB = await loadAnalytics()
    const sessionsB = storeAfterB.sessions
      .filter(s => s.agentName === config.agentName)
      .sort((a, b) => b.startedAt - a.startedAt)
    result.variantBSessionId = sessionsB[0]?.id

    // 7. Restore original branch
    await gitExec(config.projectDirectory, `checkout ${originalBranch}`)
    // Try to pop the stash (variant A's changes)
    try { await gitExec(config.projectDirectory, "stash pop") } catch {}
    // Clean up temp branch
    try { await gitExec(config.projectDirectory, `branch -d ${tempBranch}`) } catch {}

    // 8. Compare
    if (result.variantASessionId && result.variantBSessionId) {
      setStatus("comparing")
      const comparison = await compareSessions(
        result.variantASessionId,
        result.variantBSessionId,
        config.ollamaUrl,
        config.evalModel,
      )
      if (comparison) result.comparisonId = comparison.id
    }

    // 9. Store result
    result.completedAt = Date.now()
    setStatus("completed")

    await withWriteLock(async () => {
      const store = await loadAnalytics()
      if (!store.abTests) store.abTests = []
      store.abTests.push(result)
      // Cap at 20 A/B tests
      if (store.abTests.length > 20) {
        store.abTests = store.abTests.slice(store.abTests.length - 20)
      }
      await writeJsonFile(getPath(), store)
    })

  } catch (err) {
    result.error = String(err)
    result.completedAt = Date.now()
    setStatus("failed")

    // Best-effort git cleanup — try to get back to original branch
    pm.clearCycleLimit(config.projectId)
    if (result.baselineCommit) {
      try {
        const currentBranch = await gitExec(config.projectDirectory, "rev-parse --abbrev-ref HEAD")
        if (currentBranch.startsWith("ab-test-")) {
          // We're on a temp branch — switch back
          const origBranch = await gitExec(config.projectDirectory, "symbolic-ref refs/remotes/origin/HEAD").catch(() => "main")
          try { await gitExec(config.projectDirectory, `checkout ${origBranch.replace("refs/remotes/origin/", "")}`) } catch {}
          try { await gitExec(config.projectDirectory, `branch -D ${currentBranch}`) } catch {}
        }
        try { await gitExec(config.projectDirectory, "stash pop") } catch {}
      } catch { /* git cleanup is best-effort */ }
    }

    // Try to store the failed result
    await withWriteLock(async () => {
      const store = await loadAnalytics()
      if (!store.abTests) store.abTests = []
      store.abTests.push(result)
      await writeJsonFile(getPath(), store)
    }).catch(() => {})
  }

  return result
}
