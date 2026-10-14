import Anthropic from "@anthropic-ai/sdk";
import { consumeAnthropicStream, toAnthropicParams } from "./anthropic";
import type { ChatRequest, ModelEvent, ModelGateway } from "./types";

const DEFAULT_MODEL = "claude-sonnet-4-5";
const DEFAULT_MAX_TOKENS = 8192;

export function anthropicGateway(options: { apiKey?: string; model?: string } = {}): ModelGateway {
  return {
    async *complete(request: ChatRequest, signal?: AbortSignal): AsyncIterable<ModelEvent> {
      const apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY;
      if (!apiKey) {
        throw new Error(
          "ANTHROPIC_API_KEY is not set. Export it or pass --api-key. See the getting-started screen for details.",
        );
      }
      const model = options.model ?? process.env.ANTHROPIC_MODEL ?? DEFAULT_MODEL;
      const client = new Anthropic({ apiKey });
      const params = toAnthropicParams(request, { model, maxTokens: DEFAULT_MAX_TOKENS });
      const stream = await client.messages.create({ ...params, stream: true }, { signal });
      yield* consumeAnthropicStream(stream as AsyncIterable<never>);
    },
  };
}
