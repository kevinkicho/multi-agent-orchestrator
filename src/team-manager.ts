import type { Orchestrator } from "./orchestrator"
import type { DashboardLog } from "./dashboard"
import { chatCompletion } from "./brain"
import {
  loadBrainMemory,
  addMemoryEntry,
  addProjectNote,
  formatMemoryForPrompt,
} from "./brain-memory"
import { trimConversation } from "./message-utils"
import { recordPrompt } from "./prompt-ledger"
import { logPerformance } from "./performance-log"
import { runAgentSupervisor, type SupervisorLimits } from "./supervisor"
import type { EventBus, BusEvent } from "./event-bus"
import {
  type NudgeState, type CircuitBreakerState,
  createNudgeState, resetNudge, createCircuitBreaker,
  recordFailure, recordSuccess,
  buildEmptyNudge, buildNoParseNudge, fuzzyExtractCommands,
  MANAGER_COMMANDS, MANAGER_DEFAULT_CMD,
} from "./command-recovery"
import { FailureWindow } from "./failure-window"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Message = { role: "system" | "user" | "assistant"; content: string }

export type TeamRole = {
  /** Human-readable role name, e.g., "Frontend", "Backend", "QA" */
  role: string
  /** Agent name this team member controls */
  agentName: string
  /** Project directory */
  directory: string
  /** Role-specific directive (manager can update this) */
  directive: string
}

export type TeamConfig = {
  ollamaUrl: string
  model: string
  /** The single shared goal/mission for the entire team */
  goal: string
  /** Team members — each gets an agent-supervisor pair */
  members: TeamRole[]
  /** How often the manager checks in (seconds). Default: 120 */
  managerIntervalSeconds?: number
  /** Max LLM rounds per manager check-in. Default: 8 */
  managerMaxRounds?: number
  /** Supervisor limits passed to each team member's supervisor */
  supervisorLimits?: SupervisorLimits
  /** Scheduling for supervisors: sequential or parallel. Default: "sequential" */
  scheduling?: "parallel" | "sequential"
  concurrency?: number
  cyclesPerRotation?: number
  onThinking?: (source: string, thought: string) => void
  dashboardLog?: DashboardLog
  signal?: AbortSignal
  softStop?: { requested: boolean }
  /** Shared event bus for fast cross-agent coordination */
  eventBus?: EventBus
}

/** Live state of a team member during execution */
type MemberState = {
  role: TeamRole
  /** Recent cycle summaries from this member's supervisor */
  recentSummaries: string[]
  /** Mutable directive ref — shared with the running supervisor so updates take effect between cycles */
  directiveRef: { value: string }
  /** Status */
  status: "running" | "idle" | "stopped" | "error"
  /** Abort controller for this member's supervisor */
  abort: AbortController
  /** Soft stop flag for this member */
  softStop: { requested: boolean }
  /** Bus subscription IDs for cleanup */
  busSubscriptionIds: string[]
}

// ---------------------------------------------------------------------------
// Manager system prompt
// ---------------------------------------------------------------------------

function buildManagerPrompt(goal: string, members: TeamRole[]): string {
  const memberList = members.map(m =>
    `  - ${m.role} (agent: ${m.agentName}, dir: ${m.directory})`
  ).join("\n")

  return `You are a team manager coordinating multiple agent-supervisor pairs working toward a single goal.

## Goal
${goal}

## Your Team
${memberList}

Each team member has their own supervisor that handles detailed code review and task management.
Your job is higher-level coordination: strategy, priorities, dependencies, and work distribution.

You can issue these commands (one per line, in a \`\`\`commands code block):

  DIRECTIVE <agent-name> <text>  — Update a team member's directive (they'll follow it next cycle)
  PRIORITIZE <agent-name>        — Tell the scheduler to run this member's supervisor next
  NOTE <agent-name> <text>       — Save a note about this team member's work
  HIRE <role> <directory>         — Request a new team member (user must approve + provide agent)
  DISSOLVE <agent-name>           — Recommend dissolving a team (user must approve)
  STATUS_CHECK                    — Request fresh summaries from all active supervisors
  MANAGER_DONE <summary>          — You've reviewed everything, summarize and wait for next check-in

Guidelines:
- Read each team member's recent summaries carefully before deciding
- Coordinate dependencies: if Backend needs to finish an API before Frontend can use it, say so
- Redistribute work: if one team is blocked, assign their blockers to the right team
- Don't micromanage — supervisors handle the details, you handle strategy
- Look for cross-team issues: duplicated work, conflicting changes, integration gaps
- Keep directives focused on the team member's role — don't ask Frontend to fix Backend bugs
- Use HIRE when the team clearly needs a new capability (e.g., "we need dedicated testing")
- Use DISSOLVE when a team's work is complete and they're just idle-spinning
- Be concise in directives — supervisors are LLMs that work best with clear, specific goals
`
}

// ---------------------------------------------------------------------------
// Manager command parsing
// ---------------------------------------------------------------------------

type ManagerCommand =
  | { type: "directive"; agentName: string; text: string }
  | { type: "prioritize"; agentName: string }
  | { type: "note"; agentName: string; text: string }
  | { type: "hire"; role: string; directory: string }
  | { type: "dissolve"; agentName: string }
  | { type: "status_check" }
  | { type: "manager_done"; summary: string }

function parseManagerCommands(response: string): ManagerCommand[] {
  const commands: ManagerCommand[] = []

  const codeBlockMatch = response.match(/```commands?\n([\s\S]*?)```/)
  const lines = codeBlockMatch
    ? codeBlockMatch[1]!.split("\n")
    : response.split("\n")

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue

    if (trimmed.startsWith("DIRECTIVE ")) {
      const rest = trimmed.slice(10)
      const spaceIdx = rest.indexOf(" ")
      if (spaceIdx !== -1) {
        commands.push({
          type: "directive",
          agentName: rest.slice(0, spaceIdx),
          text: rest.slice(spaceIdx + 1),
        })
      }
    } else if (trimmed.startsWith("PRIORITIZE ")) {
      commands.push({ type: "prioritize", agentName: trimmed.slice(11).trim() })
    } else if (trimmed.startsWith("NOTE ")) {
      const rest = trimmed.slice(5)
      const spaceIdx = rest.indexOf(" ")
      if (spaceIdx !== -1) {
        commands.push({
          type: "note",
          agentName: rest.slice(0, spaceIdx),
          text: rest.slice(spaceIdx + 1),
        })
      }
    } else if (trimmed.startsWith("HIRE ")) {
      const rest = trimmed.slice(5)
      const spaceIdx = rest.indexOf(" ")
      if (spaceIdx !== -1) {
        commands.push({
          type: "hire",
          role: rest.slice(0, spaceIdx),
          directory: rest.slice(spaceIdx + 1),
        })
      }
    } else if (trimmed.startsWith("DISSOLVE ")) {
      commands.push({ type: "dissolve", agentName: trimmed.slice(9).trim() })
    } else if (trimmed === "STATUS_CHECK") {
      commands.push({ type: "status_check" })
    } else if (trimmed.startsWith("MANAGER_DONE")) {
      commands.push({ type: "manager_done", summary: trimmed.slice(12).trim() || "Check-in complete." })
    }
  }

  return commands
}

// ---------------------------------------------------------------------------
// Team Manager — runs above supervisors, coordinates the team
// ---------------------------------------------------------------------------

export class TeamManager {
  private members = new Map<string, MemberState>()
  private managerMessages: Message[] = []
  private checkInCount = 0
  private priorityQueue: string[] = [] // agents to run next in sequential mode
  private hireRequests: Array<{ role: string; directory: string }> = []
  private dissolveRequests: string[] = []
  /** Track unacknowledged directive updates */
  private pendingDirectiveAcks = new Map<string, { directive: string; issuedAt: number; cyclesSince: number }>()

  constructor(
    private orchestrator: Orchestrator,
    private config: TeamConfig,
  ) {}

  /** Get pending hire requests (for UI/CLI to approve) */
  getHireRequests(): Array<{ role: string; directory: string }> {
    return [...this.hireRequests]
  }

  /** Clear all hire requests */
  clearHireRequests(): void {
    this.hireRequests = []
  }

  /** Remove a single hire request by index */
  removeHireRequest(index: number): void {
    if (index >= 0 && index < this.hireRequests.length) {
      this.hireRequests.splice(index, 1)
    }
  }

  /** Get pending dissolve requests */
  getDissolveRequests(): string[] {
    return [...this.dissolveRequests]
  }

  /** Clear all dissolve requests */
  clearDissolveRequests(): void {
    this.dissolveRequests = []
  }

  /** Remove a single dissolve request by agent name */
  removeDissolveRequest(agentName: string): void {
    const idx = this.dissolveRequests.indexOf(agentName)
    if (idx !== -1) this.dissolveRequests.splice(idx, 1)
  }

  /** Add a new team member at runtime */
  addMember(role: TeamRole): void {
    const state: MemberState = {
      role,
      recentSummaries: [],
      directiveRef: { value: role.directive },
      status: "idle",
      abort: new AbortController(),
      softStop: { requested: false },
      busSubscriptionIds: [],
    }
    this.members.set(role.agentName, state)
    this.config.dashboardLog?.push({
      type: "brain-thinking",
      text: `[team-manager] New team member: ${role.role} (${role.agentName})`,
    })
  }

  /** Remove a team member */
  removeMember(agentName: string): void {
    const member = this.members.get(agentName)
    if (member) {
      member.abort.abort()
      member.status = "stopped"
      this.members.delete(agentName)
      this.config.dashboardLog?.push({
        type: "brain-thinking",
        text: `[team-manager] Dissolved team: ${member.role.role} (${agentName})`,
      })
    }
  }

  /** List current team members and their status */
  listMembers(): Array<{ agentName: string; role: string; status: string; directive: string; recentSummary: string }> {
    return Array.from(this.members.values()).map(m => ({
      agentName: m.role.agentName,
      role: m.role.role,
      status: m.status,
      directive: m.directiveRef.value,
      recentSummary: m.recentSummaries[m.recentSummaries.length - 1] ?? "(no summaries yet)",
    }))
  }

  /** Flag set when all supervisors have exited — tells the manager loop to stop */
  private supervisorsDone = false

  /** Run the full team: start supervisors + manager loop */
  async run(): Promise<void> {
    const { config } = this
    const emit = (text: string) => {
      config.onThinking?.("team-manager", text)
      config.dashboardLog?.push({ type: "brain-thinking", text: `[team-manager] ${text}` })
    }

    emit(`Team manager started. Goal: "${config.goal}"`)
    emit(`Team members: ${config.members.map(m => `${m.role} (${m.agentName})`).join(", ")}`)

    // Initialize member states
    for (const role of config.members) {
      this.addMember(role)
    }

    // Start supervisors in background — when they all exit, flag the manager to stop
    const supervisorPromise = this.runSupervisors().finally(() => {
      this.supervisorsDone = true
      emit("All supervisors have exited.")
    })

    // Run the manager loop (slower cadence)
    const managerPromise = this.runManagerLoop()

    // Wait for both to finish
    await Promise.allSettled([supervisorPromise, managerPromise])

    emit("Team manager finished.")
  }

  // -------------------------------------------------------------------------
  // Supervisor scheduling
  // -------------------------------------------------------------------------

  private async runSupervisors(): Promise<void> {
    const { config } = this
    const scheduling = config.scheduling ?? "sequential"
    const concurrency = config.concurrency ?? 1
    const cyclesPerRotation = config.cyclesPerRotation ?? 2

    if (scheduling === "parallel") {
      // All supervisors run simultaneously
      const promises = Array.from(this.members.values()).map(member =>
        this.runMemberSupervisor(member, 0) // 0 = unlimited cycles
      )
      await Promise.allSettled(promises)
    } else {
      // Sequential rotation
      while (!config.signal?.aborted && !config.softStop?.requested) {
        // Check if any members are still active — if all stopped/error, exit
        const activeMembers = Array.from(this.members.values()).filter(m => m.status !== "stopped" && m.status !== "error")
        if (activeMembers.length === 0) {
          config.onThinking?.("team-manager", "[sequential] All team members stopped — exiting supervisor loop")
          break
        }

        // Build the run order: prioritized agents first, then the rest
        const allAgents = Array.from(this.members.keys())
        const runOrder: string[] = []

        // Drain priority queue first
        while (this.priorityQueue.length > 0) {
          const agent = this.priorityQueue.shift()!
          if (this.members.has(agent) && !runOrder.includes(agent)) {
            runOrder.push(agent)
          }
        }
        // Add remaining agents
        for (const agent of allAgents) {
          if (!runOrder.includes(agent)) runOrder.push(agent)
        }

        // Run in batches
        for (let i = 0; i < runOrder.length; i += concurrency) {
          if (config.signal?.aborted || config.softStop?.requested) break

          const batch = runOrder.slice(i, i + concurrency)
            .map(name => this.members.get(name))
            .filter((m): m is MemberState => m != null && m.status !== "stopped")

          if (batch.length === 0) continue

          const batchNames = batch.map(m => m.role.role).join(", ")
          config.onThinking?.("team-manager", `[sequential] Running: ${batchNames} (${cyclesPerRotation} cycles)`)

          const promises = batch.map(member =>
            this.runMemberSupervisor(member, cyclesPerRotation)
          )
          await Promise.allSettled(promises)

          // Brief pause between batches
          if (!config.signal?.aborted) {
            await new Promise(r => setTimeout(r, 5_000))
          }
        }
      }
    }
  }

  private async runMemberSupervisor(member: MemberState, maxCycles: number): Promise<void> {
    const { config } = this
    member.status = "running"

    try {
      await runAgentSupervisor(this.orchestrator, {
        ollamaUrl: config.ollamaUrl,
        model: config.model,
        agentName: member.role.agentName,
        directory: member.role.directory,
        directive: member.directiveRef.value,
        directiveRef: member.directiveRef,
        cyclePauseSeconds: config.supervisorLimits?.cyclePauseSeconds ?? 30,
        maxRoundsPerCycle: config.supervisorLimits?.maxRoundsPerCycle ?? 12,
        reviewEnabled: true,
        limits: config.supervisorLimits,
        dashboardLog: config.dashboardLog,
        signal: member.abort.signal,
        softStop: member.softStop,
        maxCycles: maxCycles || undefined,
        eventBus: config.eventBus,
        urgentEventPatterns: config.eventBus ? [
          { type: "agent-notification" },
          { type: "resource-contention" },
          { type: "intent-conflict" },
        ] : undefined,
        onUrgentEvent: (event: BusEvent) => {
          if (event.agentName === member.role.agentName) return null
          if (event.type === "agent-notification") {
            return `Agent ${event.agentName} says: ${(event.data as Record<string, unknown>).message}`
          }
          if (event.type === "resource-contention" || event.type === "intent-conflict") {
            const data = event.data as { conflicts?: Array<{ agent?: string; file?: string; files?: string[] }> }
            const details = data.conflicts?.map(c => c.agent ?? c.file ?? "unknown").join(", ") ?? "unknown"
            return `[REDIRECT] Contention involving agent ${event.agentName}: ${details}. Adjust your work to avoid overlap.`
          }
          return null
        },
        onThinking: (thought) => {
          config.onThinking?.(member.role.agentName, thought)
        },
        onDirectiveUpdate: (newDirective) => {
          // Supervisor updated its own directive — sync to the shared ref
          member.directiveRef.value = newDirective
        },
        // Feed cycle summaries up to the manager
        onCycleSummary: (summary) => {
          member.recentSummaries.push(summary)
          // Keep last 5 summaries per member
          if (member.recentSummaries.length > 5) {
            member.recentSummaries = member.recentSummaries.slice(-5)
          }
          // Directive ack tracking: check if this cycle acknowledges a pending directive
          const pending = this.pendingDirectiveAcks.get(member.role.agentName)
          if (pending) {
            pending.cyclesSince++
            if (summary.length > 20) {
              // Assume any substantive summary acknowledges the directive
              this.pendingDirectiveAcks.delete(member.role.agentName)
              config.eventBus?.emit({
                type: "directive-acknowledged",
                source: "supervisor",
                agentName: member.role.agentName,
                data: { directive: pending.directive, cyclesUntilAck: pending.cyclesSince },
              })
            } else if (pending.cyclesSince >= 2) {
              config.onThinking?.(
                "team-manager",
                `WARNING: ${member.role.agentName} has not acknowledged directive after ${pending.cyclesSince} cycles`
              )
            }
          }
        },
      })
    } catch (err) {
      if (!member.abort.signal.aborted) {
        member.status = "error"
        config.onThinking?.(member.role.agentName, `Supervisor error: ${err}`)
      }
    } finally {
      if (member.status === "running") member.status = "idle"
    }
  }

  // -------------------------------------------------------------------------
  // Manager LLM loop — runs on slower cadence, coordinates the team
  // -------------------------------------------------------------------------

  private async runManagerLoop(): Promise<void> {
    const { config } = this
    const intervalMs = (config.managerIntervalSeconds ?? 120) * 1000
    const maxRounds = config.managerMaxRounds ?? 8
    const emit = (text: string) => {
      config.onThinking?.("team-manager", text)
      config.dashboardLog?.push({ type: "brain-thinking", text: `[team-manager] ${text}` })
    }

    // Wait for supervisors to produce initial summaries before first check-in
    emit(`Manager will check in every ${intervalMs / 1000}s. Waiting for initial supervisor output...`)
    await new Promise(r => setTimeout(r, Math.min(intervalMs, 60_000)))

    while (!config.signal?.aborted && !config.softStop?.requested && !this.supervisorsDone) {
      this.checkInCount++
      emit(`\n===== Manager Check-in #${this.checkInCount} =====`)

      try {
        await this.runManagerCheckIn(maxRounds)
      } catch (err) {
        emit(`Manager check-in error: ${err}`)
      }

      // Wait for next check-in — can be interrupted early by bus events
      if (!config.signal?.aborted && !config.softStop?.requested) {
        emit(`Next check-in in ${intervalMs / 1000}s...`)
        await new Promise<void>((resolve) => {
          let settled = false
          const done = () => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            clearInterval(pollTimer)
            config.signal?.removeEventListener("abort", done)
            if (busUnsub) busUnsub()
          }
          const timer = setTimeout(() => { done(); resolve() }, intervalMs)
          // Poll for softStop/supervisorsDone so we don't block until timer expires
          const pollTimer = setInterval(() => {
            if (config.softStop?.requested || this.supervisorsDone) {
              done(); resolve()
            }
          }, 2_000)
          config.signal?.addEventListener("abort", () => { done(); resolve() })
          // Early check-in: if any supervisor finishes a cycle or sends a notification, wake up
          let busUnsub: (() => void) | undefined
          if (config.eventBus) {
            const subId = config.eventBus.on(
              { type: "agent-notification" },
              () => { done(); resolve() }
            )
            busUnsub = () => config.eventBus!.off(subId)
          }
        })
      }
    }
  }

  private async runManagerCheckIn(maxRounds: number): Promise<void> {
    const { config } = this
    const emit = (text: string) => {
      config.onThinking?.("team-manager", text)
      config.dashboardLog?.push({ type: "brain-thinking", text: `[team-manager] ${text}` })
    }

    // Build context: all team members' recent summaries
    const teamStatus = this.buildTeamStatusReport()

    // Load shared memory (full context — manager sees everything)
    const memory = await loadBrainMemory()
    const memoryContext = formatMemoryForPrompt(memory)

    // Use live member list (not config.members) so hired/dissolved members are reflected
    const liveMembers: TeamRole[] = Array.from(this.members.values()).map(m => ({
      ...m.role,
      directive: m.directiveRef.value,
    }))
    const systemPrompt = buildManagerPrompt(config.goal, liveMembers)

    // Always refresh system prompt so team composition changes (hire/dissolve) are reflected
    if (this.managerMessages.length === 0) {
      this.managerMessages = [
        { role: "system", content: systemPrompt },
      ]
    } else {
      // Update the system message in-place
      this.managerMessages[0] = { role: "system", content: systemPrompt }
    }

    // Add current state as user message
    this.managerMessages.push({
      role: "user",
      content: [
        `## Team Status Report (check-in #${this.checkInCount})`,
        teamStatus,
        memoryContext ? `\n## Shared Memory\n${memoryContext}` : "",
        `\nReview each team member's progress. Coordinate dependencies, redistribute work if needed, and update directives.`,
      ].filter(Boolean).join("\n"),
    })

    const nudge = createNudgeState()
    const checkInBreaker = createCircuitBreaker(4) // stop check-in after 4 consecutive failures
    const MANAGER_LLM_FAILURE_WINDOW = 10
    const MANAGER_LLM_FAILURE_THRESHOLD = 3
    const llmWindow = new FailureWindow(MANAGER_LLM_FAILURE_WINDOW)

    for (let round = 0; round < maxRounds; round++) {
      if (config.signal?.aborted) break

      trimConversation(this.managerMessages, 30)

      let response: string
      // Ledger: record manager outbound prompt
      const lastMsg = this.managerMessages[this.managerMessages.length - 1]
      if (lastMsg) {
        recordPrompt({
          source: "manager", target: "llm", direction: "outbound",
          model: config.model, content: lastMsg.content,
        }).catch(() => {})
      }
      try {
        response = await chatCompletion(config.ollamaUrl, config.model, this.managerMessages, { role: "team-manager" })
        llmWindow.record(true)
        // Ledger: record manager inbound response
        recordPrompt({
          source: "manager", target: "manager", direction: "inbound",
          model: config.model, content: response,
        }).catch(() => {})
      } catch (err) {
        llmWindow.record(false)
        const fails = llmWindow.failures()
        emit(`Manager LLM failed (${fails}/${MANAGER_LLM_FAILURE_WINDOW} in window): ${err}`)
        if (fails >= MANAGER_LLM_FAILURE_THRESHOLD) {
          emit(`Manager LLM failure density too high — ending check-in early`)
          break
        }
        // Retry with backoff instead of immediately bailing
        const retryDelay = Math.min(5000 * Math.pow(2, fails - 1), 30_000)
        emit(`Retrying in ${retryDelay / 1000}s...`)
        await new Promise(r => setTimeout(r, retryDelay))
        try {
          response = await chatCompletion(config.ollamaUrl, config.model, this.managerMessages, { role: "team-manager" })
          llmWindow.record(true)
        } catch (retryErr) {
          llmWindow.record(false)
          emit(`Manager LLM retry failed: ${retryErr}`)
          continue
        }
      }

      if (!response) {
        emit(`Manager empty response (round ${round + 1}), nudge level ${nudge.consecutiveEmpty + 1}`)
        this.managerMessages.push({
          role: "user",
          content: buildEmptyNudge(nudge, MANAGER_COMMANDS, MANAGER_DEFAULT_CMD),
        })
        if (recordFailure(checkInBreaker)) {
          emit(`Circuit breaker: ${checkInBreaker.consecutiveFailures} consecutive failures — ending check-in`)
          break
        }
        continue
      }

      this.managerMessages.push({ role: "assistant", content: response })
      emit(`--- Manager round ${round + 1} ---\n${response}`)

      let commands = parseManagerCommands(response)

      // Fuzzy recovery: try extracting commands from prose
      if (commands.length === 0) {
        const fuzzyLines = fuzzyExtractCommands(response, MANAGER_COMMANDS)
        if (fuzzyLines.length > 0) {
          const wrapped = "```commands\n" + fuzzyLines.join("\n") + "\n```"
          commands = parseManagerCommands(wrapped)
          if (commands.length > 0) {
            emit(`Recovered ${commands.length} manager command(s) from prose`)
          }
        }
      }

      if (commands.length === 0) {
        emit(`Manager no-parse (round ${round + 1}), nudge level ${nudge.consecutiveNoParse + 1}`)
        this.managerMessages.push({
          role: "user",
          content: buildNoParseNudge(nudge, response, MANAGER_COMMANDS, MANAGER_DEFAULT_CMD),
        })
        if (recordFailure(checkInBreaker)) {
          emit(`Circuit breaker: ${checkInBreaker.consecutiveFailures} consecutive failures — ending check-in`)
          break
        }
        continue
      }

      // Successful parse — reset escalation
      resetNudge(nudge)
      recordSuccess(checkInBreaker)

      const results: string[] = []
      let done = false

      for (const cmd of commands) {
        switch (cmd.type) {
          case "directive": {
            const member = this.members.get(cmd.agentName)
            if (member) {
              member.directiveRef.value = cmd.text
              results.push(`Updated ${cmd.agentName}'s directive: "${cmd.text.slice(0, 120)}..."`)
              emit(`Directive update for ${member.role.role}: ${cmd.text.slice(0, 200)}`)
              config.dashboardLog?.push({
                type: "supervisor-thinking",
                agent: cmd.agentName,
                text: `[MANAGER DIRECTIVE] ${cmd.text}`,
              })
              recordPrompt({
                source: "manager", target: cmd.agentName, direction: "outbound",
                agentName: cmd.agentName, model: config.model,
                content: cmd.text, tags: ["directive-update"],
              }).catch(() => {})
              // Directive ack tracking via event bus
              config.eventBus?.emit({
                type: "directive-updated",
                source: "team-manager",
                agentName: cmd.agentName,
                data: { directive: cmd.text },
              })
              this.pendingDirectiveAcks.set(cmd.agentName, {
                directive: cmd.text,
                issuedAt: Date.now(),
                cyclesSince: 0,
              })
            } else {
              results.push(`Unknown team member: ${cmd.agentName}`)
            }
            break
          }

          case "prioritize": {
            if (this.members.has(cmd.agentName)) {
              this.priorityQueue.push(cmd.agentName)
              results.push(`${cmd.agentName} added to priority queue — will run next in sequential mode.`)
            } else {
              results.push(`Unknown team member: ${cmd.agentName}`)
            }
            break
          }

          case "note": {
            await addProjectNote(await loadBrainMemory(), cmd.agentName, cmd.text)
            results.push(`Saved note for ${cmd.agentName}: "${cmd.text.slice(0, 80)}..."`)
            break
          }

          case "hire": {
            this.hireRequests.push({ role: cmd.role, directory: cmd.directory })
            results.push(`Hire request queued: ${cmd.role} at ${cmd.directory}. User must approve and provide an agent.`)
            emit(`HIRE REQUEST: ${cmd.role} at ${cmd.directory}`)
            config.dashboardLog?.push({
              type: "supervisor-alert",
              agent: "team-manager",
              text: `HIRE REQUEST: Manager wants to add "${cmd.role}" team at ${cmd.directory}`,
            })
            break
          }

          case "dissolve": {
            this.dissolveRequests.push(cmd.agentName)
            results.push(`Dissolve request queued for ${cmd.agentName}. User must approve.`)
            emit(`DISSOLVE REQUEST: ${cmd.agentName}`)
            config.dashboardLog?.push({
              type: "supervisor-alert",
              agent: "team-manager",
              text: `DISSOLVE REQUEST: Manager recommends dissolving ${cmd.agentName}`,
            })
            break
          }

          case "status_check": {
            const freshStatus = this.buildTeamStatusReport()
            results.push(freshStatus)
            break
          }

          case "manager_done": {
            done = true
            // Save check-in summary
            await addMemoryEntry(await loadBrainMemory(), {
              timestamp: Date.now(),
              objective: `team-manager check-in #${this.checkInCount}: ${config.goal}`,
              summary: cmd.summary,
              agentLearnings: {},
            })
            emit(`Check-in #${this.checkInCount} complete: ${cmd.summary}`)
            logPerformance({
              timestamp: Date.now(),
              projectName: "team-manager",
              agentName: "team-manager",
              model: config.model,
              event: "cycle_complete",
              cycleNumber: this.checkInCount,
              summary: cmd.summary,
            })
            break
          }
        }
      }

      if (done) break

      if (results.length > 0) {
        this.managerMessages.push({ role: "user", content: results.join("\n\n") })
      }
    }
  }

  // -------------------------------------------------------------------------
  // Status report builder
  // -------------------------------------------------------------------------

  private buildTeamStatusReport(): string {
    const lines: string[] = []

    for (const [agentName, member] of this.members) {
      lines.push(`### ${member.role.role} (${agentName}) — ${member.status}`)
      lines.push(`Directive: ${member.directiveRef.value.slice(0, 200)}`)

      if (member.recentSummaries.length > 0) {
        lines.push("Recent cycle summaries:")
        for (const s of member.recentSummaries.slice(-3)) {
          lines.push(`  - ${s.slice(0, 300)}`)
        }
      } else {
        lines.push("(No cycle summaries yet — supervisor hasn't completed a cycle)")
      }
      lines.push("")
    }

    return lines.join("\n")
  }
}
