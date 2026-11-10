import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { analyzeProject } from "@terminus/context-engine";
import {
  type ChatMessage,
  type ContentPart,
  type ModelGateway,
  toToolSpecs,
} from "@terminus/model-gateway";
import { PermissionEngine } from "@terminus/permission-engine";
import { webResearch } from "@terminus/research";
import type { Approver, ToolDefinition } from "@terminus/shared";
import { actionFor, createTools } from "@terminus/tool-runtime";
import { z } from "zod";
import { BlueTeamEngine } from "./blueteam/engine";
import type { BlueTeamReport } from "./blueteam/types";
import {
  type AgentClaim,
  type AgentClaimReport,
  enforceContractOnAction,
  type SpecialistAgentContract,
  VerificationStateMachine,
} from "./contracts";
import {
  HarnessEvolutionEngine,
  type HarnessProfile,
  HarnessRouter,
  type RoutingDecision,
  type TrajectorySignals,
} from "./harness";
import { EvidenceLedger } from "./ledger";
import type { DastRouteSpec } from "./redteam/dast-prober";
import { RedTeamEngine } from "./redteam/engine";
import { FindingWorldState } from "./redteam/finding-graph";
import type { RedTeamCampaignReport } from "./redteam/types";
import { ReflectionEngine, type RunReflection } from "./reflection";
import { scanFiles } from "./sast";
import { type OrchestratorVerdictReport, VerificationEngine } from "./verification-engine";
import { verifyEditedFile } from "./verifier";

export type OrchestratorProgressEvent =
  | { type: "routing"; taskId: string; decision: RoutingDecision }
  | { type: "state"; taskId: string; from: string; to: string }
  | {
      type: "specialist_started";
      taskId: string;
      agentId: string;
      role: string;
      harnessName: string;
      objective: string;
    }
  | {
      type: "specialist_tool";
      taskId: string;
      agentId: string;
      toolName: string;
      tier: string;
      ok: boolean;
      summary: string;
    }
  | { type: "specialist_completed"; taskId: string; report: AgentClaimReport }
  | {
      type: "verification_started";
      taskId: string;
      workerReportCount: number;
      ledgerEntryCount: number;
    }
  | {
      type: "verification_completed";
      taskId: string;
      verdictReport: OrchestratorVerdictReport;
    };

export interface OrchestrationOptions {
  workspaceRoot: string;
  gateway: ModelGateway;
  approver: Approver;
  sessionId?: string;
  store?: {
    saveEvidenceRecord(sessionId: string, record: unknown): void;
  };
  maxReworkCycles?: number;
  runAdversarialPass?: boolean;
  runRedTeamPass?: boolean;
  dast?: {
    baseUrl: string;
    routes?: readonly DastRouteSpec[];
  };
  trajectorySignals?: TrajectorySignals;
  signal?: AbortSignal;
  onEvent?: (event: OrchestratorProgressEvent) => void;
  executionGate?: { waitIfPaused(signal?: AbortSignal): Promise<void> };
  extraTools?: ToolDefinition<never>[];
}

export interface OrchestrationResult {
  readonly taskId: string;
  readonly routing: RoutingDecision;
  readonly stateHistory: readonly { from: string; to: string; at: number }[];
  readonly finalState: string;
  readonly ledger: EvidenceLedger;
  readonly workerReports: AgentClaimReport[];
  readonly verdictReport: OrchestratorVerdictReport;
  readonly reworkCyclesUsed: number;
  readonly redTeamReport?: RedTeamCampaignReport;
  readonly blueTeamReport?: BlueTeamReport;
  readonly reflection?: RunReflection;
}

const toSpecs = (tools: ToolDefinition<never>[]) =>
  toToolSpecs(
    tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: z.toJSONSchema(tool.schema),
    })),
  );

/**
 * Master Orchestrator for the TERMINUS Verified Multi-Agent Harness Architecture.
 *
 * Enforces the five non-negotiable architectural principles:
 * 1. Agents execute tasks; they do not certify their own work.
 * 2. Every completion claim must have retrievable EvidenceLedger records.
 * 3. Verification is independent of the worker that generated the result.
 * 4. The MasterOrchestrator owns task status and final verdicts via VerificationStateMachine.
 * 5. Unknown or unverifiable results remain explicitly UNVERIFIED or PARTIALLY_VERIFIED.
 */
export class MasterOrchestrator {
  readonly router: HarnessRouter;
  readonly verifier: VerificationEngine;
  readonly evolution: HarnessEvolutionEngine;
  readonly reflection: ReflectionEngine;
  readonly securityWorldState = new FindingWorldState();

  constructor(options?: {
    router?: HarnessRouter;
    verifier?: VerificationEngine;
    evolution?: HarnessEvolutionEngine;
    reflection?: ReflectionEngine;
  }) {
    this.router = options?.router ?? new HarnessRouter();
    this.verifier = options?.verifier ?? new VerificationEngine();
    this.evolution = options?.evolution ?? new HarnessEvolutionEngine();
    this.reflection = options?.reflection ?? new ReflectionEngine();
  }

  /**
   * Executes a single SpecialistAgentContract under its HarnessProfile, recording all
   * tool executions directly into the trusted EvidenceLedger and returning an AgentClaimReport.
   */
  async executeSpecialist(options: {
    taskId: string;
    contract: SpecialistAgentContract;
    harness: HarnessProfile;
    workspaceRoot: string;
    gateway: ModelGateway;
    approver: Approver;
    ledger: EvidenceLedger;
    reworkFeedback?: string;
    signal?: AbortSignal;
    onEvent?: (event: OrchestratorProgressEvent) => void;
    executionGate?: { waitIfPaused(signal?: AbortSignal): Promise<void> };
    extraTools?: ToolDefinition<never>[];
  }): Promise<AgentClaimReport> {
    const { contract, harness, workspaceRoot, gateway, ledger } = options;
    const allTools = [
      ...createTools(),
      webResearch as unknown as ToolDefinition<never>,
      ...(options.extraTools ?? []),
    ];
    const allowedTools = allTools.filter((t) => contract.allowedTools.includes(t.name));
    const toolByName = new Map(allTools.map((t) => [t.name, t]));
    const permissionEngine = new PermissionEngine({
      workspaceRoot,
      mode: contract.permissions.filesystem === "read_only" ? "plan" : "act",
    });

    const modifiedFiles = new Set<string>();
    const inspectedFiles = new Set<string>();
    const recordedDiffIds = new Map<string, string>();
    const recordedHashIds = new Map<string, string>();
    const recordedTestIds: string[] = [];
    const recordedBuildIds: string[] = [];

    const systemPrompt = [
      `You are TERMINUS Specialist Agent "${contract.agentId}" running under ${harness.name} (role: ${contract.role}).`,
      `Objective: ${contract.objective}`,
      `Permissions: filesystem=${contract.permissions.filesystem}, terminal=${contract.permissions.terminal}, network=${contract.permissions.network}`,
      contract.scope.length > 0 ? `Assigned Scope: ${contract.scope.join(", ")}` : "",
      "Harness Instructions:",
      ...harness.instructions.map((i) => `- ${i}`),
      "Workflow Steps:",
      ...harness.workflowSteps.map((s) => `  ${s}`),
      "IMPORTANT: You cannot declare your work VERIFIED. Execute the work using tools so the Orchestrator's EvidenceLedger captures verifiable records.",
    ]
      .filter(Boolean)
      .join("\n");

    const messages: ChatMessage[] = [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: options.reworkFeedback
              ? `Task: ${contract.objective}\n\n[VERIFICATION REWORK REQUIRED]:\n${options.reworkFeedback}\n\nAddress the verification failures using tools and complete the task.`
              : `Task: ${contract.objective}`,
          },
        ],
      },
    ];

    const specs = toSpecs(allowedTools);
    let iterations = 0;
    let finalSummary = "";

    while (iterations < contract.budget.maxIterations) {
      if (options.executionGate) {
        await options.executionGate.waitIfPaused(options.signal);
      }
      iterations++;
      let narration = "";
      const toolCalls: { id: string; name: string; input: unknown }[] = [];

      for await (const ev of gateway.complete(
        { system: systemPrompt, messages, tools: specs },
        options.signal,
      )) {
        if (ev.type === "text") narration += ev.text;
        else if (ev.type === "tool_use") toolCalls.push(ev);
      }

      if (toolCalls.length === 0) {
        finalSummary = narration.trim();
        break;
      }

      const assistantParts: ContentPart[] = [];
      if (narration) assistantParts.push({ type: "text", text: narration });
      for (const call of toolCalls) {
        assistantParts.push({
          type: "tool_use",
          id: call.id,
          name: call.name,
          input: call.input,
        });
      }
      messages.push({ role: "assistant", content: assistantParts });

      const resultParts: ContentPart[] = [];
      for (const call of toolCalls) {
        const tool = toolByName.get(call.name);
        if (!tool) {
          resultParts.push({
            type: "tool_result",
            tool_use_id: call.id,
            content: `unknown tool: ${call.name}`,
            is_error: true,
          });
          continue;
        }
        const parsed = tool.schema.safeParse(call.input);
        if (!parsed.success) {
          resultParts.push({
            type: "tool_result",
            tool_use_id: call.id,
            content: `invalid tool input`,
            is_error: true,
          });
          continue;
        }

        const action = actionFor(call.name, parsed.data);

        // 1. Enforce SpecialistAgentContract deterministically
        const contractCheck = enforceContractOnAction(contract, call.name, action);
        if (!contractCheck.allowed) {
          resultParts.push({
            type: "tool_result",
            tool_use_id: call.id,
            content: contractCheck.reason ?? "blocked by contract",
            is_error: true,
          });
          continue;
        }

        // 2. Enforce PermissionEngine policy
        const decision = action
          ? permissionEngine.evaluate(action)
          : { action: "allow" as const, tier: tool.tier, reason: "internal" };
        if (decision.action === "deny") {
          resultParts.push({
            type: "tool_result",
            tool_use_id: call.id,
            content: `blocked by policy: ${decision.reason}`,
            is_error: true,
          });
          continue;
        }

        if (decision.action === "ask") {
          const outcome = await options.approver({
            summary: `${contract.role} (${contract.agentId}) requests: ${call.name} ${JSON.stringify(call.input).slice(0, 140)}`,
            detail: JSON.stringify(call.input, null, 2),
            tier: decision.tier,
          });
          if (!outcome.approved) {
            resultParts.push({
              type: "tool_result",
              tool_use_id: call.id,
              content: `blocked by user: action rejected${outcome.feedback ? ` (${outcome.feedback})` : ""}`,
              is_error: true,
            });
            continue;
          }
        }

        // Capture pre-write snapshot content for EvidenceLedger DIFF record
        let beforeContent: string | null = null;
        if (action?.kind === "file_write") {
          const fullTarget = join(workspaceRoot, action.path);
          if (existsSync(fullTarget)) {
            try {
              beforeContent = readFileSync(fullTarget, "utf8");
            } catch {
              beforeContent = null;
            }
          }
        }

        const res = await tool.execute(parsed.data as never, {
          workspaceRoot,
          signal: options.signal ?? new AbortController().signal,
        });
        options.onEvent?.({
          type: "specialist_tool",
          taskId: options.taskId,
          agentId: contract.agentId,
          toolName: call.name,
          tier: decision.tier,
          ok: res.ok,
          summary: res.output.slice(0, 240),
        });

        // 3. Record verifiable execution evidence in the Orchestrator's trusted EvidenceLedger
        if (res.ok && action?.kind === "file_read") {
          const cleanPath = action.path.replace(/^\.?\//, "");
          inspectedFiles.add(cleanPath);
          const fullTarget = join(workspaceRoot, cleanPath);
          if (existsSync(fullTarget)) {
            try {
              const content = readFileSync(fullTarget, "utf8");
              const rec = ledger.recordFileInspection(contract.agentId, cleanPath, content);
              recordedHashIds.set(cleanPath, rec.id);
            } catch {
              // ignore binary/unreadable
            }
          }
        }

        if (res.ok && action?.kind === "file_write") {
          const cleanPath = action.path.replace(/^\.?\//, "");
          modifiedFiles.add(cleanPath);
          const fullTarget = join(workspaceRoot, cleanPath);
          const afterContent = existsSync(fullTarget) ? readFileSync(fullTarget, "utf8") : "";
          const diffRec = ledger.recordFileDiff(
            contract.agentId,
            cleanPath,
            beforeContent,
            afterContent,
          );
          recordedDiffIds.set(cleanPath, diffRec.id);

          // Automatically record static verification & SAST scan in EvidenceLedger
          const staticIssues = verifyEditedFile(workspaceRoot, cleanPath);
          ledger.recordStaticVerification(
            contract.agentId,
            cleanPath,
            staticIssues.filter((i) => i.severity === "blocker").length,
            staticIssues.map((i) => `${i.code}: ${i.message}`).join("\n"),
          );
          const sastFindings = scanFiles([cleanPath], workspaceRoot);
          ledger.recordSastScan(
            contract.agentId,
            cleanPath,
            sastFindings.filter((f) => f.severity === "blocker" || f.severity === "major").length,
            sastFindings.map((f) => `${f.category}: ${f.message}`).join("\n"),
          );
        }

        if (action?.kind === "command") {
          const exitCode = res.ok ? 0 : 1;
          const cmdRec = ledger.recordCommandExecution(
            contract.agentId,
            action.command,
            exitCode,
            res.output,
          );
          if (cmdRec.kind === "TEST_RUN") recordedTestIds.push(cmdRec.id);
          if (cmdRec.kind === "BUILD_RUN") recordedBuildIds.push(cmdRec.id);
        }

        resultParts.push({
          type: "tool_result",
          tool_use_id: call.id,
          content: res.output,
          is_error: !res.ok,
        });
      }

      messages.push({ role: "user", content: resultParts });
    }

    // Construct structured claims linked to EvidenceLedger IDs
    const claims: AgentClaim[] = [];
    let claimCounter = 1;

    for (const file of modifiedFiles) {
      const diffId = recordedDiffIds.get(file);
      claims.push({
        claimId: `C${claimCounter++}`,
        category: "file_modified",
        description: `Modified ${file}`,
        targetPath: file,
        evidenceIds: diffId ? [diffId] : [],
      });
    }

    if (recordedTestIds.length > 0) {
      claims.push({
        claimId: `C${claimCounter++}`,
        category: "tests_passed",
        description: "Executed test suite",
        evidenceIds: [...recordedTestIds],
      });
    }

    if (recordedBuildIds.length > 0) {
      claims.push({
        claimId: `C${claimCounter++}`,
        category: "build_succeeded",
        description: "Executed build/typecheck verification",
        evidenceIds: [...recordedBuildIds],
      });
    }

    if (contract.permissions.filesystem === "read_only" && inspectedFiles.size > 0) {
      claims.push({
        claimId: `C${claimCounter++}`,
        category: "analysis_complete",
        description: `Inspected ${inspectedFiles.size} file(s)`,
        evidenceIds: [...recordedHashIds.values()],
      });
    }

    return {
      taskId: options.taskId,
      agentId: contract.agentId,
      role: contract.role,
      harnessName: harness.name,
      status: "claimed_complete",
      summary: finalSummary || `Completed ${contract.objective}`,
      claims,
      modifiedFiles: [...modifiedFiles],
      inspectedFiles: [...inspectedFiles],
      uninspectedAreas: [],
      unresolvedIssues: [],
      assumptions: [],
      risks: [],
    };
  }

  /**
   * Runs the full Orchestrated Multi-Agent Pipeline with State Machine & 4-Layer Verification.
   */
  async orchestrate(task: string, options: OrchestrationOptions): Promise<OrchestrationResult> {
    const taskId = `TASK-${Date.now().toString(36).toUpperCase()}`;
    const machine = new VerificationStateMachine();
    const ledger = new EvidenceLedger((rec) => {
      if (options.store && options.sessionId) {
        try {
          options.store.saveEvidenceRecord(options.sessionId, rec);
        } catch {
          // ignore storage error in standalone/test execution
        }
      }
    });
    const maxRework = options.maxReworkCycles ?? 1;

    // 1. Repository analysis + Intelligent Task & Trajectory Routing
    const projectIntel = analyzeProject(options.workspaceRoot);
    const routing = this.router.route(task, projectIntel, options.trajectorySignals);
    options.onEvent?.({ type: "routing", taskId, decision: routing });

    // 2. Instantiate SpecialistAgentContracts for each selected HarnessProfile
    const assignments = routing.selectedHarnesses.map((harness, idx) => ({
      harness,
      contract: this.router.createContract(harness, {
        agentId: `${harness.role}-${idx + 1}`,
        objective: task,
      }),
    }));

    const transition = (to: Parameters<VerificationStateMachine["transition"]>[0]) => {
      const from = machine.state;
      machine.transition(to);
      options.onEvent?.({ type: "state", taskId, from, to });
    };

    transition("ASSIGNED");
    transition("RUNNING");

    let reworkCyclesUsed = 0;
    let reworkFeedback: string | undefined;
    let workerReports: AgentClaimReport[] = [];
    let verdictReport: OrchestratorVerdictReport | undefined;

    while (true) {
      workerReports = [];
      for (const { contract, harness } of assignments) {
        options.onEvent?.({
          type: "specialist_started",
          taskId,
          agentId: contract.agentId,
          role: contract.role,
          harnessName: harness.name,
          objective: contract.objective,
        });
        const report = await this.executeSpecialist({
          taskId,
          contract,
          harness,
          workspaceRoot: options.workspaceRoot,
          gateway: options.gateway,
          approver: options.approver,
          ledger,
          reworkFeedback,
          signal: options.signal,
          onEvent: options.onEvent,
          executionGate: options.executionGate,
          extraTools: options.extraTools,
        });
        workerReports.push(report);
        options.onEvent?.({ type: "specialist_completed", taskId, report });
      }

      transition("CLAIMED_COMPLETE");
      transition("EVIDENCE_COLLECTION");
      transition("VERIFYING");
      options.onEvent?.({
        type: "verification_started",
        taskId,
        workerReportCount: workerReports.length,
        ledgerEntryCount: ledger.all().length,
      });

      verdictReport = await this.verifier.verifyAll({
        taskId,
        task,
        workspaceRoot: options.workspaceRoot,
        reports: assignments.map((a, idx) => ({
          report: workerReports[idx] as AgentClaimReport,
          contract: a.contract,
          harness: a.harness,
        })),
        ledger,
        gateway: options.runAdversarialPass ? options.gateway : undefined,
        signal: options.signal,
      });

      const v = verdictReport.overallVerdict;
      transition(v);
      options.onEvent?.({ type: "verification_completed", taskId, verdictReport });

      // Record telemetry in HarnessEvolutionEngine
      for (const av of verdictReport.agentVerifications) {
        if (av.verdict !== "BLOCKED") {
          this.evolution.recordExecution({
            taskId,
            harnessName: av.harnessName,
            verdict: av.verdict,
            failureModes: av.detectedFailureModes,
          });
        }
      }

      // If REJECTED or PARTIALLY_VERIFIED and rework cycles remain, transition -> REWORK -> RUNNING
      if ((v === "REJECTED" || v === "PARTIALLY_VERIFIED") && reworkCyclesUsed < maxRework) {
        reworkCyclesUsed++;
        reworkFeedback = verdictReport.summary;
        transition("REWORK");
        transition("RUNNING");
        continue;
      }

      break;
    }

    let redTeamReport: RedTeamCampaignReport | undefined;
    let blueTeamReport: BlueTeamReport | undefined;
    let reflection: RunReflection | undefined;

    if (options.runRedTeamPass) {
      const redTeam = new RedTeamEngine(options.workspaceRoot);
      const blueTeam = new BlueTeamEngine(options.workspaceRoot);
      const permEngine = new PermissionEngine({
        workspaceRoot: options.workspaceRoot,
        mode: "act",
      });

      redTeamReport = await redTeam.runCampaign(permEngine, ledger, {
        worldState: this.securityWorldState,
        dast: options.dast,
      });
      if (redTeamReport.exploitedCount > 0) {
        blueTeamReport = blueTeam.remediate(redTeamReport.findings, ledger);
      }
      reflection = this.reflection.reflect({
        taskId,
        redTeamReport,
        blueTeamReport,
        evolution: this.evolution,
      });
    }

    return {
      taskId,
      routing,
      stateHistory: machine.transitions,
      finalState: machine.state,
      ledger,
      workerReports,
      verdictReport: verdictReport as OrchestratorVerdictReport,
      reworkCyclesUsed,
      redTeamReport,
      blueTeamReport,
      reflection,
    };
  }
}
