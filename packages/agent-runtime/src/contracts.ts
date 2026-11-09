import type { Action } from "@terminus/shared";
import { z } from "zod";

export type SpecialistRole =
  | "planner"
  | "repo_analyst"
  | "researcher"
  | "frontend"
  | "backend"
  | "database"
  | "debugger"
  | "tester"
  | "security"
  | "performance"
  | "reviewer"
  | "documentation"
  | "adversarial_verifier";

export const FilesystemPermissionSchema = z.enum(["read_only", "scoped_write", "workspace_write"]);
export type FilesystemPermission = z.infer<typeof FilesystemPermissionSchema>;

export const TerminalPermissionSchema = z.enum(["none", "restricted", "test_only", "full"]);
export type TerminalPermission = z.infer<typeof TerminalPermissionSchema>;

export const SpecialistAgentContractSchema = z.object({
  agentId: z.string().min(1),
  role: z.enum([
    "planner",
    "repo_analyst",
    "researcher",
    "frontend",
    "backend",
    "database",
    "debugger",
    "tester",
    "security",
    "performance",
    "reviewer",
    "documentation",
    "adversarial_verifier",
  ]),
  harnessName: z.string().min(1),
  objective: z.string().min(1),
  /** Allowed relative file/directory prefixes for write operations when filesystem === "scoped_write" */
  scope: z.array(z.string()),
  permissions: z.object({
    filesystem: FilesystemPermissionSchema,
    terminal: TerminalPermissionSchema,
    network: z.boolean(),
  }),
  allowedTools: z.array(z.string()),
  deliverables: z.array(z.string()),
  requirements: z.array(z.string()),
  completionConditions: z.array(z.string()),
  budget: z.object({
    maxIterations: z.number().int().positive(),
    maxTokens: z.number().int().positive().optional(),
  }),
});

export type SpecialistAgentContract = z.infer<typeof SpecialistAgentContractSchema>;

/**
 * Deterministic runtime enforcement of a SpecialistAgentContract on every tool action.
 * Never trusts the LLM to stay within its assigned scope or permission boundary.
 */
export function enforceContractOnAction(
  contract: SpecialistAgentContract,
  toolName: string,
  action: Action | null,
): { allowed: boolean; reason?: string } {
  if (!contract.allowedTools.includes(toolName)) {
    return {
      allowed: false,
      reason: `contract violation: tool "${toolName}" is not in allowedTools for agent "${contract.agentId}" (${contract.role})`,
    };
  }

  if (toolName === "web_research" && !contract.permissions.network) {
    return {
      allowed: false,
      reason: `contract violation: network access is disabled for agent "${contract.agentId}"`,
    };
  }

  if (!action) return { allowed: true };

  if (action.kind === "file_write") {
    if (contract.permissions.filesystem === "read_only") {
      return {
        allowed: false,
        reason: `contract violation: agent "${contract.agentId}" (${contract.role}) has read_only filesystem permission and cannot modify "${action.path}"`,
      };
    }
    if (contract.permissions.filesystem === "scoped_write" && contract.scope.length > 0) {
      const normalized = action.path.replace(/^\.?\//, "");
      const inScope = contract.scope.some((prefix) => {
        const cleanPrefix = prefix.replace(/^\.?\//, "");
        return normalized === cleanPrefix || normalized.startsWith(cleanPrefix);
      });
      if (!inScope) {
        return {
          allowed: false,
          reason: `contract violation: file "${action.path}" is outside assigned scope [${contract.scope.join(", ")}] for agent "${contract.agentId}"`,
        };
      }
    }
  }

  if (action.kind === "command") {
    if (contract.permissions.terminal === "none") {
      return {
        allowed: false,
        reason: `contract violation: terminal execution is disabled for agent "${contract.agentId}" (${contract.role})`,
      };
    }
    if (contract.permissions.terminal === "test_only") {
      const isTestOrCheck =
        /^\s*(npm\s+(test|run\s+(test|typecheck|lint|check|build))|bun\s+(test|run\s+(test|typecheck|lint|check|build))|pytest|cargo\s+(test|check)|go\s+test|tsc\b)/.test(
          action.command,
        );
      if (!isTestOrCheck) {
        return {
          allowed: false,
          reason: `contract violation: agent "${contract.agentId}" has test_only terminal permission and cannot execute "${action.command}"`,
        };
      }
    }
  }

  return { allowed: true };
}

export const ClaimCategorySchema = z.enum([
  "file_modified",
  "symbol_implemented",
  "tests_passed",
  "build_succeeded",
  "security_clear",
  "analysis_complete",
]);
export type ClaimCategory = z.infer<typeof ClaimCategorySchema>;

export const AgentClaimSchema = z.object({
  claimId: z.string().min(1),
  category: ClaimCategorySchema,
  description: z.string().min(1),
  targetPath: z.string().optional(),
  symbolName: z.string().optional(),
  /** IDs referencing records in the orchestrator's trusted EvidenceLedger (e.g. ["DIFF-001", "TEST-RUN-001"]) */
  evidenceIds: z.array(z.string()),
});
export type AgentClaim = z.infer<typeof AgentClaimSchema>;

/**
 * Notice: An agent can only report "claimed_complete", "blocked", or "failed".
 * "VERIFIED" is intentionally excluded from the agent schema — only the Orchestrator's
 * VerificationEngine can assign a VERIFIED verdict.
 */
export const AgentClaimReportSchema = z.object({
  taskId: z.string().min(1),
  agentId: z.string().min(1),
  role: z.string().min(1),
  harnessName: z.string().min(1),
  status: z.enum(["claimed_complete", "blocked", "failed"]),
  summary: z.string(),
  claims: z.array(AgentClaimSchema),
  modifiedFiles: z.array(z.string()),
  inspectedFiles: z.array(z.string()),
  uninspectedAreas: z.array(z.string()),
  unresolvedIssues: z.array(z.string()),
  assumptions: z.array(z.string()),
  risks: z.array(z.string()),
});
export type AgentClaimReport = z.infer<typeof AgentClaimReportSchema>;

export type VerificationVerdict =
  | "VERIFIED"
  | "PARTIALLY_VERIFIED"
  | "UNVERIFIED"
  | "REJECTED"
  | "FAILED"
  | "BLOCKED";

export type OrchestratorTaskState =
  | "CREATED"
  | "ASSIGNED"
  | "RUNNING"
  | "CLAIMED_COMPLETE"
  | "EVIDENCE_COLLECTION"
  | "VERIFYING"
  | "VERIFIED"
  | "PARTIALLY_VERIFIED"
  | "UNVERIFIED"
  | "REJECTED"
  | "REWORK"
  | "FAILED"
  | "BLOCKED";

const ALLOWED_TRANSITIONS: Record<OrchestratorTaskState, readonly OrchestratorTaskState[]> = {
  CREATED: ["ASSIGNED", "FAILED", "BLOCKED"],
  ASSIGNED: ["RUNNING", "FAILED", "BLOCKED"],
  RUNNING: ["CLAIMED_COMPLETE", "FAILED", "BLOCKED"],
  CLAIMED_COMPLETE: ["EVIDENCE_COLLECTION", "FAILED"],
  EVIDENCE_COLLECTION: ["VERIFYING", "UNVERIFIED", "FAILED"],
  VERIFYING: ["VERIFIED", "PARTIALLY_VERIFIED", "UNVERIFIED", "REJECTED", "FAILED", "BLOCKED"],
  PARTIALLY_VERIFIED: ["REWORK", "VERIFIED", "FAILED"],
  UNVERIFIED: ["REWORK", "FAILED"],
  REJECTED: ["REWORK", "FAILED", "BLOCKED"],
  REWORK: ["RUNNING", "FAILED", "BLOCKED"],
  VERIFIED: [],
  FAILED: [],
  BLOCKED: [],
};

/**
 * Deterministic Orchestrator State Machine.
 * Enforces that no task can transition to VERIFIED without passing through
 * CLAIMED_COMPLETE -> EVIDENCE_COLLECTION -> VERIFYING.
 */
export class VerificationStateMachine {
  private current: OrchestratorTaskState = "CREATED";
  private readonly history: {
    from: OrchestratorTaskState;
    to: OrchestratorTaskState;
    at: number;
  }[] = [];

  get state(): OrchestratorTaskState {
    return this.current;
  }

  get transitions(): readonly {
    from: OrchestratorTaskState;
    to: OrchestratorTaskState;
    at: number;
  }[] {
    return this.history;
  }

  transition(next: OrchestratorTaskState): void {
    const allowed = ALLOWED_TRANSITIONS[this.current];
    if (!allowed.includes(next)) {
      throw new Error(
        `illegal orchestrator state transition: ${this.current} -> ${next} (allowed: ${allowed.join(", ") || "none"})`,
      );
    }
    this.history.push({ from: this.current, to: next, at: Date.now() });
    this.current = next;
  }
}
