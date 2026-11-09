import type { ModelGateway } from "@terminus/model-gateway";
import type { Approver, CompletionReport, Mode } from "@terminus/shared";
import { runTask } from "./run";

export type SubagentRole =
  | "explorer"
  | "architect"
  | "coder"
  | "ui_designer"
  | "security_auditor"
  | "reviewer"
  | "debugger";

export interface SubagentSpec {
  role: SubagentRole;
  description: string;
  mode: Mode;
  maxIterations: number;
  roleDirective: string;
}

export const SUBAGENT_REGISTRY: Record<SubagentRole, SubagentSpec> = {
  explorer: {
    role: "explorer",
    description: "Fast read-only repository explorer and symbol investigator.",
    mode: "ask",
    maxIterations: 12,
    roleDirective:
      "[Subagent: Explorer] Inspect the repository structure, symbols, and relevant files using read-only tools. Produce a concise, factual architecture and file summary.",
  },
  architect: {
    role: "architect",
    description: "Produces implementation plans, file impact matrices, and test strategies.",
    mode: "plan",
    maxIterations: 15,
    roleDirective:
      "[Subagent: Architect] Design a minimal, modular implementation plan with exact file paths, risk analysis, and verification steps.",
  },
  coder: {
    role: "coder",
    description: "Implements minimal-diff code changes and verifies them.",
    mode: "act",
    maxIterations: 40,
    roleDirective:
      "[Subagent: Coder] Implement the requested changes using minimal diffs, resolve any instant static verifier warnings, and verify.",
  },
  ui_designer: {
    role: "ui_designer",
    description:
      "Designs and implements modern, responsive, high-fidelity user interfaces with sorting, filtering, and micro-interactions.",
    mode: "act",
    maxIterations: 45,
    roleDirective:
      "[Subagent: UI/UX Designer] Implement or audit responsive, modern frontend interfaces. Ensure mobile-first responsiveness across all device widths, multi-criteria sorting and filtering, high-fidelity photography/visuals (no generic plain emoji boxes), touch-friendly targets, and synchronized React Context state.",
  },
  security_auditor: {
    role: "security_auditor",
    description: "Audits the codebase against OWASP Top 10 and security boundaries.",
    mode: "audit",
    maxIterations: 15,
    roleDirective:
      "[Subagent: Security Auditor] Audit the repository for injection, access control, secret exposure, cryptographic, and dependency vulnerabilities.",
  },
  reviewer: {
    role: "reviewer",
    description: "Reviews diffs for correctness, regressions, edge cases, and test coverage.",
    mode: "ask",
    maxIterations: 12,
    roleDirective:
      "[Subagent: Code Reviewer] Review recent changes using git_diff and read_file. Identify blockers, majors, and minors.",
  },
  debugger: {
    role: "debugger",
    description: "Diagnoses build/test failures, traces root causes, and applies minimal fixes.",
    mode: "act",
    maxIterations: 25,
    roleDirective:
      "[Subagent: Debugger] Trace the failure to its root cause, apply a targeted fix without disabling tests, and verify.",
  },
};

export interface SubagentTask {
  role: SubagentRole;
  objective: string;
}

export interface SubagentResult {
  role: SubagentRole;
  objective: string;
  report: CompletionReport;
}

export async function runSubagent(
  task: SubagentTask,
  options: {
    workspaceRoot: string;
    gateway: ModelGateway;
    approver: Approver;
    verifyCommands?: string[];
  },
): Promise<SubagentResult> {
  const spec = SUBAGENT_REGISTRY[task.role];
  const fullPrompt = `${spec.roleDirective}\n\nObjective: ${task.objective}`;
  const report = await runTask(fullPrompt, {
    workspaceRoot: options.workspaceRoot,
    gateway: options.gateway,
    approver: options.approver,
    mode: spec.mode,
    maxIterations: spec.maxIterations,
    verifyCommands: spec.mode === "act" ? options.verifyCommands : [],
  });
  return {
    role: task.role,
    objective: task.objective,
    report,
  };
}

/**
 * Runs multiple read-only subagents (`explorer`, `architect`, `security_auditor`, `reviewer`)
 * in parallel and aggregates their findings. Write-capable subagents (`coder`, `debugger`)
 * are serialized to prevent concurrent file mutation conflicts.
 */
export async function runParallelSubagents(
  tasks: SubagentTask[],
  options: {
    workspaceRoot: string;
    gateway: ModelGateway;
    approver: Approver;
    verifyCommands?: string[];
  },
): Promise<SubagentResult[]> {
  const readOnlyTasks = tasks.filter(
    (t) => SUBAGENT_REGISTRY[t.role].mode !== "act" && SUBAGENT_REGISTRY[t.role].mode !== "auto",
  );
  const mutatingTasks = tasks.filter(
    (t) => SUBAGENT_REGISTRY[t.role].mode === "act" || SUBAGENT_REGISTRY[t.role].mode === "auto",
  );

  const readResults = await Promise.all(readOnlyTasks.map((t) => runSubagent(t, options)));
  const mutateResults: SubagentResult[] = [];
  for (const mTask of mutatingTasks) {
    mutateResults.push(await runSubagent(mTask, options));
  }
  return [...readResults, ...mutateResults];
}
