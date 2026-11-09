import { createHash } from "node:crypto";

export type EvidenceRecordKind =
  | "DIFF"
  | "FILE_HASH"
  | "CMD_RUN"
  | "TEST_RUN"
  | "BUILD_RUN"
  | "SAST_SCAN"
  | "STATIC_VERIFY";

export interface EvidenceRecord {
  /** Deterministic runtime-assigned ID, e.g. DIFF-001, TEST-RUN-002 */
  readonly id: string;
  readonly kind: EvidenceRecordKind;
  readonly agentId: string;
  readonly timestamp: number;
  /** Target file path, command string, or scan scope */
  readonly subject: string;
  readonly passed: boolean;
  readonly exitCode?: number;
  readonly summary: string;
  readonly rawOutput: string;
  /** SHA-256 of the raw output / file content */
  readonly contentHash: string;
  /** Tamper-evident hash chaining this record to the previous record in the ledger */
  readonly chainHash: string;
}

const sha256 = (data: string): string => createHash("sha256").update(data).digest("hex");

const KIND_PREFIX: Record<EvidenceRecordKind, string> = {
  DIFF: "DIFF",
  FILE_HASH: "FILE-HASH",
  CMD_RUN: "CMD-RUN",
  TEST_RUN: "TEST-RUN",
  BUILD_RUN: "BUILD-RUN",
  SAST_SCAN: "SAST-SCAN",
  STATIC_VERIFY: "STATIC-VERIFY",
};

/**
 * Append-only, tamper-evident execution ledger owned exclusively by the Orchestrator's
 * tool-execution runtime. Agents can reference EvidenceRecord IDs in their claims,
 * but cannot forge or mutate records in this ledger.
 */
export class EvidenceLedger {
  private readonly records: EvidenceRecord[] = [];
  private readonly byId = new Map<string, EvidenceRecord>();
  private readonly counters = new Map<EvidenceRecordKind, number>();
  private lastChainHash = "0".repeat(64);

  private mintId(kind: EvidenceRecordKind): string {
    const next = (this.counters.get(kind) ?? 0) + 1;
    this.counters.set(kind, next);
    return `${KIND_PREFIX[kind]}-${String(next).padStart(3, "0")}`;
  }

  append(input: {
    kind: EvidenceRecordKind;
    agentId: string;
    subject: string;
    passed: boolean;
    exitCode?: number;
    summary: string;
    rawOutput: string;
  }): EvidenceRecord {
    const id = this.mintId(input.kind);
    const timestamp = Date.now();
    const contentHash = sha256(input.rawOutput);
    const chainPayload = `${this.lastChainHash}|${id}|${input.kind}|${input.agentId}|${input.subject}|${input.passed}|${input.exitCode ?? ""}|${contentHash}`;
    const chainHash = sha256(chainPayload);
    this.lastChainHash = chainHash;

    const record: EvidenceRecord = Object.freeze({
      id,
      kind: input.kind,
      agentId: input.agentId,
      timestamp,
      subject: input.subject,
      passed: input.passed,
      exitCode: input.exitCode,
      summary: input.summary,
      rawOutput: input.rawOutput,
      contentHash,
      chainHash,
    });

    this.records.push(record);
    this.byId.set(id, record);
    return record;
  }

  recordFileDiff(
    agentId: string,
    filePath: string,
    beforeContent: string | null,
    afterContent: string,
  ): EvidenceRecord {
    const summary =
      beforeContent === null
        ? `created ${filePath} (${afterContent.length} chars)`
        : `modified ${filePath} (${beforeContent.length} -> ${afterContent.length} chars)`;
    return this.append({
      kind: "DIFF",
      agentId,
      subject: filePath,
      passed: true,
      summary,
      rawOutput: afterContent,
    });
  }

  recordFileInspection(agentId: string, filePath: string, content: string): EvidenceRecord {
    return this.append({
      kind: "FILE_HASH",
      agentId,
      subject: filePath,
      passed: true,
      summary: `inspected ${filePath} (sha256:${sha256(content).slice(0, 12)})`,
      rawOutput: content,
    });
  }

  recordCommandExecution(
    agentId: string,
    command: string,
    exitCode: number,
    output: string,
  ): EvidenceRecord {
    const isTest = /\b(test|vitest|jest|pytest|mocha)\b/i.test(command);
    const isBuild = /\b(build|tsc|typecheck|compile)\b/i.test(command);
    const kind: EvidenceRecordKind = isTest ? "TEST_RUN" : isBuild ? "BUILD_RUN" : "CMD_RUN";
    return this.append({
      kind,
      agentId,
      subject: command,
      passed: exitCode === 0,
      exitCode,
      summary: `${command} (exit ${exitCode})`,
      rawOutput: output,
    });
  }

  recordSastScan(
    agentId: string,
    scopeLabel: string,
    severeCount: number,
    details: string,
  ): EvidenceRecord {
    return this.append({
      kind: "SAST_SCAN",
      agentId,
      subject: scopeLabel,
      passed: severeCount === 0,
      summary: `SAST scan on ${scopeLabel}: ${severeCount} blocker/major finding(s)`,
      rawOutput: details,
    });
  }

  recordStaticVerification(
    agentId: string,
    filePath: string,
    issueCount: number,
    details: string,
  ): EvidenceRecord {
    return this.append({
      kind: "STATIC_VERIFY",
      agentId,
      subject: filePath,
      passed: issueCount === 0,
      summary: `static verifier on ${filePath}: ${issueCount} issue(s)`,
      rawOutput: details,
    });
  }

  get(id: string): EvidenceRecord | undefined {
    return this.byId.get(id);
  }

  all(): readonly EvidenceRecord[] {
    return this.records;
  }

  byAgent(agentId: string): EvidenceRecord[] {
    return this.records.filter((r) => r.agentId === agentId);
  }

  byKind(kind: EvidenceRecordKind): EvidenceRecord[] {
    return this.records.filter((r) => r.kind === kind);
  }

  /**
   * Cryptographically verifies that the hash chain of the entire ledger is intact
   * and no record has been tampered with since creation.
   */
  verifyIntegrity(): { valid: boolean; brokenAtId?: string } {
    let prevHash = "0".repeat(64);
    for (const rec of this.records) {
      const expectedContentHash = sha256(rec.rawOutput);
      if (expectedContentHash !== rec.contentHash) {
        return { valid: false, brokenAtId: rec.id };
      }
      const chainPayload = `${prevHash}|${rec.id}|${rec.kind}|${rec.agentId}|${rec.subject}|${rec.passed}|${rec.exitCode ?? ""}|${rec.contentHash}`;
      const expectedChainHash = sha256(chainPayload);
      if (expectedChainHash !== rec.chainHash) {
        return { valid: false, brokenAtId: rec.id };
      }
      prevHash = rec.chainHash;
    }
    return { valid: true };
  }
}
