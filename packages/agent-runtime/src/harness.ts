import type { ProjectAnalysis } from "@terminus/context-engine";
import type {
  FilesystemPermission,
  SpecialistAgentContract,
  SpecialistRole,
  TerminalPermission,
} from "./contracts";

export interface HarnessProfile {
  readonly name: string;
  readonly version: number;
  readonly parentName?: string;
  readonly role: SpecialistRole;
  readonly description: string;
  readonly instructions: readonly string[];
  readonly workflowSteps: readonly string[];
  readonly allowedTools: readonly string[];
  readonly permissions: {
    readonly filesystem: FilesystemPermission;
    readonly terminal: TerminalPermission;
    readonly network: boolean;
  };
  readonly contextStrategy: "minimal" | "symbol_focused" | "diff_focused" | "broad_audit";
  readonly budget: {
    readonly maxIterations: number;
    readonly maxTokens?: number;
  };
  readonly mandatoryVerification: {
    readonly requireDiffEvidence: boolean;
    readonly requireTestExecution: boolean;
    readonly requireBuildExecution: boolean;
    readonly requireSastClean: boolean;
    readonly requireStaticVerifyClean: boolean;
  };
}

const READ_TOOLS = [
  "list_dir",
  "read_file",
  "file_outline",
  "find_symbol",
  "find_files",
  "grep",
  "git_status",
  "git_diff",
  "git_log",
] as const;

const WRITE_TOOLS = [
  ...READ_TOOLS,
  "write_file",
  "edit_file",
  "multi_edit",
  "delete_file",
  "move_file",
] as const;

const FULL_CODING_TOOLS = [...WRITE_TOOLS, "run_command"] as const;

/**
 * Object-Oriented Harness inheritance helper (arXiv:2610.28380).
 * Allows child harnesses to inherit base capabilities while overriding or appending
 * instructions, workflow steps, permissions, and mandatory verification gates.
 */
export function inheritHarness(
  parent: HarnessProfile,
  overrides: {
    name: string;
    version?: number;
    role?: SpecialistRole;
    description: string;
    additionalInstructions?: string[];
    workflowSteps?: string[];
    allowedTools?: readonly string[];
    permissions?: Partial<HarnessProfile["permissions"]>;
    contextStrategy?: HarnessProfile["contextStrategy"];
    budget?: Partial<HarnessProfile["budget"]>;
    mandatoryVerification?: Partial<HarnessProfile["mandatoryVerification"]>;
  },
): HarnessProfile {
  return Object.freeze({
    name: overrides.name,
    version: overrides.version ?? 1,
    parentName: parent.name,
    role: overrides.role ?? parent.role,
    description: overrides.description,
    instructions: Object.freeze([
      ...parent.instructions,
      ...(overrides.additionalInstructions ?? []),
    ]),
    workflowSteps: Object.freeze(overrides.workflowSteps ?? [...parent.workflowSteps]),
    allowedTools: Object.freeze(overrides.allowedTools ?? [...parent.allowedTools]),
    permissions: Object.freeze({
      ...parent.permissions,
      ...overrides.permissions,
    }),
    contextStrategy: overrides.contextStrategy ?? parent.contextStrategy,
    budget: Object.freeze({
      ...parent.budget,
      ...overrides.budget,
    }),
    mandatoryVerification: Object.freeze({
      ...parent.mandatoryVerification,
      ...overrides.mandatoryVerification,
    }),
  });
}

// ============================================================================
// Base Harnesses
// ============================================================================

export const BaseCodingHarness: HarnessProfile = Object.freeze({
  name: "BaseCodingHarness",
  version: 1,
  role: "backend",
  description:
    "General-purpose software engineering harness with minimal-diff editing and verification.",
  instructions: [
    "Inspect relevant files before making changes.",
    "Apply minimal, surgical diffs that preserve existing conventions.",
    "Never claim a task is verified; report status as claimed_complete with evidence IDs.",
  ],
  workflowSteps: [
    "1. Inspect target files using file_outline, find_symbol, or read_file.",
    "2. Apply minimal changes using edit_file, multi_edit, or write_file.",
    "3. Resolve any instant post-edit static verification diagnostics.",
    "4. Run verification checks and record evidence IDs.",
  ],
  allowedTools: FULL_CODING_TOOLS,
  permissions: {
    filesystem: "workspace_write" as const,
    terminal: "full" as const,
    network: false,
  },
  contextStrategy: "symbol_focused",
  budget: { maxIterations: 30 },
  mandatoryVerification: {
    requireDiffEvidence: true,
    requireTestExecution: false,
    requireBuildExecution: false,
    requireSastClean: true,
    requireStaticVerifyClean: true,
  },
});

export const BaseResearchHarness: HarnessProfile = Object.freeze({
  name: "BaseResearchHarness",
  version: 1,
  role: "repo_analyst",
  description: "Read-only analytical harness for codebase mapping, architecture, and research.",
  instructions: [
    "Operate strictly read-only. Never attempt to modify files.",
    "Cite every file path, line number, or external source you rely on.",
  ],
  workflowSteps: [
    "1. Map relevant modules and symbol exports.",
    "2. Gather concrete file hash evidence for every inspected file.",
    "3. Synthesize findings with explicit disclosure of any uninspected areas.",
  ],
  allowedTools: READ_TOOLS,
  permissions: {
    filesystem: "read_only" as const,
    terminal: "none" as const,
    network: false,
  },
  contextStrategy: "broad_audit",
  budget: { maxIterations: 15 },
  mandatoryVerification: {
    requireDiffEvidence: false,
    requireTestExecution: false,
    requireBuildExecution: false,
    requireSastClean: false,
    requireStaticVerifyClean: false,
  },
});

// ============================================================================
// Specialized Harnesses (inheriting from BaseCodingHarness / BaseResearchHarness)
// ============================================================================

export const DebuggingHarness = inheritHarness(BaseCodingHarness, {
  name: "DebuggingHarness",
  role: "debugger",
  description: "Root-cause diagnosis and bug-fixing harness with mandatory fault isolation.",
  additionalInstructions: [
    "Trace the failure to its root cause before editing any code.",
    "Never silence errors by deleting assertions or weakening types.",
  ],
  workflowSteps: [
    "1. Locate the failing symbol, stack trace, or error boundary.",
    "2. Identify the root cause in source code.",
    "3. Apply a minimal fix targeting the root cause.",
    "4. Run tests or verification commands to confirm the bug is resolved.",
  ],
  mandatoryVerification: {
    requireDiffEvidence: true,
    requireStaticVerifyClean: true,
  },
});

export const RefactoringHarness = inheritHarness(BaseCodingHarness, {
  name: "RefactoringHarness",
  role: "backend",
  description: "Behavior-preserving structural refactoring harness.",
  additionalInstructions: [
    "Preserve all public API signatures and external behavior unless explicitly instructed.",
    "Use find_symbol across the workspace to ensure all call sites are updated.",
  ],
  workflowSteps: [
    "1. Find all symbol definitions and references with find_symbol.",
    "2. Apply atomic multi_edit changes across affected modules.",
    "3. Verify zero broken imports or export mismatches.",
  ],
});

export const FrontendHarness = inheritHarness(BaseCodingHarness, {
  name: "FrontendHarness",
  role: "frontend",
  description:
    "Frontend UI/UX, React/Next.js App Router, and responsive layout specialist harness.",
  additionalInstructions: [
    "Ensure Next.js App Router components using React hooks, event handlers, or motion include top-level 'use client';.",
    "Verify default vs. named component exports match all import sites.",
    "Ensure responsive layouts and accessible semantics.",
  ],
  mandatoryVerification: {
    requireDiffEvidence: true,
    requireStaticVerifyClean: true,
    requireSastClean: true,
  },
});

export const BackendHarness = inheritHarness(BaseCodingHarness, {
  name: "BackendHarness",
  role: "backend",
  description: "Backend service, API route, authentication, and business logic specialist harness.",
  additionalInstructions: [
    "Enforce strict input validation (e.g. Zod) at every API or service boundary.",
    "Ensure parameterized queries and proper error handling without leaking sensitive stack traces.",
  ],
});

export const DatabaseHarness = inheritHarness(BaseCodingHarness, {
  name: "DatabaseHarness",
  role: "database",
  description: "Database schema, SQL query, and migration specialist harness.",
  additionalInstructions: [
    "Never use string interpolation in SQL/NoSQL queries; always use parameterized bindings.",
    "Ensure schema changes are backwards-compatible or paired with safe migrations.",
  ],
});

export const TestingHarness = inheritHarness(BaseCodingHarness, {
  name: "TestingHarness",
  role: "tester",
  description: "Unit, integration, and edge-case test authoring and execution specialist harness.",
  additionalInstructions: [
    "Write deterministic tests that cover happy paths, boundary conditions, and error paths.",
    "Execute the test suite via run_command so a real TEST-RUN-* record is recorded in the EvidenceLedger.",
  ],
  permissions: {
    filesystem: "scoped_write",
    terminal: "test_only",
    network: false,
  },
  mandatoryVerification: {
    requireDiffEvidence: true,
    requireTestExecution: true,
  },
});

export const SecurityAuditHarness = inheritHarness(BaseResearchHarness, {
  name: "SecurityAuditHarness",
  role: "security",
  description: "Read-only OWASP Top 10 security auditor with zero production-code write access.",
  additionalInstructions: [
    "Every vulnerability finding must reference an exact file path and line number.",
    "Distinguish confirmed exploitable vulnerabilities from potential risks.",
    "Do not invent findings; disclose any files or directories not inspected.",
  ],
  contextStrategy: "broad_audit",
});

export const RepositoryAnalystHarness = inheritHarness(BaseResearchHarness, {
  name: "RepositoryAnalystHarness",
  role: "repo_analyst",
  description: "Fast architectural analyst that maps dependencies, entrypoints, and symbols.",
});

export const ResearchHarness = inheritHarness(BaseResearchHarness, {
  name: "ResearchHarness",
  role: "researcher",
  description: "External documentation and API research specialist harness.",
  allowedTools: [...READ_TOOLS, "web_research"],
  permissions: {
    filesystem: "read_only",
    terminal: "none",
    network: true,
  },
});

export const CodeReviewerHarness = inheritHarness(BaseResearchHarness, {
  name: "CodeReviewerHarness",
  role: "reviewer",
  description: "Independent read-only code reviewer evaluating quality, correctness, and tests.",
  contextStrategy: "diff_focused",
});

export const AdversarialVerifierHarness = inheritHarness(BaseResearchHarness, {
  name: "AdversarialVerifierHarness",
  role: "adversarial_verifier",
  description:
    "Adversarial falsification harness whose sole objective is to disprove completion claims and uncover hidden defects.",
  additionalInstructions: [
    "Treat all worker agent claims as untrusted until proven by EvidenceLedger records and source code.",
    "Actively look for: missing functionality, unhandled edge cases, false test success claims, scope violations, and security regressions.",
    "Start each falsification finding with '- FALSIFIED:' or '- DEFECT:'. If all claims hold under scrutiny, end with 'adversarial_verdict: holds'.",
  ],
  contextStrategy: "diff_focused",
});

export const DocumentationHarness = inheritHarness(BaseCodingHarness, {
  name: "DocumentationHarness",
  role: "documentation",
  description: "Technical documentation and README specialist harness with no terminal access.",
  allowedTools: WRITE_TOOLS,
  permissions: {
    filesystem: "scoped_write",
    terminal: "none",
    network: false,
  },
});

export const BUILTIN_HARNESSES: Record<string, HarnessProfile> = {
  BaseCodingHarness,
  BaseResearchHarness,
  DebuggingHarness,
  RefactoringHarness,
  FrontendHarness,
  BackendHarness,
  DatabaseHarness,
  TestingHarness,
  SecurityAuditHarness,
  RepositoryAnalystHarness,
  ResearchHarness,
  CodeReviewerHarness,
  AdversarialVerifierHarness,
  DocumentationHarness,
};

// ============================================================================
// Intelligent Task + Trajectory Router (Section 8)
// ============================================================================

export interface TrajectorySignals {
  /** Files observed or modified so far */
  touchedFiles?: string[];
  /** Whether a recent build or test command failed */
  hasFailingChecks?: boolean;
  /** Whether error stack traces or compiler errors are present */
  hasErrorTraces?: boolean;
  /** Whether security-sensitive paths (auth, crypto, middleware, permissions) are involved */
  touchesSecurityPaths?: boolean;
  /** Historical lessons mapping task patterns to preferred harness names */
  routingLessons?: Record<string, string[]>;
}

export interface RoutingDecision {
  readonly strategy: "base_fallback" | "single_specialist" | "multi_specialist";
  readonly selectedHarnesses: HarnessProfile[];
  readonly rationale: string;
}

/**
 * Intelligent Harness Router (arXiv:2610.28380 Section 8 & 10).
 * Combines task description, repository intelligence, and observable execution trajectory.
 * Crucially knows when NOT to specialize (falling back to BaseCodingHarness on simple or
 * out-of-distribution tasks to preserve base performance).
 */
export class HarnessRouter {
  private readonly registry = new Map<string, HarnessProfile>(Object.entries(BUILTIN_HARNESSES));

  registerHarness(profile: HarnessProfile): void {
    this.registry.set(profile.name, profile);
  }

  getHarness(name: string): HarnessProfile {
    return this.registry.get(name) ?? BaseCodingHarness;
  }

  listHarnesses(): HarnessProfile[] {
    return [...this.registry.values()];
  }

  route(task: string, project?: ProjectAnalysis, trajectory?: TrajectorySignals): RoutingDecision {
    const lower = task.toLowerCase();
    const touched = (trajectory?.touchedFiles ?? []).join(" ").toLowerCase();

    // 1. Check learned routing lessons from HarnessEvolutionEngine first
    if (trajectory?.routingLessons) {
      for (const [pattern, harnessNames] of Object.entries(trajectory.routingLessons)) {
        if (lower.includes(pattern.toLowerCase())) {
          const matched = harnessNames.map((n) => this.getHarness(n));
          if (matched.length > 0) {
            return {
              strategy: matched.length === 1 ? "single_specialist" : "multi_specialist",
              selectedHarnesses: matched,
              rationale: `Matched evolved routing lesson for pattern "${pattern}" -> [${matched.map((h) => h.name).join(", ")}]`,
            };
          }
        }
      }
    }

    // 2. Out-of-distribution or simple/single-step task -> preserve BaseCodingHarness (Section 10)
    const wordCount = task.trim().split(/\s+/).length;
    const hasSpecialistSignals =
      /\b(debug|fix|error|bug|crash|fail|security|audit|vulnerability|owasp|auth|test|spec|coverage|refactor|frontend|ui|react|next\.js|css|layout|database|sql|schema|migration|docs|readme)\b/i.test(
        lower,
      ) ||
      Boolean(trajectory?.hasFailingChecks) ||
      Boolean(trajectory?.hasErrorTraces) ||
      Boolean(trajectory?.touchesSecurityPaths);

    if (!hasSpecialistSignals || wordCount <= 5) {
      return {
        strategy: "base_fallback",
        selectedHarnesses: [this.getHarness("BaseCodingHarness")],
        rationale:
          "Task is concise or general-purpose with no specialized domain signals; selecting BaseCodingHarness to avoid unnecessary specialization overhead.",
      };
    }

    // 3. Multi-signal Task + Trajectory classification
    const chosen: HarnessProfile[] = [];
    const reasons: string[] = [];

    const addUnique = (name: string, reason: string) => {
      const profile = this.getHarness(name);
      if (!chosen.some((p) => p.name === profile.name)) {
        chosen.push(profile);
        reasons.push(`${profile.name} (${reason})`);
      }
    };

    // Trajectory signal: failing checks or error traces immediately prioritize DebuggingHarness
    if (
      trajectory?.hasFailingChecks ||
      trajectory?.hasErrorTraces ||
      /\b(fix|bug|debug|broken|error|exception|crash|failing)\b/.test(lower)
    ) {
      addUnique(
        "DebuggingHarness",
        trajectory?.hasFailingChecks ? "observed failing check in trajectory" : "debugging intent",
      );
    }

    // Frontend signals (task or project stack + touched files)
    if (
      /\b(frontend|ui|ux|component|page|layout|responsive|css|tailwind|react|next\.js|three\.js|animation)\b/.test(
        lower,
      ) ||
      /\.(tsx|jsx|css|scss)\b/.test(touched) ||
      (project?.frameworks.some((f) => f.includes("Next.js") || f.includes("React")) &&
        /\b(build|create|implement|design|page|hero)\b/.test(lower))
    ) {
      addUnique("FrontendHarness", "frontend/UI component or Next.js workload");
    }

    // Database signals
    if (
      /\b(database|sql|sqlite|postgres|schema|migration|query|orm|prisma|drizzle)\b/.test(lower) ||
      /\b(schema|migration|\.sql)\b/.test(touched)
    ) {
      addUnique("DatabaseHarness", "database/schema/query workload");
    }

    // Backend / Refactoring signals
    if (/\b(refactor|restructure|extract|decouple|cleanup)\b/.test(lower)) {
      addUnique("RefactoringHarness", "structural refactoring intent");
    } else if (
      /\b(api|endpoint|service|controller|middleware|route|backend|server|auth|session|jwt)\b/.test(
        lower,
      )
    ) {
      addUnique("BackendHarness", "backend service/API logic");
    }

    // Security signals (task or trajectory touching auth/security files)
    if (
      trajectory?.touchesSecurityPaths ||
      /\b(auth|login|password|token|jwt|permission|policy|secret|crypto)\b/.test(touched) ||
      /\b(security|audit|vulnerability|secure|hardening|auth|authentication|permission|owasp)\b/.test(
        lower,
      )
    ) {
      addUnique(
        "SecurityAuditHarness",
        trajectory?.touchesSecurityPaths
          ? "trajectory touched security-critical files"
          : "security/authentication requirement",
      );
    }

    // Testing signals
    if (/\b(test|tests|unit test|integration test|coverage|spec|verify)\b/.test(lower)) {
      addUnique("TestingHarness", "explicit testing requirement");
    }

    // Documentation signals
    if (/\b(doc|docs|documentation|readme|changelog)\b/.test(lower) && chosen.length === 0) {
      addUnique("DocumentationHarness", "documentation update");
    }

    if (chosen.length === 0) {
      return {
        strategy: "base_fallback",
        selectedHarnesses: [this.getHarness("BaseCodingHarness")],
        rationale: "Defaulted to BaseCodingHarness.",
      };
    }

    return {
      strategy: chosen.length === 1 ? "single_specialist" : "multi_specialist",
      selectedHarnesses: chosen,
      rationale: `Selected ${chosen.length} harness(es) via task+trajectory routing: ${reasons.join(", ")}`,
    };
  }

  /**
   * Instantiates a formal SpecialistAgentContract from a selected HarnessProfile.
   */
  createContract(
    harness: HarnessProfile,
    options: {
      agentId: string;
      objective: string;
      scope?: string[];
      deliverables?: string[];
    },
  ): SpecialistAgentContract {
    return {
      agentId: options.agentId,
      role: harness.role,
      harnessName: harness.name,
      objective: options.objective,
      scope: options.scope ?? [],
      permissions: { ...harness.permissions },
      allowedTools: [...harness.allowedTools],
      deliverables: options.deliverables ?? [`${options.agentId}-report.json`],
      requirements: [...harness.instructions],
      completionConditions: [
        ...harness.workflowSteps,
        ...(harness.mandatoryVerification.requireDiffEvidence
          ? ["Attach DIFF-* EvidenceLedger IDs for every modified file."]
          : []),
        ...(harness.mandatoryVerification.requireTestExecution
          ? ["Attach passing TEST-RUN-* EvidenceLedger ID."]
          : []),
      ],
      budget: { ...harness.budget },
    };
  }
}

// ============================================================================
// System C: Self-Evolving Harness Engine (Section 9)
// ============================================================================

export type FailureModeKind =
  | "missing_regression_test"
  | "missing_build_verification"
  | "false_security_confirmation"
  | "missing_client_boundary_check"
  | "unverified_file_claim";

export interface ExecutionTelemetryRecord {
  readonly taskId: string;
  readonly harnessName: string;
  readonly verdict: "VERIFIED" | "PARTIALLY_VERIFIED" | "UNVERIFIED" | "REJECTED" | "FAILED";
  readonly failureModes: FailureModeKind[];
}

export interface EvolutionProposal {
  readonly baseHarnessName: string;
  readonly evolvedHarness: HarnessProfile;
  readonly addressedFailureModes: FailureModeKind[];
  readonly discoveryScoreBefore: number;
  readonly discoveryScoreAfter: number;
  readonly heldOutScoreBefore: number;
  readonly heldOutScoreAfter: number;
  readonly promoted: boolean;
}

/**
 * Self-Evolving Harness Engine (arXiv:2610.28380 Section 9).
 * Analyzes execution telemetry to detect recurring harness failure patterns, synthesizes
 * an evolved child HarnessProfile (`<Name>V2`), and gates promotion on held-out evaluation
 * so production agents never self-modify without empirical improvement.
 */
export class HarnessEvolutionEngine {
  private readonly history: ExecutionTelemetryRecord[] = [];

  recordExecution(entry: ExecutionTelemetryRecord): void {
    this.history.push(entry);
  }

  getHistory(): readonly ExecutionTelemetryRecord[] {
    return this.history;
  }

  /**
   * Analyzes failure modes for `harnessName` and synthesizes an evolved harness if
   * recurring failures exist. Evaluates on discovery & held-out scores before promoting.
   */
  proposeAndEvaluate(
    baseHarness: HarnessProfile,
    evalBenchmark: {
      discoveryScoreBefore: number;
      discoveryScoreAfter: number;
      heldOutScoreBefore: number;
      heldOutScoreAfter: number;
    },
    router?: HarnessRouter,
  ): EvolutionProposal {
    const records = this.history.filter((r) => r.harnessName === baseHarness.name);
    const modeCounts = new Map<FailureModeKind, number>();
    for (const rec of records) {
      for (const fm of rec.failureModes) {
        modeCounts.set(fm, (modeCounts.get(fm) ?? 0) + 1);
      }
    }

    const addressed = [...modeCounts.keys()];
    const additionalInstructions: string[] = [];
    const workflowSteps = [...baseHarness.workflowSteps];
    const mandatoryVerification = { ...baseHarness.mandatoryVerification };

    if (addressed.includes("missing_regression_test")) {
      additionalInstructions.push(
        "[Evolved Rule] You MUST reproduce the original failure and execute a regression test before claiming completion.",
      );
      workflowSteps.push(
        `${workflowSteps.length + 1}. Execute regression test and attach TEST-RUN-* evidence ID.`,
      );
      mandatoryVerification.requireTestExecution = true;
    }

    if (addressed.includes("missing_build_verification")) {
      additionalInstructions.push(
        "[Evolved Rule] You MUST run the production build / typecheck command and attach BUILD-RUN-* evidence.",
      );
      mandatoryVerification.requireBuildExecution = true;
    }

    if (addressed.includes("missing_client_boundary_check")) {
      additionalInstructions.push(
        "[Evolved Rule] Verify every edited React/Next.js component passes instant static verification with zero client-boundary errors.",
      );
      mandatoryVerification.requireStaticVerifyClean = true;
    }

    if (addressed.includes("false_security_confirmation")) {
      additionalInstructions.push(
        "[Evolved Rule] Never mark a vulnerability as confirmed without a concrete file:line sink and SAST-SCAN-* evidence.",
      );
      mandatoryVerification.requireSastClean = true;
    }

    const nextVersion = baseHarness.version + 1;
    const evolvedName = `${baseHarness.name.replace(/V\d+$/, "")}V${nextVersion}`;
    const evolvedHarness = inheritHarness(baseHarness, {
      name: evolvedName,
      version: nextVersion,
      description: `${baseHarness.description} (Evolved v${nextVersion} addressing: ${addressed.join(", ") || "refinement"})`,
      additionalInstructions,
      workflowSteps,
      mandatoryVerification,
    });

    // Only promote if BOTH discovery and held-out benchmark scores strictly improve (or hold without regression)
    const promoted =
      evalBenchmark.discoveryScoreAfter > evalBenchmark.discoveryScoreBefore &&
      evalBenchmark.heldOutScoreAfter >= evalBenchmark.heldOutScoreBefore;

    if (promoted && router) {
      router.registerHarness(evolvedHarness);
    }

    return {
      baseHarnessName: baseHarness.name,
      evolvedHarness,
      addressedFailureModes: addressed,
      ...evalBenchmark,
      promoted,
    };
  }
}
