# Demo runbook — submission video (< 3 minutes)

One task, one arc: **research → plan → approve → edit → fail → fix → prove**.
Everything below is real: real Nemotron on Token Factory, real Tavily call,
real test failure, real re-verification.

## Setup (before recording)

```bash
cp -R examples/demo-project /tmp/terminus-demo
cd /workspace/TERMINUS        # keys already in .env
```

Terminal: dark background, ~14pt, no other tabs. Record the CLI only.

## The task line

Phrase it so research is part of the story:

```bash
bun run terminus --dir /tmp/terminus-demo \
  "research the current Intl.DateTimeFormat timezone docs with web_research and cite them, then add formatForTimezone(iso, timeZone) so npm test passes"
```

## Shot list

| Time | Screen | Voiceover cue |
|---|---|---|
| 0:00-0:15 | first-run screen (`bun run terminus --help`) | TERMINUS turns instructions into execution; Nemotron on Nebius Token Factory underneath |
| 0:15-0:40 | live run: `investigating`, `planning`, `web_research` lines, cited plan | it researches first and must cite every source in the plan |
| 0:40-0:55 | plan approval prompt (`[y]/[n]/[f]`) — approve | nothing is touched before you approve |
| 0:55-1:20 | tool lines: `write_file ... allow(modify)`, permission-gate decisions | every action passes a deterministic permission gate, not the model's word |
| 1:20-1:45 | `[fail] npm run test` + the assertion output, `failed_check`, `diagnosing` | it runs the project's own test, observes a real failure, and diagnoses |
| 1:45-2:10 | `edit_file` fix, re-verify, `[pass] npm run test` | corrects the implementation and re-runs verification |
| 2:10-2:35 | completion report: changed files, checks, `tokens ... in/out` | completion is evidence: files, checks, token usage — from observed results |
| 2:35-2:50 | `bun run terminus --sessions` showing the stored run | every run is audited in a local session log |

Cut anything that drags; keep the failure visible for at least 3 seconds.

## B-roll candidates (if time allows)

- `git log --oneline` — stepwise commits, one per subsystem
- `bun test` — 96 tests including the safety matrix and the offline demo twin
- `--report json` output — machine-readable completion report

## Requirements checklist (submission)

- [ ] runtime call to Nebius Token Factory — shown live (Nemotron in banner)
- [ ] NVIDIA open model — `nvidia/nemotron-3-super-120b-a12b`
- [ ] public GitHub repo, OSI license (MIT) — ready
- [ ] README: install, configure, run — ready
- [ ] YouTube < 3 min — record with this runbook
- [ ] paragraph on Nebius/NVIDIA tool feedback — write after recording
- [ ] optional: Tavily award — the research step above qualifies the call
