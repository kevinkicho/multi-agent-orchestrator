/** Shared utilities for extracting text from OpenCode message arrays */

/** Extract the last assistant text response from a message array */
export function extractLastAssistantText(messages: unknown[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as any
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
    const m = msg as any
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
