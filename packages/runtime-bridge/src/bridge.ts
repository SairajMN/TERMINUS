import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  type AgentClaimReport,
  type AgentSession,
  BaseCodingHarness,
  BUILTIN_HARNESSES,
  createAgent,
  type ExecutionGate,
  type HarnessProfile,
  inheritHarness,
  MasterOrchestrator,
  type OrchestratorVerdictReport,
  SUBAGENT_REGISTRY,
} from "@terminus/agent-runtime";
import {
  analyzeProject,
  buildRepoMap,
  loadInstructions,
  type SkillMetadata,
  SkillRegistryManager,
  validateSkillMarkdown,
} from "@terminus/context-engine";
import { ExtensionHost, type ExtensionRuntimeState } from "@terminus/extension-host";
import {
  InMemorySecretVault,
  MCP_CONNECTION_PRESETS,
  McpConnectionManager,
  type McpServerConfig,
  type McpServerHealth,
  type SecretVault,
} from "@terminus/mcp-client";
import {
  BudgetTracker,
  type ModelGateway,
  type ProviderName,
  selectGateway,
} from "@terminus/model-gateway";
import { PermissionEngine } from "@terminus/permission-engine";
import { type PermissionAuditRow, SessionStore } from "@terminus/session-store";
import type {
  ApprovalOutcome,
  CompletionReport,
  Mode,
  PermissionTier,
  ToolDefinition,
} from "@terminus/shared";
import { createTools } from "@terminus/tool-runtime";
import { EventStreamHub, type RuntimeEventEnvelope, type RuntimeEventPayload } from "./events";

export type WorkspaceExecutionMode = Mode | "orchestrate";

export interface ExecutionBudgetConfig {
  maxTokens: number;
  maxCostUsd: number;
  maxToolCalls: number;
  maxParallelAgents: number;
  commandTimeoutMs: number;
}

export interface TokenUsageSnapshot {
  sessionId: string;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
  toolCallCount: number;
  byAgent: Record<string, { tokens: number; costUsd: number; toolCalls: number }>;
}

export interface FileDiffEntry {
  path: string;
  status: "added" | "modified" | "deleted";
  additions: number;
  deletions: number;
  unifiedDiff: string;
  beforeContent?: string;
  afterContent?: string;
}

export interface WorkspaceDiffSnapshot {
  sessionId: string;
  files: FileDiffEntry[];
}

export interface ActiveSpecialistNode {
  agentId: string;
  role: string;
  harnessName: string;
  objective: string;
  status:
    | "running"
    | "waiting"
    | "claimed_complete"
    | "verified"
    | "partially_verified"
    | "failed"
    | "blocked"
    | "awaiting_approval";
  toolCalls: { toolName: string; summary: string; ok: boolean; at: number }[];
}

export interface LiveAgentStatusSnapshot {
  sessionId: string;
  workspaceRoot: string;
  mode: WorkspaceExecutionMode;
  stage: string;
  status:
    | "idle"
    | "running"
    | "paused"
    | "awaiting_approval"
    | "completed"
    | "failed"
    | "cancelled";
  activeTask: string;
  specialists: ActiveSpecialistNode[];
  pendingApprovals: {
    approvalId: string;
    agentId: string;
    tier: PermissionTier;
    summary: string;
    detail?: string;
  }[];
}

export interface RegisteredToolSummary {
  name: string;
  description: string;
  tier: PermissionTier;
  origin: "builtin" | `mcp:${string}` | `extension:${string}`;
  enabled: boolean;
}

export interface ProviderProfileConfig {
  provider: ProviderName;
  displayName: string;
  defaultModel: string;
  endpoint?: string;
  secretKeyRef: string;
  hasApiKeyConfigured: boolean;
  fallbackProvider?: ProviderName;
  contextWindowTokens: number;
}

export class CooperativeExecutionGate implements ExecutionGate {
  private paused = false;
  private resumeWaiters: (() => void)[] = [];

  get isPaused(): boolean {
    return this.paused;
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
    const waiters = this.resumeWaiters.splice(0, this.resumeWaiters.length);
    for (const wake of waiters) wake();
  }

  async waitIfPaused(signal?: AbortSignal): Promise<void> {
    if (!this.paused) return;
    await new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error("Execution aborted while paused"));
        return;
      }
      const onAbort = () => {
        reject(new Error("Execution aborted while paused"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.resumeWaiters.push(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      });
    });
  }
}

interface ManagedSessionRuntime {
  sessionId: string;
  workspaceRoot: string;
  mode: WorkspaceExecutionMode;
  task: string;
  stage: string;
  status: LiveAgentStatusSnapshot["status"];
  agent: AgentSession;
  gate: CooperativeExecutionGate;
  abortController: AbortController;
  budgetConfig: ExecutionBudgetConfig;
  budgetTracker: BudgetTracker;
  toolCallCount: number;
  byAgentUsage: Record<string, { tokens: number; costUsd: number; toolCalls: number }>;
  latestPlan: string | null;
  completionReport?: CompletionReport;
  workerReports: AgentClaimReport[];
  verdictReport: OrchestratorVerdictReport | null;
  specialists: Map<string, ActiveSpecialistNode>;
  pendingApprovals: Map<
    string,
    {
      approvalId: string;
      agentId: string;
      tier: PermissionTier;
      summary: string;
      detail?: string;
      resolve: (outcome: ApprovalOutcome) => void;
    }
  >;
  sessionApprovedPatterns: Set<string>;
}

const computeUnifiedDiff = (
  relPath: string,
  before: string | undefined,
  after: string | undefined,
): {
  status: "added" | "modified" | "deleted";
  additions: number;
  deletions: number;
  unifiedDiff: string;
} => {
  if (before === undefined && after !== undefined) {
    const afterLines = after.split("\n");
    return {
      status: "added",
      additions: afterLines.length,
      deletions: 0,
      unifiedDiff: [
        `--- /dev/null`,
        `+++ b/${relPath}`,
        `@@ -0,0 +1,${afterLines.length} @@`,
        ...afterLines.map((l) => `+${l}`),
      ].join("\n"),
    };
  }
  if (before !== undefined && after === undefined) {
    const beforeLines = before.split("\n");
    return {
      status: "deleted",
      additions: 0,
      deletions: beforeLines.length,
      unifiedDiff: [
        `--- a/${relPath}`,
        `+++ /dev/null`,
        `@@ -1,${beforeLines.length} +0,0 @@`,
        ...beforeLines.map((l) => `-${l}`),
      ].join("\n"),
    };
  }
  const bLines = (before ?? "").split("\n");
  const aLines = (after ?? "").split("\n");
  let additions = 0;
  let deletions = 0;
  const diffLines: string[] = [
    `--- a/${relPath}`,
    `+++ b/${relPath}`,
    `@@ -1,${bLines.length} +1,${aLines.length} @@`,
  ];
  const maxLen = Math.max(bLines.length, aLines.length);
  for (let i = 0; i < maxLen; i++) {
    const bLine = bLines[i];
    const aLine = aLines[i];
    if (bLine === aLine && bLine !== undefined) {
      diffLines.push(` ${bLine}`);
    } else {
      if (bLine !== undefined) {
        deletions++;
        diffLines.push(`-${bLine}`);
      }
      if (aLine !== undefined) {
        additions++;
        diffLines.push(`+${aLine}`);
      }
    }
  }
  return {
    status: "modified",
    additions,
    deletions,
    unifiedDiff: diffLines.join("\n"),
  };
};

export class TerminusRuntimeBridge {
  readonly eventHub = new EventStreamHub();
  readonly store: SessionStore;
  readonly mcpManager: McpConnectionManager;
  readonly extensionHost: ExtensionHost;
  readonly skillRegistry: SkillRegistryManager;
  readonly secretVault: SecretVault;
  private readonly customHarnesses = new Map<string, HarnessProfile>();
  private readonly sessions = new Map<string, ManagedSessionRuntime>();
  private readonly defaultWorkspaceRoot: string;
  private readonly gatewayFactory: (provider?: ProviderName, model?: string) => ModelGateway;
  private readonly orchestrator: MasterOrchestrator;
  private approvalSeq = 0;

  constructor(options?: {
    workspaceRoot?: string;
    store?: SessionStore;
    secretVault?: SecretVault;
    gateway?: ModelGateway;
    gatewayFactory?: (provider?: ProviderName, model?: string) => ModelGateway;
    skillRegistry?: SkillRegistryManager;
  }) {
    this.defaultWorkspaceRoot = options?.workspaceRoot ?? process.cwd();
    this.store = options?.store ?? new SessionStore();
    this.secretVault = options?.secretVault ?? new InMemorySecretVault();
    this.mcpManager = new McpConnectionManager({ secretVault: this.secretVault });
    this.extensionHost = new ExtensionHost();
    this.skillRegistry = options?.skillRegistry ?? new SkillRegistryManager();
    this.orchestrator = new MasterOrchestrator();

    this.gatewayFactory =
      options?.gatewayFactory ??
      ((provider, model) => {
        if (options?.gateway) return options.gateway;
        return selectGateway({ provider, model }).gateway;
      });

    // Forward MCP & Extension health transitions to the event stream
    this.mcpManager.onStatusChange((health) => {
      this.eventHub.publish("system", {
        type: "mcp.status",
        serverId: health.serverId,
        status: health.status,
        error: health.lastError,
      });
    });

    this.extensionHost.onHealthChange((state) => {
      this.eventHub.publish("system", {
        type: "extension.health",
        extensionId: state.manifest.id,
        status: state.status,
        reason: state.lastError,
      });
    });
  }

  private emit(sessionId: string, payload: RuntimeEventPayload): RuntimeEventEnvelope {
    this.store.logEvent(sessionId, payload.type, payload);
    return this.eventHub.publish(sessionId, payload);
  }

  async createSession(input?: {
    workspaceRoot?: string;
    mode?: WorkspaceExecutionMode;
    task?: string;
    budget?: Partial<ExecutionBudgetConfig>;
    provider?: ProviderName;
    model?: string;
  }): Promise<{
    sessionId: string;
    workspaceRoot: string;
    mode: WorkspaceExecutionMode;
    status: LiveAgentStatusSnapshot["status"];
    budget: ExecutionBudgetConfig;
  }> {
    const workspaceRoot = input?.workspaceRoot ?? this.defaultWorkspaceRoot;
    const mode: WorkspaceExecutionMode = input?.mode ?? "act";
    const task = input?.task ?? "Interactive Workspace Session";
    const sessionId = this.store.createSession(workspaceRoot, task);

    const budgetConfig: ExecutionBudgetConfig = {
      maxTokens: input?.budget?.maxTokens ?? 120_000,
      maxCostUsd: input?.budget?.maxCostUsd ?? 2.0,
      maxToolCalls: input?.budget?.maxToolCalls ?? 60,
      maxParallelAgents: input?.budget?.maxParallelAgents ?? 4,
      commandTimeoutMs: input?.budget?.commandTimeoutMs ?? 30_000,
    };

    const gate = new CooperativeExecutionGate();
    const abortController = new AbortController();
    const budgetTracker = new BudgetTracker({
      maxTokens: budgetConfig.maxTokens,
      maxCostUsd: budgetConfig.maxCostUsd,
      model: input?.model,
    });

    const runtime: ManagedSessionRuntime = {
      sessionId,
      workspaceRoot,
      mode,
      task,
      stage: "queued",
      status: "idle",
      agent: null as unknown as AgentSession,
      gate,
      abortController,
      budgetConfig,
      budgetTracker,
      toolCallCount: 0,
      byAgentUsage: {},
      latestPlan: null,
      workerReports: [],
      verdictReport: null,
      specialists: new Map(),
      pendingApprovals: new Map(),
      sessionApprovedPatterns: new Set(),
    };

    const approver = async (req: {
      summary: string;
      detail?: string;
      tier: PermissionTier;
    }): Promise<ApprovalOutcome> => {
      if (runtime.sessionApprovedPatterns.has(req.summary)) {
        return { approved: true };
      }
      const approvalId = `APR-${++this.approvalSeq}`;
      runtime.status = "awaiting_approval";
      this.emit(sessionId, {
        type: "session.updated",
        sessionId,
        state: runtime.stage,
        status: "awaiting_approval",
      });

      const decisionPromise = new Promise<ApprovalOutcome>((resolve) => {
        runtime.pendingApprovals.set(approvalId, {
          approvalId,
          agentId: "primary-agent",
          tier: req.tier,
          summary: req.summary,
          detail: req.detail,
          resolve: (outcome) => {
            runtime.pendingApprovals.delete(approvalId);
            if (runtime.status === "awaiting_approval") {
              runtime.status = "running";
            }
            this.store.logPermissionAudit({
              session_id: sessionId,
              origin: "user_approval_gate",
              action_kind: "approval",
              target: req.summary,
              tier: req.tier,
              verdict: outcome.approved ? "approved" : "rejected",
              reason: outcome.feedback ?? "interactive workspace decision",
            });
            resolve(outcome);
          },
        });
      });

      this.emit(sessionId, {
        type: "approval.required",
        approvalId,
        agentId: "primary-agent",
        tier: req.tier,
        summary: req.summary,
        detail: req.detail,
      });

      return decisionPromise;
    };

    const getDynamicExtraTools = (): ToolDefinition<never>[] => {
      const effectiveMode: Mode = mode === "orchestrate" ? "act" : mode;
      const onPermissionEvaluated = (audit: {
        origin: string;
        actionKind: string;
        target: string;
        tier: PermissionTier;
        verdict: string;
        reason: string;
      }) => {
        this.store.logPermissionAudit({
          session_id: sessionId,
          origin: audit.origin,
          action_kind: audit.actionKind,
          target: audit.target,
          tier: audit.tier,
          verdict: audit.verdict,
          reason: audit.reason,
        });
      };
      return [
        ...this.mcpManager.getExecutableTools({
          workspaceRoot,
          mode: effectiveMode,
          approver,
          onPermissionEvaluated,
        }),
        ...this.extensionHost.getExecutableTools({
          workspaceRoot,
          mode: effectiveMode,
          approver,
          onPermissionEvaluated,
        }),
      ];
    };

    let gateway: ModelGateway;
    try {
      gateway = this.gatewayFactory(input?.provider, input?.model);
    } catch {
      // Allow offline GUI creation when no API key is set yet
      gateway = {
        complete: () => ({
          [Symbol.asyncIterator]: () => ({
            next: async () => {
              throw new Error("Model provider is offline or missing API credentials.");
            },
          }),
        }),
      };
    }

    let activeCallId = 0;
    const agent = createAgent({
      workspaceRoot,
      gateway,
      approver,
      mode: mode === "orchestrate" ? "act" : mode,
      store: this.store,
      maxTokens: budgetConfig.maxTokens,
      commandTimeoutMs: budgetConfig.commandTimeoutMs,
      executionGate: gate,
      getExtraTools: getDynamicExtraTools,
      emit: (ev) => {
        switch (ev.type) {
          case "state":
            runtime.stage = ev.to;
            this.emit(sessionId, {
              type: "session.updated",
              sessionId,
              state: ev.to,
              status: runtime.status,
            });
            break;
          case "text":
            this.emit(sessionId, {
              type: "agent.progress",
              agentId: "primary-agent",
              stage: runtime.stage,
              summary: ev.text.slice(0, 180),
              textDelta: ev.text,
            });
            break;
          case "plan":
            runtime.latestPlan = ev.text;
            this.emit(sessionId, {
              type: "agent.progress",
              agentId: "primary-agent",
              stage: "planning",
              summary: "Generated structured implementation plan",
              textDelta: ev.text,
            });
            break;
          case "tool": {
            runtime.toolCallCount++;
            const callId = `CALL-${++activeCallId}`;
            const origin = ev.name.startsWith("mcp__")
              ? `mcp:${ev.name.split("__")[1]}`
              : ev.name.startsWith("ext__")
                ? `extension:${ev.name.split("__")[1]}`
                : "builtin";
            this.store.logPermissionAudit({
              session_id: sessionId,
              origin,
              action_kind: "tool",
              target: ev.name,
              tier: ev.decision.tier,
              verdict: ev.decision.verdict,
              reason: ev.decision.reason,
            });
            this.emit(sessionId, {
              type: "tool.started",
              callId,
              agentId: "primary-agent",
              toolName: ev.name,
              origin,
              tier: (ev.decision.tier as PermissionTier) || "read",
              inputSummary: JSON.stringify(ev.input).slice(0, 200),
            });
            this.checkAndEnforceBudgets(runtime);
            break;
          }
          case "tool_result": {
            const callId = `CALL-${activeCallId}`;
            if (ev.ok) {
              this.emit(sessionId, {
                type: "tool.completed",
                callId,
                agentId: "primary-agent",
                toolName: ev.name,
                durationMs: 12,
                outputPreview: ev.summary,
              });
            } else {
              this.emit(sessionId, {
                type: "tool.failed",
                callId,
                agentId: "primary-agent",
                toolName: ev.name,
                error: ev.summary,
                timedOut: ev.summary.includes("timed out"),
              });
            }
            const diffSnap = this.computeDiffSnapshot(runtime);
            if (diffSnap.files.length > 0) {
              this.emit(sessionId, {
                type: "diff.updated",
                changedFiles: diffSnap.files.map((f) => ({
                  path: f.path,
                  status: f.status,
                  additions: f.additions,
                  deletions: f.deletions,
                })),
              });
            }
            break;
          }
          case "usage": {
            runtime.budgetTracker.record(ev.prompt, ev.completion);
            const snap = runtime.budgetTracker.snapshot();
            runtime.byAgentUsage["primary-agent"] = {
              tokens: snap.totalTokens,
              costUsd: snap.estimatedCostUsd,
              toolCalls: runtime.toolCallCount,
            };
            this.checkAndEnforceBudgets(runtime);
            break;
          }
          case "report":
            runtime.completionReport = ev.report;
            break;
        }
      },
    });

    runtime.agent = agent;
    this.sessions.set(sessionId, runtime);

    this.emit(sessionId, {
      type: "session.created",
      sessionId,
      workspaceRoot,
      mode,
      task,
    });

    return {
      sessionId,
      workspaceRoot,
      mode,
      status: runtime.status,
      budget: budgetConfig,
    };
  }

  private checkAndEnforceBudgets(runtime: ManagedSessionRuntime): void {
    const snap = runtime.budgetTracker.snapshot();
    const { maxTokens, maxCostUsd, maxToolCalls } = runtime.budgetConfig;

    const tokenPct = maxTokens > 0 ? (snap.totalTokens / maxTokens) * 100 : 0;
    const costPct = maxCostUsd > 0 ? (snap.estimatedCostUsd / maxCostUsd) * 100 : 0;
    const toolPct = maxToolCalls > 0 ? (runtime.toolCallCount / maxToolCalls) * 100 : 0;

    if (tokenPct >= 80) {
      const halted = snap.totalTokens >= maxTokens;
      if (halted) runtime.abortController.abort(new Error("Token budget exhausted"));
      this.emit(runtime.sessionId, {
        type: "budget.warning",
        metric: "tokens",
        used: snap.totalTokens,
        limit: maxTokens,
        percentage: Math.round(tokenPct),
        halted,
      });
    }

    if (costPct >= 80) {
      const halted = snap.estimatedCostUsd >= maxCostUsd;
      if (halted) runtime.abortController.abort(new Error("Session USD cost budget exhausted"));
      this.emit(runtime.sessionId, {
        type: "budget.warning",
        metric: "cost_usd",
        used: snap.estimatedCostUsd,
        limit: maxCostUsd,
        percentage: Math.round(costPct),
        halted,
      });
    }

    if (toolPct >= 80) {
      const halted = runtime.toolCallCount >= maxToolCalls;
      if (halted) runtime.abortController.abort(new Error("Tool call budget exhausted"));
      this.emit(runtime.sessionId, {
        type: "budget.warning",
        metric: "tool_calls",
        used: runtime.toolCallCount,
        limit: maxToolCalls,
        percentage: Math.round(toolPct),
        halted,
      });
    }
  }

  async sendMessage(input: {
    sessionId: string;
    prompt: string;
    mode?: WorkspaceExecutionMode;
    provider?: ProviderName;
    model?: string;
  }): Promise<{
    sessionId: string;
    outcome: "completed" | "cancelled" | "failed";
    summary: string;
    verdict?: string;
  }> {
    const runtime = this.sessions.get(input.sessionId);
    if (!runtime) throw new Error(`Session "${input.sessionId}" not found`);

    if (input.mode) runtime.mode = input.mode;
    runtime.task = input.prompt;
    runtime.abortController = new AbortController();
    runtime.status = "running";
    runtime.stage = "investigating";

    this.emit(runtime.sessionId, {
      type: "session.updated",
      sessionId: runtime.sessionId,
      state: runtime.stage,
      status: "running",
    });

    if (runtime.mode === "orchestrate") {
      return this.runOrchestratedSession(runtime, input.prompt, input.provider, input.model);
    }

    this.emit(runtime.sessionId, {
      type: "agent.started",
      agentId: "primary-agent",
      role: "coder",
      harnessName: "BaseCodingHarness",
      objective: input.prompt,
    });

    try {
      const report = await runtime.agent.run(input.prompt, {
        signal: runtime.abortController.signal,
      });
      runtime.completionReport = report;
      runtime.status =
        report.outcome === "completed"
          ? "completed"
          : report.outcome === "cancelled"
            ? "cancelled"
            : "failed";

      this.emit(runtime.sessionId, {
        type: "agent.completed",
        agentId: "primary-agent",
        claimStatus: report.outcome === "completed" ? "claimed_complete" : "failed",
        evidenceIds: report.changedFiles,
        summary: report.summary,
      });

      this.emit(runtime.sessionId, {
        type: "session.completed",
        sessionId: runtime.sessionId,
        outcome: report.outcome,
        summary: report.summary,
      });

      return {
        sessionId: runtime.sessionId,
        outcome: report.outcome,
        summary: report.summary,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      runtime.status = runtime.abortController.signal.aborted ? "cancelled" : "failed";
      this.emit(runtime.sessionId, {
        type: "agent.failed",
        agentId: "primary-agent",
        error: msg,
        recoverable: true,
      });
      this.emit(runtime.sessionId, {
        type: "session.completed",
        sessionId: runtime.sessionId,
        outcome: runtime.status === "cancelled" ? "cancelled" : "failed",
        summary: msg,
      });
      return {
        sessionId: runtime.sessionId,
        outcome: runtime.status === "cancelled" ? "cancelled" : "failed",
        summary: msg,
      };
    }
  }

  private async runOrchestratedSession(
    runtime: ManagedSessionRuntime,
    task: string,
    provider?: ProviderName,
    model?: string,
  ): Promise<{
    sessionId: string;
    outcome: "completed" | "cancelled" | "failed";
    summary: string;
    verdict?: string;
  }> {
    let gateway: ModelGateway;
    try {
      gateway = this.gatewayFactory(provider, model);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      runtime.status = "failed";
      this.emit(runtime.sessionId, {
        type: "agent.failed",
        agentId: "orchestrator",
        error: msg,
        recoverable: true,
      });
      return { sessionId: runtime.sessionId, outcome: "failed", summary: msg };
    }

    const extraTools = [
      ...this.mcpManager.getExecutableTools({
        workspaceRoot: runtime.workspaceRoot,
        mode: "act",
      }),
      ...this.extensionHost.getExecutableTools({
        workspaceRoot: runtime.workspaceRoot,
        mode: "act",
      }),
    ];

    try {
      const result = await this.orchestrator.orchestrate(task, {
        workspaceRoot: runtime.workspaceRoot,
        gateway,
        approver: async () => ({ approved: true }),
        signal: runtime.abortController.signal,
        executionGate: runtime.gate,
        extraTools,
        onEvent: (ev) => {
          switch (ev.type) {
            case "state":
              runtime.stage = ev.to;
              this.emit(runtime.sessionId, {
                type: "session.updated",
                sessionId: runtime.sessionId,
                state: ev.to,
                status: runtime.status,
              });
              break;
            case "specialist_started": {
              const node: ActiveSpecialistNode = {
                agentId: ev.agentId,
                role: ev.role,
                harnessName: ev.harnessName,
                objective: ev.objective,
                status: "running",
                toolCalls: [],
              };
              runtime.specialists.set(ev.agentId, node);
              this.emit(runtime.sessionId, {
                type: "agent.started",
                agentId: ev.agentId,
                role: ev.role,
                harnessName: ev.harnessName,
                objective: ev.objective,
                parentAgentId: "MasterOrchestrator",
              });
              break;
            }
            case "specialist_tool": {
              runtime.toolCallCount++;
              const node = runtime.specialists.get(ev.agentId);
              if (node) {
                node.toolCalls.push({
                  toolName: ev.toolName,
                  summary: ev.summary,
                  ok: ev.ok,
                  at: Date.now(),
                });
              }
              const callId = `ORCH-CALL-${runtime.toolCallCount}`;
              this.emit(runtime.sessionId, {
                type: "tool.started",
                callId,
                agentId: ev.agentId,
                toolName: ev.toolName,
                origin: "specialist",
                tier: (ev.tier as PermissionTier) || "read",
                inputSummary: ev.summary.slice(0, 120),
              });
              this.emit(runtime.sessionId, {
                type: "tool.completed",
                callId,
                agentId: ev.agentId,
                toolName: ev.toolName,
                durationMs: 10,
                outputPreview: ev.summary,
              });
              this.checkAndEnforceBudgets(runtime);
              break;
            }
            case "specialist_completed": {
              const node = runtime.specialists.get(ev.report.agentId);
              if (node) node.status = ev.report.status;
              this.emit(runtime.sessionId, {
                type: "agent.completed",
                agentId: ev.report.agentId,
                claimStatus: ev.report.status,
                evidenceIds: ev.report.claims.flatMap((c) => c.evidenceIds),
                summary: ev.report.summary,
              });
              break;
            }
            case "verification_started":
              this.emit(runtime.sessionId, {
                type: "verification.started",
                taskId: ev.taskId,
                workerReportCount: ev.workerReportCount,
                ledgerEntryCount: ev.ledgerEntryCount,
              });
              break;
            case "verification_completed":
              runtime.verdictReport = ev.verdictReport;
              for (const av of ev.verdictReport.agentVerifications) {
                const node = runtime.specialists.get(av.agentId);
                if (node) {
                  node.status =
                    av.verdict === "VERIFIED"
                      ? "verified"
                      : av.verdict === "PARTIALLY_VERIFIED"
                        ? "partially_verified"
                        : "failed";
                }
              }
              this.emit(runtime.sessionId, {
                type: "verification.completed",
                taskId: ev.taskId,
                overallVerdict: ev.verdictReport.overallVerdict,
                uccr: ev.verdictReport.unsupportedCompletionClaimRate,
                falseAcceptanceCount: ev.verdictReport.falseAcceptanceCount,
                summary: ev.verdictReport.summary,
              });
              break;
          }
        },
      });

      runtime.workerReports = [...result.workerReports];
      runtime.verdictReport = result.verdictReport;
      const passed =
        result.verdictReport.overallVerdict === "VERIFIED" ||
        result.verdictReport.overallVerdict === "PARTIALLY_VERIFIED";
      runtime.status = passed ? "completed" : "failed";

      this.emit(runtime.sessionId, {
        type: "session.completed",
        sessionId: runtime.sessionId,
        outcome: passed ? "completed" : "failed",
        summary: result.verdictReport.summary,
      });

      return {
        sessionId: runtime.sessionId,
        outcome: passed ? "completed" : "failed",
        summary: result.verdictReport.summary,
        verdict: result.verdictReport.overallVerdict,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      runtime.status = runtime.abortController.signal.aborted ? "cancelled" : "failed";
      this.emit(runtime.sessionId, {
        type: "session.completed",
        sessionId: runtime.sessionId,
        outcome: runtime.status === "cancelled" ? "cancelled" : "failed",
        summary: msg,
      });
      return {
        sessionId: runtime.sessionId,
        outcome: runtime.status === "cancelled" ? "cancelled" : "failed",
        summary: msg,
      };
    }
  }

  pauseExecution(sessionId: string): { status: "paused" } {
    const runtime = this.sessions.get(sessionId);
    if (!runtime) throw new Error(`Session "${sessionId}" not found`);
    runtime.gate.pause();
    runtime.status = "paused";
    this.emit(sessionId, {
      type: "session.updated",
      sessionId,
      state: runtime.stage,
      status: "paused",
    });
    return { status: "paused" };
  }

  resumeExecution(sessionId: string): { status: "running" } {
    const runtime = this.sessions.get(sessionId);
    if (!runtime) throw new Error(`Session "${sessionId}" not found`);
    runtime.gate.resume();
    runtime.status = "running";
    this.emit(sessionId, {
      type: "session.updated",
      sessionId,
      state: runtime.stage,
      status: "running",
    });
    return { status: "running" };
  }

  stopExecution(sessionId: string): { status: "cancelled" } {
    const runtime = this.sessions.get(sessionId);
    if (!runtime) throw new Error(`Session "${sessionId}" not found`);
    runtime.abortController.abort(new Error("Stopped by user"));
    runtime.gate.resume();
    runtime.status = "cancelled";
    this.store.setState(sessionId, "cancelled");
    this.emit(sessionId, {
      type: "session.updated",
      sessionId,
      state: "cancelled",
      status: "cancelled",
    });
    return { status: "cancelled" };
  }

  getSession(sessionId: string) {
    const managed = this.sessions.get(sessionId);
    const row = this.store.sessionById(sessionId);
    if (!managed && !row) return null;
    return {
      sessionId: managed?.sessionId ?? row?.id ?? sessionId,
      workspaceRoot: managed?.workspaceRoot ?? row?.workspace ?? this.defaultWorkspaceRoot,
      task: managed?.task ?? row?.task ?? "",
      state: managed?.stage ?? row?.state ?? "idle",
      status: managed?.status ?? (row?.state === "completed" ? "completed" : "idle"),
      mode: managed?.mode ?? "act",
      createdAt: row?.created_at ?? Date.now(),
      updatedAt: row?.updated_at ?? Date.now(),
    };
  }

  listSessions(workspaceRoot?: string) {
    const rows = workspaceRoot
      ? this.store.recentSessions(workspaceRoot, 30)
      : this.store.allSessions(30);
    return rows.map((r) => {
      const active = this.sessions.get(r.id);
      return {
        sessionId: r.id,
        workspaceRoot: r.workspace,
        task: r.task,
        state: active?.stage ?? r.state,
        status: active?.status ?? (r.state === "completed" ? "completed" : "idle"),
        mode: active?.mode ?? "act",
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      };
    });
  }

  getAgentStatus(sessionId: string): LiveAgentStatusSnapshot {
    const runtime = this.sessions.get(sessionId);
    if (!runtime) {
      const row = this.store.sessionById(sessionId);
      return {
        sessionId,
        workspaceRoot: row?.workspace ?? this.defaultWorkspaceRoot,
        mode: "act",
        stage: row?.state ?? "idle",
        status: "idle",
        activeTask: row?.task ?? "",
        specialists: [],
        pendingApprovals: [],
      };
    }
    return {
      sessionId: runtime.sessionId,
      workspaceRoot: runtime.workspaceRoot,
      mode: runtime.mode,
      stage: runtime.stage,
      status: runtime.status,
      activeTask: runtime.task,
      specialists: [...runtime.specialists.values()],
      pendingApprovals: [...runtime.pendingApprovals.values()].map((a) => ({
        approvalId: a.approvalId,
        agentId: a.agentId,
        tier: a.tier,
        summary: a.summary,
        detail: a.detail,
      })),
    };
  }

  getExecutionEvents(sessionId: string, afterSeq = 0): RuntimeEventEnvelope[] {
    return this.eventHub.getEventsAfter(sessionId, afterSeq);
  }

  subscribeEvents(
    sessionId: string | "*",
    listener: (event: RuntimeEventEnvelope) => void,
  ): () => void {
    return this.eventHub.subscribe(sessionId, listener);
  }

  getActiveTools(workspaceRoot?: string): RegisteredToolSummary[] {
    const root = workspaceRoot ?? this.defaultWorkspaceRoot;
    const builtins = createTools().map((t) => ({
      name: t.name,
      description: t.description,
      tier: t.tier,
      origin: "builtin" as const,
      enabled: true,
    }));

    const mcpTools: RegisteredToolSummary[] = [];
    for (const h of this.mcpManager.listHealth()) {
      for (const t of h.tools) {
        mcpTools.push({
          name: `mcp__${h.serverId}__${t.name}`,
          description: t.description,
          tier: t.permissionTier,
          origin: `mcp:${h.serverId}`,
          enabled: t.enabled && h.status === "connected",
        });
      }
    }

    const extTools: RegisteredToolSummary[] = [];
    for (const ext of this.extensionHost.listExtensions()) {
      for (const t of ext.registeredTools) {
        extTools.push({
          name: `ext__${ext.manifest.id}__${t.name}`,
          description: t.description,
          tier: t.tier,
          origin: `extension:${ext.manifest.id}`,
          enabled: ext.enabled && ext.status === "healthy",
        });
      }
    }

    void root;
    return [...builtins, ...mcpTools, ...extTools];
  }

  getTaskPlan(sessionId: string): string | null {
    const runtime = this.sessions.get(sessionId);
    return runtime?.agent.lastPlan() ?? runtime?.latestPlan ?? null;
  }

  getTaskReport(sessionId: string): {
    completionReport?: CompletionReport;
    workerReports: AgentClaimReport[];
  } {
    const runtime = this.sessions.get(sessionId);
    return {
      completionReport: runtime?.completionReport,
      workerReports: runtime ? [...runtime.workerReports] : [],
    };
  }

  getVerificationResults(sessionId: string): OrchestratorVerdictReport | null {
    const runtime = this.sessions.get(sessionId);
    return runtime?.verdictReport ?? null;
  }

  getTokenUsage(sessionId: string): TokenUsageSnapshot {
    const runtime = this.sessions.get(sessionId);
    if (!runtime) {
      return {
        sessionId,
        promptTokens: 0,
        completionTokens: 0,
        cachedTokens: 0,
        totalTokens: 0,
        estimatedCostUsd: 0,
        toolCallCount: 0,
        byAgent: {},
      };
    }
    const snap = runtime.budgetTracker.snapshot();
    return {
      sessionId,
      promptTokens: snap.promptTokens,
      completionTokens: snap.completionTokens,
      cachedTokens: 0,
      totalTokens: snap.totalTokens,
      estimatedCostUsd: snap.estimatedCostUsd,
      toolCallCount: runtime.toolCallCount,
      byAgent: { ...runtime.byAgentUsage },
    };
  }

  getExecutionBudget(sessionId: string): ExecutionBudgetConfig {
    const runtime = this.sessions.get(sessionId);
    return (
      runtime?.budgetConfig ?? {
        maxTokens: 120_000,
        maxCostUsd: 2.0,
        maxToolCalls: 60,
        maxParallelAgents: 4,
        commandTimeoutMs: 30_000,
      }
    );
  }

  updateExecutionBudget(
    sessionId: string,
    patch: Partial<ExecutionBudgetConfig>,
  ): ExecutionBudgetConfig {
    const runtime = this.sessions.get(sessionId);
    if (!runtime) throw new Error(`Session "${sessionId}" not found`);
    runtime.budgetConfig = {
      ...runtime.budgetConfig,
      ...patch,
    };
    this.checkAndEnforceBudgets(runtime);
    return { ...runtime.budgetConfig };
  }

  private computeDiffSnapshot(runtime: ManagedSessionRuntime): WorkspaceDiffSnapshot {
    const tracked = runtime.agent.trackedSnapshots();
    const files: FileDiffEntry[] = [];

    for (const relPath of tracked) {
      const base = runtime.agent.snapshotBaseline(relPath);
      if (!base) continue;
      const beforeContent =
        base.existed && base.content ? base.content.toString("utf8") : undefined;
      const fullPath = join(runtime.workspaceRoot, relPath);
      const afterContent = existsSync(fullPath) ? readFileSync(fullPath, "utf8") : undefined;
      if (beforeContent === afterContent) continue;

      const diff = computeUnifiedDiff(relPath, beforeContent, afterContent);
      files.push({
        path: relPath,
        status: diff.status,
        additions: diff.additions,
        deletions: diff.deletions,
        unifiedDiff: diff.unifiedDiff,
        beforeContent,
        afterContent,
      });
    }

    return { sessionId: runtime.sessionId, files };
  }

  getFileDiff(sessionId: string): WorkspaceDiffSnapshot {
    const runtime = this.sessions.get(sessionId);
    if (!runtime) return { sessionId, files: [] };
    return this.computeDiffSnapshot(runtime);
  }

  revertFileModification(
    sessionId: string,
    filePath: string,
  ): { outcome: "restored" | "removed" | "untouched" } {
    const runtime = this.sessions.get(sessionId);
    if (!runtime) throw new Error(`Session "${sessionId}" not found`);
    const outcome = runtime.agent.undoFile(filePath);
    const diffSnap = this.computeDiffSnapshot(runtime);
    this.emit(sessionId, {
      type: "diff.updated",
      changedFiles: diffSnap.files.map((f) => ({
        path: f.path,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
      })),
    });
    return { outcome };
  }

  restoreCheckpoint(sessionId: string): { restored: string[]; removed: string[] } {
    const runtime = this.sessions.get(sessionId);
    if (!runtime) throw new Error(`Session "${sessionId}" not found`);
    const result = runtime.agent.undo();
    this.emit(sessionId, {
      type: "diff.updated",
      changedFiles: [],
    });
    return result;
  }

  approveAction(input: {
    sessionId: string;
    approvalId: string;
    scope?: "once" | "session" | "allowlist_pattern";
    feedback?: string;
  }): { resolved: boolean } {
    const runtime = this.sessions.get(input.sessionId);
    if (!runtime) throw new Error(`Session "${input.sessionId}" not found`);
    const pending = runtime.pendingApprovals.get(input.approvalId);
    if (!pending) return { resolved: false };

    const scope = input.scope ?? "once";
    if (scope === "session" || scope === "allowlist_pattern") {
      runtime.sessionApprovedPatterns.add(pending.summary);
    }
    pending.resolve({ approved: true, feedback: input.feedback });
    this.emit(input.sessionId, {
      type: "approval.resolved",
      approvalId: input.approvalId,
      approved: true,
      scope,
      feedback: input.feedback,
    });
    return { resolved: true };
  }

  rejectAction(input: { sessionId: string; approvalId: string; feedback?: string }): {
    resolved: boolean;
  } {
    const runtime = this.sessions.get(input.sessionId);
    if (!runtime) throw new Error(`Session "${input.sessionId}" not found`);
    const pending = runtime.pendingApprovals.get(input.approvalId);
    if (!pending) return { resolved: false };

    pending.resolve({ approved: false, feedback: input.feedback });
    this.emit(input.sessionId, {
      type: "approval.resolved",
      approvalId: input.approvalId,
      approved: false,
      scope: "once",
      feedback: input.feedback,
    });
    return { resolved: true };
  }

  // --- Platform Management Operations (Agents, Skills, MCP, Extensions, Models, Rules, Security) ---

  listHarnessesAndAgents() {
    const builtins = Object.values(BUILTIN_HARNESSES);
    const custom = [...this.customHarnesses.values()];
    const subagents = Object.values(SUBAGENT_REGISTRY);
    return {
      harnesses: [...builtins, ...custom],
      subagents,
      telemetry: this.orchestrator.evolution.getHistory(),
    };
  }

  registerCustomAgent(input: {
    name: string;
    parentHarnessName?: string;
    role: HarnessProfile["role"];
    description: string;
    instructions: string[];
    allowedTools?: string[];
  }): HarnessProfile {
    const parent =
      (input.parentHarnessName && BUILTIN_HARNESSES[input.parentHarnessName]) || BaseCodingHarness;
    const created = inheritHarness(parent, {
      name: input.name,
      role: input.role,
      description: input.description,
      additionalInstructions: input.instructions,
      allowedTools: input.allowedTools,
    });
    this.customHarnesses.set(created.name, created);
    return created;
  }

  listSkills(workspaceRoot?: string): SkillMetadata[] {
    return this.skillRegistry.discoverAllScoped({
      workspaceRoot: workspaceRoot ?? this.defaultWorkspaceRoot,
    });
  }

  saveSkill(input: {
    workspaceRoot?: string;
    scope: "workspace" | "user" | "imported";
    category?: string;
    name: string;
    content: string;
  }): { valid: boolean; path?: string; errors: string[]; trustState?: "trusted" | "quarantined" } {
    const validation = validateSkillMarkdown(input.content);
    if (!validation.valid) {
      return { valid: false, errors: validation.errors };
    }
    const root = input.workspaceRoot ?? this.defaultWorkspaceRoot;
    const category = input.category ?? "custom";
    const baseDir =
      input.scope === "workspace"
        ? join(root, "skills", category, input.name)
        : input.scope === "user"
          ? join(homedir(), ".terminus", "skills", category, input.name)
          : join(homedir(), ".terminus", "skills-imported", input.name);

    const filePath = join(baseDir, "SKILL.md");
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, input.content, "utf8");
    return {
      valid: true,
      path: filePath,
      errors: [],
      trustState: input.scope === "imported" ? "quarantined" : "trusted",
    };
  }

  approveQuarantinedSkill(name: string, content: string): { sha256: string } {
    const sha256 = this.skillRegistry.approveQuarantinedSkill(name, content);
    return { sha256 };
  }

  listMcpServers(): { presets: typeof MCP_CONNECTION_PRESETS; servers: McpServerHealth[] } {
    return {
      presets: MCP_CONNECTION_PRESETS,
      servers: this.mcpManager.listHealth(),
    };
  }

  registerMcpServer(config: unknown): McpServerConfig {
    return this.mcpManager.registerServer(config);
  }

  async connectMcpServer(serverId: string): Promise<McpServerHealth> {
    return this.mcpManager.connectServer(serverId);
  }

  async disconnectMcpServer(serverId: string): Promise<void> {
    await this.mcpManager.disconnectServer(serverId);
  }

  listExtensions(): ExtensionRuntimeState[] {
    return this.extensionHost.listExtensions();
  }

  listProviders(): ProviderProfileConfig[] {
    return [
      {
        provider: "nebius",
        displayName: "Nebius Token Factory (NVIDIA Nemotron)",
        defaultModel: "nvidia/nemotron-3-super-120b-a12b",
        endpoint: "https://api.studio.nebius.com/v1/",
        secretKeyRef: "provider:nebius:api_key",
        hasApiKeyConfigured: Boolean(
          process.env.NEBIUS_API_KEY || this.secretVault.getSecret("provider:nebius:api_key"),
        ),
        fallbackProvider: "anthropic",
        contextWindowTokens: 128_000,
      },
      {
        provider: "anthropic",
        displayName: "Anthropic Claude",
        defaultModel: "claude-sonnet-4-6",
        secretKeyRef: "provider:anthropic:api_key",
        hasApiKeyConfigured: Boolean(
          process.env.ANTHROPIC_API_KEY || this.secretVault.getSecret("provider:anthropic:api_key"),
        ),
        fallbackProvider: "openai",
        contextWindowTokens: 200_000,
      },
      {
        provider: "openai",
        displayName: "OpenAI",
        defaultModel: "gpt-5.4",
        secretKeyRef: "provider:openai:api_key",
        hasApiKeyConfigured: Boolean(
          process.env.OPENAI_API_KEY || this.secretVault.getSecret("provider:openai:api_key"),
        ),
        contextWindowTokens: 128_000,
      },
      {
        provider: "gemini",
        displayName: "Google Gemini",
        defaultModel: "gemini-2.5-pro",
        secretKeyRef: "provider:gemini:api_key",
        hasApiKeyConfigured: Boolean(
          process.env.GEMINI_API_KEY || this.secretVault.getSecret("provider:gemini:api_key"),
        ),
        contextWindowTokens: 1_000_000,
      },
      {
        provider: "ollama",
        displayName: "Ollama (Local Models)",
        defaultModel: "qwen2.5-coder:32b",
        endpoint: "http://127.0.0.1:11434/v1",
        secretKeyRef: "provider:ollama:none",
        hasApiKeyConfigured: true,
        contextWindowTokens: 32_768,
      },
    ];
  }

  async setProviderApiKey(provider: ProviderName, apiKey: string): Promise<void> {
    await this.secretVault.setSecret(`provider:${provider}:api_key`, apiKey);
  }

  getInstructionHierarchy(workspaceRoot?: string) {
    const root = workspaceRoot ?? this.defaultWorkspaceRoot;
    const globalPath = join(homedir(), ".terminus", "instructions.md");
    const agentsMdPath = join(root, "AGENTS.md");
    const terminusMdPath = join(root, "TERMINUS.md");
    const dotTerminusPath = join(root, ".terminus", "instructions.md");

    const readSafe = (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : "");
    return {
      workspaceRoot: root,
      mergedPreview: loadInstructions(root) ?? "",
      repoMapPreview: buildRepoMap(root),
      projectIntel: analyzeProject(root),
      layers: [
        {
          priority: 1,
          scope: "system",
          label: "Core Safety & Verification Invariants",
          path: "packages/agent-runtime/src/prompt.ts",
          editable: false,
          content:
            "Worker agents cannot self-certify completion. All modifications pass through PermissionEngine and 4-layer VerificationEngine.",
        },
        {
          priority: 2,
          scope: "workspace",
          label: "AGENTS.md (Repository Standard)",
          path: agentsMdPath,
          editable: true,
          content: readSafe(agentsMdPath),
        },
        {
          priority: 3,
          scope: "workspace",
          label: "TERMINUS.md (Workspace Rules)",
          path: terminusMdPath,
          editable: true,
          content: readSafe(terminusMdPath),
        },
        {
          priority: 4,
          scope: "workspace_local",
          label: ".terminus/instructions.md",
          path: dotTerminusPath,
          editable: true,
          content: readSafe(dotTerminusPath),
        },
        {
          priority: 5,
          scope: "global",
          label: "~/.terminus/instructions.md (User Global)",
          path: globalPath,
          editable: true,
          content: readSafe(globalPath),
        },
      ],
    };
  }

  saveInstructionFile(targetPath: string, content: string): void {
    mkdirSync(dirname(targetPath), { recursive: true });
    writeFileSync(targetPath, content, "utf8");
  }

  getSecurityOverview(workspaceRoot?: string): {
    policySummary: { hardDenyCount: number; fastPathCount: number };
    auditLogs: PermissionAuditRow[];
  } {
    const engine = new PermissionEngine({
      workspaceRoot: workspaceRoot ?? this.defaultWorkspaceRoot,
      mode: "act",
    });
    void engine;
    return {
      policySummary: {
        hardDenyCount: 20,
        fastPathCount: 8,
      },
      auditLogs: this.store.listPermissionAudit(100),
    };
  }

  async shutdown(): Promise<void> {
    await this.mcpManager.shutdownAll();
    await this.extensionHost.shutdownAll();
  }
}
