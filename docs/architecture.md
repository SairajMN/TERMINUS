# Architecture

TERMINUS is a Bun/TypeScript monorepo. The agent runtime has no editor or UI
dependency; the CLI is one host among possible others. Every package has a
single responsibility and a one-way dependency edge.

## Package layering

```mermaid
flowchart TD
    cli["apps/cli<br/>terminal host: prompts, colors, approvals"]
    runtime["@terminus/agent-runtime<br/>task loop + state machine"]
    gateway["@terminus/model-gateway<br/>provider abstraction"]
    tools["@terminus/tool-runtime<br/>workspace tools + command runner"]
    perms["@terminus/permission-engine<br/>deterministic policy gate"]
    context["@terminus/context-engine<br/>evidence store + repository map"]
    store["@terminus/session-store<br/>SQLite sessions + audit log"]
    shared["@terminus/shared<br/>contracts: types, state machine, paths"]

    cli --> runtime
    runtime --> gateway
    runtime --> tools
    runtime --> perms
    runtime --> context
    runtime --> store
    runtime --> shared
    tools --> shared
    perms --> shared
    context --> shared
    gateway --> shared
    store --> shared
```

Rules: `shared` depends on nothing above it; host apps depend on the runtime,
never the reverse; tools never know which model produced their input.

## The task loop

```mermaid
sequenceDiagram
    participant U as User
    participant R as agent-runtime
    participant G as model-gateway
    participant P as permission-engine
    participant T as tool-runtime
    participant V as verification

    U->>R: task + workspace
    R->>R: collect repo map + AGENTS.md
    R->>G: plan request (read-only tools)
    G-->>R: exploration tool calls
    R->>T: read_file / search / list_dir
    T-->>R: results
    G-->>R: plan text
    R->>U: show plan
    U-->>R: approve | reject+feedback
    R->>G: implement request (all tools)
    G-->>R: write_file / edit_file / run_command
    R->>P: evaluate(action, mode)
    P-->>R: allow | ask | deny
    R->>U: approval request (if ask)
    U-->>R: yes / no
    R->>T: execute (after freshness check)
    T-->>R: tool result
    R->>V: npm run test / lint / build
    alt checks pass
        V-->>R: pass
        R->>U: completion report with evidence
    else checks fail
        V-->>R: failure output
        R->>G: diagnose request with failure output
        G-->>R: fix tool calls
        R->>V: re-run checks (max 2 cycles)
    end
```

## State machine

Every task has exactly one state; transitions are validated, illegal jumps
throw. Persisted to the session store on every change.

```mermaid
stateDiagram-v2
    [*] --> queued
    queued --> investigating
    investigating --> planning
    planning --> awaiting_approval
    awaiting_approval --> planning: feedback given
    awaiting_approval --> implementing: approved
    awaiting_approval --> cancelled: rejected
    implementing --> verifying
    verifying --> completed: all checks pass
    verifying --> failed_check: a check failed
    failed_check --> diagnosing: retries left
    failed_check --> completed: report honestly failed
    diagnosing --> implementing
    implementing --> cancelled: aborted
    verifying --> cancelled: aborted
    completed --> [*]
    cancelled --> [*]
```

## Tool execution pipeline

```mermaid
flowchart LR
    A[tool_use from model] --> B{schema valid?}
    B -- no --> E[error result to model]
    B -- yes --> C[map to Action]
    C --> D[permission gate]
    D -- deny --> E
    D -- ask --> F{user approves?}
    F -- no --> E
    F -- yes --> G{write & file stale?}
    G -- yes --> H[stale error: re-read first]
    G -- no --> I[execute tool]
    I --> J[bounded, redacted result]
    J --> E
    E --> K[result back into conversation]
```

## Model gateway

`ModelGateway.complete(request, signal)` returns an async stream of `text`,
`tool_use`, and `usage` events. Providers implement the same interface:

- `nebiusGateway` — Nebius Token Factory (OpenAI-compatible) streaming with
  `tool_calls` argument-delta assembly; Nemotron models, 3 automatic retries.
- `anthropicGateway` — streaming Messages API with tool-use block assembly.
- `mockGateway` — scripted responses that record every request (snapshot);
  the end-to-end tests use it, so the full agent path runs without a network.

Selection is environment-driven via `selectGateway()`:

```mermaid
flowchart LR
    E[NEBIUS_API_KEY set?] -- yes --> N[nebiusGateway<br/>nvidia/nemotron-3-super-120b-a12b]
    E -- no --> A[anthropicGateway]
    F[--provider / --model flags] --> G[override]
    G --> N
    G --> A
    N --> R[ModelGateway]
    A --> R
    M[mockGateway] --> R
```

Adding another provider means implementing one function. Nothing else in the
runtime changes.

## Research flow (Tavily)

`web_research` is a read-tier tool: it is visible while planning, never maps
to a shell action, and its output is stored as **untrusted** evidence with
URLs preserved. The plan directive requires `[title](url)` citations for any
research used.

```mermaid
sequenceDiagram
    participant M as Model
    participant R as agent-runtime
    participant T as web_research
    participant V as Tavily API
    participant E as EvidenceStore

    M->>R: tool_use web_research(query)
    R->>R: actionFor -> null (not a shell action)
    R->>T: execute
    T->>V: POST api.tavily.com/search (Bearer)
    V-->>T: results (title, url, content)
    T-->>R: numbered excerpts (redacted)
    R->>E: add as documentation, trust=untrusted
    R-->>M: tool_result with URLs
    M->>R: plan citing [title](url)
```

Search results are data: they never reach the permission engine and cannot
authorize a command.

## Contracts (`@terminus/shared`)

| Contract | Purpose |
|---|---|
| `ContextEvidence` | provenance-carrying context item: kind, source, hash, trust, staleness |
| `TaskState` / `TaskMachine` | validated task lifecycle |
| `ToolDefinition` | name, JSON-schema (zod), permission tier, bounded execution |
| `Action` | what the gate actually judges: command, file read, file write |
| `AgentEvent` | the only channel from runtime to any host UI |
| `CompletionReport` | outcome + changed files + commands + per-check results |

## Session persistence

`~/.terminus/terminus.db` (SQLite, WAL): one row per session (workspace, task,
state) and one append-only event log per session (tool decisions, approvals,
final report). Nothing about the workspace leaves the machine except the
scoped model requests described in [context engineering](context-engineering.md).

## Deliberate simplifications

- The repository map is a depth-3 tree plus manifest summaries — a tree index
  or embedding store can replace it behind `buildRepoMap` without touching the
  loop.
- Verification commands come from `package.json` scripts or `--verify`; other
  ecosystems can add detectors in `detectVerifications`.
- One agent, one workspace, sequential turns. Parallel specialist agents would
  sit above `runTask` and coordinate through the same event/report contracts.
