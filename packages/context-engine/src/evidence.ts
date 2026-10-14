import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ContextEvidence, ContextKind, TrustLevel } from "@terminus/shared";
import { sha256 } from "@terminus/shared";

export interface EvidenceInput {
  kind: ContextKind;
  source: string;
  content: string;
  startLine?: number;
  endLine?: number;
  relevance?: number;
  trustLevel?: TrustLevel;
}

export type Freshness = "fresh" | "stale" | "missing" | "unknown";

export class EvidenceStore {
  private items = new Map<string, ContextEvidence>();
  private observed = new Map<string, string>();

  add(input: EvidenceInput): ContextEvidence {
    const item: ContextEvidence = {
      id: randomUUID(),
      kind: input.kind,
      source: input.source,
      content: input.content,
      startLine: input.startLine,
      endLine: input.endLine,
      contentHash: sha256(input.content),
      relevance: input.relevance ?? 0.5,
      trustLevel: input.trustLevel ?? "untrusted",
      createdAt: Date.now(),
      stale: false,
    };
    this.items.set(item.id, item);
    return item;
  }

  get(id: string): ContextEvidence | undefined {
    return this.items.get(id);
  }

  all(): ContextEvidence[] {
    return [...this.items.values()];
  }

  markStale(id: string): void {
    const item = this.items.get(id);
    if (item) item.stale = true;
  }

  recordRead(workspaceRoot: string, path: string, content: string): void {
    this.observed.set(resolve(workspaceRoot, path), sha256(content));
  }

  checkFresh(workspaceRoot: string, path: string): Freshness {
    const key = resolve(workspaceRoot, path);
    const known = this.observed.get(key);
    if (known === undefined) return "unknown";
    let current: string;
    try {
      current = readFileSync(key, "utf8");
    } catch {
      return "missing";
    }
    return sha256(current) === known ? "fresh" : "stale";
  }

  invalidate(path: string): void {
    for (const key of this.observed.keys()) {
      if (key.endsWith(path)) this.observed.delete(key);
    }
  }

  select(options: { maxChars: number; focus?: string }): ContextEvidence[] {
    const focus = options.focus?.toLowerCase();
    const ranked = this.all()
      .filter((item) => !item.stale)
      .map((item) => {
        const boost = item.kind === "instruction" ? 100 : 0;
        const match =
          focus &&
          (item.source.toLowerCase().includes(focus) || item.content.toLowerCase().includes(focus))
            ? 0.5
            : 0;
        return { item, score: item.relevance + boost + match };
      })
      .sort((a, b) => b.score - a.score || a.item.createdAt - b.item.createdAt);

    const picked: ContextEvidence[] = [];
    let used = 0;
    for (const { item } of ranked) {
      if (used + item.content.length > options.maxChars && picked.length > 0) continue;
      picked.push(item);
      used += item.content.length;
    }
    return picked;
  }
}
