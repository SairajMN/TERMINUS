import type { ChatRequest, ContentPart, ModelEvent } from "./types";

type OpenAIMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | {
      role: "assistant";
      content: string | null;
      tool_calls?: {
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }[];
    }
  | { role: "tool"; tool_call_id: string; content: string };

export const toOpenAIMessages = (request: ChatRequest): OpenAIMessage[] => {
  const messages: OpenAIMessage[] = [{ role: "system", content: request.system }];
  for (const message of request.messages) {
    if (message.role === "user") {
      for (const part of message.content) {
        if (part.type === "tool_result") {
          messages.push({
            role: "tool",
            tool_call_id: part.tool_use_id,
            content: part.content,
          });
        } else if (part.type === "text" && part.text.trim().length > 0) {
          messages.push({ role: "user", content: part.text });
        }
      }
      continue;
    }
    const text = message.content
      .filter((part): part is Extract<ContentPart, { type: "text" }> => part.type === "text")
      .map((part) => part.text)
      .join("\n");
    const toolCalls = message.content
      .filter(
        (part): part is Extract<ContentPart, { type: "tool_use" }> => part.type === "tool_use",
      )
      .map((part) => ({
        id: part.id,
        type: "function" as const,
        function: { name: part.name, arguments: JSON.stringify(part.input ?? {}) },
      }));
    messages.push({
      role: "assistant",
      content: text.length > 0 ? text : null,
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    });
  }
  return messages;
};

export const toOpenAITools = (
  tools: ChatRequest["tools"],
): {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}[] =>
  tools.map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema as Record<string, unknown>,
    },
  }));

type StreamChunk = {
  choices?: {
    delta?: {
      content?: string | null;
      tool_calls?: {
        index: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }[];
    };
    finish_reason?: string | null;
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
};

export async function* consumeOpenAIStream(
  stream: AsyncIterable<StreamChunk>,
): AsyncIterable<ModelEvent> {
  const calls = new Map<number, { id: string; name: string; args: string }>();
  let usage: { prompt: number; completion: number } | null = null;
  for await (const chunk of stream) {
    if (chunk.usage) {
      usage = {
        prompt: chunk.usage.prompt_tokens ?? 0,
        completion: chunk.usage.completion_tokens ?? 0,
      };
    }
    for (const choice of chunk.choices ?? []) {
      const delta = choice.delta;
      if (delta?.content) yield { type: "text", text: delta.content };
      for (const call of delta?.tool_calls ?? []) {
        const entry = calls.get(call.index) ?? { id: "", name: "", args: "" };
        if (call.id) entry.id = call.id;
        if (call.function?.name) entry.name += call.function.name;
        if (call.function?.arguments) entry.args += call.function.arguments;
        calls.set(call.index, entry);
      }
    }
  }
  for (const [index, call] of [...calls.entries()].sort(([a], [b]) => a - b)) {
    const input = call.args.trim() ? JSON.parse(call.args) : {};
    yield { type: "tool_use", id: call.id || `call_${index}`, name: call.name, input };
  }
  if (usage) yield { type: "usage", prompt: usage.prompt, completion: usage.completion };
}
