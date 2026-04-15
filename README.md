# Multi-Agent Orchestrator

Orchestrate multiple AI coding agents with LLM-driven task planning, real-time supervision, and a live web dashboard.

Multi-Agent Orchestrator spawns and manages multiple [opencode](https://github.com/nicepkg/opencode) instances as headless coding agents, each working on a separate project directory. A local LLM (via [Ollama](https://ollama.ai/)) acts as a "brain" that plans tasks, reviews agent output, and coordinates work across all agents autonomously.

## Table of Contents

- [Architecture](#architecture)
- [Features](#features)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Configuration](#configuration)
- [Usage](#usage)
- [Web Dashboard](#web-dashboard)
- [CLI Commands](#cli-commands)
- [How It Works](#how-it-works)
- [File Reference](#file-reference)
- [Function Reference](#function-reference)
- [API Endpoints](#api-endpoints)
- [License](#license)

---

## Architecture

```
                          +------------------+
                          |     Ollama       |
                          |   (Local LLM)   |
                          +--------+---------+
                                   |
                          +--------v---------+
                          |     Brain /      |
                          |   Supervisor     |
                          +--------+---------+
                                   |
                    +--------------+---------------+
                    |              |               |
             +------v------+ +----v-------+ +-----v------+
             |  Project A  | | Project B  | | Project C  |
             |  Supervisor | | Supervisor | | Supervisor |
             +------+------+ +-----+------+ +-----+------+
                    |              |               |
             +------v------+ +----v-------+ +-----v------+
             |  opencode   | | opencode   | | opencode   |
             |  serve :3001| | serve :3002| | serve :3003|
             +------+------+ +-----+------+ +-----+------+
                    |              |               |
             +------v------+ +----v-------+ +-----v------+
             |  Project A  | | Project B  | | Project C  |
             |  directory  | | directory  | | directory  |
             +-------------+ +------------+ +------------+

             +------------------------------------------------+
             |        Web Dashboard (http://127.0.0.1:4000)   |
             |   Real-time logs, permissions, controls per    |
             |   project with collapsible worker/supervisor   |
             |   panels                                       |
             +------------------------------------------------+
```

Each project gets:
- A dedicated **opencode serve** instance (worker agent) on its own port
- A dedicated **LLM supervisor** that reviews the worker's output, assigns tasks, and provides feedback
- A **row in the dashboard** with separate worker and supervisor log panels

---

## Features

- **Dynamic project management** -- Add and remove projects at runtime via the dashboard or CLI. No need to pre-configure agents.
- **LLM-powered supervision** -- Each project gets an autonomous supervisor that reviews code, catches bugs, assigns tasks, and tracks progress across cycles.
- **Brain mode** -- A higher-level orchestrator brain that coordinates across all agents with a single objective.
- **Live web dashboard** -- Real-time streaming logs, permission approval UI, command palette, project add/remove controls, and export functionality.
- **Persistent memory** -- The brain and supervisors remember context across sessions via a JSON-based memory store.
- **Task queue** -- Built-in task queue for structured work assignment.
- **Permission handling** -- Auto-approve or manually review tool permissions through the dashboard.
- **Auto-reconnect** -- Health monitoring with automatic reconnection when agents come back online.
- **Crash resilience** -- Promise-chain mutexes, async write locks, retry logic, and partial-failure tolerance throughout.

---

## Prerequisites

- **[Bun](https://bun.sh/)** -- JavaScript runtime (v1.0+)
- **[opencode](https://github.com/nicepkg/opencode)** -- AI coding assistant with `serve` mode. Set `OPENCODE_DIR` environment variable to the opencode project root, or place it as a sibling directory.
- **[Ollama](https://ollama.ai/)** -- Local LLM inference server. The supervisor brain communicates via Ollama's OpenAI-compatible API.
- **An Ollama model** -- Default is `glm-5.1:cloud`. Pull it with `ollama pull glm-5.1:cloud` or configure a different model.

---

## Installation

```bash
# Clone the repository
git clone https://github.com/kevinkicho/multi-agent-orchestrator.git
cd multi-agent-orchestrator

# Install dependencies
bun install
```

---

## Configuration

Configuration is loaded from `orchestrator.json` in the project root:

```json
{
  "autoApprove": false,
  "pollInterval": 2000,
  "dashboardPort": 4000,
  "brain": {
    "model": "glm-5.1:cloud",
    "ollamaUrl": "http://127.0.0.1:11434"
  },
  "agents": []
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `autoApprove` | `boolean` | `false` | Auto-approve all agent permission requests |
| `pollInterval` | `number` | `2000` | Milliseconds between permission polling cycles |
| `dashboardPort` | `number` | `4000` | Port for the web dashboard |
| `brain.model` | `string` | `"glm-5.1:cloud"` | Ollama model name for the supervisor brain |
| `brain.ollamaUrl` | `string` | `"http://127.0.0.1:11434"` | Ollama API base URL |
| `agents` | `AgentConfig[]` | `[]` | Optional pre-configured agents (usually left empty; projects are added dynamically) |

### Environment Variables

| Variable | Description |
|----------|-------------|
| `OPENCODE_DIR` | Path to the opencode project root. Defaults to `../../opencode` relative to the orchestrator. |
| `OPENCODE_PROJECT_DIR` | Set automatically per agent process to scope each opencode instance to its project directory. |

---

## Usage

### Option A: CLI only (recommended)

```bash
bun run src/cli.ts
```

This starts the orchestrator with the interactive REPL and web dashboard. Add projects dynamically via the dashboard or CLI commands.

### Option B: Launcher mode (pre-configured agents)

```bash
bun run src/launcher.ts
```

Reads `orchestrator.json`, spawns all configured `opencode serve` instances, then starts the orchestrator CLI. Useful if you want to pre-define agents in the config file.

### Option C: CLI with flags

```bash
bun run src/cli.ts --auto-approve --dashboard-port 5000 --verbose
```

| Flag | Description |
|------|-------------|
| `--auto-approve` | Auto-approve all permission requests |
| `--dashboard-port <port>` | Override dashboard port |
| `--verbose` / `-v` | Log all raw SSE events |
| `--config <path>` / `-c <path>` | Path to a custom config file |
| `--agent <name>=<url>=<dir>` | Add an agent inline (repeatable) |

---

## Web Dashboard

The dashboard is served at `http://127.0.0.1:4000` (configurable) and provides:

- **Dynamic project rows** -- Each project appears as a collapsible row with side-by-side worker and supervisor panels
- **Real-time streaming** -- Worker events, supervisor thoughts, and agent responses stream in as they happen
- **Command palette** -- Ctrl+K to open, with quick commands for adding projects, sending prompts, checking status
- **Permission approvals** -- Visual permission request cards with approve/deny/approve-all buttons
- **Project management** -- Add projects via folder browser, remove projects, restart supervisors
- **Collapsible brain section** -- Global brain/orchestrator-level thinking logs
- **Export logs** -- Download all logs as a text file, organized by project with worker and supervisor sections
- **Status badges** -- Real-time status indicators per project (idle, busy, error, supervising)

---

## CLI Commands

When the orchestrator is running, the interactive REPL accepts:

| Command | Description |
|---------|-------------|
| `<agent-name> <prompt>` | Send a prompt to a specific agent |
| `all <prompt>` | Send a prompt to all agents |
| `brain <objective>` | Start the LLM brain with a one-shot objective |
| `brain-loop [directive]` | Start parallel per-agent supervisors |
| `brain-queue` | Process the task queue with the brain |
| `stop` | Soft stop all running supervisors |
| `projects` | List active projects |
| `project add <dir> [name]` | Add a new project (spawns agent + supervisor) |
| `project remove <id>` | Remove a project and kill its agent |
| `tasks` | Show the task queue |
| `task add <title>` | Add a task to the queue |
| `status` | Show agent connection status |
| `messages <agent-name>` | Show recent messages from an agent |
| `quit` / `exit` | Shut down everything |

---

## How It Works

### Project Lifecycle

1. **Add a project** -- via dashboard or `project add <directory>`. The ProjectManager:
   - Finds a free port starting from 3001
   - Spawns an `opencode serve` instance pointed at the project directory
   - Waits for the health check to pass
   - Registers the agent with the orchestrator (creates a session, subscribes to SSE events)
   - Starts an autonomous supervisor loop for that project

2. **Supervision cycle** -- Each project's supervisor runs in a loop:
   - Reads the agent's recent messages
   - Asks the LLM to review the work and decide next steps
   - Executes commands: `PROMPT` (send task), `WAIT` (wait for completion), `MESSAGES` (read output), `REVIEW` (trigger code review), `NOTE` (save persistent note), `CYCLE_DONE` (end cycle)
   - Pauses between cycles (default 30s), then repeats

3. **Remove a project** -- Stops the supervisor, kills the opencode process, releases the port, removes from the orchestrator.

### Brain Mode

The brain is a higher-level orchestrator that manages multiple agents with a single objective. It can:
- Send prompts to specific agents or all agents
- Check agent status and read messages
- Wait for agents to finish work
- Save notes and session summaries to persistent memory
- Declare the objective complete

### Memory System

The orchestrator persists state in `.orchestrator-memory.json`:
- **Session entries** -- Summaries of past brain/supervisor sessions (last 50)
- **Project notes** -- Per-agent notes accumulated by supervisors (last 20 per agent)

Memory is loaded at the start of each cycle and included in the LLM context, so supervisors remember what happened in previous sessions.

### Event System

Each agent's opencode instance streams Server-Sent Events (SSE). The orchestrator:
- Subscribes to each agent's `/event` endpoint
- Filters noisy events (deltas, heartbeats) from notable ones (status changes, permission requests)
- Forwards events to the dashboard via long-polling
- Tracks agent busy/idle transitions to know when work is complete

---

## File Reference

### Source Files (`src/`)

| File | Description |
|------|-------------|
| `cli.ts` | Entry point: parses config/args, sets up the REPL, wires the orchestrator to the dashboard and project manager. |
| `launcher.ts` | Alternative entry point that spawns all pre-configured opencode serve instances before starting the CLI. |
| `orchestrator.ts` | Core orchestration engine: manages agent connections, prompt queuing, SSE subscriptions, health monitoring, and the public API. |
| `agent.ts` | Agent abstraction: wraps the opencode SDK client with session management, prompting, message retrieval, and health checks. |
| `events.ts` | SSE client: connects to each agent's event stream with auto-reconnect and parses incoming server-sent events. |
| `supervisor.ts` | LLM supervisor loop: runs per-agent supervision cycles where the brain reviews work, assigns tasks, and manages project progress. |
| `brain.ts` | Higher-level brain: coordinates multiple agents toward a single objective using LLM-driven planning and command execution. |
| `brain-memory.ts` | Persistent memory store: read/write session summaries and project notes to disk with async write locks for concurrency safety. |
| `project-manager.ts` | Dynamic project provisioning: spawns opencode processes, allocates ports, manages project lifecycle, and handles crash recovery. |
| `dashboard.ts` | Web dashboard: HTTP server with REST API endpoints, long-poll event streaming, and an embedded single-page HTML/CSS/JS application. |
| `task-queue.ts` | Simple file-backed task queue for structured work assignment and progress tracking. |
| `message-utils.ts` | Shared utilities for extracting and formatting opencode message arrays into readable text. |
| `index.ts` | Public API barrel file: re-exports all types and functions for use as a library. |

### Config and Data Files

| File | Description |
|------|-------------|
| `orchestrator.json` | Main configuration file (brain model, dashboard port, auto-approve setting, optional pre-configured agents). |
| `orchestrator-projects.json` | Auto-saved list of active projects for quick restore on restart. |
| `.orchestrator-memory.json` | Persistent brain/supervisor memory (session summaries, project notes). |
| `orchestrator-tasks.json` | Task queue state (pending, in-progress, completed tasks). |
| `tsconfig.json` | TypeScript configuration extending `@tsconfig/bun`. |
| `package.json` | Package manifest with dependencies (`@opencode-ai/sdk`, `zod`) and scripts. |

---

## Function Reference

### `agent.ts` -- Agent Abstraction

| Function | Description |
|----------|-------------|
| `createAgent(config)` | Creates an agent state object with an opencode SDK client configured for the given URL and directory. |
| `agentCreateSession(agent)` | Creates a new session on the agent's opencode instance and returns the session ID. |
| `agentPrompt(agent, text, opts?)` | Sends a prompt to the agent's current session asynchronously (fires and returns immediately). |
| `agentGetMessages(agent)` | Retrieves all messages from the agent's current session. |
| `agentGetSessionStatus(agent)` | Gets the status of all sessions on the agent's opencode instance. |
| `agentListPermissions(agent)` | Lists all pending permission requests on the agent. |
| `agentReplyPermission(agent, requestID, reply)` | Replies to a specific permission request with approve, deny, or approve-all. |
| `agentAbort(agent)` | Aborts the currently running session on the agent. |
| `agentHealthCheck(agent)` | Checks if the agent's opencode server is reachable via the health endpoint. |

### `orchestrator.ts` -- Core Orchestration

| Function | Description |
|----------|-------------|
| `createOrchestrator(config)` | Initializes the orchestrator: connects to all configured agents, creates sessions, subscribes to events, starts health monitoring and permission polling. Returns the public `Orchestrator` API. |
| `orchestrator.prompt(agentName, text)` | Enqueues a prompt to a specific agent, waiting if the agent is busy (up to 5 minutes). |
| `orchestrator.promptAll(prompts)` | Sends prompts to multiple agents in parallel using `Promise.allSettled` for partial-failure tolerance. |
| `orchestrator.getMessages(agentName)` | Gets the latest messages from a specific agent's session. |
| `orchestrator.status()` | Returns a map of all agents with their current status, session ID, and last activity timestamp. |
| `orchestrator.addAgent(agentConfig)` | Dynamically registers a new agent at runtime: health check, session creation, and SSE subscription. |
| `orchestrator.removeAgent(name)` | Removes an agent: aborts its SSE subscription, cleans up its prompt queue, and marks it as disconnected. |
| `orchestrator.shutdown()` | Gracefully shuts down all connections, timers, and SSE subscriptions. |

### `supervisor.ts` -- LLM Supervision

| Function | Description |
|----------|-------------|
| `runAgentSupervisor(orchestrator, config)` | Runs an autonomous supervision loop for a single agent: cycles of LLM consultation, command execution, and pause. Supports hard stop (abort signal) and soft stop (finish current cycle). |
| `runParallelSupervisors(orchestrator, config)` | Starts parallel supervisor instances for all connected agents, each running independently. |
| `buildSupervisorPrompt(agentName, directory, reviewEnabled, hasReviewer)` | Generates the system prompt for a project supervisor including available commands and guidelines. |
| `parseSupervisorCommands(response)` | Parses the LLM's response into structured supervisor commands (PROMPT, WAIT, MESSAGES, REVIEW, NOTE, CYCLE_DONE, STOP). |
| `trimConversation(messages, maxMessages?)` | Trims the conversation history to stay within context limits, preserving the system prompt and inserting a summary marker. |
| `waitForAgent(orchestrator, agentName, timeoutMs?)` | Polls an agent's status until it is no longer busy (up to 5 minutes by default). |

### `brain.ts` -- High-Level Brain

| Function | Description |
|----------|-------------|
| `runBrain(orchestrator, config)` | Runs the orchestrator brain: a multi-round LLM loop that plans and executes commands across all agents toward a single objective. Saves progress to memory. |
| `chatCompletion(ollamaUrl, model, messages)` | Sends a chat completion request to Ollama's OpenAI-compatible API and returns the response text. Validates the response shape. |
| `parseCommands(response)` | Parses the brain's response into structured commands (PROMPT, PROMPT_ALL, STATUS, MESSAGES, WAIT, NOTE, DONE). |
| `formatAgentInfo(orchestrator)` | Formats a summary of all available agents and their directories for inclusion in the brain's context. |
| `waitForAgents(orchestrator, timeoutMs?)` | Polls all agents until none are busy (up to 5 minutes by default). |
| `trimConversation(messages, maxMessages?)` | Trims conversation history to stay within model context limits. |

### `brain-memory.ts` -- Persistent Memory

| Function | Description |
|----------|-------------|
| `loadBrainMemory()` | Loads the memory store from `.orchestrator-memory.json`, returning a default empty store if the file doesn't exist. |
| `saveBrainMemory(store)` | Writes the memory store to disk, creating the directory if needed. |
| `addMemoryEntry(store, entry)` | Adds a session summary entry to the memory store with async write lock protection. Keeps the last 50 entries. |
| `addProjectNote(store, agentName, note)` | Adds a per-agent project note to the memory store with async write lock protection. Keeps the last 20 notes per agent. |
| `formatMemoryForPrompt(store)` | Formats the memory store into a human-readable string for inclusion in LLM prompts. |
| `withWriteLock(fn)` | Promise-chain mutex that serializes concurrent write operations to prevent read-modify-write races. |

### `project-manager.ts` -- Dynamic Project Provisioning

| Function | Description |
|----------|-------------|
| `ProjectManager.addProject(directory, directive, name?)` | Adds a project: finds a free port, spawns an opencode serve instance, registers the agent, and starts a supervisor. Uses a promise-chain mutex to prevent concurrent add races. |
| `ProjectManager.removeProject(projectId)` | Removes a project: stops its supervisor, kills the opencode process, releases the port, and removes the agent from the orchestrator. |
| `ProjectManager.restartSupervisor(projectId, directive?)` | Stops the current supervisor for a project and starts a new one after a brief delay. |
| `ProjectManager.softStopAll()` | Requests a soft stop for all running supervisors (they finish their current cycle before stopping). |
| `ProjectManager.hardStopAll()` | Immediately aborts all supervisor loops. |
| `ProjectManager.listProjects()` | Returns an array of all project states. |
| `ProjectManager.getProject(id)` | Returns a single project state by ID. |
| `ProjectManager.loadSavedProjects()` | Loads previously saved project configurations from `orchestrator-projects.json` for restore on startup. |
| `ProjectManager.shutdown()` | Hard stops all supervisors and kills all spawned opencode processes. |
| `findFreePort(startFrom)` | Scans for an available port starting from the given number, reserving it immediately to prevent races. |
| `waitForServer(url, timeoutMs?)` | Polls a server's health endpoint until it responds OK (up to 60 seconds). |
| `listDirectories(dirPath)` | Lists subdirectories at a path for the dashboard's folder browser, filtering out hidden and system directories. |

### `events.ts` -- SSE Event Streaming

| Function | Description |
|----------|-------------|
| `subscribeToAgentEvents(agent, handler)` | Connects to an agent's SSE event stream with automatic reconnection on failure. Returns an abort handle. |

### `dashboard.ts` -- Web Dashboard

| Function / Class | Description |
|----------|-------------|
| `DashboardLog` | Event log class: buffers up to 500 events, supports pub/sub listeners, and provides history for long-polling clients. |
| `DashboardLog.push(event)` | Appends an event to the log and notifies all subscribers. |
| `DashboardLog.getHistory()` | Returns the full event history buffer. |
| `DashboardLog.subscribe(fn)` | Registers a listener for new events, returns an unsubscribe function. |
| `startDashboard(orchestrator, log, port, opts?)` | Starts the Bun HTTP server for the dashboard: serves the HTML SPA, REST API endpoints, and long-poll event streaming. |

### `task-queue.ts` -- Task Queue

| Function | Description |
|----------|-------------|
| `loadTaskQueue()` | Loads the task queue from `orchestrator-tasks.json`. |
| `saveTaskQueue(queue)` | Writes the task queue to disk. |
| `addTask(queue, task)` | Adds a new task with a unique ID and "pending" status. |
| `updateTask(queue, id, updates)` | Updates a task's status and/or result, automatically setting timestamps. |
| `getNextPendingTask(queue)` | Returns the first task with "pending" status. |
| `formatQueueForPrompt(queue)` | Formats the task queue as a readable checklist string for LLM prompts. |

### `message-utils.ts` -- Message Utilities

| Function | Description |
|----------|-------------|
| `extractLastAssistantText(messages)` | Extracts the text content from the most recent assistant message in an opencode message array. |
| `formatRecentMessages(messages, count?, maxLen?)` | Formats the N most recent messages into readable `[role] content` lines with truncation. |

### `cli.ts` -- CLI Entry Point

| Function | Description |
|----------|-------------|
| `main()` | Entry point: loads config, creates the orchestrator, project manager, and dashboard, then starts the interactive REPL. |
| `loadConfigFile()` | Searches for and parses `orchestrator.json` from the current directory or the package root. |
| `parseArgs()` | Parses CLI arguments and merges them with config file settings. |
| `handleCommand(command)` | Shared command handler used by both the REPL and the dashboard's `/api/command` endpoint. |
| `formatTime(ts)` | Formats a timestamp as a locale time string. |
| `statusIcon(status)` | Returns a bracketed status indicator like `[IDLE]`, `[BUSY]`, `[DOWN]`. |

### `launcher.ts` -- Launcher Entry Point

| Function | Description |
|----------|-------------|
| `main()` | Reads config, spawns all pre-configured opencode serve instances, waits for health checks, then launches the CLI orchestrator. |
| `loadConfig()` | Loads `orchestrator.json` for the launcher. |
| `extractPort(url)` | Extracts the port number from a URL string. |
| `waitForServer(url, timeoutMs?)` | Polls a server's health endpoint until it responds. |

### `index.ts` -- Public API

Barrel file that re-exports all public types and functions for use as a library:
- `Orchestrator`, `OrchestratorConfig`, `createOrchestrator`
- `AgentConfig`, `AgentState`, `AgentStatus`, `createAgent`
- `AgentEvent`, `EventHandler`, `subscribeToAgentEvents`
- `BrainConfig`, `runBrain`
- `BrainMemoryStore`, `BrainMemoryEntry`, `loadBrainMemory`, `saveBrainMemory`, `formatMemoryForPrompt`
- `DashboardLog`, `DashboardEvent`, `startDashboard`
- `ProjectManager`, `ProjectState`, `listDirectories`
- `Task`, `TaskQueue`, `loadTaskQueue`, `saveTaskQueue`, `addTask`, `updateTask`, `getNextPendingTask`, `formatQueueForPrompt`
- `AgentSupervisorConfig`, `ParallelSupervisorsConfig`, `ProjectRole`, `runAgentSupervisor`, `runParallelSupervisors`
- `extractLastAssistantText`, `formatRecentMessages`

---

## API Endpoints

The dashboard server exposes these REST endpoints:

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/` | Dashboard HTML page |
| `GET` | `/api/events?since=<cursor>` | Long-poll for new events (returns batch + new cursor) |
| `GET` | `/api/status` | Agent status map |
| `GET` | `/api/messages/<agent>` | Messages from a specific agent's session |
| `GET` | `/api/permissions` | List all pending permission requests |
| `POST` | `/api/permissions/<agent>/<requestID>` | Reply to a permission (body: `{ decision, reason? }`) |
| `POST` | `/api/prompt/<agent>` | Send a prompt to an agent (body: `{ text }`) |
| `POST` | `/api/command` | Execute a CLI command (body: `{ command }`) |
| `GET` | `/api/projects` | List active projects |
| `POST` | `/api/projects` | Add a project (body: `{ directory, directive?, name? }`) |
| `DELETE` | `/api/projects/<id>` | Remove a project |
| `GET` | `/api/browse?path=<dir>` | Browse directories for the folder picker |
| `GET` | `/api/saved-projects` | Load previously saved project configs |
| `POST` | `/api/soft-stop` | Request soft stop for all supervisors |

---

## License

MIT
