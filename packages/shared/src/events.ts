import type { TaskState } from "./task";

export interface CheckResult {
  name: string;
  command: string;
  passed: boolean;
  output: string;
}

export interface CompletionReport {
  outcome: "completed" | "cancelled" | "failed";
  summary: string;
  changedFiles: string[];
  commands: string[];
  checks: CheckResult[];
  tokens?: { prompt: number; completion: number };
}

export type AgentEvent =
  | { type: "state"; from: TaskState; to: TaskState }
  | { type: "text"; text: string }
  | { type: "plan"; text: string }
  | { type: "tool"; name: string; input: unknown; decision: PermissionNote }
  | { type: "tool_result"; name: string; ok: boolean; summary: string }
  | { type: "approval"; question: string; approved: boolean }
  | { type: "usage"; prompt: number; completion: number }
  | { type: "report"; report: CompletionReport };

export type PermissionNote = {
  verdict: "allow" | "deny" | "ask" | "approved" | "rejected";
  tier: string;
  reason: string;
};

export type Emit = (event: AgentEvent) => void;
