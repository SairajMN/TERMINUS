# TERMINUS — Status, Roadmap & What You Can Do

Generated from the current tree (`b29d116`, origin/main in sync). Use this as the single source of truth for what ships, what’s missing, and your next moves for the Nebius × NVIDIA hackathon (submission deadline **Oct 30, 2026, 10:00 AM PDT**).

---

## Status: what is done

### Build system
- **Monorepo** — bun workspaces, TypeScript strict (`tsc --noEmit` clean), Biome lint+format clean.
- **Packages**: `shared`, `model-gateway`, `tool-runtime`, `permission-engine`, `context-engine`, `session-store`, `agent-runtime`, `research`, `apps/cli`.
- **Tests**: 131/131 passing across 26 files; `bun test` is the gate before every commit.

### Model integration (the hackathon requirement: real Nemotron call)
- **Gateway**: OpenAI-compatible client pointed at `https://api.tokenfactory.us-central1.nebius.com/v1/`, default model `nvidia/nemotron-3-super-120b-a12b`, Anthropic fallback, streaming with `tool_calls` delta assembly, usage tokens tracked end-to-end.
- **Selection**: `NEBIUS_API_KEY` → Nemotron; no key → Anthropic; `--provider` / `--model` overrides.
- **Live proof**: Spike A confirmed Nemotron returns structured `tool_calls` on Token Factory.

### Context engine (the differentiator)
- Evidence store: every retrieved item kept verbatim with provenance, content hash, relevance, trust level (`trusted` / `untrusted`), and freshness flag.
- Repository map + stale-write guard (re-hash before edits; mark stale and re-read if changed).
- Progressive exploration: directory listing → grep → explicit reads; nothing preloads the whole repo.

### Agent runtime
- State machine: `queued → investigating → planning → awaiting_approval → implementing → verifying → reviewing → completed`, with failure path `implementing → failed_check → diagnosing → retrying`.
- Plan → you approve → edit → verify → report. Completion is proven by actual check results, never model prose.
- Self-correction: on a failed check the agent diagnoses, fixes, and re-runs verification (observed live on the debounce benchmark task).
- `createAgent()` sessions carry conversation + evidence across tasks in one REPL session.

### Tool runtime
- `read_file`, `write_file`, `edit_file` (exact-string replace), `list_dir`, `search` (grep), `run_command` (bounded output, timeout, cancellation, secret redaction), `git_status`, `git_diff`.
- All file ops workspace-path-restricted; every tool has zod-validated input, structured error, and audit metadata.

### Permission engine (Jev-style gate, brand-neutral)
- Order: hard-deny regex → fast-path allowlist → risk-tier classification → user approval.
- Decision made on the **proposed action only**, never conversation text. Session-based `[a]lways` remembers per-session, never global.
- Tighten-only local overrides: `~/.terminus/policy.local.json` may only add restrictions.

### Session & audit
- Local SQLite (`~/.terminus/terminus.db`) with dual backend: `node:sqlite` on Node ≥22.5, `bun:sqlite` under Bun.
- Append-only tool audit log; sessions persist plans, states, and results across invocations (`--resume <id>`, `--sessions`).

### Research
- `packages/research`: Tavily client (Bearer auth, mocked in tests) + `web_research` tool (read tier, network-allowlisted by the gate).
- Research evidence stored as **untrusted, cited** (`[title](url)`); it can never authorize a command.

### CLI (responsive, width/height aware)
- **Dashboard**: suit palette (`#1B2A44` banner, paper/stone/brass/leaf/rust), state timeline, per-event tool feed with verdicts, usage lines, approval and report cards.
- **Responsive**: `fit.ts` reads `COLUMNS`/`LINES` (or stdout columns/rows); header shortens path → drops label → drops version as width shrinks; timeline degrades to chain → count; report lines wrap; first-run screen wraps to width and hides blocks under 18 rows.
- **Status line**: in-place spinner (`thinking · 2.3s · 3 tools`) redrawn during model/tool gaps; TTY-only, zero escape codes when piped.
- **REPL**: `terminus` with no task → chat freely; task-like lines run the full loop and share context; `/help /clear /sessions /debt /quit`; SIGWINCH redraws the prompt with buffered input.
- **Flags**: `--mode ask|plan|audit|act|auto`, `--yes`, `--verify "cmd1,cmd2"`, `--report json`, `--timeout <sec>`, `--model`, `--provider`, `--sessions`, `--resume <id>`, `--debt`, `--version`.

### Benchmark (4/4 live on Nemotron)
| Task | Kind | Difficulty | Outcome | Ground truth | Retries | Tokens in/out | Seconds |
|---|---|---|---|---|---|---|---|
| strings-truncate | implement | easy | completed | ✅ | 0 | 29,030 / 1,637 | 16.0 |
| calculator-average-bug | debug | easy | completed | ✅ | 0 | 31,498 / 1,899 | 17.0 |
| debounce-implementation | implement | medium | completed | ✅ | 1 | 22,917 / 1,864 | 13.5 |
| timezone-formatter | implement | medium | completed | ✅ | 0 | 30,824 / 3,078 | 20.4 |

Ground truth = re-running each fixture’s own `npm test` after TERMINUS finished. `debounce` hit a real failing check, diagnosed, fixed, and re-verified — the retry loop fired on the live model.

### Distribution
- **npm**: `terminus-agent@0.1.0` published (`npm install -g terminus-agent` / `bun install -g terminus-agent`).
- **Repo**: `git push origin main` clean; `b29d116` is on `origin/main`, 0 ahead, working tree clean.
- Push Protection was satisfied by rewriting history to remove two test fixtures that contained Stripe’s documented example key.

### Brand hygiene
- Zero references to Cline, Nūs Desktop, Jev Engineering, or ponytail in code/commit messages/docs (only a substring false-positive "de**cline**d" in `run.ts`, which is English prose).

---

## What is left

### Short term (this week)
1. **Republish `0.1.1`** so npm carries the responsive UI (currently npm serves `0.1.0`). Run `bun run release` from the repo; it needs your npm 2FA once.
2. **Demo video** — `docs/demo.md` has the exact task line and a timed <3-minute shot list. Record it, upload to YouTube (unlisted or public), paste the link into `README.md`.
3. **Register on Devpost** and claim Token Factory credits (`NEBIUS-DEVPOST-GLOBAL26`); write the short Nebius/NVIDIA feedback paragraph required by the rules.

### Medium term (before Oct 30)
| Area | What to add |
|---|---|
| VS Code extension | Thin host over the same `apps/cli` runtime (runtime independent of UI) |
| Model routing | Nemotron 3.5 Lightning for routine ops, Ultra 550B for hard architecture; route by measured cost/latency/success, not hard-coded task names |
| Semantic retrieval | VS Code language-service symbol lookup (definition/references/implementations) — optional |
| Vector search | Add only if keyword + symbol search measurably fail on a real repo |
| Project rules | Load `AGENTS.md` / contribution guidelines into layer 2 of the context engine |
| Checkpoints | Git-aware checkpoints + diff review before risky batches |
| More verifiers | ESLint, `tsc`, project test runners, secret scanning |

### Long term (post-hackathon)
- Multi-agent / specialist workers (research vs implementation vs review) coordinated by a single coordinator — **not** before the single-agent loop is rock solid.
- Token Factory sandbox integration for isolated execution (investigate per the hackathon rules).
- Persistent cross-session memory beyond SQLite sessions (architectural decisions, project conventions).

### Explicit non-goals for now
No Electron app, no embeddings/vector DB unless proven necessary, no automatic deployment, no model that authorizes its own actions.

---

## What you can do right now

### Install & run (any project folder)

```bash
# Option A: published package (0.1.0, no responsive UI yet)
npm install -g terminus-agent      # or: bun install -g terminus-agent

# Option B: from source (has b29d116 responsive UI)
cd /Users/sahil/Desktop/HACKATHON/TERMINUS
bun install
bun run terminus "add input validation to the signup form"

# Then set keys so it works from anywhere
mkdir -p ~/.terminus && cat > ~/.terminus/.env <<'INNEREOF'
NEBIUS_API_KEY=your_nebius_key
TAVILY_API_KEY=tvly-...   # optional deep research
INNEREOF
```

### Try these tasks
```bash
# Pure explanation, no edits
terminus --mode ask "what does src/date.mjs export?"

# Research + plan, zero file changes
terminus --mode plan "how should we structure the API client?"

# Full loop with your approval at each change
terminus --mode act "make npm test pass" --dir /path/to/your-project

# Machine-readable report for CI/scripts
terminus --mode act "..." --report json
```

### Hackathon submission checklist
- [ ] Public GitHub repo (`SairajMN/TERMINUS` — already pushed)
- [ ] OSI-style license (MIT — present)
- [ ] README with install + config + run steps (present; add YouTube link)
- [ ] Working demo / test build (benchmark fixtures in `examples/benchmark/`)
- [ ] YouTube video < 3 minutes (record per `docs/demo.md`)
- [ ] Explanation of how Nemotron + Token Factory power the system (README section present)
- [ ] Nebius/NVIDIA tools feedback paragraph (write after recording)
- [ ] Register on Devpost before Oct 30, 10:00 AM PDT

### Next publish
```bash
cd /Users/sahil/Desktop/HACKATHON/TERMINUS
bun run release   # tests → typecheck → lint → bundle → npm publish (needs your 2FA once)
```

---

## Commands reference

| Flag | Meaning |
|---|---|
| `--mode ask\|plan\|audit\|act\|auto` | Operating mode (default `act`) |
| `--yes` | Auto-approve low-risk actions |
| `--verify "cmd1,cmd2"` | Checks to run at the end |
| `--report json` | Pure JSON report on stdout (CI-friendly) |
| `--timeout <sec>` | Per-command timeout override |
| `--model <id>` | Model override |
| `--provider nebius\|anthropic` | Inference backend |
| `--sessions` | List recent sessions for this workspace |
| `--resume <id>` | Continue an earlier session |
| `--debt` | List `shortcut:` comments on record |
| `--version` | Show version |

REPL commands: `/help /clear /sessions /debt /quit`.

---

*Last verified: 131/131 tests, typecheck clean, lint clean, v0.1.1 built with Agent Skills & Anchored Context Encapsulation.*
