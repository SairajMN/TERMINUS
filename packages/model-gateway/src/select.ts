import { anthropicGateway } from "./anthropic-gateway";
import { nebiusGateway, openaiCompatibleGateway } from "./nebius-gateway";
import type { ModelGateway } from "./types";

export type ProviderName = "nebius" | "anthropic" | "openai" | "gemini" | "ollama";

export const selectGateway = (
  options: { provider?: ProviderName; model?: string } = {},
): { gateway: ModelGateway; label: string } => {
  const provider: ProviderName =
    options.provider ??
    (process.env.NEBIUS_API_KEY
      ? "nebius"
      : process.env.ANTHROPIC_API_KEY
        ? "anthropic"
        : process.env.OPENAI_API_KEY
          ? "openai"
          : process.env.GEMINI_API_KEY
            ? "gemini"
            : "nebius");
  if (provider === "anthropic") {
    return {
      gateway: anthropicGateway({ model: options.model }),
      label: `anthropic ${options.model ?? process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-5"}`,
    };
  }
  if (provider === "openai") {
    const model = options.model ?? process.env.OPENAI_MODEL ?? "gpt-4o";
    return {
      gateway: openaiCompatibleGateway({
        envKey: "OPENAI_API_KEY",
        baseURL: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1/",
        model,
      }),
      label: `openai ${model}`,
    };
  }
  if (provider === "gemini") {
    const model = options.model ?? process.env.GEMINI_MODEL ?? "gemini-2.5-pro";
    return {
      gateway: openaiCompatibleGateway({
        envKey: "GEMINI_API_KEY",
        baseURL:
          process.env.GEMINI_BASE_URL ?? "https://generativelanguage.googleapis.com/v1beta/openai/",
        model,
      }),
      label: `gemini ${model}`,
    };
  }
  if (provider === "ollama") {
    const model = options.model ?? process.env.OLLAMA_MODEL ?? "qwen2.5-coder:32b";
    return {
      gateway: openaiCompatibleGateway({
        baseURL: process.env.OLLAMA_BASE_URL ?? "http://localhost:11434/v1/",
        model,
        allowEmptyKey: true,
      }),
      label: `ollama ${model}`,
    };
  }
  return {
    gateway: nebiusGateway({ model: options.model }),
    label: `nebius ${options.model ?? process.env.NEBIUS_MODEL ?? "nvidia/nemotron-3-super-120b-a12b"}`,
  };
};
