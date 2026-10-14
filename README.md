# TERMINUS

An autonomous coding agent that works inside your repository. It researches the
project, plans the change, asks for your approval, edits files through a
permission gate, runs the project's own checks, and reports completion from
evidence rather than prose.

```
TERMINUS ── plan ── approve ── edit ── run checks ── report
                │                       │
                └───── rejected ────────┘        failed checks → diagnose → fix → re-check
```

## Quick start

```bash
bun install
export ANTHROPIC_API_KEY=sk-ant-...

bun run terminus "add input validation to the signup form"
bun run terminus --mode plan "how should we structure the API client?"
bun run terminus --mode ask  "what does src/billing do?"
```

Requires [Bun](https://bun.sh) 1.2+.

## How a task runs

1. **Investigate** — the repository layout and project instructions (`AGENTS.md`)
   are collected.
2. **Plan** — the model explores with read-only tools and produces a plan.
3. **Approve** — you approve, reject, or give feedback (the plan is revised).
4. **Implement** — edits and commands run through the permission gate. Files
   changed outside the session are detected and re-read instead of edited blind.
5. **Verify** — the project's own scripts (`test`, `typecheck`, `check`, `lint`,
   `build`) are run. Failures are fed back for diagnosis, up to two cycles.
6. **Report** — completion lists changed files, commands run, and per-check
   results. If a check failed, the report says so.

## Safety model, in one screen

| Action class | Example | Behavior |
|---|---|---|
| Read | `git status`, `read_file`, `search` | allowed inside the workspace |
| Modify | `npm run test`, `write_file`, `git commit` | allowed in `act`/`auto`, denied in `plan`/`ask` |
| High-impact | `git push`, `terraform destroy`, unknown commands | always ask, never auto-approved |
| Denied | `sudo`, force-push, reading `~/.ssh`, piping curl into a shell | blocked in every mode |

Local policy (`~/.terminus/policy.local.json`) may only **add** deny rules —
loosening the shared policy is not possible by design.

## Layout

```
apps/cli                 terminal interface
packages/
  shared                 contracts: evidence, task states, tool and event types
  model-gateway          provider abstraction (Anthropic + scripted mock)
  permission-engine      deterministic policy gate
  tool-runtime           workspace tools, command runner, secret redaction
  context-engine         evidence store, repository map, freshness checks
  session-store          local SQLite session and audit log
  agent-runtime          the loop: plan → act → observe → verify
evals/                   safety fixtures run with the test suite
docs/                    architecture, security model, context engineering
```

## Commands

```bash
bun test            # unit + integration + safety evals
bun run typecheck   # strict TypeScript across all packages
bun run lint        # biome
```

## Documentation

- [Architecture](docs/architecture.md) — components, loops, state machine
- [Security model](docs/security-model.md) — gate ordering, tiers, threat notes
- [Context engineering](docs/context-engineering.md) — evidence, freshness, selection

## License

MIT

