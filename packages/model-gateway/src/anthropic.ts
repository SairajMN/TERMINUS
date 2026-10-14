import type Anthropic from "@anthropic-ai/sdk";
import type { ChatRequest, ContentPart, ModelEvent, ToolSpec } from "./types";

type BlockParam = Anthropic.Messages.ContentBlockParam;
type MessageParam = Anthropic.Messages.MessageParam;

type RawEvent = {
  type: string;
  content_block?: { type?: string; id?: string; name?: string };
  delta?: { type?: string; text?: string; partial_json?: string };
};

export const toAnthropicParams = (
  request: ChatRequest,
  defaults: { model: string; maxTokens: number },
) => ({
  model: defaults.model,
  max_tokens: request.maxTokens ?? defaults.maxTokens,
  system: request.system,
  messages: request.messages.map(
    (message): MessageParam => ({
      role: message.role,
      content: message.content.map(toAnthropicPart),
    }),
  ),
  tools: request.tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.input_schema as Anthropic.Messages.Tool.InputSchema,
  })),
});

const toAnthropicPart = (part: ContentPart): BlockParam => {
  switch (part.type) {
    case "text":
      return { type: "text", text: part.text };
    case "tool_use":
      return {
        type: "tool_use",
        id: part.id,
        name: part.name,
        input: part.input as Record<string, unknown>,
      };
    case "tool_result":
      return {
        type: "tool_result",
        tool_use_id: part.tool_use_id,
        content: part.content,
        is_error: part.is_error,
      };
  }
};

export const toToolSpecs = (
  tools: { name: string; description: string; inputSchema: unknown }[],
): ToolSpec[] =>
  tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
  }));

export async function* consumeAnthropicStream(
  stream: AsyncIterable<RawEvent>,
): AsyncIterable<ModelEvent> {
  let pending: { id: string; name: string; json: string } | null = null;
  for await (const event of stream) {
    if (event.type === "content_block_start" && event.content_block?.type === "tool_use") {
      pending = {
        id: event.content_block.id ?? "",
        name: event.content_block.name ?? "",
        json: "",
      };
    } else if (event.type === "content_block_delta" && event.delta) {
      if (event.delta.type === "text_delta" && event.delta.text) {
        yield { type: "text", text: event.delta.text };
      } else if (event.delta.type === "input_json_delta" && pending) {
        pending.json += event.delta.partial_json ?? "";
      }
    } else if (event.type === "content_block_stop" && pending) {
      const input = pending.json.trim() ? JSON.parse(pending.json) : {};
      yield { type: "tool_use", id: pending.id, name: pending.name, input };
      pending = null;
    }
  }
}
