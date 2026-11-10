import type { AttackCategory, AttackExecutionResult, ResolvedVector } from "./types";

export interface SecurityGraphEdge {
  from: string;
  to: string;
  relation: "FLOWS_TO" | "EXPOSES" | "BYPASSES" | "ESCALATES_TO";
  cost: number;
  evidenceId?: string;
}

export interface RiskPathSuggestion {
  nodes: string[];
  edges: SecurityGraphEdge[];
  totalCost: number;
}

const RELATION_DEFAULT_COSTS: Record<SecurityGraphEdge["relation"], number> = {
  BYPASSES: 10,
  ESCALATES_TO: 15,
  EXPOSES: 20,
  FLOWS_TO: 30,
};

/**
 * Shared typed world state across Red/Blue execution waves.
 * Records confirmed exposures, relationships, and resolved dead-end vectors
 * so parallel agents do not re-attempt settled vectors.
 */
export class FindingWorldState {
  private readonly nodes = new Set<string>();
  private readonly edges: SecurityGraphEdge[] = [];
  private readonly findings = new Map<string, AttackExecutionResult>();
  private readonly resolvedVectors: ResolvedVector[] = [];

  recordExecutionResult(target: string, vector: string, result: AttackExecutionResult): void {
    const cleanTarget = target.trim();
    this.nodes.add(cleanTarget);
    this.findings.set(result.hypothesisId, result);

    if (result.outcome === "blocked") {
      this.recordResolvedVector(
        cleanTarget,
        result.category,
        vector,
        result.observedExecutionTrace,
      );
    } else if (result.outcome === "exploited") {
      const findingNode = `finding:${result.hypothesisId}`;
      this.nodes.add(findingNode);
      this.addEdge(cleanTarget, findingNode, "EXPOSES", result.evidenceRecordId);
    }
  }

  recordResolvedVector(
    target: string,
    category: AttackCategory,
    vector: string,
    reason: string,
  ): void {
    const existing = this.matchResolvedVector(target, vector);
    if (existing) return;
    this.resolvedVectors.push({
      target,
      category,
      vector,
      status: "resolved",
      reason,
      recordedAt: Date.now(),
    });
  }

  /**
   * Conservative dead-end matching: blocks duplicate testing only when the vector
   * is explicitly resolved as safe/blocked and both target and vector clearly overlap.
   */
  matchResolvedVector(target: string, vector: string): ResolvedVector | undefined {
    const t = target.trim().toLowerCase();
    const v = vector.trim().toLowerCase();
    if (!t || !v) return undefined;

    for (const item of this.resolvedVectors) {
      if (item.status !== "resolved") continue;
      const it = item.target.trim().toLowerCase();
      const iv = item.vector.trim().toLowerCase();
      const targetMatch = it === t || it.includes(t) || t.includes(it);
      const vectorMatch = iv === v || (iv.length >= 6 && (iv.includes(v) || v.includes(iv)));
      if (targetMatch && vectorMatch) {
        return item;
      }
    }
    return undefined;
  }

  addEdge(
    from: string,
    to: string,
    relation: SecurityGraphEdge["relation"],
    evidenceId?: string,
    customCost?: number,
  ): void {
    this.nodes.add(from);
    this.nodes.add(to);
    this.edges.push({
      from,
      to,
      relation,
      cost: customCost ?? RELATION_DEFAULT_COSTS[relation],
      evidenceId,
    });
  }

  /**
   * Dijkstra shortest-cost escalation path finder between an entry surface and target node.
   */
  findLowestCostAttackPath(startNode: string, goalNode: string): RiskPathSuggestion | null {
    if (!this.nodes.has(startNode) || !this.nodes.has(goalNode)) return null;

    const dist = new Map<string, number>();
    const prevNode = new Map<string, string>();
    const prevEdge = new Map<string, SecurityGraphEdge>();
    const unvisited = new Set<string>(this.nodes);

    for (const node of this.nodes) {
      dist.set(node, node === startNode ? 0 : Number.POSITIVE_INFINITY);
    }

    while (unvisited.size > 0) {
      let current: string | null = null;
      let bestDist = Number.POSITIVE_INFINITY;
      for (const n of unvisited) {
        const d = dist.get(n) ?? Number.POSITIVE_INFINITY;
        if (d < bestDist) {
          bestDist = d;
          current = n;
        }
      }
      if (!current || bestDist === Number.POSITIVE_INFINITY) break;
      if (current === goalNode) break;
      unvisited.delete(current);

      for (const edge of this.edges) {
        if (edge.from !== current || !unvisited.has(edge.to)) continue;
        const alt = bestDist + edge.cost;
        if (alt < (dist.get(edge.to) ?? Number.POSITIVE_INFINITY)) {
          dist.set(edge.to, alt);
          prevNode.set(edge.to, current);
          prevEdge.set(edge.to, edge);
        }
      }
    }

    const totalCost = dist.get(goalNode) ?? Number.POSITIVE_INFINITY;
    if (!Number.isFinite(totalCost)) return null;

    const nodes: string[] = [];
    const edges: SecurityGraphEdge[] = [];
    let cursor: string | undefined = goalNode;
    while (cursor) {
      nodes.unshift(cursor);
      const e = prevEdge.get(cursor);
      if (e) edges.unshift(e);
      cursor = prevNode.get(cursor);
    }

    return { nodes, edges, totalCost };
  }

  getResolvedVectors(): readonly ResolvedVector[] {
    return this.resolvedVectors;
  }

  getAllFindings(): AttackExecutionResult[] {
    return [...this.findings.values()];
  }
}
