import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BlueTeamEngine,
  EvidenceLedger,
  MasterOrchestrator,
  RedTeamEngine,
} from "@terminus/agent-runtime";
import { type ModelEvent, mockGateway } from "@terminus/model-gateway";
import { PermissionEngine } from "@terminus/permission-engine";

describe("TERMINUS Red Team ↔ Blue Team Autonomous Feedback Loop", () => {
  it("1. RedTeamEngine: executes 12 attack hypotheses across Agentic (ASI01-10) and AppSec (A01-10) surfaces", async () => {
    const dir = mkdtempSync(join(tmpdir(), "terminus-redteam-"));
    try {
      const redTeam = new RedTeamEngine(dir);
      const permEngine = new PermissionEngine({ workspaceRoot: dir, mode: "act" });
      const ledger = new EvidenceLedger();

      const report = await redTeam.runCampaign(permEngine, ledger);

      expect(report.totalHypothesesTested).toBeGreaterThanOrEqual(12);
      expect(report.blockedCount).toBeGreaterThan(0);
      expect(report.findings.length).toBe(report.totalHypothesesTested);
      expect(ledger.all().length).toBe(report.totalHypothesesTested);
      expect(ledger.verifyIntegrity().valid).toBe(true);

      // Verify every attack result produces a reproducible shell script
      for (const finding of report.findings) {
        expect(finding.reproductionScript).toContain("PAYLOAD=");
        expect(finding.explanation).toBeDefined();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("2. BlueTeamEngine: triages exploited attacks, generates root-cause analysis and synthesis regression tests", () => {
    const dir = mkdtempSync(join(tmpdir(), "terminus-blueteam-"));
    try {
      const blueTeam = new BlueTeamEngine(dir);
      const ledger = new EvidenceLedger();

      // Simulate a confirmed Red Team finding
      const simulatedFindings = [
        {
          hypothesisId: "HYP-1-ASI02",
          category: "ASI02_TOOL_MISUSE" as const,
          attemptedAt: Date.now(),
          payload: "../../etc/passwd",
          outcome: "exploited" as const,
          prohibitedEffectAchieved: true,
          observedExecutionTrace: "Allowed path traversal",
          reproductionScript: "PAYLOAD='../../etc/passwd'",
          explanation: "Path traversal vulnerability exposed",
        },
      ];

      const report = blueTeam.remediate(simulatedFindings, ledger);

      expect(report.findingsAnalyzed).toBe(1);
      expect(report.patchesApplied).toBe(1);
      expect(report.regressionsPrevented).toBe(1);
      expect(ledger.byKind("STATIC_VERIFY").length).toBe(1);
      expect(ledger.verifyIntegrity().valid).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("3. MasterOrchestrator End-to-End: automatically runs Red Team attack campaign and reports results in OrchestrationResult", async () => {
    const dir = mkdtempSync(join(tmpdir(), "terminus-orch-redblue-"));
    try {
      writeFileSync(
        join(dir, "app.ts"),
        "export const greet = (name: string) => 'Hello ' + name;\n",
      );

      const turns: ModelEvent[][] = [
        [{ type: "text", text: "Task analyzed and verified." }],
        [{ type: "text", text: "adversarial_verdict: holds" }],
      ];
      let idx = 0;
      const gw = mockGateway(() => turns[idx++] ?? []);

      const orchestrator = new MasterOrchestrator();
      const result = await orchestrator.orchestrate("Verify greet module", {
        workspaceRoot: dir,
        gateway: gw,
        approver: async () => ({ approved: true }),
        runAdversarialPass: true,
        runRedTeamPass: true,
      });

      expect(result.redTeamReport).toBeDefined();
      expect(result.redTeamReport?.totalHypothesesTested).toBeGreaterThanOrEqual(12);
      expect(result.redTeamReport?.blockedCount).toBeGreaterThan(0);
      expect(result.ledger.verifyIntegrity().valid).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
