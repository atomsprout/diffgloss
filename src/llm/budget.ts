import type { CostSummary } from "../schema/types.ts";
import type { LLMUsage, ModelPricePerMillion } from "./types.ts";

const DEFAULT_PRICE: ModelPricePerMillion = {
  input: 3.0,
  output: 15.0,
  cachedInput: 0.3,
};

/**
 * Conservative USD per 1M token pricing table used for pre-run dry-run estimates
 * and runtime hard budget enforcement.
 */
const MODEL_PRICING: Array<[RegExp, ModelPricePerMillion]> = [
  [/claude.*opus/i, { input: 15.0, output: 75.0, cachedInput: 1.5 }],
  [/claude.*sonnet/i, { input: 3.0, output: 15.0, cachedInput: 0.3 }],
  [/claude.*haiku/i, { input: 0.8, output: 4.0, cachedInput: 0.08 }],
  [/gpt-5.*mini|o4-mini|gpt-4o-mini/i, { input: 0.25, output: 2.0, cachedInput: 0.05 }],
  [/gpt-5|gpt-4\.1|gpt-4o|o3/i, { input: 2.5, output: 10.0, cachedInput: 0.625 }],
  [/gemini.*flash/i, { input: 0.15, output: 0.6, cachedInput: 0.04 }],
  [/gemini.*pro/i, { input: 1.25, output: 10.0, cachedInput: 0.31 }],
  [/deepseek/i, { input: 0.27, output: 1.1, cachedInput: 0.07 }],
  [/mock/i, { input: 0.0, output: 0.0, cachedInput: 0.0 }],
];

export function getModelPricing(model: string): ModelPricePerMillion {
  for (const [pattern, price] of MODEL_PRICING) {
    if (pattern.test(model)) return price;
  }
  return DEFAULT_PRICE;
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.8);
}

export function calculateUsageUsd(model: string, usage: LLMUsage): number {
  const price = getModelPricing(model);
  const nonCached = Math.max(0, usage.inputTokens - usage.cachedInputTokens);
  const cost =
    (nonCached / 1_000_000) * price.input +
    (usage.cachedInputTokens / 1_000_000) * price.cachedInput +
    (usage.outputTokens / 1_000_000) * price.output;
  return Number(cost.toFixed(6));
}

export class BudgetExceededError extends Error {
  readonly spentUsd: number;
  readonly budgetUsd: number;
  readonly estimatedNextUsd: number;

  constructor(
    spentUsd: number,
    budgetUsd: number,
    estimatedNextUsd: number,
  ) {
    super(
      `Diffgloss budget cap reached: spent $${spentUsd.toFixed(4)} + next call ~$${estimatedNextUsd.toFixed(4)} exceeds limit $${budgetUsd.toFixed(2)}.`,
    );
    this.name = "BudgetExceededError";
    this.spentUsd = spentUsd;
    this.budgetUsd = budgetUsd;
    this.estimatedNextUsd = estimatedNextUsd;
  }
}

export class BudgetTracker {
  private readonly provider: string;
  private readonly model: string;
  private readonly budgetUsd: number;
  private readonly judgeModel?: string;
  private inputTokens = 0;
  private outputTokens = 0;
  private cachedInputTokens = 0;
  private spentUsd = 0;
  private exceeded = false;

  constructor(
    provider: string,
    model: string,
    budgetUsd: number,
    judgeModel?: string,
  ) {
    this.provider = provider;
    this.model = model;
    this.budgetUsd = budgetUsd;
    this.judgeModel = judgeModel;
  }

  checkBeforeCall(model: string, promptText: string, expectedOutputTokens = 1500): void {
    const estInput = estimateTokens(promptText);
    const estCost = calculateUsageUsd(model, {
      inputTokens: estInput,
      outputTokens: expectedOutputTokens,
      cachedInputTokens: 0,
    });
    if (this.budgetUsd > 0 && this.spentUsd + estCost > this.budgetUsd) {
      this.exceeded = true;
      throw new BudgetExceededError(this.spentUsd, this.budgetUsd, estCost);
    }
  }

  record(model: string, usage: LLMUsage): number {
    this.inputTokens += usage.inputTokens;
    this.outputTokens += usage.outputTokens;
    this.cachedInputTokens += usage.cachedInputTokens;
    const delta = calculateUsageUsd(model, usage);
    this.spentUsd = Number((this.spentUsd + delta).toFixed(6));
    if (this.budgetUsd > 0 && this.spentUsd >= this.budgetUsd) {
      this.exceeded = true;
    }
    return delta;
  }

  markExceeded(): void {
    this.exceeded = true;
  }

  getSummary(): CostSummary {
    return {
      provider: this.provider,
      model: this.model,
      judge_model: this.judgeModel,
      input_tokens: this.inputTokens,
      output_tokens: this.outputTokens,
      cached_input_tokens: this.cachedInputTokens,
      estimated_usd: this.spentUsd,
      budget_usd: this.budgetUsd,
      budget_exceeded: this.exceeded,
    };
  }
}
