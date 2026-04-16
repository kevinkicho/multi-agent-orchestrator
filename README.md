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
- [Testing](#testing)
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
- **Stuck agent detection and recovery** -- Orchestrator monitors agents for inactivity (busy with no new messages). Supervisors can issue `RESTART` and `ABORT` commands, and failed supervisors auto-restart after 10 seconds.
- **Behavioral learning** -- Supervisors save `NOTE_BEHAVIOR` lessons about how each agent works best. These notes are injected into future supervisor system prompts so the same mistakes are not repeated.
- **Summary validation** -- Rejects vague `CYCLE_DONE` and `STOP` summaries (e.g. "Done.", "Cycle completed."), forcing the LLM to provide actionable descriptions of what was accomplished.
- **Session resume** -- When a project is restarted, the supervisor detects existing memory and injects "RESUMING FROM PREVIOUS SESSION" context with project notes and instructions to check `git status` before assigning new work.
- **Per-project model selection** -- Choose different Ollama models per project via the dashboard. Useful for comparing model performance or matching model capability to project complexity.
- **Dynamic context size detection** -- Queries Ollama's `/api/show` endpoint to detect each model's context window and adapts `max_tokens` accordingly (up to 1/4 of context, capped at 16384).
- **Performance logging and comparison** -- Logs cycle completions, errors, restarts, and stuck events per project per model. The dashboard includes a model performance comparison table.
- **Brain mode** -- A higher-level orchestrator brain that coordinates across all agents with a single objective.
- **Live web dashboard** -- Real-time streaming logs, permission approval UI, command palette, project add/remove controls, directive editing, model selection, performance comparison, and export functionality.
- **Persistent memory** -- The brain and supervisors remember context across sessions via a JSON-based memory store with project notes and behavioral notes.
- **Task queue** -- Built-in task queue for structured work assignment.
- **Permission handling** -- Auto-approve or manually review tool permissions through the dashboard.
- **Auto-reconnect** -- Health monitoring with automatic reconnection when agents come back online.
- **Crash resilience** -- Promise-chain mutexes, async write locks, retry logic, partial-failure tolerance, and auto-restart on supervisor failure throughout.
- **Graceful shutdown** -- Signal handlers (SIGINT, SIGTERM, SIGHUP) and uncaught exception/rejection handlers ensure all ports are released, child processes killed, and supervisors stopped on any exit path.
- **API token authentication** -- Per-session UUID token protects all mutating dashboard API endpoints (POST/PUT/DELETE) against unauthorized local access.
- **Atomic file writes** -- All JSON persistence uses a write-to-temp-then-rename pattern to prevent corruption if the process crashes mid-write.
- **Configurable supervisor limits** -- Tune cycle pause, max rounds, restart caps, conversation size, and stuck thresholds via `orchestrator.json` without code changes.
- **Request timeouts** -- Ollama API calls abort after 5 minutes (chat completion) or 10 seconds (model info) to prevent indefinite hangs.
- **Port conflict detection** -- Pre-flight port availability check with actionable error messages before starting the dashboard server.
- **Behavioral note deduplication** -- Before saving a new behavioral note, checks keyword similarity against existing notes (60% overlap threshold) to prevent duplicate entries from repeated agent issues.
- **Dynamic supervisor cycle pause** -- Cycle pause adapts to agent responsiveness: backs off (up to 4x base, max 120s) when agents produce empty responses, resets when productive.
- **Performance log archival** -- Entries older than 7 days are automatically archived to daily files (`orchestrator-performance-archive/perf-YYYY-MM-DD.json`) instead of being dropped, preserving historical data while keeping the active log lean.
- **Directive history and comments** -- Track how project directives evolve over time (user vs supervisor changes), add comments on any historical entry, and revert to previous versions via the dashboard.
- **Project save/restore** -- Projects are auto-saved with their directives, models, and history. Restore from a previous session via the dashboard modal with directory existence pre-checks.
- **Project status visibility** -- Dashboard shows project-level status badges (STARTING, RUNNING, SUPERVISING, FINISHED, ERROR) that update in real-time alongside worker and supervisor badges.
- **Empty response escalation** -- Supervisors track consecutive empty agent responses with a 3-tier escalation: warn → abort → restart + behavioral note. Orchestrator-level stuck detection also monitors message content.

### Security

- **API token authentication** -- Dashboard generates a per-session UUID token injected into the HTML. All mutating requests (POST/PUT/DELETE) require this token in the `X-API-Token` header.
- **URL parameter sanitization** -- All path-extracted parameters are decoded and stripped of path traversal sequences and control characters.
- **Restricted directory browsing** -- The `/api/browse` endpoint blocks access to sensitive system paths (Windows, Program Files, /proc, /sys, etc.).
- **CORS restrictions** -- Only `127.0.0.1` and `localhost` origins are accepted.

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
  "supervisor": {
    "cyclePauseSeconds": 30,
    "maxRoundsPerCycle": 30,
    "maxRestartsPerCycle": 3,
    "maxConsecutiveFailedCycles": 3,
    "maxConversationMessages": 60,
    "stuckThresholdMs": 300000
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
| `supervisor.cyclePauseSeconds` | `number` | `30` | Seconds between supervision cycles |
| `supervisor.maxRoundsPerCycle` | `number` | `30` | Max LLM rounds per supervision cycle |
| `supervisor.maxRestartsPerCycle` | `number` | `3` | Max agent restarts allowed per cycle before circuit breaker |
| `supervisor.maxConsecutiveFailedCycles` | `number` | `3` | Consecutive failed cycles before supervisor pauses |
| `supervisor.maxConversationMessages` | `number` | `60` | Max messages in LLM conversation before trimming |
| `supervisor.stuckThresholdMs` | `number` | `300000` | Milliseconds before an agent is considered stuck (5 min) |
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
- **Directive editing** -- View and edit each project's directive in the dashboard settings panel; saving restarts the supervisor with the new directive
- **Per-project model selection** -- Choose an Ollama model per project from a dropdown populated by the Ollama API; changing the model restarts the supervisor
- **Blinking status badges** -- Status indicators blink when agents are active (busy, stuck, supervising, reviewing, starting, running) for visual clarity
- **Model performance comparison** -- Collapsible section showing cycles, errors, restarts, stuck events, and average cycle duration per model
- **Collapsible brain section** -- Global brain/orchestrator-level thinking logs
- **Directive history timeline** -- View the evolution of each project's directive over time with source badges (USER/SUPERVISOR), timestamps, user comments (with read status), and one-click revert to any historical version
- **Project save/restore** -- Projects auto-save on changes. Restore modal shows previously saved projects with directory existence checks, disabling entries for missing directories
- **Project status badges** -- Each project row shows a real-time status badge (STARTING, RUNNING, SUPERVISING, FINISHED, ERROR) alongside the worker and supervisor badges
- **Export logs** -- Download all logs as a text file, organized by project with worker and supervisor sections

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
   - Reads the agent's recent messages and loads persistent memory
   - Injects behavioral notes from previous cycles into the system prompt
   - On first cycle with existing memory, adds "RESUMING FROM PREVIOUS SESSION" context
   - Asks the LLM to review the work and decide next steps
   - Executes commands: `PROMPT` (send task), `WAIT` (wait for completion), `MESSAGES` (read output), `REVIEW` (trigger code review), `NOTE` (save persistent note), `NOTE_BEHAVIOR` (save behavioral lesson), `DIRECTIVE` (update project directive), `RESTART` (restart stuck agent), `ABORT` (cancel agent's work), `CYCLE_DONE` (end cycle), `STOP` (stop supervising)
   - Validates summaries before accepting `CYCLE_DONE` or `STOP`
   - Logs performance metrics (cycle duration, errors, restarts, stuck events)
   - Dynamically adjusts cycle pause based on responsiveness (backs off when agent is struggling, resets when productive)
   - Pauses between cycles (default 30s, up to 120s when agent is non-responsive), then repeats

3. **Stuck detection** -- The orchestrator monitors agents every 30 seconds. If an agent has been busy longer than the threshold (default 5 min) with no new messages, it's flagged as stuck. The supervisor can then issue `ABORT` or `RESTART` to recover.

4. **Failure recovery** -- If a supervisor stops due to a failure (detected by keywords like "stuck", "unresponsive", "crash" in the stop summary), the project manager auto-restarts the supervisor after 10 seconds.

5. **Remove a project** -- Stops the supervisor, kills the opencode process, releases the port, removes from the orchestrator.

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
- **Behavioral notes** -- Per-agent lessons about how agents work best (last 10 per agent), injected into future supervisor system prompts. Deduplicated by keyword similarity to prevent redundant entries.

Memory is loaded at the start of each cycle and included in the LLM context, so supervisors remember what happened in previous sessions.

### Performance Logging

The orchestrator logs performance events to `orchestrator-performance.json`:
- `supervisor_start` -- When a supervisor begins
- `cycle_complete` -- Successful cycle with duration and summary
- `cycle_error` -- LLM errors during a cycle
- `restart` -- Agent restart events
- `stuck` -- Agent stuck detection events
- `supervisor_stop` -- When a supervisor stops (normal or failure)

Performance data is aggregated by model in the dashboard's "Model Performance" section, enabling side-by-side comparison of different Ollama models. Entries older than 7 days are automatically archived to daily files in `orchestrator-performance-archive/` to keep the active log lean while preserving historical data.

### Dynamic Context Size Detection

When sending requests to Ollama, the orchestrator queries `/api/show` to detect the model's context window size. The `max_tokens` for completions is set to 1/4 of the model's context size (capped at 16384), ensuring optimal use of each model's capacity. Results are cached for 5 minutes per model.

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
| `cli.ts` | Entry point: parses config/args, sets up the REPL, wires the orchestrator to the dashboard and project manager. Includes stuck agent detection callback with auto-capture of last agent messages. |
| `launcher.ts` | Alternative entry point that spawns all pre-configured opencode serve instances before starting the CLI. |
| `orchestrator.ts` | Core orchestration engine: manages agent connections, prompt queuing, SSE subscriptions, health monitoring, stuck detection timer, agent abort/restart, and the public API. |
| `agent.ts` | Agent abstraction: wraps the opencode SDK client with session management, prompting, message retrieval, abort, and health checks. |
| `events.ts` | SSE client: connects to each agent's event stream with auto-reconnect and parses incoming server-sent events. |
| `supervisor.ts` | LLM supervisor loop: runs per-agent supervision cycles with behavioral notes injection, resume detection, summary validation, performance logging, and self-healing via RESTART/ABORT commands. |
| `brain.ts` | Higher-level brain: coordinates multiple agents toward a single objective using LLM-driven planning. Includes dynamic model context size detection from Ollama. |
| `brain-memory.ts` | Persistent memory store: read/write session summaries, project notes, and behavioral notes to disk with async write locks for concurrency safety. |
| `project-manager.ts` | Dynamic project provisioning: spawns opencode processes, allocates ports, manages project lifecycle, per-project model selection, directive updates, crash recovery, and auto-restart on supervisor failure. |
| `dashboard.ts` | Web dashboard: HTTP server with REST API endpoints (including directive editing, model selection, agent restart/abort, Ollama model list proxy, performance data), long-poll event streaming, and an embedded single-page HTML/CSS/JS application with blinking status badges. |
| `task-queue.ts` | Simple file-backed task queue for structured work assignment and progress tracking. |
| `message-utils.ts` | Shared utilities for extracting and formatting opencode message arrays into readable text, plus `trimConversation` for LLM context management. |
| `file-utils.ts` | Shared file I/O utilities: atomic writes (temp+rename), async `readJsonFile`/`writeJsonFile` using `Bun.file()`/`Bun.write()`. |
| `performance-log.ts` | Performance logging with write lock: records cycle completions, errors, restarts, and stuck events per project per model. Provides aggregation by model for comparison. |
| `dashboard.html` | Single-page dashboard application (~2249 lines of HTML/CSS/JS). Extracted from `dashboard.ts` for maintainability. Includes `apiFetch()` wrapper for API token authentication. |
| `index.ts` | Public API barrel file: re-exports all types and functions for use as a library. |
| `tests/core.test.ts` | Unit tests for `trimConversation`, `extractLastAssistantText`, `formatRecentMessages`. |
| `tests/brain-commands.test.ts` | Unit tests for brain and supervisor command parsers. |
| `tests/brain-memory.test.ts` | Unit tests for `isSimilarNote` behavioral note deduplication. |

### Config and Data Files

| File | Description |
|------|-------------|
| `orchestrator.json` | Main configuration file (brain model, dashboard port, auto-approve setting, supervisor limits, optional pre-configured agents). |
| `orchestrator-projects.json` | Auto-saved list of active projects (including per-project model selection) for quick restore on restart. |
| `.orchestrator-memory.json` | Persistent brain/supervisor memory (session summaries, project notes, behavioral notes). |
| `orchestrator-tasks.json` | Task queue state (pending, in-progress, completed tasks). |
| `orchestrator-performance.json` | Active performance log (last 500 entries; older entries archived automatically). |
| `orchestrator-performance-archive/` | Date-based performance archives (`perf-YYYY-MM-DD.json`). Entries older than 7 days are moved here automatically. |
| `tsconfig.json` | TypeScript configuration extending `@tsconfig/bun`. |
| `package.json` | Package manifest with dependencies (`@opencode-ai/sdk`, `zod`) and scripts (`dev`, `start`, `test`, `typecheck`). |

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
| `createOrchestrator(config)` | Initializes the orchestrator: connects to all configured agents, creates sessions, subscribes to events, starts health monitoring, stuck detection timer, and permission polling. Returns the public `Orchestrator` API. |
| `orchestrator.prompt(agentName, text)` | Enqueues a prompt to a specific agent, waiting if the agent is busy (up to 5 minutes). |
| `orchestrator.promptAll(prompts)` | Sends prompts to multiple agents in parallel using `Promise.allSettled` for partial-failure tolerance. |
| `orchestrator.getMessages(agentName)` | Gets the latest messages from a specific agent's session. |
| `orchestrator.status()` | Returns a map of all agents with their current status, session ID, and last activity timestamp. |
| `orchestrator.addAgent(agentConfig)` | Dynamically registers a new agent at runtime: health check, session creation, and SSE subscription. |
| `orchestrator.removeAgent(name)` | Removes an agent: aborts its SSE subscription, cleans up its prompt queue and stuck tracking, and marks it as disconnected. |
| `orchestrator.abortAgent(agentName)` | Aborts the current run on an agent, resetting its busy state and stuck tracking. |
| `orchestrator.restartAgent(agentName)` | Restarts an agent's session: aborts current work, creates a fresh session, and resets tracking. Returns the new session ID. |
| `orchestrator.shutdown()` | Gracefully shuts down all connections, timers (including stuck detection), and SSE subscriptions. |

### `supervisor.ts` -- LLM Supervision

| Function | Description |
|----------|-------------|
| `runAgentSupervisor(orchestrator, config)` | Runs an autonomous supervision loop for a single agent: cycles of LLM consultation, command execution, and pause. Includes behavioral notes injection, resume detection, summary validation, performance logging, and self-healing via RESTART/ABORT. Supports hard stop (abort signal) and soft stop (finish current cycle). |
| `runParallelSupervisors(orchestrator, config)` | Starts parallel supervisor instances for all connected agents, each running independently. |
| `buildSupervisorPrompt(agentName, directory, reviewEnabled, hasReviewer, behavioralNotes)` | Generates the system prompt for a project supervisor including available commands, behavioral notes from previous cycles, and guidelines for stuck agent recovery. |
| `parseSupervisorCommands(response)` | Parses the LLM's response into structured supervisor commands (PROMPT, WAIT, MESSAGES, REVIEW, RESTART, ABORT, NOTE, NOTE_BEHAVIOR, DIRECTIVE, CYCLE_DONE, STOP). |
| `waitForAgent(orchestrator, agentName, timeoutMs?)` | Polls an agent's status until it is no longer busy (up to 5 minutes by default). |

### `brain.ts` -- High-Level Brain

| Function | Description |
|----------|-------------|
| `runBrain(orchestrator, config)` | Runs the orchestrator brain: a multi-round LLM loop that plans and executes commands across all agents toward a single objective. Saves progress to memory. |
| `chatCompletion(ollamaUrl, model, messages)` | Sends a chat completion request to Ollama's OpenAI-compatible API with dynamic `max_tokens` based on the model's context size. Includes a 5-minute request timeout. Validates the response shape. |
| `getModelContextSize(ollamaUrl, model)` | Queries Ollama's `/api/show` endpoint (10s timeout) to detect a model's context window size. Scans architecture-prefixed keys (e.g. `qwen2.context_length`, `llama.context_length`). Results are cached for 5 minutes. |
| `parseCommands(response)` | Parses the brain's response into structured commands (PROMPT, PROMPT_ALL, STATUS, MESSAGES, WAIT, NOTE, DONE). |
| `formatAgentInfo(orchestrator)` | Formats a summary of all available agents and their directories for inclusion in the brain's context. |
| `waitForAgents(orchestrator, timeoutMs?)` | Polls all agents until none are busy (up to 5 minutes by default). |

### `brain-memory.ts` -- Persistent Memory

| Function | Description |
|----------|-------------|
| `loadBrainMemory()` | Loads the memory store from `.orchestrator-memory.json`, returning a default empty store if the file doesn't exist. |
| `saveBrainMemory(store)` | Writes the memory store to disk, creating the directory if needed. |
| `addMemoryEntry(store, entry)` | Adds a session summary entry to the memory store with async write lock protection. Keeps the last 50 entries. |
| `addProjectNote(store, agentName, note)` | Adds a per-agent project note to the memory store with async write lock protection. Keeps the last 20 notes per agent. |
| `addBehavioralNote(store, agentName, note)` | Adds a per-agent behavioral note (injected into future supervisor system prompts). Deduplicates by keyword similarity before adding. Keeps the last 10 notes per agent. Uses write lock for concurrency safety. |
| `formatMemoryForPrompt(store)` | Formats the memory store into a human-readable string for inclusion in LLM prompts. |
| `withWriteLock(fn)` | Promise-chain mutex that serializes concurrent write operations to prevent read-modify-write races. |

### `project-manager.ts` -- Dynamic Project Provisioning

| Function | Description |
|----------|-------------|
| `ProjectManager.addProject(directory, directive, name?)` | Adds a project: finds a free port, spawns an opencode serve instance, registers the agent, and starts a supervisor. Uses a promise-chain mutex to prevent concurrent add races. |
| `ProjectManager.removeProject(projectId)` | Removes a project: stops its supervisor, kills the opencode process, releases the port, and removes the agent from the orchestrator. |
| `ProjectManager.restartSupervisor(projectId, directive?)` | Stops the current supervisor for a project and starts a new one after a brief delay. Optionally updates the directive. |
| `ProjectManager.updateDirective(projectId, directive, source?)` | Updates a project's directive, records it in directive history with source tracking, and persists to saved projects. |
| `ProjectManager.addDirectiveComment(projectId, comment, historyIndex?)` | Adds a user comment on a directive entry (latest or specific historical entry) for the supervisor to read. Pushes to a fast-access pending queue. |
| `ProjectManager.getUnreadComments(agentName)` | Returns and drains unread comments from the fast pending queue, marking history entries as read. |
| `ProjectManager.getDirectiveHistory(projectId)` | Returns the full directive history for a project. |
| `ProjectManager.updateModel(projectId, model)` | Updates a project's Ollama model for its supervisor and persists it to saved projects. |
| `ProjectManager.getOllamaUrl()` | Returns the Ollama URL from the brain config (used by the dashboard to proxy model list requests). |
| `ProjectManager.softStopAll()` | Requests a soft stop for all running supervisors (they finish their current cycle before stopping). |
| `ProjectManager.hardStopAll()` | Immediately aborts all supervisor loops. |
| `ProjectManager.listProjects()` | Returns an array of all project states. |
| `ProjectManager.getProject(id)` | Returns a single project state by ID. |
| `ProjectManager.loadSavedProjects()` | Loads previously saved project configurations (including per-project model) from `orchestrator-projects.json` for restore on startup. |
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
| `startDashboard(orchestrator, log, port, opts?)` | Starts the Bun HTTP server for the dashboard with pre-flight port availability check, per-session API token authentication on mutating endpoints, URL parameter sanitization, and restricted directory browsing. Serves the HTML SPA from `dashboard.html`, REST API endpoints, and long-poll event streaming. |

### `task-queue.ts` -- Task Queue

| Function | Description |
|----------|-------------|
| `loadTaskQueue()` | Loads the task queue from `orchestrator-tasks.json`. |
| `saveTaskQueue(queue)` | Writes the task queue to disk. |
| `addTask(queue, task)` | Adds a new task with a unique ID and "pending" status. |
| `updateTask(queue, id, updates)` | Updates a task's status and/or result, automatically setting timestamps. |
| `getNextPendingTask(queue)` | Returns the first task with "pending" status. |
| `formatQueueForPrompt(queue)` | Formats the task queue as a readable checklist string for LLM prompts. |

### `performance-log.ts` -- Performance Logging

| Function | Description |
|----------|-------------|
| `loadPerformanceLog()` | Loads the performance log from `orchestrator-performance.json`. Returns an empty log if file doesn't exist. |
| `savePerformanceLog(log)` | Writes the performance log to disk. Archives entries older than 7 days to daily files in `orchestrator-performance-archive/`. Keeps the last 500 active entries. |
| `logPerformance(entry)` | Appends a performance entry (cycle_complete, cycle_error, restart, stuck, supervisor_stop, supervisor_start) to the log. Uses a write lock for concurrent supervisor safety. |
| `getModelStats(log)` | Aggregates performance data by model: total cycles, errors, restarts, stuck events, stops, average cycle duration, projects used, and first/last usage timestamps. |

### `message-utils.ts` -- Message Utilities

| Function | Description |
|----------|-------------|
| `trimConversation(messages, maxMessages?)` | Trims an LLM conversation to stay within context limits (default: 60 messages), preserving the system prompt and inserting a summary marker. Shared by brain.ts and supervisor.ts. |
| `extractLastAssistantText(messages)` | Extracts the text content from the most recent assistant message in an opencode message array. |
| `formatRecentMessages(messages, count?, maxLen?)` | Formats the N most recent messages into readable `[role] content` lines with truncation (default: 6 messages, 3000 chars max). |

### `file-utils.ts` -- File I/O Utilities

| Function | Description |
|----------|-------------|
| `atomicWrite(filePath, content)` | Writes a file atomically by writing to a temp path then renaming. Prevents corruption on crash. |
| `readFileOrNull(filePath)` | Reads a file as text using `Bun.file()`, returning `null` if it doesn't exist or is unreadable. |
| `readJsonFile(filePath, fallback)` | Reads and parses a JSON file, returning the fallback if it doesn't exist or is invalid. |
| `writeJsonFile(filePath, data)` | Writes a JSON file atomically with pretty-printing. |

### `cli.ts` -- CLI Entry Point

| Function | Description |
|----------|-------------|
| `main()` | Entry point: loads config, creates the orchestrator with stuck detection callback, project manager, and dashboard, then starts the interactive REPL. |
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
- `BrainMemoryStore`, `BrainMemoryEntry`, `loadBrainMemory`, `saveBrainMemory`, `formatMemoryForPrompt`, `addBehavioralNote`
- `DashboardLog`, `DashboardEvent`, `startDashboard`
- `ProjectManager`, `ProjectState`, `listDirectories`
- `Task`, `TaskQueue`, `loadTaskQueue`, `saveTaskQueue`, `addTask`, `updateTask`, `getNextPendingTask`, `formatQueueForPrompt`
- `AgentSupervisorConfig`, `ParallelSupervisorsConfig`, `ProjectRole`, `SupervisorLimits`, `runAgentSupervisor`, `runParallelSupervisors`
- `extractLastAssistantText`, `formatRecentMessages`, `trimConversation`
- `atomicWrite`, `readFileOrNull`, `readJsonFile`, `writeJsonFile`
- `PerformanceEntry`, `PerformanceLog`, `loadPerformanceLog`, `logPerformance`, `getModelStats`

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
| `GET` | `/api/projects` | List active projects (includes directive and model) |
| `POST` | `/api/projects` | Add a project (body: `{ directory, directive?, name? }`) |
| `DELETE` | `/api/projects/<id>` | Remove a project |
| `PUT` | `/api/projects/<id>/directive` | Update a project's directive and restart its supervisor (body: `{ directive }`) |
| `PUT` | `/api/projects/<id>/model` | Update a project's Ollama model and restart its supervisor (body: `{ model }`) |
| `POST` | `/api/agents/<name>/restart` | Restart an agent's session (abort + new session) |
| `POST` | `/api/agents/<name>/abort` | Abort an agent's current work |
| `GET` | `/api/ollama-models` | List available Ollama models (proxied from Ollama's `/api/tags`, includes parameter size, family, and quantization) |
| `GET` | `/api/performance` | Get performance log entries for model comparison |
| `GET` | `/api/browse?path=<dir>` | Browse directories for the folder picker |
| `GET` | `/api/projects/<id>/directive-history` | Get directive history timeline for a project |
| `POST` | `/api/projects/<id>/directive-comment` | Add a user comment on a directive entry (body: `{ comment, historyIndex? }`) |
| `GET` | `/api/saved-projects` | Load previously saved project configs (includes directory existence check) |
| `POST` | `/api/soft-stop` | Request soft stop for all supervisors |

---

## Testing

```bash
# Run all tests
bun test

# Type check
bun run typecheck
```

The test suite covers:
- **`core.test.ts`** -- `trimConversation` (trimming, system prompt preservation, edge cases), `extractLastAssistantText` (role filtering, multi-part joining), `formatRecentMessages` (truncation, tool-use display)
- **`brain-commands.test.ts`** -- Brain command parser (PROMPT, PROMPT_ALL, STATUS, MESSAGES, WAIT, NOTE, DONE) and supervisor command parser (PROMPT, WAIT, MESSAGES, REVIEW, RESTART, ABORT, NOTE, NOTE_BEHAVIOR, DIRECTIVE, CYCLE_DONE, STOP) with code block extraction
- **`brain-memory.test.ts`** -- `isSimilarNote` behavioral note deduplication (duplicate detection, case insensitivity, punctuation handling, short word filtering)

---

## License

MIT
