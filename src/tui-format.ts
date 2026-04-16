// ---------------------------------------------------------------------------
// TUI formatting — ANSI colors for supervisor/team-manager terminal output
// ---------------------------------------------------------------------------

export const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
  gray: "\x1b[90m",
  brightRed: "\x1b[91m",
  brightGreen: "\x1b[92m",
  brightYellow: "\x1b[93m",
  brightMagenta: "\x1b[95m",
  brightCyan: "\x1b[96m",
}

/** Format a supervisor/team-manager thought for terminal output */
export function formatThought(agentName: string, text: string): string {
  const ts = C.gray + new Date().toLocaleTimeString() + C.reset
  const tag = C.cyan + `[${agentName}]` + C.reset

  // Cycle header — prominent separator
  if (text.includes("=====") && /CYCLE \d+/.test(text)) {
    const m = text.match(/CYCLE (\d+)/)
    const line = "\u2500".repeat(50)
    return `\n${C.brightMagenta}${C.bold}${line}\n  ${agentName} \u2014 Cycle ${m?.[1] ?? "?"}  ${ts}\n${line}${C.reset}`
  }

  // LLM round — show header, truncate body
  if (/^--- .+ cycle \d+, round \d+ ---/.test(text)) {
    const m = text.match(/cycle (\d+), round (\d+)/)
    const bodyStart = text.indexOf("\n")
    const body = bodyStart !== -1 ? text.slice(bodyStart + 1).trim() : ""
    const cmds = (body.match(/^(PROMPT|WAIT|MESSAGES|REVIEW|RESTART|ABORT|NOTE_BEHAVIOR|NOTE|DIRECTIVE|CYCLE_DONE|STOP)\b/gm) || [])
    const cmdSummary = cmds.length > 0 ? cmds.join(", ") : "no commands"
    const bodyLines = body.split("\n")
    const preview = bodyLines.slice(0, 3).map(l => `  ${C.dim}${l.slice(0, 120)}${C.reset}`).join("\n")
    const more = bodyLines.length > 3 ? `\n  ${C.gray}... ${bodyLines.length - 3} more lines${C.reset}` : ""
    return `${ts} ${tag} ${C.blue}${C.bold}Round ${m?.[2] ?? "?"}${C.reset} ${C.gray}\u2192 ${cmdSummary}${C.reset}\n${preview}${more}`
  }

  // Errors / circuit breaker (check before actions — CIRCUIT BREAKER text contains "restart caps" which would false-match action regex)
  if (/CIRCUIT BREAKER|UNKNOWN AGENT|LLM request failed|LLM retry failed|Ollama persistently|Error |ALERT/i.test(text)) {
    return `${ts} ${tag} ${C.brightRed}${C.bold}${text}${C.reset}`
  }

  // Rate limit
  if (/RATE LIMITED|429|cooling down|rate-limit|consecutive 429/i.test(text)) {
    return `${ts} ${tag} ${C.yellow}${text}${C.reset}`
  }

  // Restart / abort / review actions
  if (/Restarting .+ session|Agent restarted|Aborting .+|RESTART CAP|Throttling restart|Throttling auto-restart|consecutive empty responses.*restarting|Sending review to|Requesting self-review/i.test(text)) {
    return `${ts} ${tag} ${C.brightYellow}${text}${C.reset}`
  }

  // Cycle complete / supervisor lifecycle
  if (/Supervisor start|Supervisor stop|supervisor ended|Soft stop|Completed \d+ cycles|Cycle \d+ complete/i.test(text)) {
    return `${ts} ${tag} ${C.brightMagenta}${text}${C.reset}`
  }

  // Notes / directives
  if (/^(Note saved|Behavioral note saved|Directive updated)/i.test(text)) {
    return `${ts} ${tag} ${C.green}${text}${C.reset}`
  }

  // Meta / low-priority (pausing, waiting, nudging)
  if (/^(Pausing |Waiting for |Retrying in |next cycle pause|LLM returned empty|Agent responsiveness low|WARNING:)/i.test(text)) {
    return `${ts} ${tag} ${C.dim}${text}${C.reset}`
  }

  // Default
  return `${ts} ${tag} ${text}`
}
