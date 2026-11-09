export interface ModelPricing {
  /** USD per 1M input tokens */
  inputPerMillion: number;
  /** USD per 1M output tokens */
  outputPerMillion: number;
}

const MODEL_PRICING_TABLE: Record<string, ModelPricing> = {
  "nvidia/nemotron-3-super-120b-a12b": { inputPerMillion: 0.3, outputPerMillion: 0.9 },
  "claude-sonnet-4-5": { inputPerMillion: 3.0, outputPerMillion: 15.0 },
  "claude-opus-4-5": { inputPerMillion: 15.0, outputPerMillion: 75.0 },
  "claude-haiku-3-5": { inputPerMillion: 0.8, outputPerMillion: 4.0 },
  "gpt-4o": { inputPerMillion: 2.5, outputPerMillion: 10.0 },
  "gpt-4o-mini": { inputPerMillion: 0.15, outputPerMillion: 0.6 },
  "gemini-2.5-pro": { inputPerMillion: 1.25, outputPerMillion: 10.0 },
  "gemini-2.5-flash": { inputPerMillion: 0.15, outputPerMillion: 0.6 },
};

const DEFAULT_PRICING: ModelPricing = { inputPerMillion: 0.5, outputPerMillion: 1.5 };

export function estimateCostUsd(
  promptTokens: number,
  completionTokens: number,
  model?: string,
): number {
  const key = model
    ? Object.keys(MODEL_PRICING_TABLE).find((k) => model.toLowerCase().includes(k.toLowerCase()))
    : undefined;
  const pricing = (key ? MODEL_PRICING_TABLE[key] : undefined) ?? DEFAULT_PRICING;
  const inputCost = (promptTokens / 1_000_000) * pricing.inputPerMillion;
  const outputCost = (completionTokens / 1_000_000) * pricing.outputPerMillion;
  return Number((inputCost + outputCost).toFixed(6));
}

export interface BudgetSnapshot {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  calls: number;
  estimatedCostUsd: number;
  maxTokens?: number;
  maxCostUsd?: number;
  exceeded: boolean;
  exceededReason?: string;
}

export class BudgetTracker {
  private promptTokens = 0;
  private completionTokens = 0;
  private calls = 0;
  private maxTokens?: number;
  private maxCostUsd?: number;
  private model?: string;

  constructor(options: { maxTokens?: number; maxCostUsd?: number; model?: string } = {}) {
    this.maxTokens = options.maxTokens;
    this.maxCostUsd = options.maxCostUsd;
    this.model = options.model;
  }

  record(prompt: number, completion: number): BudgetSnapshot {
    this.promptTokens += prompt;
    this.completionTokens += completion;
    this.calls += 1;
    return this.snapshot();
  }

  setLimits(limits: { maxTokens?: number; maxCostUsd?: number }): void {
    if (limits.maxTokens !== undefined) this.maxTokens = limits.maxTokens;
    if (limits.maxCostUsd !== undefined) this.maxCostUsd = limits.maxCostUsd;
  }

  reset(): void {
    this.promptTokens = 0;
    this.completionTokens = 0;
    this.calls = 0;
  }

  snapshot(): BudgetSnapshot {
    const totalTokens = this.promptTokens + this.completionTokens;
    const estimatedCostUsd = estimateCostUsd(this.promptTokens, this.completionTokens, this.model);
    let exceeded = false;
    let exceededReason: string | undefined;

    if (this.maxTokens !== undefined && totalTokens > this.maxTokens) {
      exceeded = true;
      exceededReason = `Token budget exceeded (${totalTokens.toLocaleString()} > ${this.maxTokens.toLocaleString()} tokens)`;
    } else if (this.maxCostUsd !== undefined && estimatedCostUsd > this.maxCostUsd) {
      exceeded = true;
      exceededReason = `Cost budget exceeded ($${estimatedCostUsd.toFixed(4)} > $${this.maxCostUsd.toFixed(4)})`;
    }

    return {
      promptTokens: this.promptTokens,
      completionTokens: this.completionTokens,
      totalTokens,
      calls: this.calls,
      estimatedCostUsd,
      maxTokens: this.maxTokens,
      maxCostUsd: this.maxCostUsd,
      exceeded,
      exceededReason,
    };
  }
}

export type ModelTier = "fast" | "balanced" | "reasoning";

export function classifyTaskTier(task: string, mode: string): ModelTier {
  if (mode === "ask") return "fast";
  if (mode === "audit" || mode === "plan") return "reasoning";
  const lower = task.toLowerCase();
  if (
    /\b(architect|security|audit|refactor|migrate|complex|multi-page|full-stack|benchmark)\b/.test(
      lower,
    ) ||
    task.length > 500
  ) {
    return "reasoning";
  }
  if (/\b(typo|rename|format|comment|bump|version)\b/.test(lower) && task.length < 120) {
    return "fast";
  }
  return "balanced";
}
