/**
 * Conversation Checkpoint — serialize/restore supervisor message arrays
 * so restarts resume from where they left off instead of cold-starting.
 */

import { resolve } from "path"
import { mkdirSync } from "fs"
import { atomicWrite, readFileOrNull } from "./file-utils"

type Message = { role: "system" | "user" | "assistant"; content: string }

export type ConversationCheckpoint = {
  agentName: string
  cycleNumber: number
  directive: string
  messages: Message[]
  savedAt: number
}

// Store checkpoints in .orchestrator/checkpoints/
const CHECKPOINT_DIR = resolve(process.cwd(), ".orchestrator", "checkpoints")

function ensureDir(): void {
  try { mkdirSync(CHECKPOINT_DIR, { recursive: true }) } catch {}
}

function checkpointPath(agentName: string): string {
  // Sanitize agent name for filesystem
  const safe = agentName.replace(/[^a-zA-Z0-9_-]/g, "_")
  return resolve(CHECKPOINT_DIR, `${safe}.json`)
}

/** Save a conversation checkpoint for a supervisor */
export async function saveConversationCheckpoint(
  agentName: string,
  cycleNumber: number,
  directive: string,
  messages: Message[],
): Promise<void> {
  ensureDir()
  const checkpoint: ConversationCheckpoint = {
    agentName,
    cycleNumber,
    directive,
    // Only keep last 30 messages to avoid huge checkpoint files
    messages: messages.slice(-30),
    savedAt: Date.now(),
  }
  await atomicWrite(checkpointPath(agentName), JSON.stringify(checkpoint, null, 2))
}

/** Load a conversation checkpoint for a supervisor. Returns null if none exists or is stale. */
export async function loadConversationCheckpoint(
  agentName: string,
  maxAgeMs = 24 * 60 * 60 * 1000, // default: 24 hours
): Promise<ConversationCheckpoint | null> {
  const content = await readFileOrNull(checkpointPath(agentName))
  if (!content) return null

  try {
    const checkpoint = JSON.parse(content) as ConversationCheckpoint
    // Check staleness
    if (Date.now() - checkpoint.savedAt > maxAgeMs) return null
    // Basic validation
    if (!checkpoint.agentName || !Array.isArray(checkpoint.messages)) return null
    return checkpoint
  } catch {
    return null
  }
}

/** Delete a conversation checkpoint (e.g., after clean completion) */
export async function clearConversationCheckpoint(agentName: string): Promise<void> {
  try {
    const { unlinkSync } = await import("fs")
    unlinkSync(checkpointPath(agentName))
  } catch {}
}
