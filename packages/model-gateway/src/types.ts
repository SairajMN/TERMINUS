export interface ToolSpec {
  name: string;
  description: string;
  input_schema: unknown;
}

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error: boolean };

export interface ChatMessage {
  role: "user" | "assistant";
  content: ContentPart[];
}

export interface ChatRequest {
  system: string;
  messages: ChatMessage[];
  tools: ToolSpec[];
  maxTokens?: number;
}

export type ModelEvent =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown };

export interface ModelGateway {
  complete(request: ChatRequest, signal?: AbortSignal): AsyncIterable<ModelEvent>;
}
