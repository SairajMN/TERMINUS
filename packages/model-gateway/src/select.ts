import { anthropicGateway } from "./anthropic-gateway";
import { nebiusGateway } from "./nebius-gateway";
import type { ModelGateway } from "./types";

export const selectGateway = (
  options: { provider?: "nebius" | "anthropic"; model?: string } = {},
): { gateway: ModelGateway; label: string } => {
  const provider =
    options.provider ??
    (process.env.NEBIUS_API_KEY
      ? "nebius"
      : process.env.ANTHROPIC_API_KEY
        ? "anthropic"
        : "nebius");
  if (provider === "anthropic") {
    return {
      gateway: anthropicGateway({ model: options.model }),
      label: `anthropic ${options.model ?? process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-5"}`,
    };
  }
  return {
    gateway: nebiusGateway({ model: options.model }),
    label: `nebius ${options.model ?? process.env.NEBIUS_MODEL ?? "nvidia/nemotron-3-super-120b-a12b"}`,
  };
};
