/** Shared utilities for extracting text from OpenCode message arrays and LLM conversations */

type LLMMessage = { role: "system" | "user" | "assistant"; content: string }

/** Shape of an OpenCode message (from the SDK). We only type the fields we use. */
type OpenCodeMessage = {
  info?: { role?: string }
  parts?: Array<{
    type?: string
    text?: string
    tool?: string
    name?: string
  }>
}

/** Priority message prefix pattern — these messages survive trimming longer */
const PRIORITY_PREFIX = /^\[(VALIDATION|DIRECTIVE|URGENT|WARNING|REDIRECT)\]/

/** Trim an LLM conversation to stay within model context limits.
 *  Keeps the system prompt (index 0) and the most recent messages.
 *  Priority-tagged messages ([VALIDATION], [DIRECTIVE], [URGENT], [WARNING])
 *  are preserved longer — non-priority messages are trimmed first.
 *  Inserts a summary marker so the LLM knows context was trimmed. */
export function trimConversation(messages: LLMMessage[], maxMessages = 60): void {
  if (messages.length <= maxMessages) return

  const keep = maxMessages - 2
  const startIdx = 1 // skip system prompt
  const endIdx = messages.length - keep // trim zone boundary

  if (endIdx <= startIdx) return

  // Separate priority and non-priority messages in the trim zone
  const priorityMsgs: { idx: number; msg: LLMMessage }[] = []
  const nonPriorityIndices: number[] = []

  for (let i = startIdx; i < endIdx; i++) {
    const isPriority = PRIORITY_PREFIX.test(messages[i]!.content)
    // Also protect assistant messages that immediately follow a priority user message
    const followsPriority = i > startIdx &&
      messages[i]!.role === "assistant" &&
      PRIORITY_PREFIX.test(messages[i - 1]!.content)
    if (isPriority || followsPriority) {
      priorityMsgs.push({ idx: i, msg: messages[i]! })
    } else {
      nonPriorityIndices.push(i)
    }
  }

  // Capture messages before removing (forward order for readable summary)
  const removedMsgs: LLMMessage[] = nonPriorityIndices.map(i => messages[i]!)

  // Remove non-priority messages from trim zone (reverse order to preserve indices)
  for (let i = nonPriorityIndices.length - 1; i >= 0; i--) {
    messages.splice(nonPriorityIndices[i]!, 1)
  }

  // If still over limit after removing non-priority, trim oldest priority messages
  if (messages.length > maxMessages) {
    const excess = messages.length - maxMessages
    messages.splice(1, excess)
  }

  // Build compressed summary of removed messages before inserting marker
  if (nonPriorityIndices.length > 0) {
    const roundsTrimmed = Math.floor(nonPriorityIndices.length / 2)
    // removedMsgs were spliced out — reconstruct from saved copies
    const summaryParts = summarizeRemovedMessages(removedMsgs)
    const summaryText = summaryParts.length > 0
      ? `\n\nKey context from removed messages:\n${summaryParts.join("\n")}`
      : ""
    messages.splice(1, 0, {
      role: "user",
      content: `[Context trimmed: ${roundsTrimmed} earlier rounds removed. High-priority messages preserved.]${summaryText}`,
    })
  }
}

// ---------------------------------------------------------------------------
// Deterministic message summarization — extracts key facts from trimmed messages
// ---------------------------------------------------------------------------

/** Command patterns we extract from assistant messages */
const CMD_PATTERN = /^(PROMPT|CYCLE_DONE|STOP|DIRECTIVE|NOTE|NOTE_BEHAVIOR|INTENT|NOTIFY|DONE)\b/

/** Extract a compressed summary of removed messages (no LLM call needed) */
function summarizeRemovedMessages(messages: LLMMessage[], maxItems = 8): string[] {
  const items: string[] = []

  for (const msg of messages) {
    if (items.length >= maxItems) break

    if (msg.role === "assistant") {
      // Extract commands the LLM issued
      const codeBlockMatch = msg.content.match(/```commands?\n([\s\S]*?)```/)
      if (codeBlockMatch) {
        const cmdLines = codeBlockMatch[1]!.split("\n").map(l => l.trim()).filter(l => CMD_PATTERN.test(l))
        for (const line of cmdLines.slice(0, 2)) {
          items.push(`- Issued: ${line.slice(0, 120)}`)
          if (items.length >= maxItems) break
        }
      }
      // Extract CYCLE_DONE/STOP summaries
      const cycleDone = msg.content.match(/CYCLE_DONE\s+(.+)/)
      if (cycleDone) items.push(`- Completed cycle: ${cycleDone[1]!.slice(0, 120)}`)
    } else if (msg.role === "user") {
      // Extract key results/status from user messages (system feedback)
      const content = msg.content
      if (content.includes("Agent status:")) {
        const statusMatch = content.match(/Agent status:\s*(\S+)/)
        if (statusMatch) items.push(`- Agent was ${statusMatch[1]}`)
      }
      if (content.includes("test") && /\d+\s*(pass|fail)/i.test(content)) {
        const testMatch = content.match(/(\d+\s*(?:pass|fail)[^\n]{0,60})/i)
        if (testMatch) items.push(`- Test results: ${testMatch[1]}`)
      }
      if (content.includes("error") || content.includes("Error")) {
        const errorLine = content.split("\n").find(l => /error/i.test(l))
        if (errorLine) items.push(`- Error: ${errorLine.trim().slice(0, 120)}`)
      }
      // Extract directive context
      if (content.startsWith("Directive:")) {
        items.push(`- ${content.slice(0, 100)}`)
      }
    }
  }

  return items
}

/** Extract the last assistant text response from a message array */
export function extractLastAssistantText(messages: unknown[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as OpenCodeMessage
    if (m?.info?.role !== "assistant") continue
    const texts: string[] = []
    for (const p of m.parts ?? []) {
      if (p.type === "text" && p.text) texts.push(p.text)
    }
    if (texts.length > 0) return texts.join("\n")
  }
  return null
}

/** Format recent messages into a readable summary for LLM context */
export function formatRecentMessages(messages: unknown[], count = 6, maxLen = 3000): string[] {
  const recent = messages.slice(-count)
  const formatted: string[] = []
  for (const msg of recent) {
    const m = msg as OpenCodeMessage
    const role = m.info?.role ?? "?"
    const parts = m.parts ?? []
    const texts: string[] = []
    for (const p of parts) {
      if (p.type === "text" && p.text) texts.push(p.text)
      else if (p.type === "tool-use") texts.push(`[tool: ${p.tool ?? p.name ?? "?"}]`)
      else if (p.type === "tool-result") texts.push(`[tool-result]`)
    }
    const content = texts.join("\n") || "(no text)"
    formatted.push(`[${role}] ${content.slice(0, maxLen)}`)
  }
  return formatted
}
