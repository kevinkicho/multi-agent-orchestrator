import { resolve } from "path"
import { readJsonFile, writeJsonFile } from "./file-utils"

export type TaskStatus = "pending" | "in_progress" | "completed" | "failed"

export type Task = {
  id: string
  title: string
  description: string
  agent?: string
  status: TaskStatus
  createdAt: number
  startedAt?: number
  completedAt?: number
  result?: string
}

export type TaskQueue = {
  tasks: Task[]
}

function getQueuePath(): string {
  return resolve(process.cwd(), "orchestrator-tasks.json")
}

export async function loadTaskQueue(): Promise<TaskQueue> {
  return readJsonFile<TaskQueue>(getQueuePath(), { tasks: [] })
}

export async function saveTaskQueue(queue: TaskQueue): Promise<void> {
  await writeJsonFile(getQueuePath(), queue)
}

export async function addTask(queue: TaskQueue, task: Omit<Task, "id" | "status" | "createdAt">): Promise<TaskQueue> {
  const id = `task-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  const updated: TaskQueue = {
    tasks: [
      ...queue.tasks,
      { ...task, id, status: "pending", createdAt: Date.now() },
    ],
  }
  await saveTaskQueue(updated)
  return updated
}

export async function updateTask(queue: TaskQueue, id: string, updates: Partial<Pick<Task, "status" | "result">>): Promise<TaskQueue> {
  const updated: TaskQueue = {
    tasks: queue.tasks.map((t) =>
      t.id === id
        ? {
            ...t,
            ...updates,
            ...(updates.status === "in_progress" ? { startedAt: Date.now() } : {}),
            ...(updates.status === "completed" || updates.status === "failed" ? { completedAt: Date.now() } : {}),
          }
        : t,
    ),
  }
  await saveTaskQueue(updated)
  return updated
}

export function getNextPendingTask(queue: TaskQueue): Task | undefined {
  return queue.tasks.find((t) => t.status === "pending")
}

export function formatQueueForPrompt(queue: TaskQueue): string {
  if (queue.tasks.length === 0) return "No tasks in queue."
  const lines: string[] = ["## Task Queue"]
  for (const task of queue.tasks) {
    const status = task.status === "pending" ? "[ ]" :
                   task.status === "in_progress" ? "[>]" :
                   task.status === "completed" ? "[x]" :
                   "[!]"
    const agent = task.agent ? ` (${task.agent})` : ""
    lines.push(`${status} ${task.id}: ${task.title}${agent}`)
    if (task.description) lines.push(`    ${task.description}`)
    if (task.result) lines.push(`    Result: ${task.result.slice(0, 200)}`)
  }
  return lines.join("\n")
}
