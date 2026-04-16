import type { AgentState } from "./agent"

export type AgentEvent = {
  agentName: string
  event: {
    type: string
    properties: Record<string, unknown>
  }
}

export type EventHandler = (event: AgentEvent) => void

/**
 * Subscribe to SSE events from an opencode serve instance.
 * Returns an abort function to stop listening.
 */
export function subscribeToAgentEvents(
  agent: AgentState,
  handler: EventHandler,
): { abort: () => void } {
  const controller = new AbortController()
  const url = `${agent.config.url}/event`

  const headers: Record<string, string> = {
    Accept: "text/event-stream",
  }
  if (agent.config.password) {
    headers["Authorization"] = `Bearer ${agent.config.password}`
  }
  if (agent.config.directory) {
    headers["x-opencode-directory"] = encodeURIComponent(agent.config.directory)
  }

  async function connect() {
    while (!controller.signal.aborted) {
      try {
        const response = await fetch(url, {
          headers,
          signal: controller.signal,
        })

        if (!response.ok) {
          console.error(`[${agent.config.name}] SSE connection failed: ${response.status}`)
          await sleep(3000)
          continue
        }

        const reader = response.body?.getReader()
        if (!reader) {
          // Consume the response to prevent connection leak
          await response.text().catch(() => {})
          console.error(`[${agent.config.name}] No response body`)
          await sleep(3000)
          continue
        }

        const decoder = new TextDecoder()
        let buffer = ""

        try {
          while (!controller.signal.aborted) {
            const { done, value } = await reader.read()
            if (done) break

            buffer += decoder.decode(value, { stream: true })
            const lines = buffer.split("\n")
            buffer = lines.pop() ?? ""

            for (const line of lines) {
              if (!line.startsWith("data:")) continue
              const data = line.slice(5).trim()
              if (!data) continue

              try {
                const parsed = JSON.parse(data)
                handler({
                  agentName: agent.config.name,
                  event: parsed,
                })
              } catch {
                // skip malformed JSON
              }
            }
          }
        } finally {
          // Release the reader so the underlying connection is freed
          reader.cancel().catch(() => {})
        }
      } catch (err) {
        if (controller.signal.aborted) return
        console.error(`[${agent.config.name}] SSE error:`, err)
        await sleep(3000)
      }
    }
  }

  connect()

  return {
    abort: () => controller.abort(),
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
