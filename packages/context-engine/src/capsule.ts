import type { EvidenceStore } from "./evidence";

/**
 * ContextCapsule represents a token-efficient, structured context transfer unit.
 *
 * Lineage & References:
 * - Format inspired by Jake Werner's Context Capsule:
 *   G:<goal>|T:<topic>|E:<entities>|I:<instructions>|C:<constraints>|SUM:<summary>
 * - Anchored extension based on EMNLP 2026 survey (Wang et al.):
 *   "Context Compression for LLM Agents: A Survey of Methods, Failure Modes, and Evaluation"
 *   Defends against F1 (pre-compression dependency loss), F2 (in-compression information loss),
 *   and F3 (post-compression access / staleness failure) by binding verbatim content hashes
 *   and active verifier states directly to the capsule.
 */
export interface ContextCapsule {
  /** User's primary objective (1-5 words) */
  goal: string;
  /** Primary subject or domain (1-3 words) */
  topic: string;
  /** Key files, symbols, or modules (up to 5 items) */
  entities: string[];
  /** Most critical or active directive (5-10 words) */
  instructions: string;
  /** Invariant constraints (e.g. "workspace-only", "re-verify", "no-secrets") */
  constraints: string[];
  /** High-density distillation of state and decisions (10-15 words) */
  summary: string;
  /** Verbatim content hash anchors (path#sha256[:7]) to defeat F2/F3 loss */
  anchors?: Array<{ path: string; hashPrefix: string }>;
  /** Verification status of critical checks to defeat F1 early-termination */
  verification?: {
    passed: string[];
    failed: string[];
  };
}

export interface CapsuleValidation {
  valid: boolean;
  errors: string[];
}

export interface HydratedCapsule {
  prompt: string;
  constraints: string[];
  staleAnchors: string[];
}

/**
 * Serializes a structured ContextCapsule into a single-line, token-efficient string.
 * Reduces ~4,000 tokens of raw context into ~30-50 tokens.
 */
export function serializeCapsule(capsule: ContextCapsule): string {
  const parts: string[] = [
    `G:${capsule.goal.trim()}`,
    `T:${capsule.topic.trim()}`,
    `E:${capsule.entities
      .map((e) => e.trim())
      .filter(Boolean)
      .join(",")}`,
    `I:${capsule.instructions.trim()}`,
    `C:${capsule.constraints
      .map((c) => c.trim())
      .filter(Boolean)
      .join(",")}`,
  ];

  if (capsule.anchors && capsule.anchors.length > 0) {
    const anchorStr = capsule.anchors.map((a) => `${a.path}#${a.hashPrefix}`).join(",");
    parts.push(`A:${anchorStr}`);
  }

  if (capsule.verification) {
    const vParts: string[] = [];
    if (capsule.verification.passed.length > 0) {
      vParts.push(`pass:${capsule.verification.passed.join(",")}`);
    }
    if (capsule.verification.failed.length > 0) {
      vParts.push(`fail:${capsule.verification.failed.join(",")}`);
    }
    if (vParts.length > 0) {
      parts.push(`V:${vParts.join(";")}`);
    }
  }

  parts.push(`SUM:${capsule.summary.trim()}`);
  return `Capsule: ${parts.join("|")}`;
}

/**
 * Parses a serialized context capsule into a typed ContextCapsule.
 * Tolerant of whitespace, optional fields, and key-value ordering.
 */
export function parseCapsule(raw: string): ContextCapsule | null {
  const text = raw.trim();
  const match = text.match(/(?:^|\n)\s*Capsule:\s*(.+)$/i);
  const body = match?.[1] ?? text;
  if (!body?.includes("|")) return null;

  const fields = new Map<string, string>();
  for (const token of body.split("|")) {
    const colonIdx = token.indexOf(":");
    if (colonIdx > 0) {
      const key = token.slice(0, colonIdx).trim().toUpperCase();
      const val = token.slice(colonIdx + 1).trim();
      fields.set(key, val);
    }
  }

  const goal = fields.get("G");
  const topic = fields.get("T");
  const summary = fields.get("SUM");
  if (!goal || !topic || !summary) return null;

  const entities = (fields.get("E") ?? "")
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean);

  const instructions = fields.get("I") ?? "";
  const constraints = (fields.get("C") ?? "")
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean);

  const anchors: Array<{ path: string; hashPrefix: string }> = [];
  const rawAnchors = fields.get("A");
  if (rawAnchors) {
    for (const item of rawAnchors.split(",")) {
      const [path, hashPrefix] = item.split("#");
      if (path && hashPrefix) {
        anchors.push({ path: path.trim(), hashPrefix: hashPrefix.trim() });
      }
    }
  }

  let verification: ContextCapsule["verification"];
  const rawV = fields.get("V");
  if (rawV) {
    const passed: string[] = [];
    const failed: string[] = [];
    for (const section of rawV.split(";")) {
      if (section.startsWith("pass:")) {
        passed.push(
          ...section
            .slice(5)
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
        );
      } else if (section.startsWith("fail:")) {
        failed.push(
          ...section
            .slice(5)
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
        );
      }
    }
    if (passed.length > 0 || failed.length > 0) {
      verification = { passed, failed };
    }
  }

  return {
    goal,
    topic,
    entities,
    instructions,
    constraints,
    summary,
    ...(anchors.length > 0 ? { anchors } : {}),
    ...(verification ? { verification } : {}),
  };
}

/**
 * Validates a capsule against token-efficiency and structural soundness constraints.
 */
export function validateCapsule(capsule: ContextCapsule): CapsuleValidation {
  const errors: string[] = [];
  if (!capsule.goal || capsule.goal.length === 0) errors.push("goal must not be empty");
  if (!capsule.topic || capsule.topic.length === 0) errors.push("topic must not be empty");
  if (!capsule.summary || capsule.summary.length === 0) errors.push("summary must not be empty");
  if (capsule.entities.length > 10) {
    errors.push(`entities count exceeds 10 (${capsule.entities.length})`);
  }
  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Programmatically packages an active task, its evidence store, and its verification state
 * into an Anchored Context Capsule without losing evidence provenance.
 */
export function encapsulateContext(params: {
  goal: string;
  topic: string;
  instructions: string;
  summary: string;
  constraints?: string[];
  entities?: string[];
  evidence?: EvidenceStore;
  checks?: Array<{ command: string; passed: boolean }>;
}): ContextCapsule {
  const constraints = params.constraints ?? ["workspace-only", "re-verify"];
  const entities = [...(params.entities ?? [])];

  const anchors: Array<{ path: string; hashPrefix: string }> = [];
  if (params.evidence) {
    const items = params.evidence.all();
    for (const item of items) {
      if (item.kind === "source" && !item.stale) {
        if (!entities.includes(item.source) && entities.length < 5) {
          entities.push(item.source);
        }
        if (item.contentHash && anchors.length < 5) {
          anchors.push({
            path: item.source,
            hashPrefix: item.contentHash.slice(0, 7),
          });
        }
      }
    }
  }

  let verification: ContextCapsule["verification"];
  if (params.checks && params.checks.length > 0) {
    const passed = params.checks.filter((c) => c.passed).map((c) => c.command);
    const failed = params.checks.filter((c) => !c.passed).map((c) => c.command);
    verification = { passed, failed };
  }

  return {
    goal: params.goal,
    topic: params.topic,
    entities: entities.slice(0, 5),
    instructions: params.instructions,
    constraints,
    summary: params.summary,
    ...(anchors.length > 0 ? { anchors } : {}),
    ...(verification ? { verification } : {}),
  };
}

/**
 * Hydrates a capsule into an actionable context prompt snippet.
 * Checks anchor freshness against the EvidenceStore/workspace to alert of any F3 staleness.
 */
export function hydrateCapsule(
  capsule: ContextCapsule,
  workspaceRoot?: string,
  evidence?: EvidenceStore,
): HydratedCapsule {
  const staleAnchors: string[] = [];

  if (workspaceRoot && evidence && capsule.anchors) {
    for (const anchor of capsule.anchors) {
      const freshness = evidence.checkFresh(workspaceRoot, anchor.path);
      if (freshness === "stale" || freshness === "missing") {
        staleAnchors.push(anchor.path);
      }
    }
  }

  const lines = [
    `[Context Capsule: ${capsule.goal} (${capsule.topic})]`,
    `Summary: ${capsule.summary}`,
    `Instructions: ${capsule.instructions}`,
  ];

  if (capsule.entities.length > 0) {
    lines.push(`Active Entities: ${capsule.entities.join(", ")}`);
  }

  if (capsule.constraints.length > 0) {
    lines.push(`Enforced Constraints: ${capsule.constraints.join(", ")}`);
  }

  if (capsule.verification) {
    const vStr = [
      capsule.verification.passed.length > 0
        ? `Passing: ${capsule.verification.passed.join("; ")}`
        : null,
      capsule.verification.failed.length > 0
        ? `Failing: ${capsule.verification.failed.join("; ")}`
        : null,
    ]
      .filter(Boolean)
      .join(" | ");
    lines.push(`Verification State: ${vStr}`);
  }

  if (staleAnchors.length > 0) {
    lines.push(
      `⚠️ Stale Anchors: [${staleAnchors.join(", ")}] have changed since capsule generation and must be re-read.`,
    );
  }

  return {
    prompt: lines.join("\n"),
    constraints: capsule.constraints,
    staleAnchors,
  };
}
