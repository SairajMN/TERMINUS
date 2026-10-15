import type { SessionStore } from "@terminus/session-store";
import type { CompletionReport } from "@terminus/shared";

export interface ResumeResult {
  context?: string;
  error?: string;
}

const isReport = (payload: unknown): payload is CompletionReport =>
  typeof payload === "object" && payload !== null && "outcome" in payload && "summary" in payload;

/** Build an honest context note from a stored session; never fabricates state we did not persist. */
export const buildPriorContext = (store: SessionStore, id: string): ResumeResult => {
  const session = store.sessionById(id);
  if (!session) return { error: `no session matches id "${id}"` };
  const report = store
    .eventsOf(session.id)
    .map((event) => {
      try {
        return JSON.parse(event.payload) as unknown;
      } catch {
        return undefined;
      }
    })
    .filter(isReport)
    .at(-1);
  const lines = [
    "Earlier session in this workspace — build on it, do not redo it:",
    `task: ${session.task}`,
    report ? `outcome: ${report.outcome}` : undefined,
    report ? `summary: ${report.summary}` : undefined,
    report && report.changedFiles.length > 0
      ? `files it changed: ${report.changedFiles.join(", ")}`
      : undefined,
    report && report.checks.length > 0
      ? `checks: ${report.checks.map((c) => `${c.command} -> ${c.passed ? "pass" : "fail"}`).join("; ")}`
      : undefined,
  ].filter((line): line is string => line !== undefined);
  return { context: lines.join("\n") };
};
