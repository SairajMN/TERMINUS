import type { CompletionReport, PermissionNote, TaskState } from "@terminus/shared";

const colored = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const paint = (rgb: string) => (text: string) =>
  colored ? `${rgbText(rgb)}${text}${rgbReset()}` : text;

const rgbText = (rgb: string): string => `\x1b[38;2;${rgb}m`;
const rgbReset = (): string => "\x1b[0m";

export const paper = paint("215,219,224");
export const stone = paint("138,148,163");
export const brass = paint("185,154,95");
export const leaf = paint("123,160,91");
export const rust = paint("176,90,90");

export const suitBanner = (text: string): string =>
  colored ? `\x1b[48;2;27;42;68m\x1b[38;2;215;219;224m${text}\x1b[0m` : text;

export interface DashState {
  startedAt: number;
  stateAt: Map<TaskState, number>;
  current: TaskState | null;
  toolCalls: number;
  spinner: number;
}

export const emptyDash = (): DashState => ({
  startedAt: Date.now(),
  stateAt: new Map(),
  current: null,
  toolCalls: 0,
  spinner: 0,
});

const TRACKED: TaskState[] = [
  "investigating",
  "planning",
  "awaiting_approval",
  "implementing",
  "verifying",
  "reviewing",
  "completed",
];

export const SHORT: Record<TaskState, string> = {
  queued: "queued",
  investigating: "research",
  planning: "plan",
  awaiting_approval: "approve",
  implementing: "build",
  verifying: "verify",
  reviewing: "review",
  failed_check: "failed",
  diagnosing: "fix",
  completed: "done",
  cancelled: "cancelled",
};

export const recordState = (dash: DashState, to: TaskState, at = Date.now()): DashState => {
  dash.current = to;
  dash.stateAt.set(to, at);
  return dash;
};

export const recordTool = (dash: DashState): DashState => {
  dash.toolCalls += 1;
  return dash;
};

export const header = (workspace: string, mode: string, label: string): string =>
  `${suitBanner(" TERMINUS ")}  ${stone(workspace)}  ${brass(mode)}  ${stone(label)}  ${stone("v0.1.0")}`;

export const timeline = (dash: DashState): string => {
  const parts = TRACKED.map((state) => {
    const at = dash.stateAt.get(state);
    const mark = dash.current === state ? brass("●") : at !== undefined ? leaf("●") : stone("○");
    return `${mark} ${stone(SHORT[state])}`;
  });
  return `  ${parts.join("  ")}`;
};

export const elapsed = (dash: DashState, now = Date.now()): string =>
  stone(`elapsed ${((now - dash.startedAt) / 1000).toFixed(1)}s · ${dash.toolCalls} tools`);

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export const spin = (dash: DashState): string => {
  const frame = SPINNER[dash.spinner % SPINNER.length] ?? "⠋";
  dash.spinner += 1;
  return colored ? frame : "…";
};

const toolSubject = (name: string, input: unknown): string => {
  const value = (input ?? {}) as Record<string, unknown>;
  if (name === "run_command") return String(value.command ?? "");
  return typeof value.path === "string" ? value.path : "";
};

export const toolLine = (name: string, input: unknown, decision: PermissionNote): string => {
  const subject = toolSubject(name, input);
  const mark =
    decision.verdict === "deny" ? rust("✕") : decision.verdict === "ask" ? brass("?") : stone("·");
  const suffix =
    decision.verdict === "deny"
      ? ` · ${decision.reason}`
      : ` · ${decision.verdict}(${decision.tier})`;
  return `  ${mark} ${paper(name)}${subject ? ` ${stone(subject)}` : ""}  ${stone(suffix)}`;
};

export const approvalCard = (question: string, detail?: string): string => {
  const lines = [`  ${brass("approve?")} ${paper(question)}`];
  if (detail) {
    for (const line of detail.split("\n").slice(0, 6)) lines.push(`    ${stone(line)}`);
    lines.push(`    ${stone("[y]es / [n]o / [f]eedback")}`);
  } else {
    lines.push(`    ${stone("[y]es / [a]lways / [N]o")}`);
  }
  return lines.join("\n");
};

export const reportCard = (report: CompletionReport): string => {
  const done = report.outcome === "completed";
  const lines = ["", `  ${done ? leaf("done") : rust(report.outcome)} · ${paper(report.summary)}`];
  if (report.changedFiles.length > 0) {
    lines.push(`  ${stone("changed")}`);
    for (const file of report.changedFiles) lines.push(`    ${paper(file)}`);
  }
  if (report.checks.length > 0) {
    lines.push(`  ${stone("checks")}`);
    for (const check of report.checks) {
      lines.push(`    ${check.passed ? leaf("[pass]") : rust("[fail]")} ${paper(check.command)}`);
    }
  }
  if (report.review) {
    lines.push(
      `  ${stone("review")} ${report.review.verdict === "clear" ? leaf("clear") : brass("issues")} · ${paper(report.review.summary.split("\n")[0] ?? "")}`,
    );
  }
  if (report.tokens) {
    lines.push(
      `  ${stone("tokens")} ${stone(`${report.tokens.prompt} in / ${report.tokens.completion} out`)}`,
    );
  }
  return lines.join("\n");
};

export const chatHint =
  "chat freely; directives run as tasks. /help, /clear, /quit — /help for details";
