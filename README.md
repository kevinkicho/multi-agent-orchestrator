# Multi-Agent Orchestrator

Orchestrate multiple AI coding agents with LLM-driven task planning, real-time supervision, and a live web dashboard.

Multi-Agent Orchestrator spawns and manages multiple [opencode](https://github.com/sst/opencode) instances as headless coding agents, each working on a separate project directory. A local LLM (via [Ollama](https://ollama.ai/) or cloud providers) acts as a "brain" that plans tasks, reviews agent output, and coordinates work across all agents autonomously.

> **Unofficial orchestration layer for opencode.** Opencode is distributed as the [`opencode-ai`](https://www.npmjs.com/package/opencode-ai) npm package and is a regular dependency of this repo — `bun install` installs the opencode binary into `node_modules/.bin/`. No separate clone or global install is required.

## Quick Start

```bash
git clone https://github.com/kevinkicho/multi-agent-orchestrator.git
cd multi-agent-orchestrator
bun install
bun run dev
```

Advanced: if you're hacking on opencode itself and want to run against a local source checkout, set `OPENCODE_DIR` to the checkout path and the orchestrator will launch from source instead of the bundled binary.

### Fresh-clone provider setup

The orchestrator owns its own provider registry (`orchestrator-providers.json`) and automatically synthesizes a per-worker `opencode.json` into `.orchestrator-workspaces/<projectId>/` so opencode serve routes to exactly the providers you've enabled in the dashboard. **You do NOT need to edit `~/.config/opencode/opencode.json` or run `opencode auth login` for orchestrator workers.**

On first run:

1. `bun install` — installs opencode-ai and deps.
2. Put any provider API keys in `.env` (see `.env.example`). For the default setup: `OPENCODE_GO_API_KEY=<your-key>`.
3. `bun run start` — the **Boot Status** panel in the dashboard will show each provider's health (reachable / quota / auth) within a few seconds of startup.
4. Open the dashboard, enable at least one provider under **LLM Providers**, add its models, then add a project.

If the Boot Status panel shows a provider as `QUOTA`, `AUTH`, or `DOWN`, fix it before starting a worker — the worker will silently fall back to whatever opencode's default is otherwise (historically this caused "Round N → no commands" loops where the supervisor kept prompting a worker that was misrouted to an exhausted provider).

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
- [API Endpoints](#api-endpoints)
- [Pause Service](#pause-service)
- [Prompt Ledger](#prompt-ledger)
- [Testing](#testing)
- [License](#license)

---

## Architecture

```
                          +------------------+
                          |   Ollama / Cloud |
                          |   LLM Providers  |
                          +--------+---------+
                                   |
                          +--------v---------+
                          |     Brain /      |
                          |   Team Manager   |
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
             |  serve :rand| | serve :rand| | serve :rand|
             +------+------+ +-----+------+ +-----+------+
                    |              |               |
             +------v------+ +----v-------+ +-----v------+
             |  Project A  | | Project B  | | Project C  |
             |  directory  | | directory  | | directory  |
             +-------------+ +------------+ +------------+

     +----------------------------------------------------+
     |   Event Bus (in-memory pub/sub coordination)       |
     +----------------------------------------------------+
     |   Resource Manager (file locks, LLM semaphore)     |
     +----------------------------------------------------+

     +----------------------------------------------------+
     |      Web Dashboard (http://127.0.0.1:15828)        |
     |   Real-time logs, permissions, controls per        |
     |   project with sidebar navigation, toast           |
     |   notifications, team hierarchy, event bus         |
     |   viewer, resource locks, and analytics            |
     +----------------------------------------------------+
```

Each project gets:
- A dedicated **opencode serve** instance (worker agent) on a randomly assigned port (10000–60000)
- A dedicated **LLM supervisor** that reviews the worker's output, assigns tasks, and provides feedback
- An optional **git branch** for isolated work (`agent/<name>`)
- A **row in the dashboard** with separate worker and supervisor log panels

---

## Features

### Core Orchestration

- **Dynamic project management** -- Add and remove projects at runtime via the dashboard or CLI
- **LLM-powered supervision** -- Each project gets an autonomous supervisor that reviews code, catches bugs, assigns tasks, and tracks progress across cycles
- **Multi-LLM provider support** -- Ollama, OpenAI, Anthropic, Google, Groq, Mistral, OpenRouter, and custom providers. Configure API keys, enable/disable providers, and select models per project
- **Team mode** -- A team manager coordinates multiple agents toward a shared goal, with automatic hiring/dissolution of team members, role assignment, and directive management
- **Brain mode** -- A higher-level orchestrator brain that coordinates across all agents with a single objective

### Socratic Supervision

- **Dialogue-based supervision** -- Supervisors engage in Socratic dialogue with workers rather than issuing rigid commands. The LLM thinks freely in natural language, using lightweight `@` markers (`@worker:`, `@check`, `@done:`, `@note:`, `@lesson:`, etc.) to take actions when ready
- **Free thinking preserved** -- All reasoning between `@` markers stays in the conversation context, building understanding across rounds instead of being discarded
- **Worker engagement prompts** -- Worker responses are presented as dialogue turns with reflection prompts ("What did the worker do well? What might they have missed?"), encouraging critical engagement over task-checking
- **Legacy fallback** -- If no `@` markers are found, the parser falls back to the legacy UPPERCASE command format for backwards compatibility

### Recovery and Resilience

- **Stale-busy detection** -- Monitors SSE heartbeat events from workers. If an agent claims "busy" but no SSE events arrive for 45 seconds, it's flagged as stale and automatically restarted
- **Pause hard-break** -- If a pause is requested but the LLM doesn't issue `@done:` within 2 rounds, the cycle is force-ended (prevents runaway loops)
- **Post-cycle validation** -- Run tests, lints, or type checks after each cycle. Built-in presets (`test`, `lint`, `typecheck`) or custom commands. Failed validation can warn, inject feedback, or pause the supervisor
- **False progress detection** -- Compares LLM summaries against actual `git diff` to catch hallucinated progress
- **Command recovery** -- Nudge system with escalating hints when the LLM fails to produce valid `@` markers. Circuit breaker trips after repeated failures. Fuzzy command extraction recovers partial matches
- **Empty response escalation** -- 3-tier escalation for consecutive empty agent responses: warn, abort, restart + behavioral note
- **Conversation checkpoints** -- Save/restore supervisor message arrays so restarts resume from where they left off
- **Auto-question answering** -- When workers ask interactive questions (e.g., "should I delete these files or focus on the build?"), the orchestrator auto-selects the first option so agents never block waiting for human input

### Coordination

- **Event bus** -- System-wide in-memory pub/sub with ring buffer (200 events), pattern-matched subscriptions, and SSE streaming to the dashboard
- **Resource manager** -- Advisory file locks prevent agents from stepping on each other's files. LLM concurrency semaphore throttles parallel Ollama requests. Work intent declarations enable conflict detection before work begins
- **Git branch isolation** -- Each project works on an `agent/<name>` branch cut from a configurable base (defaults to current HEAD; missing branches are materialized from `origin` when possible). Canonical `<name>` is derived from the `origin` remote slug when available so two clones of the same repo share one agent identity. Merge back via dashboard or CLI when work is complete
- **Self-ingest guard** -- `addProject` refuses the exact directory currently running the orchestrator, preventing the supervisor from cutting `agent/` branches inside its own working tree. Sibling clones of the same repo at a different path are allowed (their supervisor operates on the clone, not the running tree)
- **Unmerged-work warning** -- When a project is removed, commits on its agent branch that haven't landed on the base branch trigger an `unmerged-agent-branch` event and dashboard warning; the branch is preserved (non-force delete) so nothing is silently lost
- **Rate-limit coordination** -- Shared 429 cooldown with escalating backoff across all agents
- **Token tracking** -- Per-agent token usage accounting with budget limits

### Learning and Memory

- **Behavioral learning** -- Supervisors save `@lesson:` notes about how agents work best. These are injected into future system prompts so the same mistakes aren't repeated. Deduplicated by keyword similarity
- **Persistent memory** -- Brain and supervisors remember context across sessions via a JSON-based memory store
- **Directive history** -- Track how project directives evolve over time (user vs supervisor changes), add comments, revert to previous versions
- **Summary validation** -- Rejects vague `CYCLE_DONE` and `STOP` summaries, forcing actionable descriptions
- **Priority-aware trimming** -- Messages tagged `[VALIDATION]`, `[DIRECTIVE]`, `[URGENT]`, `[WARNING]` are preserved longer during conversation trimming

### Dashboard and Observability

- **Live web dashboard** -- Real-time streaming logs, permission approval, command palette, sidebar navigation, global search, toast notifications, team hierarchy visualization
- **Analytics and session tracking** -- Cycle summaries, git snapshots, AI-powered evaluation, cross-session comparison, timeline visualization
- **Prompt ledger** -- Persistent, queryable log of every prompt at every level with filters and pagination
- **Performance logging** -- Per-model cycle stats with automatic archival of entries older than 7 days
- **Project save/restore** -- Auto-save projects with directives, models, and history. On startup, a restore modal offers to re-add all previously active projects or start fresh
- **Random port allocation** -- Worker agents are assigned random ports (10000–60000) to avoid conflicts with other local services
- **Ghost project cleanup** -- Failed or errored projects are automatically cleaned from the project map, so re-adding always works

### Reliability

- **Crash resilience** -- Promise-chain mutexes, async write locks, retry logic, partial-failure tolerance, and auto-restart on supervisor failure
- **Graceful shutdown** -- Signal handlers (SIGINT, SIGTERM, SIGHUP) ensure all ports are released, child processes killed, and supervisors stopped
- **Atomic file writes** -- All JSON persistence uses write-to-temp-then-rename to prevent corruption
- **Session resume** -- Detects existing memory on restart and injects resumption context

### Security

- **API token authentication** -- Per-session UUID token protects all mutating dashboard API endpoints
- **URL parameter sanitization** -- Path-extracted parameters are decoded and stripped of path traversal sequences
- **Restricted directory browsing** -- `/api/browse` blocks access to sensitive system paths
- **CORS restrictions** -- Only `127.0.0.1` and `localhost` origins are accepted
- **Worker token scoping** -- Workers run with `workerGithubAccess: "none"` by default, which strips `GITHUB_TOKEN` from the worker environment. Supervisor-initiated git operations (clone/push/merge) use the token via an injected HTTP extraheader — the token never lands in the worker shell or on disk. Set `workerGithubAccess: "full"` only if you need the worker itself to perform authenticated git.
- **Pre-commit secret scanner** -- `scripts/check-secrets.ts` blocks commits containing GitHub PATs, API keys, and bearer tokens. Activate in a fresh clone with `git config core.hooksPath .githooks` (the tracked hook at `.githooks/pre-commit` then runs on every commit).
- **Credential-helper isolation** -- On Windows, Git Credential Manager can shadow the injected auth header and hang the clone path on a hidden prompt. The orchestrator suppresses this via `-c credential.helper=` and `GIT_TERMINAL_PROMPT=0`, so cloning works identically regardless of the host's git credential config.

---

## Prerequisites

- **[Bun](https://bun.sh/)** -- JavaScript runtime (v1.0+)
- **[Ollama](https://ollama.ai/)** -- Local LLM inference server. Other cloud providers (OpenAI, Anthropic, etc.) can also be configured.
- **An Ollama model** -- Default is `glm-5.1:cloud`. Pull it with `ollama pull glm-5.1:cloud` or configure a different model.

Opencode itself is installed automatically as an npm dependency (`opencode-ai`) during `bun install` — no separate install step is needed.

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
  "dashboardPort": 15828,
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
| `dashboardPort` | `number` | `15828` | Port for the web dashboard |
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
| `OPENCODE_DIR` | Optional. Path to an opencode **source checkout** for running from TypeScript source (fork development). When unset, the orchestrator uses the `opencode-ai` npm package binary from `node_modules/.bin`. |
| `OPENCODE_PROJECT_DIR` | Set automatically per agent process to scope each opencode instance to its project directory. |
| `OPENCODE_GO_API_KEY` | API key for the OpenCode Go provider. Injected into the per-worker opencode config via `{env:OPENCODE_GO_API_KEY}` so it never gets written to disk. |
| `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`, `GROQ_API_KEY`, `TOGETHER_API_KEY`, `DEEPSEEK_API_KEY`, `FIREWORKS_API_KEY` | Keys for the corresponding providers. Each provider has an `apiKeyEnv` field in `orchestrator-providers.json` that points to the env var it reads from. |

### How worker provider routing works (and why it won't silently fall back to Ollama)

Every project's worker runs as its own `opencode serve` subprocess. Opencode normally reads its provider list from `~/.config/opencode/opencode.json`, which on a fresh opencode install only knows about Ollama. Without this orchestrator's glue, any worker pinned to OpenCode Go / OpenAI / Anthropic would silently fall back to Ollama's default model.

To close that gap, every time a worker spawns the orchestrator:

1. Reads enabled providers from `orchestrator-providers.json`.
2. Serializes them into an `opencode.json` written to `.orchestrator-workspaces/<projectId>/` (gitignored, cleaned up when the project is removed).
3. Spawns `opencode serve` with `cwd` set to that scratch directory, so opencode picks up the generated config.
4. Still sets `OPENCODE_PROJECT_DIR` to the actual project directory, so filesystem tools target the right worktree.

API keys are injected as `{env:VAR}` templates — the generated `opencode.json` contains no plaintext secrets. If you see a worker stuck in "Round N → no commands", check the **Boot Status** panel first; the most common cause is a provider showing `QUOTA` or `AUTH` that the worker is pinned to.

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

Reads `orchestrator.json`, spawns all configured `opencode serve` instances, then starts the orchestrator CLI.

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

The dashboard is served at `http://127.0.0.1:15828` (configurable) and provides:

- **Sidebar navigation** -- Fixed sidebar with section links (Projects, Brain, Performance, Analytics, Prompt Log, Providers, Event Bus, Resources, Intents, Team, Live Events). Collapses to icon-only on narrow screens.
- **Dynamic project rows** -- Each project appears as a collapsible row with side-by-side worker and supervisor panels
- **Real-time streaming** -- SSE auto-connect on page load, plus 30-second auto-refresh for open panels
- **Global search** -- Filters across all panels, project rows, log entries, live events, and bus events
- **Toast notifications** -- Stacked notifications for agent completions, errors, and actions (success/error/warning/info types)
- **Command palette** -- Ctrl+K or `?` button to open. 35+ commands organized into 7 sections (Prompting, Supervision, Projects, Pause & Resume, Git & Validation, Tasks, Team Mode, Infrastructure) with examples for each command
- **Permission approvals** -- Visual permission request cards with approve/deny/approve-all buttons
- **Project management** -- Add projects via folder browser, remove projects, restart supervisors
- **Tabbed project drawers** -- Each project has a collapsible drawer with three tabs: Settings (model selector, directive, comments), History (directive timeline with revert), and Memory (agent behavioral notes, project notes, session summaries)
- **Per-project model selection** -- Choose from models across all enabled providers
- **Agent memory viewer** -- Memory tab shows behavioral notes (amber), project notes (green), and session summaries (purple) with learnings — lets you see what the AI has learned about your project
- **Branch isolation badges** -- Shows the agent's working branch with merge button
- **Post-cycle validation** -- Configure validation commands or presets per project
- **Blinking status badges** -- Status indicators blink when agents are active
- **Model performance comparison** -- Collapsible section with per-model cycle stats
- **Project save/restore** -- Auto-save on changes; restore modal on startup when saved projects exist but none are active
- **Port display** -- Each project header shows its assigned port number
- **Project status badges** -- Real-time STARTING, RUNNING, SUPERVISING, FINISHED, ERROR badges
- **Team hierarchy visualization** -- Manager node connected to member cards with status dots, roles, and directives
- **Event Bus panel** -- Live event log with type/source filters
- **Resources panel** -- File locks table, LLM queue depth, contention warnings
- **Work Intents panel** -- Declared agent work intents with file overlap detection
- **Prompt Log section** -- Filterable, paginated table of all prompts with color-coded source labels
- **Analytics section** -- Session cards, cycle details, score bars, evaluation, comparison, timeline chart
- **Export logs** -- Download all logs as a text file organized by project
- **Pause/Resume controls** -- Per-project and global pause with PAUSING/PAUSED badges
- **Dark/light theme** -- Toggle with persistence via localStorage
- **Responsive layout** -- Adapts at 900px and 600px breakpoints
- **ARIA accessibility** -- Screen reader support with roles, labels, keyboard navigation, and aria-expanded sync via MutationObserver
- **Drag-to-annotate feedback** -- Select text in any log panel to submit behavioral or project feedback
- **Smart auto-scroll** -- Chat logs stick to bottom when you're there, but don't force-scroll when you've scrolled up to read history. Properly catches up when opening a collapsed panel

---

## CLI Commands

When the orchestrator is running, the interactive REPL accepts:

### Project Management

| Command | Description |
|---------|-------------|
| `projects` | List active projects |
| `project add <dir> [name]` | Add a new project (spawns agent + supervisor) |
| `project remove <id>` | Remove a project and kill its agent |
| `status` | Show agent connection status |
| `messages <agent-name>` | Show recent messages from an agent |
| `<agent-name> <prompt>` | Send a prompt to a specific agent |
| `all <prompt>` | Send a prompt to all agents |

### Supervision

| Command | Description |
|---------|-------------|
| `brain <objective>` | Start the LLM brain with a one-shot objective |
| `brain-loop [directive]` | Start parallel per-agent supervisors |
| `brain-queue` | Process the task queue with the brain |
| `stop` | Soft stop all running supervisors |
| `pause <project>` | Request a project to pause at a clean checkpoint |
| `resume <project>` | Resume a paused project |
| `pause-all` | Pause all supervising projects |
| `resume-all` | Resume all paused projects |

### Git and Validation

| Command | Description |
|---------|-------------|
| `branch <project>` | Show the agent's isolated git branch |
| `merge <project> [target]` | Merge the agent's branch into target (default: main) |
| `validate <project> <command\|preset>` | Set post-cycle validation (presets: `test`, `lint`, `typecheck`) |

### Team Mode

| Command | Description |
|---------|-------------|
| `team-loop [goal]` | Start team mode with manager and members |
| `team` | Show team members and status |
| `team hire-requests` | List pending hire requests from the manager |
| `team approve-hire <index> <agent-name>` | Approve a hire request |
| `team dissolve-requests` | List pending dissolution requests |
| `team approve-dissolve <agent-name>` | Approve a dissolution |

### Providers and Resources

| Command | Description |
|---------|-------------|
| `providers` | List configured LLM providers |
| `provider enable <id>` / `provider disable <id>` | Toggle a provider |
| `provider key <id> <api-key>` | Set a provider's API key |
| `models` | List all available models across providers |
| `locks` | Show active file locks |
| `intents` | Show declared work intents |
| `events [limit]` | Show recent event bus events |

### Tasks and System

| Command | Description |
|---------|-------------|
| `tasks` | Show the task queue |
| `task add <title>` | Add a task to the queue |
| `quit` / `exit` | Shut down everything |

---

## How It Works

### Project Lifecycle

1. **Add a project** -- via dashboard or `project add <directory>`. The ProjectManager:
   - Refuses the exact directory currently running the orchestrator (other clones of the same repo at different paths are accepted)
   - Derives a canonical agent name from the `origin` remote slug when available, so two clones of the same repo share one agent identity (falls back to folder basename)
   - Finds a free random port (10000–60000) to avoid conflicts with other local services
   - Spawns an `opencode serve` instance pointed at the project directory
   - Waits for the health check to pass
   - Registers the agent with the orchestrator
   - Creates an isolated `agent/<name>` git branch cut from a configurable `baseBranch` (defaults to current HEAD; missing branches materialized from `origin` when possible)
   - Starts an autonomous supervisor loop for that project

2. **Supervision cycle** -- Each project's supervisor runs in a Socratic dialogue loop:
   - Reads the worker's recent messages and loads persistent memory
   - Injects behavioral lessons from previous cycles into the system prompt
   - On first cycle with existing memory, adds resumption context
   - Checks for urgent events from the event bus and mid-cycle user feedback
   - Asks the LLM to **think freely** about the situation and decide next steps
   - The LLM reasons in natural language, then uses `@` markers to take actions: `@worker:` (talk to worker), `@check` (read messages), `@review`, `@note:`, `@lesson:`, `@directive:`, `@broadcast:`, `@intent:`, `@restart`, `@abort`, `@done:` (end cycle), `@stop:`
   - After each `@worker:` message, waits for the worker, then presents the response as dialogue with reflection prompts
   - Runs post-cycle validation (if configured) after `@done:`
   - Checks for false progress (summary claims work but git shows no changes)
   - Updates file locks and checks for contention with other agents
   - Emits events to the event bus at each stage
   - Records all prompts to the prompt ledger
   - If a pause is requested, injects a wrap-up directive; force-breaks after 2 rounds if LLM doesn't comply
   - Dynamically adjusts cycle pause based on responsiveness

3. **Stale-busy detection** -- Every SSE event from a worker (including streaming deltas) updates a `lastEventAt` timestamp. If an agent claims "busy" but no SSE events have arrived for 45 seconds, it's flagged as stale and automatically restarted — much more accurate than the old timeout-based approach.

4. **Failure recovery** -- If a supervisor stops due to failure, the project manager auto-restarts after 10 seconds. The command recovery system nudges the LLM with escalating hints when it fails to produce valid commands.

5. **Remove a project** -- Stops the supervisor, kills the opencode process, releases the port, and attempts a non-force delete of the agent branch. If the branch has commits not on its `baseBranch`, it's preserved and an `unmerged-agent-branch` event is emitted (dashboard shows a warning) so work is never silently lost.

### Team Mode

The team manager is a higher-level orchestrator that coordinates multiple agents toward a shared goal:
- An LLM-powered manager assigns directives, reviews progress, and coordinates work
- Can request hiring new team members or dissolving underperforming ones (requires user approval)
- Subscribes to cycle-done events via the event bus for early check-in
- Passes urgent event patterns to member supervisors so agents hear each other's `NOTIFY` broadcasts

### Memory System

The orchestrator persists state in `.orchestrator-memory.json`:
- **Session entries** -- Summaries of past brain/supervisor sessions (last 50)
- **Project notes** -- Per-agent notes accumulated by supervisors (last 20 per agent)
- **Behavioral notes** -- Per-agent lessons about how agents work best (last 10 per agent), injected into future supervisor system prompts. Deduplicated by keyword similarity.

All memory is viewable per-agent in the dashboard's **Memory tab** (in each project's drawer) and via the `GET /api/memory/<agent>` endpoint.

### Event Bus

In-memory event bus with a 200-event ring buffer. Supports pattern-matched subscriptions (by type, source, agent name) and SSE streaming to the dashboard. Events are emitted at each supervisor stage (cycle-start, agent-prompt, agent-response, validation-result, false-progress-warning, cycle-done, supervisor-stop, pause-entered, pause-exited) and by the team manager.

### Resource Manager

Advisory file locks and LLM concurrency semaphore:
- **File locks** -- Agents register which files they're working on. Other agents are warned about contention.
- **Work intents** -- Agents declare what they plan to work on before starting. Conflicts are detected early.
- **LLM semaphore** -- Limits concurrent Ollama requests (default: 2) to prevent overloading.
- **Rate-limit coordination** -- Shared 429 cooldown with escalating backoff (30s, 60s, 120s, 240s, 300s cap).

### Prompt Ledger

Separate from memory, the prompt ledger (`.orchestrator-ledger.json`) records every prompt sent or received at every level of the hierarchy. Unlike memory (which is curated summaries for LLM context), the ledger is a raw audit trail. Capped at 2000 entries.

### Analytics Store

The analytics store (`orchestrator-analytics.json`) tracks:
- **Sessions** -- Each supervisor run with cycle summaries and command counts
- **Snapshots** -- Point-in-time git state captures (branch, commit hash, diff stats)
- **Comparisons** -- AI-generated side-by-side session comparisons

### Performance Logging

Performance events logged to `orchestrator-performance.json`: `supervisor_start`, `cycle_complete`, `cycle_error`, `restart`, `stuck`, `supervisor_stop`. Aggregated by model in the dashboard. Entries older than 7 days automatically archived to `orchestrator-performance-archive/`.

---

## File Reference

### Source Files (`src/`)

| File | Lines | Description |
|------|-------|-------------|
| `cli.ts` | 1057 | Entry point: config loading, CLI argument parsing, interactive REPL, command handler, stuck detection callback. |
| `launcher.ts` | 173 | Alternative entry point that spawns pre-configured opencode serve instances before starting the CLI. |
| `orchestrator.ts` | ~470 | Core orchestration: agent connections, prompt queuing, SSE subscriptions with heartbeat tracking (`lastEventAt`), health monitoring, stale-busy detection, auto-question answering, auto-permission approval, abort/restart. |
| `agent.ts` | 142 | Agent abstraction: wraps the opencode SDK client with session management, prompting, and health checks. |
| `events.ts` | 106 | SSE client: connects to each agent's event stream with auto-reconnect. |
| `supervisor.ts` | ~1800 | Socratic supervisor loop: free-thinking LLM dialogue with `@` marker parsing, per-agent cycles, stale-busy detection, pause hard-break, validation, false progress detection, resource contention, event bus emissions, command recovery. Legacy UPPERCASE command fallback. |
| `brain.ts` | 594 | Higher-level brain: coordinates multiple agents toward a single objective. Dynamic model context size detection. |
| `brain-memory.ts` | 215 | Persistent memory store: session summaries, project notes, behavioral notes with async write locks. |
| `project-manager.ts` | 894 | Dynamic project provisioning: random port allocation (10000–60000), ghost project cleanup, branch isolation, directive history, pause/resume, save/restore. |
| `team-manager.ts` | 814 | Team mode: LLM-powered manager coordinating multiple agents with hiring/dissolution, role assignment, and event bus integration. |
| `dashboard.ts` | 1144 | Web dashboard HTTP server: REST API endpoints, memory API, project restore, long-poll event streaming, SSE, static asset serving, API token authentication. |
| `dashboard.html` | 418 | Dashboard HTML shell: command palette with 35+ commands, markup structure referencing external CSS and JS. |
| `dashboard-client.css` | 1371 | Dashboard styles: dark/light themes, responsive breakpoints, sidebar, toast notifications, team hierarchy, tabbed drawers, memory viewer. |
| `dashboard-client.js` | 2750 | Dashboard client logic: event handling, agent management, status updates, search, toasts, sidebar, ARIA sync, smart auto-scroll, tabbed drawers, memory viewer, restore modal. |
| `providers.ts` | 514 | Multi-LLM provider management: Ollama, OpenAI, Anthropic, Google, Groq, Mistral, OpenRouter, custom. Model listing, API key resolution, provider templates. |
| `event-bus.ts` | 137 | In-memory event bus: ring buffer, pattern-matched subscriptions, SSE streaming support. |
| `resource-manager.ts` | 240 | Advisory file locks, work intent ledger, LLM concurrency semaphore, rate-limit coordination. |
| `git-utils.ts` | 129 | Git operations: exec, diff, branch, checkout, merge, delete, latest commit, clean check. |
| `command-recovery.ts` | ~210 | Command recovery: nudge state machine (Socratic `@` marker guidance), circuit breaker, fuzzy command extraction, command constants for both Socratic and legacy formats. |
| `token-tracker.ts` | 155 | Token usage tracking per agent with budget limits. |
| `conversation-checkpoint.ts` | 78 | Save/restore supervisor conversation state for warm restarts. |
| `analytics.ts` | ~620 | Analytics engine: session tracking, git snapshots, AI evaluation, cross-session comparison. |
| `chat-log.ts` | ~140 | Per-agent append-only chat history persistence with JSONL rotation at 25 MB. |
| `responsibilities.ts` | ~160 | Per-agent responsibility catalog (planning, git, validation, review, testing) backing the dashboard's responsibility-checklist UI. |
| `session-state.ts` | 186 | Crash recovery: session state tracking, supervisor checkpointing, crash detection. |
| `performance-log.ts` | 169 | Performance logging with write lock and automatic archival. |
| `prompt-ledger.ts` | 145 | Persistent prompt log: write-locked append, query/filter/paginate, stats. |
| `task-queue.ts` | 81 | File-backed task queue for structured work assignment. |
| `message-utils.ts` | 163 | Message extraction, formatting, and priority-aware trimming for LLM context management. |
| `file-utils.ts` | 54 | Atomic writes, JSON read/write via `Bun.file()`/`Bun.write()`. |
| `pause-service.ts` | 72 | Runtime pause state management: request, resume, await, status. |
| `tui-format.ts` | 81 | Terminal formatting: ANSI color constants, thought/status formatting for CLI output. |
| `index.ts` | 25 | Public API barrel file: re-exports all types and functions for library use. |

### Test Files (`src/tests/`)

| File | Lines | Description |
|------|-------|-------------|
| `core.test.ts` | 146 | `trimConversation`, `extractLastAssistantText`, `formatRecentMessages` |
| `brain-commands.test.ts` | 235 | Brain and supervisor command parsers |
| `brain-memory.test.ts` | 52 | `isSimilarNote` behavioral note deduplication |
| `command-recovery.test.ts` | 234 | Nudge system, circuit breaker, fuzzy command extraction |
| `dashboard-api.test.ts` | 397 | Dashboard HTTP endpoints: routing, auth, CORS, JSON serialization |
| `dashboard-ui.test.ts` | 909 | Dashboard JS rendering: badges, status dots, toasts, filtering, ARIA, sidebar |
| `event-bus.test.ts` | 233 | EventBus: emit, subscribe, pattern matching, ring buffer, SSE |
| `file-utils.test.ts` | 107 | Atomic writes, JSON read/write, error handling |
| `integration-supervisor.test.ts` | 493 | End-to-end supervisor cycle integration |
| `message-utils-priority.test.ts` | 158 | Priority-aware message trimming |
| `pause-service.test.ts` | 104 | Pause state transitions, await/resume, abort signal |
| `providers.test.ts` | 137 | Provider management, model listing, API key resolution |
| `resource-manager.test.ts` | 238 | File locks, contention, LLM semaphore, work intents, rate limits |
| `session-state.test.ts` | 101 | Session state, crash detection, checkpointing |
| `supervisor-commands.test.ts` | 188 | Supervisor command parsing and validation |

### Config and Data Files

| File | Description |
|------|-------------|
| `orchestrator.json` | Main configuration (brain model, dashboard port, supervisor limits). |
| `orchestrator-projects.json` | Auto-saved project list for restore on restart. |
| `.orchestrator-memory.json` | Persistent memory (session summaries, project notes, behavioral notes). |
| `orchestrator-tasks.json` | Task queue state. |
| `orchestrator-analytics.json` | Analytics: sessions, snapshots, comparisons. |
| `.orchestrator-chat-log/` | Per-agent JSONL chat history (rotated at 25 MB). |
| `.orchestrator-ledger.json` | Prompt ledger (capped at 2000 entries). |
| `.orchestrator-session.json` | Session state for crash recovery. |
| `orchestrator-performance.json` | Active performance log (last 500 entries). |
| `orchestrator-performance-archive/` | Date-based performance archives. |
| `orchestrator-providers.json` | LLM provider configurations and API keys. |
| `.orchestrator/checkpoints/` | Conversation checkpoint files per agent. |

### Scripts and Hooks

| Path | Description |
|------|-------------|
| `scripts/smoke-e2e.ts` | End-to-end smoke exercising clone → commit → push → merge → delete-remote against a local bare repo. Runs via `bun run smoke`. |
| `scripts/check-secrets.ts` | Pattern-based secret scanner (GitHub PATs, Anthropic/OpenAI/Google/AWS keys, long bearer tokens). Runs on staged files via `bun run check-secrets -- --staged` or full-tree for audit. |
| `.githooks/pre-commit` | Tracked pre-commit hook that invokes the secret scanner. Activate with `git config core.hooksPath .githooks`. |

### Environment File

`.env` (git-ignored) is the only place the orchestrator looks for sensitive values:

| Variable | Purpose |
|----------|---------|
| `GITHUB_TOKEN` | Classic or fine-grained PAT for clone/push/merge against GitHub remotes. Used only by the supervisor via an injected extraheader; workers never see it unless `workerGithubAccess: "full"` is set. |
| `OPENCODE_GO_API_KEY` | API key for the opencode-go OpenAI-compatible chat/completions endpoint (an optional LLM provider). |

See `.env.example` for the full list of supported variables. None of them need to be set in order to run the dashboard and local Ollama supervision.

---

## API Endpoints

The dashboard server exposes these REST endpoints. `GET` requests are unauthenticated; `POST`/`PUT`/`DELETE` require the `X-API-Token` header.

### Dashboard Assets

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/` | Dashboard HTML page |
| `GET` | `/dashboard-client.css` | Dashboard stylesheet |
| `GET` | `/dashboard-client.js` | Dashboard client JavaScript |

### Events

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/events?since=<cursor>` | Long-poll for new events (returns batch + cursor) |
| `GET` | `/api/events/stream` | SSE stream of real-time events |
| `GET` | `/api/events/bus/recent?type=&limit=` | Recent event bus events with optional type filter |

### Agents

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/status` | Agent status map |
| `GET` | `/api/messages/<agent>` | Messages from an agent's session |
| `GET` | `/api/permissions` | Pending permission requests |
| `POST` | `/api/permissions/<agent>/<requestID>` | Reply to a permission (`{ decision, reason? }`) |
| `POST` | `/api/prompt/<agent>` | Send a prompt to an agent (`{ text }`) |
| `POST` | `/api/agents/<name>/restart` | Restart an agent's session |
| `POST` | `/api/agents/<name>/abort` | Abort an agent's current work |

### Projects

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/projects` | List active projects |
| `POST` | `/api/projects` | Add a project (`{ directory, directive?, name?, baseBranch?, model? }`). Returns 409 if already active or if the directory is the one currently running the orchestrator, 404 if the directory does not exist |
| `DELETE` | `/api/projects/<id>` | Remove a project |
| `PUT` | `/api/projects/<id>/directive` | Update directive and restart supervisor (`{ directive }`) |
| `PUT` | `/api/projects/<id>/model` | Update model and restart supervisor (`{ model }`) |
| `GET` | `/api/projects/<id>/directive-history` | Directive history timeline |
| `POST` | `/api/projects/<id>/directive-comment` | Add comment on a directive entry (`{ comment, historyIndex? }`) |
| `POST` | `/api/projects/<id>/pause` | Request pause for a project |
| `POST` | `/api/projects/<id>/resume` | Resume a paused project |
| `GET` | `/api/projects/<id>/branch` | Get the agent's git branch name |
| `POST` | `/api/projects/<id>/merge` | Merge agent branch (`{ targetBranch? }`) |
| `POST` | `/api/projects/<id>/validation` | Set validation config (`{ command?, preset?, failAction? }`) |
| `GET` | `/api/projects/saved` | Load saved project configs for restore |
| `POST` | `/api/projects/restore` | Restore all saved projects |
| `GET` | `/api/memory/<agent>` | Agent memory: behavioral notes, project notes, session summaries |

### Global Controls

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/command` | Execute a CLI command (`{ command }`) |
| `POST` | `/api/soft-stop` | Soft stop all supervisors |
| `POST` | `/api/pause-all` | Pause all supervising projects |
| `POST` | `/api/resume-all` | Resume all paused projects |
| `POST` | `/api/feedback` | Submit user feedback annotation (`{ agent, selectedText, note, type }`) |

### Providers and Models

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/providers` | List configured LLM providers |
| `POST` | `/api/providers` | Add or update a provider |
| `POST` | `/api/providers/<id>/models` | Add a model to a provider (`{ model }`) |
| `DELETE` | `/api/providers/<id>/models` | Remove a model from a provider (`{ model }`) |
| `GET` | `/api/models` | List all models across enabled providers |
| `GET` | `/api/ollama-models` | List Ollama models (legacy, proxied from Ollama API) |

### Resources

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/resources/locks` | Active file locks + LLM queue depth |
| `GET` | `/api/resources/intents` | Declared work intents |
| `GET` | `/api/tokens` | Token usage stats per agent |

### Team

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/team/members` | Team members and status |
| `GET` | `/api/team/hire-requests` | Pending hire requests |
| `POST` | `/api/team/hire-requests` | Approve a hire request (`{ index, agentName }`) |
| `GET` | `/api/team/dissolve-requests` | Pending dissolution requests |
| `POST` | `/api/team/dissolve-requests` | Approve a dissolution (`{ agentName }`) |

### Analytics and Observability

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/performance` | Performance log entries |
| `GET` | `/api/analytics/sessions?id=` | List or get specific analytics sessions |
| `POST` | `/api/analytics/evaluate/<id>` | AI evaluation of a session |
| `POST` | `/api/analytics/compare` | Compare two sessions (`{ sessionA, sessionB }`) |
| `GET` | `/api/analytics/comparisons` | List all session comparisons |
| `GET` | `/api/analytics/timeline` | Cycle timeline data for charts |
| `GET` | `/api/ledger?source=&agentName=&search=&tags=&since=&until=&limit=&offset=` | Query the prompt ledger |
| `GET` | `/api/ledger/stats` | Ledger statistics by source, agent, hour |
| `GET` | `/api/crash-info` | Crash recovery information |
| `GET` | `/api/browse?path=<dir>` | Browse directories for folder picker |

---

## Pause Service

The pause service provides graceful suspension of project supervisors, distinct from soft-stop:

| Action | Behavior |
|--------|----------|
| **Soft stop** | Finish the current cycle, then exit the supervisor loop permanently |
| **Pause** | Finish the current work plan, reach a clean checkpoint, then hold indefinitely until resumed |

### How it works

1. **Request pause** -- via dashboard button, CLI (`pause <project>`), or API (`POST /api/projects/<id>/pause`)
2. **Wrap-up injection** -- The supervisor injects a message asking the LLM to wrap up cleanly and issue `@done:`
3. **Hard break** -- If the LLM doesn't comply within 2 rounds after the pause injection, the cycle is force-ended (prevents infinite loops with smaller models)
4. **Block at cycle boundary** -- After the cycle ends, the supervisor enters a blocked state instead of starting the next cycle
5. **Dashboard feedback** -- PAUSING badge (amber) while wrapping up, then PAUSED (blue) once blocked. Tooltips show time since request
6. **Resume** -- via dashboard, CLI, or API. The supervisor immediately starts the next cycle

---

## Prompt Ledger

Persistent, queryable log of every prompt at every level of the orchestration hierarchy.

### What's recorded

| Source | What |
|--------|------|
| `user` | CLI commands, dashboard prompts, feedback annotations |
| `brain` | Brain LLM calls, brain-to-agent prompts |
| `supervisor` | Supervisor LLM calls, supervisor-to-agent prompts |
| `manager` | Team manager LLM calls, manager-to-supervisor directives |
| `agent` | Agent responses, review results |
| `system` | Pause injection messages |

### Storage

- Persisted to `.orchestrator-ledger.json`
- Write-locked (promise-chain mutex)
- Capped at 2000 entries (oldest dropped)
- All recording is fire-and-forget so failures never block the supervisor

---

## Testing

```bash
# Run all tests (39 test files under src/tests/)
bun test

# Run a specific test file
bun test src/tests/dashboard-api.test.ts

# Type check
bun run typecheck

# End-to-end smoke: clone/commit/push/merge against a local bare repo
bun run smoke

# Scan the working tree for committed secrets (also runs automatically
# as a pre-commit hook when .githooks is activated)
bun run check-secrets
```

The test suite covers:

| Suite | Tests | Covers |
|-------|-------|--------|
| `core.test.ts` | Conversation trimming, message extraction, formatting |
| `brain-commands.test.ts` | Brain and supervisor command parsers |
| `brain-memory.test.ts` | Behavioral note deduplication |
| `brain-memory-archive.test.ts` | Memory archival and trimming policies |
| `command-recovery.test.ts` | Nudge system, circuit breaker, fuzzy command extraction |
| `dashboard-api.test.ts` | HTTP endpoints: routing, auth, CORS, events, resources |
| `dashboard-ui.test.ts` | DOM rendering: badges, status dots, toasts, filtering, ARIA, sidebar |
| `event-bus.test.ts` | Event emission, subscription, pattern matching, ring buffer |
| `file-utils.test.ts` | Atomic writes, JSON read/write, error handling |
| `git-utils-branches.test.ts` | Branch existence, remote URL, branch listing, commits-ahead (real temp repo) |
| `integration-supervisor.test.ts` | End-to-end supervisor cycle with mock LLM |
| `message-utils-priority.test.ts` | Priority-aware message trimming |
| `opencode-runtime.test.ts` | Opencode launch resolution and runtime paths |
| `pause-service.test.ts` | Pause state transitions, await/resume, abort signal |
| `progress-assessor.test.ts` | False-progress detection heuristics |
| `promptAll-isolation.test.ts` | Cross-agent prompt isolation |
| `providers.test.ts` | Provider management, model listing, API key resolution |
| `rate-limit-backoff.test.ts` | 429 cooldown and escalating backoff |
| `repo-identity.test.ts` | Git URL normalization, repo slug, canonical agent name, self-ingest detection |
| `resource-manager.test.ts` | File locks, contention, LLM semaphore, work intents, rate limits |
| `session-state.test.ts` | Session state, crash detection, checkpointing |
| `shared-knowledge.test.ts` | Cross-agent broadcast store |
| `supervisor-commands.test.ts` | Supervisor command parsing edge cases |

---

## License

MIT

## Troubleshooting

### Provider Setup Issues

#### Authentication Failures
If you see AUTH errors in the Boot Status panel:

1. Verify your API keys are correctly set in `.env`
2. For OpenAI: Ensure `OPENCODE_OPENAI_API_KEY` is set
3. For Anthropic: Ensure `OPENCODE_ANTHROPIC_API_KEY` is set
4. For Google: Ensure `OPENCODE_GO_API_KEY` is set
5. After updating `.env`, restart the orchestrator

#### Provider Not Reachable
If you see DOWN errors:

1. Check your internet connection
2. Verify the provider's service status
3. Ensure any required proxy settings are configured
4. Check firewall rules aren't blocking API endpoints

#### Quota Exceeded
If you see QUOTA errors:

1. Check your provider account for usage and billing
2. Consider adding additional providers for load balancing
3. Implement rate limiting in your workflow
4. Wait for quota reset or upgrade your plan

#### Model Not Found
If models aren't appearing in the dashboard:

1. Verify the provider API key has access to the models
2. Some providers require explicit model enablement in their dashboard
3. Check if the model names are correctly formatted
4. Try refreshing the model list in the provider settings

### Common Worker Issues

#### Silent Fallback Behavior
When a provider is misconfigured, workers may silently fall back to default providers:

1. Always verify Boot Status shows all enabled providers as HEALTHY
2. Check worker logs for provider routing information
3. Test with a simple task before launching complex workflows

#### Configuration Drift
If workers behave unexpectedly:

1. Verify `orchestrator-providers.json` matches dashboard settings
2. Check per-worker `opencode.json` files in `.orchestrator-workspaces/`
3. Ensure `.env` changes are applied (requires restart)
4. Look for conflicting environment variables

### Debugging Tips

1. Enable verbose logging by setting `DEBUG=true` in `.env`
2. Check the prompt ledger at `.orchestrator-ledger.json` for request/response details
3. Monitor the supervisor logs for decision-making insights
4. Use the dashboard's real-time inspection to view agent communications


## Provider Configuration

Configuration for LLM providers is managed through `orchestrator-providers.json` in the root directory. This file defines which providers are available, their API keys, and configured models.

### File Structure

The configuration file follows this structure:

```jsonc
{
  "providers": [
    {
      "id": "string",
      "name": "string",
      "enabled": "boolean",
      "apiKey": "string | null",
      "configuredModels": ["string"],
      "defaultModel": "string | null"
    }
  ]
}
```

### Field Descriptions

| Field | Type | Description |
|-------|------|-------------|
| id | string | Unique identifier for the provider (e.g., "openai", "anthropic", "google", "ollama") |
| name | string | Human-readable name displayed in the dashboard |
| enabled | boolean | Whether the provider is active and available for use |
| apiKey | string | Reference to environment variable containing the API key (null for Ollama) |
| configuredModels | string[] | Array of model identifiers available for this provider |
| defaultModel | string | Default model to use when none specified (optional) |

### Provider-Specific Notes

#### Ollama
- Does not require an API key
- Models are discovered automatically via `/api/tags` endpoint
- Configured models should match those available in your Ollama instance

#### Cloud Providers (OpenAI, Anthropic, Google)
- Require valid API keys stored in environment variables
- Model availability depends on your subscription and access
- Refer to provider documentation for valid model identifiers

### Environment Variable Mapping

Provider API keys are resolved from environment variables:

| Provider | Environment Variable |
|----------|----------------------|
| openai | `OPENCODE_OPENAI_API_KEY` |
| anthropic | `OPENCODE_ANTHROPIC_API_KEY` |
| google | `OPENCODE_GO_API_KEY` |

### Example Configuration

```json
{
  "providers": [
    {
      "id": "ollama",
      "name": "Ollama Local",
      "enabled": true,
      "apiKey": null,
      "configuredModels": ["codellama", "llama2"],
      "defaultModel": "codellama"
    },
    {
      "id": "openai",
      "name": "OpenAI",
      "enabled": true,
      "apiKey": "${OPENCODE_OPENAI_API_KEY}",
      "configuredModels": ["gpt-4", "gpt-3.5-turbo"],
      "defaultModel": "gpt-4"
    }
  ]
}
```

### Usage Notes

1. The orchestrator automatically synchronizes this file with dashboard changes
2. Manual edits are preserved but may be overridden by dashboard operations
3. API keys are never stored in plain text - they reference environment variables
4. Changes require orchestrator restart to take effect
5. The `defaultModel` field is optional and falls back to the first configured model

## Dashboard Configuration

The web dashboard can be customized through environment variables and configuration files.

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `DASHBOARD_PORT` | Port for the dashboard server | `3000` |
| `DASHBOARD_HOST` | Hostname to bind the dashboard | `0.0.0.0` |
| `DASHBOARD_DISABLE_AUTH` | Disable API token authentication (not recommended for production) | `false` |
| `DASHBOARD_CORS_ORIGINS` | Comma-separated list of allowed CORS origins | `*` |
| `DASHBOARD_THEME` | Color theme (`light` or `dark`) | `system` (follows OS preference) |
| `DASHBOARD_REFRESH_INTERVAL` | Auto-refresh interval in milliseconds | `5000` |
| `DASHBOARD_MAX_LOGS` | Maximum number of log entries to retain | `1000` |

### Customization Options

#### Changing the Dashboard Port

To run the dashboard on a different port:

```bash
DASHBOARD_PORT=8080 bun run start
```

#### Disabling Authentication (Development Only)

⚠️ **Warning**: Disabling authentication exposes your orchestrator to unauthorized access.

```bash
DASHBOARD_DISABLE_AUTH=true bun run start
```

#### Setting CORS Origins

To restrict dashboard access to specific domains:

```bash
DASHBOARD_CORS_ORIGINS="http://localhost:3000,https://yourdomain.com" bun run start
```

#### Theme Configuration

Choose between light and dark themes:

```bash
DASHBOARD_THEME=dark bun run start
```

#### Adjusting Refresh Rates

Modify how frequently the dashboard updates:

```bash
DASHBOARD_REFRESH_INTERVAL=2000 bun run start
```

#### Log Retention Settings

Control how much historical data is preserved:

```bash
DASHBOARD_MAX_LOGS=5000 bun run start
```

### File-Based Configuration

Advanced configuration can be set in `dashboard-config.json`:

```jsonc
{
  "branding": {
    "title": "My Orchestrator",
    "logoUrl": "/path/to/logo.png",
    "footerText": "Powered by Multi-Agent Orchestrator"
  },
  "features": {
    "realTimeUpdates": true,
    "fileExplorer": true,
    "commandPalette": true,
    "showSystemMetrics": true
  },
  "limits": {
    "maxConcurrentProjects": 10,
    "maxLogEntriesPerAgent": 1000
  }
}
```

### Security Considerations

1. **Authentication**: The dashboard uses API token authentication by default. Tokens are embedded in the HTML served at `/` and must be sent via the `X-API-Token` header for API requests.

2. **CORS**: Configure `DASHBOARD_CORS_ORIGINS` to restrict which domains can access the dashboard API.

3. **Environment Variables**: Never commit `.env` files to version control. Use `.env.example` as a template.

4. **Network Exposure**: By default, the dashboard binds to `0.0.0.0` to allow access from other devices on your network. For local-only access, set `DASHBOARD_HOST=127.0.0.1`.

5. **Rate Limiting**: Consider placing a reverse proxy (like nginx or Cloudflare) in front of the dashboard for production deployments to add rate limiting and SSL termination.
