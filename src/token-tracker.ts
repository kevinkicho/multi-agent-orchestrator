/**
 * Token usage tracking — tracks LLM token consumption per agent, cycle, and session.
 * Supports budget limits to prevent runaway costs.
 */

import type { TokenUsage } from "./brain"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TokenRecord = {
  timestamp: number
  agentName: string
  model: string
  cycleNumber?: number
  sessionId?: string
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

export type AgentTokenStats = {
  totalPromptTokens: number
  totalCompletionTokens: number
  totalTokens: number
  callCount: number
  firstCallAt: number
  lastCallAt: number
}

export type TokenBudget = {
  /** Max total tokens per agent per session (0 = unlimited) */
  maxTokensPerAgent?: number
  /** Max total tokens across all agents (0 = unlimited) */
  maxTotalTokens?: number
  /** Callback when budget is exceeded */
  onBudgetExceeded?: (agentName: string, used: number, limit: number) => void
}

// ---------------------------------------------------------------------------
// TokenTracker class
// ---------------------------------------------------------------------------

export class TokenTracker {
  private records: TokenRecord[] = []
  private agentStats = new Map<string, AgentTokenStats>()
  private totalTokens = 0
  private budget: TokenBudget

  constructor(budget?: TokenBudget) {
    this.budget = budget ?? {}
  }

  /** Record token usage from an LLM call */
  record(agentName: string, model: string, usage: TokenUsage | undefined, cycleNumber?: number, sessionId?: string): void {
    if (!usage) return

    const record: TokenRecord = {
      timestamp: Date.now(),
      agentName,
      model,
      cycleNumber,
      sessionId,
      promptTokens: usage.promptTokens ?? 0,
      completionTokens: usage.completionTokens ?? 0,
      totalTokens: usage.totalTokens ?? (usage.promptTokens ?? 0) + (usage.completionTokens ?? 0),
    }

    this.records.push(record)
    this.totalTokens += record.totalTokens

    // Update per-agent stats
    const existing = this.agentStats.get(agentName)
    if (existing) {
      existing.totalPromptTokens += record.promptTokens
      existing.totalCompletionTokens += record.completionTokens
      existing.totalTokens += record.totalTokens
      existing.callCount++
      existing.lastCallAt = record.timestamp
    } else {
      this.agentStats.set(agentName, {
        totalPromptTokens: record.promptTokens,
        totalCompletionTokens: record.completionTokens,
        totalTokens: record.totalTokens,
        callCount: 1,
        firstCallAt: record.timestamp,
        lastCallAt: record.timestamp,
      })
    }

    // Keep ring buffer at 5000 records
    if (this.records.length > 5000) {
      this.records = this.records.slice(-4000)
    }
  }

  /** Check if an agent is over budget. Returns true if within budget. */
  checkBudget(agentName: string): boolean {
    if (this.budget.maxTotalTokens && this.totalTokens >= this.budget.maxTotalTokens) {
      this.budget.onBudgetExceeded?.(agentName, this.totalTokens, this.budget.maxTotalTokens)
      return false
    }
    if (this.budget.maxTokensPerAgent) {
      const stats = this.agentStats.get(agentName)
      if (stats && stats.totalTokens >= this.budget.maxTokensPerAgent) {
        this.budget.onBudgetExceeded?.(agentName, stats.totalTokens, this.budget.maxTokensPerAgent)
        return false
      }
    }
    return true
  }

  /** Get stats for a specific agent */
  getAgentStats(agentName: string): AgentTokenStats | undefined {
    return this.agentStats.get(agentName)
  }

  /** Get stats for all agents */
  getAllStats(): Map<string, AgentTokenStats> {
    return new Map(this.agentStats)
  }

  /** Get total tokens used across all agents */
  getTotalTokens(): number {
    return this.totalTokens
  }

  /** Get recent records (for dashboard) */
  getRecent(limit = 50): TokenRecord[] {
    return this.records.slice(-limit)
  }

  /** Get tokens used in a specific cycle */
  getCycleTokens(agentName: string, cycleNumber: number): number {
    return this.records
      .filter(r => r.agentName === agentName && r.cycleNumber === cycleNumber)
      .reduce((sum, r) => sum + r.totalTokens, 0)
  }

  /** Get a formatted summary for the dashboard */
  formatSummary(): string {
    const lines: string[] = [`Total tokens: ${this.totalTokens.toLocaleString()}`]
    for (const [agent, stats] of this.agentStats) {
      const avgPerCall = stats.callCount > 0 ? Math.round(stats.totalTokens / stats.callCount) : 0
      lines.push(`  ${agent}: ${stats.totalTokens.toLocaleString()} tokens (${stats.callCount} calls, ~${avgPerCall}/call)`)
    }
    return lines.join("\n")
  }

  /** Update budget config */
  setBudget(budget: TokenBudget): void {
    this.budget = budget
  }
}
