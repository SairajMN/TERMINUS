import type { CompletionReport, TaskState } from "@terminus/shared";

const colored = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const paint = (rgb: string) => (text: string) =>
  colored ? `\x1b[38;2;${rgb}m${text}\x1b[0m` : text;

const ink = paint("216,222,233");
const muted = paint("108,122,137");
const accent = paint("127,161,195");
const ok = paint("123,160,91");
const err = paint("176,90,90");
const warn = paint("194,161,90");
const header = (text: string) =>
  colored ? `\x1b[48;2;27;42;65m\x1b[38;2;216;222;233m${text}\x1b[0m` : text;

const rule = muted("─".repeat(58));
const indent = (text: string, pad = "  ") =>
  text
    .split("\n")
    .map((line) => pad + line)
    .join("\n");

export const banner = (workspace: string): string =>
  `${header(" TERMINUS ")}  ${muted(workspace)}  ${muted("v0.1.0")}`;

export const firstRun = (): string =>
  [
    "",
    `  ${header(" TERMINUS ")}  ${muted("autonomous coding agent for your codebase")}`,
    "",
    "  It researches the project, plans the work, asks for your approval,",
    "  edits inside a permission gate, runs the project's own checks, and",
    "  reports what actually passed.",
    "",
    `  ${accent("SET UP")} (once)`,
    "    export NEBIUS_API_KEY=...          tokenfactory.nebius.com",
    "    optional: export NEBIUS_MODEL=nvidia/nemotron-3-super-120b-a12b",
    "    optional: export TAVILY_API_KEY=...  deep research (tvly-...)",
    "",
    `  ${accent("RUN")}`,
    '    bun run terminus "add input validation to the signup form"',
    '    bun run terminus --dir ../my-app "fix the failing auth test"',
    '    bun run terminus --mode plan "how should we structure the API client?"',
    '    bun run terminus --mode ask "what does src/billing do?"',
    "",
    `  ${accent("FLAGS")}`,
    "    --mode ask | plan | act | auto     default act: plan, approve, edit",
    "    --yes                             approve low-risk actions without asking",
    '    --verify "cmd1,cmd2"              checks to run at the end',
    "    --model <id>                      model override",
    "    --provider nebius | anthropic     inference backend override",
    "",
    `  ${accent("SAFETY")}`,
    "    Plans are approved before any change. Every command is checked",
    "    against the policy; dangerous operations are blocked or require",
    "    explicit approval. Completion is reported from check results,",
    "    never from prose.",
    "",
    `  ${muted("policy overrides: ~/.terminus/policy.local.json (deny rules only)")}`,
    `  ${muted("session log:      ~/.terminus/terminus.db")}`,
    "",
  ].join("\n");

const STATE_LABEL: Record<TaskState, string> = {
  queued: "queued",
  investigating: "investigating",
  planning: "planning",
  awaiting_approval: "awaiting approval",
  implementing: "implementing",
  verifying: "verifying",
  failed_check: "check failed",
  diagnosing: "diagnosing",
  completed: "completed",
  cancelled: "cancelled",
};

export const printState = (to: TaskState): void => {
  const label = STATE_LABEL[to];
  const paintFn =
    to === "completed" ? ok : to === "failed_check" || to === "cancelled" ? err : accent;
  process.stdout.write(`  ${paintFn("→")} ${paintFn(label)}\n`);
};

export const printText = (text: string): void => {
  process.stdout.write(`${ink(text.trimEnd())}\n`);
};

export const printPlan = (text: string): void => {
  process.stdout.write(
    `\n${rule}\n${indent(accent("plan"))}\n${indent(ink(text.trim()))}\n${rule}\n\n`,
  );
};

export const printTool = (
  name: string,
  input: unknown,
  decision: { verdict: string; tier: string; reason: string },
): void => {
  const value = (input ?? {}) as Record<string, unknown>;
  const subject =
    name === "run_command"
      ? String(value.command ?? "")
      : typeof value.path === "string"
        ? value.path
        : "";
  const paintFn = decision.verdict === "deny" ? err : decision.verdict === "ask" ? warn : muted;
  const suffix =
    decision.verdict === "deny"
      ? ` · ${decision.reason}`
      : ` · ${decision.verdict}(${decision.tier})`;
  process.stdout.write(
    `  ${muted("·")} ${ink(name)}${subject ? ` ${muted(subject)}` : ""}  ${paintFn(suffix)}\n`,
  );
};

export const printToolResult = (name: string, okFlag: boolean, summary: string): void => {
  if (okFlag && !summary.toLowerCase().includes("error")) return;
  process.stdout.write(`  ${err("✗")} ${muted(name)} ${muted(summary.split("\n")[0] ?? "")}\n`);
};

export const printUsage = (prompt: number, completion: number): void => {
  process.stdout.write(`  ${muted("tokens")} ${muted(`${prompt} in / ${completion} out`)}\n`);
};

export const printReport = (report: CompletionReport): void => {
  const mark = report.outcome === "completed" ? ok : err;
  process.stdout.write(`\n${rule}\n`);
  process.stdout.write(`  ${mark(report.outcome)} · ${ink(report.summary)}\n`);
  if (report.changedFiles.length > 0) {
    process.stdout.write(`\n  ${muted("changed files")}\n`);
    for (const file of report.changedFiles) process.stdout.write(`    ${ink(file)}\n`);
  }
  if (report.checks.length > 0) {
    process.stdout.write(`\n  ${muted("checks")}\n`);
    for (const check of report.checks) {
      process.stdout.write(
        `    ${check.passed ? ok("[pass]") : err("[fail]")} ${ink(check.command)}\n`,
      );
    }
  }
  if (report.tokens) {
    process.stdout.write(
      `\n  ${muted("tokens")} ${muted(`${report.tokens.prompt} in / ${report.tokens.completion} out`)}\n`,
    );
  }
  process.stdout.write(`${rule}\n\n`);
};
