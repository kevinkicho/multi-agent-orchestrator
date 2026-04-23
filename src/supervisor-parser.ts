/**
 * Supervisor command parsing — Socratic (@marker) + legacy (UPPERCASE) + JSON.
 *
 * Extracted from supervisor.ts so the parser is testable in isolation and the
 * orchestration loop stays focused on cycle flow. The unified entry point is
 * `parseSupervisorCommands` (tries Socratic first, falls back to legacy);
 * `parseJsonCommands` is used when the provider runs in JSON-mode.
 */

// ---------------------------------------------------------------------------
// Command types — shared by both Socratic and legacy parsers
// ---------------------------------------------------------------------------

export type SupervisorCommand =
  | { type: "prompt"; message: string }
  | { type: "wait" }
  | { type: "messages" }
  | { type: "review" }
  | { type: "restart" }
  | { type: "abort" }
  | { type: "note"; text: string }
  | { type: "note_behavior"; text: string }
  | { type: "directive"; text: string }
  | { type: "notify"; message: string }
  | { type: "intent"; description: string; files: string[] }
  | { type: "share"; text: string; files: string[]; kind: "discovery" | "lesson" | "observation" }
  | { type: "cycle_done"; summary: string }
  | { type: "stop"; summary: string }

// ---------------------------------------------------------------------------
// Socratic response parser — extracts actions from natural language + @ markers
// ---------------------------------------------------------------------------

/** All recognized @ markers (order matters — longer prefixes first to avoid partial matches) */
export const SOCRATIC_MARKERS = [
  { prefix: "@worker:", type: "prompt" as const, hasBody: true },
  { prefix: "@check", type: "messages" as const, hasBody: false },
  { prefix: "@review", type: "review" as const, hasBody: false },
  { prefix: "@restart", type: "restart" as const, hasBody: false },
  { prefix: "@abort", type: "abort" as const, hasBody: false },
  { prefix: "@lesson:", type: "note_behavior" as const, hasBody: true },
  { prefix: "@note:", type: "note" as const, hasBody: true },
  { prefix: "@directive:", type: "directive" as const, hasBody: true },
  { prefix: "@broadcast:", type: "broadcast" as const, hasBody: true },
  { prefix: "@intent:", type: "intent" as const, hasBody: true },
  { prefix: "@share:", type: "share" as const, hasBody: true },
  { prefix: "@done:", type: "cycle_done" as const, hasBody: true },
  { prefix: "@stop:", type: "stop" as const, hasBody: true },
] as const

export function matchMarker(line: string): { marker: typeof SOCRATIC_MARKERS[number]; rest: string } | null {
  const trimmed = line.trim()
  for (const m of SOCRATIC_MARKERS) {
    if (m.hasBody) {
      if (trimmed.startsWith(m.prefix)) {
        return { marker: m, rest: trimmed.slice(m.prefix.length).trim() }
      }
    } else {
      // Exact match (possibly with trailing whitespace/punctuation)
      if (trimmed === m.prefix || trimmed.startsWith(m.prefix + " ") || trimmed === m.prefix + ".") {
        return { marker: m, rest: "" }
      }
    }
  }
  return null
}

export function parseSocraticResponse(response: string): { commands: SupervisorCommand[]; thinking: string } {
  const commands: SupervisorCommand[] = []
  const thinkingLines: string[] = []

  // Strip LLM think tags
  const cleaned = response.replace(/<\/?think>/gi, "\n")
  const lines = cleaned.split("\n")

  let currentMarker: { marker: typeof SOCRATIC_MARKERS[number]; bodyLines: string[] } | null = null

  function flushCurrent() {
    if (!currentMarker) return
    const body = currentMarker.bodyLines.join("\n").trim()
    const m = currentMarker.marker

    switch (m.type) {
      case "prompt":
        if (body) commands.push({ type: "prompt", message: body })
        // Implicit wait after every @worker message
        commands.push({ type: "wait" })
        break
      case "messages":
        commands.push({ type: "messages" })
        break
      case "review":
        commands.push({ type: "review" })
        break
      case "restart":
        commands.push({ type: "restart" })
        break
      case "abort":
        commands.push({ type: "abort" })
        break
      case "note":
        if (body) commands.push({ type: "note", text: body })
        break
      case "note_behavior":
        if (body) commands.push({ type: "note_behavior", text: body })
        break
      case "directive":
        if (body) commands.push({ type: "directive", text: body })
        break
      case "broadcast":
        if (body) commands.push({ type: "notify", message: body })
        break
      case "intent": {
        const filesMatch = body.match(/\[files?:\s*([^\]]+)\]/)
        const files = filesMatch
          ? filesMatch[1]?.split(",").map(f => f.trim()).filter(Boolean) ?? []
          : []
        const description = body.replace(/\[files?:\s*[^\]]+\]/, "").trim()
        if (description) commands.push({ type: "intent", description, files })
        break
      }
      case "share": {
        const shareFilesMatch = body.match(/\[files?:\s*([^\]]+)\]/)
        const shareFiles = shareFilesMatch
          ? shareFilesMatch[1]?.split(",").map(f => f.trim()).filter(Boolean) ?? []
          : []
        const shareText = body.replace(/\[files?:\s*[^\]]+\]/, "").trim()
        // Default kind to "discovery" unless text starts with "LESSON:" or "OBSERVATION:"
        let kind: "discovery" | "lesson" | "observation" = "discovery"
        if (shareText.startsWith("LESSON:") || shareText.startsWith("lesson:")) kind = "lesson"
        else if (shareText.startsWith("OBSERVATION:") || shareText.startsWith("observation:")) kind = "observation"
        if (shareText) commands.push({ type: "share", text: shareText, files: shareFiles, kind })
        break
      }
      case "cycle_done":
        commands.push({ type: "cycle_done", summary: body || "Cycle completed." })
        break
      case "stop":
        commands.push({ type: "stop", summary: body || "Supervisor stopped." })
        break
    }
    currentMarker = null
  }

  for (const line of lines) {
    const match = matchMarker(line)
    if (match) {
      // Flush any pending marker
      flushCurrent()
      // Start new marker
      currentMarker = { marker: match.marker, bodyLines: match.rest ? [match.rest] : [] }
      // No-body markers can be flushed immediately
      if (!match.marker.hasBody) {
        flushCurrent()
      }
    } else if (currentMarker && currentMarker.marker.hasBody) {
      // Continuation line for a multi-line marker body
      currentMarker.bodyLines.push(line)
    } else {
      // Free thinking — preserved as context
      thinkingLines.push(line)
    }
  }

  // Flush any trailing marker
  flushCurrent()

  return { commands, thinking: thinkingLines.join("\n").trim() }
}

// ---------------------------------------------------------------------------
// Legacy command parsing — fallback for older command format
// ---------------------------------------------------------------------------

export const LEGACY_COMMAND_PREFIXES = [
  "PROMPT ", "WAIT", "MESSAGES", "REVIEW", "RESTART", "ABORT",
  "NOTE_BEHAVIOR ", "NOTE ", "DIRECTIVE ", "NOTIFY ", "INTENT ",
  "CYCLE_DONE", "STOP",
]

export function isCommandLine(trimmed: string): boolean {
  return LEGACY_COMMAND_PREFIXES.some(p => trimmed === p.trim() || trimmed.startsWith(p))
}

export function parseLegacyCommands(response: string): SupervisorCommand[] {
  const commands: SupervisorCommand[] = []
  const cleaned = response.replace(/<\/?think>/gi, "\n")

  const codeBlockMatch = cleaned.match(/```commands?\n([\s\S]*?)```/)
  const lines = codeBlockMatch
    ? codeBlockMatch[1]?.split("\n") ?? cleaned.split("\n")
    : cleaned.split("\n")

  let lastPrompt: { type: "prompt"; message: string } | null = null

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue

    if (trimmed.startsWith("PROMPT ")) {
      lastPrompt = { type: "prompt", message: trimmed.slice(7) }
      commands.push(lastPrompt)
    } else if (trimmed === "WAIT") {
      lastPrompt = null
      commands.push({ type: "wait" })
    } else if (trimmed === "MESSAGES") {
      lastPrompt = null
      commands.push({ type: "messages" })
    } else if (trimmed === "REVIEW") {
      lastPrompt = null
      commands.push({ type: "review" })
    } else if (trimmed === "RESTART") {
      lastPrompt = null
      commands.push({ type: "restart" })
    } else if (trimmed === "ABORT") {
      lastPrompt = null
      commands.push({ type: "abort" })
    } else if (trimmed.startsWith("NOTE_BEHAVIOR ")) {
      lastPrompt = null
      commands.push({ type: "note_behavior", text: trimmed.slice(14) })
    } else if (trimmed.startsWith("NOTE ")) {
      lastPrompt = null
      commands.push({ type: "note", text: trimmed.slice(5) })
    } else if (trimmed.startsWith("DIRECTIVE ")) {
      lastPrompt = null
      commands.push({ type: "directive", text: trimmed.slice(10) })
    } else if (trimmed.startsWith("NOTIFY ")) {
      lastPrompt = null
      commands.push({ type: "notify", message: trimmed.slice(7) })
    } else if (trimmed.startsWith("INTENT ")) {
      lastPrompt = null
      const rest = trimmed.slice(7)
      const filesMatch = rest.match(/\[files?:\s*([^\]]+)\]/)
      const files = filesMatch
        ? filesMatch[1]?.split(",").map(f => f.trim()).filter(Boolean) ?? []
        : []
      const description = rest.replace(/\[files?:\s*[^\]]+\]/, "").trim()
      commands.push({ type: "intent", description, files })
    } else if (trimmed.startsWith("CYCLE_DONE")) {
      lastPrompt = null
      commands.push({ type: "cycle_done", summary: trimmed.slice(10).trim() || "Cycle completed." })
    } else if (trimmed.startsWith("STOP")) {
      lastPrompt = null
      commands.push({ type: "stop", summary: trimmed.slice(4).trim() || "Supervisor stopped." })
    } else if (lastPrompt) {
      lastPrompt.message += "\n" + trimmed
    }
  }

  return commands
}

/** Unified parser: try Socratic @ markers first, fall back to legacy UPPERCASE commands */
export function parseSupervisorCommands(response: string): SupervisorCommand[] {
  // Try Socratic parsing first
  const socratic = parseSocraticResponse(response)
  if (socratic.commands.length > 0) return socratic.commands

  // Fall back to legacy command format
  return parseLegacyCommands(response)
}

/**
 * Parse JSON-mode responses: LLM returns { commands: ["CMD arg", ...], thinking?: "..." }
 * Falls back to text parsing if JSON is malformed.
 */
export function parseJsonCommands(response: string): SupervisorCommand[] {
  try {
    const parsed = JSON.parse(response) as { commands?: string[]; actions?: string[]; thinking?: string }
    const items = parsed.actions ?? parsed.commands
    if (Array.isArray(items)) {
      // Convert JSON array to newline-separated text and parse through unified parser
      const asText = items.join("\n")
      return parseSupervisorCommands(asText)
    }
  } catch {
    // Not valid JSON — fall through to text parsing
  }
  return parseSupervisorCommands(response)
}

/** JSON-mode instruction appended to system prompt when structuredOutput is enabled */
export const JSON_MODE_INSTRUCTION = `

IMPORTANT: You MUST respond with a JSON object. Format:
{"actions": ["@check", "@worker: your message here"], "thinking": "your reasoning"}

Example:
{"actions": ["@check"], "thinking": "Let me see what the worker has been doing before deciding next steps"}

Every action goes as a string in the "actions" array, using the @ marker format documented above.
Do NOT use a code block — respond with pure JSON only.`
