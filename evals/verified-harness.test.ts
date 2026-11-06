import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AgentClaimReport,
  BaseCodingHarness,
  DebuggingHarness,
  EvidenceLedger,
  enforceContractOnAction,
  HarnessEvolutionEngine,
  HarnessRouter,
  MasterOrchestrator,
  SecurityAuditHarness,
  TestingHarness,
  VerificationEngine,
  VerificationStateMachine,
} from "@terminus/agent-runtime";
import { type ModelEvent, mockGateway } from "@terminus/model-gateway";

describe("TERMINUS Verified Multi-Agent Harness Architecture (OO-Harness + Evidence Ledger)", () => {
  it("1. SpecialistAgentContract: deterministically blocks read-only write attempts, out-of-scope edits, and forbidden tools", () => {
    const router = new HarnessRouter();

    // Security agent contract: strictly read-only, no terminal
    const securityContract = router.createContract(SecurityAuditHarness, {
      agentId: "security-1",
      objective: "Audit src/auth",
      scope: ["src/auth/"],
    });

    const writeAttempt = enforceContractOnAction(securityContract, "write_file", {
      kind: "file_write",
      path: "src/auth/login.ts",
    });
    expect(writeAttempt.allowed).toBe(false);
    expect(writeAttempt.reason).toContain("not in allowedTools");

    // Even if a write tool were in allowedTools, filesystem === "read_only" blocks it
    const customReadOnly = {
      ...securityContract,
      allowedTools: [...securityContract.allowedTools, "write_file"],
    };
    const blockedByFs = enforceContractOnAction(customReadOnly, "write_file", {
      kind: "file_write",
      path: "src/auth/login.ts",
    });
    expect(blockedByFs.allowed).toBe(false);
    expect(blockedByFs.reason).toContain("read_only filesystem permission");

    // Scoped write agent contract: can edit src/auth/*, blocked from src/billing/*
    const scopedTester = router.createContract(TestingHarness, {
      agentId: "tester-1",
      objective: "Add auth unit tests",
      scope: ["src/auth/"],
    });

    expect(
      enforceContractOnAction(scopedTester, "write_file", {
        kind: "file_write",
        path: "src/auth/login.test.ts",
      }).allowed,
    ).toBe(true);

    const outOfScope = enforceContractOnAction(scopedTester, "write_file", {
      kind: "file_write",
      path: "src/billing/invoice.ts",
    });
    expect(outOfScope.allowed).toBe(false);
    expect(outOfScope.reason).toContain("outside assigned scope");

    // Terminal test_only restriction: allows `bun test`, blocks arbitrary `curl` or `rm`
    expect(
      enforceContractOnAction(scopedTester, "run_command", {
        kind: "command",
        command: "bun test src/auth/login.test.ts",
      }).allowed,
    ).toBe(true);

    const forbiddenCmd = enforceContractOnAction(scopedTester, "run_command", {
      kind: "command",
      command: "python3 deploy.py",
    });
    expect(forbiddenCmd.allowed).toBe(false);
    expect(forbiddenCmd.reason).toContain("test_only terminal permission");
  });

  it("2. Append-Only Cryptographic EvidenceLedger: mints deterministic IDs and verifies SHA-256 hash chain", () => {
    const ledger = new EvidenceLedger();
    const diff1 = ledger.recordFileDiff("coder-1", "src/auth.ts", "old", "new");
    const hash1 = ledger.recordFileInspection("security-1", "src/auth.ts", "new");
    const test1 = ledger.recordCommandExecution("tester-1", "bun test", 0, "10 pass");
    const build1 = ledger.recordCommandExecution("coder-1", "bun run build", 0, "built");

    expect(diff1.id).toBe("DIFF-001");
    expect(hash1.id).toBe("FILE-HASH-001");
    expect(test1.id).toBe("TEST-RUN-001");
    expect(build1.id).toBe("BUILD-RUN-001");
    expect(ledger.verifyIntegrity().valid).toBe(true);
  });

  it("3. Independent VerificationEngine: falsifies fabricated evidence IDs, failed test claims, missing symbols, and unverified file claims (Zero False Acceptance)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "terminus-vh-verify-"));
    try {
      writeFileSync(join(dir, "auth.ts"), "export function login() { return true; }\n");

      const ledger = new EvidenceLedger();
      // Record a real diff on auth.ts, but a FAILING test run (exitCode 1)
      ledger.recordFileDiff(
        "backend-1",
        "auth.ts",
        "",
        "export function login() { return true; }\n",
      );
      ledger.recordCommandExecution("backend-1", "bun test", 1, "FAIL: 2 tests failed");

      const router = new HarnessRouter();
      const contract = router.createContract(BaseCodingHarness, {
        agentId: "backend-1",
        objective: "Implement login and verify tests",
      });

      // Dishonest agent report claiming:
      // C1: Modified auth.ts (TRUE - backed by DIFF-001)
      // C2: All unit tests passed (FALSE - TEST-RUN-001 actually exited with code 1!)
      // C3: Production build succeeded (FABRICATED ID - BUILD-RUN-999 does not exist in ledger!)
      // C4: Implemented verifyMfaToken symbol in auth.ts (FALSE - symbol not in file!)
      // C5: Security audit passed (UNVERIFIED - empty evidenceIds: [])
      const dishonestReport: AgentClaimReport = {
        taskId: "TASK-ADV-1",
        agentId: "backend-1",
        role: "backend",
        harnessName: "BaseCodingHarness",
        status: "claimed_complete",
        summary: "Refactored auth, all tests passed, production build succeeded.",
        claims: [
          {
            claimId: "C1",
            category: "file_modified",
            description: "Modified auth.ts",
            targetPath: "auth.ts",
            evidenceIds: ["DIFF-001"],
          },
          {
            claimId: "C2",
            category: "tests_passed",
            description: "All unit tests passed",
            evidenceIds: ["TEST-RUN-001"],
          },
          {
            claimId: "C3",
            category: "build_succeeded",
            description: "Production build succeeded",
            evidenceIds: ["BUILD-RUN-999"],
          },
          {
            claimId: "C4",
            category: "symbol_implemented",
            description: "Implemented verifyMfaToken",
            targetPath: "auth.ts",
            symbolName: "verifyMfaToken",
            evidenceIds: ["DIFF-001"],
          },
          {
            claimId: "C5",
            category: "security_clear",
            description: "No vulnerabilities",
            evidenceIds: [],
          },
        ],
        modifiedFiles: ["auth.ts", "nonexistent-fabricated-file.ts"],
        inspectedFiles: ["auth.ts"],
        uninspectedAreas: [],
        unresolvedIssues: [],
        assumptions: [],
        risks: [],
      };

      const engine = new VerificationEngine();
      const verdict = await engine.verifyAll({
        taskId: "TASK-ADV-1",
        task: "Implement login and verify tests",
        workspaceRoot: dir,
        reports: [{ report: dishonestReport, contract, harness: BaseCodingHarness }],
        ledger,
      });

      expect(verdict.overallVerdict).toBe("REJECTED");
      expect(verdict.falseAcceptanceCount).toBe(0);

      const agentVer = verdict.agentVerifications[0];
      expect(agentVer?.verifiedClaims).toBe(1); // Only C1 is true
      expect(agentVer?.falsifiedClaims).toBe(3); // C2, C3, C4 falsified
      expect(agentVer?.unverifiedClaims).toBe(1); // C5 unverified
      expect(agentVer?.unsupportedCompletionClaimRate).toBe(0.8); // 4/5 = 80% unsupported!
      expect(agentVer?.detectedFailureModes).toContain("unverified_file_claim");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("4. Orchestrator VerificationStateMachine: enforces strict state transitions and prevents direct RUNNING -> VERIFIED jumps", () => {
    const sm = new VerificationStateMachine();
    expect(sm.state).toBe("CREATED");
    sm.transition("ASSIGNED");
    sm.transition("RUNNING");

    // Agent or caller cannot jump straight from RUNNING to VERIFIED
    expect(() => sm.transition("VERIFIED")).toThrow("illegal orchestrator state transition");

    sm.transition("CLAIMED_COMPLETE");
    sm.transition("EVIDENCE_COLLECTION");
    sm.transition("VERIFYING");
    sm.transition("REJECTED");
    sm.transition("REWORK");
    sm.transition("RUNNING");
    sm.transition("CLAIMED_COMPLETE");
    sm.transition("EVIDENCE_COLLECTION");
    sm.transition("VERIFYING");
    sm.transition("VERIFIED");
    expect(sm.state).toBe("VERIFIED");
  });

  it("5. OO-Harness Intelligent Task + Trajectory Router: falls back to BaseCodingHarness on simple tasks and adapts to trajectory signals", () => {
    const router = new HarnessRouter();

    // Out-of-distribution / simple request -> BaseCodingHarness fallback (Paper Section 10)
    const simpleDecision = router.route("Update greeting text");
    expect(simpleDecision.strategy).toBe("base_fallback");
    expect(simpleDecision.selectedHarnesses.map((h) => h.name)).toEqual(["BaseCodingHarness"]);

    // Complex multi-domain request -> Multi-specialist deployment
    const complexDecision = router.route(
      "Refactor the authentication service, fix the login bug, audit security vulnerabilities, and add unit tests",
    );
    expect(complexDecision.strategy).toBe("multi_specialist");
    const names = complexDecision.selectedHarnesses.map((h) => h.name);
    expect(names).toContain("DebuggingHarness");
    expect(names).toContain("RefactoringHarness");
    expect(names).toContain("SecurityAuditHarness");
    expect(names).toContain("TestingHarness");

    // Trajectory-aware routing (Paper Section 8): generic prompt + observed failing check & security path in trajectory
    const trajectoryDecision = router.route(
      "Complete the pending changes in the workspace",
      undefined,
      {
        hasFailingChecks: true,
        touchesSecurityPaths: true,
        touchedFiles: ["src/auth/jwt.ts"],
      },
    );
    const trajNames = trajectoryDecision.selectedHarnesses.map((h) => h.name);
    expect(trajNames).toContain("DebuggingHarness");
    expect(trajNames).toContain("SecurityAuditHarness");
  });

  it("6. Self-Evolving Harness Engine: synthesizes DebuggingHarnessV2 from failure telemetry and gates promotion on held-out benchmarks", () => {
    const router = new HarnessRouter();
    const evolution = new HarnessEvolutionEngine();

    // Record repeated failures where DebuggingHarness stopped without running regression tests
    evolution.recordExecution({
      taskId: "T-1",
      harnessName: "DebuggingHarness",
      verdict: "PARTIALLY_VERIFIED",
      failureModes: ["missing_regression_test"],
    });
    evolution.recordExecution({
      taskId: "T-2",
      harnessName: "DebuggingHarness",
      verdict: "REJECTED",
      failureModes: ["missing_regression_test", "missing_build_verification"],
    });

    // Candidate that improves both discovery (61.62 -> 77.41) and held-out (71.87 -> 77.18)
    const promotedProposal = evolution.proposeAndEvaluate(
      DebuggingHarness,
      {
        discoveryScoreBefore: 61.62,
        discoveryScoreAfter: 77.41,
        heldOutScoreBefore: 71.87,
        heldOutScoreAfter: 77.18,
      },
      router,
    );

    expect(promotedProposal.promoted).toBe(true);
    expect(promotedProposal.evolvedHarness.name).toBe("DebuggingHarnessV2");
    expect(promotedProposal.evolvedHarness.parentName).toBe("DebuggingHarness");
    expect(promotedProposal.evolvedHarness.mandatoryVerification.requireTestExecution).toBe(true);
    expect(promotedProposal.evolvedHarness.mandatoryVerification.requireBuildExecution).toBe(true);
    expect(router.getHarness("DebuggingHarnessV2").version).toBe(2);

    // Candidate that overfits discovery but regresses on held-out tasks MUST be rejected
    const rejectedProposal = evolution.proposeAndEvaluate(DebuggingHarness, {
      discoveryScoreBefore: 61.62,
      discoveryScoreAfter: 80.0,
      heldOutScoreBefore: 71.87,
      heldOutScoreAfter: 65.0,
    });
    expect(rejectedProposal.promoted).toBe(false);
  });

  it("7. End-to-End MasterOrchestrator: executes specialist contract, records EvidenceLedger, and certifies VERIFIED with 0% UCCR", async () => {
    const dir = mkdtempSync(join(tmpdir(), "terminus-vh-e2e-"));
    try {
      writeFileSync(join(dir, "math.ts"), "export const add = (a: number, b: number) => a - b;\n");

      const turns: ModelEvent[][] = [
        // Specialist turn 1: edit math.ts to fix bug
        [
          {
            type: "tool_use",
            id: "call-1",
            name: "edit_file",
            input: {
              path: "math.ts",
              old_text: "export const add = (a: number, b: number) => a - b;",
              new_text: "export const add = (a: number, b: number) => a + b;",
            },
          },
        ],
        // Specialist turn 2: finish and report
        [{ type: "text", text: "Fixed addition operator in math.ts." }],
        // Adversarial Verifier pass: confirms claims hold
        [{ type: "text", text: "adversarial_verdict: holds" }],
      ];
      let idx = 0;
      const gw = mockGateway(() => turns[idx++] ?? []);

      const orchestrator = new MasterOrchestrator();
      const result = await orchestrator.orchestrate("Fix bug in math.ts addition function", {
        workspaceRoot: dir,
        gateway: gw,
        approver: async () => ({ approved: true }),
        runAdversarialPass: true,
      });

      expect(result.finalState).toBe("VERIFIED");
      expect(result.verdictReport.overallVerdict).toBe("VERIFIED");
      expect(result.verdictReport.unsupportedCompletionClaimRate).toBe(0);
      expect(result.verdictReport.falseAcceptanceCount).toBe(0);
      expect(result.ledger.verifyIntegrity().valid).toBe(true);
      expect(result.ledger.get("DIFF-001")?.subject).toBe("math.ts");
      expect(readFileSync(join(dir, "math.ts"), "utf8")).toContain("a + b");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
