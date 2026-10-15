import OpenAI from "openai";
import { consumeOpenAIStream, toOpenAIMessages, toOpenAITools } from "./openai";
import type { ChatRequest, ModelEvent, ModelGateway } from "./types";

const DEFAULT_BASE_URL = "https://api.tokenfactory.us-central1.nebius.com/v1/";
const DEFAULT_MODEL = "nvidia/nemotron-3-super-120b-a12b";
const DEFAULT_MAX_TOKENS = 8192;

export function nebiusGateway(
  options: { apiKey?: string; baseURL?: string; model?: string } = {},
): ModelGateway {
  return {
    async *complete(request: ChatRequest, signal?: AbortSignal): AsyncIterable<ModelEvent> {
      const apiKey = options.apiKey ?? process.env.NEBIUS_API_KEY;
      if (!apiKey) {
        throw new Error(
          "NEBIUS_API_KEY is not set. Get a key at https://tokenfactory.nebius.com and export it. See the getting-started screen for details.",
        );
      }
      const client = new OpenAI({
        apiKey,
        baseURL: options.baseURL ?? process.env.NEBIUS_BASE_URL ?? DEFAULT_BASE_URL,
        maxRetries: 3,
      });
      const model = options.model ?? process.env.NEBIUS_MODEL ?? DEFAULT_MODEL;
      const stream = await client.chat.completions.create(
        {
          model,
          messages: toOpenAIMessages(request),
          ...(request.tools.length > 0 ? { tools: toOpenAITools(request.tools) } : {}),
          max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
          stream: true,
          stream_options: { include_usage: true },
        },
        { signal },
      );
      yield* consumeOpenAIStream(stream as AsyncIterable<never>);
    },
  };
}
