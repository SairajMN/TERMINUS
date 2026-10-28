import type { CompletionReport, PermissionNote, TaskState } from "@terminus/shared";
import { clip, fitWidth, shortPath, wrap } from "./fit";
import { VERSION } from "./version";

const colored =
  Boolean(process.stdout.isTTY) && !process.env.NO_COLOR && process.env.NODE_ENV !== "test";
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

export const header = (
  workspace: string,
  mode: string,
  label: string,
  width = fitWidth(),
): string => {
  const version = `v${VERSION}`;
  let withLabel = true;
  let withVersion = true;
  const tailLength = (): number =>
    2 + mode.length + (withLabel ? 2 + label.length : 0) + (withVersion ? 2 + version.length : 0);
  const fit = (): string => {
    let ws = shortPath(workspace, width - 12 - tailLength());
    while (12 + ws.length + tailLength() > width && (withLabel || withVersion)) {
      if (withLabel) withLabel = false;
      else withVersion = false;
      ws = shortPath(workspace, width - 12 - tailLength());
    }
    return ws;
  };
  const ws = fit();
  const tail =
    `  ${brass(mode)}` +
    (withLabel ? `  ${stone(label)}` : "") +
    (withVersion ? `  ${stone(version)}` : "");
  return `${suitBanner(" TERMINUS ")}  ${stone(ws)}${tail}`;
};

const trackMark = (dash: DashState, state: TaskState): string => {
  const at = dash.stateAt.get(state);
  if (dash.current === state) return brass("●");
  return at !== undefined ? leaf("●") : stone("○");
};

const renderTrack = (dash: DashState, states: TaskState[], joiner: string): string =>
  `  ${states.map((state) => `${trackMark(dash, state)} ${stone(SHORT[state])}`).join(joiner)}`;

const trackLength = (states: TaskState[], joiner: string): number =>
  2 +
  states.reduce(
    (total, state, index) => total + 2 + SHORT[state].length + (index > 0 ? joiner.length : 0),
    0,
  );

export const timeline = (dash: DashState, width = fitWidth()): string => {
  if (trackLength(TRACKED, "  ") <= width) return renderTrack(dash, TRACKED, "  ");
  const index = dash.current ? TRACKED.indexOf(dash.current) : -1;
  const upto = TRACKED.slice(0, index >= 0 ? index + 1 : 3);
  const more = upto.length < TRACKED.length;
  const compact = `${renderTrack(dash, upto, " › ")}${more ? stone(" › …") : ""}`;
  if (trackLength(upto, " › ") + (more ? 4 : 0) <= width) return compact;
  const label = dash.current ? SHORT[dash.current] : "queued";
  const mark = dash.current ? brass("●") : stone("○");
  return `  ${mark} ${stone(`${label} (${Math.max(index + 1, 0)}/${TRACKED.length})`)}`;
};

export const pace = (dash: DashState, now = Date.now()): string =>
  `${((now - dash.startedAt) / 1000).toFixed(1)}s · ${dash.toolCalls} tools`;

export const elapsed = (dash: DashState, now = Date.now()): string =>
  stone(`elapsed ${pace(dash, now)}`);

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

export const toolLine = (
  name: string,
  input: unknown,
  decision: PermissionNote,
  width = fitWidth(),
): string => {
  const subject = toolSubject(name, input);
  const mark =
    decision.verdict === "deny" ? rust("✕") : decision.verdict === "ask" ? brass("?") : stone("·");
  const suffix =
    decision.verdict === "deny"
      ? ` · ${decision.reason}`
      : ` · ${decision.verdict}(${decision.tier})`;
  const coreLength = 4 + name.length;
  const shownSuffix = clip(suffix, Math.max(8, width - coreLength - 2));
  const budget = width - coreLength - 2 - shownSuffix.length - (subject ? 1 : 0);
  const shownSubject = subject && budget >= 4 ? clip(subject, budget) : "";
  return `  ${mark} ${paper(name)}${shownSubject ? ` ${stone(shownSubject)}` : ""}  ${stone(shownSuffix)}`;
};

export const approvalCard = (question: string, detail?: string, width = fitWidth()): string => {
  const headLength = 12;
  const lines = wrap(question, Math.max(12, width - headLength)).map((segment, index) =>
    index === 0
      ? `  ${brass("approve?")} ${paper(segment)}`
      : `${" ".repeat(headLength)}${paper(segment)}`,
  );
  if (detail) {
    for (const line of detail.split("\n").slice(0, 6)) {
      lines.push(`    ${stone(clip(line, Math.max(8, width - 4)))}`);
    }
    lines.push(`    ${stone("[y]es / [n]o / [f]eedback")}`);
  } else {
    lines.push(`    ${stone("[y]es / [a]lways / [N]o")}`);
  }
  return lines.join("\n");
};

export const reportCard = (report: CompletionReport, width = fitWidth()): string => {
  const done = report.outcome === "completed";
  const verdict = done ? "done" : report.outcome;
  const headLength = 5 + verdict.length;
  const lines: string[] = [""];
  wrap(report.summary, Math.max(12, width - headLength)).forEach((segment, index) => {
    lines.push(
      index === 0
        ? `  ${done ? leaf("done") : rust(report.outcome)} · ${paper(segment)}`
        : `${" ".repeat(headLength)}${paper(segment)}`,
    );
  });
  if (report.changedFiles.length > 0) {
    lines.push(`  ${stone("changed")}`);
    for (const file of report.changedFiles) {
      lines.push(`    ${paper(clip(file, Math.max(8, width - 4)))}`);
    }
  }
  if (report.checks.length > 0) {
    lines.push(`  ${stone("checks")}`);
    for (const check of report.checks) {
      lines.push(
        `    ${check.passed ? leaf("[pass]") : rust("[fail]")} ${paper(clip(check.command, Math.max(8, width - 11)))}`,
      );
    }
  }
  if (report.review) {
    const head = report.review.verdict === "clear" ? "clear" : "issues";
    const firstLine = report.review.summary.split("\n")[0] ?? "";
    lines.push(
      `  ${stone("review")} ${head === "clear" ? leaf("clear") : brass("issues")} · ${paper(clip(firstLine, Math.max(8, width - (12 + head.length))))}`,
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

export const stateLine = (to: TaskState): string => {
  const paintFn =
    to === "completed" ? leaf : to === "failed_check" || to === "cancelled" ? rust : brass;
  return `  ${paintFn("→")} ${paper(SHORT[to])}`;
};

export const usageLine = (prompt: number, completion: number): string =>
  `  ${stone("tokens")} ${stone(`${prompt} in / ${completion} out`)}`;

export const resultLine = (
  name: string,
  ok: boolean,
  summary: string,
  width = fitWidth(),
): string | null => {
  if (ok && !summary.toLowerCase().includes("error")) return null;
  const first = summary.split("\n")[0] ?? "";
  return `  ${rust("✕")} ${stone(name)} ${stone(clip(first, Math.max(8, width - (5 + name.length))))}`;
};

export const planCard = (text: string, width = fitWidth()): string => {
  const rule = stone("─".repeat(Math.max(20, Math.min(58, width - 4))));
  const body = text
    .trim()
    .split("\n")
    .map((line) => `  ${paper(clip(line, Math.max(8, width - 2)))}`)
    .join("\n");
  return `\n${rule}\n  ${brass("plan")}\n${body}\n${rule}\n`;
};
