import { createHash } from "node:crypto";

export type ContextKind =
  | "source"
  | "instruction"
  | "documentation"
  | "terminal"
  | "test_result"
  | "git_change"
  | "decision";

export type TrustLevel = "trusted" | "untrusted";

export interface ContextEvidence {
  id: string;
  kind: ContextKind;
  source: string;
  content: string;
  startLine?: number;
  endLine?: number;
  contentHash: string;
  relevance: number;
  trustLevel: TrustLevel;
  createdAt: number;
  stale: boolean;
}

export const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");
