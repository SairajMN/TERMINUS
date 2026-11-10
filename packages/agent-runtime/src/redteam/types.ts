/**
 * Red Team Attack Categories across Agentic AI Security (OWASP Top 10 Agentic 2026)
 * and Application Security (OWASP Top 10:2025 / ASVS 5.0).
 */
export type AgenticSecurityCategory =
  | "ASI01_GOAL_HIJACK"
  | "ASI02_TOOL_MISUSE"
  | "ASI03_IDENTITY_ABUSE"
  | "ASI04_SUPPLY_CHAIN"
  | "ASI05_CODE_EXEC"
  | "ASI06_MEMORY_POISONING"
  | "ASI07_INTER_AGENT"
  | "ASI08_CASCADING_FAILURE"
  | "ASI09_TRUST_EXPLOITATION"
  | "ASI10_ROGUE_AGENT";

export type ApplicationSecurityCategory =
  | "A01_BROKEN_ACCESS_CONTROL"
  | "A02_SECURITY_MISCONFIGURATION"
  | "A03_SUPPLY_CHAIN_FAILURES"
  | "A04_CRYPTOGRAPHIC_FAILURES"
  | "A05_INJECTION"
  | "A06_INSECURE_DESIGN"
  | "A07_AUTHENTICATION_FAILURES"
  | "A08_INTEGRITY_FAILURES"
  | "A09_LOGGING_FAILURES"
  | "A10_EXCEPTIONAL_CONDITIONS";

export type AttackCategory = AgenticSecurityCategory | ApplicationSecurityCategory;

export type AttackSurface =
  | "filesystem"
  | "terminal"
  | "prompt"
  | "mcp"
  | "context"
  | "inter_agent"
  | "network"
  | "api";

export interface AttackHypothesis {
  id: string;
  category: AttackCategory;
  agentRole: string;
  objective: string;
  threatModel: string;
  targetSurface: AttackSurface;
  payload: string;
  expectedDefensiveControl: string;
  targetEndpoint?: string;
}

export interface HttpTraceSummary {
  url: string;
  method: string;
  status: number;
  indicator: string;
}

export interface AttackExecutionResult {
  hypothesisId: string;
  category: AttackCategory;
  attemptedAt: number;
  payload: string;
  outcome: "blocked" | "exploited" | "error";
  prohibitedEffectAchieved: boolean;
  observedExecutionTrace: string;
  reproductionScript: string;
  evidenceRecordId?: string;
  explanation: string;
  httpTrace?: HttpTraceSummary;
  confidence?: number;
  targetEndpoint?: string;
}

export interface ResolvedVector {
  target: string;
  category: AttackCategory;
  vector: string;
  status: "resolved" | "active";
  reason: string;
  recordedAt: number;
}

export interface RedTeamCampaignReport {
  campaignId: string;
  targetWorkspace: string;
  startedAt: number;
  completedAt: number;
  totalHypothesesTested: number;
  blockedCount: number;
  exploitedCount: number;
  attackSuccessRate: number; // 0.0 to 1.0
  findings: AttackExecutionResult[];
  skippedResolvedVectors?: number;
  dastFindingsCount?: number;
}
