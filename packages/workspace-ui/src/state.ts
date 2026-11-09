import { parseRuntimeEventSafely, type RuntimeEventEnvelope } from "@terminus/runtime-bridge";

export type WorkspaceNavSection =
  | "workspace"
  | "agents"
  | "skills"
  | "mcp"
  | "extensions"
  | "models"
  | "rules"
  | "security"
  | "analytics"
  | "settings";

export type InspectorTabId =
  | "plan"
  | "agents"
  | "activity"
  | "files"
  | "diff"
  | "tests"
  | "verification"
  | "usage";

export interface ComposerKeyboardEventLike {
  key: string;
  shiftKey?: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
  isComposing?: boolean;
  keyCode?: number;
}

/**
 * IME-safe Enter-to-submit check (per modern-web-guidance `ime-safe-enter-submit`).
 * Prevents premature submission while composing CJK/IME characters including Safari's keyCode 229 quirk.
 */
export function shouldSubmitComposerOnKeydown(event: ComposerKeyboardEventLike): boolean {
  if (event.key !== "Enter" || event.shiftKey) return false;
  if (event.isComposing || event.keyCode === 229) return false;
  return true;
}

export class DirtyConfigGuard {
  private readonly dirtyForms = new Map<string, string>();

  markDirty(formId: string, unsavedValue: string): void {
    this.dirtyForms.set(formId, unsavedValue);
  }

  markClean(formId: string): void {
    this.dirtyForms.delete(formId);
  }

  hasUnsavedChanges(formId?: string): boolean {
    if (formId) return this.dirtyForms.has(formId);
    return this.dirtyForms.size > 0;
  }

  dirtyFormIds(): string[] {
    return [...this.dirtyForms.keys()];
  }

  canNavigate(
    targetSection: WorkspaceNavSection,
    confirmDiscard?: (dirtyIds: string[], target: WorkspaceNavSection) => boolean,
  ): boolean {
    if (!this.hasUnsavedChanges()) return true;
    if (!confirmDiscard) return false;
    const confirmed = confirmDiscard(this.dirtyFormIds(), targetSection);
    if (confirmed) {
      this.dirtyForms.clear();
    }
    return confirmed;
  }
}

export interface WorkspaceClientSnapshot {
  bridgeStatus: "online" | "offline" | "reconnecting";
  activeSection: WorkspaceNavSection;
  activeInspectorTab: InspectorTabId;
  activeSessionId: string | null;
  lastSeenSeqBySession: Record<string, number>;
  sessionStatus:
    | "idle"
    | "running"
    | "paused"
    | "awaiting_approval"
    | "completed"
    | "failed"
    | "cancelled";
  sessionStage: string;
  events: RuntimeEventEnvelope[];
  droppedMalformedEventCount: number;
  lastDiagnosticWarning?: string;
  verificationBadge:
    | "UNVERIFIED"
    | "CLAIMED_COMPLETE"
    | "VERIFIED"
    | "PARTIALLY_VERIFIED"
    | "REJECTED"
    | "FAILED"
    | "BLOCKED";
  budgetWarnings: {
    metric: string;
    used: number;
    limit: number;
    percentage: number;
    halted: boolean;
  }[];
}

export class WorkspaceClientStore {
  readonly dirtyGuard = new DirtyConfigGuard();
  private state: WorkspaceClientSnapshot = {
    bridgeStatus: "offline",
    activeSection: "workspace",
    activeInspectorTab: "verification",
    activeSessionId: null,
    lastSeenSeqBySession: {},
    sessionStatus: "idle",
    sessionStage: "idle",
    events: [],
    droppedMalformedEventCount: 0,
    verificationBadge: "UNVERIFIED",
    budgetWarnings: [],
  };

  constructor(options?: { initialBridgeStatus?: "online" | "offline" }) {
    if (options?.initialBridgeStatus) {
      this.state.bridgeStatus = options.initialBridgeStatus;
    }
  }

  snapshot(): WorkspaceClientSnapshot {
    return {
      ...this.state,
      lastSeenSeqBySession: { ...this.state.lastSeenSeqBySession },
      events: [...this.state.events],
      budgetWarnings: [...this.state.budgetWarnings],
    };
  }

  setBridgeStatus(status: "online" | "offline" | "reconnecting"): void {
    this.state.bridgeStatus = status;
  }

  navigateTo(
    section: WorkspaceNavSection,
    confirmDiscard?: (dirtyIds: string[], target: WorkspaceNavSection) => boolean,
  ): { navigated: boolean; blockedByDirtyForms: string[] } {
    if (!this.dirtyGuard.canNavigate(section, confirmDiscard)) {
      return {
        navigated: false,
        blockedByDirtyForms: this.dirtyGuard.dirtyFormIds(),
      };
    }
    this.state.activeSection = section;
    return { navigated: true, blockedByDirtyForms: [] };
  }

  selectInspectorTab(tab: InspectorTabId): void {
    this.state.activeInspectorTab = tab;
  }

  /**
   * Safely ingests a raw event from SSE / Webview postMessage.
   * Malformed events are dropped without crashing the UI state store.
   * Worker completion claims NEVER set verificationBadge to VERIFIED; only verification.completed can.
   */
  ingestRawEvent(raw: unknown): { accepted: boolean; reason?: string } {
    const parsed = parseRuntimeEventSafely(raw);
    if (!parsed.valid || !parsed.envelope) {
      this.state.droppedMalformedEventCount++;
      this.state.lastDiagnosticWarning = `Dropped malformed runtime event: ${parsed.error ?? "invalid schema"}`;
      return { accepted: false, reason: parsed.error };
    }

    const env = parsed.envelope;
    const prevSeq = this.state.lastSeenSeqBySession[env.sessionId] ?? 0;
    if (env.seq <= prevSeq && env.sessionId !== "system") {
      return { accepted: false, reason: "duplicate_or_stale_seq" };
    }

    this.state.lastSeenSeqBySession[env.sessionId] = env.seq;
    this.state.events.push(env);
    if (!this.state.activeSessionId && env.sessionId !== "system") {
      this.state.activeSessionId = env.sessionId;
    }

    const p = env.payload;
    switch (p.type) {
      case "session.created":
        this.state.activeSessionId = p.sessionId;
        this.state.sessionStatus = "idle";
        this.state.verificationBadge = "UNVERIFIED";
        break;
      case "session.updated":
        this.state.sessionStage = p.state;
        this.state.sessionStatus = p.status;
        break;
      case "session.completed":
        this.state.sessionStatus =
          p.outcome === "completed"
            ? "completed"
            : p.outcome === "cancelled"
              ? "cancelled"
              : "failed";
        break;
      case "agent.completed":
        // CRITICAL INVARIANT: A worker agent claiming completion only transitions to CLAIMED_COMPLETE, NEVER VERIFIED.
        if (this.state.verificationBadge === "UNVERIFIED" && p.claimStatus === "claimed_complete") {
          this.state.verificationBadge = "CLAIMED_COMPLETE";
        }
        break;
      case "approval.required":
        this.state.sessionStatus = "awaiting_approval";
        break;
      case "verification.completed":
        this.state.verificationBadge = p.overallVerdict;
        break;
      case "budget.warning":
        this.state.budgetWarnings.push({
          metric: p.metric,
          used: p.used,
          limit: p.limit,
          percentage: p.percentage,
          halted: p.halted,
        });
        if (p.halted) {
          this.state.sessionStatus = "cancelled";
        }
        break;
    }

    return { accepted: true };
  }
}
