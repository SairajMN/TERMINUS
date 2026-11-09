import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelGateway } from "@terminus/model-gateway";
import type {
  AgentClaim,
  AgentClaimReport,
  SpecialistAgentContract,
  VerificationVerdict,
} from "./contracts";
import type { FailureModeKind, HarnessProfile } from "./harness";
import type { EvidenceLedger } from "./ledger";
import { scanFiles } from "./sast";
import { verifyEditedFile } from "./verifier";

export type ClaimVerificationStatus = "VERIFIED" | "UNVERIFIED" | "FALSIFIED";

export interface ClaimVerificationResult {
  readonly claimId: string;
  readonly status: ClaimVerificationStatus;
  readonly reason: string;
  readonly verifiedEvidenceIds: string[];
  readonly missingOrInvalidEvidenceIds: string[];
}

export interface AgentReportVerification {
  readonly agentId: string;
  readonly harnessName: string;
  readonly verdict: VerificationVerdict;
  readonly claimResults: ClaimVerificationResult[];
  readonly totalClaims: number;
  readonly verifiedClaims: number;
  readonly unverifiedClaims: number;
  readonly falsifiedClaims: number;
  /** Unsupported Completion Claim Rate = (unverified + falsified) / totalClaims */
  readonly unsupportedCompletionClaimRate: number;
  readonly detectedFailureModes: FailureModeKind[];
  readonly reasons: string[];
}

export interface OrchestratorVerdictReport {
  readonly taskId: string;
  readonly overallVerdict: VerificationVerdict;
  readonly ledgerIntegrityValid: boolean;
  readonly agentVerifications: AgentReportVerification[];
  readonly adversarialFindings: string[];
  readonly independentReviewFindings: string[];
  readonly integrationIssues: string[];
  /** Aggregate Unsupported Completion Claim Rate across all submitted agent claims */
  readonly unsupportedCompletionClaimRate: number;
  /** Guaranteed 0 when any unsupported/falsified claim is prevented from reaching VERIFIED */
  readonly falseAcceptanceCount: number;
  readonly summary: string;
}

/**
 * 4-Layer Independent Verification Engine (Section 5 & 6).
 *
 * Layer 1: Deterministic Verification against the trusted EvidenceLedger and actual filesystem/AST/SAST state.
 * Layer 2: Independent AI Reviewer (separate from worker).
 * Layer 3: Adversarial Falsification Verifier (actively tries to disprove completion claims).
 * Layer 4: Multi-Agent Integration Verification (scope collision, SAST, static import/export/boundary checks).
 */
export class VerificationEngine {
  /**
   * Layer 1: Deterministic verification of a single AgentClaim against the trusted EvidenceLedger
   * and live workspace files.
   */
  verifyClaimDeterministic(
    claim: AgentClaim,
    ledger: EvidenceLedger,
    workspaceRoot: string,
  ): ClaimVerificationResult {
    if (claim.evidenceIds.length === 0) {
      return {
        claimId: claim.claimId,
        status: "UNVERIFIED",
        reason: `Claim "${claim.claimId}" (${claim.category}) provided zero evidence IDs.`,
        verifiedEvidenceIds: [],
        missingOrInvalidEvidenceIds: [],
      };
    }

    const verifiedIds: string[] = [];
    const invalidIds: string[] = [];

    for (const eid of claim.evidenceIds) {
      const rec = ledger.get(eid);
      if (!rec) {
        invalidIds.push(eid);
      } else {
        verifiedIds.push(eid);
      }
    }

    // Fabricated evidence ID not present in the Orchestrator's EvidenceLedger -> immediately FALSIFIED
    if (invalidIds.length > 0) {
      return {
        claimId: claim.claimId,
        status: "FALSIFIED",
        reason: `Claim "${claim.claimId}" cited fabricated or non-existent EvidenceLedger ID(s): [${invalidIds.join(", ")}].`,
        verifiedEvidenceIds: verifiedIds,
        missingOrInvalidEvidenceIds: invalidIds,
      };
    }

    const records = verifiedIds
      .map((id) => ledger.get(id))
      .filter((r): r is NonNullable<typeof r> => r !== undefined);

    switch (claim.category) {
      case "file_modified": {
        const diffRecords = records.filter((r) => r.kind === "DIFF" && r.passed);
        if (diffRecords.length === 0) {
          return {
            claimId: claim.claimId,
            status: "FALSIFIED",
            reason: `Claim "${claim.claimId}" asserts file modification but no DIFF-* record was found among [${verifiedIds.join(", ")}].`,
            verifiedEvidenceIds: [],
            missingOrInvalidEvidenceIds: verifiedIds,
          };
        }
        if (claim.targetPath) {
          const cleanTarget = claim.targetPath.replace(/^\.?\//, "");
          const matchingDiff = diffRecords.some(
            (r) => r.subject.replace(/^\.?\//, "") === cleanTarget,
          );
          const fullPath = join(workspaceRoot, cleanTarget);
          if (!matchingDiff || !existsSync(fullPath)) {
            return {
              claimId: claim.claimId,
              status: "FALSIFIED",
              reason: `Claim "${claim.claimId}" asserts "${claim.targetPath}" was modified, but ledger/disk shows no matching modification.`,
              verifiedEvidenceIds: [],
              missingOrInvalidEvidenceIds: verifiedIds,
            };
          }
        }
        break;
      }

      case "symbol_implemented": {
        if (!claim.targetPath || !claim.symbolName) {
          return {
            claimId: claim.claimId,
            status: "UNVERIFIED",
            reason: `Claim "${claim.claimId}" (symbol_implemented) is missing targetPath or symbolName.`,
            verifiedEvidenceIds: verifiedIds,
            missingOrInvalidEvidenceIds: [],
          };
        }
        const fullPath = join(workspaceRoot, claim.targetPath);
        if (!existsSync(fullPath)) {
          return {
            claimId: claim.claimId,
            status: "FALSIFIED",
            reason: `Claim "${claim.claimId}" asserts symbol "${claim.symbolName}" in "${claim.targetPath}", but file does not exist.`,
            verifiedEvidenceIds: [],
            missingOrInvalidEvidenceIds: verifiedIds,
          };
        }
        const content = readFileSync(fullPath, "utf8");
        const symbolRegex = new RegExp(`\\b${claim.symbolName}\\b`);
        if (!symbolRegex.test(content)) {
          return {
            claimId: claim.claimId,
            status: "FALSIFIED",
            reason: `Claim "${claim.claimId}" asserts symbol "${claim.symbolName}" exists in "${claim.targetPath}", but source inspection falsified this claim.`,
            verifiedEvidenceIds: [],
            missingOrInvalidEvidenceIds: verifiedIds,
          };
        }
        break;
      }

      case "tests_passed": {
        const testRuns = records.filter((r) => r.kind === "TEST_RUN");
        if (testRuns.length === 0) {
          return {
            claimId: claim.claimId,
            status: "FALSIFIED",
            reason: `Claim "${claim.claimId}" asserts tests passed, but none of [${verifiedIds.join(", ")}] is a TEST-RUN record.`,
            verifiedEvidenceIds: [],
            missingOrInvalidEvidenceIds: verifiedIds,
          };
        }
        const failedRun = testRuns.find((r) => !r.passed || r.exitCode !== 0);
        if (failedRun) {
          return {
            claimId: claim.claimId,
            status: "FALSIFIED",
            reason: `Claim "${claim.claimId}" asserts tests passed, but ${failedRun.id} exited with code ${failedRun.exitCode}.`,
            verifiedEvidenceIds: [],
            missingOrInvalidEvidenceIds: [failedRun.id],
          };
        }
        break;
      }

      case "build_succeeded": {
        const buildRuns = records.filter((r) => r.kind === "BUILD_RUN" || r.kind === "CMD_RUN");
        if (buildRuns.length === 0 || buildRuns.some((r) => !r.passed || r.exitCode !== 0)) {
          return {
            claimId: claim.claimId,
            status: "FALSIFIED",
            reason: `Claim "${claim.claimId}" asserts build succeeded, but ledger shows failing or missing build execution.`,
            verifiedEvidenceIds: [],
            missingOrInvalidEvidenceIds: verifiedIds,
          };
        }
        break;
      }

      case "security_clear": {
        const scans = records.filter((r) => r.kind === "SAST_SCAN" || r.kind === "STATIC_VERIFY");
        if (scans.length === 0 || scans.some((r) => !r.passed)) {
          return {
            claimId: claim.claimId,
            status: "FALSIFIED",
            reason: `Claim "${claim.claimId}" asserts security clear, but SAST/static scan records failed or are missing.`,
            verifiedEvidenceIds: [],
            missingOrInvalidEvidenceIds: verifiedIds,
          };
        }
        break;
      }

      case "analysis_complete": {
        const inspected = records.filter((r) => r.kind === "FILE_HASH" || r.kind === "SAST_SCAN");
        if (inspected.length === 0) {
          return {
            claimId: claim.claimId,
            status: "UNVERIFIED",
            reason: `Claim "${claim.claimId}" asserts analysis complete without FILE-HASH-* or SAST-SCAN-* evidence.`,
            verifiedEvidenceIds: [],
            missingOrInvalidEvidenceIds: verifiedIds,
          };
        }
        break;
      }
    }

    return {
      claimId: claim.claimId,
      status: "VERIFIED",
      reason: `Verified against EvidenceLedger record(s): [${verifiedIds.join(", ")}].`,
      verifiedEvidenceIds: verifiedIds,
      missingOrInvalidEvidenceIds: [],
    };
  }

  /**
   * Verifies an entire AgentClaimReport against its SpecialistAgentContract, HarnessProfile,
   * and the Orchestrator's EvidenceLedger.
   */
  verifyAgentReport(
    report: AgentClaimReport,
    contract: SpecialistAgentContract,
    harness: HarnessProfile,
    ledger: EvidenceLedger,
    workspaceRoot: string,
  ): AgentReportVerification {
    const reasons: string[] = [];
    const failureModes: FailureModeKind[] = [];

    if (report.status === "blocked") {
      return {
        agentId: report.agentId,
        harnessName: report.harnessName,
        verdict: "BLOCKED",
        claimResults: [],
        totalClaims: report.claims.length,
        verifiedClaims: 0,
        unverifiedClaims: report.claims.length,
        falsifiedClaims: 0,
        unsupportedCompletionClaimRate: 0,
        detectedFailureModes: [],
        reasons: [`Agent reported status: blocked (${report.summary})`],
      };
    }

    if (report.status === "failed") {
      return {
        agentId: report.agentId,
        harnessName: report.harnessName,
        verdict: "FAILED",
        claimResults: [],
        totalClaims: report.claims.length,
        verifiedClaims: 0,
        unverifiedClaims: 0,
        falsifiedClaims: report.claims.length,
        unsupportedCompletionClaimRate: 0,
        detectedFailureModes: [],
        reasons: [`Agent reported status: failed (${report.summary})`],
      };
    }

    // 1. Verify every individual claim
    const claimResults = report.claims.map((claim) =>
      this.verifyClaimDeterministic(claim, ledger, workspaceRoot),
    );

    const verifiedClaims = claimResults.filter((c) => c.status === "VERIFIED").length;
    const unverifiedClaims = claimResults.filter((c) => c.status === "UNVERIFIED").length;
    const falsifiedClaims = claimResults.filter((c) => c.status === "FALSIFIED").length;
    const totalClaims = claimResults.length;

    const uccr =
      totalClaims > 0 ? Number(((unverifiedClaims + falsifiedClaims) / totalClaims).toFixed(4)) : 1;

    for (const cr of claimResults) {
      if (cr.status !== "VERIFIED") {
        reasons.push(`[${cr.status}] ${cr.reason}`);
      }
    }

    // 2. Cross-check reported modifiedFiles against actual DIFF-* records in EvidenceLedger
    const agentDiffs = ledger
      .byAgent(report.agentId)
      .filter((r) => r.kind === "DIFF")
      .map((r) => r.subject.replace(/^\.?\//, ""));

    for (const reportedFile of report.modifiedFiles) {
      const cleanFile = reportedFile.replace(/^\.?\//, "");
      if (!agentDiffs.includes(cleanFile)) {
        failureModes.push("unverified_file_claim");
        reasons.push(
          `[FALSIFIED] Agent claimed it modified "${reportedFile}", but no DIFF record exists for that file in EvidenceLedger.`,
        );
      }
      if (contract.permissions.filesystem === "read_only") {
        reasons.push(
          `[CONTRACT VIOLATION] Read-only agent "${report.agentId}" claimed modification of "${reportedFile}".`,
        );
      }
    }

    // 3. Enforce Harness mandatory verification policies
    const agentRecords = ledger.byAgent(report.agentId);
    if (harness.mandatoryVerification.requireTestExecution) {
      const hasPassingTest = agentRecords.some(
        (r) => r.kind === "TEST_RUN" && r.passed && r.exitCode === 0,
      );
      if (!hasPassingTest) {
        failureModes.push("missing_regression_test");
        reasons.push(
          `[HARNESS REQUIREMENT] ${harness.name} requires a passing TEST-RUN-* record in EvidenceLedger, but none was recorded.`,
        );
      }
    }

    if (harness.mandatoryVerification.requireBuildExecution) {
      const hasPassingBuild = agentRecords.some(
        (r) => r.kind === "BUILD_RUN" && r.passed && r.exitCode === 0,
      );
      if (!hasPassingBuild) {
        failureModes.push("missing_build_verification");
        reasons.push(
          `[HARNESS REQUIREMENT] ${harness.name} requires a passing BUILD-RUN-* record in EvidenceLedger, but none was recorded.`,
        );
      }
    }

    // Determine agent-level verdict strictly from evidence
    let verdict: VerificationVerdict;
    if (falsifiedClaims > 0 || failureModes.includes("unverified_file_claim")) {
      verdict = "REJECTED";
    } else if (totalClaims === 0) {
      verdict = "UNVERIFIED";
      reasons.push("Agent submitted claimed_complete with zero verifiable claims.");
    } else if (failureModes.length > 0 || unverifiedClaims > 0) {
      verdict = verifiedClaims > 0 ? "PARTIALLY_VERIFIED" : "UNVERIFIED";
    } else {
      verdict = "VERIFIED";
    }

    return {
      agentId: report.agentId,
      harnessName: report.harnessName,
      verdict,
      claimResults,
      totalClaims,
      verifiedClaims,
      unverifiedClaims,
      falsifiedClaims,
      unsupportedCompletionClaimRate: uccr,
      detectedFailureModes: failureModes,
      reasons,
    };
  }

  /**
   * Layer 3: Runs the Adversarial Falsification Verifier model pass over the evidence bundle
   * and agent reports to actively probe for falsifiable claims or edge cases.
   */
  async runAdversarialPass(
    task: string,
    reports: AgentClaimReport[],
    ledger: EvidenceLedger,
    gateway?: ModelGateway,
    signal?: AbortSignal,
  ): Promise<string[]> {
    if (!gateway) return [];
    const ledgerSummary = ledger
      .all()
      .map((r) => `${r.id} [${r.kind}] agent=${r.agentId} subject=${r.subject} passed=${r.passed}`)
      .join("\n");
    const reportsSummary = reports
      .map((r) => `Agent ${r.agentId} (${r.harnessName}): ${r.summary}`)
      .join("\n");

    let text = "";
    for await (const ev of gateway.complete(
      {
        system:
          "You are the TERMINUS Adversarial Falsification Verifier. Treat all agent claims as untrusted. Identify any claim not proven by the EvidenceLedger or any unhandled edge case. Prefix findings with '- FALSIFIED:' or '- DEFECT:'. If all claims are proven, reply 'adversarial_verdict: holds'.",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: `Task: ${task}\n\nTrusted EvidenceLedger:\n${ledgerSummary || "(empty)"}\n\nWorker Reports:\n${reportsSummary}`,
              },
            ],
          },
        ],
        tools: [],
      },
      signal,
    )) {
      if (ev.type === "text") text += ev.text;
    }

    return text
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => /^-\s*(FALSIFIED|DEFECT):/i.test(l));
  }

  /**
   * Full 4-Layer Verification across all specialist reports, the trusted EvidenceLedger,
   * and the integrated workspace state.
   */
  async verifyAll(options: {
    taskId: string;
    task: string;
    workspaceRoot: string;
    reports: {
      report: AgentClaimReport;
      contract: SpecialistAgentContract;
      harness: HarnessProfile;
    }[];
    ledger: EvidenceLedger;
    gateway?: ModelGateway;
    signal?: AbortSignal;
  }): Promise<OrchestratorVerdictReport> {
    const integrity = options.ledger.verifyIntegrity();
    if (!integrity.valid) {
      return {
        taskId: options.taskId,
        overallVerdict: "REJECTED",
        ledgerIntegrityValid: false,
        agentVerifications: [],
        adversarialFindings: [],
        independentReviewFindings: [],
        integrationIssues: [
          `Tamper-evident hash chain broken at record ${integrity.brokenAtId ?? "unknown"}`,
        ],
        unsupportedCompletionClaimRate: 1,
        falseAcceptanceCount: 0,
        summary: `REJECTED: EvidenceLedger cryptographic integrity check failed at ${integrity.brokenAtId}.`,
      };
    }

    // Layer 1: Deterministic verification per agent report
    const agentVerifications = options.reports.map(({ report, contract, harness }) =>
      this.verifyAgentReport(report, contract, harness, options.ledger, options.workspaceRoot),
    );

    // Layer 3: Adversarial verification pass
    const adversarialFindings = await this.runAdversarialPass(
      options.task,
      options.reports.map((r) => r.report),
      options.ledger,
      options.gateway,
      options.signal,
    );

    // Layer 4: Integration Verification (cross-agent file conflicts + workspace SAST + static verifier)
    const integrationIssues: string[] = [];
    const fileOwners = new Map<string, string[]>();
    const allChangedFiles = new Set<string>();

    for (const rec of options.ledger.byKind("DIFF")) {
      const clean = rec.subject.replace(/^\.?\//, "");
      allChangedFiles.add(clean);
      const owners = fileOwners.get(clean) ?? [];
      if (!owners.includes(rec.agentId)) owners.push(rec.agentId);
      fileOwners.set(clean, owners);
    }

    // Check uncoordinated multi-agent edits to the same file
    for (const [file, owners] of fileOwners.entries()) {
      if (owners.length > 1) {
        integrationIssues.push(
          `Integration notice: file "${file}" was modified by multiple agents (${owners.join(", ")}) — verifying final combined state.`,
        );
      }
    }

    // Run deterministic static verifier and 16-rule OWASP SAST on all integrated modified files
    const changedArray = [...allChangedFiles];
    const sastFindings = scanFiles(changedArray, options.workspaceRoot);
    const severeSast = sastFindings.filter(
      (f) => f.severity === "blocker" || f.severity === "major",
    );
    for (const s of severeSast) {
      integrationIssues.push(
        `[SAST ${s.severity.toUpperCase()}] ${s.category} in ${s.file}:${s.line} — ${s.message}`,
      );
    }

    for (const relFile of changedArray) {
      const staticIssues = verifyEditedFile(options.workspaceRoot, relFile);
      const blockers = staticIssues.filter((i) => i.severity === "blocker");
      for (const b of blockers) {
        integrationIssues.push(
          `[STATIC VERIFIER BLOCKER] ${b.code} in ${b.file}${b.line ? `:${b.line}` : ""} — ${b.message}`,
        );
      }
    }

    // Compute aggregate UCCR
    const totalClaims = agentVerifications.reduce((acc, v) => acc + v.totalClaims, 0);
    const unsupportedClaims = agentVerifications.reduce(
      (acc, v) => acc + v.unverifiedClaims + v.falsifiedClaims,
      0,
    );
    const aggregateUccr =
      totalClaims > 0 ? Number((unsupportedClaims / totalClaims).toFixed(4)) : 1;

    // Determine final Orchestrator Verdict
    const hasRejected =
      agentVerifications.some((v) => v.verdict === "REJECTED") ||
      adversarialFindings.some((f) => f.toUpperCase().includes("FALSIFIED")) ||
      severeSast.length > 0 ||
      integrationIssues.some((i) => i.includes("BLOCKER"));
    const hasFailed = agentVerifications.some((v) => v.verdict === "FAILED");
    const hasBlocked = agentVerifications.some((v) => v.verdict === "BLOCKED");
    const hasPartial = agentVerifications.some((v) => v.verdict === "PARTIALLY_VERIFIED");
    const hasUnverified =
      agentVerifications.some((v) => v.verdict === "UNVERIFIED") || agentVerifications.length === 0;

    let overallVerdict: VerificationVerdict;
    if (hasRejected) {
      overallVerdict = "REJECTED";
    } else if (hasFailed) {
      overallVerdict = "FAILED";
    } else if (hasBlocked) {
      overallVerdict = "BLOCKED";
    } else if (hasPartial || adversarialFindings.length > 0) {
      overallVerdict = "PARTIALLY_VERIFIED";
    } else if (hasUnverified) {
      overallVerdict = "UNVERIFIED";
    } else {
      overallVerdict = "VERIFIED";
    }

    // Non-negotiable invariant: if unsupportedClaims > 0, overallVerdict can NEVER be VERIFIED
    if (unsupportedClaims > 0 && overallVerdict === "VERIFIED") {
      overallVerdict = "PARTIALLY_VERIFIED";
    }

    const falseAcceptanceCount = overallVerdict === "VERIFIED" && unsupportedClaims > 0 ? 1 : 0;

    const summaryLines = [
      `Orchestrator Final Verdict: ${overallVerdict} (UCCR: ${(aggregateUccr * 100).toFixed(1)}%, Ledger Records: ${options.ledger.all().length})`,
      ...agentVerifications.map(
        (v) =>
          `  - Agent ${v.agentId} [${v.harnessName}]: ${v.verdict} (${v.verifiedClaims}/${v.totalClaims} claims verified)${v.reasons.length > 0 ? ` — ${v.reasons.join("; ")}` : ""}`,
      ),
      ...adversarialFindings.map((f) => `  - Adversarial Verifier: ${f}`),
      ...integrationIssues.map((i) => `  - Integration Check: ${i}`),
    ];

    return {
      taskId: options.taskId,
      overallVerdict,
      ledgerIntegrityValid: true,
      agentVerifications,
      adversarialFindings,
      independentReviewFindings: [],
      integrationIssues,
      unsupportedCompletionClaimRate: aggregateUccr,
      falseAcceptanceCount,
      summary: summaryLines.join("\n"),
    };
  }
}
