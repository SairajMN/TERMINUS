import { z } from "zod";

export const RuntimeEventPayloadSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("session.created"),
    sessionId: z.string(),
    workspaceRoot: z.string(),
    mode: z.string(),
    task: z.string(),
  }),
  z.object({
    type: z.literal("session.updated"),
    sessionId: z.string(),
    state: z.string(),
    status: z.enum([
      "idle",
      "running",
      "paused",
      "awaiting_approval",
      "completed",
      "failed",
      "cancelled",
    ]),
  }),
  z.object({
    type: z.literal("session.completed"),
    sessionId: z.string(),
    outcome: z.enum(["completed", "cancelled", "failed"]),
    summary: z.string(),
  }),
  z.object({
    type: z.literal("agent.started"),
    agentId: z.string(),
    role: z.string(),
    harnessName: z.string(),
    objective: z.string(),
    parentAgentId: z.string().optional(),
  }),
  z.object({
    type: z.literal("agent.progress"),
    agentId: z.string(),
    stage: z.string(),
    summary: z.string(),
    textDelta: z.string().optional(),
  }),
  z.object({
    type: z.literal("agent.completed"),
    agentId: z.string(),
    claimStatus: z.enum(["claimed_complete", "blocked", "failed"]),
    evidenceIds: z.array(z.string()),
    summary: z.string(),
  }),
  z.object({
    type: z.literal("agent.failed"),
    agentId: z.string(),
    error: z.string(),
    recoverable: z.boolean(),
  }),
  z.object({
    type: z.literal("tool.started"),
    callId: z.string(),
    agentId: z.string(),
    toolName: z.string(),
    origin: z.string(),
    tier: z.enum(["read", "modify", "high_impact"]),
    inputSummary: z.string(),
  }),
  z.object({
    type: z.literal("tool.completed"),
    callId: z.string(),
    agentId: z.string(),
    toolName: z.string(),
    durationMs: z.number(),
    ledgerEvidenceId: z.string().optional(),
    outputPreview: z.string(),
  }),
  z.object({
    type: z.literal("tool.failed"),
    callId: z.string(),
    agentId: z.string(),
    toolName: z.string(),
    error: z.string(),
    timedOut: z.boolean().default(false),
  }),
  z.object({
    type: z.literal("approval.required"),
    approvalId: z.string(),
    agentId: z.string(),
    tier: z.enum(["read", "modify", "high_impact"]),
    summary: z.string(),
    detail: z.string().optional(),
  }),
  z.object({
    type: z.literal("approval.resolved"),
    approvalId: z.string(),
    approved: z.boolean(),
    scope: z.enum(["once", "session", "allowlist_pattern"]),
    feedback: z.string().optional(),
  }),
  z.object({
    type: z.literal("verification.started"),
    taskId: z.string(),
    workerReportCount: z.number(),
    ledgerEntryCount: z.number(),
  }),
  z.object({
    type: z.literal("verification.completed"),
    taskId: z.string(),
    overallVerdict: z.enum([
      "VERIFIED",
      "PARTIALLY_VERIFIED",
      "UNVERIFIED",
      "REJECTED",
      "FAILED",
      "BLOCKED",
    ]),
    uccr: z.number(),
    falseAcceptanceCount: z.number(),
    summary: z.string(),
  }),
  z.object({
    type: z.literal("diff.updated"),
    changedFiles: z.array(
      z.object({
        path: z.string(),
        status: z.enum(["added", "modified", "deleted"]),
        additions: z.number(),
        deletions: z.number(),
      }),
    ),
  }),
  z.object({
    type: z.literal("budget.warning"),
    metric: z.enum(["tokens", "cost_usd", "tool_calls"]),
    used: z.number(),
    limit: z.number(),
    percentage: z.number(),
    halted: z.boolean().default(false),
  }),
  z.object({
    type: z.literal("extension.health"),
    extensionId: z.string(),
    status: z.enum(["healthy", "disabled", "degraded", "crashed", "circuit_open"]),
    reason: z.string().optional(),
  }),
  z.object({
    type: z.literal("mcp.status"),
    serverId: z.string(),
    status: z.enum(["disconnected", "connecting", "connected", "reconnecting", "error"]),
    error: z.string().optional(),
  }),
]);

export type RuntimeEventPayload = z.infer<typeof RuntimeEventPayloadSchema>;

export const RuntimeEventEnvelopeSchema = z.object({
  seq: z.number().int().nonnegative(),
  sessionId: z.string(),
  timestamp: z.number(),
  payload: RuntimeEventPayloadSchema,
});

export type RuntimeEventEnvelope = z.infer<typeof RuntimeEventEnvelopeSchema>;

export function parseRuntimeEventSafely(raw: unknown): {
  valid: boolean;
  envelope?: RuntimeEventEnvelope;
  error?: string;
} {
  try {
    const obj = typeof raw === "string" ? JSON.parse(raw) : raw;
    const res = RuntimeEventEnvelopeSchema.safeParse(obj);
    if (res.success) {
      return { valid: true, envelope: res.data };
    }
    return {
      valid: false,
      error: res.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
    };
  } catch (err) {
    return {
      valid: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export class EventStreamHub {
  private readonly sessionSeq = new Map<string, number>();
  private readonly history = new Map<string, RuntimeEventEnvelope[]>();
  private readonly listeners = new Map<string, Set<(event: RuntimeEventEnvelope) => void>>();
  private readonly maxHistoryPerSession: number;

  constructor(options?: { maxHistoryPerSession?: number }) {
    this.maxHistoryPerSession = options?.maxHistoryPerSession ?? 1000;
  }

  publish(sessionId: string, payload: RuntimeEventPayload): RuntimeEventEnvelope {
    const validated = RuntimeEventPayloadSchema.parse(payload);
    const nextSeq = (this.sessionSeq.get(sessionId) ?? 0) + 1;
    this.sessionSeq.set(sessionId, nextSeq);

    const envelope: RuntimeEventEnvelope = Object.freeze({
      seq: nextSeq,
      sessionId,
      timestamp: Date.now(),
      payload: validated,
    });

    const list = this.history.get(sessionId) ?? [];
    list.push(envelope);
    if (list.length > this.maxHistoryPerSession) list.shift();
    this.history.set(sessionId, list);

    const sessionSubs = this.listeners.get(sessionId);
    if (sessionSubs) {
      for (const fn of sessionSubs) fn(envelope);
    }
    const wildcardSubs = this.listeners.get("*");
    if (wildcardSubs) {
      for (const fn of wildcardSubs) fn(envelope);
    }

    return envelope;
  }

  subscribe(sessionId: string | "*", listener: (event: RuntimeEventEnvelope) => void): () => void {
    const set = this.listeners.get(sessionId) ?? new Set();
    set.add(listener);
    this.listeners.set(sessionId, set);
    return () => {
      set.delete(listener);
    };
  }

  getEventsAfter(sessionId: string, afterSeq = 0): RuntimeEventEnvelope[] {
    const list = this.history.get(sessionId) ?? [];
    return list.filter((e) => e.seq > afterSeq);
  }
}
