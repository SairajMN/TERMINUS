import type { AttackCategory } from "../redteam/types";

export interface VulnerabilityFinding {
  id: string;
  category: AttackCategory;
  severity: "critical" | "high" | "medium" | "low";
  title: string;
  description: string;
  affectedComponent: string;
  sourceAttackId?: string;
  reproductionSteps: string;
  evidenceRecordId?: string;
}

export interface SkepticDecision {
  hypothesisId: string;
  confirmed: boolean;
  reason: string;
}

export interface RootCauseAnalysis {
  findingId: string;
  underlyingDefect:
    | "policy_gap"
    | "unvalidated_input"
    | "untrusted_injection"
    | "missing_boundary"
    | "dependency_flaw"
    | "auth_misconfiguration";
  rootCauseDescription: string;
  defenseRecommendation: string;
  mustNotWeakenExistingGates: boolean;
}

export interface RemediationPatch {
  id: string;
  findingId: string;
  filesChanged: string[];
  patchDiff: string;
  explanation: string;
  regressionTestCode: string;
}

export interface BlueTeamReport {
  timestamp: number;
  findingsAnalyzed: number;
  skepticRejectedCount?: number;
  skepticDecisions?: SkepticDecision[];
  rootCausesIdentified: number;
  patchesProposed: number;
  patchesApplied: number;
  regressionsPrevented: number;
  remediationSummary: string;
}
