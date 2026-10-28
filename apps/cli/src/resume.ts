import { type ContextCapsule, serializeCapsule } from "@terminus/context-engine";
import type { SessionStore } from "@terminus/session-store";
import type { CompletionReport } from "@terminus/shared";

export interface ResumeResult {
  context?: string;
  capsule?: string;
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

  let capsuleStr: string | undefined;
  if (report) {
    const capsule: ContextCapsule = {
      goal: session.task.slice(0, 40),
      topic: "Codebase modification",
      entities: report.changedFiles.slice(0, 5),
      instructions: "Resume earlier work and verify changes",
      constraints: ["workspace-only", "re-verify"],
      summary: report.summary.slice(0, 80),
      verification: {
        passed: report.checks.filter((c) => c.passed).map((c) => c.command),
        failed: report.checks.filter((c) => !c.passed).map((c) => c.command),
      },
    };
    capsuleStr = serializeCapsule(capsule);
  }

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
    capsuleStr,
  ].filter((line): line is string => line !== undefined);
  return { context: lines.join("\n"), capsule: capsuleStr };
};
