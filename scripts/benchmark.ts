// Live coding benchmark: runs TERMINUS against fixture tasks with the real
// model, then independently re-runs each project's test suite as ground truth.
// Run: bun run benchmark
import { execSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTask } from "../packages/agent-runtime/src/index";
import { nebiusGateway } from "../packages/model-gateway/src/index";
import type { AgentEvent, CompletionReport } from "../packages/shared/src/index";

if (!process.env.NEBIUS_API_KEY) {
  console.error("NEBIUS_API_KEY is not set (see .env.example)");
  process.exit(2);
}

interface BenchTask {
  name: string;
  difficulty: "easy" | "medium";
  kind: "implement" | "debug";
  fixture: string;
  task: string;
}

const TASKS: BenchTask[] = [
  {
    name: "strings-truncate",
    difficulty: "easy",
    kind: "implement",
    fixture: "examples/benchmark/strings-task",
    task: "add truncate(value, limit) to src/strings.mjs so npm test passes: return the value unchanged when it fits within limit characters, otherwise the first limit characters followed by three dots",
  },
  {
    name: "calculator-average-bug",
    difficulty: "easy",
    kind: "debug",
    fixture: "examples/benchmark/calculator-task",
    task: "npm test fails. find and fix the bug in src/calculator.mjs without changing the public API",
  },
  {
    name: "debounce-implementation",
    difficulty: "medium",
    kind: "implement",
    fixture: "examples/benchmark/debounce-task",
    task: "add debounce(fn, waitMs) to src/events.mjs so npm test passes: calls inside one window collapse to a single trailing invocation",
  },
  {
    name: "timezone-formatter",
    difficulty: "medium",
    kind: "implement",
    fixture: "examples/demo-project",
    task: "add formatForTimezone(iso, timeZone) to src/date.mjs so npm test passes",
  },
];

interface BenchResult {
  name: string;
  difficulty: string;
  kind: string;
  outcome: CompletionReport["outcome"];
  checks: string;
  groundTruth: boolean;
  failedChecks: number;
  tokens: { prompt: number; completion: number } | undefined;
  seconds: number;
  changedFiles: number;
}

globalThis.TZ = "UTC";
const gateway = nebiusGateway();
const results: BenchResult[] = [];

for (const bench of TASKS) {
  process.stderr.write(`\n=== ${bench.name} (${bench.difficulty}/${bench.kind}) ===\n`);
  const dir = mkdtempSync(join(tmpdir(), `terminus-bench-`));
  cpSync(join(import.meta.dir, "..", bench.fixture), dir, { recursive: true });
  const started = Date.now();
  let failedChecks = 0;
  const emit = (event: AgentEvent) => {
    if (event.type === "state" && event.to === "failed_check") failedChecks++;
    if (event.type === "tool") {
      process.stderr.write(`  ${event.decision.verdict} ${event.name}\n`);
    }
  };
  const report = await runTask(bench.task, {
    workspaceRoot: dir,
    gateway,
    approver: async () => ({ approved: true }),
    emit,
    mode: "act",
  });
  const seconds = Math.round((Date.now() - started) / 100);

  let groundTruth = false;
  try {
    execSync("npm test", { cwd: dir, stdio: "pipe" });
    groundTruth = true;
  } catch {
    groundTruth = false;
  }

  results.push({
    name: bench.name,
    difficulty: bench.difficulty,
    kind: bench.kind,
    outcome: report.outcome,
    checks: report.checks.map((c) => `${c.passed ? "pass" : "fail"}`).join(",") || "none",
    groundTruth,
    failedChecks,
    tokens: report.tokens,
    seconds: seconds / 10,
    changedFiles: report.changedFiles.length,
  });
  rmSync(dir, { recursive: true, force: true });
}

const passed = results.filter((r) => r.groundTruth && r.outcome === "completed");
const rows = results.map((r) =>
  [
    r.name,
    r.difficulty,
    r.kind,
    r.outcome,
    r.checks,
    r.groundTruth ? "YES" : "NO",
    String(r.failedChecks),
    r.tokens ? `${r.tokens.prompt}/${r.tokens.completion}` : "-",
    String(r.seconds),
  ].join(" | "),
);
const table = [
  "task | diff | kind | outcome | checks | ground-truth | retries | tokens in/out | secs",
  "--- | --- | --- | --- | --- | --- | --- | --- | ---",
  ...rows,
].join("\n");
console.log(`\n${table}\n`);
console.log(`pass rate: ${passed.length}/${results.length} (ground truth + completed)`);

mkdirSync(join(import.meta.dir, "..", "evals", "results"), { recursive: true });
const outFile = join(
  import.meta.dir,
  "..",
  "evals",
  "results",
  `benchmark-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
);
writeFileSync(
  outFile,
  JSON.stringify(
    { model: process.env.NEBIUS_MODEL ?? "nvidia/nemotron-3-super-120b-a12b", results },
    null,
    2,
  ),
);
console.log(`results: ${outFile}`);
process.exit(passed.length === results.length ? 0 : 1);
