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

/** Trim an LLM conversation to stay within model context limits.
 *  Keeps the system prompt (index 0) and the most recent messages.
 *  Inserts a summary marker so the LLM knows context was trimmed. */
export function trimConversation(messages: LLMMessage[], maxMessages = 60): void {
  if (messages.length <= maxMessages) return
  // Keep system prompt + last (maxMessages - 2) messages + a summary marker
  const keep = maxMessages - 2
  const trimmed = messages.splice(1, messages.length - 1 - keep)
  const roundsTrimmed = Math.floor(trimmed.length / 2)
  messages.splice(1, 0, {
    role: "user",
    content: `[Context trimmed: ${roundsTrimmed} earlier rounds removed to stay within context limits. Recent conversation follows.]`,
  })
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
