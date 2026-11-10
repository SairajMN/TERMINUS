import { describe, expect, it } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  analyzeJwtToken,
  assertLoopbackTarget,
  BlueTeamEngine,
  EvidenceLedger,
  FindingWorldState,
  LoopbackDastProber,
  MasterOrchestrator,
  RedTeamEngine,
  ReflectionEngine,
} from "@terminus/agent-runtime";
import { SkillRegistryManager } from "@terminus/context-engine";
import { type ModelEvent, mockGateway } from "@terminus/model-gateway";
import { PermissionEngine } from "@terminus/permission-engine";
import { TargetConcurrencyLimiter } from "@terminus/tool-runtime";

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
      expect(result.reflection).toBeDefined();
      expect(result.ledger.verifyIntegrity().valid).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("4. LoopbackDastProber & TargetConcurrencyLimiter: detects XSS/SSTI/SQLi/weak-JWT on localhost and fails closed on non-loopback targets", async () => {
    expect(() => assertLoopbackTarget("https://example.com")).toThrow();
    expect(() => assertLoopbackTarget("http://10.0.0.5:8080")).toThrow();

    // Create weak HS256 JWT (no exp, signed with "secret")
    const h = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
    const p = Buffer.from(JSON.stringify({ sub: "user-1" })).toString("base64url");
    const s = createHmac("sha256", "secret").update(`${h}.${p}`).digest("base64url");
    const weakJwt = `${h}.${p}.${s}`;
    const jwtFindings = analyzeJwtToken(weakJwt);
    expect(jwtFindings.some((w) => w.severity === "critical")).toBe(true);

    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const url = new URL(req.url);
        const q = url.searchParams.get("q") ?? "";
        if (url.pathname === "/search") {
          return new Response(`<html><body>Search: ${q}</body></html>`, {
            headers: { "content-type": "text/html" },
          });
        }
        if (url.pathname === "/tpl" && q.includes("7919*6841")) {
          return new Response("Result: 54173879", { headers: { "content-type": "text/plain" } });
        }
        if (url.pathname === "/user" && q.includes("'")) {
          return new Response('SQLITE_ERROR: near "\'": syntax error', { status: 500 });
        }
        return new Response("OK");
      },
    });

    try {
      const baseUrl = `http://127.0.0.1:${server.port}`;
      const prober = new LoopbackDastProber();
      const ledger = new EvidenceLedger();

      const results = await prober.runEndpointSweep(
        baseUrl,
        [
          { path: "/search", param: "q" },
          { path: "/tpl", param: "q" },
          { path: "/user", param: "q", jwtToken: weakJwt },
        ],
        ledger,
      );

      expect(results.some((r) => r.outcome === "exploited" && r.explanation.includes("XSS"))).toBe(
        true,
      );
      expect(results.some((r) => r.outcome === "exploited" && r.explanation.includes("SSTI"))).toBe(
        true,
      );
      expect(results.some((r) => r.outcome === "exploited" && r.explanation.includes("SQLi"))).toBe(
        true,
      );
      expect(
        results.some(
          (r) => r.outcome === "exploited" && r.category === "A07_AUTHENTICATION_FAILURES",
        ),
      ).toBe(true);
      expect(ledger.verifyIntegrity().valid).toBe(true);

      // Concurrency cap enforcement test
      const limiter = new TargetConcurrencyLimiter(2);
      let peak = 0;
      let active = 0;
      await Promise.all(
        Array.from({ length: 6 }, () =>
          limiter.run("127.0.0.1:test", async () => {
            active++;
            if (active > peak) peak = active;
            await Bun.sleep(10);
            active--;
          }),
        ),
      );
      expect(peak).toBeLessThanOrEqual(2);
    } finally {
      server.stop(true);
    }
  });

  it("5. FindingWorldState, False-Positive Skeptic & ReflectionEngine: deduplicates dead ends, rejects unbacked noise, and emits quarantined skills", async () => {
    const dir = mkdtempSync(join(tmpdir(), "terminus-skeptic-"));
    try {
      const world = new FindingWorldState();
      const redTeam = new RedTeamEngine(dir);
      const perm = new PermissionEngine({ workspaceRoot: dir, mode: "act" });

      const firstRun = await redTeam.runCampaign(perm, undefined, { worldState: world });
      expect(firstRun.skippedResolvedVectors).toBe(0);
      expect(world.getResolvedVectors().length).toBeGreaterThan(0);

      const secondRun = await redTeam.runCampaign(perm, undefined, { worldState: world });
      expect(secondRun.skippedResolvedVectors).toBeGreaterThan(0);
      expect(secondRun.totalHypothesesTested).toBe(0);

      // Skeptic gate rejects noisy / mitigated claims while passing valid trace
      const blueTeam = new BlueTeamEngine(dir);
      const mixed = [
        {
          hypothesisId: "FP-ESCAPED",
          category: "A05_INJECTION" as const,
          attemptedAt: Date.now(),
          payload: "<tag>",
          outcome: "exploited" as const,
          prohibitedEffectAchieved: true,
          observedExecutionTrace: "Payload reflected safely HTML-escaped",
          reproductionScript: "curl -i http://127.0.0.1:3000/?q=tag",
          explanation: "False positive XSS signal",
          confidence: 0.9,
        },
        {
          hypothesisId: "REAL-JWT",
          category: "A07_AUTHENTICATION_FAILURES" as const,
          attemptedAt: Date.now(),
          payload: "<jwt>",
          outcome: "exploited" as const,
          prohibitedEffectAchieved: true,
          observedExecutionTrace: "JWT accepts unsigned 'none' algorithm",
          reproductionScript: "curl -H 'Authorization: Bearer ...'",
          explanation: "JWT none accepted",
          confidence: 1.0,
        },
      ];

      const btReport = blueTeam.remediate(mixed);
      expect(btReport.findingsAnalyzed).toBe(1);
      expect(btReport.skepticRejectedCount).toBe(1);

      const reflectionEngine = new ReflectionEngine();
      const refl = reflectionEngine.reflect({
        taskId: "TASK-REFL",
        redTeamReport: {
          campaignId: "CAMP-REFL1",
          targetWorkspace: dir,
          startedAt: Date.now(),
          completedAt: Date.now(),
          totalHypothesesTested: 2,
          blockedCount: 0,
          exploitedCount: 2,
          attackSuccessRate: 1,
          findings: mixed,
        },
        blueTeamReport: btReport,
      });

      const importedRoot = join(dir, "skills-imported");
      const skillPath = reflectionEngine.emitQuarantinedSkill(refl, importedRoot);
      expect(skillPath).not.toBeNull();

      const registry = new SkillRegistryManager({ trustFilePath: join(dir, "trusted.json") });
      const discovered = registry.discoverAllScoped({
        workspaceRoot: dir,
        importedSkillsRoot: importedRoot,
      });
      const learned = discovered.find((s) => s.name === "remediate-camp-refl1");
      expect(learned).toBeDefined();
      expect(learned?.trustState).toBe("quarantined");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
