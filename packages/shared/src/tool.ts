import type { z } from "zod";

export type PermissionTier = "read" | "modify" | "high_impact";

export type Mode = "ask" | "plan" | "audit" | "act" | "auto";

export interface ToolContext {
  workspaceRoot: string;
  signal: AbortSignal;
  commandTimeoutMs?: number;
}

export interface ToolResult {
  ok: boolean;
  output: string;
  truncated: boolean;
}

export interface ToolDefinition<Input = unknown> {
  name: string;
  description: string;
  tier: PermissionTier;
  schema: z.ZodType<Input>;
  execute(input: Input, ctx: ToolContext): ToolResult | Promise<ToolResult>;
}

export type Action =
  | { kind: "command"; command: string }
  | { kind: "file_read"; path: string }
  | { kind: "file_write"; path: string };

export interface PermissionDecision {
  action: "allow" | "deny" | "ask";
  tier: PermissionTier;
  reason: string;
}

export interface ApprovalRequest {
  summary: string;
  detail?: string;
  tier: PermissionTier;
}

export type ApprovalOutcome = { approved: boolean; feedback?: string };

export type Approver = (request: ApprovalRequest) => Promise<ApprovalOutcome>;
